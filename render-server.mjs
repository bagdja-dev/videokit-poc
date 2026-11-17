// Executor SERVER (pembanding): project.json + sample.srt → out/subs.ass → ffmpeg + libass → out/server.mp4
// Jalankan: node render-server.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseSrt, buildAss, backgroundEnvelope, envelopeToFfmpegExpr } from './lib/videokit.mjs';

const FF = process.env.FFMPEG ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const FP = process.env.FFPROBE ?? '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe';
const project = JSON.parse(readFileSync('project.json', 'utf8'));
const { output: out, design } = project;
const W = out.width, H = out.height, FPS = out.fps, DUR = out.duration_ms / 1000;

mkdirSync('out', { recursive: true });
const cues = parseSrt(readFileSync('sample.srt', 'utf8'));
writeFileSync('out/subs.ass', buildAss(cues, design, out));

const durationOf = (p) => +execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString();

const args = ['-hide_banner', '-loglevel', 'error', '-y',
  // Simulasi VPS: VK_THREADS=2 membatasi thread decode/filter/encode
  ...(process.env.VK_THREADS ? ['-filter_threads', process.env.VK_THREADS, '-filter_complex_threads', process.env.VK_THREADS] : [])];
const filters = [];
let inputIdx = 0;
// VK_THREADS: decoder per input juga dibatasi 1 thread (banyak input terbuka bersamaan → RAM)
const addInput = (...a) => { if (process.env.VK_THREADS) args.push('-threads', '1'); args.push(...a); return inputIdx++; };

// --- Video: satu label per segmen, lalu concat ---
const fitChain = (src, fit, label) => {
  if (fit === 'cover') {
    filters.push(`[${src}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${label}]`);
  } else if (fit === 'contain') {
    filters.push(`[${src}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${out.background_color},setsar=1[${label}]`);
  } else { // blur: latar cover + gaussian blur, depan contain di tengah
    filters.push(`[${src}]split[${label}a][${label}b]`);
    filters.push(`[${label}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40[${label}bg]`);
    filters.push(`[${label}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[${label}fg]`);
    filters.push(`[${label}bg][${label}fg]overlay=(W-w)/2:(H-h)/2,setsar=1[${label}]`);
  }
};

const segLabels = project.visuals.map((seg, i) => {
  const segDur = (seg.end_ms - seg.start_ms) / 1000;
  const label = `v${i}`;
  if (seg.color) {
    filters.push(`color=c=${seg.color}:s=${W}x${H}:r=${FPS}:d=${segDur},setsar=1,format=gbrp[${label}]`);
    return label;
  }
  const inp = project.inputs[seg.input];
  if (inp.kind === 'image') {
    const idx = addInput('-loop', '1', '-framerate', String(FPS), '-t', String(segDur), '-i', inp.path);
    fitChain(`${idx}:v`, seg.fit, `${label}f`);
    filters.push(`[${label}f]fps=${FPS},trim=duration=${segDur},format=gbrp[${label}]`);
    return label;
  }
  const idx = addInput('-i', inp.path);
  const start = (seg.source_in_ms ?? 0) / 1000;
  // potong sumber, normalkan fps, tambal kekurangan dengan freeze frame terakhir (underflow=freeze)
  filters.push(`[${idx}:v]trim=start=${start}:duration=${segDur},setpts=PTS-STARTPTS,fps=${FPS},tpad=stop_mode=clone:stop_duration=${segDur},trim=duration=${segDur}[${label}r]`);
  fitChain(`${label}r`, seg.fit, `${label}f`);
  filters.push(`[${label}f]format=gbrp[${label}]`);
  return label;
});

filters.push(`${segLabels.map((l) => `[${l}]`).join('')}concat=n=${segLabels.length}:v=1:a=0[vcat]`);
// RGB → YUV BT.709 (limited) secara eksplisit; tanpa ini ffmpeg diam-diam memakai BT.601 tanpa tag
filters.push(`[vcat]ass=out/subs.ass:fontsdir=fonts,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]`);

// --- Audio: latar (loop + amplop fade/ducking) + voice di offset-nya ---
const bg = project.audio.find((a) => a.role === 'background');
const voices = project.audio.filter((a) => a.role === 'voice');
const audioLabels = [];
if (bg) {
  const idx = addInput('-stream_loop', '-1', '-i', project.inputs[bg.input].path);
  const env = envelopeToFfmpegExpr(backgroundEnvelope(bg, voices, out.duration_ms));
  filters.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${DUR},asetpts=PTS-STARTPTS,volume='${env}':eval=frame[abg]`);
  audioLabels.push('abg');
}
voices.forEach((v, i) => {
  const idx = addInput('-i', project.inputs[v.input].path);
  const len = (v.end_ms - v.start_ms) / 1000;
  filters.push(`[${idx}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${len},asetpts=PTS-STARTPTS,volume=${v.volume ?? 1},adelay=${v.start_ms}:all=1,apad[av${i}]`);
  audioLabels.push(`av${i}`);
});
if (audioLabels.length) {
  filters.push(`${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,atrim=0:${DUR}[aout]`);
} else {
  filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${DUR}[aout]`);
}

args.push(
  '-filter_complex', filters.join(';'),
  '-map', '[vout]', '-map', '[aout]',
  ...(process.env.VK_THREADS ? ['-threads', process.env.VK_THREADS] : []),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-t', String(DUR), '-movflags', '+faststart', 'out/server.mp4',
);

const t0 = Date.now();
const res = spawnSync(FF, args, { stdio: 'inherit' });
if (res.status !== 0) process.exit(res.status ?? 1);
const secs = (Date.now() - t0) / 1000;
console.log(`server.mp4 selesai dalam ${secs.toFixed(1)} detik (durasi video ${DUR} s, ${(DUR / secs).toFixed(2)}x realtime)`);
console.log(`input video dicek: ${Object.values(project.inputs).filter((i) => i.kind === 'video').map((i) => `${i.path.split('/').pop()}=${durationOf(i.path).toFixed(2)}s`).join(', ')}`);
