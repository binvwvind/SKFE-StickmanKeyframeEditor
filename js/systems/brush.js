// js/systems/brush.js
// SKFE 画笔元件系统 v5.1.0 —— 矢量画笔（type: 'ink'）
// 说明：与 eraser.js 同一套模块范式（IIFE + init(deps) + boot()），
//       所有依赖通过 D.xxx 访问，不引入任何外部库。
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.brush = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  /* ==================== i18n 小工具 ==================== */
  function tr(key, fallback) {
    try {
      if (typeof window.t === 'function') {
        const s = window.t(key);
        if (s && s !== key) return s;
      }
    } catch (_) {}
    return fallback;
  }

  /* ==================== 状态 ==================== */
  let brushOn = false;              // 画笔模式是否开启
  let editingInk = null;            // 正在编辑的 ink 元件（null 表示新建模式）
  let baseStrokes = [];             // 进入时的初始笔迹（屏幕坐标，深度拷贝）
  let baseErasers = [];             // 进入时的初始橡皮（屏幕坐标，深度拷贝）
  let ops = [];                     // 本次编辑的操作栈（{ type:'stroke'|'erase', data }）
  let current = null;               // 当前笔画（实时）
  let penTip = { x: 0, y: 0 };      // 防抖笔尖位置
  let target = { x: 0, y: 0 };      // 指针目标位置
  let lastTipPos = { x: 0, y: 0 };
  let targetTime = 0;
  let releaseDeadline = 0;
  let drawing = false;
  let rafId = 0;
  let finishTimer = 0;              // 收笔兜底定时器（rAF 被节流时仍然提交笔画）
  let lastFrameTime = 0;
  let loopTimer = 0;                // rAF 兜底计时器
  let lastTickAt = 0;               // 上一次 tick 的时间戳（判断 rAF 是否被节流）
  let isPenPointer = false;
  let tipPressure = 0.5;
  let _prevSelected = null;         // 进入前的选中状态
  let _prevUndoDepth = 0;

  /* ==================== 画笔配置（面板驱动） ==================== */
  const cfg = {
    color: '#111111',
    borderColor: '#1a1a1a',
    borderWidth: 3,
    borderEnabled: true,
    size: 6,
    stabilize: 0.40
  };
  /* 面板配置持久化（不影响项目数据） */
  const CFG_KEY = 'skfe_brush_cfg_v1';
  function loadCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        if (typeof o.color === 'string') cfg.color = o.color;
        if (typeof o.borderColor === 'string') cfg.borderColor = o.borderColor;
        if (typeof o.borderWidth === 'number') cfg.borderWidth = o.borderWidth;
        if (typeof o.borderEnabled === 'boolean') cfg.borderEnabled = o.borderEnabled;
        if (typeof o.size === 'number') cfg.size = o.size;
        if (typeof o.stabilize === 'number') cfg.stabilize = o.stabilize;
      }
    } catch (_) {}
  }
  function saveCfg() {
    try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
  }

  /* ==================== 双层绘制状态 ==================== */
  let overlayCtx = null;
  let overlay = null;
  let DPR = 1;

  /* ==================== 初始化 ==================== */
  function boot() {
    overlay = document.getElementById('brushOverlay');
    if (!overlay) return;
    overlayCtx = overlay.getContext('2d');
    loadCfg();
    syncOverlaySize();
    bindUI();
    bindFloatBar();
    bindPresetUI();
    loadPresets();
    refreshPresetOptions();
    bindPointer();
    bindHotkeys();
    bindOutsideClickExit();
    window.addEventListener('resize', syncOverlaySize);
    /* 选中状态变化时刷新「编辑选中画笔」按钮可用性 */
    D.EventBus.on('need:syncUI', refreshButtons);
    applyCfgToPanel();
    restoreCfgInputs();
    syncBrushBtn();
  }

  function syncOverlaySize() {
    if (!overlay) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    overlay.width = Math.round(w * DPR);
    overlay.height = Math.round(h * DPR);
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
    if (overlayCtx) {
      overlayCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
      overlayCtx.lineCap = 'round';
      overlayCtx.lineJoin = 'round';
    }
    if (brushOn) renderOverlay();
  }

  /* brush-v5.1.0: 实现 §6.1.5 —— 面板绑定（画笔 / 橡皮合并面板） */
  function bindUI() {
    const $ = (id) => document.getElementById(id);

    const btnBrushToggle = $('btnBrushToggle');
    if (btnBrushToggle) {
      btnBrushToggle.addEventListener('click', () => {
        setOn(!brushOn);
      });
    }

    const color = $('brushColor');
    if (color) {
      color.addEventListener('input', () => {
        cfg.color = color.value;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const borderCb = $('brushBorderEnabled');
    if (borderCb) {
      borderCb.addEventListener('change', () => {
        cfg.borderEnabled = !!borderCb.checked;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const borderColor = $('brushBorderColor');
    if (borderColor) {
      borderColor.addEventListener('input', () => { cfg.borderColor = borderColor.value; saveCfg(); });
    }

    const borderWidth = $('brushBorderWidth');
    const borderWidthVal = $('brushBorderWidthVal');
    if (borderWidth) {
      borderWidth.addEventListener('input', () => {
        cfg.borderWidth = Math.max(0, parseInt(borderWidth.value, 10) || 0);
        if (borderWidthVal) borderWidthVal.textContent = cfg.borderWidth;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const size = $('brushSize');
    const sizeVal = $('brushSizeVal');
    if (size) {
      size.addEventListener('input', () => {
        cfg.size = Math.max(1, Math.min(40, parseInt(size.value, 10) || 6));
        if (sizeVal) sizeVal.textContent = cfg.size;
        saveCfg();
        updateBrushCursorSize();
      });
    }

    const stab = $('brushStabilize');
    const stabVal = $('brushStabilizeVal');
    if (stab) {
      stab.addEventListener('input', () => {
        const v = Math.max(0, Math.min(100, parseInt(stab.value, 10) || 0));
        cfg.stabilize = v / 100;
        if (stabVal) stabVal.textContent = v;
        saveCfg();
      });
    }

    /* 编辑选中的画笔元件（显式入口，不使用双击） */
    const btnEdit = $('btnBrushEdit');
    if (btnEdit) {
      btnEdit.addEventListener('click', () => {
        const sel = D.getSelected();
        if (!sel || sel.type !== 'ink') {
          D.showToast(tr('brush.noInkSelected', '请先选中一个画笔元件，再点「编辑选中画笔」'));
          return;
        }
        if (sel.locked) {
          D.showToast(tr('brush.locked', '该画笔元件已锁定，请先解锁'));
          return;
        }
        if (!brushOn) setOn(true);
        openEdit(sel);
      });
    }

    const btnClearFrame = $('btnBrushClearFrame');
    if (btnClearFrame) {
      btnClearFrame.addEventListener('click', () => {
        if (!window.confirm(tr('brush.confirmClearFrame', '确定删除本帧所有画笔元件吗？'))) return;
        const n = D.deleteInkOnCurrentFrame();
        if (n) D.showToast(tr('brush.toastClearedFrame', '已清除本帧画笔元件'));
      });
    }

    /* 橡皮擦面板控件：交给 eraser.js 自己的 initUI 处理，
       这里只处理「在画笔模式下切到擦除」的互斥关系。 */
    const btnEraserToggle = $('btnEraserToggle');
    if (btnEraserToggle) {
      btnEraserToggle.addEventListener('click', () => {
        /* eraser.js 的监听器先执行切换，这里在下一拍读取结果 */
        setTimeout(() => {
          if (brushOn) {
            if (D.eraserIsOn()) {
              D.showToast(tr('brush.toastEraseOn', '画笔模式内已切换到擦除：拖动可擦掉笔迹'));
            }
            updateBrushCursorSize();
          }
        }, 0);
      });
    }

    const eraserSize = $('eraserSize');
    if (eraserSize) {
      eraserSize.addEventListener('input', () => {
        D.eraserSetSize(parseInt(eraserSize.value, 10) || 15);
        updateBrushCursorSize();
      });
    }
    const eraserLine = $('eraserLineMode');
    if (eraserLine) {
      eraserLine.addEventListener('change', () => D.eraserSetLineMode(!!eraserLine.checked));
    }
  }

  function applyCfgToPanel() {
    const $ = (id) => document.getElementById(id);
    const map = [
      ['brushColor', cfg.color],
      ['brushBorderColor', cfg.borderColor],
      ['brushBorderWidth', cfg.borderWidth],
      ['brushSize', cfg.size],
      ['brushStabilize', Math.round(cfg.stabilize * 100)]
    ];
    map.forEach(([id, v]) => { const el = $(id); if (el) el.value = v; });
    const bw = $('brushBorderWidthVal'); if (bw) bw.textContent = cfg.borderWidth;
    const sv = $('brushSizeVal'); if (sv) sv.textContent = cfg.size;
    const st = $('brushStabilizeVal'); if (st) st.textContent = Math.round(cfg.stabilize * 100);
    const bc = $('brushBorderEnabled'); if (bc) bc.checked = !!cfg.borderEnabled;
  }

  function restoreCfgInputs() {
    const er = document.getElementById('eraserSize');
    if (er) er.value = D.eraserGetSize();
    const erv = document.getElementById('eraserSizeVal');
    if (erv) erv.textContent = D.eraserGetSize();
  }

  /* brush-v5.1.0: 实现 §6.1.6 —— 浮动工具栏（撤销上一笔 / 清空 / 取消 / 确定） */
  function bindFloatBar() {
    const bar = document.getElementById('brushFloatBar');
    if (!bar) return;
    const undo = document.getElementById('bfUndo');
    if (undo) undo.onclick = () => undoLast();
    const clear = document.getElementById('bfClear');
    if (clear) {
      clear.onclick = () => {
        if (ops.length === 0 && baseStrokes.length === 0 && baseErasers.length === 0) return;
        if (!window.confirm(tr('brush.confirmClear', '确定清空所有笔迹吗？'))) return;
        clearAll();
      };
    }
    const cancelBtn = document.getElementById('bfCancel');
    if (cancelBtn) cancelBtn.onclick = () => setOn(false);
    const ok = document.getElementById('bfConfirm');
    if (ok) ok.onclick = () => finalize();
  }

  function refreshButtons() {
    const hasContent = (ops.length > 0) || (baseStrokes.length > 0) || (baseErasers.length > 0);
    const c = document.getElementById('bfConfirm');
    if (c) c.disabled = !hasContent;
    const u = document.getElementById('bfUndo');
    if (u) u.disabled = ops.length === 0;
    const cl = document.getElementById('bfClear');
    if (cl) cl.disabled = !hasContent;
    const edit = document.getElementById('btnBrushEdit');
    if (edit) {
      const sel = D.getSelected();
      edit.disabled = !(sel && sel.type === 'ink' && !sel.locked);
    }
  }

  /* brush-v5.1.0: 实现 §6.1.2 —— 开关画笔模式（body.brush-mode + overlay 接管指针） */
  function setOn(on) {
    on = !!on;
    if (on === brushOn) return;
    brushOn = on;
    if (on) {
      if (D.isPlaying && D.isPlaying()) D.pause();
      /* 与橡皮擦互斥：进入画笔时关闭独立擦除 */
      D.eraserSetOn(false);
      _prevSelected = D.getSelected();
      _prevUndoDepth = D.getUndoDepth ? D.getUndoDepth() : 0;
      document.body.classList.add('brush-mode');
      const bar = document.getElementById('brushFloatBar');
      if (bar) bar.style.display = 'flex';
      syncOverlaySize();
      if (!editingInk && ops.length === 0 && baseStrokes.length === 0 && !current) openNew();
      refreshButtons();
      syncBrushBtn();
      D.refreshUI();
      D.showToast(tr('brush.toastOn', '画笔已开启，点击画布开始绘制'));
      D.EventBus.emit('need:render');
    } else {
      document.body.classList.remove('brush-mode');
      const bar = document.getElementById('brushFloatBar');
      if (bar) bar.style.display = 'none';
      cancel();
      syncBrushBtn();
      hideBrushCursor();
    }
  }

  function isOn() { return brushOn; }

  function syncBrushBtn() {
    const btn = document.getElementById('btnBrushToggle');
    if (!btn) return;
    btn.classList.toggle('on', brushOn);
    const key = brushOn ? 'brush.enableOff' : 'brush.enable';
    btn.textContent = tr(key, brushOn ? '🖌 退出画笔' : '🖌 开启画笔');
    /* 同步 data-i18n，语言切换后仍显示正确文案 */
    btn.setAttribute('data-i18n', key);
  }

  /* brush-v5.1.0: 实现 §6.1.3 —— 新建绘制会话（clean session） */
  function openNew() {
    editingInk = null;
    baseStrokes.length = 0;
    baseErasers.length = 0;
    ops.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    penTip = { x: 0, y: 0 };
    target = { x: 0, y: 0 };
    lastTipPos = { x: 0, y: 0 };
    syncOverlaySize();
    renderOverlay();
    refreshButtons();
  }

  /* brush-v5.1.0: 实现 §6.2.1 —— 局部坐标 → 世界坐标（读回已有笔迹） */
  function inkToWorld(ink) {
    const M = D.getInkLocalMatrix(ink);
    const applyM = (p) => ({
      x: M.a * p.x + M.c * p.y + M.e,
      y: M.b * p.x + M.d * p.y + M.f
    });
    /* 局部单位 → 世界长度（均匀缩放 + 旋转，用向量长度量） */
    const o0 = applyM({ x: 0, y: 0 });
    const o1 = applyM({ x: 1, y: 0 });
    const scaleUnit = Math.hypot(o1.x - o0.x, o1.y - o0.y) || 1;

    const strokes = (ink.strokes || []).map(s => ({
      z: (typeof s.z === 'number' ? s.z : 0),        /* brush-v5.1.2: 落笔顺序 */
      color: s.color,
      borderColor: s.borderColor || null,
      borderWidth: (s.borderWidth || 0) * scaleUnit,
      points: (s.points || []).map(p => {
        const w = applyM(p);
        return { x: w.x, y: w.y, w: (p.w || 0) * scaleUnit };
      })
    }));

    /* eraser.size 在渲染时按"世界宽度"使用（drawMask 不参与局部缩放），故直接取世界值 */
    const erasers = (ink.eraser || []).map(er => ({
      z: (typeof er.z === 'number' ? er.z : 1e9),    /* 旧数据没有 z → 视作最后擦除 */
      size: er.size || 1,
      points: (er.points || []).map(p => {
        const w = applyM(p);
        return { x: w.x, y: w.y };
      })
    }));

    return { strokes, erasers };
  }

  /* brush-v5.1.0: 实现 §6.1.4 —— 打开重绘（旧笔迹回显 + 追加 + 局部擦除） */
  function openEdit(ink) {
    if (!ink || ink.type !== 'ink') return false;
    /* 元件可能已被删除（历史回滚 / 其他轨道） */
    const exists = D.getObjects().some(o => o && o.id === ink.id);
    if (!exists) { cancel(); return false; }

    const world = inkToWorld(ink);
    const worldToScreen = D.worldToScreen;
    /* 世界长度 → 屏幕长度（笔迹宽度与擦除遮罩都按世界单位存储） */
    const kv = worldUnitScreenLen();

    baseStrokes = world.strokes.map(s => ({
      z: s.z,                                        /* brush-v5.1.2: 保留原有落笔顺序 */
      color: s.color,
      borderColor: s.borderColor,
      borderWidth: s.borderWidth * kv,
      points: s.points.map(p => {
        const sp = worldToScreen({ x: p.x, y: p.y });
        return { x: sp.x, y: sp.y, w: p.w * kv };
      })
    }));

    baseErasers = world.erasers.map(er => ({
      z: er.z,                                       /* brush-v5.1.2: 遮罩的擦除顺序 */
      size: er.size * kv,
      points: er.points.map(p => {
        const sp = worldToScreen({ x: p.x, y: p.y });
        return { x: sp.x, y: sp.y };
      })
    }));

    editingInk = ink;
    ops.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    syncOverlaySize();
    renderOverlay();
    refreshButtons();
    D.showToast(tr('brush.hintEdit', '正在重新编辑画笔元件：旧笔迹已载入，可用橡皮擦局部擦除'));
    D.EventBus.emit('need:render');
    return true;
  }

  /* 世界单位 → 屏幕长度（随视图缩放 / 摄像机视角变化） */
  function worldUnitScreenLen() {
    const a = D.worldToScreen({ x: 0, y: 0 });
    const b = D.worldToScreen({ x: 1, y: 0 });
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return d > 1e-6 ? d : 1;
  }

  /* brush-v5.1.0: 实现 §7.1 —— 自动绑定（优先选中火柴人，否则最近关节点） */
  function pickTargetFigure(centerWorld) {
    const sel = D.getSelected();
    if (sel && sel.type === 'figure') return sel;
    const figs = D.getObjects().filter(o => o && o.type === 'figure');
    if (!figs.length) return null;
    let best = null, bestD = Infinity;
    for (const f of figs) {
      const d = Math.hypot((f.x || 0) - centerWorld.x, (f.y || 0) - centerWorld.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  /* 火柴人自身旋转/镜像（渲染时套在绑定对象外层） */
  function figRenderTransform(fig) {
    const tr = D.getBoundFigureTransform({ bindTo: 'head', targetId: fig.id, type: 'ink' });
    if (!tr) return null;
    return tr;
  }

  function toFigRenderSpace(fig, ftr, p) {
    if (!ftr) return p;
    const cx = fig.x || 0, cy = fig.y || 0;
    let dx = p.x - cx, dy = p.y - cy;
    if (ftr.rot) {
      const a = ftr.rot * Math.PI / 180;
      const c = Math.cos(a), s = Math.sin(a);
      const nx = dx * c - dy * s, ny = dx * s + dy * c;
      dx = nx; dy = ny;
    }
    if (ftr.mirror) dx = -dx;
    return { x: cx + dx, y: cy + dy };
  }

  /* 12 个关节点里挑离 ink 中心最近的（用渲染后的世界坐标比较） */
  function pickMount(fig, centerWorld) {
    const j = D.jointData(fig);
    const pts = {
      head: j.headC, neck: j.neck, waist: j.waistPoint, pelvis: j.pelvis,
      handL: j.handL, handR: j.handR, elbowL: j.elbowL, elbowR: j.elbowR,
      footL: j.footL, footR: j.footR, kneeL: j.thighL, kneeR: j.thighR
    };
    const ftr = figRenderTransform(fig);
    let best = 'head', bestD = Infinity;
    for (const k in pts) {
      const p = toFigRenderSpace(fig, ftr, pts[k]);
      const d = Math.hypot(p.x - centerWorld.x, p.y - centerWorld.y);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /* brush-v5.1.0: 实现 §6.2.2 —— 世界笔迹 → ink 元件字段（含绑定反算） */
  /* worldStrokes: [{color,borderColor,borderWidth(世界),points:[{x,y,w(世界)}]}]
     worldErasers: [{size(世界),points:[{x,y}]}] */
  function buildFromWorld(worldStrokes, worldErasers, opts) {
    opts = opts || {};

    /* 1. 世界包围盒（含线宽与外扩边） */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of worldStrokes) {
      const bw = s.borderWidth || 0;
      for (const p of s.points) {
        const half = Math.max(p.w || 0, 1) / 2 + bw;
        if (p.x - half < minX) minX = p.x - half;
        if (p.y - half < minY) minY = p.y - half;
        if (p.x + half > maxX) maxX = p.x + half;
        if (p.y + half > maxY) maxY = p.y + half;
      }
    }
    if (!isFinite(minX)) return null;
    if (maxX - minX < 1) { maxX = minX + 1; }
    if (maxY - minY < 1) { maxY = minY + 1; }

    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const boxW = maxX - minX, boxH = maxY - minY;

    /* 2. 绑定目标：重绘时沿用原绑定（避免每次编辑都跳到别的关节），新建时自动挑选 */
    let fig = null, bindTo = 'none';
    if (opts.keepBind && opts.keepBind.bindTo && opts.keepBind.bindTo !== 'none' && opts.keepBind.targetId) {
      fig = D.findFigureById(opts.keepBind.targetId);
      if (fig) bindTo = opts.keepBind.bindTo;
    }
    if (!fig) {
      fig = pickTargetFigure(center);
      if (fig) bindTo = pickMount(fig, center);
    }
    if (opts.forceNoBind) { fig = null; bindTo = 'none'; }

    /* 3. 无火柴人 → 直接按世界坐标存（不绑定） */
    if (!fig || bindTo === 'none') {
      return {
        x: center.x, y: center.y, w: boxW, h: boxH,
        bindTo: 'none', targetId: null, offX: 0, offY: 0, rot: 0,
        strokes: worldStrokes.map(s => ({
          z: s.z,                                  /* brush-v5.1.2: 落笔顺序（不绑定分支） */
          color: s.color,
          borderColor: s.borderColor,
          borderWidth: s.borderWidth || 0,
          points: s.points.map(p => ({ x: p.x - center.x, y: p.y - center.y, w: p.w }))
        })),
        eraser: worldErasers.map(er => ({
          z: er.z,                               /* brush-v5.1.2: 擦除顺序（不绑定分支） */
          size: er.size,
          points: er.points.map(p => ({ x: p.x - center.x, y: p.y - center.y }))
        }))
      };
    }

    /* 4. 挂载点基准（未套用火柴人旋转/镜像的坐标） */
    const base = D.getBindBase({ bindTo: bindTo, targetId: fig.id, type: 'ink' });
    if (!base) {
      return buildFromWorld(worldStrokes, worldErasers, { forceNoBind: true });
    }
    const g = (base.scale || fig.scale || 1) || 1;
    const ba = base.angle || 0;

    /* 5. 火柴人渲染变换 T(p)=c+R(S(p-c))，求逆把"画面上看到的点"还原到火柴人自身坐标系 */
    const ftr = figRenderTransform(fig);
    const cx = fig.x || 0, cy = fig.y || 0;
    const rotRad = (ftr && ftr.rot ? ftr.rot : 0) * Math.PI / 180;
    const mir = !!(ftr && ftr.mirror);
    const invT = (p) => {
      let dx = p.x - cx, dy = p.y - cy;
      if (rotRad) {
        const c = Math.cos(-rotRad), s = Math.sin(-rotRad);
        const nx = dx * c - dy * s, ny = dx * s + dy * c;
        dx = nx; dy = ny;
      }
      if (mir) dx = -dx;
      return { x: cx + dx, y: cy + dy };
    };

    /* 6. 以"逆变换后的中心"作为 ink 的局部原点，保证绑定后世界位置不偏移 */
    const cInv = invT(center);
    const localOf = (p) => {
      const q = invT(p);
      let lx = (q.x - cInv.x) / g;
      const ly = (q.y - cInv.y) / g;
      return { x: lx, y: ly };
    };

    const strokes = worldStrokes.map(s => ({
      z: s.z,                                    /* brush-v5.1.2: 落笔顺序 */
      color: s.color,
      borderColor: s.borderColor,
      borderWidth: (s.borderWidth || 0) / g,
      points: s.points.map(p => {
        const l = localOf(p);
        return { x: l.x, y: l.y, w: (p.w || 0) / g };
      })
    }));

    const eraser = worldErasers.map(er => ({
      z: er.z,                                   /* brush-v5.1.2: 擦除顺序 */
      /* 遮罩宽度按世界单位绘制（drawMask 不做局部缩放） */
      size: er.size,
      points: er.points.map(p => localOf(p))
    }));

    /* 7. 反算 offX/offY：使 getBindTransform(ink) 落在 cInv 上 */
    const dx = cInv.x - base.x, dy = cInv.y - base.y;
    const cs = Math.cos(-ba), sn = Math.sin(-ba);
    const offX = (dx * cs - dy * sn) / g;
    const offY = (dx * sn + dy * cs) / g;

    /* 8. rot 抵消挂载角度 → 绑定后笔迹方向与"画的时候"完全一致 */
    const rotDeg = -ba * 180 / Math.PI;

    return {
      x: center.x, y: center.y, w: boxW / g, h: boxH / g,
      bindTo: bindTo, targetId: fig.id, offX: offX, offY: offY, rot: rotDeg,
      strokes: strokes,
      eraser: eraser
    };
  }

  /* 给已有 ink 重新计算绑定（保持世界外观不变） */
  function autoBind(ink) {
    if (!ink || ink.type !== 'ink') return false;
    const world = inkToWorld(ink);
    const built = buildFromWorld(world.strokes, world.erasers, { keepBind: null });
    if (!built) return false;
    applyBuilt(ink, built);
    D.EventBus.emit('need:render');
    return true;
  }

  function applyBuilt(ink, built) {
    ink.x = built.x;
    ink.y = built.y;
    ink.w = built.w;
    ink.h = built.h;
    ink.rot = built.rot;
    ink.bindTo = built.bindTo;
    ink.targetId = built.targetId;
    ink.offX = built.offX;
    ink.offY = built.offY;
    ink.strokes = built.strokes;
    ink.eraser = built.eraser;
  }

  /* brush-v5.1.1: 点到线段距离（屏幕/世界同一套算法） */
  function distPointSeg(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 1e-9) t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
  }

  /* brush-v5.1.1: 把一段擦除遮罩裁剪到"已有笔迹的覆盖范围"内。
     只留下真正压到笔迹的点（边缘少量外扩保留，保证擦边效果不变），
     空白处的点直接丢弃；并按连续性切段，避免远点连成一条直线误擦。 */
  function clipEraseToStrokes(er, strokes) {
    const pts = (er && er.points) || [];
    if (!pts.length) return [];
    const reach = Math.max(1, er.size || 1) / 2 + 1.5;
    const segs = [];
    for (const s of strokes) {
      const sp = s.points || [];
      if (!sp.length) continue;
      const bw = (s.borderWidth || 0) / 2;
      for (let i = 0; i < sp.length; i++) {
        const a = sp[i], b = sp[Math.min(i + 1, sp.length - 1)];
        segs.push({ a, b, hw: Math.max(a.w || 0, b.w || 0) / 2 + bw });
      }
    }
    if (!segs.length) return [];
    const out = [];
    let run = [];
    const flush = () => { if (run.length) { out.push({ size: er.size, points: run }); run = []; } };
    for (const p of pts) {
      let hit = false;
      for (const sg of segs) {
        if (distPointSeg(p, sg.a, sg.b) - sg.hw <= reach) { hit = true; break; }
      }
      if (hit) run.push(p);
      else flush();
    }
    flush();
    return out;
  }

  /* brush-v5.1.0: 实现 §6.1.12 —— 退出（确定写入元件 / 取消丢弃） */
  function finalize() {
    /* 未收尾的当前笔画先提交，避免"最后一下"被丢掉 */
    if (current) finishCurrentStroke();
    /* 1. 按时间顺序收集笔迹 / 擦除（屏幕坐标）
       brush-v5.1.1: 擦除遮罩只保留"真正擦到已有笔迹"的部分 —— 空白处不留罩。
       brush-v5.1.2: 每个笔迹与每段遮罩都带一个落笔序号 z，渲染时按 z 依次落笔，
       擦除只会吃掉"它之前"的笔迹，所以"先擦除、再画上去"的新笔迹不会再被旧遮罩擦掉。 */
    const seq = [];                 /* 有序：{kind:'stroke'|'erase', data, z} */
    const allStrokes = [];          /* 供裁剪使用：此刻已存在的笔迹 */
    let zNext = 0;

    /* 进入编辑时已有的内容，先按它们自己的 z 复位（旧数据：笔迹 0，遮罩最后） */
    const baseItems = [];
    for (const s of baseStrokes) baseItems.push({ kind: 'stroke', data: s, z: (typeof s.z === 'number' ? s.z : 0) });
    for (const er of baseErasers) baseItems.push({ kind: 'erase', data: er, z: (typeof er.z === 'number' ? er.z : 1e9) });
    baseItems.sort((a, b) => a.z - b.z);

    for (const it of baseItems) {
      if (it.kind === 'stroke') {
        allStrokes.push(it.data);
        seq.push({ kind: 'stroke', data: it.data, z: zNext++ });
      } else {
        /* 旧遮罩按"进入时的笔迹"复核一次，顺手清理历史数据里落在空白处的罩 */
        for (const run of clipEraseToStrokes(it.data, allStrokes)) seq.push({ kind: 'erase', data: run, z: zNext++ });
      }
    }
    for (const op of ops) {
      if (op.type === 'stroke') {
        allStrokes.push(op.data);
        seq.push({ kind: 'stroke', data: op.data, z: zNext++ });
      } else if (op.type === 'erase') {
        for (const run of clipEraseToStrokes(op.data, allStrokes)) seq.push({ kind: 'erase', data: run, z: zNext++ });
      }
    }
    const orderedStrokes = seq.filter(it => it.kind === 'stroke');
    if (!orderedStrokes.length) { cancel(); return; }

    /* 2. 屏幕 → 世界（z 原样带过去，交给渲染端按序落笔） */
    const kv = worldUnitScreenLen();
    const worldStrokes = orderedStrokes.map(it => {
      const s = it.data;
      return {
        z: it.z,
        color: s.color,
        borderColor: s.borderColor || null,
        borderWidth: (s.borderWidth || 0) / kv,
        points: s.points.map(p => {
          const w = D.screenToWorld(p.x, p.y);
          return { x: w.x, y: w.y, w: (p.w || 0) / kv };
        })
      };
    });
    const worldErasers = seq.filter(it => it.kind === 'erase').map(it => {
      const er = it.data;
      return {
        z: it.z,
        size: (er.size || 1) / kv,
        points: er.points.map(p => {
          const w = D.screenToWorld(p.x, p.y);
          return { x: w.x, y: w.y };
        })
      };
    });

    /* 3. 决定绑定并生成局部数据 */
    const keepBind = editingInk
      ? { bindTo: editingInk.bindTo, targetId: editingInk.targetId }
      : null;
    const built = buildFromWorld(worldStrokes, worldErasers, { keepBind: keepBind });
    if (!built) { cancel(); return; }

    const hadFig = built.bindTo !== 'none' && built.targetId;

    if (editingInk) {
      /* 4a. 更新已有元件 */
      const ink = editingInk;
      applyBuilt(ink, built);
      /* 全局属性联动（globalEditEnabled 时同步所有帧） */
      D.setGlobalProp(ink, 'strokes', JSON.parse(JSON.stringify(built.strokes)));
      D.setGlobalProp(ink, 'eraser', JSON.parse(JSON.stringify(built.eraser)));
      D.setGlobalProp(ink, 'x', ink.x);
      D.setGlobalProp(ink, 'y', ink.y);
      D.setGlobalProp(ink, 'w', ink.w);
      D.setGlobalProp(ink, 'h', ink.h);
      D.setGlobalProp(ink, 'rot', ink.rot);
      D.setGlobalProp(ink, 'bindTo', ink.bindTo);
      D.setGlobalProp(ink, 'targetId', ink.targetId);
      D.setGlobalProp(ink, 'offX', ink.offX);
      D.setGlobalProp(ink, 'offY', ink.offY);
      D.markCurrentFrameModified();
      D.invalidateAllFrameThumbs();
      /* 记录"修改后"的快照，保证 Ctrl+Z / Ctrl+Y 都能正确回退与重做 */
      D.EventBus.emit('history:save', '更新画笔元件');
      resetSession();
      D.refreshUI();
      D.EventBus.emit('need:render');
      D.showToast(tr('brush.toastUpdate', '画笔元件已更新'));
      if (!hadFig) D.showToast(tr('brush.toastNoFig', '当前画布没有火柴人，画笔元件未绑定'));
      return;
    }

    /* 4b. 新建元件 */
    const ink = {
      id: D.nextUid(),
      type: 'ink',
      name: D.generateName('ink'),
      x: built.x, y: built.y,
      w: built.w, h: built.h,
      scale: 1, rot: built.rot, alpha: 1,
      layer: 10,
      locked: false, mirror: false,
      ax: 0, ay: 0,
      bindTo: built.bindTo, targetId: built.targetId,
      offX: built.offX, offY: built.offY,
      strokes: built.strokes,
      eraser: built.eraser
    };
    D.addObjectToFrames(ink);
    /* 先结束会话，避免 queueInk 把新元件当作"编辑中"跳过 */
    const prevSel = _prevSelected;
    resetSession();
    D.select(ink);
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.EventBus.emit('history:save', '新建画笔元件');
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.showToast(tr('brush.toastConfirm', '已生成画笔元件') + (hadFig ? '' : ' · ' + tr('brush.toastNoFig', '未绑定')));
    _prevSelected = prevSel;
  }

  function resetSession() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = 0; }
    editingInk = null;
    baseStrokes.length = 0;
    baseErasers.length = 0;
    ops.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    clearOverlay();
    refreshButtons();
  }

  function cancel() {
    const had = !!editingInk || ops.length > 0 || baseStrokes.length > 0 || baseErasers.length > 0 || !!current;
    resetSession();
    /* 未确定就退出 → 恢复进入前的选中状态（已确定时 had 为 false，不动选中） */
    if (had && _prevSelected) {
      const p = _prevSelected;
      _prevSelected = null;
      try { D.select(p); } catch (_) {}
    }
    D.EventBus.emit('need:render');
  }

  /* brush-v5.1.0: 实现 §6.1.9 —— Overlay 重绘（旧笔迹 + 本次操作 + 当前笔画） */
  function clearOverlay() {
    if (!overlayCtx || !overlay) return;
    overlayCtx.clearRect(0, 0, overlay.width / DPR, overlay.height / DPR);
  }

  function renderOverlay() {
    if (!overlayCtx) return;
    const W = overlay.width / DPR;
    const H = overlay.height / DPR;
    overlayCtx.clearRect(0, 0, W, H);

    /* brush-v5.1.2: 基线内容也按 z 顺序回放（旧遮罩不再盖在后来补画的笔迹上），
       编辑过程中所见即所得，和点「确定」后的结果是同一套顺序。 */
    const baseItems = [];
    for (const s of baseStrokes) baseItems.push({ kind: 'stroke', z: (typeof s.z === 'number' ? s.z : 0), data: s });
    for (const er of baseErasers) baseItems.push({ kind: 'erase', z: (typeof er.z === 'number' ? er.z : 1e9), data: er });
    baseItems.sort((a, b) => a.z - b.z);
    for (const it of baseItems) {
      if (it.kind === 'stroke') drawStroke(overlayCtx, it.data);
      else drawErase(overlayCtx, it.data);
    }
    for (const op of ops) {
      if (op.type === 'stroke') drawStroke(overlayCtx, op.data);
      else if (op.type === 'erase') drawErase(overlayCtx, op.data);
    }
    if (current) {
      if (current.type === 'stroke') drawStroke(overlayCtx, current.data);
      else if (current.type === 'erase') drawErase(overlayCtx, current.data);
    }
  }

  /* 每笔内部先边后芯（需求 4：同一笔内"边被芯覆盖"） */
  function drawStroke(c, s) {
    if (!s || !s.points || !s.points.length) return;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (s.borderWidth > 0 && s.borderColor) {
      c.strokeStyle = s.borderColor;
      c.fillStyle = s.borderColor;
      if (s.points.length === 1) {
        const p = s.points[0];
        c.beginPath();
        c.arc(p.x, p.y, Math.max(p.w / 2, 0.4) + s.borderWidth, 0, Math.PI * 2);
        c.fill();
      } else {
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1], b = s.points[i];
          c.lineWidth = ((a.w + b.w) / 2) + s.borderWidth * 2;
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
        }
      }
    }

    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    if (s.points.length === 1) {
      const p = s.points[0];
      c.beginPath();
      c.arc(p.x, p.y, Math.max(p.w / 2, 0.4), 0, Math.PI * 2);
      c.fill();
    } else {
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1], b = s.points[i];
        c.lineWidth = Math.max(0.4, (a.w + b.w) / 2);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
    }
    c.restore();
  }

  function drawErase(c, er) {
    if (!er || !er.points || !er.points.length) return;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(0.5, er.size || 1);
    if (er.points.length === 1) {
      c.beginPath();
      c.arc(er.points[0].x, er.points[0].y, Math.max(0.5, (er.size || 1) / 2), 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      for (let i = 0; i < er.points.length; i++) {
        if (i === 0) c.moveTo(er.points[i].x, er.points[i].y);
        else c.lineTo(er.points[i].x, er.points[i].y);
      }
      c.stroke();
    }
    c.restore();
  }

  /* brush-v5.1.0: 实现 §6.1.10 —— 防抖追逐（requestAnimationFrame）+ 实时落笔 */
  function startLoop() {
    if (rafId) return;
    lastFrameTime = performance.now();
    lastTickAt = lastFrameTime;
    rafId = requestAnimationFrame(tick);
    startWatchdog();
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    stopWatchdog();
  }

  /* brush-v5.1.0: rAF 在后台标签页/无头环境会被节流到几乎不触发，
     用计时器兜底推动同一个 tick，保证笔迹不会因为掉帧而丢点 */
  function startWatchdog() {
    if (loopTimer) return;
    loopTimer = setInterval(function () {
      if (!current) { stopWatchdog(); return; }
      const now = performance.now();
      if (now - lastTickAt > 60) tick(now, true);
    }, 40);
  }

  function stopWatchdog() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = 0; }
  }

  function tick(now, viaTimer) {
    if (!viaTimer) rafId = 0;
    lastTickAt = now;
    if (!current) { drawing = false; stopLoop(); return; }

    const dt = Math.max(1, Math.min(now - lastFrameTime, 40));
    lastFrameTime = now;

    /* === 1. 笔尖追逐指针（防抖） === */
    const dx = target.x - penTip.x, dy = target.y - penTip.y;
    const dist = Math.hypot(dx, dy);
    let changed = false;

    if (dist > 0.01) {
      const s = Math.max(0, Math.min(0.98, cfg.stabilize));
      const inv = 1 - s;
      const inv3 = inv * inv * inv;
      let baseSpeed = 0.35 + inv3 * 20;
      let distFactor = 0.05 + inv3 * 1.5;
      if (now - targetTime > 70) { baseSpeed *= 2.4; distFactor *= 1.8; }
      const step = baseSpeed + dist * distFactor;
      const move = Math.min(dist, step);
      if (dist - move < 0.25) { penTip.x = target.x; penTip.y = target.y; }
      else { penTip.x += (dx / dist) * move; penTip.y += (dy / dist) * move; }

      /* === 2. 落笔 === */
      const ddx = penTip.x - lastTipPos.x, ddy = penTip.y - lastTipPos.y;
      const d = Math.hypot(ddx, ddy);
      if (d > 0.2) {
        if (current.type === 'stroke') {
          const speed = d / dt * 16;
          current.data.points.push({ x: penTip.x, y: penTip.y, w: widthAt(speed, tipPressure, isPenPointer) });
        } else {
          current.data.points.push({ x: penTip.x, y: penTip.y });
        }
        lastTipPos.x = penTip.x;
        lastTipPos.y = penTip.y;
        changed = true;
      }
    }

    if (changed) renderOverlay();

    /* === 3. 松手收尾 === */
    if (!drawing) {
      const remain = Math.hypot(target.x - penTip.x, target.y - penTip.y);
      if (remain < 0.4 || now > releaseDeadline) { finishCurrentStroke(); return; }
    }
    if (!viaTimer) rafId = requestAnimationFrame(tick);
  }

  /* 宽变：速度（鼠标）+ 压感（手写笔） */
  function widthAt(speed, press, isPen) {
    const base = Math.max(1, cfg.size);
    let f;
    if (isPen) f = 0.40 + press * 1.25;
    else f = 1.12 - Math.min(speed, 3) * 0.20;
    return Math.max(0.5, base * f);
  }

  function finishCurrentStroke() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = 0; }
    if (!current) { drawing = false; stopLoop(); renderOverlay(); return; }
    if (current.type === 'stroke') ops.push({ type: 'stroke', data: current.data });
    else ops.push({ type: 'erase', data: current.data });
    current = null;
    drawing = false;
    stopLoop();
    renderOverlay();
    refreshButtons();
  }

  /* brush-v5.1.0: 实现 §6.1.11 —— 指针事件（落笔 / 追逐 / 收笔） */
  function bindPointer() {
    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', onUp);
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    /* 光标更新注册在 eraser.initUI 之后，保证覆盖 eraser.js 的光标逻辑 */
    document.addEventListener('pointermove', onDocMoveCursor, { passive: true });
    document.addEventListener('pointerleave', hideBrushCursor);
  }

  function localPoint(e) {
    const rect = overlay.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onDown(e) {
    if (!brushOn) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();

    if (current) finishCurrentStroke();
    try { overlay.setPointerCapture(e.pointerId); } catch (_) {}

    const p = localPoint(e);
    penTip = { x: p.x, y: p.y };
    target = { x: p.x, y: p.y };
    lastTipPos = { x: p.x, y: p.y };
    targetTime = performance.now();
    releaseDeadline = 0;
    isPenPointer = e.pointerType === 'pen';
    tipPressure = (isPenPointer && e.pressure > 0) ? e.pressure : 0.5;
    drawing = true;

    if (D.eraserIsOn()) {
      /* 画笔模式内切到橡皮 → 本次笔画是一段擦除遮罩 */
      current = {
        type: 'erase',
        data: { size: Math.max(1, D.eraserGetSize() * 2.6), points: [{ x: p.x, y: p.y }] }
      };
    } else {
      current = {
        type: 'stroke',
        data: {
          color: cfg.color,
          borderColor: cfg.borderEnabled ? cfg.borderColor : null,
          borderWidth: cfg.borderEnabled ? cfg.borderWidth : 0,
          points: [{ x: p.x, y: p.y, w: widthAt(0, tipPressure, isPenPointer) }]
        }
      };
    }
    renderOverlay();
    startLoop();
  }

  function onMove(e) {
    if (!brushOn) return;
    if (!drawing || !current) return;
    e.preventDefault();
    const p = localPoint(e);
    target.x = p.x;
    target.y = p.y;
    targetTime = performance.now();
    const pr = (e.pointerType === 'pen' && e.pressure > 0) ? e.pressure : 0.5;
    tipPressure = tipPressure * 0.65 + pr * 0.35;
    startLoop();
  }

  function onUp(e) {
    if (!drawing) return;
    drawing = false;
    releaseDeadline = performance.now() + 400;
    startLoop();
    /* 兜底：标签页后台 / rAF 被节流时，用定时器保证笔画一定会提交 */
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      finishTimer = 0;
      if (current && !drawing) finishCurrentStroke();
    }, 460);
    try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
  }

  /* brush-v5.1.0: 实现 §6.1.14 —— 圆形光标（复用 #eraserCursor） */
  function brushCursorRadius() {
    if (D.eraserIsOn()) return Math.max(4, D.eraserGetSize() * 2.6 / 2);
    const bw = cfg.borderEnabled ? cfg.borderWidth * 2 : 0;
    return Math.max(4, (cfg.size + bw) / 2);
  }

  function updateBrushCursorSize() {
    /* 尺寸在下一次 pointermove 时应用，这里只做即时刷新（指针不动时也更新） */
    const cursor = document.getElementById('eraserCursor');
    if (!cursor || !brushOn) return;
    const d = brushCursorRadius() * 2;
    cursor.style.width = d + 'px';
    cursor.style.height = d + 'px';
    if (D.eraserIsOn()) cursor.style.borderColor = '';
    else cursor.style.borderColor = cfg.color;
  }

  function onDocMoveCursor(e) {
    if (!brushOn) { return; }
    const cursor = document.getElementById('eraserCursor');
    if (!cursor) return;
    /* 只有指针在画笔画布上时显示圆形光标 */
    const overOverlay = (e.target === overlay);
    if (!overOverlay) { hideBrushCursor(); return; }
    const d = brushCursorRadius() * 2;
    cursor.style.setProperty('display', 'block', 'important');
    cursor.style.width = d + 'px';
    cursor.style.height = d + 'px';
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
    if (D.eraserIsOn()) cursor.style.borderColor = '';
    else cursor.style.borderColor = cfg.color;
  }

  function hideBrushCursor() {
    const cursor = document.getElementById('eraserCursor');
    if (!cursor) return;
    if (brushOn) cursor.style.setProperty('display', 'none', 'important');
  }

  /* brush-v5.1.0: 实现 §6.1.13 —— 快捷键（会话内接管，不影响旧笔迹） */
  function bindHotkeys() {
    window.addEventListener('keydown', (e) => {
      if (!brushOn) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = (e.key || '').toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
        if (k === 'y') { e.preventDefault(); e.stopPropagation(); return; }
        return;
      }
      if (k === 'escape') { e.preventDefault(); e.stopPropagation(); setOn(false); return; }
      if (k === 'z') { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
      /* 画笔模式下禁止切换帧 / 播放 / 删除 / 复制 / 重置等画布级快捷键 */
      if (k === ' ' || k === 'arrowleft' || k === 'arrowright' ||
          k === 'delete' || k === 'backspace' || k === 'c' || k === 'r') {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }

  /* 点击面板以外的区域 → 退出画笔模式（避免误触其它元件 / 时间轴） */
  function bindOutsideClickExit() {
    document.addEventListener('pointerdown', (e) => {
      if (!brushOn) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t === overlay || t.id === 'brushOverlay') return;
      if (t.closest('#brushFloatBar')) return;
      if (t.closest('.tool-panel[data-tool="eraser"]')) return;
      if (t.closest('#toolChips .tool-chip[data-tool="eraser"]')) return;
      setOn(false);
    }, true);
  }

  /* brush-v5.1.0: 实现 §6.1.15 —— 会话内撤销上一笔 / 清空 */
  function undoLast() {
    if (!ops.length) return;
    ops.pop();
    renderOverlay();
    refreshButtons();
  }

  function clearAll() {
    ops.length = 0;
    baseStrokes.length = 0;
    baseErasers.length = 0;
    current = null;
    drawing = false;
    stopLoop();
    renderOverlay();
    refreshButtons();
  }

  /* ==================== 画笔预设（v5.1.1：笔迹 + 挂载位置） ==================== */
  const PRESET_KEY = 'skfe_ink_presets_v1';
  let presets = [];

  function cloneJSON(v) { return JSON.parse(JSON.stringify(v == null ? null : v)); }

  function loadPresets() {
    try {
      const raw = localStorage.getItem(PRESET_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      presets = Array.isArray(arr) ? arr.filter(p => p && p.id && Array.isArray(p.strokes)) : [];
    } catch (_) { presets = []; }
  }

  function savePresets() {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); } catch (_) {}
  }

  function refreshPresetOptions(selectId) {
    const sel = document.getElementById('inkPresetSelect');
    if (!sel) return;
    const keep = selectId || sel.value;
    sel.innerHTML = '';
    if (!presets.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = tr('brushPreset.empty', '还没有预设');
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const p of presets) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.bindTo && p.bindTo !== 'none' ? ' · ' + p.bindTo : '');
      sel.appendChild(o);
    }
    if (keep && presets.some(p => p.id === keep)) sel.value = keep;
  }

  /* 把当前选中的 ink 存成预设（笔迹用局部单位，可直接复用；同时记录挂载点与偏移） */
  function savePresetFromSelection() {
    const sel = D.getSelected();
    if (!sel || sel.type !== 'ink') {
      D.showToast(tr('brushPreset.toastNeedInk', '请先选中一个画笔元件，再存为预设'));
      return false;
    }
    const nameEl = document.getElementById('inkPresetName');
    const typed = nameEl ? nameEl.value.trim().slice(0, 20) : '';
    const name = typed || sel.name || D.generateName('ink');
    /* 相对旋转：抵消挂载角度后的"用户额外旋转"，换关节复用也不会歪 */
    const base = (sel.bindTo && sel.bindTo !== 'none' && sel.targetId) ? D.getBindBase(sel) : null;
    const baseDeg = base ? base.angle * 180 / Math.PI : 0;
    const data = {
      id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
      name: name,
      at: Date.now(),
      strokes: cloneJSON(sel.strokes || []),
      eraser: cloneJSON(sel.eraser || []),
      bindTo: sel.bindTo || 'none',
      offX: sel.offX || 0,
      offY: sel.offY || 0,
      relRot: (sel.rot || 0) + baseDeg,
      scale: sel.scale || 1,
      w: sel.w || 1,
      h: sel.h || 1,
      alpha: sel.alpha == null ? 1 : sel.alpha,
      layer: sel.layer == null ? 10 : sel.layer
    };
    const dup = presets.findIndex(p => p.name === name);
    if (dup >= 0) presets[dup] = data;
    else presets.unshift(data);
    savePresets();
    refreshPresetOptions(data.id);
    if (nameEl) nameEl.value = '';
    D.showToast(tr('brushPreset.toastSaved', '已保存预设：') + name);
    return true;
  }

  /* 应用预设：按记录的挂载点 + 偏移挂到当前选中的火柴人（没有则第一个火柴人） */
  function applyPreset(preset) {
    if (!preset) {
      D.showToast(tr('brushPreset.toastNoPreset', '请先在列表里选择一个预设'));
      return false;
    }
    const sel = D.getSelected();
    let fig = (sel && sel.type === 'figure') ? sel : null;
    if (!fig) fig = D.getObjects().find(o => o && o.type === 'figure') || null;

    const ink = {
      id: D.nextUid(),
      type: 'ink',
      name: preset.name || D.generateName('ink'),
      x: 0, y: 0,
      w: preset.w || 1, h: preset.h || 1,
      scale: preset.scale || 1,
      rot: preset.relRot || 0,
      alpha: preset.alpha == null ? 1 : preset.alpha,
      layer: preset.layer == null ? 10 : preset.layer,
      locked: false, mirror: false, ax: 0, ay: 0,
      bindTo: 'none', targetId: null, offX: 0, offY: 0,
      strokes: cloneJSON(preset.strokes || []),
      eraser: cloneJSON(preset.eraser || [])
    };

    const canBind = !!(fig && preset.bindTo && preset.bindTo !== 'none');
    if (canBind) {
      ink.bindTo = preset.bindTo;
      ink.targetId = fig.id;
      ink.offX = preset.offX || 0;
      ink.offY = preset.offY || 0;
      const base = D.getBindBase({ bindTo: ink.bindTo, targetId: fig.id, type: 'ink' });
      if (base) {
        const g = base.scale || 1;
        const ox = ink.offX * g, oy = ink.offY * g;
        ink.x = base.x + Math.cos(base.angle) * ox - Math.sin(base.angle) * oy;
        ink.y = base.y + Math.sin(base.angle) * ox + Math.cos(base.angle) * oy;
        /* 抵消新挂载点的角度，保持"画的时候"的方向 */
        ink.rot = -(base.angle * 180 / Math.PI) + (preset.relRot || 0);
      } else {
        ink.x = fig.x; ink.y = fig.y;
      }
    } else {
      /* 无火柴人：放在当前视图中心 */
      const c = D.screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      ink.x = c.x; ink.y = c.y;
      if (fig) D.showToast(tr('brushPreset.noFigure', '当前画布没有火柴人，预设将按未绑定方式放置'));
    }

    D.addObjectToFrames(ink);
    D.select(ink);
    D.markCurrentFrameModified();
    D.invalidateAllFrameThumbs();
    D.refreshUI();
    D.EventBus.emit('need:render');
    D.EventBus.emit('history:save', '应用画笔预设');
    D.showToast(tr('brushPreset.toastApplied', '已应用预设：') + (preset.name || ''));
    return true;
  }

  function deletePresetById(id) {
    const i = presets.findIndex(p => p.id === id);
    if (i < 0) return false;
    presets.splice(i, 1);
    savePresets();
    refreshPresetOptions();
    D.showToast(tr('brushPreset.toastDeleted', '预设已删除'));
    return true;
  }

  function bindPresetUI() {
    const $ = (id) => document.getElementById(id);
    const btnSave = $('btnInkPresetSave');
    const btnApply = $('btnInkPresetApply');
    const btnDel = $('btnInkPresetDelete');
    const selEl = $('inkPresetSelect');
    if (btnSave) btnSave.addEventListener('click', () => savePresetFromSelection());
    if (btnApply) btnApply.addEventListener('click', () => {
      const id = selEl ? selEl.value : '';
      const p = presets.find(x => x.id === id);
      applyPreset(p);
    });
    if (btnDel) btnDel.addEventListener('click', () => {
      const id = selEl ? selEl.value : '';
      const p = presets.find(x => x.id === id);
      if (!p) { D.showToast(tr('brushPreset.toastNoPreset', '请先在列表里选择一个预设')); return; }
      if (!window.confirm(tr('brushPreset.confirmDelete', '确定删除这个画笔预设吗？'))) return;
      deletePresetById(id);
    });
  }

  /* ==================== 对外 API ==================== */
  function getEditingInk() { return editingInk; }

  return {
    init,
    boot,
    setOn,
    isOn,
    openNew,
    openEdit,
    finalize,
    cancel,
    autoBind,
    getEditingInk,
    undoLast,
    clearAll,
    /* 预设 */
    getPresets: () => presets.map(p => ({ id: p.id, name: p.name, bindTo: p.bindTo, offX: p.offX, offY: p.offY })),
    savePreset: () => savePresetFromSelection(),
    applyPresetById: (id) => applyPreset(presets.find(p => p.id === id)),
    deletePresetById
  };
})();
