// js/systems/eraser.js
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.eraser = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  /* brush-v5.1.0: 面板文案走 i18n，语言切换后仍能显示正确文字 */
  function tr(key, fallback) {
    try {
      if (typeof window.t === 'function') {
        const s = window.t(key);
        if (s && s !== key) return s;
      }
    } catch (_) {}
    return fallback;
  }

/* ---------------- 圆形笔刷矢量橡皮擦 ---------------- */
let eraserOn = false;
let eraserSize = 15;
let eraserDrag = null;
let eraserLineMode = false;

function getActiveViewScale() {
  const cam = D.getCameraViewObject();
  if (cam) return Math.max(0.0001, D.getCameraViewTransform(cam).fit);
  return Math.max(0.0001, D.AppState.viewScale);
}

function hasEraserStrokes(o) {
  if (!o) return false;
  if (o.type === 'figure') {
    if (!o.eraser || Array.isArray(o.eraser)) return false;
    return Object.keys(o.eraser).some(k => o.eraser[k] && o.eraser[k].some(st => st.points && st.points.length));
  }
  return !!(o && o.type !== 'camera' && Array.isArray(o.eraser) && o.eraser.some(st => st.points && st.points.length));
}

function getEraserScale(o) {
  if (!o) return 1;
  if (o.type === 'figure' || o.type === 'image') return Math.max(0.0001, o.scale || 1);
  if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') {
    const tr = D.getBindTransform(o);
    return Math.max(0.0001, (o.scale || 1) * (tr.syncScale || 1));
  }
  return Math.max(0.0001, o.scale || 1);
}

/* 仿射矩阵：局部坐标 -> 世界坐标 */
function affId() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
function affMul(m, n) {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f
  };
}
function affTranslate(x, y) { return { a: 1, b: 0, c: 0, d: 1, e: x, f: y }; }
function affRotateDeg(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}
function affScale(x, y) { return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 }; }
function affApply(m, p) {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}
function affInvert(m) {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return affId();
  return {
    a: m.d / det, b: -m.b / det,
    c: -m.c / det, d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det
  };
}

function objectEraserMatrix(o) {
  let m = affId();
  const s = getEraserScale(o);
  if (o.type === 'figure') {
    m = affMul(m, affTranslate(o.x, o.y));
    if (o.rot) m = affMul(m, affRotateDeg(o.rot));
    m = affMul(m, affScale(o.mirror ? -s : s, s));
    m = affMul(m, affTranslate(-o.x, -o.y));
  } else if (o.type === 'image') {
    const { ax, ay } = D.getAnchorOffset(o, o.scale || 1);
    m = affMul(m, affTranslate(o.x + ax, o.y + ay));
    if (o.rot) m = affMul(m, affRotateDeg(o.rot));
    m = affMul(m, affScale(s, s));
  } else if (o.type === 'acc') {
    const tr = D.getBindTransform(o);
    const figTr = D.getBoundFigureTransform(o);
    if (figTr) {
      m = affMul(m, affTranslate(figTr.x, figTr.y));
      if (figTr.rot) m = affMul(m, affRotateDeg(figTr.rot));
      if (figTr.mirror) m = affMul(m, affScale(-1, 1));
      m = affMul(m, affTranslate(-figTr.x, -figTr.y));
    }
    const { ax, ay } = D.getAnchorOffset(o, s);
    m = affMul(m, affTranslate(tr.x + ax, tr.y + ay));
    m = affMul(m, affRotateDeg(tr.angle * 180 / Math.PI));
    m = affMul(m, affScale(s, s));
  } else if (o.type === 'ink') {
    /* brush-v5.1.0: 实现 §6.2.1 —— ink 的局部坐标 → 世界坐标
       必须与 app.js 中 queueInk 的 ctx 变换顺序完全一致：
       fig 旋转/镜像 → 平移(tr + anchor) → 旋转 → ink 镜像 → 回退 anchor → 缩放 */
    const tr = D.getBindTransform(o);
    const figTr = D.getBoundFigureTransform(o);
    if (figTr) {
      m = affMul(m, affTranslate(figTr.x, figTr.y));
      if (figTr.rot) m = affMul(m, affRotateDeg(figTr.rot));
      if (figTr.mirror) m = affMul(m, affScale(-1, 1));
      m = affMul(m, affTranslate(-figTr.x, -figTr.y));
    }
    const { ax, ay } = D.getAnchorOffset(o, s);
    m = affMul(m, affTranslate(tr.x + ax, tr.y + ay));
    m = affMul(m, affRotateDeg(tr.angle * 180 / Math.PI));
    if (o.mirror) m = affMul(m, affScale(-1, 1));
    m = affMul(m, affTranslate(-ax, -ay));
    m = affMul(m, affScale(s, s));
  } else {
    const tr = D.getBindTransform(o);
    const figTr = D.getBoundFigureTransform(o);
    if (figTr) {
      m = affMul(m, affTranslate(figTr.x, figTr.y));
      if (figTr.rot) m = affMul(m, affRotateDeg(figTr.rot));
      if (figTr.mirror) m = affMul(m, affScale(-1, 1));
      m = affMul(m, affTranslate(-figTr.x, -figTr.y));
    }
    const { ax, ay } = D.getAnchorOffset(o, s);
    m = affMul(m, affTranslate(tr.x + ax, tr.y + ay));
    m = affMul(m, affRotateDeg(tr.angle * 180 / Math.PI));
    m = affMul(m, affTranslate(-ax, -ay));
    m = affMul(m, affScale(s, s));
  }
  return m;
}

