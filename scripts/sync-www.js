/**
 * 把源码（index.html / style.css / js/**）同步到一个干净的 www/ 目录，
 * 并注入 PWA 相关的 <link> 与 Service Worker 注册。
 *
 * 为什么不在根目录直接打包：
 *  - Capacitor 的 webDir 需要一个"只含前端产物"的目录，避免把 node_modules / android 一起拷进 App；
 *  - PWA 的 manifest / SW 只在 http(s) 下有意义，注入到产物里，源码双击 file:// 打开仍然干净。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log('[sync] 清理 www/');
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

console.log('[sync] 复制前端文件');
for (const f of ['index.html', 'style.css']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
copyDir(path.join(ROOT, 'js'), path.join(OUT, 'js'));

// PWA 资源
const pwaDir = path.join(ROOT, 'pwa');
if (fs.existsSync(pwaDir)) {
  copyDir(pwaDir, OUT);
  console.log('[sync] 复制 PWA 资源');
}

// 注入 manifest / 图标 / SW 注册
const headInject = [
  '  <link rel="manifest" href="./manifest.webmanifest">',
  '  <link rel="icon" type="image/png" href="./icons/icon-192.png">',
  '  <meta name="theme-color" content="#2f7d4f">',
  '  <meta name="apple-mobile-web-app-capable" content="yes">',
  '  <meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '  <meta name="apple-mobile-web-app-title" content="SKFE">',
  '  <link rel="apple-touch-icon" href="./icons/icon-192.png">',
  ''
].join('\n');

const bodyInject = [
  '',
  '  <!-- PWA：仅在 http(s) 下注册 Service Worker，file:// 与 Capacitor 内部协议下自动跳过 -->',
  '  <script>',
  '  (function () {',
  "    if (!/^https?:$/.test(location.protocol)) return;",
  "    if ('serviceWorker' in navigator) {",
  "      window.addEventListener('load', function () {",
  "        navigator.serviceWorker.register('./sw.js').catch(function () {});",
  '      });',
  '    }',
  '  })();',
  '  </script>',
  '</body>'
].join('\n');

const idxPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(idxPath, 'utf8');
if (!html.includes('manifest.webmanifest')) {
  html = html.replace('</head>', headInject + '</head>');
}
if (!html.includes("navigator.serviceWorker.register")) {
  // 注意：源码里 </body> 后面还跟着注释（`</body> <!-- ... -->`），不能按行尾匹配
  html = html.replace('</body>', bodyInject);
}
fs.writeFileSync(idxPath, html);

// 自检：确保关键文件都在
const required = ['index.html', 'style.css', 'js/app.js', 'js/systems/headShapes.js', 'manifest.webmanifest', 'sw.js'];
const missing = required.filter(f => !fs.existsSync(path.join(OUT, f)));
if (missing.length) {
  console.error('[sync] 缺少文件: ' + missing.join(', '));
  process.exit(1);
}

// 统计体积，便于判断安装包大小
let bytes = 0;
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p); else bytes += st.size;
  }
})(OUT);

console.log(`[sync] 完成 → www/  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
