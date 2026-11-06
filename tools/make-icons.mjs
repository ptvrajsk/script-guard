// Renders icons/icon-{16,32,48,128}.png from the shield design using headless Brave. Run: node tools/make-icons.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../icons');
const EXE = process.env.BRAVE || '/usr/bin/brave-browser';

// Shield (viewBox 128). Thicker check on small sizes so it survives downscaling.
const svg = (size) => {
  const sw = size <= 16 ? 17 : size <= 32 ? 14 : 11;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17a08d"/><stop offset="1" stop-color="#0b5f53"/></linearGradient>
  </defs>
  <path d="M64 6 14 25v40c0 31 21 49 50 57 29-8 50-26 50-57V25L64 6z" fill="url(#g)"/>
  ${size >= 48 ? '<path d="M64 6 14 25v40c0 31 21 49 50 57V6z" fill="#fff" opacity=".08"/>' : ''}
  <path d="M40 66l17 17 33-37" fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.svg'), svg(128));
const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size)}`);
    await page.screenshot({ path: path.join(OUT, `icon-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
} finally { await browser.close(); }
console.log('wrote', fs.readdirSync(OUT).join(', '));