function worldToEraseLocal(o, p) {
  return affApply(affInvert(objectEraserMatrix(o)), p);
}

function eraserHitObject(o, p) {
  if (!o || o.locked || o.type === 'camera' || o.type === 'video') return false;
  const hitR = 18 / getActiveViewScale();
  if (o.type === 'figure') {
    const pL = (o.rot || o.mirror) ? D.worldToFigureLocal(o, p) : p;
    const j = D.jointData(o);
    if (D.segments(j, o).some(([a, b]) => D.distToSeg(pL, a, b) < hitR)) return true;
    return Math.hypot(pL.x - j.headC.x, pL.y - j.headC.y) < j.headR + hitR;
  }
  if (o.type === 'image') {
    const b = D.imageBounds(o);
    const { ax, ay } = D.getAnchorOffset(o, o.scale || 1);
    const dx = p.x - (o.x + ax), dy = p.y - (o.y + ay);
    const rot = (o.rot || 0) * Math.PI / 180;
    const c = Math.cos(-rot), s = Math.sin(-rot);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return Math.abs(rx + ax) <= b.w / 2 + hitR && Math.abs(ry + ay) <= b.h / 2 + hitR;
  }
  return D.hitObj(o, p);
}

function getEraserTargetAt(p) {
  // 橡皮擦只作用于当前选中的元件，不扫描其他元件，也不允许点击命中其他元件
  if (D.AppState.selected && D.AppState.selected.type !== 'camera' && !D.AppState.selected.locked && eraserHitObject(D.AppState.selected, p)) {
    return { obj: D.AppState.selected };
  }
  return null;
}

/* ============ 橡皮擦 v2：骨段级归一化局部坐标 ============ */
/* 每个肢体拆成两段（如 neck→elbow、elbow→hand），每段独立局部坐标系。
   lx = 沿骨段方向的世界长度 / 骨段长度平方（允许 0~1 之外）
   ly = 垂直方向的世界长度 / 骨段长度平方
   这样：缩放时自动跟随、旋转时跟着骨段走、不会跨关节直线化。 */
   function getLimbSegs(j, limb) {
  switch (limb) {
    case 'body': return [[j.pelvis, j.waistPoint], [j.waistPoint, j.neck]];
    case 'armL': return [[j.neck, j.elbowL], [j.elbowL, j.handL]];
    case 'armR': return [[j.neck, j.elbowR], [j.elbowR, j.handR]];
    case 'legL': return [[j.pelvis, j.thighL], [j.thighL, j.footL]];
    case 'legR': return [[j.pelvis, j.thighR], [j.thighR, j.footR]];
  }
  return [];
}

