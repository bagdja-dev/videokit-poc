// Modul bersama PoC VideoKit — dipakai Node (render server) dan browser (render WebCodecs).
// Tanpa dependensi: parse SRT, bangun file ASS dari desain slot, dan amplop ducking audio.

/** Parse SRT → [{ start_ms, end_ms, lines: [..] }]. Satu baris = satu slot bahasa. */
export function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  for (const block of blocks) {
    const rows = block.split('\n');
    const timeIdx = rows.findIndex((r) => r.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = rows[timeIdx].split('-->').map((s) => toMs(s.trim()));
    const lines = rows.slice(timeIdx + 1).map((l) => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    if (lines.length && b > a) cues.push({ start_ms: a, end_ms: b, lines });
  }
  return cues;
}

function toMs(t) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t);
  if (!m) throw new Error(`Waktu SRT tidak valid: ${t}`);
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0').slice(0, 3);
}

// #RRGGBB → &H00BBGGRR (alpha 00 = opak)
function assColor(hex, alpha = 0) {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function assTime(ms) {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function escapeAss(text) {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

const ALIGN = { bottom: 2, middle: 5, top: 8 };

/**
 * Bangun file ASS. Satu cue = SATU event; pindah slot dengan \N{\rSlotN}, sehingga
 * baris yang ter-wrap otomatis mendorong slot berikutnya ke bawah (overview §4.3).
 */
export function buildAss(cues, design, output) {
  const align = ALIGN[design.anchor] ?? 2;
  const styles = design.slots.map((s, i) =>
    [
      `Style: Slot${i + 1}`, s.font, s.size, assColor(s.color), assColor(s.color),
      assColor(s.outline_color ?? '#000000'), assColor('#000000', 0x80),
      s.bold ? -1 : 0, s.italic ? -1 : 0, 0, 0, 100, 100, 0, 0, 1, s.outline ?? 0, s.shadow ?? 0,
      align, design.margin_h, design.margin_h, design.margin_v, 1,
    ].join(','),
  );
  const events = cues.map((c) => {
    const text = c.lines
      .map((line, i) => (i === 0 ? '' : `\\N{\\rSlot${Math.min(i, design.slots.length - 1) + 1}}`) + escapeAss(line))
      .join('');
    return `Dialogue: 0,${assTime(c.start_ms)},${assTime(c.end_ms)},Slot1,,0,0,0,,${text}`;
  });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${output.width}`,
    `PlayResY: ${output.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/**
 * Amplop gain musik latar (0..1) sebagai titik linear [{t_ms, gain}], dipakai identik oleh
 * ffmpeg (ekspresi volume) dan Web Audio (linearRampToValueAtTime). Menggabungkan fade
 * in/out dan ducking selama track voice berbunyi.
 */
export function backgroundEnvelope(bg, voices, durationMs) {
  const d = bg.ducking;
  const at = (t) => {
    let g = 1;
    if (bg.fade_in_ms && t < bg.fade_in_ms) g = Math.min(g, t / bg.fade_in_ms);
    const fo = bg.fade_out_ms ?? 0;
    if (fo && t > durationMs - fo) g = Math.min(g, (durationMs - t) / fo);
    if (d) {
      let duck = 0;
      for (const v of voices) {
        const up = (t - (v.start_ms - d.attack_ms)) / d.attack_ms;
        const down = (v.end_ms + d.release_ms - t) / d.release_ms;
        duck = Math.max(duck, Math.max(0, Math.min(1, up, down)));
      }
      g *= 1 - (1 - d.level) * duck;
    }
    return Math.max(0, g) * (bg.volume ?? 1);
  };
  // Titik patah: semua sudut trapesium + fade, cukup untuk interpolasi linear yang persis.
  const ts = new Set([0, durationMs]);
  if (bg.fade_in_ms) ts.add(bg.fade_in_ms);
  if (bg.fade_out_ms) ts.add(durationMs - bg.fade_out_ms);
  if (d) for (const v of voices) {
    [v.start_ms - d.attack_ms, v.start_ms, v.end_ms, v.end_ms + d.release_ms].forEach((t) => ts.add(t));
  }
  return [...ts].filter((t) => t >= 0 && t <= durationMs).sort((a, b) => a - b).map((t) => ({ t_ms: t, gain: at(t) }));
}

/** Untuk ffmpeg: ekspresi piecewise-linear dari amplop (t dalam detik). */
export function envelopeToFfmpegExpr(points) {
  let expr = `${points[points.length - 1].gain.toFixed(5)}`;
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i], b = points[i + 1];
    const ta = a.t_ms / 1000, tb = b.t_ms / 1000;
    if (tb <= ta) continue;
    const seg = `(${a.gain.toFixed(5)}+(${(b.gain - a.gain).toFixed(5)})*(t-${ta.toFixed(3)})/${(tb - ta).toFixed(3)})`;
    expr = `if(lt(t\\,${tb.toFixed(3)})\\,${seg}\\,${expr})`;
  }
  return expr;
}

/** Waktu sumber (detik) untuk frame output pada tOut (ms) di sebuah segmen visual. */
export function sourceTimeFor(seg, tOutMs, clipDurationS, fps) {
  const rel = (tOutMs - seg.start_ms + (seg.source_in_ms ?? 0)) / 1000;
  const last = Math.max(0, clipDurationS - 1 / fps);
  if (rel <= last) return rel;
  if (seg.underflow === 'loop') return rel % clipDurationS;
  return last; // freeze (default)
}
