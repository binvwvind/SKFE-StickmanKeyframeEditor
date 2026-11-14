/* ============================================================================
   SKFE 关键帧数据层 v7.0.0（一期：关键帧 / 派生帧 / 段）
   ----------------------------------------------------------------------------
   设计要点（与《关键帧需求说明》对应）：

   1. 槽位只有四种身份，全部可以「从槽位本身」判定，不额外维护并行数组：
        key     : 对象数据 + `__k` 标记        → 关键帧，携带完整快照
        plain   : 对象数据，无标记            → 普通帧，保留原有烘焙数据
        derived : 单例哨兵 `{ __d: 1 }`        → 派生帧，不存画面，渲染时求值
        blank   : null                        → 空白帧，该元件本帧不存在

      为什么派生帧不用 null：null 是老代码里「该元件本帧未出场」的唯一表示，
      全项目 58 处直接读 `t.frames[i]` 都依赖它。用哨兵可以让 null 的语义保持
      不变，同时派生帧又能随 splice / 深拷贝 / 拖拽排序自动跟着槽位走，
      不需要在十几个 splice 点手动重映射下标（那是丢数据的高发区）。

   2. 关键帧标记与段曲线都挂在**对象数据自身**的 `__k` 上：
        __k = { o: 'main' | 'sub', c: 曲线配置 }
      于是「复制关键帧生成新关键帧」「拖拽重排」「撤销快照」「存盘」全部天然
      正确，不需要额外的锚点表。

   3. 段 = 相邻两个关键帧，中间**一律插值填满**（含原本没有内容的空白帧）。
      也就是「关键帧只对当前段生效」：只要两端都有关键帧，中间的槽位全部被接管
      成派生帧；既然没有成对的关键帧，就不构成段，什么也不会发生。
      —— 特例：段的首尾之外的空白帧仍是空白（段外不插值）。
      想让元件在某帧之后消失，就在消失处再打一个关键帧（显隐按 D6 是 hold），
      让 4→5 成为一段退化段。
   ========================================================================== */