function pointToSegLocal(P, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-8) return { lx: 0, ly: 0 };
  const px = P.x - A.x, py = P.y - A.y;
  return {
    lx: (px * dx + py * dy) / L2,
    ly: (px * (-dy) + py * dx) / L2
  };
}

function segLocalToWorld(local, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  return {
    x: A.x + local.lx * dx + local.ly * (-dy),
    y: A.y + local.lx * dy + local.ly * dx
  };
}

function findNearestLimbSeg(P, j, maxDist) {
  let best = null, bestD = maxDist;
  const dHead = Math.abs(Math.hypot(P.x - j.headC.x, P.y - j.headC.y) - j.headR);
  if (dHead < bestD) { bestD = dHead; best = { limb: 'head', seg: 0 }; }
  const limbs = ['body', 'armL', 'armR', 'legL', 'legR'];
  for (const limb of limbs) {
    const segs = getLimbSegs(j, limb);
    for (let i = 0; i < segs.length; i++) {
      const d = D.distToSeg(P, segs[i][0], segs[i][1]);
      if (d < bestD) { bestD = d; best = { limb, seg: i }; }
    }
  }
  return best;
}

/* 把采样点追加到 eraserDrag（自动按当前最近骨段分桶，跨段时自动新开一笔） */
function addEraserPointToDrag(drag, pUse) {
  const o = drag.o;
  const j = D.jointData(o);
  const vs = getActiveViewScale();
  const tol = 24 / vs;

  const hit = findNearestLimbSeg(pUse, j, tol);
  if (!hit) {
    drag.current = null;
    drag.currentKey = null;
    return;
  }

  const key = hit.limb + '_' + hit.seg;
  let local;
  if (hit.limb === 'head') {
    local = { x: pUse.x - j.headC.x, y: pUse.y - j.headC.y };
  } else {
    const segs = getLimbSegs(j, hit.limb);
    const [A, B] = segs[hit.seg];
    local = pointToSegLocal(pUse, A, B);
  }

  /* 记录直线模式的起点 */
  if (!drag.startLimb && hit.limb !== 'head') {
    drag.startLimb = hit.limb;
    drag.startSeg = hit.seg;
    drag.startLocal = local;
  }

  /* 切换骨段 → 结束当前 stroke，新开一个 */
  if (!drag.current || drag.currentKey !== key) {
    const stroke = { size: drag.localSize, seg: hit.seg, points: [local] };
    if (!o.eraser[hit.limb]) o.eraser[hit.limb] = [];
    o.eraser[hit.limb].push(stroke);
    drag.current = stroke;
    drag.currentKey = key;
    drag.currentLimb = hit.limb;
    drag.currentSeg = hit.seg;
    drag.hadNewStroke = true;
    return;
  }

  /* 防抖（屏幕像素） */
  const last = drag.current.points[drag.current.points.length - 1];
  if (!last) { drag.current.points.push(local); return; }
  let screenDist;
  if (hit.limb === 'head') {
    screenDist = Math.hypot(local.x - last.x, local.y - last.y) * vs;
  } else {
    const segs = getLimbSegs(j, hit.limb);
    const [A, B] = segs[hit.seg];
    const L = Math.hypot(B.x - A.x, B.y - A.y);
    screenDist = Math.hypot(local.lx - last.lx, local.ly - last.ly) * L * vs;
  }
  if (screenDist < 0.6) return;
  drag.current.points.push(local);
}

