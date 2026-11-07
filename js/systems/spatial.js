// js/systems/spatial.js
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.spatial = (function () {
  'use strict';

  const SAMPLES = 40;

  /* 每条线（躯干/双臂/双腿）的头、尾粗细倍率默认值。1 = 原始线宽。 */
  function defaultLines() {
    return {
      body: { start: 1, end: 1 },
      armL: { start: 1, end: 1 },
      armR: { start: 1, end: 1 },
      legL: { start: 1, end: 1 },
      legR: { start: 1, end: 1 }
    };
  }

  /* 读取对象的 spatial 配置。旧版 z 关节模型已废弃：读到旧数据一律按
     「全部 1（均匀线宽）」处理，不报错也不迁移。 */
  function getSpatialConfig(fig) {
    if (!fig || fig.type !== 'figure') return null;
    const sp = fig.spatial;
    if (!sp || !(sp.strength > 0)) return null;
    const src = sp.lines || {};
    const lines = defaultLines();
    for (const k in lines) {
      const l = src[k];
      if (!l) continue;
      if (typeof l.start === 'number' && isFinite(l.start)) lines[k].start = l.start;
      if (typeof l.end === 'number' && isFinite(l.end)) lines[k].end = l.end;
    }
    return {
      strength: Math.max(0, Math.min(1, sp.strength)),
      lines
    };
  }

  /* 水滴缓动：t∈[0,1] 从「粗端」走向「细端」。
     1 - t^1.35 让宽度在粗的一端保持饱满（圆水滴头），
     越接近细端收得越快，形成水滴尾巴那种顺滑的锥形过渡。 */
  function dropEase(t) {
    if (t <= 0) return 1;
    if (t >= 1) return 0;
    return 1 - Math.pow(t, 1.35);
  }

  function sampleSmoothPath(pts, radius, N) {
    N = Math.max(8, N || SAMPLES);
    if (!pts || pts.length < 2) return [];
    if (pts.length === 2 || radius <= 0.1) {
      const a = pts[0], b = pts[1], out = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, u: t });
      }
      return out;
    }
    const A = pts[0], B = pts[1], C = pts[2];
    let v1x = B.x - A.x, v1y = B.y - A.y;
    let v2x = C.x - B.x, v2y = C.y - B.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const l2 = Math.hypot(v2x, v2y) || 1;
    v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
    const r = Math.min(radius, l1 / 2, l2 / 2);
    const p1 = { x: B.x - v1x * r, y: B.y - v1y * r };
    const p2 = { x: B.x + v2x * r, y: B.y + v2y * r };

    const lenA = Math.hypot(p1.x - A.x, p1.y - A.y);
    const lenB = Math.hypot(B.x - p1.x, B.y - p1.y) + Math.hypot(p2.x - B.x, p2.y - B.y);
    const lenC = Math.hypot(C.x - p2.x, C.y - p2.y);
    const total = lenA + lenB + lenC || 1;

    const nA = Math.max(2, Math.round(N * lenA / total));
    const nB = Math.max(4, Math.round(N * lenB / total));
    const nC = Math.max(2, Math.round(N * lenC / total));

    const out = [];
    for (let i = 0; i <= nA; i++) {
      const t = i / nA;
      out.push({ x: A.x + (p1.x - A.x) * t, y: A.y + (p1.y - A.y) * t, u: 0 });
    }
    for (let i = 1; i <= nB; i++) {
      const t = i / nB, mt = 1 - t;
      out.push({
        x: mt * mt * p1.x + 2 * mt * t * B.x + t * t * p2.x,
        y: mt * mt * p1.y + 2 * mt * t * B.y + t * t * p2.y,
        u: 0
      });
    }
    for (let i = 1; i <= nC; i++) {
      const t = i / nC;
      out.push({ x: p2.x + (C.x - p2.x) * t, y: p2.y + (C.y - p2.y) * t, u: 0 });
    }

    const n = out.length;
    for (let i = 0; i < n; i++) out[i].u = i / (n - 1);
    return out;
  }

  function buildSmoothPath(ctx, pts, radius) {
    if (pts.length < 2) return;
    if (pts.length === 2 || radius <= 0.1) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      return;
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const prev = pts[i - 1], cur = pts[i], next = pts[i + 1];
      let v1x = cur.x - prev.x, v1y = cur.y - prev.y;
      let v2x = next.x - cur.x, v2y = next.y - cur.y;
      const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
      v1x /= l1; v1y /= l1; v2x /= l2; v2y /= l2;
      const r = Math.min(radius, l1 / 2, l2 / 2);
      const p1 = { x: cur.x - v1x * r, y: cur.y - v1y * r };
      const p2 = { x: cur.x + v2x * r, y: cur.y + v2y * r };
      ctx.lineTo(p1.x, p1.y);
      ctx.quadraticCurveTo(cur.x, cur.y, p2.x, p2.y);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  function drawCaps(ctx, pts, lw, color) {
    if (!pts || pts.length < 2 || lw <= 0) return;
    ctx.save();
    ctx.fillStyle = color;
    const half = lw / 2;
    ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, half, 0, Math.PI * 2); ctx.fill();
    const end = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(end.x, end.y, half, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /**
   * 核心：水滴状粗细过渡的肢体绘制。
   * ends = { start, end }：这条线「起点 / 终点」的粗细倍率（1 = 原始线宽）。
   * 强度 strength 只缩放「偏离 1 的部分」：强度 0.5 时 1.8 的头宽表现为 1.4。
   * 宽度沿整条线一次性水滴缓动（不再按骨段分段），粗端饱满、细端收锥。
   */
  function drawZVariedLimb(ctx, pts, radius, baseLW, fillStyle, ends, strength) {
    if (!pts || pts.length < 2) return;

    if (!(strength > 0)) {
      ctx.strokeStyle = fillStyle;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = baseLW;
      ctx.beginPath();
      buildSmoothPath(ctx, pts, radius);
      ctx.stroke();
      drawCaps(ctx, pts, baseLW, fillStyle);
      return;
    }

    const samples = sampleSmoothPath(pts, radius, SAMPLES);
    const N = samples.length;
    if (N < 2) return;

    const s = Math.max(0, Math.min(1, strength));
    const fStart = 1 + (((ends && ends.start) || 1) - 1) * s;
    const fEnd   = 1 + (((ends && ends.end)   || 1) - 1) * s;

    // 路径总长：宽度上限放宽到 85%（水滴头本来就该圆，旧版 60% 会把效果整个吃掉）
    let totalLen = 0;
    for (let i = 1; i < N; i++) {
      totalLen += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    }
    const wCap = totalLen * 0.85;

    // 宽度沿整条线一次性水滴缓动：起点 fStart → 终点 fEnd，中间不设锚点
    const w0 = Math.min(baseLW * fStart, wCap);
    const w2 = Math.min(baseLW * fEnd, wCap);
    const wArr = new Array(N);
    for (let i = 0; i < N; i++) {
      const u = samples[i].u;
      wArr[i] = w2 + (w0 - w2) * dropEase(u);
    }

    // 左右包络
    const leftEdge = [], rightEdge = [];
    for (let i = 0; i < N; i++) {
      const sm = samples[i];
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(N - 1, i + 1)];
      let dx = next.x - prev.x, dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy, ny = dx, hw = wArr[i] / 2;
      leftEdge.push({ x: sm.x + nx * hw, y: sm.y + ny * hw });
      rightEdge.push({ x: sm.x - nx * hw, y: sm.y - ny * hw });
    }

    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.beginPath();

    const P0 = samples[0], PN = samples[N - 1];
    const L0 = leftEdge[0], R0 = rightEdge[0];
    const LN = leftEdge[N - 1], RN = rightEdge[N - 1];
    const K = 4 / 3;                           // 单段三次贝塞尔近似半圆的标准系数（控制点纯沿切线）
    const r0 = wArr[0] / 2, rN = wArr[N - 1] / 2;
    // 切线（指向路径前方）与法线
    let d0x = samples[1].x - P0.x, d0y = samples[1].y - P0.y;
    const d0l = Math.hypot(d0x, d0y) || 1; d0x /= d0l; d0y /= d0l;
    let dNx = PN.x - samples[N - 2].x, dNy = PN.y - samples[N - 2].y;
    const dNl = Math.hypot(dNx, dNy) || 1; dNx /= dNl; dNy /= dNl;

    // 从左边缘起点出发
    ctx.moveTo(L0.x, L0.y);

    // 起点圆头（向后鼓出的半圆；细端在这里自然收成水滴圆尖）
    ctx.bezierCurveTo(
      L0.x - d0x * r0 * K, L0.y - d0y * r0 * K,
      R0.x - d0x * r0 * K, R0.y - d0y * r0 * K,
      R0.x, R0.y
    );

    // 右边缘走到终点
    for (let i = 1; i < N; i++) ctx.lineTo(rightEdge[i].x, rightEdge[i].y);

    // 终点圆头（向前鼓出的半圆）
    ctx.bezierCurveTo(
      RN.x + dNx * rN * K, RN.y + dNy * rN * K,
      LN.x + dNx * rN * K, LN.y + dNy * rN * K,
      LN.x, LN.y
    );

    // 左边缘走回起点
    for (let i = N - 2; i >= 0; i--) ctx.lineTo(leftEdge[i].x, leftEdge[i].y);

    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* 命中测试 / 包围框的宽度余量：取所有线条里最大的倍率（含 strength 缩放） */
  function maxLimbWidthFactor(fig) {
    const sp = getSpatialConfig(fig);
    if (!sp) return 1;
    let m = 1;
    for (const k in sp.lines) {
      const l = sp.lines[k];
      if (l.start > m) m = l.start;
      if (l.end > m) m = l.end;
    }
    return Math.min(2.5, 1 + (m - 1) * sp.strength);
  }

  return {
    getSpatialConfig,
    defaultLines,
    dropEase,
    sampleSmoothPath,
    drawZVariedLimb,
    buildSmoothPath,
    drawCaps,
    maxLimbWidthFactor
  };
})();