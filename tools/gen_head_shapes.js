#!/usr/bin/env node
/* ==================== 手绘头型生成器 ====================
 *
 * 用法：  node tools/gen_head_shapes.js
 *
 * 干什么：把 tools/heads/*.svg 转成 js/systems/headShapes.js。
 *         每个 SVG 必须是「单条闭合路径 + 外轮廓 + 内孔」的填充环（evenodd），
 *         脚本会取路径里的端点算外轮廓包围盒和内孔比例。
 *
 * 怎么加新头型：
 *   1. 画好一个环，导出成 SVG（viewBox 随意，路径必须是 <path d="...">）
 *   2. 丢进 tools/heads/ ，文件名就是头型 id（如 My.svg → id "My"）
 *   3. 跑一次本脚本，然后在 index.html 的头型按钮里加一个 data-shape="My"
 *
 * 注意：脚本只认绝对坐标的 M/L/C 命令（M x,y / L x,y / C x1,y1,x2,y2,x,y）。
 *       如果你的 SVG 用了相对命令或弧线 A，先用别的工具转成绝对路径。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(__dirname, 'heads');
const OUT = path.join(ROOT, 'js', 'systems', 'headShapes.js');

/* 显示顺序：数组里越靠前越先出现，没列到的按文件名排后面 */
const ORDER = ['Vic', 'TCO', 'TDL', 'TSC'];

/* ---------- 解析 path：只取端点 ---------- */
function endpoints(d) {
  const cmds = d.match(/[MLCZ][^MLCZ]*/g) || [];
  const subs = [];
  let cur = null;
  for (const raw of cmds) {
    const c = raw[0];
    const nums = (raw.slice(1).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (c === 'M') {
      cur = [];
      subs.push(cur);
      if (nums.length >= 2) cur.push([nums[0], nums[1]]);
    } else if (c === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) cur.push([nums[i], nums[i + 1]]);
    } else if (c === 'C') {
      for (let i = 0; i + 5 < nums.length; i += 6) cur.push([nums[i + 4], nums[i + 5]]);
    }
  }
  return subs;
}
function bbox(pts) {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    w: maxX - minX, h: maxY - minY,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2
  };
}
const r1 = n => Math.round(n * 10) / 10;
const r3 = n => Math.round(n * 1000) / 1000;

/* ---------- 读 SVG ---------- */
if (!fs.existsSync(SRC_DIR)) {
  console.error('× 找不到目录 ' + SRC_DIR);
  process.exit(1);
}
const files = fs.readdirSync(SRC_DIR).filter(f => /\.svg$/i.test(f));
if (!files.length) {
  console.error('× ' + SRC_DIR + ' 里没有 .svg');
  process.exit(1);
}

const rows = [];
for (const f of files) {
  const id = f.replace(/\.svg$/i, '');
  const svg = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  /* 找出所有 path，取 d 最长的那条（防止文件里有装饰用的小路径） */
  const ds = Array.from(svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)).map(m => m[1]);
  if (!ds.length) { console.error('× ' + f + ' 里没有 <path d="...">'); process.exit(1); }
  ds.sort((a, b) => b.length - a.length);
  const d = ds[0];

  const subs = endpoints(d);
  if (subs.length < 2) {
    console.error('× ' + f + ' 只有 ' + subs.length + ' 个子路径，头型需要「外轮廓 + 内孔」两个');
    process.exit(1);
  }
  const o = bbox(subs[0]);
  const i = bbox(subs[1]);
  if (!o.w || !o.h) { console.error('× ' + f + ' 外轮廓尺寸为 0'); process.exit(1); }

  /* 单独抠出外轮廓那条子路径：实心模式要用它。
     不能靠 nonzero 让整个 d 填满——实测这两个子路径方向相反，nonzero 出来的还是环。 */
  const segs = d.split('M');
  const outerD = segs.length > 1 ? 'M' + segs[1] : d;
  /* 内孔那条子路径：遮罩挖空要用它（用正圆近似会在头环上啃出缺口） */
  const innerD = segs.length > 2 ? 'M' + segs[2] : null;

  rows.push({
    id,
    w: r1(o.w), h: r1(o.h), ox: r1(o.cx), oy: r1(o.cy),
    ratio: r3(((i.w / o.w) + (i.h / o.h)) / 2),
    d, outerD, innerD
  });
  console.log('  ' + id.padEnd(6) + ' 外径 ' + (Math.round(o.w) + '×' + Math.round(o.h)).padEnd(11) +
    ' 内/外 ' + (((i.w / o.w) + (i.h / o.h)) / 2).toFixed(3));
}

rows.sort((a, b) => {
  const ia = ORDER.indexOf(a.id), ib = ORDER.indexOf(b.id);
  if (ia < 0 && ib < 0) return a.id.localeCompare(b.id);
  if (ia < 0) return 1;
  if (ib < 0) return -1;
  return ia - ib;
});

