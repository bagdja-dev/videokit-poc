// Server statis PoC: header COOP/COEP (agar JASSUB bisa multi-thread), terima hasil render browser.
// Jalankan: node serve.mjs  → buka http://localhost:8787/web/  (tambahkan ?auto=1 untuk langsung render)
import { createServer } from 'node:http';
import { createReadStream, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = +(process.env.PORT ?? 8787);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.png': 'image/png', '.ttf': 'font/ttf',
  '.woff2': 'font/woff2', '.srt': 'text/plain', '.ass': 'text/plain' };
mkdirSync('out', { recursive: true });

const readBody = (req) => new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

export const server = createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/upload') {
    const name = (url.searchParams.get('name') ?? 'browser.mp4').replace(/[^\w.-]/g, '');
    writeFileSync(join('out', name), await readBody(req));
    console.log(`diterima out/${name}`);
    return res.end('ok');
  }
  if (req.method === 'POST' && url.pathname === '/log') {
    console.log('[browser]', (await readBody(req)).toString());
    return res.end('ok');
  }
  if (req.method === 'POST' && url.pathname === '/report') {
    const body = (await readBody(req)).toString();
    writeFileSync('out/browser-report.json', body);
    console.log('laporan browser:', body);
    server.emit('report', JSON.parse(body));
    return res.end('ok');
  }
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname === '/web/' ? '/web/index.html' : url.pathname)));
  if (!path.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try {
    const st = statSync(path);
    if (st.isDirectory()) throw new Error('dir');
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : st.size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return createReadStream(path, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', st.size);
    createReadStream(path).pipe(res);
  } catch { res.statusCode = 404; res.end('not found'); }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`PoC: http://localhost:${PORT}/web/`));
}
