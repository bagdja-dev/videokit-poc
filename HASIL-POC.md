# Hasil PoC Fase 0 — VideoKit (17 Nov 2026)

Gerbang Fase 0 di [`plan/videokit/execution-plan.md`](../../../plan/videokit/execution-plan.md): satu render spec
dieksekusi di **browser (WebCodecs + JASSUB)** dan di **server (ffmpeg + libass)**, lalu hasilnya dibandingkan.

## Cara menjalankan ulang

```bash
cd app/videokit/videokit-poc
node render-server.mjs                 # → out/server.mp4 (ffmpeg-full, libass)
npx esbuild web/render-browser.mjs --bundle --format=esm --outfile=web/dist/app.js
node run-browser.mjs                   # Chrome headless → out/browser.mp4 + out/browser-report.json
node compare.mjs                       # → out/compare-report.json + out/compare_strip.png
node gen-long.mjs && VK_QS="project=project-10min.json&srt=sample-10min.srt&out=browser-10min.mp4" node run-browser.mjs
VK_THREADS=2 /usr/bin/time -l node render-server.mjs   # simulasi VPS
```

Uji manual di laptop tim: `node serve.mjs`, lalu buka `http://localhost:8787/web/` di Chrome/Edge, klik **Mulai render**.

## Bahan uji (sintetis)

SRT dwibahasa 10 cue (wrap slot 1, diakritik é è û ñ), 6 segmen visual: klip landscape `blur`, portrait `cover`,
gambar `contain`, klip 2 detik dengan `freeze`, **HEVC** portrait `cover`, warna polos. Musik latar loop + fade +
**ducking** saat 2 narasi. Output 1080×1920, 30 fps, 30 detik.

## Hasil — Mac M4 (Chrome 157 headless)

| Kriteria gerbang | Hasil | Status |
|---|---|---|
| Encode H.264 + AAC di browser | `avc` ✅ `aac` ✅ (juga `opus`), cross-origin isolated ✅ | ✅ |
| Decode input di browser | H.264 ✅, **HEVC ✅** | ✅ |
| Hasil browser ≈ hasil server (SSIM, 1 = identik) | Per segmen **0,983–1,000**; area subtitle **0,977–1,000** | ✅ |
| Audio browser ≈ server | Selisih RMS rata-rata **0,04 dB**, maks. 0,86 dB (per 0,5 dtk) | ✅ |
| Kecepatan render browser 30 dtk | **7,8 detik (3,9× realtime)** | ✅ |
| Video 10 menit di browser tanpa crash | **98 detik (6,1× realtime)**, file 240 MB, heap JS ±450 MB | ✅ dengan catatan |
| Render server 30 dtk (tanpa batas / 2 thread) | 6,5 dtk, RAM 861 MB / **10,7 dtk, RAM 430 MB** | ⚠️ di atas target 300 MB |
| MP4 lolos upload TikTok / YouTube | Belum diuji | ⏳ manual |
| Laptop tim marketing (OS/browser apa adanya) | Belum diuji — baru Mac M4 headless | ⏳ manual |
| Video HP asli (rotasi, VFR, HDR) | Belum — baru media sintetis | ⏳ manual |
| Storage Fase 9 aktif di dev (migration + CORS) | Belum | ⏳ butuh izin/ops |

## Temuan yang mengubah rencana

1. **Ruang warna wajib dikunci ke BT.709 di kedua executor.** ffmpeg diam-diam memakai BT.601 tanpa tag, sedangkan
   browser menganggap HD tanpa tag = BT.709 → warna berbeda (SSIM sempat 0,95). Setelah pipeline server dikunci
   BT.709 (komposit RGB, konversi sekali di akhir, output bertag), SSIM naik ke 0,98–1,00. Server juga harus
   **menolak/menafsirkan input tanpa tag secara konsisten** dengan browser. Sisa: tag `transfer/primaries` output
   libx264 masih `unknown` — perbaiki di Fase 6.
2. **JASSUB butuh elemen kanvas yang ikut layout** (bukan `display:none`) dan **pemanasan font**: render pertama
   selalu kosong karena font dimuat asinkron. Executor kini menunggu sampai subtitle benar-benar ter-render dan
   **menghentikan render** bila sebuah cue kosong — jangan pernah menghasilkan video tanpa subtitle diam-diam.
   `_drawCapture` adalah API privat JASSUB → kunci versi, uji tiap upgrade.
3. **Subtitle cukup dirender sekali per cue** (fase 1 tanpa animasi), bukan per frame — murah.
4. **File hasil tidak boleh ditahan di RAM**: 10 menit = 240 MB di memori (heap ±450 MB). Tulis bertahap ke OPFS
   (`StreamTarget`) seperti rencana Fase 2 — wajib untuk laptop RAM kecil.
5. **Segmen `blur` paling mahal di browser** (±3,7 dtk untuk 6 dtk video pertama vs ±0,4 dtk per 3 dtk segmen lain).
   Pertimbangkan blur pada resolusi rendah lalu diperbesar.
6. **RAM server**: banyak input terbuka bersamaan. Batas thread per decoder menurunkan 861 → 430 MB. Untuk target
   ≤ 300 MB (Fase 6): komposit di YUV bukan RGB penuh, atau render per segmen lalu concat.
7. Homebrew `ffmpeg` biasa **tidak** menyertakan libass — butuh `ffmpeg-full` (Mac) / build dengan `--enable-libass`
   untuk image server.

## Versi yang dipakai (dikunci, ≥ 2 minggu sejak rilis)

`jassub@2.5.23`, `mediabunny@1.65.0`, `esbuild@0.28.2` (dev), ffmpeg 9.0.2 (`ffmpeg-full`, Homebrew).
Font: Poppins (Regular, Bold, Italic), Bebas Neue — OFL (Google Fonts).

## Langkah manual tersisa sebelum gerbang dinyatakan lolos

1. Jalankan `node serve.mjs` dan render dari Chrome/Edge di **laptop tim marketing** yang sebenarnya; kirim
   `out/browser-report.json` per laptop. Coba juga pindah tab saat render berjalan.
2. Ganti salah satu klip dengan **video HP asli** (iPhone & Android), render ulang.
3. Unggah `out/browser.mp4` ke **TikTok dan YouTube** (draft/private) — pastikan diterima & warnanya benar di HP.
4. Aktifkan Storage Fase 9 di dev (migration storage-service + CORS R2).
