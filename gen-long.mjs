// Buat project 10 menit (project.json diulang 20x) untuk uji ketahanan: node gen-long.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSrt } from './lib/videokit.mjs';

const REPEAT = 20;
const base = JSON.parse(readFileSync('project.json', 'utf8'));
const len = base.output.duration_ms;
const shift = (o, k) => ({ ...o, start_ms: o.start_ms + k * len, end_ms: o.end_ms + k * len });
const long = {
  ...base,
  output: { ...base.output, duration_ms: len * REPEAT },
  visuals: Array.from({ length: REPEAT }, (_, k) => base.visuals.map((v) => shift(v, k))).flat(),
  audio: [
    base.audio.find((a) => a.role === 'background'),
    ...Array.from({ length: REPEAT }, (_, k) => base.audio.filter((a) => a.role === 'voice').map((v) => shift(v, k))).flat(),
  ],
};
writeFileSync('project-10min.json', JSON.stringify(long, null, 2));

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ts = (ms) => `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
const cues = parseSrt(readFileSync('sample.srt', 'utf8'));
const srt = Array.from({ length: REPEAT }, (_, k) => cues.map((c) => ({ ...c, start_ms: c.start_ms + k * len, end_ms: c.end_ms + k * len }))).flat()
  .map((c, i) => `${i + 1}\n${ts(c.start_ms)} --> ${ts(c.end_ms)}\n${c.lines.join('\n')}\n`).join('\n');
writeFileSync('sample-10min.srt', srt);
console.log(`project-10min.json: ${long.visuals.length} segmen, ${long.output.duration_ms / 60000} menit; sample-10min.srt: ${cues.length * REPEAT} cue`);
