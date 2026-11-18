// Executor BROWSER: render spec yang sama dengan render-server.mjs, seluruhnya di perangkat pengguna.
// decode (WebCodecs via mediabunny) → komposit canvas → subtitle JASSUB (libass WASM) → mix Web Audio
// → encode H.264 + AAC (WebCodecs) → MP4. Di-bundle oleh esbuild ke web/dist/app.js.
import {
  Input, ALL_FORMATS, UrlSource, CanvasSink, Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, AudioBufferSource, QUALITY_HIGH, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';
import JASSUB from 'jassub';
import { parseSrt, buildAss, backgroundEnvelope, sourceTimeFor } from '../lib/videokit.mjs';

const FONT_URLS = ['Poppins-Bold.ttf', 'Poppins-Italic.ttf', 'Poppins-Regular.ttf', 'BebasNeue-Regular.ttf']
  .map((f) => new URL(`/fonts/${f}`, location.href).href);

const logEl = document.getElementById('log');
const report = { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, steps: [] };
function log(msg, extra) {
  const line = `[${(performance.now() / 1000).toFixed(1)}s] ${msg}`;
  logEl.textContent += line + '\n';
  report.steps.push(extra ? { msg, ...extra } : { msg });
  console.log(line, extra ?? '');
  fetch('/log', { method: 'POST', body: line + (extra ? ' ' + JSON.stringify(extra) : '') }).catch(() => {});
}
addEventListener('error', (e) => log('window.error: ' + (e.message ?? e)));
addEventListener('unhandledrejection', (e) => log('unhandledrejection: ' + (e.reason?.stack ?? e.reason)));
const post = (path, body, type = 'application/json') =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': type }, body });

export async function run({ upload = true } = {}) {
  const t0 = performance.now();
  try {
    const qs = new URLSearchParams(location.search);
    const project = await (await fetch('/' + (qs.get('project') ?? 'project.json'))).json();
    const srt = await (await fetch('/' + (qs.get('srt') ?? 'sample.srt'))).text();
    report.project = qs.get('project') ?? 'project.json';
    const { output: out, design } = project;
    const W = out.width, H = out.height, FPS = out.fps, DUR = out.duration_ms / 1000;
    const ass = buildAss(parseSrt(srt), design, out);

    // 1. Kemampuan encode (gerbang routing hybrid di produk)
    const caps = {
      avc: await canEncodeVideo('avc', { width: W, height: H }),
      aac: await canEncodeAudio('aac'),
      opus: await canEncodeAudio('opus'),
      crossOriginIsolated: self.crossOriginIsolated,
    };
    report.caps = caps;
    log('kemampuan encode', caps);
    if (!caps.avc) throw new Error('Browser ini tidak bisa encode H.264 di resolusi output');
    const audioCodec = caps.aac ? 'aac' : 'opus';
    if (!caps.aac) log('⚠️ AAC tidak tersedia — memakai Opus (perlu diuji di platform tujuan)');

    // 2. Siapkan sumber visual
    const sources = {};
    for (const seg of project.visuals) {
      if (!seg.input || sources[seg.input]) continue;
      const inp = project.inputs[seg.input];
      if (inp.kind === 'image') {
        sources[seg.input] = { kind: 'image', bitmap: await createImageBitmap(await (await fetch('/' + inp.path)).blob()) };
      } else {
        const input = new Input({ source: new UrlSource('/' + inp.path), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        const decodable = await track.canDecode();
        const duration = await input.computeDuration();
        sources[seg.input] = { kind: 'video', input, track, duration, codec: track.codec, decodable };
        log(`sumber ${seg.input}: ${track.codec} ${track.displayWidth}x${track.displayHeight}, ${duration.toFixed(2)}s, decode=${decodable}`);
        if (!decodable) throw new Error(`Tidak bisa decode ${seg.input} (${track.codec})`);
      }
    }

    // 3. Subtitle: JASSUB mode canvas, piksel diambil per cue (fase 1 tanpa animasi → statis selama cue)
    const subCanvasEl = document.createElement('canvas');
    subCanvasEl.width = W; subCanvasEl.height = H;
    // Tetap di-layout (bukan display:none): JASSUB membaca clientWidth/clientHeight elemen.
    Object.assign(subCanvasEl.style, { position: 'fixed', left: '0', top: '0', width: W + 'px', height: H + 'px', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(subCanvasEl);
    const jassub = new JASSUB({
      workerUrl: new URL('/web/dist/worker/worker.js', location.href).href,
      wasmUrl: new URL('/web/dist/worker/jassub-worker.wasm', location.href).href,
      modernWasmUrl: new URL('/web/dist/worker/jassub-worker-modern.wasm', location.href).href,
      canvas: subCanvasEl, subContent: ass, fonts: FONT_URLS, prescaleFactor: 1, maxRenderHeight: H });
    log('menunggu JASSUB…');
    await jassub.ready;
    await jassub.resize(true, W, H);
    const cues = parseSrt(srt);
    const filled = (cap) => { let n = 0; if (cap) for (let p = 3; p < cap.data.length; p += 4) if (cap.data[p] > 0) n++; return n; };

    // Pemanasan: font dimuat asinkron di worker, render pertama selalu kosong (FOUT libass).
    // Tunggu sampai cue pertama benar-benar menghasilkan piksel, maks. 10 detik.
    const tWarm = performance.now();
    const warmT = (cues[0].start_ms + 1) / 1000;
    for (let tries = 0; ; tries++) {
      await jassub.manualRender({ expectedDisplayTime: performance.now(), width: W, height: H, mediaTime: warmT }, true);
      if (filled(await jassub.renderer._drawCapture(warmT)) > 0) break;
      if (performance.now() - tWarm > 10_000) throw new Error('Subtitle tidak ter-render setelah 10 detik (font/JASSUB)');
      await new Promise((r) => setTimeout(r, 50));
    }
    log('JASSUB siap', { warmupMs: Math.round(performance.now() - tWarm) });

    const subCache = new Map();
    async function subtitleFor(tSec) {
      const idx = cues.findIndex((c) => tSec * 1000 >= c.start_ms && tSec * 1000 < c.end_ms);
      if (idx < 0) return null;
      if (!subCache.has(idx)) {
        const cap = await jassub.renderer._drawCapture((cues[idx].start_ms + 1) / 1000);
        const n = filled(cap);
        if (!n) throw new Error(`Subtitle cue ${idx + 1} kosong — render dihentikan agar tidak menghasilkan video tanpa subtitle`);
        const bmpCanvas = new OffscreenCanvas(cap.width, cap.height);
        bmpCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(cap.data), cap.width, cap.height), 0, 0);
        subCache.set(idx, await createImageBitmap(bmpCanvas));
      }
      return subCache.get(idx);
    }

    // 4. Komposit + encode video
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d', { alpha: false });
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const videoSource = new CanvasSource(canvas, { codec: 'avc', bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192_000 });
    output.addAudioTrack(audioSource);
    await output.start();

    const drawFit = (img, iw, ih, fit) => {
      const cover = Math.max(W / iw, H / ih), contain = Math.min(W / iw, H / ih);
      const draw = (s, pad = 0) => {
        const w = iw * s + pad * 2, h = ih * s + pad * 2;
        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      };
      if (fit === 'cover') return draw(cover);
      if (fit === 'contain') { ctx.fillStyle = out.background_color; ctx.fillRect(0, 0, W, H); return draw(contain); }
      // blur: latar cover di-blur (diperbesar agar tepi tidak transparan), depan contain
      ctx.filter = 'blur(40px)'; draw(cover, 120); ctx.filter = 'none';
      draw(contain);
    };

    const totalFrames = Math.round(DUR * FPS);
    const tVideo = performance.now();
    for (const seg of project.visuals) {
      const first = Math.round(seg.start_ms * FPS / 1000), last = Math.round(seg.end_ms * FPS / 1000);
      const frameIdx = Array.from({ length: last - first }, (_, k) => first + k);
      const src = seg.input ? sources[seg.input] : null;
      let frames = null;
      if (src?.kind === 'video') {
        const sink = new CanvasSink(src.track, { poolSize: 3 });
        frames = sink.canvasesAtTimestamps(frameIdx.map((i) => sourceTimeFor(seg, i * 1000 / FPS, src.duration, FPS)));
      }
      for (const i of frameIdx) {
        const t = i / FPS;
        if (seg.color) { ctx.fillStyle = seg.color; ctx.fillRect(0, 0, W, H); }
        else if (src.kind === 'image') drawFit(src.bitmap, src.bitmap.width, src.bitmap.height, seg.fit);
        else {
          const { value: wrapped } = await frames.next();
          if (wrapped) drawFit(wrapped.canvas, wrapped.canvas.width, wrapped.canvas.height, seg.fit);
        }
        const sub = await subtitleFor(t);
        if (sub) ctx.drawImage(sub, 0, 0, W, H);
        await videoSource.add(t, 1 / FPS);
        if (i % 90 === 0) log(`frame ${i}/${totalFrames}`);
      }
    }
    log('video selesai di-encode', { seconds: +((performance.now() - tVideo) / 1000).toFixed(2) });

    // 5. Audio: OfflineAudioContext, amplop latar identik dengan ekspresi ffmpeg
    const tAudio = performance.now();
    const actx = new OfflineAudioContext(2, Math.round(DUR * 48000), 48000);
    const decode = async (key) => actx.decodeAudioData(await (await fetch('/' + project.inputs[key].path)).arrayBuffer());
    const bg = project.audio.find((a) => a.role === 'background');
    const voices = project.audio.filter((a) => a.role === 'voice');
    if (bg) {
      const node = actx.createBufferSource();
      node.buffer = await decode(bg.input); node.loop = !!bg.loop;
      const gain = actx.createGain();
      const env = backgroundEnvelope(bg, voices, out.duration_ms);
      gain.gain.setValueAtTime(env[0].gain, 0);
      for (const p of env.slice(1)) gain.gain.linearRampToValueAtTime(p.gain, p.t_ms / 1000);
      node.connect(gain).connect(actx.destination);
      node.start(0);
    }
    for (const v of voices) {
      const node = actx.createBufferSource();
      node.buffer = await decode(v.input);
      const gain = actx.createGain(); gain.gain.value = v.volume ?? 1;
      node.connect(gain).connect(actx.destination);
      node.start(v.start_ms / 1000, 0, (v.end_ms - v.start_ms) / 1000);
    }
    await audioSource.add(await actx.startRendering());
    log('audio selesai', { seconds: +((performance.now() - tAudio) / 1000).toFixed(2) });

    await output.finalize();
    const buf = target.buffer;
    report.totalSeconds = +((performance.now() - t0) / 1000).toFixed(2);
    report.realtimeFactor = +(DUR / report.totalSeconds).toFixed(2);
    report.outputBytes = buf.byteLength;
    report.jsHeapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
    log(`SELESAI dalam ${report.totalSeconds}s (${report.realtimeFactor}x realtime), ${(buf.byteLength / 1e6).toFixed(1)} MB`);
    await jassub.destroy();

    const blob = new Blob([buf], { type: 'video/mp4' });
    const a = document.getElementById('download');
    a.href = URL.createObjectURL(blob); a.download = 'browser.mp4'; a.hidden = false;
    if (upload) await post('/upload?name=' + (new URLSearchParams(location.search).get('out') ?? 'browser.mp4'), blob, 'video/mp4');
  } catch (e) {
    report.error = String(e?.stack ?? e);
    log('GAGAL: ' + e);
  } finally {
    if (upload) await post('/report', JSON.stringify(report));
  }
}

document.getElementById('start').onclick = () => run();
if (new URLSearchParams(location.search).has('auto')) run();
