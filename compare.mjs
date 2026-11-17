// Bandingkan out/browser.mp4 vs out/server.mp4: metadata, SSIM per segmen & area subtitle, amplop audio.
// node compare.mjs  → out/compare-report.json + out/compare_strip.png
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FF = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', FP = '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe';
const run = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const stderrOf = (args) => spawnSync(FF, ['-hide_banner', ...args, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1e8 }).stderr;

const project = JSON.parse(readFileSync('project.json', 'utf8'));
const meta = (f) => JSON.parse(run(FP, ['-v', 'error', '-show_entries', 'stream=codec_name,profile,width,height,r_frame_rate,nb_frames,sample_rate,channels:format=duration,size', '-of', 'json', f]));

const ssim = (start, dur, crop = '') => {
  const c = crop ? `,crop=${crop}` : '';
  const err = stderrOf(['-ss', String(start), '-t', String(dur), '-i', 'out/browser.mp4', '-ss', String(start), '-t', String(dur), '-i', 'out/server.mp4',
    '-lavfi', `[0:v]format=yuv420p${c}[a];[1:v]format=yuv420p${c}[b];[a][b]ssim`]);
  const m = /All:([\d.]+)/.exec(err);
  return m ? +m[1] : null;
};

const H = project.output.height, W = project.output.width;
const subCrop = `${W}:${Math.round(H * 0.3)}:0:${Math.round(H * 0.6)}`; // area subtitle (bawah 40%)
const segments = project.visuals.map((s) => {
  const start = s.start_ms / 1000 + 0.2, dur = Math.max(0.2, (s.end_ms - s.start_ms) / 1000 - 0.4);
  return { segment: s.input ?? s.color, fit: s.fit ?? '-', ssim_full: ssim(start, dur), ssim_subtitle_area: ssim(start, dur, subCrop) };
});

// Amplop audio: RMS per 0.5 detik
const rms = (f) => {
  const err = stderrOf(['-i', f, '-af', 'asetnsamples=24000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level']);
  return [...err.matchAll(/RMS_level=(-?[\d.inf]+)/g)].map((m) => (m[1].includes('inf') ? -120 : +m[1]));
};
const ra = rms('out/browser.mp4'), rb = rms('out/server.mp4');
const n = Math.min(ra.length, rb.length);
const diffs = Array.from({ length: n }, (_, i) => Math.abs(ra[i] - rb[i]));
const audio = { windows: n, max_rms_diff_db: +Math.max(...diffs).toFixed(2), mean_rms_diff_db: +(diffs.reduce((a, b) => a + b, 0) / n).toFixed(2) };

// Strip visual: atas = browser, bawah = server, di 4 detik, 16 detik, 25 detik
for (const [name, f] of [['b', 'out/browser.mp4'], ['s', 'out/server.mp4']]) {
  for (const t of [4, 16, 25]) spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=300:-1', `out/cmp_${name}_${t}.png`]);
}
spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y',
  ...['b_4', 'b_16', 'b_25', 's_4', 's_16', 's_25'].flatMap((k) => ['-i', `out/cmp_${k}.png`]),
  '-filter_complex', '[0][1][2]hstack=3[top];[3][4][5]hstack=3[bot];[top][bot]vstack', 'out/compare_strip.png']);

const report = { browser: meta('out/browser.mp4'), server: meta('out/server.mp4'), segments, audio };
writeFileSync('out/compare-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ segments, audio }, null, 2));
