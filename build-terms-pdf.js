// Генерация terms.pdf из terms.html через headless Chrome/Edge (протокол DevTools).
// Даёт аккуратный футер с нумерацией «Страница N из M». Запускать после любой
// правки текста оферты в terms.html, чтобы PDF совпадал с HTML 1:1.
//   node build-terms-pdf.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const here = __dirname;
const htmlPath = path.join(here, 'terms.html');
const pdfPath = path.join(here, 'terms.pdf');

if (!fs.existsSync(htmlPath)) { console.error('Не найден ' + htmlPath); process.exit(1); }

const candidates = [
  process.env.CHROME_PATH,                         // задаётся в CI (GitHub Actions)
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Windows
  process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux (CI / серверы)
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser', '/usr/bin/chromium',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = candidates.find(p => p && fs.existsSync(p));
if (!browser) { console.error('Не найден Chrome или Edge для рендеринга PDF'); process.exit(1); }

const PORT = 9222 + Math.floor((process.pid % 500)); // избегаем занятого порта
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-pdf-'));

const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-sandbox', '--disable-dev-shm-usage', // no-sandbox нужен под Linux CI
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${userDataDir}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getBrowserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(150);
  }
  throw new Error('DevTools не поднялся');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', e => reject(new Error('WS error: ' + (e.message || 'unknown'))));
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    const api = {
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      close() { ws.close(); },
    };
  });
}

(async () => {
  const wsUrl = await getBrowserWs();
  const cdp = await connect(wsUrl);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Page.enable', {}, sessionId);
  const fileUrl = pathToFileURL(htmlPath).href;
  await cdp.send('Page.navigate', { url: fileUrl }, sessionId);
  await sleep(1500); // догрузка стилей/шрифтов

  const footer =
    '<div style="font-size:9px;width:100%;text-align:center;color:#94a3b8;' +
    'font-family:Inter,Arial,sans-serif;padding:0 16mm;">Страница ' +
    '<span class="pageNumber"></span> из <span class="totalPages"></span></div>';

  const { data } = await cdp.send('Page.printToPDF', {
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: footer,
    marginTop: 0.55, marginBottom: 0.7, marginLeft: 0.63, marginRight: 0.63, // дюймы
    preferCSSPageSize: false,
  }, sessionId);

  fs.writeFileSync(pdfPath, Buffer.from(data, 'base64'));
  await cdp.send('Target.closeTarget', { targetId });
  cdp.close();
  proc.kill();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}

  const kb = Math.round(fs.statSync(pdfPath).size / 1024);
  console.log(`OK: terms.pdf (${kb} KB) собран через ${path.basename(browser)}`);
  process.exit(0);
})().catch(e => {
  console.error('Ошибка: ' + e.message);
  try { proc.kill(); } catch (_) {}
  process.exit(1);
});