/* 计算点相对于肢体线段的局部坐标 (t为0-1进度, d为垂直距离) */
function worldToLimbLocal(P, pts) {
  const A = pts[0], B = pts[pts.length - 1];
  const vx = B.x - A.x, vy = B.y - A.y;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1) return { t: 0, d: Math.hypot(P.x - A.x, P.y - A.y) };
  let t = ((P.x - A.x) * vx + (P.y - A.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projx = A.x + vx * t, projy = A.y + vy * t;
  const len = Math.sqrt(len2);
  const nx = -vy / len, ny = vx / len;
  const d = (P.x - projx) * nx + (P.y - projy) * ny;
  return { t, d };
}

/* 将局部坐标还原为当前肢体的世界坐标 */
function limbLocalToWorld(lp, pts) {
  const A = pts[0], B = pts[pts.length - 1];
  const vx = B.x - A.x, vy = B.y - A.y;
  const len = Math.hypot(vx, vy);
  if (len < 0.01) return { x: A.x, y: A.y };
  const projx = A.x + vx * lp.t, projy = A.y + vy * lp.t;
  const nx = -vy / len, ny = vx / len;
  return { x: projx + nx * lp.d, y: projy + ny * lp.d };
}

/* 判断点击落在了哪个肢体/骨段上（保留旧接口，内部走 findNearestLimbSeg） */
function getEraserLimbTarget(f, p) {
  const j = D.jointData(f);
  const hit = findNearestLimbSeg(p, j, 24 / getActiveViewScale());
  return { limb: hit ? hit.limb : null, seg: hit ? hit.seg : -1, joint: j };
}

function computeEraserPoint(f, p) {
  const j = D.jointData(f);
  const limbsMap = {
    body: [j.pelvis, j.waistPoint, j.neck],
    armL: [j.neck, j.elbowL, j.handL],
    armR: [j.neck, j.elbowR, j.handR],
    legL: [j.pelvis, j.thighL, j.footL],
    legR: [j.pelvis, j.thighR, j.footR]
  };
  
  // 容差：距离肢体一定范围内吸附
  const vs = getActiveViewScale();
  const s = getEraserScale(f);
  const tol = 20 / (vs * s); 

  let bestLimb = null, bestD = tol;
  const dHead = Math.abs(Math.hypot(p.x - j.headC.x, p.y - j.headC.y) - j.headR);
  if (dHead < bestD) { bestLimb = 'head'; bestD = dHead; }

  for (const k in limbsMap) {
    const pts = limbsMap[k];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = D.distToSeg(p, pts[i], pts[i+1]);
      if (d < bestD) { bestD = d; bestLimb = k; }
    }
  }
  
  // 吸附到肢体
  if (bestLimb) {
    if (bestLimb === 'head') {
      return { limb: 'head', x: p.x - j.headC.x, y: p.y - j.headC.y };
    } else {
      return { limb: bestLimb, ...worldToLimbLocal(p, limbsMap[bestLimb]) };
    }
  }
  
  // 没碰到肢体则用整体坐标（空白处涂鸦）
  const local = worldToEraseLocal(f, p);
  return { limb: 'global', x: local.x, y: local.y };
}

function resolveEraserPoint(f, pt) {
  const j = D.jointData(f);
  if (pt.limb === 'head') {
    return { x: j.headC.x + pt.x, y: j.headC.y + pt.y };
  }
  if (pt.limb === 'global' || !pt.limb) {
    const m = objectEraserMatrix(f);
    return affApply(m, { x: pt.x, y: pt.y });
  }
  
  const limbsMap = {
    body: [j.pelvis, j.waistPoint, j.neck],
    armL: [j.neck, j.elbowL, j.handL],
    armR: [j.neck, j.elbowR, j.handR],
    legL: [j.pelvis, j.thighL, j.footL],
    legR: [j.pelvis, j.thighR, j.footR]
  };
  if (limbsMap[pt.limb]) {
    return limbLocalToWorld(pt, limbsMap[pt.limb]);
  }
  return { x: f.x, y: f.y };
}

/* brush-v5.1.2: 新遮罩的落笔序号 —— 必须排在所有已有笔迹之上，
   否则它会被自己该擦的笔迹"盖住"（渲染时按 z 交替落笔） */
function nextMaskZ(o) {
  let m = 0;
  const arr = Array.isArray(o.eraser) ? o.eraser : [];
  for (const er of arr) if (er && typeof er.z === 'number' && er.z > m) m = er.z;
  for (const s of (o.strokes || [])) if (s && typeof s.z === 'number' && s.z > m) m = s.z;
  return m + 1;
}

