// js/systems/distort.js
// SKFE 四角扭曲（8 点透视变形）系统 v1.0.0
// -----------------------------------------------------------------------------
// 设计要点：
// 1. 数学层零依赖：手写 DLT 求解单应性矩阵（9 个系数，h33 归一化为 1）。
// 2. 变形定义在「对象盒空间（box space）」里：以对象 OBB 中心为原点、宽高为 w/h 的
//    局部坐标系。未变形时盒空间 == 单位矩形，变形后 4 个角点任你摆放。
// 3. 渲染层区分两类：
//    - 矢量对象（figure / shape / bubble）：把顶点/关节点过一遍映射后重新描路径，
//      不做任何逐像素重采样，缩放永远清晰。
//    - 位图对象（image / acc）：16x16 网格纹理映射（Mesh Warping），
//      每个小格用仿射变换 + 裁剪做一次 drawImage，共 256 次，绝不逐像素 CPU 插值。
// 4. 导出复用同一条渲染管线（renderScene → renderQueue），因此导出结果天然带扭曲。
// -----------------------------------------------------------------------------
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.distort = (function () {
  'use strict';

  /* ==========================================================================
   * 0. 常量 / 外部钩子
   * ========================================================================== */
  const SUPPORTED = { figure: 1, image: 1, acc: 1, shape: 1, bubble: 1, ink: 1 };
  const WARP_GRID = 16;       // 位图切片网格（16 x 16 = 256 格）
  const WARP_GRID_FAST = 8;   // 拖拽过程中的降级网格（8 x 8 = 64 格）
  const EDGE_PAIRS = [[0, 1], [1, 2], [2, 3], [3, 0]]; // 上 右 下 左 对应的两条角点

  /* 由 app.js 注入，避免本模块反向依赖主程序内部作用域 */
  const hooks = {
    getObbCorners: null,   // (obj) => [TL, TR, BR, BL] 世界坐标
    worldToScreen: null,   // (worldPt) => {x, y}  画布 CSS 像素坐标
    screenToWorld: null,   // (sx, sy) => worldPt
    getSelected: null,     // () => obj | null
    getParentWarp: null,   // (obj) => 父火柴人的 mapping | null（挂载元件继承父级单应性）
    getCanvasRect: null,   // () => DOMRect
    requestRender: null,
    syncUI: null,
    markModified: null,
    saveHistory: null,
    syncGlobal: null,      // (obj) => void  全局属性开启时把扭曲同步到所有帧
    isBlocked: null        // 播放中 / 摄像机视角 / 导出中 → 禁止交互
  };

  let lowQuality = false;  // 拖拽过程中开启，降低网格密度换流畅度
  let distortionOn = false; // 仅用于按钮态缓存（真正的状态在 obj.distort.enabled 上）
  let rafPending = false;   // requestRender 的帧合并

  /** 拖拽时把多次 pointermove 合并到一帧，避免每个 move 都跑一次完整 render */
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    const raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(() => { rafPending = false; call('requestRender'); });
  }

  function setHooks(h) {
    if (!h) return;
    for (const k in h) if (Object.prototype.hasOwnProperty.call(h, k)) hooks[k] = h[k];
  }

  function call(name, a, b, c) {
    const fn = hooks[name];
    if (typeof fn !== 'function') return null;
    try { return fn(a, b, c); } catch (err) { console.warn('[distort] hook "' + name + '" 出错:', err); return null; }
  }

  /* ==========================================================================
   * 1. 数学层：单应性矩阵（Homography）
   * ========================================================================== */

  /* 高斯消元（列主元），解 A·x = b。A 为 n*n 扁平数组 */
  function solveLinear(A, b, n) {
    const M = A, v = b;
    for (let col = 0; col < n; col++) {
      let piv = col;
      let best = Math.abs(M[col * n + col]);
      for (let r = col + 1; r < n; r++) {
        const a = Math.abs(M[r * n + col]);
        if (a > best) { best = a; piv = r; }
      }
      if (best < 1e-12) return null;                 // 奇异矩阵：四点共线/重合
      if (piv !== col) {
        for (let c = col; c < n; c++) {
          const t = M[col * n + c]; M[col * n + c] = M[piv * n + c]; M[piv * n + c] = t;
        }
        const t2 = v[col]; v[col] = v[piv]; v[piv] = t2;
      }
      const d = M[col * n + col];
      for (let r = col + 1; r < n; r++) {
        const f = M[r * n + col] / d;
        if (f === 0) continue;
        for (let c = col; c < n; c++) M[r * n + c] -= f * M[col * n + c];
        v[r] -= f * v[col];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = v[r];
      for (let c = r + 1; c < n; c++) s -= M[r * n + c] * x[c];
      x[r] = s / M[r * n + r];
    }
    return x;
  }

  /**
   * DLT 求解单应性：输入原矩形 4 顶点 src 与目标 4 顶点 dst（必须同序），
   * 返回 { h11..h33 }（h33 固定为 1）。无法求解时返回 null。
   */
  function solveHomography(src, dst) {
    if (!src || !dst || src.length < 4 || dst.length < 4) return null;
    const A = new Float64Array(64);
    const b = new Float64Array(8);
    for (let i = 0; i < 4; i++) {
      const x = src[i].x, y = src[i].y, u = dst[i].x, v = dst[i].y;
      if (!isFinite(x) || !isFinite(y) || !isFinite(u) || !isFinite(v)) return null;
      const r0 = (i * 2) * 8, r1 = (i * 2 + 1) * 8;
      // u = (h11 x + h12 y + h13) / (h31 x + h32 y + 1)
      A[r0 + 0] = x; A[r0 + 1] = y; A[r0 + 2] = 1; A[r0 + 6] = -x * u; A[r0 + 7] = -y * u;
      b[i * 2] = u;
      // v = (h21 x + h22 y + h23) / (h31 x + h32 y + 1)
      A[r1 + 3] = x; A[r1 + 4] = y; A[r1 + 5] = 1; A[r1 + 6] = -x * v; A[r1 + 7] = -y * v;
      b[i * 2 + 1] = v;
    }
    const s = solveLinear(A, b, 8);
    if (!s) return null;
    for (let i = 0; i < 8; i++) if (!isFinite(s[i])) return null;
    return { h11: s[0], h12: s[1], h13: s[2], h21: s[3], h22: s[4], h23: s[5], h31: s[6], h32: s[7], h33: 1 };
  }

  /** 把任意点 (x, y) 通过单应性矩阵映射到变形后的位置 */
  function applyHomography(x, y, h) {
    if (!h) return { x, y };
    let den = h.h31 * x + h.h32 * y + h.h33;
    if (Math.abs(den) < 1e-9) den = den < 0 ? -1e-9 : 1e-9;  // 避免除零导致 Infinity
    return {
      x: (h.h11 * x + h.h12 * y + h.h13) / den,
      y: (h.h21 * x + h.h22 * y + h.h23) / den
    };
  }

  /** 3x3 逆矩阵（伴随矩阵 / 行列式） */
  function invertHomography(h) {
    if (!h) return null;
    const a = h.h11, b = h.h12, c = h.h13;
    const d = h.h21, e = h.h22, f = h.h23;
    const g = h.h31, i = h.h32, j = h.h33;
    const A =  (e * j - f * i);
    const B = -(b * j - c * i);
    const C =  (b * f - c * e);
    const D = -(d * j - f * g);
    const E =  (a * j - c * g);
    const F = -(a * f - c * d);
    const G =  (d * i - e * g);
    const H = -(a * i - b * g);
    const I =  (a * e - b * d);
    const det = a * A + b * D + c * G;
    if (Math.abs(det) < 1e-14) return null;
    const k = 1 / det;
    const m = { h11: A * k, h12: B * k, h13: C * k, h21: D * k, h22: E * k, h23: F * k, h31: G * k, h32: H * k, h33: I * k };
    if (Math.abs(m.h33) > 1e-14) {
      const n = 1 / m.h33;
      m.h11 *= n; m.h12 *= n; m.h13 *= n; m.h21 *= n; m.h22 *= n; m.h23 *= n; m.h31 *= n; m.h32 *= n; m.h33 = 1;
    }
    return m;
  }

  /**
   * 单应性在 (x, y) 处的局部缩放（面积缩放的平方根）。
   * 用于矢量对象变形后近似推算线宽 / 字号，避免「拉大后线条还是原来的粗细」。
   */
  function homographyLocalScale(h, x, y) {
    if (!h) return 1;
    const den = h.h31 * x + h.h32 * y + h.h33;
    if (Math.abs(den) < 1e-9) return 1;
    const nx = h.h11 * x + h.h12 * y + h.h13;
    const ny = h.h21 * x + h.h22 * y + h.h23;
    const j00 = (h.h11 - nx * h.h31 / den) / den;
    const j01 = (h.h12 - nx * h.h32 / den) / den;
    const j10 = (h.h21 - ny * h.h31 / den) / den;
    const j11 = (h.h22 - ny * h.h32 / den) / den;
    const det = Math.abs(j00 * j11 - j01 * j10);
    if (!isFinite(det) || det <= 0) return 1;
    return Math.sqrt(det);
  }

  /** 单应性在 (x, y) 处的雅可比（2x3 仿射近似），用于文字等「局部刚性」图元 */
  function homographyJacobian(h, x, y) {
    if (!h) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    let den = h.h31 * x + h.h32 * y + h.h33;
    if (Math.abs(den) < 1e-9) den = den < 0 ? -1e-9 : 1e-9;
    const nx = h.h11 * x + h.h12 * y + h.h13;
    const ny = h.h21 * x + h.h22 * y + h.h23;
    const o = applyHomography(x, y, h);
    return {
      a: (h.h11 - nx * h.h31 / den) / den,
      b: (h.h21 - ny * h.h31 / den) / den,
      c: (h.h12 - nx * h.h32 / den) / den,
      d: (h.h22 - ny * h.h32 / den) / den,
      e: o.x - ((h.h11 - nx * h.h31 / den) / den) * x - ((h.h12 - nx * h.h32 / den) / den) * y,
      f: o.y - ((h.h21 - ny * h.h31 / den) / den) * x - ((h.h22 - ny * h.h32 / den) / den) * y
    };
  }

  /* ==========================================================================
   * 2. 数据模型
   * ========================================================================== */

  function defaultCorners(w, h) {
    const hw = (w || 100) / 2, hh = (h || 100) / 2;
    return [
      { x: -hw, y: -hh }, // TL 左上
      { x:  hw, y: -hh }, // TR 右上
      { x:  hw, y:  hh }, // BR 右下
      { x: -hw, y:  hh }  // BL 左下
    ];
  }

  function supports(o) {
    return !!(o && SUPPORTED[o.type]);
  }

  function isActive(o) {
    return !!(o && o.distort && o.distort.enabled && o.distort.corners &&
              o.distort.corners.length === 4 && SUPPORTED[o.type]);
  }

  /** 取（并补齐）对象的 distort 数据，四个角点用当前 OBB 尺寸初始化 */
  function ensure(o) {
    if (!o) return null;
    if (!o.distort) o.distort = { enabled: false, corners: null, baseW: 0, baseH: 0 };
    const d = o.distort;
    if (!d.corners || d.corners.length !== 4) {
      const size = getBoxSize(o);
      d.corners = defaultCorners(size.w, size.h);
      d.baseW = size.w; d.baseH = size.h;
    }
    if (!(d.baseW > 0) || !(d.baseH > 0)) {
      const size = getBoxSize(o);
      d.baseW = size.w; d.baseH = size.h;
    }
    /* v5.6.1：首次启用时冻结「变形框架」快照。之后姿势怎么改都不重算，
       这样拖动关节时骨盆（以及整个变形结果）不会被现算的盒子带着漂。 */
    if (!d.frame0) call('captureFrame', o);
    return d;
  }

  function getBoxSize(o) {
    const obb = call('getObbCorners', o);
    if (!obb || obb.length < 4) return { w: 100, h: 100 };
    const w = Math.hypot(obb[1].x - obb[0].x, obb[1].y - obb[0].y);
    const h = Math.hypot(obb[3].x - obb[0].x, obb[3].y - obb[0].y);
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  /** 把变形重置为单位矩形（等于关闭变形效果） */
  function reset(o) {
    if (!o || !o.distort) return;
    const size = getBoxSize(o);
    o.distort.corners = defaultCorners(size.w, size.h);
    o.distort.baseW = size.w;
    o.distort.baseH = size.h;
    /* v5.6.1：重置 = 变形归零，冻结框架也应该重新对齐到当前盒子 */
    o.distort.frame0 = null;
    call('captureFrame', o);
  }

  function setEnabled(o, on) {
    if (!supports(o)) return false;
    ensure(o);
    o.distort.enabled = !!on;
    distortionOn = !!on;
    return true;
  }

  /* ==========================================================================
   * 3. 坐标框架：盒空间 <-> 世界空间
   * ========================================================================== */

  /** 用 OBB 的 4 个世界角点构造仿射框架 */
  function buildFrame(q) {
    const TL = q[0], TR = q[1], BL = q[3];
    let w = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    let h = Math.hypot(BL.x - TL.x, BL.y - TL.y);
    if (!(w > 1e-4)) w = 1;
    if (!(h > 1e-4)) h = 1;
    const ux = (TR.x - TL.x) / w, uy = (TR.y - TL.y) / w;
    const vx = (BL.x - TL.x) / h, vy = (BL.y - TL.y) / h;
    return {
      w, h, ux, uy, vx, vy,
      ox: TL.x + ux * (w / 2) + vx * (h / 2),
      oy: TL.y + uy * (w / 2) + vy * (h / 2)
    };
  }

  function boxToWorld(f, p) {
    return {
      x: f.ox + f.ux * p.x + f.vx * p.y,
      y: f.oy + f.uy * p.x + f.vy * p.y
    };
  }

  function worldToBox(f, p) {
    const dx = p.x - f.ox, dy = p.y - f.oy;
    const det = f.ux * f.vy - f.uy * f.vx;
    if (Math.abs(det) < 1e-12) return { x: 0, y: 0 };
    return {
      x: (dx * f.vy - dy * f.vx) / det,
      y: (f.ux * dy - f.uy * dx) / det
    };
  }

  /* ==========================================================================
   * 4. 映射对象（每次渲染即时求解，8x8 消元开销可忽略）
   * ========================================================================== */

  /* --- 3x3 矩阵（列向量约定，与 h11..h33 同序）--- */
  function mat3FromAffine(a) {
    /* x' = a*x + c*y + e ; y' = b*x + d*y + f */
    return [a.a, a.c, a.e,
            a.b, a.d, a.f,
            0,   0,   1];
  }
  function mat3FromH(h) {
    return [h.h11, h.h12, h.h13,
            h.h21, h.h22, h.h23,
            h.h31, h.h32, h.h33];
  }
  function mat3Mul(A, B) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
      }
    }
    return r;
  }
  function mat3Invert(m) {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    const A =  (e * i - f * h), B = -(b * i - c * h), C =  (b * f - c * e);
    const D = -(d * i - f * g), E =  (a * i - c * g), F = -(a * f - c * d);
    const G =  (d * h - e * g), H = -(a * h - b * g), I =  (a * e - b * d);
    const det = a * A + b * D + c * G;
    if (!isFinite(det) || Math.abs(det) < 1e-14) return null;
    const k = 1 / det;
    return [A * k, B * k, C * k, D * k, E * k, F * k, G * k, H * k, I * k];
  }
  function mat3ToH(m) {
    if (Math.abs(m[8]) < 1e-14) return null;
    const n = 1 / m[8];
    const h = { h11: m[0] * n, h12: m[1] * n, h13: m[2] * n,
                h21: m[3] * n, h22: m[4] * n, h23: m[5] * n,
                h31: m[6] * n, h32: m[7] * n, h33: 1 };
    for (const k in h) if (!isFinite(h[k])) return null;
    return h;
  }

  /** 某个 mapping 的「世界坐标 → 世界坐标」单应性（F · H · F⁻¹） */
  function worldHomography(mp) {
    if (!mp) return null;
    const F = mat3FromAffine(frameAffine(mp.frame));
    const Fi = mat3Invert(F);
    if (!Fi) return null;
    return mat3Mul(mat3Mul(F, mat3FromH(mp.H)), Fi);
  }

  /** 把父级的世界单应性换到子对象自己的盒空间里 */
  function parentInBox(parentMp, frame) {
    const pw = worldHomography(parentMp);
    if (!pw) return null;
    const F = mat3FromAffine(frameAffine(frame));
    const Fi = mat3Invert(F);
    if (!Fi) return null;
    return mat3ToH(mat3Mul(mat3Mul(Fi, pw), F));
  }

  /* 防重入：父子链理论上只有一层，这里仍然兜一层底 */
  let _mapDepth = 0;

  /**
   * 返回 { obj, frame, H, sx, sy, src, dst, dstOwn, parentBox, inherited }
   *  - H        : 盒空间 -> 盒空间 的单应性（自身扭曲 ∘ 父级扭曲，已合成）
   *  - dstOwn   : 忽略父级时 4 个角点落在哪里（编辑器拖拽用）
   *  - parentBox: 父级单应性在本对象盒空间里的表达（拖拽反算用）
   *  - sx/sy    : 当前尺寸相对「初始尺寸」的比例（用于角点自适应缩放）
   */
  function getMapping(o) {
    if (!o) return null;
    if (_mapDepth > 6) return null;
    _mapDepth++;
    try { return getMappingCore(o, call('getObbCorners', o)); }
    finally { _mapDepth--; }
  }

  /** 用指定的 4 个世界角点当盒子（命中测试要排除"并入了配饰"的显示范围时用） */
  function getMappingOnBox(o, corners) {
    if (!o || !corners || corners.length < 4) return null;
    if (_mapDepth > 6) return null;
    _mapDepth++;
    try { return getMappingCore(o, corners); }
    finally { _mapDepth--; }
  }

  function getMappingCore(o, obb) {
    const ownOn = isActive(o);
    /* 挂载在火柴人身上时，继承父级的单应性 —— 这就是「整个角色像一张图一起变形」 */
    const parent = call('getParentWarp', o);
    if (!ownOn && !parent) return null;

    if (!obb || obb.length < 4) return null;
    /* v5.6.1：火柴人走「冻结框架」—— 姿势变了也不重算盒子，骨盆因此钉住。
       其余对象（图片/形状/配饰…）盒子本来就稳定，直接现算即可。
       frz 为 null 时（旧存档没 frame0）自动退回老逻辑，不会炸。 */
    const frz = ownOn ? call('getFrozenFrame', o) : null;
    const liveFrame = frz ? buildFrame(obb) : null;
    const frame = frz || liveFrame || buildFrame(obb);
    const d = o.distort || {};

    let sx = 1, sy = 1;
    if (ownOn) {
      const bw = d.baseW > 0 ? d.baseW : frame.w;
      const bh = d.baseH > 0 ? d.baseH : frame.h;
      sx = frame.w / bw; sy = frame.h / bh;
    }

    const src = [
      { x: -frame.w / 2, y: -frame.h / 2 },
      { x:  frame.w / 2, y: -frame.h / 2 },
      { x:  frame.w / 2, y:  frame.h / 2 },
      { x: -frame.w / 2, y:  frame.h / 2 }
    ];

    const dstOwn = ownOn
      ? [
          { x: d.corners[0].x * sx, y: d.corners[0].y * sy },
          { x: d.corners[1].x * sx, y: d.corners[1].y * sy },
          { x: d.corners[2].x * sx, y: d.corners[2].y * sy },
          { x: d.corners[3].x * sx, y: d.corners[3].y * sy }
        ]
      : [{ x: src[0].x, y: src[0].y }, { x: src[1].x, y: src[1].y },
         { x: src[2].x, y: src[2].y }, { x: src[3].x, y: src[3].y }];

    let dst = dstOwn;
    let parentBox = null;
    if (parent) {
      parentBox = parentInBox(parent, frame);
      if (parentBox) {
        dst = dstOwn.map(p => applyHomography(p.x, p.y, parentBox));
      }
    }

    const H = solveHomography(src, dst);
    if (!H) return null;
    return {
      obj: o, frame, H, sx, sy, src, dst, dstOwn,
      /* v5.6.1：内容框（现算的、随姿势变的那个）。框架冻结后内容可能长出冻结框，
         渲染贴膜时要按它把源矩形撑开，否则会被裁掉。 */
      liveFrame,
      parentBox, inherited: !!parent
    };
  }

  /** 世界点（未变形态）→ 世界点（变形态） */
  function mapWorld(mp, p) {
    if (!mp || !p) return p;
    const b = worldToBox(mp.frame, p);
    const q = applyHomography(b.x, b.y, mp.H);
    return boxToWorld(mp.frame, q);
  }

  /** 盒空间点 → 变形后世界点 */
  function mapBox(mp, bx, by) {
    if (!mp) return { x: bx, y: by };
    const q = applyHomography(bx, by, mp.H);
    return boxToWorld(mp.frame, q);
  }

  /** 盒中心处的整体线宽缩放 */
  function centerScale(mp) {
    if (!mp) return 1;
    return homographyLocalScale(mp.H, 0, 0);
  }

  /** 盒空间（原点在对象中心）→ 世界 的局部仿射（含透视雅可比），用于文字 */
  function localAffine(mp) {
    if (!mp) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const f = mp.frame;
    const J = homographyJacobian(mp.H, 0, 0);
    return {
      a: f.ux * J.a + f.vx * J.b,
      b: f.uy * J.a + f.vy * J.b,
      c: f.ux * J.c + f.vx * J.d,
      d: f.uy * J.c + f.vy * J.d,
      e: f.ux * J.e + f.vx * J.f + f.ox,
      f: f.uy * J.e + f.vy * J.f + f.oy
    };
  }

  /* ==========================================================================
   * 4b. 世界空间局部仿射（挂载元件"完整贴膜"用）
   * ==========================================================================
   * 组件约定与 canvas 一致：x' = a*x + c*y + e , y' = b*x + d*y + f
   */

  function affineIdentity() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }

  /** 返回 P∘Q（先 Q 后 P） */
  function affineMul(P, Q) {
    return {
      a: P.a * Q.a + P.c * Q.b,
      b: P.b * Q.a + P.d * Q.b,
      c: P.a * Q.c + P.c * Q.d,
      d: P.b * Q.c + P.d * Q.d,
      e: P.a * Q.e + P.c * Q.f + P.e,
      f: P.b * Q.e + P.d * Q.f + P.f
    };
  }

  function affineInvert(m) {
    if (!m) return null;
    const det = m.a * m.d - m.b * m.c;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    const k = 1 / det;
    const a = m.d * k, b = -m.b * k, c = -m.c * k, d = m.a * k;
    return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
  }

  function affineApply(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  /** 盒空间 → 世界 的仿射（frame 的线性部分 + 原点平移） */
  function frameAffine(f) {
    return { a: f.ux, b: f.uy, c: f.vx, d: f.vy, e: f.ox, f: f.oy };
  }

  /**
   * 单应性在「世界点 p」处的局部仿射（雅可比 + 值），即
   *   warp(v) ≈ worldJacobian(mp, p) · v        （对 p 附近成立）
   * 直接把它左乘到任意既有矩阵上，就等于"把这套变换搬到变形后的位置、方向、尺度"。
   * 未变形时返回单位阵（严格 equal，不会引入浮点漂移）。
   */
  function worldJacobian(mp, p) {
    if (!mp || !p) return affineIdentity();
    const f = mp.frame;
    const b = worldToBox(f, p);
    const Jb = homographyJacobian(mp.H, b.x, b.y);
    const F = frameAffine(f);
    const B = affineInvert(F);
    if (!B) return affineIdentity();
    const M = affineMul(affineMul(F, Jb), B);
    if (!isFinite(M.a) || !isFinite(M.b) || !isFinite(M.c) ||
        !isFinite(M.d) || !isFinite(M.e) || !isFinite(M.f)) return affineIdentity();
    return M;
  }

  /**
   * 把 jointData 的所有关节点原地映射到变形后的位置，并把头部半径按局部缩放调整。
   * 返回整体线宽缩放系数（调用方用它去乘 curLW）。
   *
   * 注意：v5.4.0 起火柴人渲染改走「整体离屏渲染 + 网格贴膜」（见 app.js 的
   * queueFigureBitmapWarp），不再用它逐点重描；这里保留给需要关节级坐标的场合。
   */
  const JOINT_KEYS = ['pelvis', 'waistPoint', 'neck', 'headC', 'elbowL', 'handL', 'elbowR', 'handR',
                      'thighL', 'footL', 'thighR', 'footR', 'wristL', 'wristR', 'toeL', 'toeR'];

  function warpJoints(j, mp) {
    if (!mp || !j) return 1;
    const s = centerScale(mp);
    for (let i = 0; i < JOINT_KEYS.length; i++) {
      const k = JOINT_KEYS[i];
      const p = j[k];
      if (!p) continue;
      const b = worldToBox(mp.frame, p);
      const q = applyHomography(b.x, b.y, mp.H);
      const w = boxToWorld(mp.frame, q);
      p.x = w.x; p.y = w.y;
    }
    if (typeof j.headR === 'number') {
      /* 头半径要跟着「颈→头」那段实际被拉伸的比例走；用盒中心的比例，
         当头离开盒中心较远时圆头就会和脖子对不上（离得很开或者糊成一坨）。 */
      let hs = s;
      if (j.headC) {
        const b = worldToBox(mp.frame, j.headC);
        hs = homographyLocalScale(mp.H, b.x, b.y);
      }
      j.headR *= hs;
    }
    return s;
  }

  /* ==========================================================================
   * 5. 位图网格纹理映射（Mesh Warping）
   * ========================================================================== */

  function gridFor() {
    return lowQuality ? WARP_GRID_FAST : WARP_GRID;
  }

  function setLowQuality(on) { lowQuality = !!on; }

  /* 由三对「源点 → 目标点」求 2x3 仿射矩阵 */
  function affineFromTri(s0, s1, s2, d0, d1, d2) {
    const ux = s1.x - s0.x, uy = s1.y - s0.y;
    const vx = s2.x - s0.x, vy = s2.y - s0.y;
    const den = ux * vy - vx * uy;
    if (Math.abs(den) < 1e-9) return null;
    const dx1 = d1.x - d0.x, dy1 = d1.y - d0.y;
    const dx2 = d2.x - d0.x, dy2 = d2.y - d0.y;
    const a = (dx1 * vy - dx2 * uy) / den;
    const c = (ux * dx2 - vx * dx1) / den;
    const b = (dy1 * vy - dy2 * uy) / den;
    const d = (ux * dy2 - vx * dy1) / den;
    return { a, b, c, d, e: d0.x - a * s0.x - c * s0.y, f: d0.y - b * s0.x - d * s0.y };
  }

  /**
   * 网格切片渲染位图。
   * @param ctx    当前 2D 上下文（已处于世界坐标画布变换下）
   * @param source 图片源（HTMLImageElement / Canvas / ImageBitmap）
   * @param mp     getMapping() 的返回值
   * @param opts   { grid, srcW, srcH }
   */
  function drawWarpedBitmap(ctx, source, mp, opts) {
    if (!ctx || !source || !mp) return;
    opts = opts || {};
    const srcW = opts.srcW || source.naturalWidth || source.videoWidth || source.width || 0;
    const srcH = opts.srcH || source.naturalHeight || source.videoHeight || source.height || 0;
    if (!(srcW > 0 && srcH > 0)) return;

    const fr = mp.frame, H = mp.H;
    const N = Math.max(2, opts.grid || gridFor());
    const step = 1 / N;

    /* 屏幕空间下 1 像素对应的世界长度（用于补偿裁剪缝隙） */
    let pxScale = 1;
    try {
      const tr = ctx.getTransform();
      pxScale = Math.hypot(tr.a, tr.b) || 1;
    } catch (_) {}
    const eps = 2.2 / pxScale;

    /* 17 x 17 个交点：盒空间均匀取点 → 单应性 → 世界坐标 */
    const cols = N + 1;
    const gx = new Float64Array(cols * cols);
    const gy = new Float64Array(cols * cols);
    for (let j = 0; j < cols; j++) {
      const by = -fr.h / 2 + fr.h * j * step;
      for (let i = 0; i < cols; i++) {
        const bx = -fr.w / 2 + fr.w * i * step;
        const q = applyHomography(bx, by, H);
        const w = boxToWorld(fr, q);
        const k = j * cols + i;
        gx[k] = w.x; gy[k] = w.y;
      }
    }

    const cellW = srcW / N;
    const cellH = srcH / N;

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k00 = j * cols + i;
        const k10 = k00 + 1;
        const k01 = k00 + cols;
        const k11 = k01 + 1;

        const sx0 = i * cellW, sy0 = j * cellH;
        const s00 = { x: sx0, y: sy0 };
        const s10 = { x: sx0 + cellW, y: sy0 };
        const s11 = { x: sx0 + cellW, y: sy0 + cellH };
        const s01 = { x: sx0, y: sy0 + cellH };
        const d00 = { x: gx[k00], y: gy[k00] };
        const d10 = { x: gx[k10], y: gy[k10] };
        const d11 = { x: gx[k11], y: gy[k11] };
        const d01 = { x: gx[k01], y: gy[k01] };

        /* 每个小格拆成 2 个三角形：仿射在 3 个顶点上严格成立，
           所以相邻格的公共边完全对齐，不会出现错位撕裂。 */
        drawMeshTriangle(ctx, source, s00, s10, s11, d00, d10, d11, sx0, sy0, cellW, cellH, eps, srcW, srcH);
        drawMeshTriangle(ctx, source, s00, s11, s01, d00, d11, d01, sx0, sy0, cellW, cellH, eps, srcW, srcH);
      }
    }
  }

  /**
   * 单个三角形的纹理映射：裁剪到目标三角形 → 仿射 → 只搬这一小格。
   *
   * 关键细节：裁剪框向外扩了 eps，但「搬过来的内容」如果严格限制在本格内，
   * 扩出来的那一圈其实是空的 —— 相邻两格各留一条半透明缝，叠在深色笔画上
   * 就是一层浅色网格纹（带透明度的素材尤其明显）。
   * 所以这里把源矩形也向四周各放 1 个像素，让接缝处两边都是**真实像素**互相重叠，
   * 亮缝就彻底消失了（重叠的实心像素叠在一起还是实心）。
   */
  function drawMeshTriangle(ctx, source, s0, s1, s2, d0, d1, d2, sx, sy, sw, sh, eps, srcW, srcH) {
    const area = Math.abs((d1.x - d0.x) * (d2.y - d0.y) - (d2.x - d0.x) * (d1.y - d0.y));
    if (!isFinite(area) || area < 1e-7) return;  // 退化（角点重叠）直接跳过
    const M = affineFromTri(s0, s1, s2, d0, d1, d2);
    if (!M) return;

    /* 裁剪三角形沿重心做「等比」外扩（等比缩放才能让三条边同时向外平移），
       消除相邻三角形之间的亚像素缝隙；外扩量约 1 个屏幕像素。 */
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    let maxR = 0;
    [d0, d1, d2].forEach(p => {
      const r = Math.hypot(p.x - cx, p.y - cy);
      if (r > maxR) maxR = r;
    });
    const k = maxR > 1e-9 ? (maxR + eps) / maxR : 1;
    const a = { x: cx + (d0.x - cx) * k, y: cy + (d0.y - cy) * k };
    const b = { x: cx + (d1.x - cx) * k, y: cy + (d1.y - cy) * k };
    const c = { x: cx + (d2.x - cx) * k, y: cy + (d2.y - cy) * k };

    /* 源矩形向四周放 1px（真实像素重叠），并夹在图片范围内 */
    const gx0 = Math.max(0, sx - 1);
    const gy0 = Math.max(0, sy - 1);
    const gx1 = Math.min(srcW || (sx + sw), sx + sw + 1);
    const gy1 = Math.min(srcH || (sy + sh), sy + sh + 1);
    const gw = gx1 - gx0, gh = gy1 - gy0;
    if (!(gw > 0 && gh > 0)) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    ctx.clip();

    ctx.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    /* 只把这一小格（含 1px 外扩）从源图搬到目标位置，避免整图重复采样 */
    ctx.drawImage(source, gx0, gy0, gw, gh, gx0, gy0, gw, gh);
    ctx.restore();
  }

  /* ==========================================================================
   * 6. 矢量路径辅助
   * ========================================================================== */

  /** 圆/椭圆按角度采样成多边形（盒空间） */
  function ellipsePoints(rx, ry, seg) {
    seg = seg || 48;
    const out = [];
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      out.push({ x: Math.cos(t) * rx, y: Math.sin(t) * ry });
    }
    return out;
  }

  /**
   * 对话气泡轮廓采样（盒空间）。
   * 必须与 app.js 里 drawSmoothBubble 的圆角半径 / 尾巴位置完全一致，
   * 否则变形后会和未变形状态「长得不一样」。
   */
  function bubblePoints(w, h, segPerCorner) {
    const r = Math.min(20, w / 4, h / 4);
    const x = -w / 2, y = -h / 2;
    const tailWidth = 24, tailLength = 24;
    let tailCenterX = x + w * 0.25;
    const minCenterX = x + r + tailWidth / 2;
    const maxCenterX = x + w - r - tailWidth / 2;
    if (minCenterX > maxCenterX) tailCenterX = x + w / 2;
    else tailCenterX = Math.min(Math.max(tailCenterX, minCenterX), maxCenterX);
    const tailLeftX = tailCenterX - tailWidth / 2;
    const tailRightX = tailCenterX + tailWidth / 2;

    const seg = segPerCorner || 8;
    const pts = [];
    const arc = (cx, cy, a0, a1) => {
      for (let i = 0; i <= seg; i++) {
        const t = a0 + (a1 - a0) * (i / seg);
        pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
      }
    };

    pts.push({ x: x + r, y: y });
    pts.push({ x: x + w - r, y: y });
    arc(x + w - r, y + r, -Math.PI / 2, 0);            // 右上圆角
    pts.push({ x: x + w, y: y + h - r });
    arc(x + w - r, y + h - r, 0, Math.PI / 2);         // 右下圆角
    pts.push({ x: tailRightX, y: y + h });
    pts.push({ x: tailCenterX, y: y + h + tailLength }); // 尾巴尖
    pts.push({ x: tailLeftX, y: y + h });
    pts.push({ x: x + r, y: y + h });
    arc(x + r, y + h - r, Math.PI / 2, Math.PI);       // 左下圆角
    pts.push({ x: x, y: y + r });
    arc(x + r, y + r, Math.PI, Math.PI * 1.5);         // 左上圆角
    return pts;
  }

  /** 圆角矩形轮廓采样（盒空间），供形状/自定义气泡等场景复用 */
  function roundRectPoints(w, h, r, segPerCorner) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const seg = segPerCorner || 8;
    const x = -w / 2, y = -h / 2;
    const pts = [];
    const arc = (cx, cy, a0, a1) => {
      for (let i = 0; i <= seg; i++) {
        const t = a0 + (a1 - a0) * (i / seg);
        pts.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
      }
    };
    pts.push({ x: x + r, y: y });
    pts.push({ x: x + w - r, y: y });
    arc(x + w - r, y + r, -Math.PI / 2, 0);
    pts.push({ x: x + w, y: y + h - r });
    arc(x + w - r, y + h - r, 0, Math.PI / 2);
    pts.push({ x: x + r, y: y + h });
    arc(x + r, y + h - r, Math.PI / 2, Math.PI);
    pts.push({ x: x, y: y + r });
    arc(x + r, y + r, Math.PI, Math.PI * 1.5);
    return pts;
  }

  /** 把盒空间多边形映射成世界坐标路径（不 beginPath，方便调用方叠加） */
  function tracePath(ctx, mp, pts, close) {
    if (!pts.length) return;
    for (let i = 0; i < pts.length; i++) {
      const p = mapBox(mp, pts[i].x, pts[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (close !== false) ctx.closePath();
  }

  /* ==========================================================================
   * 7. 8 点控制点 UI
   * ========================================================================== */

  let uiRoot = null;
  const handleEls = [];      // 0..3 角点，4..7 边中点
  let dragState = null;

  function ensureDOM() {
    if (uiRoot && uiRoot.isConnected) return uiRoot;
    uiRoot = document.createElement('div');
    uiRoot.id = 'distortUI';

    const cornerTips = ['左上角点', '右上角点', '右下角点', '左下角点'];
    const edgeTips = ['上边中点（同步左右两角）', '右边中点（同步上下两角）',
                      '下边中点（同步左右两角）', '左边中点（同步上下两角）'];

    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div');
      el.className = 'dpt' + (i < 4 ? ' dpt-corner' : ' dpt-edge');
      el.dataset.k = String(i);
      el.title = (i < 4 ? cornerTips[i] : edgeTips[i - 4]) + '　（双击重置变形）';
      el.addEventListener('pointerdown', (e) => onHandleDown(e, i));
      el.addEventListener('pointermove', onHandleMove);
      el.addEventListener('pointerup', onHandleUp);
      el.addEventListener('pointercancel', onHandleUp);
      el.addEventListener('dblclick', onHandleDblClick);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      uiRoot.appendChild(el);
      handleEls.push(el);
    }
    document.body.appendChild(uiRoot);
    return uiRoot;
  }

  /* 当前应显示控制点的对象 */
  function activeTarget() {
    /* v5.5.2：只有处于「扭曲编辑模式」时才显示控制点/网格。
       按钮逻辑和变换框一致：点一下出现，再点一下消失；变形本身不受影响。 */
    if (!call('isDistortEditOn')) return null;
    const o = call('getSelected');
    if (!o || !isActive(o)) return null;
    if (hooks.isTransformBoxOn && call('isTransformBoxOn')) return null;
    if (hooks.isBlocked && call('isBlocked')) return null;
    return o;
  }

  /** 重新定位 8 个控制点（每次 render 调用） */
  function updateUI() {
    const o = activeTarget();   /* 内部已处理「编辑模式」与「变换框让位」 */
    if (!o) {
      if (uiRoot) uiRoot.style.display = 'none';
      return;
    }
    const mp = getMapping(o);
    if (!mp) {
      if (uiRoot) uiRoot.style.display = 'none';
      return;
    }
    ensureDOM();
    uiRoot.style.display = 'block';

    const rect = call('getCanvasRect') || { left: 0, top: 0 };
    const pts = handlePositions(mp);
    for (let i = 0; i < 8; i++) {
      const p = call('worldToScreen', pts[i]);
      const el = handleEls[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.left = (rect.left + p.x) + 'px';
      el.style.top = (rect.top + p.y) + 'px';
    }
  }

  /** 8 个控制点：4 角 + 4 边中点，均为世界坐标 */
  function handlePositions(mp) {
    const d = mp.dst;
    return [
      boxToWorld(mp.frame, d[0]),
      boxToWorld(mp.frame, d[1]),
      boxToWorld(mp.frame, d[2]),
      boxToWorld(mp.frame, d[3]),
      boxToWorld(mp.frame, { x: (d[0].x + d[1].x) / 2, y: (d[0].y + d[1].y) / 2 }),
      boxToWorld(mp.frame, { x: (d[1].x + d[2].x) / 2, y: (d[1].y + d[2].y) / 2 }),
      boxToWorld(mp.frame, { x: (d[2].x + d[3].x) / 2, y: (d[2].y + d[3].y) / 2 }),
      boxToWorld(mp.frame, { x: (d[3].x + d[0].x) / 2, y: (d[3].y + d[0].y) / 2 })
    ];
  }

  function clientToBox(clientX, clientY, mp) {
    const rect = call('getCanvasRect') || { left: 0, top: 0 };
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const world = call('screenToWorld', sx, sy);
    if (!world) return null;
    return worldToBox(mp.frame, world);
  }

  function onHandleDown(e, idx) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const o = call('getSelected');
    if (!o || !isActive(o)) return;
    const mp = getMapping(o);
    if (!mp) return;

    /* 关键：彻底阻断画布的选中 / 平移逻辑 */
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation && e.stopImmediatePropagation();

    const box = clientToBox(e.clientX, e.clientY, mp);
    if (!box) return;

    const d = o.distort;
    const c = d.corners;
    dragState = {
      obj: o,
      pointerId: e.pointerId,
      idx,
      mp,
      invert: invertHomography(mp.H),
      /* 继承父级扭曲时，角点写在「去掉父级之后」的空间里，拖拽才能精确跟手 */
      parentBox: mp.parentBox || null,
      parentBoxInv: mp.parentBox ? invertHomography(mp.parentBox) : null,
      sx: mp.sx,
      sy: mp.sy,
      startBox: box,
      start: [
        { x: c[0].x, y: c[0].y }, { x: c[1].x, y: c[1].y },
        { x: c[2].x, y: c[2].y }, { x: c[3].x, y: c[3].y }
      ],
      moved: false
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    handleEls[idx].classList.add('dragging');
    document.body.classList.add('distort-dragging');
    setLowQuality(true);
    scheduleRender();   /* v5.5.0：立刻重绘，让 3x3 网格在按下的瞬间出现 */
  }

  function onHandleMove(e) {
    const st = dragState;
    if (!st || e.pointerId !== st.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    const o = st.obj;
    if (!o || !isActive(o) || call('getSelected') !== o) { endDrag(true); return; }

    const box = clientToBox(e.clientX, e.clientY, st.mp);
    if (!box) return;

    const dx = box.x - st.startBox.x;
    const dy = box.y - st.startBox.y;
    if (!st.moved && Math.hypot(dx * st.sx, dy * st.sy) > 0.4) st.moved = true;

    /* 盒空间位移换算回「初始尺寸」单位，避免对象被缩放后角点漂移 */
    const bx = dx / (st.sx || 1);
    const by = dy / (st.sy || 1);

    const c = o.distort.corners;
    /* 写一个角点：有父级继承时，先把「起始角点」搬到显示空间，加位移后再反解回去 */
    const write = (ci,ddx,ddy) => {
      if (st.parentBox && st.parentBoxInv) {
        const a = applyHomography(st.start[ci].x * st.sx, st.start[ci].y * st.sy, st.parentBox);
        const b = applyHomography(a.x + ddx, a.y + ddy, st.parentBoxInv);
        c[ci].x = b.x / (st.sx || 1);
        c[ci].y = b.y / (st.sy || 1);
      } else {
        c[ci].x = st.start[ci].x + bx;
        c[ci].y = st.start[ci].y + by;
      }
    };

    if (st.idx < 4) {
      /* 4 个角点：直接改该角坐标 */
      write(st.idx, dx, dy);
    } else {
      /* 4 个边中点：位移同步给该边相邻的两个角点 */
      const pair = EDGE_PAIRS[st.idx - 4];
      for (let k = 0; k < 2; k++) write(pair[k], dx, dy);
    }
    scheduleRender();
  }

  function onHandleUp(e) {
    if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
    endDrag(false);
  }

  function endDrag(cancelled) {
    const st = dragState;
    if (!st) return;
    dragState = null;
    setLowQuality(false);
    document.body.classList.remove('distort-dragging');
    handleEls.forEach(el => el.classList.remove('dragging'));
    try { if (st.pointerId != null) handleEls[st.idx].releasePointerCapture(st.pointerId); } catch (_) {}

    if (cancelled || !st.moved) { call('requestRender'); return; }

    /* 全局属性开启时：四角坐标一次性同步到该元件的所有帧（松手时提交，不打断拖拽） */
    call('syncGlobal', st.obj);

    /* 持久化：4 角坐标已在 obj.distort.corners 上，这里补历史与缩略图 */
    call('markModified');
    call('saveHistory', '扭曲变形');
    call('syncUI');
    call('requestRender');
  }

  /** 双击任一控制点：把 4 角复位成原矩形 */
  function onHandleDblClick(e) {
    e.preventDefault(); e.stopPropagation();
    const o = call('getSelected');
    if (!o || !isActive(o)) return;
    reset(o);
    call('syncGlobal', o);
    call('markModified');
    call('saveHistory', '重置扭曲');
    call('requestRender');
  }

  function isDragging() { return !!dragState; }

  function cancelDrag() {
    if (!dragState) return;
    /* 回滚到拖拽开始时的角点 */
    const st = dragState;
    const c = st.obj.distort.corners;
    for (let i = 0; i < 4; i++) { c[i].x = st.start[i].x; c[i].y = st.start[i].y; }
    endDrag(true);
  }

  /* ==========================================================================
   * 8. 画布叠加层（外轮廓常驻 + 3x3 变形网格仅在拖拽时显示）
   * ========================================================================== */

  function drawOverlay(ctx) {
    const o = activeTarget();
    if (!o || !ctx) return;
    const mp = getMapping(o);
    if (!mp) return;

    const dpr = window.devicePixelRatio || 1;
    const toS = (p) => call('worldToScreen', p);
    const hs = handlePositions(mp);

    /* v5.5.0：网格只在「真的在拖控制点」时画。
       常驻网格会盖住画面，让人判断不了预览和导出的真实效果。
       拖动是唯一需要看清网格的时刻，其余时间只保留外轮廓。 */
    const showMesh = !!dragState;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (showMesh) {
      /* 3x3 网格线：直观显示透视变化 */
      ctx.strokeStyle = 'rgba(74,144,255,.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const STEP = 3;
      for (let i = 1; i < STEP; i++) {
        const t = i / STEP;
        const bx = -mp.frame.w / 2 + mp.frame.w * t;
        const by = -mp.frame.h / 2 + mp.frame.h * t;
        let p = toS(mapBox(mp, bx, -mp.frame.h / 2)); if (p) ctx.moveTo(p.x, p.y);
        p = toS(mapBox(mp, bx, mp.frame.h / 2)); if (p) ctx.lineTo(p.x, p.y);
        p = toS(mapBox(mp, -mp.frame.w / 2, by)); if (p) ctx.moveTo(p.x, p.y);
        p = toS(mapBox(mp, mp.frame.w / 2, by)); if (p) ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    /* 外轮廓：常驻，告诉你「这一块被变形了」，但不会挡画面 */
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const p = toS(hs[i]);
      if (!p) continue;
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(74,144,255,.92)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (showMesh) {
      /* 四个角点连到对应边中点，提示拓扑关系（拖拽时才有意义） */
      ctx.strokeStyle = 'rgba(74,144,255,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = toS(hs[i]), b = toS(hs[4 + i]);
        if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ==========================================================================
   * 9. 对外接口
   * ========================================================================== */
  return {
    /* 数学 */
    solveHomography,
    applyHomography,
    invertHomography,
    homographyLocalScale,
    homographyJacobian,
    /* 数据 */
    defaultCorners,
    supports,
    isActive,
    ensure,
    reset,
    setEnabled,
    /* 框架 / 映射 */
    buildFrame,
    boxToWorld,
    worldToBox,
    getMapping,
    getMappingOnBox,
    mapWorld,
    mapBox,
    centerScale,
    localAffine,
    /* 世界空间局部仿射（挂载贴膜） */
    affineIdentity,
    affineMul,
    affineInvert,
    affineApply,
    worldJacobian,
    warpJoints,
    /* 渲染 */
    drawWarpedBitmap,
    gridFor,
    setLowQuality,
    ellipsePoints,
    roundRectPoints,
    bubblePoints,
    tracePath,
    drawOverlay,
    /* UI */
    setHooks,
    updateUI,
    isDragging,
    cancelDrag,
    /* 状态 */
    isOn: () => distortionOn
  };
})();