(function () {
  'use strict';

  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.SKFE = root.SKFE || {};
  root.SKFE.systems = root.SKFE.systems || {};

  const KEY = '__k';
  const DERIVED = '__d';

  /* 派生帧哨兵。冻结，避免被任何代码就地改坏。 */
  const DERIVED_SLOT = Object.freeze({ [DERIVED]: 1 });

  /* ---------------- 槽位身份 ---------------- */
  function isDerived(d) { return !!d && typeof d === 'object' && d[DERIVED] === 1; }
  function isReal(d) { return !!d && typeof d === 'object' && d[DERIVED] !== 1; }
  function isKey(d) { return isReal(d) && !!d[KEY]; }
  function isPlain(d) { return isReal(d) && !d[KEY]; }
  function isBlank(d) { return d == null; }

  function kindOf(d) {
    if (d == null) return 'blank';
    if (isDerived(d)) return 'derived';
    return d[KEY] ? 'key' : 'plain';
  }

  /* ---------------- 关键帧标记 ---------------- */
  function markKey(d, origin, curve) {
    if (!isReal(d)) return null;
    d[KEY] = { o: origin === 'main' ? 'main' : 'sub' };
    if (curve) d[KEY].c = curve;
    return d;
  }
  function clearKey(d) {
    if (isReal(d) && d[KEY]) delete d[KEY];
    return d;
  }
  function originOf(d) { return (isReal(d) && d[KEY] && d[KEY].o) || null; }
  function curveOf(d) { return (isReal(d) && d[KEY] && d[KEY].c) || null; }
  function setCurve(d, curve) { if (isReal(d) && d[KEY]) d[KEY].c = curve || null; }

  /* 新建元件 / 套预设时用：复制一份并剥掉帧身份，避免把关键帧标记带给新对象 */
  function stripFrameMarks(obj) {
    if (!isReal(obj)) return obj;
    const c = JSON.parse(JSON.stringify(obj, (k, v) => (k === 'img' ? undefined : v)));
    if (obj.img) c.img = obj.img;
    delete c[KEY];
    delete c[DERIVED];
    return c;
  }

  /* ---------------- 关键帧查找 ---------------- */
  function keyIndices(frames) {
    const out = [];
    for (let i = 0; i < frames.length; i++) if (isKey(frames[i])) out.push(i);
    return out;
  }
  function prevKeyIndex(frames, idx) {
    for (let i = idx - 1; i >= 0; i--) if (isKey(frames[i])) return i;
    return -1;
  }
  function nextKeyIndex(frames, idx) {
    for (let i = idx + 1; i < frames.length; i++) if (isKey(frames[i])) return i;
    return -1;
  }

  /* ---------------- 段 ---------------- */
  /* 全部成立的段：任意相邻两个关键帧就是一段，中间是普通帧还是空白帧都不影响
     —— 段内的槽位一律被插值填满。判定只依赖关键帧是否成对。 */
  function segments(frames) {
    const keys = keyIndices(frames);
    const out = [];
    for (let n = 0; n < keys.length - 1; n++) out.push({ a: keys[n], b: keys[n + 1] });
    return out;
  }

  function segmentContaining(frames, idx) {
    const list = segments(frames);
    for (let n = 0; n < list.length; n++) {
      if (idx > list[n].a && idx < list[n].b) return list[n];
    }
    return null;
  }

  /* 槽位定位：渲染求值的唯一入口。
     返回 { kind, a, b, u }：
       kind='key'   → a=b=idx, u=0，直接用自身数据
       kind='plain' → 用自身烘焙数据（段外）
       kind='blank' → 不渲染（段外的空白）
       kind='derived' → a/b 为段端点，u∈(0,1) 为归一化进度。
                     段内的槽位**一律**归为派生，不管它原本存的是普通帧数据
                     还是空白（待 reconcile 归一化，渲染时直接按派生处理）。
       kind='orphan'  → 派生帧不在任何段内（数据异常），按空白处理 */
  function locate(frames, idx) {
    const d = frames[idx];
    const kind = kindOf(d);
    if (kind === 'key') return { kind: 'key', a: idx, b: idx, u: 0 };
    const seg = segmentContaining(frames, idx);
    if (seg) return { kind: 'derived', a: seg.a, b: seg.b, u: (idx - seg.a) / (seg.b - seg.a) };
    if (kind === 'plain') return { kind: 'plain' };
    if (kind === 'derived') return { kind: 'orphan' };
    return { kind: 'blank' };
  }

  /* 选区 → 段：选区落在段内任意位置即定位整段（D4）。
     返回命中的段（去重后），供 UI 高亮与改曲线使用。 */
  function segmentsForRange(frames, from, to) {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const list = segments(frames);
    const hit = [];
    for (let n = 0; n < list.length; n++) {
      const s = list[n];
      /* 选区与段有交集即算命中；端点也算（点关键帧本身就等于选它后面的段） */
      if (hi >= s.a && lo <= s.b) hit.push(s);
    }
    return hit;
  }

  /* 选区扩张：把选区补成完整段范围，用于 UI「整段高亮」 */
  function expandRangeToSegments(frames, from, to) {
    const hit = segmentsForRange(frames, from, to);
    if (!hit.length) return { from: Math.min(from, to), to: Math.max(from, to), segments: [] };
    let a = hit[0].a, b = hit[0].b;
    for (const s of hit) { a = Math.min(a, s.a); b = Math.max(b, s.b); }
    return { from: a, to: b, segments: hit };
  }

  /* ---------------- 归一化 ---------------- */
  /* 保证 track 的槽位身份自洽：
     ① 段内（两关键帧之间）的普通帧 / 空白帧 → 一律降为派生帧（被关键帧接管，
        旧数据记入 adopted 供 toast 提示，一次撤销可恢复）
     ② 段外的派生帧 → 退回空白帧（悬空派生）
     幂等，加载工程 / 插删帧 / 拖拽后都可以安全重跑。
     opts.adoptPlain=false 时只做 ②，不接管 ①（用于旧工程原样加载）。 */
  function reconcileTrack(t, opts) {
    const fr = t && t.frames;
    const res = { adopted: [], dropped: [] };
    if (!fr || !fr.length) return res;
    const adopt = !(opts && opts.adoptPlain === false);
    const list = segments(fr);
    const inside = new Array(fr.length).fill(false);
    for (const s of list) for (let i = s.a + 1; i < s.b; i++) inside[i] = true;

    for (let i = 0; i < fr.length; i++) {
      const k = kindOf(fr[i]);
      if (inside[i]) {
        if (k === 'plain' || k === 'blank') {
          if (adopt) { fr[i] = DERIVED_SLOT; res.adopted.push(i); }
        }
      } else if (k === 'derived') {
        fr[i] = null;
        res.dropped.push(i);
      }
    }
    return res;
  }

  /* ---------------- 统计（UI / 测试用） ---------------- */
  function countKinds(frames) {
    const c = { key: 0, plain: 0, derived: 0, blank: 0 };
    for (let i = 0; i < frames.length; i++) c[kindOf(frames[i])]++;
    return c;
  }

  /* 段内派生帧数量（= 间距 - 1，对应 R3「补帧数不可自定义」） */
  function derivedCount(frames, s) {
    let n = 0;
    for (let i = s.a + 1; i < s.b; i++) if (kindOf(frames[i]) === 'derived') n++;
    return n;
  }

  /* ---------------- 单对象插值 ---------------- */
  /* 按一个轨道的两个关键帧求值出中间某一帧的对象。
     与旧的 buildTweenFrames 相比有三处修正（对应 D6）：
       · 离散属性（ikEnabled / 深度开关 / 头型 / 镜像 / 显隐 / 绑定）一律 hold：
         段内全程取起点，到末端关键帧才切换，不再 tt<0.5 中途跳变；
       · 缩放走对数插值（两端都 > 0 时），避免线性插值在 1→4 时前快后慢；
       · 旋转保持线性（不归一化最短弧），>360° 的多圈照旧生效。
     求值结果不带 __k，因此永远不会被当成关键帧写回。 */
  const IDENT = (u) => u;

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  /* v7.2.1：角度制（0-360）的最短弧插值 —— 侧面高光的「高光方向」滑条是角度，不是弧度。
     不加这个的话，350° → 10° 会绕一整圈（走反方向）。 */
  function lerpAngleDeg(a, b, t) {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return a + d * t;
  }
  function lerpScale(a, b, t) {
    a = (a == null) ? 1 : a;
    b = (b == null) ? 1 : b;
    if (a > 0 && b > 0) return Math.exp(lerp(Math.log(a), Math.log(b), t));
    return lerp(a, b, t);
  }
  function hexToRgbLocal(hex) {
    const h = String(hex || '#000000').replace('#', '');
    const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(s, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function srgbLerp(c1, c2, t) {
    if (!c1 || !c2) return c1 || c2;
    const a = hexToRgbLocal(c1), b = hexToRgbLocal(c2);
    const m = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function cloneForEval(src) {
    const c = JSON.parse(JSON.stringify(src, (k, v) => (k === 'img' ? undefined : v)));
    if (src && src.img) c.img = src.img;
    delete c[KEY];
    delete c[DERIVED];
    return c;
  }

  function interpolateObject(o1, o2, u, ctx) {
    if (!isReal(o1) || !isReal(o2)) return null;
    ctx = ctx || {};
    const ease = ctx.ease || IDENT;
    const tt = ease(u);
    /* 分部进度：把 TT（已过整段曲线的值）与原始 u 都给出去。
       通道自己的曲线作用在原始 u 上（与旧「分部缓动」一致：它替换而不是叠加）。 */
    const prog = (part) => (ctx.partEase ? ctx.partEase(part, tt, u) : tt);
    const col = (c1, c2, k) => (ctx.colorLerp ? ctx.colorLerp(c1, c2, k) : srgbLerp(c1, c2, k));
    const obj = cloneForEval(o1);
    if (obj.ax === undefined) obj.ax = 0;
    if (obj.ay === undefined) obj.ay = 0;

    if (obj.type === 'figure') {
      obj.x = lerp(o1.x, o2.x, prog('x'));
      obj.y = lerp(o1.y, o2.y, prog('y'));
      obj.scale = lerpScale(o1.scale, o2.scale, prog('scale'));
      obj.alpha = lerp(o1.alpha == null ? 1 : o1.alpha, o2.alpha == null ? 1 : o2.alpha, tt);
      obj.rot = lerp(o1.rot || 0, o2.rot || 0, prog('rot'));
      if (o1.bodyScale && o2.bodyScale) {
        obj.bodyScale = {};
        Object.keys(o1.bodyScale).forEach(k => {
          obj.bodyScale[k] = lerp(o1.bodyScale[k], o2.bodyScale[k] !== undefined ? o2.bodyScale[k] : o1.bodyScale[k], tt);
        });
      }
      if (o1.color && o2.color) obj.color = col(o1.color, o2.color, tt);
      if (o1.light && o1.light.color && o2.light && o2.light.color) obj.light.color = col(o1.light.color, o2.light.color, tt);
      if (o1.glow && o1.glow.color && o2.glow && o2.glow.color) obj.glow.color = col(o1.glow.color, o2.glow.color, tt);
      /* v7.2.0：描边阴影的偏移 / 羽化 / 扩展 / 不透明度也走插值，不然段内阴影是硬跳的 */
      if (o1.glow && o2.glow) {
        const g = obj.glow = obj.glow || {};
        g.blur = lerp(o1.glow.blur || 0, o2.glow.blur || 0, tt);
        g.spread = lerp(o1.glow.spread || 0, o2.glow.spread || 0, tt);
        g.offsetX = lerp(o1.glow.offsetX || 0, o2.glow.offsetX || 0, tt);
        g.offsetY = lerp(o1.glow.offsetY || 0, o2.glow.offsetY || 0, tt);
        g.alpha = lerp(o1.glow.alpha == null ? 1 : o1.glow.alpha, o2.glow.alpha == null ? 1 : o2.glow.alpha, tt);
        /* 开关是离散量：段内取起点（与 D6 一致） */
        g.enabled = !!o1.glow.enabled;
        g.includeAcc = !!o1.glow.includeAcc;   /* v7.2.1：连同绑定配饰也是离散量 */
        g.color = obj.glow.color || o1.glow.color || '#000000';
      }
      /* v7.2.1：侧面高光的粗细 / 方向也走插值（原来只有颜色会变，粗细和方向是硬跳的） */
      if (o1.light && o2.light) {
        const l = obj.light = obj.light || {};
        l.enabled = !!o1.light.enabled;   /* 离散：段内 hold 起点 */
        l.size = lerp(o1.light.size == null ? 1 : o1.light.size, o2.light.size == null ? 1 : o2.light.size, tt);
        l.angle = lerpAngleDeg(o1.light.angle == null ? 0 : o1.light.angle, o2.light.angle == null ? 0 : o2.light.angle, tt);
      }
      /* v7.2.1：手部渐变的起始位置也插值 */
      if (o1.joint && o2.joint) {
        const jj = obj.joint = obj.joint || {};
        jj.enabled = !!o1.joint.enabled;  /* 离散：段内 hold 起点 */
        jj.len = lerp(o1.joint.len == null ? 0.5 : o1.joint.len, o2.joint.len == null ? 0.5 : o2.joint.len, tt);
      }
      /* v7.2.1：地面阴影（v7.2.1 起是每个火柴人独立的属性，所以能参与插值） */
      if (o1.shadowEnabled !== undefined || o2.shadowEnabled !== undefined) {
        obj.shadowEnabled = !!o1.shadowEnabled;   /* 离散：段内 hold 起点 */
        obj.shadowColor = col(o1.shadowColor || '#000000', o2.shadowColor || o1.shadowColor || '#000000', tt);
        obj.shadowAlpha = lerp(o1.shadowAlpha == null ? 0.3 : o1.shadowAlpha, o2.shadowAlpha == null ? 0.3 : o2.shadowAlpha, tt);
        obj.shadowScaleX = lerp(o1.shadowScaleX == null ? 1 : o1.shadowScaleX, o2.shadowScaleX == null ? 1 : o2.shadowScaleX, tt);
        obj.shadowScaleY = lerp(o1.shadowScaleY == null ? 1 : o1.shadowScaleY, o2.shadowScaleY == null ? 1 : o2.shadowScaleY, tt);
        obj.shadowOffX = lerp(o1.shadowOffX || 0, o2.shadowOffX || 0, tt);
        obj.shadowOffY = lerp(o1.shadowOffY || 0, o2.shadowOffY || 0, tt);
      }
      if (o1.joint && o1.joint.color && o2.joint && o2.joint.color) obj.joint.color = col(o1.joint.color, o2.joint.color, tt);
      if (o1.depth && o2.depth) {
        if (!obj.depth) obj.depth = {};
        /* D6：离散属性 hold —— 取起点，到末端关键帧才切换 */
        obj.depth.enabled = !!o1.depth.enabled;
        obj.depth.useCustom = !!o1.depth.useCustom;
        if (o1.depth.customColor && o2.depth.customColor) obj.depth.customColor = col(o1.depth.customColor, o2.depth.customColor, tt);
      }
      obj.headAngle = lerpAngle(o1.headAngle, o2.headAngle, prog('headAngle'));
      obj.a.torso = lerpAngle(o1.a.torso, o2.a.torso, prog('torso'));
      obj.a.waist = lerpAngle(o1.a.waist || 0, o2.a.waist || 0, prog('waist'));
      obj.a.armL.u = lerpAngle(o1.a.armL.u, o2.a.armL.u, prog('armL_u'));
      obj.a.armL.f = lerpAngle(o1.a.armL.f, o2.a.armL.f, prog('armL_f'));
      obj.a.armR.u = lerpAngle(o1.a.armR.u, o2.a.armR.u, prog('armR_u'));
      obj.a.armR.f = lerpAngle(o1.a.armR.f, o2.a.armR.f, prog('armR_f'));
      obj.a.legL.u = lerpAngle(o1.a.legL.u, o2.a.legL.u, prog('legL_u'));
      obj.a.legL.f = lerpAngle(o1.a.legL.f, o2.a.legL.f, prog('legL_f'));
      obj.a.legR.u = lerpAngle(o1.a.legR.u, o2.a.legR.u, prog('legR_u'));
      obj.a.legR.f = lerpAngle(o1.a.legR.f, o2.a.legR.f, prog('legR_f'));
      if (o1.extremity && o1.extremity.enabled && o2.extremity && o2.extremity.enabled) {
        obj.extremity.armAngleL = lerpAngle(o1.extremity.armAngleL, o2.extremity.armAngleL, prog('ext_armL'));
        obj.extremity.armAngleR = lerpAngle(o1.extremity.armAngleR, o2.extremity.armAngleR, prog('ext_armR'));
        obj.extremity.legAngleL = lerpAngle(o1.extremity.legAngleL, o2.extremity.legAngleL, prog('ext_legL'));
        obj.extremity.legAngleR = lerpAngle(o1.extremity.legAngleR, o2.extremity.legAngleR, prog('ext_legR'));
        obj.extremity.armRatio = lerp(o1.extremity.armRatio != null ? o1.extremity.armRatio : 0.23, o2.extremity.armRatio != null ? o2.extremity.armRatio : 0.23, tt);
        obj.extremity.legRatio = lerp(o1.extremity.legRatio != null ? o1.extremity.legRatio : 0.23, o2.extremity.legRatio != null ? o2.extremity.legRatio : 0.23, tt);
      }
      if (obj.ikEnabled && o1.pinned && o2.pinned) {
        obj.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
        obj.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
        ['footL', 'footR', 'handL', 'handR', 'pelvis'].forEach(p => {
          if (o1.pinned[p] && o2.pinned[p] && o1.pinnedPos[p] && o2.pinnedPos[p]) {
            obj.pinned[p] = true;
            obj.pinnedPos[p] = {
              x: lerp(o1.pinnedPos[p].x, o2.pinnedPos[p].x, tt),
              y: lerp(o1.pinnedPos[p].y, o2.pinnedPos[p].y, tt)
            };
          }
        });
      } else {
        obj.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
        obj.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
      }
      if (ctx.enforcePins) ctx.enforcePins(obj);
      return obj;
    }

    if (obj.type === 'image') {
      obj.x = lerp(o1.x, o2.x, prog('x'));
      obj.y = lerp(o1.y, o2.y, prog('y'));
      obj.scale = lerpScale(o1.scale, o2.scale, prog('scale'));
      obj.alpha = lerp(o1.alpha == null ? 1 : o1.alpha, o2.alpha == null ? 1 : o2.alpha, tt);
      obj.rot = lerp(o1.rot || 0, o2.rot || 0, prog('rot'));
      obj.ax = lerp(o1.ax || 0, o2.ax || 0, tt);
      obj.ay = lerp(o1.ay || 0, o2.ay || 0, tt);
      if (o1.w !== undefined && o2.w !== undefined) obj.w = lerp(o1.w, o2.w, prog('width'));
      if (o1.h !== undefined && o2.h !== undefined) obj.h = lerp(o1.h, o2.h, prog('height'));
      return obj;
    }

    if (obj.type === 'shape' || obj.type === 'bubble') {
      obj.x = lerp(o1.x, o2.x, prog('x'));
      obj.y = lerp(o1.y, o2.y, prog('y'));
      obj.scale = lerpScale(o1.scale, o2.scale, prog('scale'));
      obj.alpha = lerp(o1.alpha == null ? 1 : o1.alpha, o2.alpha == null ? 1 : o2.alpha, tt);
      obj.rot = lerp(o1.rot || 0, o2.rot || 0, prog('rot'));
      obj.offX = lerp(o1.offX || 0, o2.offX || 0, tt);
      obj.offY = lerp(o1.offY || 0, o2.offY || 0, tt);
      obj.ax = lerp(o1.ax || 0, o2.ax || 0, tt);
      obj.ay = lerp(o1.ay || 0, o2.ay || 0, tt);
      obj.w = lerp(o1.w || 60, o2.w || 60, prog('width'));
      obj.h = lerp(o1.h || 60, o2.h || 60, prog('height'));
      if (obj.type === 'shape') {
        if (o1.fillColor && o2.fillColor) obj.fillColor = col(o1.fillColor, o2.fillColor, tt);
        if (o1.strokeColor && o2.strokeColor) obj.strokeColor = col(o1.strokeColor, o2.strokeColor, tt);
      } else {
        if (o1.customW !== undefined && o2.customW !== undefined) obj.customW = lerp(o1.customW, o2.customW, prog('width'));
        if (o1.customH !== undefined && o2.customH !== undefined) obj.customH = lerp(o1.customH, o2.customH, prog('height'));
        if (o1.fontSize !== undefined && o2.fontSize !== undefined) obj.fontSize = lerp(o1.fontSize, o2.fontSize, tt);
        if (o1.textColor && o2.textColor) obj.textColor = col(o1.textColor, o2.textColor, tt);
        if (o1.gradientColor && o2.gradientColor) obj.gradientColor = col(o1.gradientColor, o2.gradientColor, tt);
        if (o1.fillColor && o2.fillColor) obj.fillColor = col(o1.fillColor, o2.fillColor, tt);
        if (o1.strokeColor && o2.strokeColor) obj.strokeColor = col(o1.strokeColor, o2.strokeColor, tt);
      }
      return obj;
    }

    if (obj.type === 'acc') {
      obj.x = lerp(o1.x, o2.x, prog('x'));
      obj.y = lerp(o1.y, o2.y, prog('y'));
      obj.scale = lerpScale(o1.scale, o2.scale, prog('scale'));
      obj.alpha = lerp(o1.alpha == null ? 1 : o1.alpha, o2.alpha == null ? 1 : o2.alpha, tt);
      obj.rot = lerp(o1.rot || 0, o2.rot || 0, prog('rot'));
      obj.offX = lerp(o1.offX || 0, o2.offX || 0, tt);
      obj.offY = lerp(o1.offY || 0, o2.offY || 0, tt);
      obj.ax = lerp(o1.ax || 0, o2.ax || 0, tt);
      obj.ay = lerp(o1.ay || 0, o2.ay || 0, tt);
      if (o1.w !== undefined && o2.w !== undefined) obj.w = lerp(o1.w, o2.w, prog('width'));
      if (o1.h !== undefined && o2.h !== undefined) obj.h = lerp(o1.h, o2.h, prog('height'));
      return obj;
    }

    if (obj.type === 'camera') {
      obj.x = lerp(o1.x, o2.x, prog('x'));
      obj.y = lerp(o1.y, o2.y, prog('y'));
      obj.scale = lerpScale(o1.scale, o2.scale, prog('scale'));
      obj.rot = lerp(o1.rot || 0, o2.rot || 0, prog('rot'));
      obj.alpha = lerp(o1.alpha == null ? 1 : o1.alpha, o2.alpha == null ? 1 : o2.alpha, tt);
      obj.w = lerp(o1.w || 640, o2.w || 640, prog('width'));
      obj.h = lerp(o1.h || 360, o2.h || 360, prog('height'));
      return obj;
    }

    /* 画笔 / 未知类型：位置缩放透明度插值，笔迹本体不变 */
    obj.x = lerp(o1.x || 0, o2.x || 0, prog('x'));
    obj.y = lerp(o1.y || 0, o2.y || 0, prog('y'));
    if (o1.scale !== undefined || o2.scale !== undefined) obj.scale = lerpScale(o1.scale, o2.scale, prog('scale'));
    if (o1.rot !== undefined || o2.rot !== undefined) obj.rot = lerp(o1.rot || 0, o2.rot || 0, prog('rot'));
    obj.alpha = lerp(o1.alpha == null ? 1 : o1.alpha, o2.alpha == null ? 1 : o2.alpha, tt);
    return obj;
  }

  /* 按轨道求值：idx 落在段内就用两端关键帧插值，否则原样返回槽位数据。
     返回值一律是「可以直接渲染的对象」或 null，永不返回哨兵。 */
  function evaluateTrack(track, idx, ctx) {
    const fr = track && track.frames;
    if (!fr || idx < 0 || idx >= fr.length) return null;
    const slot = locate(fr, idx);
    if (slot.kind === 'key' || slot.kind === 'plain') return fr[idx];
    if (slot.kind !== 'derived') return null;
    const o1 = fr[slot.a], o2 = fr[slot.b];
    if (!isReal(o1) || !isReal(o2)) return null;
    return interpolateObject(o1, o2, slot.u, ctx);
  }

  /* ---------------- 导出 ---------------- */
  const api = {
    KEY, DERIVED, DERIVED_SLOT,
    isDerived, isReal, isKey, isPlain, isBlank, kindOf,
    markKey, clearKey, originOf, curveOf, setCurve, stripFrameMarks,
    keyIndices, prevKeyIndex, nextKeyIndex,
    segments, segmentContaining, locate, segmentsForRange, expandRangeToSegments,
    reconcileTrack, countKinds, derivedCount,
    lerp, lerpAngle, lerpScale, interpolateObject, evaluateTrack
  };

  root.SKFE.systems.keyframes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