function startEraserStroke(p, e) {
  /* 只作用于当前选中对象；不再要求起点命中肢体，允许从空白起笔 */
  const o = D.AppState.selected;
  if (!o || o.locked || o.type === 'camera' || o.type === 'video') return false;

  let pUse = p;
  if (o.type === 'figure' && (o.rot || o.mirror)) {
    pUse = D.worldToFigureLocal(o, p);
  }

  const vs = getActiveViewScale();
  const s = getEraserScale(o);
  /* size 存"figure 局部单位"，渲染时乘 f.scale 还原为世界单位 */
  const localSize = Math.max(0.0001, eraserSize / (vs * s));

  if (o.type === 'figure') {
    if (Array.isArray(o.eraser) || !o.eraser) o.eraser = {};
    for (const limb of ['head', 'body', 'armL', 'armR', 'legL', 'legR']) {
      if (!o.eraser[limb]) o.eraser[limb] = [];
    }
    eraserDrag = {
      o,
      pre: D.getSnapshot(),
      localSize,
      current: null,
      currentKey: null,
      currentLimb: null,
      currentSeg: -1,
      startLimb: null,
      startSeg: -1,
      startLocal: null,
      hadNewStroke: false
    };
    /* 起点若命中某段，立即开一笔；未命中就等拖到肢体上再开 */
    addEraserPointToDrag(eraserDrag, pUse);
  } else {
    if (!Array.isArray(o.eraser)) o.eraser = [];
    const local = worldToEraseLocal(o, p);
    const stroke = { size: localSize, points: [local], z: nextMaskZ(o) };
    o.eraser.push(stroke);
    eraserDrag = {
      o,
      pre: D.getSnapshot(),
      localSize,
      current: stroke,
      currentKey: 'global',
      currentLimb: null,
      currentSeg: -1,
      startLimb: null,
      startSeg: -1,
      startLocal: local,
      hadNewStroke: true
    };
  }

  D.hideHandles();
  try { D.getCanvas().setPointerCapture(e.pointerId); } catch (_) {}
  D.EventBus.emit('need:render');
  return true;
}

function updateEraserStroke(p) {
  const d = eraserDrag;
  if (!d) return;
  const o = d.o;

  let pUse = p;
  if (o.type === 'figure' && (o.rot || o.mirror)) {
    pUse = D.worldToFigureLocal(o, p);
  }

  if (o.type === 'figure') {
    if (eraserLineMode) {
      /* 直线模式：固定在起点所在骨段上，每帧替换为 [起点, 当前投影] */
      if (!d.startLimb || !d.startLocal) return;
      const j = D.jointData(o);
      const segs = getLimbSegs(j, d.startLimb);
      const seg = segs[d.startSeg];
      if (!seg) return;
      const currentLocal = pointToSegLocal(pUse, seg[0], seg[1]);
      if (!d.current) {
        const stroke = { size: d.localSize, seg: d.startSeg, points: [d.startLocal, currentLocal] };
        o.eraser[d.startLimb].push(stroke);
        d.current = stroke;
        d.currentKey = d.startLimb + '_' + d.startSeg;
        d.currentLimb = d.startLimb;
        d.currentSeg = d.startSeg;
        d.hadNewStroke = true;
      } else {
        d.current.points = [d.startLocal, currentLocal];
      }
    } else {
      addEraserPointToDrag(d, pUse);
    }
  } else {
    /* 非 figure：仍用 figure 局部坐标 (x,y) 存储 */
    const local = worldToEraseLocal(o, p);
    if (!d.current) {
      const stroke = { size: d.localSize, points: [local], z: nextMaskZ(o) };
      o.eraser.push(stroke);
      d.current = stroke;
      d.hadNewStroke = true;
    } else {
      const last = d.current.points[d.current.points.length - 1];
      const vs = getActiveViewScale();
      const s = getEraserScale(o);
      if (last && Math.hypot(local.x - last.x, local.y - last.y) * vs * s < 0.6) {
        D.EventBus.emit('need:render');
        return;
      }
      d.current.points.push(local);
    }
  }
  D.EventBus.emit('need:render');
}