/* ---------- 生成 JS ---------- */
const L = [];
const P = s => L.push(s);
P('/* ==================== v6.4.0 手绘头型 ====================');
P(' * 由 tools/gen_head_shapes.js 从 tools/heads/*.svg 自动生成，不要手改。');
P(' * 每个头型是「单条闭合路径 + evenodd」= 外轮廓 + 内孔，本质是一个填充环。');
P(' *   w/h/ox/oy  外轮廓端点包围盒与中心 —— 用来把每个头型都归一化到和正圆一样大；');
P(' *   ratio      内孔直径 / 外径 —— 遮罩挖空用（肢体不能画进环里）。');
P(' * 想加新头型：把 SVG 丢进 tools/heads/，跑一次 node tools/gen_head_shapes.js。');
P(' */');
P('window.SKFE = window.SKFE || {};');
P('window.SKFE.systems = window.SKFE.systems || {};');
P('SKFE.systems.headShapes = (function () {');
P('  const DATA = [');
for (const r of rows) {
  P('    { id: ' + JSON.stringify(r.id) + ', w: ' + r.w + ', h: ' + r.h + ', ox: ' + r.ox + ', oy: ' + r.oy + ', ratio: ' + r.ratio + ',');
  P('      d: ' + JSON.stringify(r.d) + ',');
  P('      outerD: ' + JSON.stringify(r.outerD) + ',');
  P('      innerD: ' + JSON.stringify(r.innerD) + ' },');
}
P('  ];');
P('');
P('  const byId = new Map();');
P('  DATA.forEach(s => byId.set(s.id, s));');
P('');
P('  /* Path2D 只构造一次：每帧都要 fill，重复 new 太浪费 */');
P('  const p2d = new Map();');
P('  const p2dOuter = new Map();');
P('  const p2dInner = new Map();');
P('  function path2d(id) {');
P('    if (p2d.has(id)) return p2d.get(id);');
P('    const s = byId.get(id);');
P('    let p = null;');
P('    if (s) { try { p = new Path2D(s.d); } catch (_) { p = null; } }');
P('    p2d.set(id, p);');
P('    return p;');
P('  }');
P('  /* 只有外轮廓的单路径：实心填充用它（nonzero 一定能填满整个盘） */');
P('  function outerPath2d(id) {');
P('    if (p2dOuter.has(id)) return p2dOuter.get(id);');
P('    const s = byId.get(id);');
P('    let p = null;');
P('    if (s && s.outerD) { try { p = new Path2D(s.outerD); } catch (_) { p = null; } }');
P('    p2dOuter.set(id, p);');
P('    return p;');
P('  }');
P('  /* 只有内孔的单路径：遮罩挖空用它 */');
P('  function innerPath2d(id) {');
P('    if (p2dInner.has(id)) return p2dInner.get(id);');
P('    const s = byId.get(id);');
P('    let p = null;');
P('    if (s && s.innerD) { try { p = new Path2D(s.innerD); } catch (_) { p = null; } }');
P('    p2dInner.set(id, p);');
P('    return p;');
P('  }');
P('');
P('  function get(id) { return byId.get(id) || null; }');
P("  function list() { return DATA.map(s => ({ id: s.id, ratio: s.ratio })); }");
P('  function has(id) { return byId.has(id); }');
P('  /* 内孔半径 / 外半径：遮罩挖空用；拿不到头型时返回 0，调用方退回「不挖」 */');
P('  function innerRatio(id) { const s = byId.get(id); return s ? s.ratio : 0; }');
P('');
P('  /* 把 headC + headR 映射到头型自己的坐标系，然后回调 fn(path, k, shape, outerPath)，');
P('     回调里直接 fill/stroke 就行，出了回调自动还原变换。');
P('     cx,cy 头心 · radius 外半径（直径 = 2*radius）· angle 头朝向（0 = 正立） */');
P('  function draw(ctx, id, cx, cy, radius, angle, fn) {');
P('    const s = byId.get(id);');
P('    const p = path2d(id);');
P("    if (!s || !p || typeof fn !== 'function') return false;");
P('    /* 最大边对齐到直径：换成手绘头型后和原来的正圆"看起来一样大" */');
P('    const k = (radius * 2) / Math.max(s.w, s.h);');
P('    ctx.save();');
P('    ctx.translate(cx, cy);');
P('    if (angle) ctx.rotate(angle);');
P('    ctx.scale(k, k);');
P('    ctx.translate(-s.ox, -s.oy);');
P('    fn(p, k, s, outerPath2d(id));');
P('    ctx.restore();');
P('    return true;');
P('  }');
P('');
P('  /* 内孔路径 → 世界坐标的变换矩阵（和 draw 里那套完全一致） */');
P('  function matrixOf(s, cx, cy, radius, angle, shrink) {');
P('    const k = (radius * 2) / Math.max(s.w, s.h) * (shrink || 1);');
P('    const m = new DOMMatrix();');
P('    m.translateSelf(cx, cy);');
P('    if (angle) m.rotateSelf(angle * 180 / Math.PI);');
P('    m.scaleSelf(k, k);');
P('    m.translateSelf(-s.ox, -s.oy);');
P('    return m;');
P('  }');
P('');
P('  /* 遮罩挖空：把「整屏减去内孔」做成裁剪区，肢体只在内孔里被裁掉。');
P('     比正圆近似准得多——圆的边界会捅出头环，在头上啃出月牙缺口。');
P('     shrink 略小于 1：宁可让肢体在孔沿留 1px，也不要啃进头环。 */');
P('  function holeClip(ctx, id, cx, cy, radius, angle, shrink) {');
P('    const s = byId.get(id);');
P('    const pin = innerPath2d(id);');
P('    if (!s || !pin) return false;');
P('    const p = new Path2D();');
P('    p.rect(-100000, -100000, 200000, 200000);');
P('    p.addPath(pin, matrixOf(s, cx, cy, radius, angle, shrink === undefined ? 1.02 : shrink));');
P("    ctx.clip(p, 'evenodd');");
P('    return true;');
P('  }');
P('');
P('  return { get, list, has, innerRatio, path2d, outerPath2d, innerPath2d, holeClip, draw };');
P('})();');

fs.writeFileSync(OUT, L.join('\n') + '\n', 'utf8');
console.log('\n✓ ' + rows.length + ' 个头型 → ' + path.relative(ROOT, OUT) +
  '  (' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)');
