/* ============================================================================
   stamp-android-version.js — 出安卓包之前，把 package.json 的版本号写进安卓工程
   ----------------------------------------------------------------------------
   为什么需要：Capacitor 生成的 android/app/build.gradle 里是模板默认的
     versionCode 1
     versionName "1.0"
   每个版本都是这两个值 →
     · 系统「应用信息」里看不出用户装的是哪一版；
     · Android 覆盖安装只认 versionCode，不递增就永远停在 1，
       一旦以后想拦旧版本、或者走应用商店，都没法用。
   这里按 package.json 的 version 写入：
     7.4.7 → versionCode 70407 / versionName "7.4.7"
     （主版本×10000 + 次版本×100 + 修订号，够用到 99.99.99）

   用法（CI 里在 npx cap sync android 之后调）：
     node scripts/stamp-android-version.js
   找不到 android/ 工程时直接报错退出；匹配不到字段只警告不中断 ——
   宁可出一个版本号不对的包，也别让整条流水线挂掉。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = String(pkg.version || '0.0.0').trim();
const seg = ver.split('.').map(n => parseInt(n, 10) || 0);
const code = (seg[0] || 0) * 10000 + (seg[1] || 0) * 100 + (seg[2] || 0);

const gradle = path.join(root, 'android', 'app', 'build.gradle');
if (!fs.existsSync(gradle)) {
  console.error('[android-version] 找不到 ' + gradle + ' —— 先跑 npx cap add android / npx cap sync android');
  process.exit(1);
}

let src = fs.readFileSync(gradle, 'utf8');
const before = src;
src = src.replace(/(\bversionCode\s+)(\d+)/, '$1' + code);
src = src.replace(/(\bversionName\s+)"[^"]*"/, '$1"' + ver + '"');

if (src === before) {
  /* 没变化有两种情况：本来就是这个版本号（重复跑，正常），
     或者根本没匹配到字段（模板变了，要人看一眼）。分开报，别把正常情况当警告。 */
  const already = new RegExp('\\bversionCode\\s+' + code + '\\b').test(before) &&
    new RegExp('\\bversionName\\s+"' + ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(before);
  if (already) {
    console.log('[android-version] 已经是 versionName="' + ver + '" versionCode ' + code + '，无需改动');
    process.exit(0);
  }
  /* ::warning:: 是 GitHub Actions 的注解语法，会在运行日志里高亮出来 */
  console.log('::warning::[android-version] build.gradle 里没匹配到 versionCode / versionName，版本号没有写进去');
  process.exit(0);
}
fs.writeFileSync(gradle, src);
console.log('[android-version] versionName="' + ver + '" versionCode ' + code);