function simplifyEraserPath(points, eps) {
  if (!points || points.length <= 2) return points || [];
  const sq = Math.max(0.000001, eps * eps);
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  const distSq = (p, a, b) => {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = p.x - (a.x + vx * t), dy = p.y - (a.y + vy * t);
    return dx * dx + dy * dy;
  };
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distSq(points[i], points[start], points[end]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) {
      keep[idx] = true;
      stack.push([start, idx], [idx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function finishEraserStroke() {
  const d = eraserDrag;
  if (!d) return;
  eraserDrag = null;
  const o = d.o;
  const vs = getActiveViewScale();
  const epsWorld = 0.45 / vs;  /* 屏幕上约 0.45px */

  /* 简化路径：head 用世界单位；骨段要除以骨段长度归一化 */
  if (o.type === 'figure') {
    const j = D.jointData(o);
    for (const limb of ['head', 'body', 'armL', 'armR', 'legL', 'legR']) {
      if (!o.eraser || !o.eraser[limb]) continue;
      for (const st of o.eraser[limb]) {
        if (!st.points || st.points.length < 3) continue;
        if (limb === 'head') {
          st.points = simplifyEraserPath(st.points, epsWorld);
        } else {
          const segs = getLimbSegs(j, limb);
          const seg = segs[st.seg] || segs[0];
          if (!seg) continue;
          const L = Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y);
          const epsLocal = epsWorld / Math.max(0.001, L);
          st.points = simplifyEraserPath(st.points, epsLocal);
        }
      }
    }
  } else if (Array.isArray(o.eraser)) {
    const eps = epsWorld / Math.max(0.0001, getEraserScale(o));
    for (const st of o.eraser) {
      if (st.points && st.points.length >= 3) {
        st.points = simplifyEraserPath(st.points, eps);
      }
    }
  }

  /* 如果一笔什么都没擦到，不记录历史 */
  if (!d.hadNewStroke) {
    D.EventBus.emit('need:render');
    return;
  }

  /* brush-v5.1.1: 画笔元件只在"有痕迹"的地方留遮罩 */
  if (o.type === 'ink') clipInkEraserMask(o);

  if (D.isGlobalEdit()) {
    D.setGlobalProp(o, 'eraser', JSON.parse(JSON.stringify(o.eraser || [])));
  }
  D.invalidateAllFrameThumbs();
  D.markCurrentFrameModified();
  if (d.pre) D.pushPreSnapshot(d.pre, '橡皮擦除');
  else D.EventBus.emit('history:save', '橡皮擦除');
  D.EventBus.emit('need:render');
}

/* brush-v5.1.1: 画笔元件的擦除遮罩裁剪
   —— 只保留压在已有笔迹上的遮罩点（边缘保留少量外扩），
      空白处的遮罩会被丢弃，避免"擦空白 → 之后补画的笔迹被挡住"。 */
function clipInkEraserMask(ink) {
  if (!ink || !Array.isArray(ink.eraser) || !ink.eraser.length) return;
  const strokes = ink.strokes || [];
  if (!strokes.length) { ink.eraser = []; return; }
  const IM = D.getInkLocalMatrix(ink);
  const o0 = affApply(IM, { x: 0, y: 0 });
  const o1 = affApply(IM, { x: 1, y: 0 });
  const unit = Math.hypot(o1.x - o0.x, o1.y - o0.y) || 1;
  const segs = [];
  for (const s of strokes) {
    const pts = s.points || [];
    if (!pts.length) continue;
    const bw = ((s.borderWidth || 0) * unit) / 2;
    for (let i = 0; i < pts.length; i++) {
      const a = affApply(IM, pts[i]);
      const b = affApply(IM, pts[Math.min(i + 1, pts.length - 1)]);
      const hw = (Math.max(pts[i].w || 0, pts[Math.min(i + 1, pts.length - 1)].w || 0) * unit) / 2 + bw;
      segs.push({ a, b, hw });
    }
  }
  if (!segs.length) { ink.eraser = []; return; }
  const M = objectEraserMatrix(ink);
  const out = [];
  for (const st of ink.eraser) {
    const pts = st.points || [];
    if (!pts.length) continue;
    const reach = Math.max(1, st.size || 1) / 2 + 1.5;
    let run = [];
    const flush = () => { if (run.length) { out.push({ size: st.size, points: run, z: st.z }); run = []; } };
    for (const p of pts) {
      const w = affApply(M, p);
      let hit = false;
      for (const sg of segs) {
        if (D.distToSeg(w, sg.a, sg.b) - sg.hw <= reach) { hit = true; break; }
      }
      if (hit) run.push(p);
      else flush();
    }
    flush();
  }
  ink.eraser = out;
}

function drawEraseMask(targetCtx, o) {
  let strokes = [];
  if (o.type === 'figure') {
    if (Array.isArray(o.eraser)) strokes = o.eraser;
    else if (o.eraser) {
      if (o.eraser.any) strokes = o.eraser.any;
      else {
        for (const k in o.eraser) {
          if (Array.isArray(o.eraser[k])) strokes = strokes.concat(o.eraser[k]);
        }
      }
    }
  } else {
    strokes = o.eraser || [];
  }
  if (!strokes.length) return;
  
  for (const st of strokes) {
    const pts = st && st.points;
    if (!pts || !pts.length) continue;
    const width = Math.max(0.0001, st.size || 1);
    
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'destination-out';
    targetCtx.globalAlpha = 1;
    
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = width;
    targetCtx.strokeStyle = '#000';
    targetCtx.fillStyle = '#000';
    
    targetCtx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      let P = { x: 0, y: 0 };
      if (o.type === 'figure') {
        P = resolveEraserPoint(o, pts[i]);
      } else {
        const m = objectEraserMatrix(o);
        P = affApply(m, pts[i]);
      }
      
      if (pts.length === 1) {
        targetCtx.arc(P.x, P.y, width / 2, 0, SKFE.core.constants.TAU);
        targetCtx.fill();
      } else {
        if (i === 0) targetCtx.moveTo(P.x, P.y);
        else targetCtx.lineTo(P.x, P.y);
      }
    }
    if (pts.length > 1) targetCtx.stroke();
    targetCtx.restore();
  }
}


function clearEraserFrame() {
  const pre = D.getSnapshot();
  const targets = (D.AppState.selected && D.AppState.selected.type !== 'camera') ? [D.AppState.selected] : D.AppState.objects.slice();
  targets.forEach(o => {
    if (!o || o.type === 'camera') return;
    if (o.type === 'figure') o.eraser = {};
    else o.eraser = [];
  });
  D.invalidateAllFrameThumbs();
  D.markCurrentFrameModified();
  D.pushPreSnapshot(pre, '清除本帧擦除');
  D.EventBus.emit('need:render');
}

function clearEraserAll() {
  const pre = D.getSnapshot();
  const targetId = (D.AppState.selected && D.AppState.selected.type !== 'camera') ? String(D.AppState.selected.id) : null;
  for (const id in D.AppState.tracks) {
    const t = D.AppState.tracks[id];
    if (!t || !t.frames) continue;
    for (const data of t.frames) {
      if (!data || data.type === 'camera') continue;
      if (targetId && String(data.id) !== targetId) continue;
      if (data.type === 'figure') data.eraser = {};
      else data.eraser = [];
    }
  }
  D.AppState.objects.forEach(o => {
    if (!o || o.type === 'camera') return;
    if (targetId && String(o.id) !== targetId) return;
    if (o.type === 'figure') o.eraser = {};
    else o.eraser = [];
  });
  D.invalidateAllFrameThumbs();
  D.markCurrentFrameModified();
  D.pushPreSnapshot(pre, '清除全部擦除');
  D.EventBus.emit('need:render');
}

function setEraserOn(on) {
  eraserOn = !!on;
  document.body.classList.toggle('eraser-mode', eraserOn);
  const btn = document.getElementById('btnEraserToggle');
  if (btn) {
    btn.textContent = eraserOn ? tr('eraser.enableOff', '🛑 关闭擦除') : tr('eraser.enable', '🧽 开启擦除');
    btn.classList.toggle('on', eraserOn);
  }
  const state = document.getElementById('eraserState');
  if (state) state.textContent = eraserOn ? tr('eraser.stateOn', '擦除中：在画布上按住拖动') : tr('eraser.stateIdle', '擦除 = 隐藏，不破坏原像素');
  const cursor = document.getElementById('eraserCursor');
  if (cursor && !eraserOn) cursor.style.display = 'none';
}

function updateEraserCursor(e) {
  const cursor = document.getElementById('eraserCursor');
  if (!cursor) return;
  if (!eraserOn) { cursor.style.display = 'none'; return; }
  const t = e.target;
  if (t && t.closest && (t.closest('#ui') || t.closest('#timeline') || t.closest('#floatControls') ||
      t.closest('#historyControls') || t.closest('#cameraPreviewFloat'))) {
    cursor.style.display = 'none';
    return;
  }
  cursor.style.display = 'block';
  cursor.style.width = eraserSize + 'px';
  cursor.style.height = eraserSize + 'px';
  cursor.style.left = e.clientX + 'px';
  cursor.style.top = e.clientY + 'px';
}

function initEraserUI() {
  const toggle = document.getElementById('btnEraserToggle');
  if (toggle) toggle.addEventListener('click', () => setEraserOn(!eraserOn));
  const lineModeCb = document.getElementById('eraserLineMode');
  if (lineModeCb) {
    lineModeCb.addEventListener('change', () => {
      eraserLineMode = lineModeCb.checked;
    });
  }
  const size = document.getElementById('eraserSize');
  const sizeVal = document.getElementById('eraserSizeVal');
  if (size) {
    size.addEventListener('input', () => {
      eraserSize = Math.max(1, Math.min(100, parseInt(size.value, 10) || 15));
      if (sizeVal) sizeVal.textContent = eraserSize;
    });
  }
  const cf = document.getElementById('btnEraserClearFrame');
  if (cf) cf.addEventListener('click', clearEraserFrame);
  const ca = document.getElementById('btnEraserClearAll');
  if (ca) ca.addEventListener('click', clearEraserAll);
  document.addEventListener('pointermove', updateEraserCursor, { passive: true });
  document.addEventListener('pointerleave', () => {
    const cursor = document.getElementById('eraserCursor');
    if (cursor) cursor.style.display = 'none';
  });

  /* 橡皮擦开启后，点击以下位置保留擦除模式：
     - 画布（继续作画）
     - 撤销/恢复按钮（用户明确要求撤销时不关闭）
     - "画笔"工具芯片（切换面板但不关闭擦除模式）
     - 画笔工具面板内部（可继续调大小/直线/清除等）
     其余任何 UI 点击都会关闭擦除模式，避免误擦。 */
     document.addEventListener('pointerdown', (e) => {
    if (!eraserOn) return;
    if (e.target === D.getCanvas()) return;
    const t = e.target;
    if (!t || !t.closest) return;
    /* brush-v5.1.0: 画笔模式下在 overlay 上作画 / 点浮动工具栏时，保持擦除模式 */
    if (t.id === 'brushOverlay') return;
    if (t.closest('#brushFloatBar')) return;
    if (t.closest('#btnUndo') || t.closest('#btnRedo')) return;
    if (t.closest('#toolChips .tool-chip[data-tool="eraser"]')) return;
    if (t.closest('.tool-panel[data-tool="eraser"]')) return;
    setEraserOn(false);
  }, true);
}


  /* ---------------- 对外 API ---------------- */
  function setOn(on) { setEraserOn(on); }
  function isOn() { return eraserOn; }
  function isDragging() { return !!eraserDrag; }
  function size() { return eraserSize; }
  function setSize(n) { eraserSize = Math.max(1, Math.min(100, parseInt(n, 10) || 15)); }
  function lineMode() { return eraserLineMode; }
  function setLineMode(b) { eraserLineMode = !!b; }

  return {
    init,
    setOn,
    isOn,
    isDragging,
    size,
    setSize,
    lineMode,
    setLineMode,
    startStroke: startEraserStroke,
    updateStroke: updateEraserStroke,
    finishStroke: finishEraserStroke,
    hitObject: eraserHitObject,
    hasStrokes: hasEraserStrokes,
    drawMask: drawEraseMask,
    clearFrame: clearEraserFrame,
    clearAll: clearEraserAll,
    initUI: initEraserUI,
    getActiveViewScale,
    getEraserTargetAt,
    getLimbSegs,
    segLocalToWorld,
    pointToSegLocal
  };
})();
