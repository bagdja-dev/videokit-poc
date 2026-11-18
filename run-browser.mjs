// Jalankan executor browser otomatis di Chrome headless, tunggu hasil, lalu tutup.
// node run-browser.mjs   (untuk uji manual di laptop: node serve.mjs lalu buka http://localhost:8787/web/)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from './serve.mjs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8787;
await new Promise((ok) => server.listen(PORT, ok));
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'vk-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', ...(process.env.VK_LOG ? ['--enable-logging=stderr', '--v=0'] : []), `http://localhost:${PORT}/web/?auto=1${process.env.VK_QS ? '&' + process.env.VK_QS : ''}`,
], { stdio: ['ignore', 'ignore', process.env.VK_LOG ? 'inherit' : 'ignore'] });

const timeout = setTimeout(() => { console.error('TIMEOUT 15 menit'); chrome.kill(); process.exit(2); }, 900_000);
server.on('report', (r) => {
  clearTimeout(timeout);
  chrome.kill();
  server.close();
  process.exit(r.error ? 1 : 0);
});
