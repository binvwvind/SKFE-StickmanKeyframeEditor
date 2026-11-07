/**
 * 生成应用图标：用无头 Chrome 渲染一张 SVG 并导出多种尺寸。
 * 产出：build/icon.png(1024) / pwa/icons/{192,512,maskable-512}.png
 * 注意：headless Chrome 的目标列表里可能先出现 background_page，必须精确挑 type==='page'。
 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.ICON_PORT || 9463);

const log = (...a) => { process.stdout.write(a.join(' ') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ART = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3f9563"/>
      <stop offset="1" stop-color="#1d5436"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#bg)"/>
  <circle cx="256" cy="150" r="46" fill="none" stroke="#ffffff" stroke-width="22"/>
  <path d="M256 200 C 246 240, 232 300, 228 330 C 224 372, 246 392, 256 392
           C 266 392, 288 372, 284 330 C 280 300, 266 240, 256 200 Z" fill="#ffffff"/>
  <path d="M236 250 C 200 268, 168 288, 138 306" stroke="#ffffff" stroke-width="17" stroke-linecap="round" fill="none"/>
  <path d="M276 250 C 312 268, 344 288, 374 306" stroke="#ffffff" stroke-width="17" stroke-linecap="round" fill="none"/>
  <path d="M240 382 C 230 412, 222 440, 214 462" stroke="#ffffff" stroke-width="19" stroke-linecap="round" fill="none"/>
  <path d="M272 382 C 282 412, 290 440, 298 462" stroke="#ffffff" stroke-width="19" stroke-linecap="round" fill="none"/>
</svg>`;

function pageHtml(size, pad) {
  const inner = Math.round(size * (1 - pad * 2));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  svg{width:${inner}px;height:${inner}px;display:block;margin:${Math.round(size * pad)}px}
</style></head><body>${ART}</body></html>`;
}

const getJson = (p) => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 1500 }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', rej);
});

(async () => {
  const profile = path.join(os.tmpdir(), 'skfe_icon_profile_' + Date.now());
  const tmpHtml = path.join(os.tmpdir(), 'skfe_icon_' + Date.now() + '.html');
  fs.writeFileSync(tmpHtml, pageHtml(512, 0));

  log('[icon] 启动 Chrome');
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--allow-file-access-from-files', '--disable-gpu',
    '--hide-scrollbars',
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 40; i++) {
    try { list = await getJson('/json/list'); if (Array.isArray(list) && list.length) break; } catch (_) {}
    await sleep(250);
  }
  if (!Array.isArray(list)) throw new Error('Chrome 未就绪');
  const page = list.find((x) => x.type === 'page');
  if (!page) throw new Error('找不到 page target：' + list.map((x) => x.type).join(','));
  log('[icon] 目标就绪');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    const timer = setTimeout(() => { pend.delete(mid); rej(new Error(method + ' 超时')); }, 8000);
    pend.set(mid, (r) => { clearTimeout(timer); res(r); });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const opened = await Promise.race([
    new Promise((r) => ws.addEventListener('open', () => r(true))),
    sleep(6000).then(() => false)
  ]);
  if (!opened) throw new Error('WebSocket 未打开');
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  });
  await send('Page.enable');

  const targets = [
    { file: 'build/icon.png', size: 1024, pad: 0 },
    { file: 'pwa/icons/icon-512.png', size: 512, pad: 0 },
    { file: 'pwa/icons/icon-192.png', size: 192, pad: 0 },
    { file: 'pwa/icons/icon-maskable-512.png', size: 512, pad: 0.1 }
  ];

  for (const t of targets) {
    fs.writeFileSync(tmpHtml, pageHtml(t.size, t.pad));
    await send('Emulation.setDeviceMetricsOverride', { width: t.size, height: t.size, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'file:///' + tmpHtml.replace(/\\/g, '/') });
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(ROOT, t.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    log('[icon] ' + t.file + '  ' + t.size + 'px');
  }

  ws.close(); child.kill();
  try { fs.unlinkSync(tmpHtml); } catch (_) {}
  log('[icon] 完成');
  process.exit(0);
})().catch((e) => { log('[icon] 失败: ' + e.message); process.exit(1); });
