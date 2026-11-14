
(function () {
  'use strict';

  /* ==================== 图标助手（v7.1.0） ====================
     界面上的 emoji 全部换成 IconPark 矢量图标（js/skfe-icons.js）。
     统一走 ic(name)：拿到一段 <svg>，颜色跟随文字，深色/浅色主题都不用改。 */
  function ic(name) { return typeof SKFEIcon === 'function' ? SKFEIcon(name) : ''; }

  /* ==================== 取词助手（v7.2.2） ====================
     tr2(键, 中文原文)：语言包里有这个键就用译文，没有（或还没加载）就退回中文原文。
     trv(键, 变量, 原文)：同上，额外支持 {name} 占位符插值（帧号、数量这类带数字的句子）。
     动态生成的按钮文字必须走它们 —— 直接写死中文的话，切到英文也永远是中文。 */
  function tr2(key, fallback) {
    if (typeof window.t !== 'function') return fallback;
    const v = window.t(key);
    return (v == null || v === key) ? fallback : v;
  }

  function trv(key, vars, fallback) {
    if (typeof window.t !== 'function') return fallback;
    const v = window.t(key, vars);
    return (v == null || v === key) ? fallback : v;
  }

  /* ==================== 外部模块解构（SKFE.core） ==================== */
  const { P, TAU, displayY, TRACK_ALL_ID } = SKFE.core.constants;

  /* v6.1.0：画布视角缩放范围（原来的 0.2~5 太窄，滚轮/双指稍微一拉就到头）。
     下限放小到 2%，上限放到 80 倍，基本等于不限制。 */
  const VIEW_SCALE_MIN = 0.02;
  const VIEW_SCALE_MAX = 80;
  const { EventBus } = SKFE.core.eventBus;
  const { darkenColor, hexToRgb, rgbToHex, lerpColor, themeHexToRgba, themeMixHex } = SKFE.core.colorUtils;
  const { along, norm, distToSeg, worldToFigureLocal } = SKFE.core.geometry;
  /* v7.0.0：关键帧数据层（槽位身份 / 段 / 单对象插值） */
  const KF = SKFE.systems.keyframes;

  /* ==================== 全局状态（AppState） ==================== */
  const AppState = {
    /* 主帧元信息：只保存 id / duration / isTween（时长与顺序），不再保存 objects */
    frames: [{ id: 1, duration: 83, isTween: false }],
    /* 每元件独立轨道：{ 'obj_1': { name, frames: [ objData | null, ... ] } } */
    tracks: {},
    objects: [],
    selected: null,
    viewOffset: { x: 0, y: 0 },
    viewScale: 1,
    currentFrameIndex: 0,
    activeTrackId: 'all',
    canvasBounds: { x: -400, y: -400, w: 800, h: 800, rotation: 0 },
    canvasBoundsEnabled: false,
    canvasSelected: false
  };

  /* ==================== EventBus（事件总线） ==================== */

  /* ==================== 基础环境 ==================== */
  const canvas = document.getElementById('c');
  let ctx = canvas.getContext('2d');
  const layerListEl = document.getElementById('layerList');
  const targetFigureSelect = document.getElementById('targetFigure');
  const uiPanel = document.getElementById('ui');
  const exportHDCheckbox = document.getElementById('exportHD');
  const btnToggleLock = document.getElementById('btnToggleLock');
  const timelineEl = document.getElementById('timeline');

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

  let isPanning = false;
  let panStart = { x: 0, y: 0 };
  let cameraPreviewVisible = false; // 移到这里，防止初始化报错

  /* ==================== 吸附相关 ==================== */
  let snapEnabled = localStorage.getItem('skfe_snap_enabled') !== '0';
  let snapLines = { x: null, y: null }; // 存储紫色辅助线的世界坐标


  let pageBgColor = '#f4f6f9';
  let pageBgAlpha = 1;
  let gridEnabled = true;
  let gridSize = 32;

  let drag = null;
  let uid = 0;
  let currentColor = '#111111';
  let currentLW = 10.5;

  /* v7.2.1：地面阴影不再是工程级全局量，已搬到每个火柴人的 shadow* 字段上 */
  let shadowEditMode = false;

  let groundLineEnabled = false;
  let groundLineY = 400;
  let groundLineEditMode = false;
  let draggingGroundLine = false;

  let canvasBoundsEditMode = false;
  let draggingCanvasBounds = false;
  let canvasDragStart = { x: 0, y: 0, cx: 0, cy: 0 };
  let canvasBaseBounds = null;
  let viewPinned = false;
  let pinnedView = null;

  let canvasMaskEnabled = false;
  let canvasMaskAlpha = 1.0;
  let canvasMaskBgColor = '#2b2b2b'; // 新增
  let canvasMaskGridColor = '#ffffff'; // 新增

  let TIMELINE_H = 0;
  let isPlaying = false;
  let playTimer = null;
  let playState = null;
  let defaultFPS = 12;

  let onionEnabled = true;
  let onionBefore = 1;
  let onionAfter = 1;
  const ONION_ALPHA = 0.28;
  const ONION_COLOR_BEFORE = '#ff7043';
  const ONION_COLOR_AFTER = '#42a5f5';

  let _renderList = null;
  window.__isExporting = false; // 导出时用于局部画布判断

  const counts = { figure: 0, image: 0, acc: 0, shape: 0, bubble: 0, ink: 0 }; // brush-v5.1.0: §6.3.10 追加 ink 计数

  const PRESET_KEY = 'tco_figure_presets_v1';
  let presets = [];

  const ACTION_PRESET_KEY = 'tco_action_presets_v1';
  let actionPresets = [];
  let selectedActionIndex = -1;

  let hideJointsEnabled = false;
  let jointSize = 7;
  let jointColorDiff = false;

  let multiSelectMode = false;
  let multiSelectedFrames = new Set();
  let frameThumbMode = true;
  let thumbVersion = 0;
  /* 子轨道缩略图缓存：key = trackId + '|' + frameIndex */
  const trackThumbCache = new Map();

  /* 多轨道：'all' = 全局主时间轴；其它值 = 元件 id 的子轨道 */
  let otherTracksVisibility = 'show';
  let subTrackOptionSignature = '';

  /* ==================== v4.7.0 变换框系统状态 ==================== */
  let transformBoxOn = false;
  let freeStretchOn = false;
  /* v5.5.2：四角扭曲的「编辑模式」—— 只控制 8 个控制点显不显示，与变换框同一套逻辑。
     变形本身是否生效看 obj.distort.enabled，由「关闭扭曲」按钮控制。 */
  let distortEditOn = false;
  try { transformBoxOn = localStorage.getItem('skfe_transform_box_v1') === '1'; } catch (_) {}
  try { freeStretchOn = localStorage.getItem('skfe_free_stretch_v1') === '1'; } catch (_) {}
  /* 画布边界的虚拟选中目标（与普通对象区分） */
  const CANVAS_BOUNDS_TARGET = { type: 'canvasBounds', name: '画布边界' };
  /* 变换框拖拽状态 */
  let tboxDrag = null;

  /* 锚点模式状态 */
  let anchorModeOn = false;
  let jointStretchOn = false; // 关节拉伸模式状态
  let isolatedJointName = null; // 当前被隔离/单独显示的关节名称


  /* ==================== 全局属性修改 ==================== */
  /* v6.1.0：默认关闭。以前默认开启，新建元件时会自动把属性铺满所有帧，
     用户改一帧却动了全部，很容易误操作，所以改成默认关、需要时再开。 */
  let globalEditEnabled = false;

  /* ==================== 导出时画布优先 ==================== */
  let exportCanvasFirst = false;
  try { exportCanvasFirst = localStorage.getItem('skfe_export_canvas_first_v1') === '1'; } catch (_) {}

  /* 仅导出路径调用；不影响预览、缩略图、编辑 */
  function shouldSkipCameraForExport() {
    return exportCanvasFirst && AppState.canvasBoundsEnabled;
  }

  function setGlobalProp(fig, path, value) {
    if (!globalEditEnabled) return;
    const set = (obj, p, v) => {
      const keys = p.split('.');
      let cur = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (cur[keys[i]] === undefined || cur[keys[i]] === null) cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = v;
    };
    const targetId = String(fig.id);
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      for (let i = 0; i < t.frames.length; i++) {
        const data = t.frames[i];
        if (data && String(data.id) === targetId) {
          // 如果开启了多选模式，且当前帧不在多选列表中，则跳过
          if (multiSelectMode && !multiSelectedFrames.has(i)) continue;
          set(data, path, value);
        }
      }
    }
    if (AppState.selected && String(AppState.selected.id) === targetId) set(AppState.selected, path, value);
    /* v7.4.7：关键帧写过了，段内派生帧就得按新值重算 —— 不清缓存的话
       「全局改了颜色/比例，关键帧之间那几帧还是旧样子」。 */
    bumpKfEval();
  }

/* 判断对象是否处于"已绑定"状态（配饰/图形/对话框/画笔） */
function isBoundObj(o) {
  return !!(o && (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink')
    && o.bindTo !== 'none' && o.targetId);
}

/* 绑定对象专用的全局覆盖
   global-v5.1.1: 不再要求"帧数据也必须处于绑定态"——同一元件的所有帧统一写入，
   否则某些帧（例如建帧时全局属性是关的、或绑定只在当前帧生效）会被跳过，
   表现就是"开了全局属性修改，总有一帧位置/大小不对"。 */
const BOUND_PLACEMENT_PATHS = { offX: 1, offY: 1, bindTo: 1, targetId: 1, rot: 1, scale: 1, x: 1, y: 1, ax: 1, ay: 1, mirror: 1 };
function setGlobalPropForBound(obj, path, value) {
  if (!globalEditEnabled) return;
  if (!obj) return;
  const targetId = String(obj.id);
  const set = (o, p, v) => {
    const keys = p.split('.');
    let cur = o;
    for (let i = 0; i < keys.length - 1; i++) {
      if (cur[keys[i]] === undefined || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = v;
  };
  for (const id in AppState.tracks) {
    const t = AppState.tracks[id];
    if (!t || !t.frames) continue;
    for (const data of t.frames) {
      if (data && String(data.id) === targetId) set(data, path, value);
    }
  }
  if (AppState.selected && String(AppState.selected.id) === targetId) {
    set(AppState.selected, path, value);
  }
  /* 位置类属性同步后，把"当前世界位置"写进各帧的 x/y 作为兜底缓存：
     若某帧缺少目标火柴人（getBindTransform 会退回 x/y），也能停在同一处而不是旧出生点。 */
  if (isBoundObj(obj) && BOUND_PLACEMENT_PATHS[path]) {
    const tr = getBindTransform(obj);
    if (tr) {
      for (const id in AppState.tracks) {
        const t = AppState.tracks[id];
        if (!t || !t.frames) continue;
        for (const data of t.frames) {
          if (data && String(data.id) === targetId) { data.x = tr.x; data.y = tr.y; }
        }
      }
      if (AppState.selected && String(AppState.selected.id) === targetId) {
        AppState.selected.x = tr.x;
        AppState.selected.y = tr.y;
      }
    }
  }
  /* v7.4.7：绑定件的全局改动同样要让段内派生帧重算 */
  bumpKfEval();
}

/* v5.3.0 全局属性：四角扭曲也要跨帧同步。
   注意必须【深拷贝】corners —— setGlobalProp 是按引用赋值，直接传数组会让所有帧
   共用一个 corners，在某一帧拖一个角点，其它帧会同时被改掉并留下脏数据。 */
function cloneDistortField(src) {
  if (!src) return src;
  const out = {
    enabled: !!src.enabled,
    corners: Array.isArray(src.corners) ? src.corners.map(c => ({ x: c.x, y: c.y })) : null,
    baseW: src.baseW || 0,
    baseH: src.baseH || 0
  };
  /* v5.6.1：冻结的变形框架必须一起带走，否则换帧后框架丢失 → 骨盆又开始漂 */
  if (src.frame0) {
    out.frame0 = {
      w: src.frame0.w || 0, h: src.frame0.h || 0,
      dx: src.frame0.dx || 0, dy: src.frame0.dy || 0,
      scale0: src.frame0.scale0 || 1
    };
  }
  return out;
}

function syncDistortToAllFrames(obj) {
  if (!globalEditEnabled) return;
  if (!obj || !obj.distort) return;
  const targetId = String(obj.id);
  const snap = cloneDistortField(obj.distort);
  for (const id in AppState.tracks) {
    const t = AppState.tracks[id];
    if (!t || !t.frames) continue;
    for (let i = 0; i < t.frames.length; i++) {
      const data = t.frames[i];
      if (!data || String(data.id) !== targetId) continue;
      if (data === obj) continue;
      if (multiSelectMode && !multiSelectedFrames.has(i)) continue;
      data.distort = cloneDistortField(snap);
    }
  }
  /* 当前帧对象若与帧数据不是同一个实例，也补写一次（保持一致） */
  if (AppState.selected && String(AppState.selected.id) === targetId) {
    AppState.selected.distort = cloneDistortField(snap);
  }
}

  /* D12：主轨已经有段时新增元件 —— 在这一段的两端补锚点，用当前帧的姿势填充。
     两端姿势相同，所以段内每一帧插出来都是同一个姿势（整段静止）。
     来源记 'main'：它确实是主轨带出来的，主轨取消关键帧时会跟着回收（D9）；
     但用户在子轨改过姿势也好、重新打过锚点也好，来源不变 → 仍然被回收（用例 19）。
     返回补了几个锚点，0 表示当前帧不在任何段内（保持旧行为：只有这一帧有这个元件）。 */
  function inheritMainKeyframesForNewTrack(trackId, obj) {
    /* 画笔笔画和参考视频天生是「这一帧的」东西，整段复制会糊成一片，不参与继承 */
    if (!obj || obj.type === 'ink' || obj.type === 'video' || obj.type === 'camera') return 0;
    const cur = AppState.currentFrameIndex;
    const keys = new Set();
    for (const id in AppState.tracks) {
      if (String(id) === String(trackId)) continue;
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      for (let i = 0; i < t.frames.length; i++) if (KF.isKey(t.frames[i])) keys.add(i);
    }
    if (keys.size < 2) return 0;
    const sorted = Array.from(keys).sort((a, b) => a - b);
    let lo = null, hi = null;
    for (const k of sorted) if (k <= cur) lo = k;
    for (const k of sorted) if (k >= cur) { hi = k; break; }
    if (lo === null || hi === null || lo === hi) return 0;

    const t = AppState.tracks[String(trackId)];
    if (!t || !t.frames) return 0;
    while (t.frames.length <= hi) t.frames.push(null);
    let n = 0;
    for (const k of [lo, hi]) {
      if (KF.isReal(t.frames[k])) continue;
      const clone = cloneObjectKeepImg(obj);
      clone.id = obj.id;
      t.frames[k] = clone;
      KF.markKey(clone, 'main');
      n++;
    }
    return n;
  }

  function addObjectToFrames(obj) {
    if (!obj || obj.type === 'video') return;
    const id = String(obj.id);
    const total = Math.max(1, AppState.frames.length);
    const arr = new Array(total).fill(null);
    arr[AppState.currentFrameIndex] = obj;
    AppState.tracks[id] = { name: obj.name || (obj.type + id), frames: arr };
    if (isSubTrackMode()) {
      /* 新建元件后自动切到它自己的子轨道，避免对象落在别人的轨道之外 */
      AppState.activeTrackId = id;
      refreshSubTrackOptions();
    } else if (globalEditEnabled && total > 1) {
      for (let i = 0; i < total; i++) {
        if (i === AppState.currentFrameIndex) continue;
        const clone = cloneObjectKeepImg(obj);
        clone.id = obj.id;
        AppState.tracks[id].frames[i] = clone;
      }
    } else if (inheritMainKeyframesForNewTrack(id, obj) > 0) {
      /* D12：段内新增元件 → 继承主轨关键帧，段两端补锚点（当前帧姿势），整段静止 */
      reconcileAllTracks();
    }
    syncMainLengthFromTracks();
    AppState.objects.length = 0;
    for (const o of getCombinedObjectsForRender()) AppState.objects.push(o);
  }

  /* ==================== 全屏 ==================== */
  const btnFullscreen = document.getElementById('btnFullscreen');

  async function toggleFullscreen() {
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFull) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
    } else {
      const elem = document.documentElement;
      try {
        if (elem.requestFullscreen) await elem.requestFullscreen();
        else if (elem.webkitRequestFullscreen) await elem.webkitRequestFullscreen();
        else alert(tr2('fullscreen.unsupported', '当前浏览器不支持网页全屏。\niPhone Safari 建议使用分享菜单「添加到主屏幕」。'));
      } catch (e) {
        alert(tr2('fullscreen.fail', '进入全屏失败。'));
      }
    }
  }
  btnFullscreen.addEventListener('click', toggleFullscreen);
  const updateFullscreenBtn = () => {
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    btnFullscreen.textContent = isFull ? tr2('fullscreen.exit', '退出全屏') : tr2('fullscreen.enter', '全屏');
  };
  document.addEventListener('fullscreenchange', updateFullscreenBtn);
  document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);

  /* ==================== 历史记录 ==================== */
  let undoStack = [];
  let redoStack = [];
  const MAX_HISTORY = 30;
  let isUndoRedoAction = false;

  let historyToastEl = null;
  let historyToastTimer = null;

  function showHistoryToast(msg, type, ms) {
    if (!historyToastEl) {
      historyToastEl = document.createElement('div');
      historyToastEl.className = 'ui-toast history-toast';
      document.body.appendChild(historyToastEl);
    }
    historyToastEl.textContent = msg;
    historyToastEl.classList.toggle('toast-redo', type === 'redo');
    historyToastEl.style.opacity = '1';
    historyToastEl.style.transform = 'translate(-50%, 0)';
    clearTimeout(historyToastTimer);
    historyToastTimer = setTimeout(() => {
      historyToastEl.style.opacity = '0';
      historyToastEl.style.transform = 'translate(-50%, -8px)';
    }, ms || 1700);
  }

  function getSnapshot() {
    return {
      frames: AppState.frames.map(frame => ({ id: frame.id, duration: frame.duration, isTween: !!frame.isTween })),
      tracks: cloneTracksMap(AppState.tracks),
      currentFrameIndex: AppState.currentFrameIndex,
      // === 新增：记录画布相关状态 ===
      canvasBounds: JSON.parse(JSON.stringify(AppState.canvasBounds)),
      canvasBoundsEnabled: AppState.canvasBoundsEnabled,
      canvasMaskEnabled,
      canvasMaskAlpha,
      canvasMaskBgColor,
      canvasMaskGridColor,
      canvasBaseBounds: canvasBaseBounds ? JSON.parse(JSON.stringify(canvasBaseBounds)) : null
    };
  }

  function restoreSnapshot(snapshot) {
    const prevSelectedId = AppState.selected ? String(AppState.selected.id) : null;
    if (Array.isArray(snapshot)) {
      /* 兼容旧版（v1，frames[i].objects）历史快照 */
      const migrated = migrateLegacyFrames(snapshot);
      AppState.frames = migrated.frames;
      AppState.tracks = migrated.tracks;
    } else if (snapshot && Array.isArray(snapshot.frames) && snapshot.tracks) {
      AppState.frames = snapshot.frames.map(frame => ({ id: frame.id, duration: frame.duration, isTween: !!frame.isTween }));
      AppState.tracks = cloneTracksMap(snapshot.tracks);
    } else {
      return;
    }
    reconcileAllTracks({ adoptPlain: false });
    syncMainLengthFromTracks();
    if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = AppState.frames.length - 1;
    if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
    AppState.objects = getCombinedObjectsForRender();
    
    // === 新增：恢复画布相关状态 ===
    if (snapshot.canvasBounds) AppState.canvasBounds = JSON.parse(JSON.stringify(snapshot.canvasBounds));
    if (snapshot.canvasBoundsEnabled !== undefined) AppState.canvasBoundsEnabled = snapshot.canvasBoundsEnabled;
    if (snapshot.canvasMaskEnabled !== undefined) canvasMaskEnabled = snapshot.canvasMaskEnabled;
    if (snapshot.canvasMaskAlpha !== undefined) canvasMaskAlpha = snapshot.canvasMaskAlpha;
    if (snapshot.canvasMaskBgColor !== undefined) canvasMaskBgColor = snapshot.canvasMaskBgColor;
    if (snapshot.canvasMaskGridColor !== undefined) canvasMaskGridColor = snapshot.canvasMaskGridColor;
    if (snapshot.canvasBaseBounds !== undefined) {
      canvasBaseBounds = snapshot.canvasBaseBounds ? JSON.parse(JSON.stringify(snapshot.canvasBaseBounds)) : null;
    }
    // 同步刷新 UI
    syncCanvasUI();
    syncCanvasMaskUI();
    /* 恢复选中：优先按 id 找回来；找不到再退回原逻辑 */
    if (isSubTrackMode()) {
      AppState.selected = getActiveTrackObject();
    } else if (prevSelectedId) {
      AppState.selected = AppState.objects.find(o => o && String(o.id) === prevSelectedId) || null;
    } else {
      AppState.selected = null;
    }
    drag = null; isPanning = false; AppState.canvasSelected = false;
    cancelTransformBoxDrag(); anchorModeOn = false;
    trackThumbCache.clear();
    updateFrameBar();
    EventBus.emit('app:update');
    updateUndoRedoButtons();
  }

  /* v7.0.0（验收 11）：拖滑块 / 连续微调时，同一标签的连续落点合并成一条历史。
     合并时保留最早那次落点的快照，因此撤销一步就能回到拖动之前。 */
  function saveHistory(label, coalesceMs) {
    if (isUndoRedoAction) return;
    if (typeof label !== 'string' || !label) label = '编辑';
    thumbVersion++;
    const now = Date.now();
    const last = undoStack[undoStack.length - 1];
    if (coalesceMs > 0 && last && last.label === label &&
        (now - (last.at || 0)) < coalesceMs && undoStack.length > 1) {
      last.at = now;
      redoStack = [];
      updateUndoRedoButtons();
      SKFE.systems.autosave.scheduleAutoArchiveSave();
      return;
    }
    undoStack.push({ snap: getSnapshot(), label, at: now });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
    SKFE.systems.autosave.scheduleAutoArchiveSave();
  }

  function pushPreSnapshot(snap, label) {
    if (isUndoRedoAction || !snap) return;
    if (typeof label !== 'string' || !label) label = '编辑';
    thumbVersion++;
    undoStack.push({ snap, label });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
    SKFE.systems.autosave.scheduleAutoArchiveSave();
  }

  /* ==================== v7.4.3：事务式历史 ====================
     一次拖拽 = 一次 begin/end：begin 时记一份「操作前」快照，end 时再取一份当前快照，
     两份一模一样就当没改过、不记历史；否则按现有语义压一条「操作后」状态。
     好处：① 拖了半天其实没动 → 不会留下一条空历史（否则撤销会「按了没反应」）
           ② 一次手势里改了多少条轨道/多少帧，都只算一步撤销。 */
  let txPreSnap = null;
  let txLabel = null;
  let txDepth = 0;

  function txBegin(label) {
    txDepth++;
    if (txDepth > 1) return false;
    txPreSnap = getSnapshot();
    txLabel = label || '编辑';
    return true;
  }

  function txEnd() {
    if (txDepth === 0) return false;
    if (txDepth > 1) { txDepth--; return false; }
    txDepth = 0;
    const pre = txPreSnap;
    const label = txLabel;
    txPreSnap = null;
    txLabel = null;
    if (!pre) return false;
    let same = false;
    try { same = JSON.stringify(pre) === JSON.stringify(getSnapshot()); } catch (_) { same = false; }
    if (same) return false;
    pushPreSnapshot(getSnapshot(), label);
    return true;
  }

  /* begin → 改 → end 一把梭，给一次性操作（按钮/快捷键）用 */
  function txRun(label, fn) {
    txBegin(label);
    try { return fn(); } finally { txEnd(); }
  }

  function isTxOpen() { return txDepth > 0; }

  function undo() {
    if (undoStack.length <= 1) return;
    isUndoRedoAction = true;
    const item = undoStack.pop();
    redoStack.push({ snap: item.snap, label: item.label });
    if (redoStack.length > MAX_HISTORY) redoStack.shift();
    const prev = undoStack[undoStack.length - 1];
    restoreSnapshot(prev.snap);
    isUndoRedoAction = false;
    showHistoryToast('已撤销：' + item.label, 'undo');
  }

  function redo() {
    if (redoStack.length === 0) return;
    isUndoRedoAction = true;
    const item = redoStack.pop();
    undoStack.push({ snap: item.snap, label: item.label });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    restoreSnapshot(item.snap);
    isUndoRedoAction = false;
    showHistoryToast('已恢复：' + item.label, 'redo');
  }

  function updateUndoRedoButtons() {
    document.getElementById('btnUndo').disabled = undoStack.length <= 1;
    document.getElementById('btnRedo').disabled = redoStack.length === 0;
  }

  document.getElementById('btnUndo').onclick = undo;
  document.getElementById('btnRedo').onclick = redo;

  /* ==================== 补间帧恢复 ==================== */
  /* v7.4.3：落帧策略（对齐 Alight Motion 的「自动关键帧」三分支）。
     这一帧被改动之后，关键帧该落在哪儿就按这三条来：
       ① 已经是关键帧      → 就地改，绝不再多落一帧（不然每拖一下都长出一颗菱形）
       ② 段内的派生帧      → 升起成关键帧。派生帧不存画面，不升格的话切一帧就被补间
                            重新求值覆盖，用户看到的就是「改了动作却没生成画面」
       ③ 段外的普通帧/空白 → 自动帧常开：只要这条轨**已经**有关键帧，就在这一帧落关键帧；
                            一帧关键帧都没有时按「烘焙帧」处理（写进这一帧本身，不制造关键帧），
                            否则给烘焙工程加一帧关键帧会把前后整片普通帧都吞成派生帧。
     返回 true = 落了新关键帧（调用方要刷新缩略图 / 帧条）。
     allowPlain=false 时只认派生帧（②）—— 给「不是用户正在改的那只元件」用，
     免得拖 A 的动作时顺手把 B 的普通帧也点成关键帧。 */
  /* v7.4.8：撤销 v7.4.7 的「尾巴跟随最后一颗关键帧」（holdTailFromKey / repairHoldTails）。
     关键帧只对「它和下一颗关键帧之间那一段」负责，段外的普通帧是各自独立的烘焙帧 ——
     这是原本就定好的模型，用户实测后确认要保留：改最后一颗关键帧不会改写它后面的帧，
     想要尾巴跟着走，就在尾巴那头再打一颗关键帧。 */
  function landAutoKey(tid, idx, allowPlain) {
    const t = AppState.tracks[tid];
    if (!t || !t.frames) return false;
    const slot = t.frames[idx];
    /* ① 已经是关键帧：用户接着摆这个姿势（比如先拖手臂、再拖腿）。
       这一帧的对象就是关键帧本身，数据已经写进去了，但段内的派生帧还在
       缓存里 —— 不失效的话播放时只有「第一次改动的那条肢体」在动，
       后面改的肢体要等到这一帧才突然跳过去。 */
    if (KF.isKey(slot)) { bumpKfEval(); return false; }
    const live = AppState.objects.find(o => o && o.type !== 'video' && String(o.id) === tid) || null;
    if (KF.isDerived(slot)) {                              /* ② */
      if (!live) return false;
      if (!poseChanged(tid, idx, live)) return false;      /* 没被改过：别平白加一颗菱形 */
      t.frames[idx] = live;
      KF.markKey(live, 'sub');
    } else {
      /* ③ 普通帧 / 空白帧 */
      if (allowPlain === false) return false;
      if (!t.frames.some(k => KF.isKey(k))) return false;  /* 整轨没关键帧：保持烘焙语义 */
      let base = live;
      if (!base && KF.isReal(slot)) base = slot;           /* 这一帧本来有画面，用它自己 */
      if (!base) base = nearestPose(tid, idx);             /* 空白帧：借最近的姿势补一张 */
      if (!base) return false;
      while (t.frames.length <= idx) t.frames.push(null);
      t.frames[idx] = base;
      KF.markKey(base, 'sub');
      base.hidden = false;
      /* 空白帧补出来的对象不在 AppState.objects 里，重取一遍，否则下一次
         goToFrame→syncFrameRef 会把这一帧当成「本帧不该有它」又抹成空白。 */
      if (base !== live) refreshObjectsNow();
    }
    /* ★ v7.4.4 关键一步：新关键帧一落，就把它和前后关键帧之间的普通帧交给补间接管。
       少了这步会看到「关键帧生成了，但中间几帧一动不动，到那一帧才突然跳过去」——
       因为段内每一帧还各自留着自己那张画，补间永远没机会上场。
       （轨道视图一直有 reconcile，所以只有从画布上改动作时才会踩到。） */
    KF.reconcileTrack(t);
    bumpKfEval();
    return true;
  }

  /* 「这一帧的在场对象」和「按轨道重新求值的结果」一样吗？
     派生帧每次求值都是现算的：没被拖动过就一定相等，被改过就一定有差异 ——
     靠它判断用户到底动的是哪只元件。比较前剥掉 img（拖动不会改它，还是几 MB 的 base64）。
     ⚠️ 不能直接 getTrackFrame：它返回的就是缓存里那个对象，也正是被拖动的那个，
        比出来永远相等。所以这里临时把该帧的缓存摘掉重算一次（拿到真正由关键帧
        算出来的克隆），算完再把原对象放回去 —— AppState.objects 的身份不能变。 */
  function evalDerivedFresh(tid, idx) {
    const key = tid + '|' + idx + '|' + kfEvalEpoch;
    const had = kfEvalCache.has(key);
    const bak = kfEvalCache.get(key);
    kfEvalCache.delete(key);
    let fresh = null;
    try { fresh = evaluateDerived(tid, idx); } catch (_) { fresh = null; }
    kfEvalCache.delete(key);
    if (had && bak) kfEvalCache.set(key, bak);
    return fresh;
  }

  function poseSignature(o) {
    if (!o) return '';
    try {
      return JSON.stringify(o, (k, v) => {
        if (k === 'img') return undefined;
        if (typeof v === 'number') return Math.round(v * 100) / 100;
        return v;
      });
    } catch (_) { return ''; }
  }
  function poseChanged(tid, idx, live) {
    if (!live) return false;
    const fresh = evalDerivedFresh(tid, idx);
    if (!fresh) return true;
    return poseSignature(fresh) !== poseSignature(live);
  }

  /* 最近的可用姿势（先往前找，找不到再往后），已经剥掉帧身份 */
  function nearestPose(tid, idx) {
    const t = AppState.tracks[tid];
    if (!t || !t.frames) return null;
    const grab = (i) => {
      const o = getTrackFrame(tid, i);
      if (!o) return null;
      const c = cloneObjectKeepImg(o);
      KF.clearKey(c);
      c.hidden = false;
      return c;
    };
    for (let i = idx - 1; i >= 0; i--) { const o = grab(i); if (o) return o; }
    for (let i = idx + 1; i < t.frames.length; i++) { const o = grab(i); if (o) return o; }
    return null;
  }

  /* 按轨道重取当前帧的渲染对象，并按 id 重指选中项（轨道模块也调这个） */
  function refreshObjectsNow() {
    const keepId = AppState.selected ? String(AppState.selected.id) : null;
    AppState.objects.length = 0;
    for (const o of getCombinedObjectsForRender()) AppState.objects.push(o);
    if (keepId) AppState.selected = AppState.objects.find(o => o && String(o.id) === keepId) || null;
  }

  function markCurrentFrameModified() {
    if (AppState.frames[AppState.currentFrameIndex] && AppState.frames[AppState.currentFrameIndex].isTween) {
      AppState.frames[AppState.currentFrameIndex].isTween = false;
      updateFrameBar();
    }
    /* v7.4.3：自动关键帧常开 —— 当前帧「在场」的元件全部过一遍，不只是被选中的那只。
       拖关节时未必先选中对象，只认 selected 会漏掉真正被改的那只，
       结果就是「动作改了，关键帧没生成」。
       但「不是选中的那只」只允许升派生帧（②）：普通帧那一条要写新数据，
       对没被改过的元件做就等于平白撒一把关键帧。 */
    const idxNow = AppState.currentFrameIndex;
    const seen = Object.create(null);
    let promoted = 0;
    const consider = (oid, isPrimary) => {
      if (oid == null) return;
      const k = String(oid);
      if (seen[k] && !isPrimary) return;
      seen[k] = 1;
      if (landAutoKey(k, idxNow, !!isPrimary)) promoted++;
    };
    for (const o of AppState.objects) { if (o && o.type !== 'video') consider(o.id, false); }
    if (AppState.selected) consider(AppState.selected.id, true);
    if (isSubTrackMode()) consider(AppState.activeTrackId, true);
    if (promoted) {
      invalidateAllFrameThumbs();
      updateFrameBar();
      showHistoryToast('已自动生成关键帧（⌘Z 可撤销）', 'ink', 1800);
    }
    /* v7.4.5：不管有没有新落菱形，这一帧的姿势都变了 —— 段内派生帧必须重算，
       否则「接着改第二个肢体」时中间帧还是上一轮算出来的值（只动第一个肢体）。 */
    bumpKfEval();
    if (AppState.frames[AppState.currentFrameIndex]) delete AppState.frames[AppState.currentFrameIndex]._thumb;
    if (isSubTrackMode()) trackThumbCache.delete(AppState.activeTrackId + '|' + AppState.currentFrameIndex);
    SKFE.systems.autosave.scheduleAutoArchiveSave();
  }

  /* ==================== 项目文件导出与导入 ==================== */
  const PROJECT_SAVE_KEY = 'skfe_project_v1';
  /* v7.0.0：工程格式版本。
     3 = 关键帧模型（槽位带 __k / __d 标记）；2 = 每元件轨道的烘焙帧；
     1 = frames[i].objects 共享模型。
     minVersion 是「打开本文件至少需要的版本」——v7 的工程里派生帧不存画面，
     旧版打开会看到空白帧，所以必须声明。 */
  const PROJECT_VERSION = 3;
  const PROJECT_MIN_VERSION = 3;

  function cloneObjectForSave(o) {
    const copy = JSON.parse(JSON.stringify(o, (k, v) => (k === 'img' ? undefined : v)));
    if (o.img && o.img.src) copy.imgSrc = o.img.src;
    return copy;
  }

  function serializeFrames() {
    return AppState.frames.map(frame => ({
      id: frame.id,
      duration: frame.duration,
      isTween: !!frame.isTween
    }));
  }

  function serializeTracks() {
    const out = {};
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t) continue;
      out[id] = {
        name: t.name || id,
        frames: (t.frames || []).map(d => d ? cloneObjectForSave(d) : null)
      };
    }
    return out;
  }

  /* 保证主时间轴长度等于最长轨道长度（缺失的尾部用 null 补齐最长轨道） */
  function alignMainMetaWithTracks(frameArr, trackMap) {
    let longestId = null, maxLen = 0;
    for (const id in trackMap) {
      const arr = trackMap[id] && trackMap[id].frames;
      if (arr && arr.length > maxLen) { maxLen = arr.length; longestId = id; }
    }
    if (!longestId) {
      if (frameArr.length > 1) frameArr.length = 1;
      return;
    }
    if (maxLen < frameArr.length) {
      const arr = trackMap[longestId].frames;
      while (arr.length < frameArr.length) arr.push(null);
    }
  }

  /* v1（frames[i].objects 共享模型）→ v2（每元件独立 tracks） */
  function migrateLegacyFrames(frameArr) {
    const newTracks = {};
    const newFrames = [];
    (frameArr || []).forEach((frame, i) => {
      newFrames.push({
        id: frame.id,
        duration: frame.duration || Math.round(1000 / (defaultFPS || 12)),
        isTween: !!frame.isTween
      });
      (frame.objects || []).forEach(o => {
        if (!o || o.type === 'video') return;
        const id = String(o.id);
        if (!newTracks[id]) newTracks[id] = { name: o.name || (o.type + id), frames: [] };
        while (newTracks[id].frames.length <= i) newTracks[id].frames.push(null);
        newTracks[id].frames[i] = o;
      });
    });
    if (!newFrames.length) newFrames.push({ id: 1, duration: Math.round(1000 / (defaultFPS || 12)), isTween: false });
    alignMainMetaWithTracks(newFrames, newTracks);
    return { frames: newFrames, tracks: newTracks };
  }

  function restoreTrackObjectImages(objList, promises) {
    (objList || []).forEach(o => {
      if (!o) return;
      if (KF.isDerived(o)) return;   /* v7.0.0：派生帧哨兵不是真对象，别往上挂字段 */
      if (o.imgSrc) {
        promises.push(new Promise((resolve) => {
          const img = new Image();
          img.onload = () => { o.img = img; resolve(); };
          img.onerror = () => resolve();
          img.src = o.imgSrc;
        }));
        delete o.imgSrc;
      }
      if (typeof o.id === 'number') uid = Math.max(uid, o.id);
      if (o.ax === undefined) o.ax = 0;
      if (o.ay === undefined) o.ay = 0;
    });
  }

  function deserializeProject(data) {
    const promises = [];
    let newFrames = [];
    let newTracks = {};
    if (data && data.tracks && typeof data.tracks === 'object') {
      /* v2 */
      newFrames = (data.frames || []).map(frame => ({
        id: frame.id,
        duration: frame.duration || Math.round(1000 / (defaultFPS || 12)),
        isTween: !!frame.isTween
      }));
      for (const id in data.tracks) {
        const t = data.tracks[id] || {};
        /* v6.1.0：老项目文件里可能混进了参考视频的轨道（video 不该进轨道），读入时直接丢弃 */
        const arr = (t.frames || []).map(d => (!d || d.type === 'video') ? null : d);
        newTracks[id] = { name: t.name || id, frames: arr };
        restoreTrackObjectImages(arr, promises);
      }
    } else {
      /* v1 迁移 */
      const migrated = migrateLegacyFrames((data && data.frames) || []);
      newFrames = migrated.frames;
      newTracks = migrated.tracks;
      for (const id in newTracks) restoreTrackObjectImages(newTracks[id].frames, promises);
    }
    if (!newFrames.length) newFrames = [{ id: 1, duration: Math.round(1000 / (defaultFPS || 12)), isTween: false }];
    alignMainMetaWithTracks(newFrames, newTracks);
    return { newFrames, newTracks, promises };
  }

  function exportProjectJSON() {
    const projectData = {
      version: PROJECT_VERSION,
      minVersion: PROJECT_MIN_VERSION,
      frames: serializeFrames(),
      tracks: serializeTracks(),
      currentFrameIndex: AppState.currentFrameIndex, defaultFPS,
      groundLineEnabled, groundLineY,
      onionEnabled, onionBefore, onionAfter,
      canvasBounds: AppState.canvasBounds, canvasBoundsEnabled: AppState.canvasBoundsEnabled,
      pageBgColor, gridEnabled, gridSize,
      canvasMaskEnabled, canvasMaskAlpha,
      canvasMaskBgColor, canvasMaskGridColor, // 新增
    };
    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: 'application/json' });
    SKFE.platform.save(blob, 'skfe_project_' + Date.now() + '.json');
  }

  function applyLoadedProject(data) {
    const { newFrames, newTracks, promises } = deserializeProject(data);
    return Promise.all(promises).then(() => {
      AppState.frames = newFrames;
      AppState.tracks = newTracks;
      reconcileAllTracks({ adoptPlain: false });
      /* v7.4.7：清掉一个元件都没有的空轨道 */
      pruneEmptyTracks();
      syncMainLengthFromTracks();
      AppState.currentFrameIndex = data.currentFrameIndex || 0;
      if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = 0;
      if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
      if (AppState.activeTrackId !== TRACK_ALL_ID && !AppState.tracks[AppState.activeTrackId]) AppState.activeTrackId = TRACK_ALL_ID;
      AppState.objects = getCombinedObjectsForRender();
      defaultFPS = data.defaultFPS || 12;
      groundLineEnabled = data.groundLineEnabled || false;
      groundLineY = data.groundLineY !== undefined ? data.groundLineY : 400;
      onionEnabled = data.onionEnabled || false;
      onionBefore = data.onionBefore !== undefined ? data.onionBefore : 1;
      onionAfter = data.onionAfter !== undefined ? data.onionAfter : 1;
      if (onionBefore + onionAfter > 12) {
        if (onionBefore > 12) { onionBefore = 12; onionAfter = 0; }
        else onionAfter = 12 - onionBefore;
      }
      if (data.canvasBounds) AppState.canvasBounds = data.canvasBounds;
      if (!AppState.canvasBounds.rotation) AppState.canvasBounds.rotation = 0;
      AppState.canvasBoundsEnabled = data.canvasBoundsEnabled || false;
      canvasBaseBounds = { ...AppState.canvasBounds };
      if (data.pageBgColor) pageBgColor = data.pageBgColor;
      if (data.gridEnabled !== undefined) gridEnabled = !!data.gridEnabled;
      if (data.gridSize !== undefined) gridSize = data.gridSize;
      if (data.canvasMaskEnabled !== undefined) canvasMaskEnabled = !!data.canvasMaskEnabled;
      if (data.canvasMaskAlpha !== undefined) canvasMaskAlpha = data.canvasMaskAlpha;
      if (data.canvasMaskBgColor !== undefined) canvasMaskBgColor = data.canvasMaskBgColor; // 新增
      if (data.canvasMaskGridColor !== undefined) canvasMaskGridColor = data.canvasMaskGridColor; // 新增
      syncPageAppearanceUI();
      syncCanvasMaskUI();
      syncCanvasUI();
      syncAdvToggles();
      AppState.selected = null;
      AppState.canvasSelected = false;
      trackThumbCache.clear();
      applyFPS(defaultFPS);
      updateFrameBar();
      EventBus.emit('app:update');
    });
  }

  function importProjectJSON(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || !Array.isArray(data.frames)) throw new Error('Invalid project file');
        /* v7.0.0：版本校验。minVersion 高于本版本说明文件里有本版本读不懂的插值数据，
           硬读会把关键帧段读成一堆空白帧，所以宁可拒绝。 */
        const need = Number(data.minVersion || data.version || 1);
        if (need > PROJECT_VERSION) {
          alert(tr2('project.tooNewHead', '这个工程由更新版本的 SKFE 创建（需要 v') + need + tr2('project.tooNewTail', '），当前版本是 v') + PROJECT_VERSION +
            '。\n请升级后再打开，否则动画的关键帧数据会显示不出来。');
          return;
        }
        applyLoadedProject(data).then(() => {
          EventBus.emit('history:save', '导入项目');
          const n = data.version || 1;
          alert(n >= 3 ? tr2('project.importOk', '项目导入成功') : tr2('project.importOkOld', '项目导入成功（旧格式 v') + n + tr2('project.importOkOldTail', '，已按普通帧加载）'));
        });
      } catch (err) {
        alert(tr2('project.importFail', '导入失败: ') + err.message);
      }
    };
    reader.readAsText(file);
  }

  function saveProjectToLocal() {
    try {
      const projectData = {
        version: PROJECT_VERSION,
        minVersion: PROJECT_MIN_VERSION,
        frames: serializeFrames(),
        tracks: serializeTracks(),
        currentFrameIndex: AppState.currentFrameIndex, defaultFPS,
        groundLineEnabled, groundLineY,
        onionEnabled, onionBefore, onionAfter,
        canvasBounds: AppState.canvasBounds, canvasBoundsEnabled: AppState.canvasBoundsEnabled,
        pageBgColor, gridEnabled, gridSize,
        canvasMaskEnabled, canvasMaskAlpha,
        canvasMaskBgColor, canvasMaskGridColor, // 新增
      };
      localStorage.setItem(PROJECT_SAVE_KEY, JSON.stringify(projectData));
      alert(tr2('project.savedLocal', '已保存到本地'));
    } catch (err) {
      alert(tr2('project.saveFail', '保存失败，可能超出了本地存储限制: ') + err.message);
    }
  }

  function loadProjectFromLocal() {
    const raw = localStorage.getItem(PROJECT_SAVE_KEY);
    if (!raw) return alert(tr2('project.noneLocal', '本地没有保存的项目'));
    try {
      const data = JSON.parse(raw);
      applyLoadedProject(data).then(() => {
        EventBus.emit('history:save', '读取本地项目');
        alert(tr2('project.loadOk', '本地项目读取成功'));
      });
    } catch (err) {
      alert(tr2('project.loadFail', '读取失败: ') + err.message);
    }
  }

  document.getElementById('btnExportProject').onclick = exportProjectJSON;
  document.getElementById('btnImportProject').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) importProjectJSON(file);
    };
    input.click();
  };
  document.getElementById('btnSaveProjectLocal').onclick = saveProjectToLocal;
  document.getElementById('btnLoadProjectLocal').onclick = loadProjectFromLocal;

  /* ==================== IndexedDB 自动存档 ==================== */


  function collectAutoArchiveData() {
    return {
      version: 2,
      timestamp: Date.now(),
      frames: serializeFrames(),
      tracks: serializeTracks(),
      currentFrameIndex: AppState.currentFrameIndex, uid, defaultFPS, viewOffset: AppState.viewOffset, viewScale: AppState.viewScale,
      canvasBounds: AppState.canvasBounds, canvasBoundsEnabled: AppState.canvasBoundsEnabled, canvasBaseBounds,
      canvasMaskEnabled, canvasMaskAlpha,
      canvasMaskBgColor, canvasMaskGridColor, // 新增
      groundLineEnabled, groundLineY,
      gridEnabled, gridSize, pageBgColor,
      onionEnabled, onionBefore, onionAfter,
      globalEditEnabled, frameThumbMode, multiSelectMode
    };
  }




  function restoreFromAutoArchive(data) {
    if (!data || !Array.isArray(data.frames)) return false;
    try {
      const { newFrames, newTracks, promises } = deserializeProject(data);
      Promise.all(promises).then(() => {
        AppState.frames = newFrames;
        AppState.tracks = newTracks;
        syncMainLengthFromTracks();
        AppState.currentFrameIndex = data.currentFrameIndex || 0;
        if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = 0;
        if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
        if (AppState.activeTrackId !== TRACK_ALL_ID && !AppState.tracks[AppState.activeTrackId]) AppState.activeTrackId = TRACK_ALL_ID;
        AppState.objects = getCombinedObjectsForRender();
        uid = data.uid || uid;
        defaultFPS = data.defaultFPS || 12;
        if (data.viewOffset) AppState.viewOffset = data.viewOffset;
        if (data.viewScale) AppState.viewScale = data.viewScale;
        if (data.canvasBounds) AppState.canvasBounds = data.canvasBounds;
        if (!AppState.canvasBounds.rotation) AppState.canvasBounds.rotation = 0;
        AppState.canvasBoundsEnabled = !!data.canvasBoundsEnabled;
        if (data.canvasBaseBounds) canvasBaseBounds = data.canvasBaseBounds;
        canvasMaskEnabled = !!data.canvasMaskEnabled;
        if (data.canvasMaskAlpha !== undefined) canvasMaskAlpha = data.canvasMaskAlpha;
        if (data.canvasMaskBgColor !== undefined) canvasMaskBgColor = data.canvasMaskBgColor; // 新增
        if (data.canvasMaskGridColor !== undefined) canvasMaskGridColor = data.canvasMaskGridColor; // 新增
        groundLineEnabled = !!data.groundLineEnabled;
        if (data.groundLineY !== undefined) groundLineY = data.groundLineY;
        if (data.gridEnabled !== undefined) gridEnabled = !!data.gridEnabled;
        if (data.gridSize !== undefined) gridSize = data.gridSize;
        if (data.pageBgColor) pageBgColor = data.pageBgColor;
        onionEnabled = !!data.onionEnabled;
        if (data.onionBefore !== undefined) onionBefore = data.onionBefore;
        if (data.onionAfter !== undefined) onionAfter = data.onionAfter;
        if (onionBefore + onionAfter > 12) {
          if (onionBefore > 12) { onionBefore = 12; onionAfter = 0; }
          else onionAfter = 12 - onionBefore;
        }
        /* v6.1.0：全局属性修改改为默认关闭，所以恢复自动存档时不再沿用旧开关状态，
           避免老存档把它悄悄又打开（用户会觉得“明明关了还是动全部帧”）。 */
        globalEditEnabled = false;
        {
          const geEl = document.getElementById('globalEdit');
          if (geEl) geEl.checked = false;
        }
        if (data.frameThumbMode !== undefined) {
          frameThumbMode = !!data.frameThumbMode;
          const ftEl = document.getElementById('frameThumbMode');
          if (ftEl) ftEl.checked = frameThumbMode;
        }
        if (data.multiSelectMode !== undefined) multiSelectMode = !!data.multiSelectMode;
        AppState.selected = null;
        AppState.canvasSelected = false;
        trackThumbCache.clear();
        applyFPS(defaultFPS);
        updateFrameBar();
        syncGroundLineUI();
        syncPageAppearanceUI();
        syncCanvasMaskUI();
        syncCanvasUI();
        syncAdvToggles();
        EventBus.emit('need:syncUI');
        EventBus.emit('need:render');
        console.log('[AutoArchive] 已自动恢复存档');
      });
      return true;
    } catch (err) {
      return false;
    }
  }


  /* ==================== 自动存档（已迁移至 js/systems/autosave.js） ==================== */
  SKFE.systems.autosave.init({
    collectData: () => collectAutoArchiveData(),        // app.js 里的原函数
    applyData: (data) => restoreFromAutoArchive(data),  // app.js 里的原函数
  });
  SKFE.systems.autosave.boot();

  /* ==================== 参考视频 ==================== */
  let refVideo = null;
  let refVideoVisible = true;
  let refVideoPlaying = false;
  let refVideoUrl = null;
  let refVideoRaf = null;
  let videoCache = {};
  let videoLoadToken = 0;
  let videoObj = null;
  let seekDebounceTimer = null;

  const videoProgressEl = document.getElementById('videoProgress');
  const videoProgressFill = document.getElementById('videoProgressFill');
  const videoProgressPct = document.getElementById('videoProgressPct');

  function showVideoProgress(pct) {
    const p = Math.max(0, Math.min(100, pct || 0));
    videoProgressEl.style.display = 'block';
    videoProgressFill.style.width = p + '%';
    videoProgressPct.textContent = Math.round(p) + '%';
  }
  function hideVideoProgress() {
    videoProgressEl.style.display = 'none';
    videoProgressFill.style.width = '0%';
    videoProgressPct.textContent = '0%';
  }

  function getFrameStartTime(idx) {
    let time = 0;
    for (let i = 0; i < idx; i++) time += AppState.frames[i].duration;
    return time / 1000;
  }

  function captureVideoFrame(idx) {
    if (!refVideo || refVideo.readyState < 2) return;
    const offCanvas = document.createElement('canvas');
    offCanvas.width = refVideo.videoWidth;
    offCanvas.height = refVideo.videoHeight;
    offCanvas.getContext('2d').drawImage(refVideo, 0, 0);
    videoCache[idx] = offCanvas;
  }

  function seekVideoToFrame(idx) {
    if (!refVideo || refVideo.readyState < 1) return;
    if (videoCache[idx]) return;
    if (seekDebounceTimer) clearTimeout(seekDebounceTimer);
    seekDebounceTimer = setTimeout(() => {
      const target = getFrameStartTime(idx);
      const dur = refVideo.duration || 0;
      const time = Math.min(target, Math.max(0, dur - 0.001));
      if (Math.abs(refVideo.currentTime - time) < 0.001) { captureVideoFrame(idx); return; }
      refVideo.currentTime = time;
      const onSeeked = () => {
        refVideo.removeEventListener('seeked', onSeeked);
        captureVideoFrame(idx);
        if (AppState.currentFrameIndex === idx) EventBus.emit('need:render');
      };
      refVideo.addEventListener('seeked', onSeeked);
    }, 30);
  }

  function updateVideoUI() {
    const ctrls = document.getElementById('videoCtrls');
    const btnToggle = document.getElementById('btnToggleVideo');
    const btnPlay = document.getElementById('btnPlayVideo');
    const btnRefTop = document.getElementById('btnRefVideoTop');
    if (!refVideo) { 
      ctrls.style.display = 'none'; 
      if (btnRefTop) btnRefTop.style.display = 'none';
      return; 
    }
    ctrls.style.display = 'inline-flex';
    btnToggle.innerHTML = refVideoVisible ? ic('preview-open') : ic('forbid');
    btnPlay.innerHTML = (refVideoPlaying && refVideo && !refVideo.paused) ? ic('pause') : ic('play');
    if (btnRefTop) btnRefTop.style.display = 'block';
  }

  /* ==================== 参考视频长按置顶 ==================== */
  const btnRefVideoTop = document.getElementById('btnRefVideoTop');
  let refVideoTopHold = null;

  if (btnRefVideoTop) {
    btnRefVideoTop.addEventListener('contextmenu', e => e.preventDefault());

    btnRefVideoTop.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!videoObj || refVideoTopHold) return;

      // 备份原本的透明度和层级
      refVideoTopHold = {
        alpha: videoObj.alpha,
        layer: videoObj.layer
      };

      // 临时设为 100% 不透明并置顶
      videoObj.alpha = 1;
      videoObj.layer = 999999;
      EventBus.emit('need:render');

      // 松手逻辑（绑定到 window 防止手指滑出按钮捕获不到）
      const endHold = () => {
        if (!refVideoTopHold) return;
        videoObj.alpha = refVideoTopHold.alpha;
        videoObj.layer = refVideoTopHold.layer;
        refVideoTopHold = null;
        EventBus.emit('need:render');
        window.removeEventListener('pointerup', endHold);
        window.removeEventListener('pointercancel', endHold);
      };

      window.addEventListener('pointerup', endHold);
      window.addEventListener('pointercancel', endHold);
    });
  }

  function startVideoRaf() {
    if (refVideoRaf) return;
    const tick = () => {
      if (!refVideoPlaying || !refVideo || refVideo.paused) { refVideoRaf = null; return; }
      renderCanvas(false);
      refVideoRaf = requestAnimationFrame(tick);
    };
    refVideoRaf = requestAnimationFrame(tick);
  }

  const videoInput = document.createElement('input');
  videoInput.type = 'file';
  videoInput.accept = 'video/*';
  videoInput.style.display = 'none';
  document.body.appendChild(videoInput);

  document.getElementById('btnImportVideo').onclick = () => videoInput.click();
  videoInput.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    videoInput.value = '';
    if (!file) return;
    const token = ++videoLoadToken;
    if (refVideoTopHold) {
      window.dispatchEvent(new Event('pointerup'));
    }
    if (refVideo) { refVideo.pause(); refVideo = null; }
    if (refVideoUrl) { URL.revokeObjectURL(refVideoUrl); refVideoUrl = null; }
    videoCache = {};
    refVideoPlaying = false;
    if (videoObj) { if (AppState.selected === videoObj) AppState.selected = null; videoObj = null; }
    updateVideoUI();
    showVideoProgress(0);

    const reader = new FileReader();
    reader.onprogress = ev => {
      if (token !== videoLoadToken) return;
      if (ev.lengthComputable) showVideoProgress(ev.loaded / ev.total * 100);
    };
    reader.onerror = () => { if (token !== videoLoadToken) return; hideVideoProgress(); alert(tr2('video.loadFail', '视频加载失败')); };
    reader.onload = () => {
      if (token !== videoLoadToken) return;
      showVideoProgress(100);
      const blob = new Blob([reader.result], { type: file.type || 'video/mp4' });
      refVideoUrl = URL.createObjectURL(blob);
      refVideo = document.createElement('video');
      refVideo.src = refVideoUrl;
      refVideo.muted = true;
      refVideo.playsInline = true;
      refVideo.preload = 'auto';
      refVideo.addEventListener('loadedmetadata', () => {
        if (token !== videoLoadToken) return;
        refVideoVisible = true;
        videoObj = {
          id: 'video-obj', type: 'video', name: '🎥 参考视频',
          x: 0, y: 0, w: refVideo.videoWidth, h: refVideo.videoHeight,
          scale: 1, alpha: 0.55, layer: -9999, locked: false
        };
        updateVideoUI();
        seekVideoToFrame(AppState.currentFrameIndex);
        EventBus.emit('need:render');
        setTimeout(() => { if (token === videoLoadToken) hideVideoProgress(); }, 250);
      });
      refVideo.addEventListener('error', () => {
        if (token !== videoLoadToken) return;
        hideVideoProgress(); alert(tr2('video.loadFail', '视频加载失败'));
      });
      refVideo.addEventListener('ended', () => {
        refVideoPlaying = false;
        seekVideoToFrame(AppState.currentFrameIndex);
        updateVideoUI();
        EventBus.emit('need:render');
      });
      refVideo.load();
      updateVideoUI();
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('btnToggleVideo').onclick = () => {
    if (!refVideo) return;
    refVideoVisible = !refVideoVisible;
    updateVideoUI();
    EventBus.emit('need:render');
  };

  document.getElementById('btnPlayVideo').onclick = () => {
    if (!refVideo) return;
    if (refVideo.paused) {
      const startTime = getFrameStartTime(AppState.currentFrameIndex);
      refVideo.currentTime = Math.min(startTime, refVideo.duration - 0.1);
      refVideo.muted = false;
      refVideo.play().catch(() => {});
      refVideoPlaying = true;
      startVideoRaf();
    } else {
      refVideo.pause();
      refVideo.muted = true;
      refVideoPlaying = false;
    }
    updateVideoUI();
  };

  /* v6.1.0：移除参考视频（选中视频图层后按删除键 / 点删除按钮走这里）
     以前 deleteSelected 遇到 video 直接 return，所以视频永远删不掉。 */
  function removeReferenceVideo() {
    const had = !!(videoObj || refVideo);
    if (AppState.selected && AppState.selected.type === 'video') AppState.selected = null;
    if (refVideo) { try { refVideo.pause(); } catch (_) {} refVideo = null; }
    if (refVideoUrl) { try { URL.revokeObjectURL(refVideoUrl); } catch (_) {} refVideoUrl = null; }
    videoCache = {};
    refVideoPlaying = false;
    refVideoVisible = false;
    videoObj = null;
    if (videoLoadToken) videoLoadToken++; /* 让还在路上的加载回调作废 */
    hideVideoProgress();
    updateVideoUI();
    EventBus.emit('need:render');
    EventBus.emit('need:syncUI');
    return had;
  }

  /* ==================== 颜色工具 ==================== */

  /* ==================== 预设 ==================== */
  function loadPresetsFromStorage() {
    try { const raw = localStorage.getItem(PRESET_KEY); presets = raw ? JSON.parse(raw) : []; }
    catch (e) { presets = []; }
  }
  function savePresetsToStorage() {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); }
    catch (e) { alert(tr2('preset.saveFail', '保存预设失败，浏览器存储空间可能已满')); }
  }
  function updatePresetListUI() {
    const listEl = document.getElementById('presetList');
    listEl.innerHTML = '';
    if (presets.length === 0) {
      listEl.innerHTML = tr2('preset.empty', '<div class="empty-state">暂无预设，选中火柴人后保存吧</div>');
      return;
    }
    presets.forEach((p, index) => {
      const div = document.createElement('div');
      div.className = 'preset-item';
      const infoDiv = document.createElement('div');
      infoDiv.className = 'preset-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'preset-name';
      nameDiv.textContent = p.name || tr2('preset.unnamed', '未命名预设');
      if (p.data.color) nameDiv.style.color = p.data.color;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'preset-meta';
      let metaHtml = `<span>LW:${(+p.data.lw).toFixed(1)}</span>`;
      if (p.data.glow.enabled) metaHtml += ' <span>' + ic('star-one') + '描边阴影</span>';
      if (p.data.light.enabled) metaHtml += ' <span>' + ic('high-light') + '高光</span>';
      if (p.data.extremity.enabled) metaHtml += ' <span>' + ic('foot') + '手脚</span>';
      if (p.data.depth && p.data.depth.enabled) metaHtml += ' <span>' + ic('contrast') + '深色</span>';
      if (p.accessories && p.accessories.length > 0) metaHtml += ` <span>${ic('crown')}x${p.accessories.length}</span>`;
      metaDiv.innerHTML = metaHtml;
      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(metaDiv);

      const btns = document.createElement('div');
      btns.className = 'preset-actions';
      const renameBtn = document.createElement('div');
      renameBtn.className = 'preset-rename';
      renameBtn.innerHTML = ic('pencil');
      renameBtn.title = tr2('preset.renameTitle', '重命名预设');
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        const newName = prompt('输入新的预设名称：', p.name || '');
        if (newName !== null && newName.trim()) {
          p.name = newName.trim();
          savePresetsToStorage();
          updatePresetListUI();
        }
      };
      const delBtn = document.createElement('div');
      delBtn.className = 'preset-del';
      delBtn.innerHTML = ic('close');
      delBtn.title = tr2('common.delete', '删除');
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm('确定删除该预设吗？')) {
          presets.splice(index, 1);
          savePresetsToStorage();
          updatePresetListUI();
        }
      };
      btns.appendChild(renameBtn);
      btns.appendChild(delBtn);
      div.appendChild(infoDiv);
      div.appendChild(btns);
      div.onclick = () => loadPreset(p);
      listEl.appendChild(div);
    });
  }

  function savePreset() {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    const nameInput = document.getElementById('presetNameInput');
    const name = nameInput.value.trim() || ('预设' + (presets.length + 1));
    const data = {
      color: AppState.selected.color, lw: AppState.selected.lw, alpha: AppState.selected.alpha, scale: AppState.selected.scale,
      rot: AppState.selected.rot || 0, mirror: !!AppState.selected.mirror,
      headFilled: AppState.selected.headFilled,
      headFillCustom: !!AppState.selected.headFillCustom,
      headFillColor: AppState.selected.headFillColor || '#111111',
      headShape: AppState.selected.headShape || 'circle',   /* v6.4.0 */
      bodyScale: JSON.parse(JSON.stringify(AppState.selected.bodyScale)),
      headAngle: AppState.selected.headAngle,
      light: JSON.parse(JSON.stringify(AppState.selected.light)),
      glow: JSON.parse(JSON.stringify(AppState.selected.glow)),
      joint: JSON.parse(JSON.stringify(AppState.selected.joint)),
      extremity: JSON.parse(JSON.stringify(AppState.selected.extremity)),
      layer: JSON.parse(JSON.stringify(AppState.selected.layer)),
      a: JSON.parse(JSON.stringify(AppState.selected.a)),
      depth: JSON.parse(JSON.stringify(AppState.selected.depth || { enabled: false, useCustom: false, customColor: '#555555' })),
      ikEnabled: AppState.selected.ikEnabled,
      shadowOffX: AppState.selected.shadowOffX || 0, shadowOffY: AppState.selected.shadowOffY || 0,
      shadowScaleX: AppState.selected.shadowScaleX || 1, shadowScaleY: AppState.selected.shadowScaleY || 1,
      shadowEnabled: !!AppState.selected.shadowEnabled,
      shadowColor: AppState.selected.shadowColor || '#000000',
      shadowAlpha: AppState.selected.shadowAlpha == null ? 0.3 : AppState.selected.shadowAlpha
    };
    const boundAccs = AppState.objects.filter(o => o.type === 'acc' && o.targetId === AppState.selected.id);
    const accessories = boundAccs.map(acc => ({
      imgSrc: acc.img.src, w: acc.w, h: acc.h, alpha: acc.alpha, scale: acc.scale,
      layer: acc.layer, bindTo: acc.bindTo, offX: acc.offX, offY: acc.offY, rot: acc.rot,
      /* v6.1.0：镜像 / 旋转轴心也要存进预设，否则重新载入后配饰会左右翻回去，位置和旋转都对不上 */
      mirror: !!acc.mirror, ax: acc.ax || 0, ay: acc.ay || 0
    }));
    presets.push({ name, data, accessories });
    savePresetsToStorage();
    updatePresetListUI();
    nameInput.value = '';
    const btn = document.getElementById('btnSavePreset');
    btn.innerHTML = tr2('preset.saved', '已保存') + ic('check-correct');
    btn.classList.add('is-saved');
    setTimeout(() => { btn.textContent = tr2('preset.save', '保存预设'); btn.classList.remove('is-saved'); }, 1000);
  }

  function loadPreset(p) {
    const sp = getSpawnPoint();
    const f = makeFigure(sp.x, sp.y);
    f.name = p.name + ' 的副本';
    const d = p.data;
    f.color = d.color; f.lw = d.lw; f.alpha = d.alpha; f.scale = d.scale;
    f.rot = d.rot || 0; f.mirror = !!d.mirror;
    f.headFilled = d.headFilled;
    f.headFillCustom = !!d.headFillCustom;
    f.headFillColor = d.headFillColor || '#111111';
    /* v6.4.0：旧预设没有这个字段 → 正圆；拿不到对应头型数据也退回正圆 */
    const wantShape = d.headShape || 'circle';
    f.headShape = (wantShape !== 'circle' && !(SKFE.systems.headShapes && SKFE.systems.headShapes.has(wantShape))) ? 'circle' : wantShape;
    f.bodyScale = JSON.parse(JSON.stringify(d.bodyScale));
    f.headAngle = d.headAngle;
    f.light = JSON.parse(JSON.stringify(d.light));
    f.glow = glowFill(JSON.parse(JSON.stringify(d.glow || {})));
    f.joint = JSON.parse(JSON.stringify(d.joint));
    f.extremity = JSON.parse(JSON.stringify(d.extremity));
    f.layer = JSON.parse(JSON.stringify(d.layer));
    f.a = JSON.parse(JSON.stringify(d.a));
    if (f.a.waist === undefined) f.a.waist = 0;
    f.depth = d.depth ? JSON.parse(JSON.stringify(d.depth)) : { enabled: false, useCustom: false, customColor: '#555555' };
    f.ikEnabled = d.ikEnabled !== undefined ? d.ikEnabled : false;
    f.shadowOffX = d.shadowOffX || 0; f.shadowOffY = d.shadowOffY || 0;
    f.shadowScaleX = d.shadowScaleX !== undefined ? d.shadowScaleX : 1;
    f.shadowScaleY = d.shadowScaleY !== undefined ? d.shadowScaleY : 1;
    f.shadowEnabled = !!d.shadowEnabled;
    f.shadowColor = d.shadowColor || '#000000';
    f.shadowAlpha = d.shadowAlpha != null ? d.shadowAlpha : 0.3;
    if (f.light.size === undefined) f.light.size = 1.0;
    if (f.light.angle === undefined) f.light.angle = 315;
    generateName(f);
    addObjectToFrames(f);
    const promises = [];
    if (p.accessories && p.accessories.length > 0) {
      p.accessories.forEach(accData => {
        promises.push(new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const acc = {
              id: ++uid, type: 'acc', name: 'Acc', img, x: f.x, y: f.y,
              w: accData.w, h: accData.h, alpha: accData.alpha, scale: accData.scale,
              layer: accData.layer, bindTo: accData.bindTo, targetId: f.id,
              offX: accData.offX, offY: accData.offY, rot: accData.rot, locked: false,
              ax: accData.ax || 0, ay: accData.ay || 0, mirror: !!accData.mirror
            };
            generateName(acc);
            addObjectToFrames(acc);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = accData.imgSrc;
        }));
      });
    }
    Promise.all(promises).then(() => { select(f); EventBus.emit('need:render'); EventBus.emit('history:save', '加载预设'); });
  }

  /* ==================== 动作库 ==================== */
  function loadActionPresets() {
    try { const raw = localStorage.getItem(ACTION_PRESET_KEY); actionPresets = raw ? JSON.parse(raw) : []; }
    catch (e) { actionPresets = []; }
  }
  function saveActionPresets() {
    try { localStorage.setItem(ACTION_PRESET_KEY, JSON.stringify(actionPresets)); }
    catch (e) { alert(tr2('action.saveFail', '保存动作失败，浏览器存储空间可能已满')); }
  }

  function updateActionListUI() {
  const listEl = document.getElementById('actionList');
  listEl.innerHTML = '';
  if (actionPresets.length === 0) {
    listEl.innerHTML = tr2('action.empty', '<div class="empty-state">暂无动作，选中火柴人保存吧</div>');
    selectedActionIndex = -1;
    return;
  }
  if (selectedActionIndex >= actionPresets.length) selectedActionIndex = -1;
  actionPresets.forEach((p, index) => {
    const isSelected = (index === selectedActionIndex);
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.style.cursor = 'pointer';
    div.title = isSelected ? tr2('action.selectedTip', '已选中，点「导出动作」只导出此动作') : tr2('action.selectTip', '点击选中该动作');
    if (isSelected) {
      div.style.background = 'var(--color-primary-soft)';
      div.style.outline = '2px solid var(--color-primary)';
      div.style.outlineOffset = '-2px';
    }
    div.onclick = (e) => {
      if (e.target.closest('button') || e.target.closest('.preset-del')) return;
      if (selectedActionIndex === index) {
        selectedActionIndex = -1;
      } else {
        selectedActionIndex = index;
      }
      updateActionListUI();
    };
    const infoDiv = document.createElement('div');
    infoDiv.className = 'preset-info';
    const metaText = p.frames.length + tr2('timeline.frameSuffix', ' 帧') + (isSelected ? ' · 已选中' : ' · 点击选中');
    infoDiv.innerHTML = `<div class="preset-name">${p.name || tr2('action.unnamed', '未命名动作')}</div><div class="preset-meta">${metaText}</div>`;
    const btns = document.createElement('div');
    btns.className = 'preset-actions';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = tr2('action.apply', '应用');
    applyBtn.className = 'btn-soft btn-xs';
    applyBtn.onclick = (e) => { e.stopPropagation(); applyActionPreset(p); };
    const delBtn = document.createElement('div');
    delBtn.className = 'preset-del';
    delBtn.innerHTML = ic('close');
    delBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm('确定删除该动作吗？')) {
        actionPresets.splice(index, 1);
        if (selectedActionIndex === index) selectedActionIndex = -1;
        else if (selectedActionIndex > index) selectedActionIndex -= 1;
        saveActionPresets();
        updateActionListUI();
      }
    };
    btns.appendChild(applyBtn);
    btns.appendChild(delBtn);
    div.appendChild(infoDiv);
    div.appendChild(btns);
    listEl.appendChild(div);
  });
}
  
  function exportSingleActionPreset(preset) {
  if (!preset || !Array.isArray(preset.frames)) return;
  const safeName = String(preset.name || 'action').replace(/[\\/:*?"<>|]/g, '_').trim() || 'action';
  const payload = {
    name: preset.name || tr2('action.unnamed', '未命名动作'),
    version: preset.version || 2,
    savedBase: preset.savedBase || null,
    frames: preset.frames
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  SKFE.platform.save(blob, safeName + '_' + Date.now() + '.json');
}

  /* ==================== 动作保存/应用：辅助函数 ==================== */
  const BODY_SCALE_RANGES = {
    head: [0.5, 2.0], arm: [0.1, 2.0], leg: [0.1, 2.0], torso: [0.1, 2.0],
    armL: [0.1, 3.0], armR: [0.1, 3.0], legL: [0.1, 3.0], legR: [0.1, 3.0],
    foreArm: [0.2, 0.8], shin: [0.2, 0.8],
    foreArmL: [0.1, 0.9], foreArmR: [0.1, 0.9], shinL: [0.1, 0.9], shinR: [0.1, 0.9]
  };
  const LEN_KEYS = ['head', 'arm', 'leg', 'torso', 'armL', 'armR', 'legL', 'legR'];
  const PORTION_KEYS = ['foreArm', 'shin', 'foreArmL', 'foreArmR', 'shinL', 'shinR'];

  /* 有界映射：把 savedBase→savedVal 的变化，按"离边界的剩余空间"等比映射到 targetBase 上 */
  function boundedMap(savedBaseVal, savedVal, targetBaseVal, lower, upper) {
    if (!isFinite(savedVal) || !isFinite(savedBaseVal) || !isFinite(targetBaseVal)) return targetBaseVal;
    savedBaseVal = Math.max(lower, Math.min(upper, savedBaseVal));
    savedVal = Math.max(lower, Math.min(upper, savedVal));
    targetBaseVal = Math.max(lower, Math.min(upper, targetBaseVal));
    if (savedVal >= savedBaseVal) {
      const spaceSrc = upper - savedBaseVal;
      const spaceTgt = upper - targetBaseVal;
      if (spaceSrc < 0.02) return Math.max(lower, Math.min(upper, savedVal));
      return Math.max(lower, Math.min(upper, targetBaseVal + (savedVal - savedBaseVal) / spaceSrc * spaceTgt));
    } else {
      const spaceSrc = savedBaseVal - lower;
      const spaceTgt = targetBaseVal - lower;
      if (spaceSrc < 0.02) return Math.max(lower, Math.min(upper, savedVal));
      return Math.max(lower, Math.min(upper, targetBaseVal - (savedBaseVal - savedVal) / spaceSrc * spaceTgt));
    }
  }

  /* 取 bodyScale 值，独立字段用通用值兜底 */
  function getBodyVal(bs, key) {
    if (!bs) return 1;
    if (bs[key] !== undefined && bs[key] !== null && isFinite(bs[key])) return bs[key];
    if (key === 'armL' || key === 'armR') return bs.arm !== undefined ? bs.arm : 1;
    if (key === 'legL' || key === 'legR') return bs.leg !== undefined ? bs.leg : 1;
    if (key === 'foreArmL' || key === 'foreArmR') return bs.foreArm !== undefined ? bs.foreArm : 0.37;
    if (key === 'shinL' || key === 'shinR') return bs.shin !== undefined ? bs.shin : 0.49;
    return 1;
  }

  /* 判断一个 bodyScale 对象是否开启了独立四肢 */
  function hasIndepLimbs(bs) {
    if (!bs) return false;
    return bs.armL !== undefined || bs.armR !== undefined ||
           bs.legL !== undefined || bs.legR !== undefined;
  }

  function saveActionPreset() {
    if (!AppState.selected || AppState.selected.type !== 'figure') return alert(tr2('alert.pickFigure', '请先选中一个火柴人'));
    const nameInput = document.getElementById('actionNameInput');
    const name = nameInput.value.trim() || ('动作 ' + (actionPresets.length + 1));

    const targetId = String(AppState.selected.id);

    /* 找到第一个非空帧作为基准（10A） */
    let baseFig = null;
    for (let i = 0; i < AppState.frames.length; i++) {
      const fig = getTrackFrame(targetId, i);
      if (fig) { baseFig = fig; break; }
    }
    if (!baseFig) return alert(tr2('action.noValidFrame', '当前元件的轨道上没有有效帧，无法保存动作'));

    const savedBase = {
      scale: baseFig.scale || 1,
      rot: baseFig.rot || 0,
      bodyScale: JSON.parse(JSON.stringify(baseFig.bodyScale || {})),
      hasIndep: hasIndepLimbs(baseFig.bodyScale)
    };

    let baseX = null, baseY = null;
    const extractedFrames = [];

    for (let i = 0; i < AppState.frames.length; i++) {
      const fig = getTrackFrame(targetId, i);
      if (fig) {
        if (baseX === null) { baseX = fig.x; baseY = fig.y; }
        const dx = fig.x - baseX;
        const dy = fig.y - baseY;
        const pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
        const pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
        if (fig.pinned) for (const k in pinned) pinned[k] = !!fig.pinned[k];
        if (fig.pinnedPos) {
          for (const k in pinnedPos) {
            if (fig.pinnedPos[k]) {
              pinnedPos[k] = { x: fig.pinnedPos[k].x - baseX, y: fig.pinnedPos[k].y - baseY };
            }
          }
        }

        /* 每帧 bodyScale 绝对值（用于有界映射精确反算） */
        const frameBody = fig.bodyScale || {};
        const bodyScaleAbs = {};
        [...LEN_KEYS, ...PORTION_KEYS].forEach(k => {
          bodyScaleAbs[k] = getBodyVal(frameBody, k);
        });

        extractedFrames.push({
          dx, dy,
          a: JSON.parse(JSON.stringify(fig.a)),
          headAngle: fig.headAngle,
          headOffset: fig.headOffset ? JSON.parse(JSON.stringify(fig.headOffset)) : { x: 0, y: 0 },
          extremity: JSON.parse(JSON.stringify(fig.extremity)),
          layer: JSON.parse(JSON.stringify(fig.layer)),
          ikEnabled: fig.ikEnabled,
          pinned, pinnedPos,
          mirror: !!fig.mirror,                                    /* 3A */
          rotTotal: (fig.rot || 0) - savedBase.rot,                /* 1A */
          scaleRatio: savedBase.scale > 0.001 ? (fig.scale || 1) / savedBase.scale : 1, /* 2A */
          bodyScaleAbs,
          hasIndep: hasIndepLimbs(fig.bodyScale)
        });
      } else {
        extractedFrames.push(null);   /* 26=null：源动作某帧无角色 */
      }
    }

    actionPresets.push({
      name,
      version: 2,                        /* 20A */
      savedBase,
      frames: extractedFrames
    });
    saveActionPresets();
    updateActionListUI();
    nameInput.value = '';
    alert(tr2('action.saved', '动作已保存'));
  }

  /* 这条轨道里「绑在 fid 身上的元件」的样本数据；不是绑定轨道就返回 null */
  function boundSampleOf(track, fid) {
    if (!track || !track.frames) return null;
    let sample = null;
    for (let i = 0; i < track.frames.length; i++) {
      const d = track.frames[i];
      if (d && d.bindTo && d.bindTo !== 'none' && String(d.targetId) === fid) sample = d;
    }
    return sample;
  }

  /* v5.4.1：把这个火柴人身上「绑定」的元件（配饰 / 图形 / 对话框 / 画笔）一起铺到动作覆盖的每一帧。
     不这么做的话：动作有 20 帧、配饰轨道只有 1 帧，从第 2 帧起配饰就"掉了"；
     反过来火柴人某帧离场（动作该帧为 null）时，配饰也得跟着离场，否则会留在原地飘着。
     配饰的位置是渲染时按 offX/offY + 当前帧火柴人关节实时算的，所以这里只需要补帧，不用改坐标。 */
  function syncBoundChildrenFrames(figId, startIndex, count, hasFigureAt) {
    const fid = String(figId);
    let touched = 0;
    for (const tid in AppState.tracks) {
      if (String(tid) === fid) continue;
      const tr = AppState.tracks[tid];
      if (!tr || !tr.frames) continue;

      /* 这条轨道是不是"绑在这个火柴人身上的元件" */
      const sample = boundSampleOf(tr, fid);
      if (!sample) continue;

      /* 优先拿当前帧那份当克隆源，保证颜色/尺寸/挂载点是用户最后看到的状态 */
      const cur = tr.frames[startIndex];
      const src = (cur && cur.bindTo && cur.bindTo !== 'none' && String(cur.targetId) === fid) ? cur : sample;

      let changed = false;
      for (let i = 0; i < count; i++) {
        const idx = startIndex + i;
        while (tr.frames.length <= idx) tr.frames.push(null);
        if (!hasFigureAt[i]) {
          if (tr.frames[idx]) { tr.frames[idx] = null; changed = true; }
          continue;
        }
        if (!tr.frames[idx]) {
          tr.frames[idx] = cloneObjectKeepImg(src);
          changed = true;
        }
      }
      if (changed) {
        touched++;
        for (let i = 0; i < count; i++) invalidateFrameThumb(startIndex + i, tid);
      }
    }
    return touched;
  }

  /* v5.4.2：子轨道补间在火柴人轨道里「插入」帧时，绑定元件的轨道必须在同一位置插入等量空帧。
     否则从那之后整条时间线就错位了 —— 配饰的帧还停在旧索引上，越往后偏得越远。
     这里只插入空占位，具体内容随后交给 tweenBoundChildren 填。 */
  function spliceBoundChildrenFrames(figId, at, count) {
    if (!(count > 0)) return 0;
    const fid = String(figId);
    let touched = 0;
    for (const tid in AppState.tracks) {
      if (String(tid) === fid) continue;
      const tr = AppState.tracks[tid];
      if (!boundSampleOf(tr, fid)) continue;
      while (tr.frames.length < at) tr.frames.push(null);
      tr.frames.splice(at, 0, ...new Array(count).fill(null));
      for (let i = at; i < tr.frames.length; i++) invalidateFrameThumb(i, tid);
      touched++;
    }
    return touched;
  }

  /**
   * 先把「绑定元件」的补间数据算好：每条轨道一份长度 count 的数组。
   * 必须在火柴人插帧之前调用 —— 插帧会让 f2Idx 指向别的帧，之后再算就取不到正确的首尾关键帧。
   * 内容优先用该元件自己的补间结果（offX/offY/缩放/旋转都会插值），取不到就退回克隆当前帧那份。
   */
  function buildBoundChildTweens(figId, startIdx, f2Idx, count) {
    const fid = String(figId);
    const map = {};
    for (const tid in AppState.tracks) {
      if (String(tid) === fid) continue;
      const tr = AppState.tracks[tid];
      if (!tr || !tr.frames) continue;
      const sample = boundSampleOf(tr, fid);
      if (!sample) continue;

      let tws = null;
      try {
        tws = buildTweenFrames(AppState.frames[startIdx], AppState.frames[f2Idx], count, tid, startIdx, f2Idx);
      } catch (_) { tws = null; }

      const fallback = tr.frames[startIdx] || sample;
      const out = [];
      for (let i = 0; i < count; i++) {
        const tw = tws && tws[i];
        const src = (tw && tw.objects) ? (tw.objects.find(o => String(o.id) === String(tid)) || null) : null;
        const base = src || fallback;
        if (!base) { out.push(null); continue; }
        const c = cloneObjectKeepImg(base);
        c.id = base.id;
        out.push(c);
      }
      map[tid] = out;
    }
    return map;
  }

  /**
   * 把上面算好的补间帧填进绑定元件的轨道。
   * 落点严格复用火柴人那套：前 used 个填进已存在的空档 slots[]，其余随插帧落到 f2Idx 之后，逐帧对齐。
   */
  function tweenBoundChildren(figId, startIdx, f2Idx, count, used, slots, childTweens) {
    const fid = String(figId);
    let touched = 0;
    for (const tid in childTweens) {
      const tr = AppState.tracks[tid];
      if (!tr || !tr.frames) continue;
      const data = childTweens[tid];
      let changed = false;
      for (let i = 0; i < count; i++) {
        const idx = (i < used) ? slots[i] : (f2Idx + (i - used));
        if (!getTrackFrame(fid, idx)) {           /* 火柴人这一帧不在，配饰也不该在 */
          if (idx < tr.frames.length && tr.frames[idx]) { tr.frames[idx] = null; changed = true; }
          continue;
        }
        /* v6.1.0：只有确实要写内容时才把轨道撑到 idx，否则会留下一串尾部空帧 */
        while (tr.frames.length <= idx) tr.frames.push(null);
        if (!tr.frames[idx] && data[i]) {
          tr.frames[idx] = data[i];
          changed = true;
        }
      }
      if (changed) {
        touched++;
        for (let i = 0; i < count; i++) {
          invalidateFrameThumb((i < used) ? slots[i] : (f2Idx + (i - used)), tid);
        }
      }
    }
    return touched;
  }

  function applyActionPreset(preset) {
    if (!AppState.selected || AppState.selected.type !== 'figure') return alert(tr2('alert.pickFigure', '请先选中一个火柴人'));
    const targetId = String(AppState.selected.id);
    const targetX = AppState.selected.x;
    const targetY = AppState.selected.y;

    /* 捕获目标基准（18A：当前帧状态） */
    const targetBase = {
      scale: AppState.selected.scale || 1,
      rot: AppState.selected.rot || 0,
      bodyScale: JSON.parse(JSON.stringify(AppState.selected.bodyScale || {})),
      hasIndep: hasIndepLimbs(AppState.selected.bodyScale)
    };

    const isV2 = preset.version === 2 && preset.savedBase;   /* 21A：老动作按无变化处理 */
    const savedBase = isV2 ? preset.savedBase : null;

    const templateFig = cloneObjectKeepImg(AppState.selected);
    const startIndex = AppState.currentFrameIndex;                     /* 17A */
    const t = ensureTrack(targetId, AppState.selected.name);

    /* 每写一帧记录一下「这一帧有没有火柴人」，用来同步绑定配饰 */
    const figPresent = [];

    preset.frames.forEach((data, i) => {
      const frameIdx = startIndex + i;
      while (frameIdx >= t.frames.length) t.frames.push(null);/* 27A：自动补帧 */

      let fig = null;
      if (data) {
        fig = cloneObjectKeepImg(templateFig);
        fig.id = AppState.selected.id;
        fig.x = targetX + data.dx;
        fig.y = targetY + data.dy;
        fig.a = JSON.parse(JSON.stringify(data.a));
        fig.headAngle = data.headAngle;
        /* 恢复头部独立位移 */
        if (data.headOffset) {
          fig.headOffset = JSON.parse(JSON.stringify(data.headOffset));
        } else {
          fig.headOffset = { x: 0, y: 0 }; // 兼容老动作，没有就复位
        }
        fig.layer = JSON.parse(JSON.stringify(data.layer));   /* 28A：绝对值 */

        /* 小手小脚：完全按动作来（5A 自动开启） */
        fig.extremity = data.extremity
          ? JSON.parse(JSON.stringify(data.extremity))
          : { enabled: false, armAngleL: 30 * Math.PI / 180, armAngleR: 30 * Math.PI / 180,
              legAngleL: 30 * Math.PI / 180, legAngleR: 30 * Math.PI / 180, armRatio: 0.23, legRatio: 0.23 };
        if (fig.extremity.armRatio == null) fig.extremity.armRatio = 0.23;
        if (fig.extremity.legRatio == null) fig.extremity.legRatio = 0.23;

        /* 镜像（3A） */
        if (data.mirror !== undefined) fig.mirror = !!data.mirror;

        /* IK（16A：照搬 + 自动开启） */
        fig.ikEnabled = data.ikEnabled;
        fig.pinned = JSON.parse(JSON.stringify(data.pinned));
        fig.pinnedPos = {};
        const savedPinnedPos = data.pinnedPos || {};
        /* 15A：按 scale 比缩放 pinnedPos */
        const scaleRatioForPin = isV2 ? (targetBase.scale / (savedBase.scale || 1)) : 1;
        for (const k in savedPinnedPos) {
          if (savedPinnedPos[k]) {
            fig.pinnedPos[k] = {
              x: targetX + savedPinnedPos[k].x * scaleRatioForPin,
              y: targetY + savedPinnedPos[k].y * scaleRatioForPin
            };
          } else {
            fig.pinnedPos[k] = null;
          }
        }

        /* 体形参数（6A / 7A / 12B / 13B） */
        if (isV2 && data.bodyScaleAbs) {
          const newBody = {};
          const actionHasIndep = data.hasIndep;
          const targetHasIndep = targetBase.hasIndep;
          const finalHasIndep = actionHasIndep || targetHasIndep;

          /* 长度型：倍率 + clamp */
          LEN_KEYS.forEach(k => {
            const savedVal = data.bodyScaleAbs[k];
            const savedBaseVal = getBodyVal(savedBase.bodyScale, k);
            const targetBaseVal = getBodyVal(targetBase.bodyScale, k);
            const [lo, hi] = BODY_SCALE_RANGES[k];
            let newVal = targetBaseVal;
            if (isFinite(savedVal) && isFinite(savedBaseVal) && savedBaseVal > 0.001) {
              newVal = targetBaseVal * (savedVal / savedBaseVal);
            }
            newBody[k] = Math.max(lo, Math.min(hi, newVal));
          });

          /* 占比型：有界映射（11A 兜底在 boundedMap 里） */
          PORTION_KEYS.forEach(k => {
            const savedVal = data.bodyScaleAbs[k];
            const savedBaseVal = getBodyVal(savedBase.bodyScale, k);
            const targetBaseVal = getBodyVal(targetBase.bodyScale, k);
            const [lo, hi] = BODY_SCALE_RANGES[k];
            newBody[k] = boundedMap(savedBaseVal, savedVal, targetBaseVal, lo, hi);
          });

          const indepLenKeys = ['armL', 'armR', 'legL', 'legR'];
          const indepPortionKeys = ['foreArmL', 'foreArmR', 'shinL', 'shinR'];

          if (!finalHasIndep) {
            /* 双方都不开独立四肢 → 删掉独立字段 */
            [...indepLenKeys, ...indepPortionKeys].forEach(k => { delete newBody[k]; });
          } else {
            if (actionHasIndep) {
              /* 12B：动作有独立四肢 → 目标也应用独立值（目标原本没开，用 arm/leg 兜底作基） */
              indepLenKeys.forEach(k => {
                const savedVal = data.bodyScaleAbs[k];
                const savedBaseVal = getBodyVal(savedBase.bodyScale, k);
                const targetBaseVal = getBodyVal(targetBase.bodyScale, k);
                const [lo, hi] = BODY_SCALE_RANGES[k];
                let newVal = targetBaseVal;
                if (isFinite(savedVal) && isFinite(savedBaseVal) && savedBaseVal > 0.001) {
                  newVal = targetBaseVal * (savedVal / savedBaseVal);
                }
                newBody[k] = Math.max(lo, Math.min(hi, newVal));
              });
              indepPortionKeys.forEach(k => {
                const savedVal = data.bodyScaleAbs[k];
                const savedBaseVal = getBodyVal(savedBase.bodyScale, k);
                const targetBaseVal = getBodyVal(targetBase.bodyScale, k);
                const [lo, hi] = BODY_SCALE_RANGES[k];
                newBody[k] = boundedMap(savedBaseVal, savedVal, targetBaseVal, lo, hi);
              });
            } else {
              /* 13B：动作无独立、目标有独立 → 目标保留独立字段，但按"通用 arm/leg 的变化率"调整 */
              indepLenKeys.forEach(k => {
                const generalKey = (k === 'armL' || k === 'armR') ? 'arm' : 'leg';
                const savedVal = data.bodyScaleAbs[generalKey];
                const savedBaseVal = getBodyVal(savedBase.bodyScale, generalKey);
                const targetBaseVal = getBodyVal(targetBase.bodyScale, k);
                const [lo, hi] = BODY_SCALE_RANGES[k];
                let newVal = targetBaseVal;
                if (isFinite(savedVal) && isFinite(savedBaseVal) && savedBaseVal > 0.001) {
                  newVal = targetBaseVal * (savedVal / savedBaseVal);
                }
                newBody[k] = Math.max(lo, Math.min(hi, newVal));
              });
              indepPortionKeys.forEach(k => {
                const generalKey = (k === 'foreArmL' || k === 'foreArmR') ? 'foreArm' : 'shin';
                const savedVal = data.bodyScaleAbs[generalKey];
                const savedBaseVal = getBodyVal(savedBase.bodyScale, generalKey);
                const targetBaseVal = getBodyVal(targetBase.bodyScale, k);
                const [lo, hi] = BODY_SCALE_RANGES[k];
                newBody[k] = boundedMap(savedBaseVal, savedVal, targetBaseVal, lo, hi);
              });
            }
          }
          fig.bodyScale = newBody;
        } else {
          /* 老动作兼容：不改动目标体形 */
          fig.bodyScale = JSON.parse(JSON.stringify(targetBase.bodyScale));
        }

        /* 缩放倍率（2A） */
        if (data.scaleRatio !== undefined && isFinite(data.scaleRatio)) {
          fig.scale = Math.max(0.05, Math.min(4, targetBase.scale * data.scaleRatio));
        }

        /* 旋转（v6.2.0）：改为完全套用动作自身的绝对角度。
           rotTotal 是「该帧相对动作首帧」的增量，所以 savedBase.rot + rotTotal
           就等于源动作这一帧的原始角度 —— 首帧自然落在动作首帧的角度上，
           不再叠加目标火柴人应用前的旋转（1A 的旧行为）。
           v1 老动作没有 savedBase，继续沿用「叠加目标当前角度」以免破坏老数据。 */
        if (data.rotTotal !== undefined && isFinite(data.rotTotal)) {
          const rotBase = (isV2 && isFinite(savedBase.rot)) ? savedBase.rot : targetBase.rot;
          fig.rot = rotBase + data.rotTotal;
        }
      }

      /* 26=null：源动作该帧为空，目标该帧也置空（角色"离场"） */
      t.frames[frameIdx] = fig;
      figPresent.push(!!fig);

      invalidateFrameThumb(frameIdx, targetId);
      if (AppState.frames[frameIdx]) AppState.frames[frameIdx].isTween = false;
    });

    /* v5.4.1：身上的绑定配饰/图形一起铺满动作覆盖到的帧，跟着火柴人同生同灭 */
    const syncedChildren = syncBoundChildrenFrames(targetId, startIndex, preset.frames.length, figPresent);

    syncMainLengthFromTracks();
    trimTrailingEmptyFrames();
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = isSubTrackMode() ? getActiveTrackObject() : (AppState.objects.find(o => String(o.id) === targetId) || null);
    updateFrameBar();
    EventBus.emit('app:update', '应用动作');
    alert(syncedChildren > 0
      ? `动作已应用（${syncedChildren} 个绑定元件已同步到 ${preset.frames.length} 帧）`
      : '动作已应用');
  }

  function exportActionPresets() {
  if (actionPresets.length === 0) return alert(tr2('action.none', '没有保存的动作'));
  if (selectedActionIndex >= 0 && selectedActionIndex < actionPresets.length) {
    exportSingleActionPreset(actionPresets[selectedActionIndex]);
    return;
  }
  const blob = new Blob([JSON.stringify(actionPresets, null, 2)], { type: 'application/json' });
  SKFE.platform.save(blob, 'tco_actions.json');
}

function importActionPresets() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target.result);
        const isValidAction = (p) => p && p.name && Array.isArray(p.frames);
        let valid = [];
        if (Array.isArray(imported)) {
          valid = imported.filter(isValidAction);
        } else if (isValidAction(imported)) {
          valid = [imported];
        }
        if (valid.length > 0) {
          const wasEmpty = (actionPresets.length === 0);
          actionPresets.push(...valid);
          if (wasEmpty && valid.length === 1) selectedActionIndex = 0;
          saveActionPresets();
          updateActionListUI();
          alert(tr2('action.importedHead', '成功导入 ') + valid.length + tr2('action.importedTail', ' 个动作'));
        } else {
          alert(tr2('action.importFail', '导入失败，格式不正确'));
        }
      } catch (err) { alert(tr2('action.importFail', '导入失败，格式不正确')); }
    };
    reader.readAsText(file);
  };
  input.click();
}

  /* ==================== 生成位置 ==================== */
  function getSpawnPoint() {
    if (AppState.canvasBoundsEnabled) {
      return { x: AppState.canvasBounds.x + AppState.canvasBounds.w / 2, y: AppState.canvasBounds.y + AppState.canvasBounds.h / 2 };
    }
    return {
      x: (canvas.clientWidth / 2 - AppState.viewOffset.x) / AppState.viewScale,
      y: (canvas.clientHeight / 2 - AppState.viewOffset.y) / AppState.viewScale
    };
  }

  /* ==================== 高级设置切换按钮同步 ==================== */
  function syncAdvToggles() {
    document.querySelectorAll('.adv-toggle').forEach(btn => {
      const cb = document.getElementById(btn.dataset.toggle);
      if (cb) btn.classList.toggle('on', cb.checked);
    });
  }
  document.querySelectorAll('.adv-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const cb = document.getElementById(btn.dataset.toggle);
      if (!cb) return;
      cb.checked = !cb.checked;
      btn.classList.toggle('on', cb.checked);
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });

  /* ==================== UI 拖动面板 ==================== */
  
  let uiDragMode = null;
  let uiStartX = 0, uiStartY = 0;
  let uiResizable = localStorage.getItem('skfe_ui_resizable') === '1'; // 读取是否开启了自由缩放
  let uiCustomSize = null; // 新增：缓存的尺寸
  try { uiCustomSize = JSON.parse(localStorage.getItem('skfe_ui_size_v1')); } catch(_) {}
  /* v7.2.1：自由缩放面板的**顶边位置**（px）。null = 用户还没拖过，按老规矩贴底。
     起因是移动端 applyCustomSize() 里无条件写 bottom:0 / top:auto —— 而 resize() 每次都会
     调它，用户把面板拖到半空，随便点一下别的地方就又被按回屏幕底部，
     表现就是「开了自由缩放之后面板离不开底部」。 */
  let uiCustomTop = null;
  try {
    const t = JSON.parse(localStorage.getItem('skfe_ui_top_v1'));
    if (Number.isFinite(t)) uiCustomTop = t;
  } catch(_) {}
  let uiStartLeft = 0, uiStartTop = 0, uiStartWidth = 0;
  let uiPanelDragged = false;
  const uiDragHandle = document.getElementById('uiDragHandle');

  let isPanelLocked = false;
  const btnLockPanel = document.getElementById('btnLockPanel');

  function updateLockPanelUI() {
    if (!btnLockPanel) return;
    { const lkKey = isPanelLocked ? 'panel.unlock' : 'panel.lock'; const lkTxt = isPanelLocked ? tr2('panel.unlock', '解锁面板位置') : tr2('panel.lock', '锁定面板位置'); btnLockPanel.innerHTML = (isPanelLocked ? ic('unlock') : ic('lock')) + '<span data-i18n="' + lkKey + '">' + lkTxt + '</span>'; }
    btnLockPanel.classList.toggle('active', isPanelLocked);
    uiPanel.classList.toggle('ui-locked', isPanelLocked);
  }

  if (btnLockPanel) {
    btnLockPanel.addEventListener('click', () => {
      isPanelLocked = !isPanelLocked;
      if (isPanelLocked) uiDragMode = null;
      updateLockPanelUI();
    });
  }

  uiDragHandle.addEventListener('pointerdown', (e) => {
    if (isPanelLocked) return;
    e.preventDefault();
    uiDragMode = 'move';
    uiStartX = e.clientX; uiStartY = e.clientY;
    const r = uiPanel.getBoundingClientRect();
    uiStartLeft = r.left; uiStartTop = r.top; uiStartWidth = r.width;
    uiPanel.style.transition = 'none'; // 拖拽时禁用动画，防止跳动
    uiDragHandle.setPointerCapture(e.pointerId);
  });

  uiDragHandle.addEventListener('pointermove', (e) => {
    if (uiDragMode !== 'move') return;
    const dx = e.clientX - uiStartX;
    const dy = e.clientY - uiStartY;
    if (isMobile) {
      const timelineVisible = getComputedStyle(timelineEl).display !== 'none';
      // 判断时间轴是否在底部，如果在顶部则不留底部空隙
      const bottomOffset = (timelineDock === 'bottom' && timelineVisible) ? (TIMELINE_H || 100) : 0;
      if (uiResizable && uiCustomSize) {
        /* v7.2.1：开了自由缩放 —— 宽高是用户定的，拖动**只改位置**。
           顶边可以在整块可视区里自由移动（不再被 bottom:0 拴在底部），
           否则「自由缩放」和「不能离开底部」这对组合就是个笑话。 */
        const ch = uiCustomSize.h;
        const maxTop = Math.max(0, window.innerHeight - Math.min(ch, window.innerHeight));
        const nt = Math.max(0, Math.min(maxTop, uiStartTop + dy));
        uiCustomTop = nt;
        uiPanel.style.left = '0';
        uiPanel.style.right = 'auto';
        uiPanel.style.width = uiCustomSize.w + 'px';
        uiPanel.style.top = nt + 'px';
        uiPanel.style.bottom = 'auto';
        uiPanel.style.height = ch + 'px';
        uiPanel.style.maxHeight = 'none';
      } else {
        const maxTop = window.innerHeight - bottomOffset - 50;
        const nt = Math.max(10, Math.min(maxTop, uiStartTop + dy));
        uiPanel.style.left = '0';
        uiPanel.style.right = '0';
        uiPanel.style.width = '100%';
        uiPanel.style.top = nt + 'px';
        uiPanel.style.bottom = bottomOffset + 'px'; // 精准贴底
        uiPanel.style.maxHeight = Math.max(120, window.innerHeight - nt - bottomOffset) + 'px';
      }
      uiPanelDragged = true;
    } else {
      const maxL = window.innerWidth - 60;
      const maxT = window.innerHeight - 60;
      const nl = Math.max(0, Math.min(maxL, uiStartLeft + dx));
      const nt = Math.max(0, Math.min(maxT, uiStartTop + dy));
      uiPanel.style.left = nl + 'px';
      uiPanel.style.top = nt + 'px';
      uiPanel.style.width = uiStartWidth + 'px';
      uiPanel.style.bottom = 'auto';
      uiPanel.style.right = 'auto';
      uiPanelDragged = true;
    }
    updateResizeHandlePos();
  });

  const endUiDrag = (e) => {
    if (uiDragMode) {
      uiDragMode = null;
      uiPanel.style.transition = 'transform .3s ease, bottom .3s ease'; // 松手后恢复动画
      try { uiDragHandle.releasePointerCapture(e.pointerId); } catch (_) {}
      /* v7.2.1：记住拖到的位置，刷新页面 / 关了再开自由缩放都能还原 */
      if (isMobile && uiResizable && Number.isFinite(uiCustomTop)) {
        try { localStorage.setItem('skfe_ui_top_v1', JSON.stringify(Math.round(uiCustomTop))); } catch (_) {}
      }
    }
  };
  uiDragHandle.addEventListener('pointerup', endUiDrag);
  uiDragHandle.addEventListener('pointercancel', endUiDrag);

  /* ==================== 自由缩放面板长宽 ==================== */
  const btnToggleResize = document.getElementById('btnToggleResize');
  const uiResizeHandle = document.getElementById('uiResizeHandle');

  function syncResizeUI() {
    if (btnToggleResize) {
      { const rsKey = uiResizable ? 'panel.resizeOff' : 'panel.resizeOn'; const rsTxt = uiResizable ? tr2('panel.resizeOff', '关闭自由缩放') : tr2('panel.resizeOn', '开启自由缩放'); btnToggleResize.innerHTML = ic('scale') + '<span data-i18n="' + rsKey + '">' + rsTxt + '</span>'; }
      btnToggleResize.classList.toggle('active', uiResizable);
    }
    if (uiResizeHandle) {
      uiResizeHandle.style.display = (uiResizable && !isPanelLocked) ? 'flex' : 'none';
    }
    if (uiResizable && !isPanelLocked) updateResizeHandlePos();
    uiPanel.classList.toggle('ui-resizable', uiResizable);
    
    if (!uiResizable) {
      uiPanel.style.width = '';
      uiPanel.style.height = '';
      uiPanel.style.maxHeight = '';
      uiPanel.style.left = ''; 
      uiPanel.style.right = ''; 
      uiPanel.style.top = ''; 
      uiPanel.style.bottom = ''; 
      refreshTimelineDockOffsets();
      resize();
    } else if (uiCustomSize) {
      applyCustomSize();
    }
  }

  function applyCustomSize() {
    if (!uiResizable || !uiCustomSize) return;
    if (isMobile) {
      const cw = uiCustomSize.w, chh = uiCustomSize.h;
      uiPanel.style.left = '0';
      uiPanel.style.right = 'auto';
      uiPanel.style.width = cw + 'px';
      uiPanel.style.height = chh + 'px';
      uiPanel.style.maxHeight = 'none';
      /* v7.2.1：位置。用户拖过就还原他拖到的顶边（并夹回可视区），没拖过才贴底。
         原来这里无条件 top:auto / bottom:0 —— 而 resize() 每次都会走到这儿，
         于是「拖到半空 → 点一下别处 → 面板又滑回底部」。 */
      if (Number.isFinite(uiCustomTop)) {
        const maxTop = Math.max(0, window.innerHeight - Math.min(chh, window.innerHeight));
        const top = Math.max(0, Math.min(maxTop, uiCustomTop));
        uiCustomTop = top;
        uiPanel.style.top = top + 'px';
        uiPanel.style.bottom = 'auto';
      } else {
        uiPanel.style.top = 'auto';
        uiPanel.style.bottom = '0';
      }
    } else {
      uiPanel.style.width = uiCustomSize.w + 'px';
      uiPanel.style.height = uiCustomSize.h + 'px';
      uiPanel.style.maxHeight = 'none';
    }
    updateResizeHandlePos(); // 新增
  }

  // 实时更新右下角手柄的位置（让手柄紧贴面板右下角）
  function updateResizeHandlePos() {
    /* v7.2.1：面板被 display:none 收起时（移动端），getBoundingClientRect 全是 0，
       手柄会被塞到屏幕左上角外，先算出来再说就晚了 —— 直接藏掉。
       v7.3.0：全关（只剩底部栏）时也藏起来 —— 那条胶囊没什么可缩的，
       留一颗 ◢ 挂在它右下角只会被误点。 */
    if (!uiResizable || isPanelLocked || !uiResizeHandle || !uiPanel.getClientRects().length
        || uiPanel.classList.contains('collapsed')) {
      if (uiResizeHandle) uiResizeHandle.style.display = 'none';
      return;
    }
    uiResizeHandle.style.display = 'flex';
    const rect = uiPanel.getBoundingClientRect();
    uiResizeHandle.style.left = (rect.right - 24) + 'px';
    uiResizeHandle.style.top = (rect.bottom - 24) + 'px';
  }

  if (btnToggleResize) {
    btnToggleResize.onclick = () => {
      if (isPanelLocked) {
        showHistoryToast('请先解除面板锁定', 'undo');
        return;
      }
      uiResizable = !uiResizable;
              localStorage.setItem('skfe_ui_resizable', uiResizable ? '1' : '0'); // 保存状态到浏览器
              syncResizeUI();
            };
          }

  let resizeDragState = null;
  if (uiResizeHandle) {
    uiResizeHandle.addEventListener('pointerdown', (e) => {
      if (!uiResizable || isPanelLocked) return;
      e.preventDefault(); e.stopPropagation();
      const rect = uiPanel.getBoundingClientRect();
      resizeDragState = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startW: rect.width,
        startH: rect.height
      };
      try { uiResizeHandle.setPointerCapture(e.pointerId); } catch (_) {}
    });

    uiResizeHandle.addEventListener('pointermove', (e) => {
      if (!resizeDragState || e.pointerId !== resizeDragState.id) return;
      e.preventDefault(); e.stopPropagation();
      
      const dw = e.clientX - resizeDragState.startX;
      const dh = e.clientY - resizeDragState.startY;

      let newW = resizeDragState.startW + dw;
      let newH = resizeDragState.startH + dh;

      newW = Math.max(260, Math.min(window.innerWidth * 0.85, newW));
      newH = Math.max(150, Math.min(window.innerHeight - 50, newH));

      if (isMobile) {
        /* v7.2.1：以**顶边**为锚点缩放 —— 手柄拖的是右下角，底边跟着手走，顶边不动。
           原来这里写死 bottom:0 / top:auto，一拖高度面板就被钉回屏幕底部，
           用户在屏幕中间调完尺寸，面板直接掉下去，还再也拉不回来。 */
        const topPx = Number.isFinite(uiCustomTop)
          ? uiCustomTop
          : Math.max(0, window.innerHeight - resizeDragState.startH);
        newH = Math.max(150, Math.min(window.innerHeight - topPx, newH));
        uiCustomTop = topPx;
        uiPanel.style.left = '0';
        uiPanel.style.right = 'auto';
        uiPanel.style.width = newW + 'px';
        uiPanel.style.top = topPx + 'px';
        uiPanel.style.bottom = 'auto';
        uiPanel.style.height = newH + 'px';
        uiPanel.style.maxHeight = 'none';
      } else {
        uiPanel.style.width = newW + 'px';
        uiPanel.style.height = newH + 'px';
        uiPanel.style.maxHeight = 'none';
      }
      updateResizeHandlePos();
    });

    const endResize = (e) => {
      if (!resizeDragState || e.pointerId !== resizeDragState.id) return;
      resizeDragState = null;
      try { uiResizeHandle.releasePointerCapture(e.pointerId); } catch (_) {}
      const rect = uiPanel.getBoundingClientRect();
      uiCustomSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
      try { localStorage.setItem('skfe_ui_size_v1', JSON.stringify(uiCustomSize)); } catch(_) {}
      if (isMobile && Number.isFinite(uiCustomTop)) {
        try { localStorage.setItem('skfe_ui_top_v1', JSON.stringify(Math.round(uiCustomTop))); } catch(_) {}
      }
    };
    uiResizeHandle.addEventListener('pointerup', endResize);
    uiResizeHandle.addEventListener('pointercancel', endResize);

    uiResizeHandle.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      uiCustomSize = null;
      uiCustomTop = null; /* v7.2.1：位置也一并复位，否则双击后还悬在半空 */
      localStorage.removeItem('skfe_ui_size_v1');
      localStorage.removeItem('skfe_ui_top_v1');
      uiPanel.style.width = '';
      uiPanel.style.height = '';
      uiPanel.style.maxHeight = '';
      uiPanel.style.top = '';
      uiPanel.style.bottom = '';
      syncResizeUI();
      showHistoryToast('已恢复面板默认大小', 'undo');
    });
  }

  const originalUpdateLockPanelUI = updateLockPanelUI;
  updateLockPanelUI = function() {
    originalUpdateLockPanelUI();
    // 【修复】不再强制把 uiResizable 置为 false，只刷新界面
    // 这样在锁定时，依然会保留你自由缩放后的宽高，仅仅隐藏右下角的缩放手柄
    syncResizeUI();
  };

  /* ==================== 移动端点击控制面板自动收起时间轴 ==================== */
  let uiPendingCollapse = false;
  uiPanel.addEventListener('pointerdown', (e) => {
    if (!isMobile) return;
    const autoCollapseCb = document.getElementById('autoCollapseTimeline');
    if (autoCollapseCb && !autoCollapseCb.checked) return; // 判断自动收起是否开启
    if (timelineEl.style.display === 'none') return;
    if (e.target.closest('#uiDragHandle')) return;
    uiPendingCollapse = true;
  }, true);
  document.addEventListener('pointerup', () => {
    if (!uiPendingCollapse) return;
    uiPendingCollapse = false;
    setTimeout(() => { if (timelineEl.style.display !== 'none') toggleTimeline(false); }, 0);
  }, true);
  document.addEventListener('pointercancel', () => { uiPendingCollapse = false; }, true);

  /* ==================== 移动端 UI ==================== */

  /* v7.3.0：面板的「收起 / 展开」不再是一颗外部浮钮，而是**底部入口栏自己**：
       点某个入口 → 展开那个分区；再点同一个入口 → 全关，只剩底部栏（#ui.collapsed）。
     具体的开合逻辑在 switchUiSheet()（文件后半段的「控制面板分区」一节），
     这里只负责首屏默认值：手机全关、桌面展开「属性」。 */
  if (isMobile) {
    /* 默认全关 —— 手机上屏幕就这么高，一上来就盖掉半屏画布不合适，只留一条底部入口栏 */
    uiPanel.classList.add('collapsed');
    setTimeout(resize, 100);
    const tip = document.createElement('div');
    tip.innerHTML = ic('tips') + tr2('mobile.gestureTip', '双指拖动平移，捏合缩放');
    tip.className = 'ui-toast mobile-tip';
    document.body.appendChild(tip);
    setTimeout(() => { tip.style.opacity = '0'; }, 2500);
    setTimeout(() => { tip.remove(); }, 3500);
  }

  /* ==================== 时间轴开关 ==================== */
  function toggleTimeline(show) {
    const tl = document.getElementById('timeline');
    const btnShow = document.getElementById('btnShowTimeline');
    if (show) {
      tl.style.display = 'flex';
      btnShow.style.display = 'none';
      TIMELINE_H = 100;
    } else {
      tl.style.display = 'none';
      btnShow.style.display = 'flex';
      TIMELINE_H = 0;
    }
    
    /* v7.3.0：面板开合由底部入口栏自己管（switchUiSheet），这里不用再同步任何浮钮显隐 */

    // 所有的面板位置计算统一交给 refreshTimelineDockOffsets 处理
    refreshTimelineDockOffsets();
    resize();
    /* v7.0.0：时间轴刚展开时帧条还没量过宽度，段曲线要重画一次 */
    if (show && typeof renderKfCurveStrip === 'function') renderKfCurveStrip();
    /* 摄像机视角下，时间轴开关会改变可用区域 → 重新适配，保证取景框不被遮挡 */
    if (isCameraTrackId(AppState.activeTrackId)) {
      SKFE.systems.camera.fitCameraViewToAvailableArea();
      EventBus.emit('need:render');
    }
  }
  document.getElementById('btnShowTimeline').onclick = () => toggleTimeline(true);
  document.getElementById('btnHideTimeline').onclick = () => toggleTimeline(false);

  /* v7.0.4：横向滚动容器的**鼠标**适配。横滑本身对触屏是原生的，但桌面上：
     ① 滚动条被藏了 ② 滚轮只会竖滚 → 溢出后鼠标根本推不动。
     这里补两条：滚轮映射成横向滚动、按住空白处可以像拖地图一样拖。
     v7.0.5：抽成通用函数，底部面板的 #uiBottomBar 也用它。 */
  function bindHorizontalScroll(bar) {
    if (!bar) return;

    /* 滚轮 / Shift+滚轮 / 触控板横滑 → 统一转成横向滚动 */
    bar.addEventListener('wheel', (e) => {
      if (bar.scrollWidth <= bar.clientWidth + 1) return;   /* 没溢出就别拦，让页面正常滚 */
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      bar.scrollLeft += d;
      e.preventDefault();
    }, { passive: false });

    /* 按住空白处拖动（按钮/输入框上不抢事件，否则点不动） */
    let dragging = false, startX = 0, startLeft = 0, moved = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      if (e.target.closest('button, input, select, label, a, .tween-more-menu')) return;
      dragging = true; moved = false;
      startX = e.clientX; startLeft = bar.scrollLeft;
      bar.classList.add('dragging');
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      bar.scrollLeft = startLeft - dx;
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      /* 兜底：万一后面没来 click，别把 moved 永久挂着吞掉下一次点击 */
      setTimeout(() => { moved = false; }, 260);
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    /* 拖完抬手时浏览器还会补一个 click，拦掉，免得误触按钮 */
    bar.addEventListener('click', (e) => {
      if (!moved) return;
      e.stopPropagation(); e.preventDefault(); moved = false;
    }, true);
  }
  bindHorizontalScroll(document.querySelector('.timeline-controls'));
  bindHorizontalScroll(document.getElementById('uiBottomBar'));

  /* ==================== 几何/工具 ==================== */



  /* ==================== 对象工厂 ==================== */
  function makeFigure(x, y, color, lw) {
    return {
      /* v5.7：透视 = 每条线（躯干/双臂/双腿）独立的头、尾粗细倍率。
         骨盆端（body.start + 双腿 start）与脖子端（body.end + 双臂 start）在 UI 层自动同步。
         旧版 11 关节 z 模型已废弃。 */
      spatial: {
        strength: 0,
        lines: SKFE.systems.spatial.defaultLines()
      },
      id: ++uid, type: 'figure', name: 'Stickman',
      /* v7.0.4：默认尺寸 2、线宽 10.5（线宽支持一位小数，见 index.html 的 #lw step=0.1） */
      x, y, color: color || '#111111', lw: lw || 10.5,
      alpha: 1, scale: 2, locked: false,
      rot: 0, mirror: false,
      /* v7.2.1：地面阴影从「工程级全局开关」搬到每个火柴人身上，才能分别打关键帧 */
      shadowEnabled: false, shadowColor: '#000000', shadowAlpha: 0.3,
      shadowOffX: 0, shadowOffY: 0, shadowScaleX: 1, shadowScaleY: 1,
      headFilled: false, headFillCustom: false, headFillColor: '#111111',
      headShape: 'TCO',   /* v7.0.4：默认头型改成 TCO（'circle' | 'Vic' | 'TCO' | 'TDL' | 'TSC'） */
      /* v6.3.0：初始预设改成用户调好的比例（手臂 0.98 / 小臂占比 0.41，其余不变） */
      bodyScale: { head: 1.83, arm: 0.98, leg: 1.16, torso: 0.62, foreArm: 0.41, shin: 0.49 },
      headAngle: -Math.PI / 2 - 15 * Math.PI / 180,
      headOffset: { x: 0, y: 0 },
      light: { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 },
      /* v7.2.0：默认值换成描边阴影的常规参数（右下轻投影），旧字段名保留兼容老工程 */
      glow: { enabled: false, color: '#000000', alpha: 0.45, blur: 14, offsetX: 3, offsetY: -4, spread: 0, includeAcc: false },
      joint: { enabled: false, color: '#ff0000', len: 0.5 },
      jointSmooth: 1,
      extremity: {
        enabled: false,
        armAngleL: 30 * Math.PI / 180, armAngleR: 30 * Math.PI / 180,
        legAngleL: 30 * Math.PI / 180, legAngleR: 30 * Math.PI / 180,
        armRatio: 0.23, legRatio: 0.23
      },
      depth: { enabled: false, useCustom: false, customColor: '#555555' },
      ikEnabled: false,
      /* v5.2.0 四角扭曲（8 点透视变形）：corners 为相对于对象盒中心、以盒宽高为单位的
         像素偏移（TL/TR/BR/BL）。null 表示尚未初始化，开启时按当前 OBB 现场生成。 */
      distort: { enabled: false, corners: null, baseW: 0, baseH: 0 },
      pinned: { footL: false, footR: false, handL: false, handR: false, pelvis: false },
      pinnedPos: { footL: null, footR: null, handL: null, handR: null, pelvis: null },
      layer: { body: 1, head: 2, armL: 1, armR: 1, legL: 1, legR: 1 },
      /* v6.3.0：初始预设 = 基准姿势 + 用户在旋转面板里调好的偏移
         （头部 -15°、左大腿 6°、左小腿 -7°、右大腿 -5°、右小腿 0°、
           左大臂 33°、左小臂 94°、右大臂 -29°、右小臂 103°，腰部 0°、颈部随头部 -15°）
         旋转面板显示的正是"相对下面这些基准值的偏移"，所以这里加上偏移后，
         新建的火柴人一出来就是截图里的那组数字。 */
      a: {
        torso: -Math.PI / 2, waist: 0,
        armL: { u: Math.PI + 0.18 + 33 * Math.PI / 180, f: 0.12 + 94 * Math.PI / 180 },
        armR: { u: Math.PI - 0.18 - 29 * Math.PI / 180, f: -0.12 + 103 * Math.PI / 180 },
        legL: { u: Math.PI + 0.10 + 6 * Math.PI / 180, f: -0.05 - 7 * Math.PI / 180 },
        legR: { u: Math.PI - 0.10 - 5 * Math.PI / 180, f: 0.05 }
      }
    };
  }

  function makeImage(img, x, y) {
    const maxW = 360;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const r = Math.min(1, maxW / w);
    w *= r; h *= r;
    return { id: ++uid, type: 'image', name: 'Image', img, x, y, w, h, alpha: 1, scale: 1, layer: 1, locked: false, rot: 0, mirror: false, ax: 0, ay: 0, distort: makeDistortField() };
  }

  function makeShape(shapeType, x, y) {
    return {
      id: ++uid, type: 'shape', shape: shapeType, name: 'Shape',
      x, y, w: 60, h: 60, alpha: 1, scale: 1, layer: 1, locked: false,
      fillColor: '#ff6b6b', strokeColor: '#333333', strokeWidth: 0,
      bindTo: 'none', targetId: null, offX: 0, offY: 0, rot: 0, ax: 0, ay: 0, mirror: false,
      distort: makeDistortField()
    };
  }

  function makeAccessory(img, x, y) {
    const maxW = 120;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const r = Math.min(1, maxW / w);
    w *= r; h *= r;
    return {
      id: ++uid, type: 'acc', name: 'Accessory',
      img, x, y, w, h, alpha: 1, scale: 1, layer: 1, locked: false,
      bindTo: 'none', targetId: null, offX: 0, offY: 0, rot: 0, ax: 0, ay: 0, mirror: false,
      distort: makeDistortField()
    };
  }

  function makeBubble(x, y) {
    return {
      id: ++uid, type: 'bubble', name: 'Bubble',
      x, y, w: 180, h: 90, alpha: 1, scale: 1, layer: 1, locked: false,
      text: '双击编辑文字',
      textColor: '#000000', isGradient: false, gradientColor: '#4a90ff',
      fontSize: 20, fillColor: '#ffffff', strokeColor: '#000000', strokeWidth: 2,
      isMirrored: false, customSize: false, customW: 180, customH: 90,
      bindTo: 'none', targetId: null, offX: 0, offY: 0, rot: 0, ax: 0, ay: 0,
      distort: makeDistortField()
    };
  }

  /* v5.2.0 四角扭曲默认字段（corners 为 null 时在开启瞬间按 OBB 生成） */
  function makeDistortField() {
    return { enabled: false, corners: null, baseW: 0, baseH: 0 };
  }

  function generateName(obj) {
    if (obj.type === 'figure') { counts.figure++; obj.name = 'Stickman' + counts.figure; }
    else if (obj.type === 'image') { counts.image++; obj.name = 'Image' + counts.image; }
    else if (obj.type === 'acc') { counts.acc++; obj.name = 'Acc' + counts.acc; }
    else if (obj.type === 'shape') {
      counts.shape++;
      const map = { circle: 'Circle', rect: 'Square', tri: 'Triangle' };
      obj.name = map[obj.shape] + counts.shape;
    } else if (obj.type === 'bubble') { counts.bubble++; obj.name = 'Bubble' + counts.bubble; }
    else if (obj.type === 'camera') { counts.camera = (counts.camera || 0) + 1; obj.name = 'Camera' + counts.camera; }
    else if (obj.type === 'ink') { counts.ink = (counts.ink || 0) + 1; obj.name = 'Ink' + counts.ink; } // brush-v5.1.0: §6.3.9
  }

  /* ==================== 末端样式 ==================== */
  function ensureExtremity(f) {
    if (!f.extremity) {
      f.extremity = {
        enabled: false,
        armAngleL: 30 * Math.PI / 180, armAngleR: 30 * Math.PI / 180,
        legAngleL: 30 * Math.PI / 180, legAngleR: 30 * Math.PI / 180,
        armRatio: 0.23, legRatio: 0.23
      };
    }
    const ex = f.extremity;
    if (ex.armRatio == null) ex.armRatio = 0.23;
    if (ex.legRatio == null) ex.legRatio = 0.23;
    if (ex.armAngleL == null) ex.armAngleL = 30 * Math.PI / 180;
    if (ex.armAngleR == null) ex.armAngleR = 30 * Math.PI / 180;
    if (ex.legAngleL == null) ex.legAngleL = 30 * Math.PI / 180;
    if (ex.legAngleR == null) ex.legAngleR = 30 * Math.PI / 180;
    return ex;
  }

  /* ==================== 关节计算 ==================== */
  function jointData(f) {
    const a = f.a, s = f.bodyScale, g = f.scale;
    const torsoLen = P.torso * s.torso * g;
    const headR = P.headR * s.head * g;
    const armBase = P.upperArm + P.foreArm;
    const legBase = P.thigh + P.shin;
    const fArmRatio = (s.foreArm !== undefined) ? s.foreArm : 0.37;
    const shinRatio = (s.shin !== undefined) ? s.shin : 0.49;
    const armRatioL = (s.foreArmL !== undefined) ? s.foreArmL : fArmRatio;
    const armRatioR = (s.foreArmR !== undefined) ? s.foreArmR : fArmRatio;
    const legRatioL = (s.shinL !== undefined) ? s.shinL : shinRatio;
    const legRatioR = (s.shinR !== undefined) ? s.shinR : shinRatio;
    const armScaleL = (s.armL !== undefined) ? s.armL : s.arm;
    const armScaleR = (s.armR !== undefined) ? s.armR : s.arm;
    const legScaleL = (s.legL !== undefined) ? s.legL : s.leg;
    const legScaleR = (s.legR !== undefined) ? s.legR : s.leg;
    const uArmL = armBase * (1 - armRatioL) * armScaleL * g;
    const fArmL = armBase * armRatioL * armScaleL * g;
    const uArmR = armBase * (1 - armRatioR) * armScaleR * g;
    const fArmR = armBase * armRatioR * armScaleR * g;
    const thighLenL = legBase * (1 - legRatioL) * legScaleL * g;
    const shinLenL = legBase * legRatioL * legScaleL * g;
    const thighLenR = legBase * (1 - legRatioR) * legScaleR * g;
    const shinLenR = legBase * legRatioR * legScaleR * g;
    const pelvis = { x: f.x, y: f.y };
    const waistPoint = along(pelvis, a.torso, torsoLen / 2);
    const neck = along(waistPoint, a.torso + a.waist, torsoLen / 2);
    let headC = along(neck, f.headAngle, headR);
    if (f.headOffset) {
      headC.x += f.headOffset.x;
      headC.y += f.headOffset.y;
    }
    const uArmAngleL = a.torso + a.waist + a.armL.u;
    const elbowL = along(neck, uArmAngleL, uArmL);
    const uArmAngleR = a.torso + a.waist + a.armR.u;
    const elbowR = along(neck, uArmAngleR, uArmR);
    const thighL = along(pelvis, a.torso + a.legL.u, thighLenL);
    const thighR = along(pelvis, a.torso + a.legR.u, thighLenR);
    const ext = f.extremity || { enabled: false };
    let handL, handR, footL, footR, wristL, wristR, toeL, toeR;
    if (ext.enabled) {
      const armExtRatio = (ext.armRatio != null ? ext.armRatio : 0.23);
      const mainArmL = fArmL * (1 - armExtRatio);
      const extArmLenL = fArmL * armExtRatio;
      handL = along(elbowL, uArmAngleL + a.armL.f, mainArmL);
      wristL = along(handL, uArmAngleL + a.armL.f + (ext.armAngleL || 0), extArmLenL);
      const mainArmR = fArmR * (1 - armExtRatio);
      const extArmLenR = fArmR * armExtRatio;
      handR = along(elbowR, uArmAngleR + a.armR.f, mainArmR);
      wristR = along(handR, uArmAngleR + a.armR.f + (ext.armAngleR || 0), extArmLenR);
      const legExtRatio = (ext.legRatio != null ? ext.legRatio : 0.23);
      const mainLegL = shinLenL * (1 - legExtRatio);
      const extLegLenL = shinLenL * legExtRatio;
      footL = along(thighL, a.torso + a.legL.u + a.legL.f, mainLegL);
      toeL = along(footL, a.torso + a.legL.u + a.legL.f + (ext.legAngleL || 0), extLegLenL);
      const mainLegR = shinLenR * (1 - legExtRatio);
      const extLegLenR = shinLenR * legExtRatio;
      footR = along(thighR, a.torso + a.legR.u + a.legR.f, mainLegR);
      toeR = along(footR, a.torso + a.legR.u + a.legR.f + (ext.legAngleR || 0), extLegLenR);
    } else {
      handL = along(elbowL, uArmAngleL + a.armL.f, fArmL);
      handR = along(elbowR, uArmAngleR + a.armR.f, fArmR);
      footL = along(thighL, a.torso + a.legL.u + a.legL.f, shinLenL);
      footR = along(thighR, a.torso + a.legR.u + a.legR.f, shinLenR);
      wristL = handL; wristR = handR; toeL = footL; toeR = footR;
    }
    return { pelvis, waistPoint, neck, headC, headR, elbowL, handL, elbowR, handR, thighL, footL, thighR, footR, wristL, wristR, toeL, toeR };
  }

  /* ==================== 关节拉伸计算 ==================== */
  function stretchJoint(o, part, pLocal) {
    if (!o.bodyScale) return;
    const g = o.scale || 1;
    const armBase = P.upperArm + P.foreArm;
    const legBase = P.thigh + P.shin;
    
    const clampTotal = (v) => Math.max(0.1, Math.min(5.0, v));
    const clampRatio = (v) => Math.max(0.05, Math.min(0.95, v));
    const j = jointData(o); // 获取当前（计算前）的关节位置

    // --- 左臂：拖手（大臂绝对长度不变，小臂变） ---
    if (part === 'handL') {
      const U_old = (o.bodyScale.armL !== undefined ? o.bodyScale.armL : o.bodyScale.arm) * armBase * (1 - (o.bodyScale.foreArmL !== undefined ? o.bodyScale.foreArmL : o.bodyScale.foreArm));
      const dist = Math.hypot(pLocal.x - j.elbowL.x, pLocal.y - j.elbowL.y) / g;
      const F_new = dist;
      
      const newTotal = clampTotal((U_old + F_new) / armBase);
      o.bodyScale.armL = newTotal;
      o.bodyScale.foreArmL = clampRatio(F_new / (U_old + F_new));
      
      const targetAngle = Math.atan2(pLocal.y - j.elbowL.y, pLocal.x - j.elbowL.x);
      o.a.armL.f = norm(targetAngle - (o.a.torso + o.a.waist + o.a.armL.u));

      setGlobalProp(o, 'bodyScale.armL', o.bodyScale.armL);
      setGlobalProp(o, 'bodyScale.foreArmL', o.bodyScale.foreArmL);
    } 
    // --- 左臂：拖肘（小臂绝对长度不变，大臂变） ---
    else if (part === 'elbowL') {
      const F_old = (o.bodyScale.armL !== undefined ? o.bodyScale.armL : o.bodyScale.arm) * armBase * (o.bodyScale.foreArmL !== undefined ? o.bodyScale.foreArmL : o.bodyScale.foreArm);
      const dist = Math.hypot(pLocal.x - j.neck.x, pLocal.y - j.neck.y) / g;
      const U_new = dist;
      
      const newTotal = clampTotal((U_new + F_old) / armBase);
      o.bodyScale.armL = newTotal;
      o.bodyScale.foreArmL = clampRatio(F_old / (U_new + F_old));
      
      const targetAngle = Math.atan2(pLocal.y - j.neck.y, pLocal.x - j.neck.x);
      o.a.armL.u = norm(targetAngle - (o.a.torso + o.a.waist));

      setGlobalProp(o, 'bodyScale.armL', o.bodyScale.armL);
      setGlobalProp(o, 'bodyScale.foreArmL', o.bodyScale.foreArmL);
    }
    // --- 右臂：拖手 ---
    else if (part === 'handR') {
      const U_old = (o.bodyScale.armR !== undefined ? o.bodyScale.armR : o.bodyScale.arm) * armBase * (1 - (o.bodyScale.foreArmR !== undefined ? o.bodyScale.foreArmR : o.bodyScale.foreArm));
      const dist = Math.hypot(pLocal.x - j.elbowR.x, pLocal.y - j.elbowR.y) / g;
      const F_new = dist;
      
      const newTotal = clampTotal((U_old + F_new) / armBase);
      o.bodyScale.armR = newTotal;
      o.bodyScale.foreArmR = clampRatio(F_new / (U_old + F_new));
      
      const targetAngle = Math.atan2(pLocal.y - j.elbowR.y, pLocal.x - j.elbowR.x);
      o.a.armR.f = norm(targetAngle - (o.a.torso + o.a.waist + o.a.armR.u));

      setGlobalProp(o, 'bodyScale.armR', o.bodyScale.armR);
      setGlobalProp(o, 'bodyScale.foreArmR', o.bodyScale.foreArmR);
    } 
    // --- 右臂：拖肘 ---
    else if (part === 'elbowR') {
      const F_old = (o.bodyScale.armR !== undefined ? o.bodyScale.armR : o.bodyScale.arm) * armBase * (o.bodyScale.foreArmR !== undefined ? o.bodyScale.foreArmR : o.bodyScale.foreArm);
      const dist = Math.hypot(pLocal.x - j.neck.x, pLocal.y - j.neck.y) / g;
      const U_new = dist;
      
      const newTotal = clampTotal((U_new + F_old) / armBase);
      o.bodyScale.armR = newTotal;
      o.bodyScale.foreArmR = clampRatio(F_old / (U_new + F_old));
      
      const targetAngle = Math.atan2(pLocal.y - j.neck.y, pLocal.x - j.neck.x);
      o.a.armR.u = norm(targetAngle - (o.a.torso + o.a.waist));

      setGlobalProp(o, 'bodyScale.armR', o.bodyScale.armR);
      setGlobalProp(o, 'bodyScale.foreArmR', o.bodyScale.foreArmR);
    }
    // --- 左腿：拖脚（大腿绝对长度不变，小腿变） ---
    else if (part === 'footL') {
      const T_old = (o.bodyScale.legL !== undefined ? o.bodyScale.legL : o.bodyScale.leg) * legBase * (1 - (o.bodyScale.shinL !== undefined ? o.bodyScale.shinL : o.bodyScale.shin));
      const dist = Math.hypot(pLocal.x - j.thighL.x, pLocal.y - j.thighL.y) / g;
      const S_new = dist;
      
      const newTotal = clampTotal((T_old + S_new) / legBase);
      o.bodyScale.legL = newTotal;
      o.bodyScale.shinL = clampRatio(S_new / (T_old + S_new));
      
      const targetAngle = Math.atan2(pLocal.y - j.thighL.y, pLocal.x - j.thighL.x);
      o.a.legL.f = norm(targetAngle - (o.a.torso + o.a.legL.u));

      setGlobalProp(o, 'bodyScale.legL', o.bodyScale.legL);
      setGlobalProp(o, 'bodyScale.shinL', o.bodyScale.shinL);
    }
    // --- 左腿：拖膝（小腿绝对长度不变，大腿变） ---
    else if (part === 'kneeL') {
      const S_old = (o.bodyScale.legL !== undefined ? o.bodyScale.legL : o.bodyScale.leg) * legBase * (o.bodyScale.shinL !== undefined ? o.bodyScale.shinL : o.bodyScale.shin);
      const dist = Math.hypot(pLocal.x - j.pelvis.x, pLocal.y - j.pelvis.y) / g;
      const T_new = dist;
      
      const newTotal = clampTotal((T_new + S_old) / legBase);
      o.bodyScale.legL = newTotal;
      o.bodyScale.shinL = clampRatio(S_old / (T_new + S_old));
      
      const targetAngle = Math.atan2(pLocal.y - j.pelvis.y, pLocal.x - j.pelvis.x);
      o.a.legL.u = norm(targetAngle - o.a.torso);

      setGlobalProp(o, 'bodyScale.legL', o.bodyScale.legL);
      setGlobalProp(o, 'bodyScale.shinL', o.bodyScale.shinL);
    }
    // --- 右腿：拖脚 ---
    else if (part === 'footR') {
      const T_old = (o.bodyScale.legR !== undefined ? o.bodyScale.legR : o.bodyScale.leg) * legBase * (1 - (o.bodyScale.shinR !== undefined ? o.bodyScale.shinR : o.bodyScale.shin));
      const dist = Math.hypot(pLocal.x - j.thighR.x, pLocal.y - j.thighR.y) / g;
      const S_new = dist;
      
      const newTotal = clampTotal((T_old + S_new) / legBase);
      o.bodyScale.legR = newTotal;
      o.bodyScale.shinR = clampRatio(S_new / (T_old + S_new));
      
      const targetAngle = Math.atan2(pLocal.y - j.thighR.y, pLocal.x - j.thighR.x);
      o.a.legR.f = norm(targetAngle - (o.a.torso + o.a.legR.u));

      setGlobalProp(o, 'bodyScale.legR', o.bodyScale.legR);
      setGlobalProp(o, 'bodyScale.shinR', o.bodyScale.shinR);
    }
    // --- 右腿：拖膝 ---
    else if (part === 'kneeR') {
      const S_old = (o.bodyScale.legR !== undefined ? o.bodyScale.legR : o.bodyScale.leg) * legBase * (o.bodyScale.shinR !== undefined ? o.bodyScale.shinR : o.bodyScale.shin);
      const dist = Math.hypot(pLocal.x - j.pelvis.x, pLocal.y - j.pelvis.y) / g;
      const T_new = dist;
      
      const newTotal = clampTotal((T_new + S_old) / legBase);
      o.bodyScale.legR = newTotal;
      o.bodyScale.shinR = clampRatio(S_old / (T_new + S_old));
      
      const targetAngle = Math.atan2(pLocal.y - j.pelvis.y, pLocal.x - j.pelvis.x);
      o.a.legR.u = norm(targetAngle - o.a.torso);

      setGlobalProp(o, 'bodyScale.legR', o.bodyScale.legR);
      setGlobalProp(o, 'bodyScale.shinR', o.bodyScale.shinR);
    }
    // --- 躯干：拖腰 ---
    else if (part === 'waist') {
      const dist = Math.hypot(pLocal.x - j.pelvis.x, pLocal.y - j.pelvis.y) / g;
      o.bodyScale.torso = clampTotal((dist * 2) / P.torso);
      
      const targetAngle = Math.atan2(pLocal.y - j.pelvis.y, pLocal.x - j.pelvis.x);
      const newTorsoAngle = norm(targetAngle);
      const deltaTorso = norm(newTorsoAngle - o.a.torso);
      o.a.torso = newTorsoAngle;
      o.a.legL.u = norm(o.a.legL.u - deltaTorso);
      o.a.legR.u = norm(o.a.legR.u - deltaTorso);
      
      setGlobalProp(o, 'bodyScale.torso', o.bodyScale.torso);
    }
  }

  /* ==================== v5.3.1 挂载贴膜（bound skinning） ==================== */
  /* 父火柴人被四角扭曲后，挂在它身上的元件（配饰/图形/对话框/画笔）必须一起走。
     做法不是"给配饰单独算一个近似变换"，而是让它【继承父级的单应性】：
     distort.getMapping(child) 会把父级的 H 换到子对象自己的盒空间里再做一次合成，
     于是配饰的每一个像素和火柴人身体走的是同一个投影 —— 视觉上就是"整张图一起变形"。
     这里只负责告诉 distort 模块"我的父级是谁、它现在是什么映射"。 */
  function getParentWarp(obj) {
    const DZ = SKFE.systems.distort;
    if (!DZ || !obj || obj.type === 'figure') return null;
    if (!DZ.supports(obj)) return null;              /* 不支持的元件不参与，避免白算 */
    if (obj.bindTo === 'none' || !obj.targetId) return null;
    const list = _renderList || AppState.objects;
    const fig = list.find(o => o.id === obj.targetId && o.type === 'figure');
    if (!fig || !DZ.isActive(fig)) return null;
    return DZ.getMapping(fig);
  }

  function getBindTransform(obj) {
    if (obj.bindTo === 'none' || !obj.targetId) {
      return { x: obj.x, y: obj.y, angle: (obj.rot || 0) * Math.PI / 180, syncScale: 1 };
    }
    const list = _renderList || AppState.objects;
    const fig = list.find(o => o.id === obj.targetId && o.type === 'figure');
    if (!fig) return { x: obj.x, y: obj.y, angle: (obj.rot || 0) * Math.PI / 180, syncScale: 1 };
    const j = jointData(fig);
    let baseX = 0, baseY = 0, baseAngle = 0;
    switch (obj.bindTo) {
      /* ---- 躯干 ---- */
      case 'head':
        baseX = j.headC.x; baseY = j.headC.y;
        baseAngle = fig.headAngle;
        break;
      case 'neck':
      case 'torso_upper':  /* 旧值兼容 → 映射到颈部 */
        baseX = j.neck.x; baseY = j.neck.y;
        baseAngle = fig.a.torso + fig.a.waist;
        break;
      case 'waist':
      case 'torso_lower':  /* 旧值兼容 → 映射到腰部 */
        baseX = j.waistPoint.x; baseY = j.waistPoint.y;
        baseAngle = fig.a.torso;
        break;
      case 'pelvis':
        baseX = j.pelvis.x; baseY = j.pelvis.y;
        baseAngle = fig.a.torso;
        break;

      /* ---- 上肢 ---- */
      case 'elbowL':
        baseX = j.elbowL.x; baseY = j.elbowL.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armL.u;
        break;
      case 'elbowR':
        baseX = j.elbowR.x; baseY = j.elbowR.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armR.u;
        break;
      case 'handL':
        baseX = j.handL.x; baseY = j.handL.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armL.u + fig.a.armL.f;
        break;
      case 'handR':
        baseX = j.handR.x; baseY = j.handR.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armR.u + fig.a.armR.f;
        break;

      /* ---- 下肢 ---- */
      case 'kneeL':
        baseX = j.thighL.x; baseY = j.thighL.y;
        baseAngle = fig.a.torso + fig.a.legL.u;
        break;
      case 'kneeR':
        baseX = j.thighR.x; baseY = j.thighR.y;
        baseAngle = fig.a.torso + fig.a.legR.u;
        break;
      case 'footL':
        baseX = j.footL.x; baseY = j.footL.y;
        baseAngle = fig.a.torso + fig.a.legL.u + fig.a.legL.f;
        break;
      case 'footR':
        baseX = j.footR.x; baseY = j.footR.y;
        baseAngle = fig.a.torso + fig.a.legR.u + fig.a.legR.f;
        break;
    }
    const g = fig.scale;
    const offX = obj.offX * g, offY = obj.offY * g;
    const finalX = baseX + Math.cos(baseAngle) * offX - Math.sin(baseAngle) * offY;
    const finalY = baseY + Math.sin(baseAngle) * offX + Math.cos(baseAngle) * offY;
    return {
      x: finalX, y: finalY,
      angle: baseAngle + (obj.rot || 0) * Math.PI / 180,
      syncScale: g
    };
  }

  function getHandles(j, f) {
    const list = [
      { name: 'pelvis', p: j.pelvis },
      { name: 'waist', p: j.waistPoint },
      { name: 'neck', p: j.neck },
      { name: 'head', p: j.headC },
      { name: 'elbowL', p: j.elbowL }, { name: 'handL', p: j.handL },
      { name: 'elbowR', p: j.elbowR }, { name: 'handR', p: j.handR },
      { name: 'kneeL', p: j.thighL }, { name: 'footL', p: j.footL },
      { name: 'kneeR', p: j.thighR }, { name: 'footR', p: j.footR }
    ];
    if (f && f.extremity && f.extremity.enabled) {
      list.push({ name: 'wristL', p: j.wristL });
      list.push({ name: 'wristR', p: j.wristR });
      list.push({ name: 'toeL', p: j.toeL });
      list.push({ name: 'toeR', p: j.toeR });
    }
    return list;
  }

  function segments(j, f) {
    const list = [
      [j.pelvis, j.waistPoint], [j.waistPoint, j.neck],
      [j.neck, j.elbowL], [j.elbowL, j.handL],
      [j.neck, j.elbowR], [j.elbowR, j.handR],
      [j.pelvis, j.thighL], [j.thighL, j.footL],
      [j.pelvis, j.thighR], [j.thighR, j.footR]
    ];
    if (f && f.extremity && f.extremity.enabled) {
      list.push([j.handL, j.wristL]);
      list.push([j.handR, j.wristR]);
      list.push([j.footL, j.toeL]);
      list.push([j.footR, j.toeR]);
    }
    return list;
  }

  /* ==================== 绘制基础 ==================== */
  function drawGrid(w, h) {
    const s = Math.max(8, gridSize);
    const x0 = -AppState.viewOffset.x / AppState.viewScale;
    const y0 = -AppState.viewOffset.y / AppState.viewScale;
    const x1 = (canvas.clientWidth - AppState.viewOffset.x) / AppState.viewScale;
    const y1 = (canvas.clientHeight - AppState.viewOffset.y) / AppState.viewScale;

    if (gridEnabled) {
      ctx.fillStyle = 'rgba(120,140,170,0.40)';
      const startX = Math.floor(x0 / s) * s;
      const startY = Math.floor(y0 / s) * s;
      for (let x = startX; x <= x1; x += s) {
        for (let y = startY; y <= y1; y += s) {
          ctx.beginPath(); ctx.arc(x, y, 1, 0, TAU); ctx.fill();
        }
      }
    }
    ctx.save();
    ctx.strokeStyle = 'rgba(120,140,170,0.75)';
    ctx.lineWidth = 1 / AppState.viewScale;
    ctx.beginPath();
    ctx.moveTo(-8 / AppState.viewScale, 0); ctx.lineTo(8 / AppState.viewScale, 0);
    ctx.moveTo(0, -8 / AppState.viewScale); ctx.lineTo(0, 8 / AppState.viewScale);
    ctx.stroke();
    ctx.restore();
  }

  function drawGroundLine() {
    const y = groundLineY;
    ctx.save();
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5 / AppState.viewScale;
    ctx.setLineDash([10 / AppState.viewScale, 6 / AppState.viewScale]);
    ctx.beginPath();
    ctx.moveTo(-100000, y);
    ctx.lineTo(100000, y);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.fillStyle = '#10b981';
    ctx.font = `bold ${12 / AppState.viewScale}px system-ui`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const screenLeftX = -AppState.viewOffset.x / AppState.viewScale + 10 / AppState.viewScale;
    ctx.fillText(`Y: ${Math.round(displayY(y))}`, screenLeftX, y - 4 / AppState.viewScale);
    ctx.restore();
  }

  function drawCanvasBounds() {
    if (!AppState.canvasBoundsEnabled) return;
    if (canvasMaskEnabled && canvasMaskAlpha >= 0.99) return;
    ctx.save();
    ctx.translate(AppState.canvasBounds.x + AppState.canvasBounds.w / 2, AppState.canvasBounds.y + AppState.canvasBounds.h / 2);
    ctx.rotate(AppState.canvasBounds.rotation || 0);
    ctx.strokeStyle = AppState.canvasSelected ? '#1f5fcc' : '#4a90ff';
    ctx.lineWidth = (AppState.canvasSelected ? 3 : 2) / AppState.viewScale;
    ctx.setLineDash([8 / AppState.viewScale, 8 / AppState.viewScale]);
    if (AppState.canvasSelected) {
      ctx.fillStyle = 'rgba(74, 144, 255, 0.08)';
      ctx.fillRect(-AppState.canvasBounds.w / 2, -AppState.canvasBounds.h / 2, AppState.canvasBounds.w, AppState.canvasBounds.h);
    }
    ctx.strokeRect(-AppState.canvasBounds.w / 2, -AppState.canvasBounds.h / 2, AppState.canvasBounds.w, AppState.canvasBounds.h);
    if (AppState.canvasSelected) {
      ctx.setLineDash([]);
      ctx.font = `bold ${14 / AppState.viewScale}px system-ui, sans-serif`;
      ctx.fillStyle = '#4a90ff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▲ 上', 0, -AppState.canvasBounds.h / 2 - 16 / AppState.viewScale);
      ctx.fillText('▼ 下', 0, AppState.canvasBounds.h / 2 + 16 / AppState.viewScale);
    }
    ctx.restore();
  }

  function smoothPolyline(pts, radius) {
    if (pts.length < 2) return;
    if (pts.length === 2 || radius <= 0.1) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
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

  function drawLimbEndCaps(pts, lw, fillStyle) {
    if (!pts || pts.length < 2 || lw <= 0) return;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const half = lw / 2;
    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.beginPath(); ctx.arc(start.x, start.y, half, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(end.x, end.y, half, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawLimbWithGradient(f, pts, radius, startT, tint, baseColor) {
    const startIdx = pts[0], endIdx = pts[pts.length - 1];
    const g = ctx.createLinearGradient(startIdx.x, startIdx.y, endIdx.x, endIdx.y);
    const tt = Math.max(0, Math.min(1, startT));
    const c0 = tint || baseColor || f.color;
    const c1 = tint || f.joint.color;
    g.addColorStop(0, c0); g.addColorStop(tt, c0); g.addColorStop(1, c1);
    ctx.strokeStyle = g;
    ctx.lineCap = 'round';
    ctx.beginPath(); smoothPolyline(pts, radius); ctx.stroke();
    drawLimbEndCaps(pts, ctx.lineWidth, g);
  }

  function drawSmoothBubble(ctx2, w, h, lw, strokeColor, fillColor) {
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
    ctx2.beginPath();
    ctx2.moveTo(x + r, y);
    ctx2.lineTo(x + w - r, y);
    ctx2.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx2.lineTo(x + w, y + h - r);
    ctx2.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx2.lineTo(tailRightX, y + h);
    ctx2.lineTo(tailCenterX, y + h + tailLength);
    ctx2.lineTo(tailLeftX, y + h);
    ctx2.lineTo(x + r, y + h);
    ctx2.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx2.lineTo(x, y + r);
    ctx2.quadraticCurveTo(x, y, x + r, y);
    ctx2.closePath();
    if (fillColor !== 'transparent') { ctx2.fillStyle = fillColor; ctx2.fill(); }
    if (lw > 0) {
      ctx2.lineWidth = lw; ctx2.strokeStyle = strokeColor;
      ctx2.lineJoin = 'round'; ctx2.lineCap = 'round'; ctx2.stroke();
    }
  }

  let renderQueue = [];

  /* ==================== v6.4.0 手绘头型 ==================== */
  /* 当前 figure 选中的手绘头型；正圆或无效值返回 null，调用方走原来的 arc 逻辑 */
  function headShapeOf(f) {
    const id = f && f.headShape;
    if (!id || id === 'circle') return null;
    const HS = SKFE.systems.headShapes;
    if (!HS || !HS.has(id)) return null;
    return id;
  }

  /* 头型朝向：headAngle 是「颈部 → 头心」的方向角，手绘头型默认正立，所以补 90°。
     正圆是对称的，这个角度对它没有影响 —— 这样"圆头能转，头型也能转"是同一套逻辑。 */
  function headShapeAngle(f) {
    return (f.headAngle || 0) + Math.PI / 2;
  }

  /* 遮罩挖空半径：肢体/躯干要在这个半径以内被裁掉，不能画进头环里。
     正圆用「外沿往里收半个线宽」；手绘头型用内孔比例（每个头型不一样）。 */
  function headHoleRadius(f, j, curLW) {
    const shapeId = headShapeOf(f);
    if (shapeId) {
      const r = SKFE.systems.headShapes.innerRatio(shapeId);
      return Math.max(0, j.headR * (r || 0.7));
    }
    return Math.max(0, j.headR - curLW / 2);
  }

  /* v6.4.1：遮罩挖空改成一次调用。
     正圆仍用「圆」近似；手绘头型直接用它的**内孔路径**（evenodd = 全屏减内孔），
     遮罩边界和头型内沿完全重合。之前用圆近似，圆不是内孔的形状、圆心还有偏移，
     某些方向会捅进头环里，把已经画好的头啃出一道月牙缺口。 */
  function clipOutHeadHole(c, f, j, curLW) {
    const HS = SKFE.systems.headShapes;
    const shapeId = headShapeOf(f);
    if (HS && shapeId && HS.holeClip) {
      if (HS.holeClip(c, shapeId, j.headC.x, j.headC.y, j.headR, headShapeAngle(f))) return;
    }
    c.beginPath();
    c.rect(-10000, -10000, 20000, 20000);
    c.arc(j.headC.x, j.headC.y, headHoleRadius(f, j, curLW), 0, TAU, true);
    c.clip();
  }

  /* 头型自身的「线宽」= 环的厚度。手绘头型的粗细是图形自带的、不吃线条滑块，
     所以头部高光的倍数要以它为基准，否则（拿身体线宽算）会描出一圈比头环还粗的光。
     正圆没有这个问题：它的环厚就是 curLW。 */
  function headRingWidth(j, shapeId) {
    const HS = SKFE.systems.headShapes;
    const r = HS && shapeId ? HS.innerRatio(shapeId) : 0;
    return Math.max(1, j.headR - j.headR * (r || 0));
  }

  /* 用给定颜色画一次头型。
     mode: 'ring'（空心环）| 'solid'（实心盘）| 'inner'（环 + 内孔填 innerColor）
         | 'stroke'（沿轮廓描边）| 'grow'（把环整体加厚 grow 像素，高光用）
     strokeWidth 只在 'stroke' / 'grow' 模式下用，单位是「屏幕/世界像素」，内部会自动除以缩放系数。
     返回 true 表示画过了，调用方不要再走 arc 分支 */
  function paintHeadShape(c, j, f, shapeId, color, mode, innerColor, strokeWidth) {
    const HS = SKFE.systems.headShapes;
    if (!HS || !shapeId) return false;
    const ang = headShapeAngle(f);
    return HS.draw(c, shapeId, j.headC.x, j.headC.y, j.headR, ang, (p, k, s, pOuter) => {
      if (mode === 'stroke') {
        c.strokeStyle = color;
        c.lineWidth = (strokeWidth || 1) / (k || 1);   /* 换算回头型局部坐标 */
        c.stroke(p);
        return;
      }
      if (mode === 'grow') {
        /* 高光：把整个环按 grow 像素加厚（内外各长 grow），而不是沿外轮廓描一圈粗边。
           这样和正圆头的高光语义一致——只有「超出原线条」的那一点点露出来，
           高光粗细才是原线条的倍数，而不是半个线宽直接捅出剪影外。 */
        c.fillStyle = color;
        c.fill(p, 'evenodd');
        if (strokeWidth > 0) {
          c.strokeStyle = color;
          c.lineWidth = strokeWidth * 2 / (k || 1);    /* 描边以轮廓为中心，两边各长 grow */
          c.stroke(p);
        }
        return;
      }
      if (mode === 'solid') {
        /* 用单独的外轮廓路径填：两个子路径方向相反，nonzero 直接 fill 会留孔 */
        c.fillStyle = color;
        c.fill(pOuter || p);
        return;
      }
      if (mode === 'inner') {
        /* 先铺满内盘，再用 evenodd 把环盖上去 —— 顺序反了环会被内盘吃掉 */
        c.fillStyle = innerColor;
        c.fill(pOuter || p);
        c.fillStyle = color;
        c.fill(p, 'evenodd');
        return;
      }
      c.fillStyle = color;
      c.fill(p, 'evenodd');
    });
  }

  /* ==================== 描边阴影（v7.2.0，原「轮廓外发光」） ====================
     剪影不再是「手画一遍线条」，而是把【人物 + 勾选的绑定件】整组交给
     renderScene() 走正常渲染管线画进离屏，再压成一个纯色罩子。
     这样画笔(ink)、形状、对话框、配饰、扭曲……全都不用手写第二套画法。

     两个曾经踩过的坑，写在这里免得再犯：
     ① 剪影离屏必须按**当前设备比例**开（k = hypot(m.a, m.b)）。
        1:1 画完再放大，边缘会被重采样成毛边 —— 羽化滑条拉到 0 还是一圈糊边，
        就是这个原因（不是羽化没关掉）。
     ② 不能用主画布的 ctx.shadow*：shadowBlur / shadowOffset 是设备像素、不吃 CTM，
        为了让阴影和本体分开又得把源图推到画布外，缩放一大 Chrome 就整块裁掉。 */

  /* 描边阴影的调试输出：只有 ?debug=1 且打开 __glowDebug 时才写，平时零开销 */
  function gdbg(k, v) {
    if (!window.__glowDebug) return;
    if (!window.__glowDbg) window.__glowDbg = {};
    window.__glowDbg[k] = v;
  }

  /* 挂在这个火柴人身上的所有绑定件（配饰 / 画笔 / 形状 / 对话框 / 图片） */
  function boundObjsOf(f) {
    const list = _renderList || AppState.objects || [];
    const out = [];
    for (const o of list) {
      if (!o || o === f || o.hidden) continue;
      if (o.type === 'camera' || o.type === 'figure' || o.type === 'video') continue;
      if (o.bindTo === 'none' || !o.targetId) continue;
      if (String(o.targetId) !== String(f.id)) continue;
      out.push(o);
    }
    return out;
  }

  function drawFigureGlow(f, j, curLW, radius, alphaMul, armLpts, armRpts, legLpts, legRpts) {
    const gBlur = Math.max(0, +f.glow.blur || 0);
    const gSpread = Math.max(0, +f.glow.spread || 0);
    const gOffX = +f.glow.offsetX || 0;
    /* 面板上的 Y 正数 = 向上（和坐标输入、Y 轴吸附保持同一套 displayY 约定），
       画布 y 轴向下，所以这里取负。 */
    const gOffY = -(+f.glow.offsetY || 0);
    const gColor = f.glow.color || '#000000';
    const group = f.glow.includeAcc ? boundObjsOf(f) : [];
    gdbg('inc', !!f.glow.includeAcc);
    gdbg('ids', group.map(o => o.id + ':' + o.type));

    /* ---- 包围盒：人物 + 并进来的绑定件（统一用 getObjectBounds，各类型都覆盖到了） ----
       任何一个元件算不出有效包围盒（比如图元还没加载出 img，w/h 是 undefined → NaN），
       都不能把它并进来、更不能让它把整体的 min/max 污染成 NaN —— 那会让整个阴影直接消失。 */
    const okBox = (b) => !!b && Number.isFinite(b.left) && Number.isFinite(b.right)
      && Number.isFinite(b.top) && Number.isFinite(b.bottom);
    const fb = getObjectBounds(f);
    if (!okBox(fb)) return;
    let minX = fb.left, maxX = fb.right, minY = fb.top, maxY = fb.bottom;
    for (const o of group) {
      let b = null;
      try { b = getObjectBounds(o); } catch (_) { b = null; }
      if (!okBox(b)) continue;
      if (b.left < minX) minX = b.left;
      if (b.right > maxX) maxX = b.right;
      if (b.top < minY) minY = b.top;
      if (b.bottom > maxY) maxY = b.bottom;
    }
    gdbg('bb', [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)]);
    const reach = gBlur * 2.5 + gSpread + Math.max(Math.abs(gOffX), Math.abs(gOffY)) + 8;
    minX -= reach; minY -= reach; maxX += reach; maxY += reach;
    const W = maxX - minX, H = maxY - minY;
    if (!(W > 1) || !(H > 1)) return;

    /* ---- 设备比例：按它开离屏，羽化为 0 时边缘才是干净的 ---- */
    let k = 1;
    try {
      const m = ctx.getTransform ? ctx.getTransform() : null;
      /* 缩放小于 1（缩小视图）时也不要低于 1:1：宁可多几个像素，
         否则离屏先降采样、贴回时再放大，羽化为 0 也会带出一圈毛边。 */
      if (m) { const v = Math.hypot(m.a, m.b); if (v > 0.05) k = Math.min(3, Math.max(1, v)); }
    } catch (_) { k = 1; }
    if (W * k > 4096) k = 4096 / W;
    if (H * k > 4096) k = 4096 / H;
    if (!(k > 0.15)) return;

    const offCv = document.createElement('canvas');
    offCv.width = Math.max(1, Math.ceil(W * k));
    offCv.height = Math.max(1, Math.ceil(H * k));
    const octx = offCv.getContext('2d');
    octx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    octx.lineCap = 'round';
    octx.lineJoin = 'round';

    /* ---- 剪影：整组走一遍正常渲染管线 ----
       逐个元件单独画：剪影是并集，绘制顺序无关紧要，但**一个元件抛错不能连坐整组**。
       （早先整组一次 renderScene，配饰里只要有一个画不出来，人物的阴影也一起没了。）
       每个元件外面套 save/restore，抛错时把画布状态完整恢复，避免脏 CTM 污染后面的元件。 */
    const savedCtx = ctx;
    ctx = octx;
    /* ctx 是模块级共享变量，必须在 finally 里换回来 ——
       否则中途抛出会让后续所有绘制都画进这个离屏画布。 */
    try {
      const refList = _renderList || AppState.objects;
      const silList = group.length ? [f].concat(group) : [f];
      let drewAny = false;
      for (const o of silList) {
        octx.save();
        try {
          /* isGhost 会关掉它自己的发光/地面投影/高光 —— 这里正好用来防递归 */
          renderScene([o], { isExporting: true, isGhost: true, refList });
          drewAny = true;
        } catch (err) {
          gdbg('err', (window.__glowDbg && window.__glowDbg.err ? window.__glowDbg.err + ' | ' : '') + (o.type + ':' + o.id + ' ' + String(err && err.message || err)));
        } finally { octx.restore(); }
      }
      if (!drewAny) {
        /* 一个都画不出来时，退回只描人物躯干+头，至少还有个轮廓 */
        try {
          octx.strokeStyle = gColor;
          octx.fillStyle = gColor;
          octx.lineWidth = curLW;
          octx.beginPath();
          smoothPolyline([j.pelvis, j.waistPoint, j.neck], radius);
          octx.stroke();
          octx.beginPath();
          octx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU);
          octx.stroke();
        } catch (_) { /* 彻底放弃 */ }
      }
    } finally { ctx = savedCtx; }

    /* ---- 压成纯色罩子：配饰/画笔本身是彩色的，不压阴影会变成彩色的 ---- */
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-in';
    octx.globalAlpha = 1;
    octx.fillStyle = gColor;
    octx.fillRect(0, 0, offCv.width, offCv.height);
    octx.globalCompositeOperation = 'source-over';
    if (window.__glowDebug) {
      try {
        const px = octx.getImageData(0, 0, offCv.width, offCv.height).data;
        let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++;
        gdbg('off', n);
      } catch (_) {}
    }

    /* ---- 扩展（扩散）：按圆周把罩子向外膨胀，半径是设备像素 ---- */
    let srcCv = offCv, sw = offCv.width, sh = offCv.height, sxDev = 0, syDev = 0;
    const spDev = gSpread * k;
    if (spDev > 0.5) {
      const d = Math.ceil(spDev);
      const dw = sw + d * 2, dh = sh + d * 2;
      if (dw <= 4096 && dh <= 4096) {
        const dc = document.createElement('canvas');
        dc.width = dw; dc.height = dh;
        const dctx = dc.getContext('2d');
        const passes = Math.min(28, Math.max(8, Math.ceil(spDev * 1.2)));
        for (let i = 0; i < passes; i++) {
          const a = i / passes * TAU;
          dctx.drawImage(offCv, d + Math.cos(a) * spDev, d + Math.sin(a) * spDev);
        }
        srcCv = dc; sw = dw; sh = dh; sxDev = -d; syDev = -d;
      }
    }

    /* ---- 偏移 + 羽化：全在设备像素里做，最后一次性贴回 ---- */
    const blurDev = gBlur * k;
    const offDevX = gOffX * k, offDevY = gOffY * k;
    const bleed = Math.ceil(blurDev * 2.5 + Math.abs(offDevX) + Math.abs(offDevY) + 6);
    const scW = sw + bleed * 2, scH = sh + bleed * 2;
    if (scW > 4096 || scH > 4096) return;
    const shCv = document.createElement('canvas');
    shCv.width = scW; shCv.height = scH;
    const sctx = shCv.getContext('2d');
    if (blurDev > 0.15 && typeof sctx.filter === 'string') {
      sctx.filter = 'blur(' + blurDev + 'px)';
      sctx.drawImage(srcCv, bleed + offDevX, bleed + offDevY, sw, sh);
      sctx.filter = 'none';
    } else if (blurDev > 0.15) {
      /* 老浏览器没有 ctx.filter：退回 shadow 影子法（源图推到这张小画布外，只留阴影） */
      const G = scW + 200;
      sctx.shadowColor = gColor;
      sctx.shadowBlur = blurDev;
      sctx.shadowOffsetX = offDevX + G;
      sctx.shadowOffsetY = offDevY;
      sctx.drawImage(srcCv, bleed - G, bleed, sw, sh);
    } else {
      /* 羽化 0：直接贴，不加任何滤镜 —— 边缘保持原始清晰度 */
      sctx.drawImage(srcCv, bleed + offDevX, bleed + offDevY, sw, sh);
    }

    const dx = minX + (sxDev - bleed) / k;
    const dy = minY + (syDev - bleed) / k;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, f.alpha * (f.glow.alpha == null ? 1 : f.glow.alpha) * alphaMul));
    gdbg('draw', { a: +ctx.globalAlpha.toFixed(3), dx: Math.round(dx), dy: Math.round(dy), w: Math.round(scW / k), h: Math.round(scH / k), k: +k.toFixed(3), cv: [offCv.width, offCv.height] });
    ctx.drawImage(shCv, dx, dy, scW / k, scH / k);
    ctx.restore();
  }

  function resolveAlphaMul(opts, obj) {
    let a = opts.alphaMul != null ? opts.alphaMul : 1;
    if (typeof opts.alphaFor === 'function') {
      const trackAlpha = opts.alphaFor(obj);
      if (trackAlpha != null && isFinite(trackAlpha)) a *= Math.max(0, trackAlpha);
    }
    return a;
  }

  /* v5.4.0 ── 变形中的火柴人：整体离屏渲染 + 网格贴膜 ─────────────────────
     旧做法是把 16 个关节点逐个过单应性再重新描线，三个副作用：
       1) 线宽是全局常数，拉长的小腿变成"细长线"，看着像换了动作；
       2) 头部半径按「盒中心」缩放，和颈→头的实际距离不一致 → 头和身子分开；
       3) 关节平滑半径 / 橡皮擦遮罩都在变形后的空间里重算，形状跑偏。
     现在改成：先在【未变形】状态把火柴人画进离屏画布，再把这张图按同一个单应性
     做网格贴膜。于是"只改形状、不改动作"，和配饰走的是同一套像素流，
     导出 4x 时离屏画布也按导出的设备像素比例生成，清晰度不损失。 */
  function queueFigureBitmapWarp(f, mp, isSel, isExporting, opts) {
    if (!mp || !mp.frame) return false;
    const DZ = SKFE.systems.distort;
    const fr = mp.frame;

    /* 画到盒外的元素（发光 / 描边偏移 / 地面投影）要留出余量，否则会被切掉。
       余量只是把「源矩形」放大，单应性本身不变，所以控制点位置完全不受影响。 */
    let margin = 8;
    if (f.glow && f.glow.enabled) {
      const gb = +f.glow.blur || 0, gs = +f.glow.spread || 0;
      const gx = Math.abs(+f.glow.offsetX || 0), gy = Math.abs(+f.glow.offsetY || 0);
      margin += Math.max(gb * 2.5, 0) + gs + Math.max(gx, gy);
    }
    if (f.light && f.light.enabled) margin += 2 * (f.light.size || 1) + 4;
    if (f.shadowEnabled) margin += 48;

    const ex = {
      w: fr.w + margin * 2,
      h: fr.h + margin * 2,
      ux: fr.ux, uy: fr.uy, vx: fr.vx, vy: fr.vy, ox: fr.ox, oy: fr.oy
    };
    /* v5.6.1：框架冻结之后，姿势变化可能让火柴人长出冻结框之外（抬手、劈叉…）。
       源矩形必须撑到「冻结框 ∪ 当前内容框」，否则超出的部分会被离屏画布直接裁掉。
       注意只放大 w/h、不动 ox/oy —— 盒坐标原点仍在中心，H 本身完全不受影响。 */
    if (mp.liveFrame) {
      const lf = mp.liveFrame;
      let hw = ex.w / 2, hh = ex.h / 2;
      const lc = [
        { x: -lf.w / 2, y: -lf.h / 2 }, { x: lf.w / 2, y: -lf.h / 2 },
        { x: lf.w / 2, y: lf.h / 2 }, { x: -lf.w / 2, y: lf.h / 2 }
      ];
      for (const q of lc) {
        const b = DZ.worldToBox(fr, DZ.boxToWorld(lf, q));
        if (!isFinite(b.x) || !isFinite(b.y)) continue;
        hw = Math.max(hw, Math.abs(b.x) + margin);
        hh = Math.max(hh, Math.abs(b.y) + margin);
      }
      ex.w = hw * 2; ex.h = hh * 2;
    }
    const mpEx = { frame: ex, H: mp.H };

    /* 世界 → 设备像素的倍率（导出时会自动变大，所以导出图不会有马赛克） */
    let pxScale = 1;
    try {
      const tr = ctx.getTransform();
      pxScale = Math.hypot(tr.a, tr.b) || 1;
    } catch (_) {}
    pxScale = Math.min(Math.max(pxScale, 0.5), 6);

    let cw = Math.ceil(ex.w * pxScale);
    let ch = Math.ceil(ex.h * pxScale);
    const MAXPIX = 8e6;
    if (cw * ch > MAXPIX) {
      const k = Math.sqrt(MAXPIX / (cw * ch));
      pxScale *= k;
      cw = Math.ceil(ex.w * pxScale);
      ch = Math.ceil(ex.h * pxScale);
    }
    if (!(cw > 1 && ch > 1)) return false;

    const scratch = document.createElement('canvas');
    scratch.width = cw; scratch.height = ch;
    const sctx = scratch.getContext('2d');
    if (!sctx) return false;

    /* 世界 → 离屏像素：先按 frame 换到盒空间，再平移到 [0,w]×[0,h] */
    const det = fr.ux * fr.vy - fr.uy * fr.vx;
    if (Math.abs(det) < 1e-12) return false;
    const Ba = fr.vy / det, Bb = -fr.uy / det;
    const Bc = -fr.vx / det, Bd = fr.ux / det;
    const Be = (fr.vx * fr.oy - fr.vy * fr.ox) / det;
    const Bf = (fr.uy * fr.ox - fr.ux * fr.oy) / det;
    sctx.setTransform(
      pxScale * Ba, pxScale * Bb, pxScale * Bc, pxScale * Bd,
      pxScale * (Be + ex.w / 2), pxScale * (Bf + ex.h / 2)
    );

    /* 把这一帧的火柴人按未变形状态画进离屏画布（内部可能再切 ctx，但会自己还原） */
    const savedCtx = ctx;
    const savedQueue = renderQueue;
    let ok = true;
    ctx = sctx;
    renderQueue = [];
    try {
      queueFigure(f, false, isExporting, Object.assign({}, opts, { __noDistort: true }));
      const items = renderQueue;
      items.sort((a, b) => a.level - b.level);
      for (const it of items) it.draw();
    } catch (err) {
      ok = false;
      if (window.console && console.warn) console.warn('[distort] 火柴人整体贴膜失败，退回未变形绘制', err);
    } finally {
      ctx = savedCtx;
      renderQueue = savedQueue;
    }
    if (!ok) return false;

    const minOwnLayer = Math.min.apply(null, Object.values(f.layer));
    renderQueue.push({
      level: minOwnLayer,
      draw: () => {
        ctx.save();
        DZ.drawWarpedBitmap(ctx, scratch, mpEx, { grid: Math.max(8, DZ.gridFor()) });
        ctx.restore();
        /* v5.6.1：这里【不再】补画一圈选中虚线框。
           未变形的火柴人本来就只有关节点、没有框；变形后多画一圈框反而是特例，
           看上去像「物体被这个框限制住了」。要框的时候：
             · 开「变换框」→ drawTransformBox
             · 开「四角扭曲」→ drawOverlay 的 8 点编辑框
           两者都没开 = 纯预览态，只留关节点。 */
      }
    });

    /* v5.5.0：变形状态下恢复关节手柄。
       手柄画在「映射后」的位置（和用户看到的图像完全重合），
       命中测试与拖拽则走逆单应性反算回源空间 —— 见 distortInvWorld()。
       这两件事必须成对实现，只做一半就会出现「看得到点不到」。 */
    if (isSel && !isExporting && !hideJointsEnabled) {
      renderQueue.push({
        level: 99999,
        draw: () => {
          let jj = null;
          try { jj = jointData(f); } catch (_) { return; }
          if (!jj) return;
          /* v5.6.2：jointData 给的是「未旋转的本地坐标」，必须先过一遍人物自身的
             刚性变换（绕 o.x,o.y 旋转 + 镜像）才变成世界坐标，然后再进单应性。
             漏掉这一步会出现「火柴人转了、关节点没转」，点为量全飘在画外。
             普通绘制那条路是靠 wrapFig() 的 ctx.rotate 顺带解决的，这里没有 ctx 变换，得自己算。 */
          const rm = figureRigidMatrix(f);
          paintJointDots(f, jj, (h) => {
            const w = tboxMatApply(rm, h.p);
            return DZ.mapWorld(mp, w);
          });
        }
      });
    }
    return true;
  }

  function queueFigure(f, isSel, isExporting, opts) {
    opts = opts || {};
    /* v5.4.0：开启扭曲时改成整体贴膜，见 queueFigureBitmapWarp */
    if (!opts.__noDistort) {
      const dm = SKFE.systems.distort.getMapping(f);
      if (dm && queueFigureBitmapWarp(f, dm, isSel, isExporting, opts)) return;
    }
    const alphaMul = resolveAlphaMul(opts, f);
    const tint = opts.tint || null;
    const isGhost = !!opts.isGhost;
    const effColor = tint || f.color;

    const j = jointData(f);
    let curLW = f.lw * f.scale;
    /* v5.4.0：扭曲不再逐点映射关节再重新描线（那会让"动作"看起来变了），
       而是整体贴膜 —— 走到这里一定是未变形状态。 */
    const distMap = null;
    const smoothVal = (f.jointSmooth !== undefined) ? f.jointSmooth : 1;
    const radius = smoothVal <= 0.01 ? 0 : Math.max(curLW * 2.2 * smoothVal, 1);
    const minOwnLayer = Math.min(...Object.values(f.layer));
    const extOn = !!(f.extremity && f.extremity.enabled);

    const armLpts = extOn ? [j.neck, j.elbowL, j.handL, j.wristL] : [j.neck, j.elbowL, j.handL];
    const armRpts = extOn ? [j.neck, j.elbowR, j.handR, j.wristR] : [j.neck, j.elbowR, j.handR];
    const legLpts = extOn ? [j.pelvis, j.thighL, j.footL, j.toeL] : [j.pelvis, j.thighL, j.footL];
    const legRpts = extOn ? [j.pelvis, j.thighR, j.footR, j.toeR] : [j.pelvis, j.thighR, j.footR];

    const getLimbColor = (limbName) => {
      if (tint) return tint;
      if (f.depth && f.depth.enabled && (limbName === 'armL' || limbName === 'legL')) {
        return f.depth.useCustom ? f.depth.customColor : darkenColor(f.color, 0.55);
      }
      return f.color;
    };

    /* v5.4.0：旋转/镜像在这里照常烘焙进离屏画布，再由单应性整体贴膜 */
    const hasRot = !!(f.rot);
    const hasMirror = !!(f.mirror);
    const wrapFig = (fn) => {
      if (!hasRot && !hasMirror) return fn;
      return () => {
        ctx.save();
        ctx.translate(f.x, f.y);
        if (hasRot) ctx.rotate(f.rot * Math.PI / 180);
        if (hasMirror) ctx.scale(-1, 1);
        ctx.translate(-f.x, -f.y);
        try { fn(); } finally { ctx.restore(); }
      };
    };

    /* v7.2.0：描边阴影不只是模糊 —— 扩展 / 偏移任意一项非 0 都要画 */
    const glowOn = f.glow && f.glow.enabled &&
      ((+f.glow.blur || 0) > 0 || (+f.glow.spread || 0) > 0 || (+f.glow.offsetX || 0) !== 0 || (+f.glow.offsetY || 0) !== 0);
    if (!isGhost && glowOn) {
      renderQueue.push({
        level: minOwnLayer - 1,
        /* 包一层 try/catch：描边阴影出任何岔子都只是「没有阴影」，
           绝不能把人物的绘制一起带崩（否则整个画布都画不出来）。 */
        /* 注意：这里**不能**套 wrapFig。剪影是在离屏里用 renderScene 重画的，
           人物自身的 f.rot / f.mirror 已经在那一次里烘焙进去了；再套一层 wrapFig
           会把整张阴影贴图按 f.x/f.y 再转一次 —— 表现就是「影子转到人物另一边」。 */
        draw: () => {
          const st = ctx.save ? (ctx.save(), true) : false;
          try { drawFigureGlow(f, j, curLW, radius, alphaMul, armLpts, armRpts, legLpts, legRpts); }
          catch (err) { try { console.warn('[glow] 描边阴影绘制失败：', err); } catch (_) {} }
          finally { if (st) { try { ctx.restore(); } catch (_) {} } }
        }
      });
    }

    if (!isGhost && f.shadowEnabled) {
      const drawGroundShadow = () => {
        ctx.save();
        ctx.globalAlpha = f.alpha * (f.shadowAlpha == null ? 0.3 : f.shadowAlpha) * alphaMul;
        const lowestY = Math.max(j.footL.y, j.footR.y, j.toeL.y, j.toeR.y);
        const shadowX = f.x + (f.shadowOffX || 0);
        const shadowY = lowestY + 10 + (f.shadowOffY || 0);
        const rx = 30 * f.scale * (f.shadowScaleX || 1);
        const ry = 8 * f.scale * (f.shadowScaleY || 1);
        ctx.translate(shadowX, shadowY);
        ctx.scale(rx, ry);
        let r = 0, g = 0, b = 0;
        const sCol = f.shadowColor || '#000000';
        if (sCol.startsWith('#')) {
          r = parseInt(sCol.slice(1, 3), 16) || 0;
          g = parseInt(sCol.slice(3, 5), 16) || 0;
          b = parseInt(sCol.slice(5, 7), 16) || 0;
        }
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
        grad.addColorStop(0.5, `rgba(${r},${g},${b},0.7)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
        ctx.restore();
      };
      renderQueue.push({ level: minOwnLayer - 0.8, draw: drawGroundShadow });
    }

    const rad = (f.light.angle || 0) * Math.PI / 180;
    const off = 2 * (f.light.size || 1.0);
    const ox = Math.sin(rad) * off;
    const oy = -Math.cos(rad) * off;
    const drawLight = f.light.enabled && !isGhost;

    const drawBody = () => {
      ctx.save(); ctx.globalAlpha = f.alpha * alphaMul; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      
      // 新增：躯干被头部挖空逻辑
      const needsMask = f.layer.body < f.layer.head && !(f.headFilled || f.headFillCustom);
      if (needsMask) {
        ctx.save();
        clipOutHeadHole(ctx, f, j, curLW);
      }

      if (drawLight) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(-10000, -10000, 20000, j.pelvis.y + 10000);
        ctx.clip();
        ctx.strokeStyle = f.light.color;
        ctx.lineWidth = curLW * (f.light.size || 1.0);
        ctx.translate(ox, oy);
        ctx.beginPath(); smoothPolyline([j.pelvis, j.waistPoint, j.neck], radius); ctx.stroke();
        ctx.restore();
      }
      const spatial = SKFE.systems.spatial.getSpatialConfig(f);
      if (spatial) {
        SKFE.systems.spatial.drawZVariedLimb(
          ctx, [j.pelvis, j.waistPoint, j.neck], radius, curLW, effColor,
          { start: spatial.lines.body.start, end: spatial.lines.body.end }, spatial.strength
        );
      } else {
        ctx.strokeStyle = effColor; ctx.lineWidth = curLW;
        ctx.beginPath(); smoothPolyline([j.pelvis, j.waistPoint, j.neck], radius); ctx.stroke();
      }

      if (needsMask) ctx.restore(); // 恢复躯干遮罩
      ctx.restore();
    };

    const drawHead = () => {
      ctx.save(); ctx.globalAlpha = f.alpha * alphaMul; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const hShape = headShapeOf(f);
      if (drawLight) {
        ctx.save();
        ctx.strokeStyle = f.light.color;
        /* v6.4.1：手绘头型的「原线条」是环的厚度，不是身体线宽 curLW。
           之前统一用 curLW → 高光描边比头环还粗，糊成一圈大橙环。
           另外也不能沿外轮廓描：那样半个线宽直接露在剪影外。
           这里改成「整环加厚 Δ」，Δ = 环厚×(倍数-1)/2，和正圆头的语义完全一致。 */
        const ringW = hShape ? headRingWidth(j, hShape) : curLW;
        const grow = Math.max(0, ringW * ((f.light.size || 1.0) - 1) / 2);
        ctx.lineWidth = hShape ? grow * 2 : curLW * (f.light.size || 1.0);
        ctx.translate(ox, oy);
        if (hShape) {
          paintHeadShape(ctx, j, f, hShape, f.light.color, 'grow', null, grow);
        } else {
          ctx.beginPath(); ctx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU); ctx.stroke();
        }
        ctx.restore();
      }
      const customFill = f.headFillCustom && f.headFillColor;
      if (hShape) {
        /* v6.4.0：手绘头型。粗细由形状本身决定，不吃线宽滑块 —— 大小只跟「头部」比例走 */
        if (f.headFilled) {
          paintHeadShape(ctx, j, f, hShape, (tint || !customFill) ? effColor : f.headFillColor, 'solid');
        } else if (customFill) {
          paintHeadShape(ctx, j, f, hShape, tint || effColor, 'inner', tint || f.headFillColor);
        } else {
          paintHeadShape(ctx, j, f, hShape, effColor, 'ring');
        }
        ctx.restore();
        return;
      }
      if (f.headFilled) {
        ctx.fillStyle = (tint || !customFill) ? effColor : f.headFillColor;
        ctx.beginPath(); ctx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU); ctx.fill();
      } else {
        if (customFill) {
          ctx.fillStyle = tint || f.headFillColor;
          ctx.beginPath(); ctx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU); ctx.fill();
        }
        ctx.strokeStyle = effColor; ctx.lineWidth = curLW;
        ctx.beginPath(); ctx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    };

    const drawLimbMasked = (limbName, pts, isArm) => {
      const needsMask = f.layer[limbName] < f.layer.head && !(f.headFilled || f.headFillCustom);
      if (needsMask) {
        ctx.save();
        clipOutHeadHole(ctx, f, j, curLW);
      }
      ctx.save(); ctx.globalAlpha = f.alpha * alphaMul; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = curLW;
      if (drawLight) {
        ctx.save();
        ctx.strokeStyle = f.light.color;
        const lightLW = curLW * (f.light.size || 1.0);
        ctx.lineWidth = lightLW;
        ctx.lineCap = 'round';
        ctx.translate(ox, oy);
        ctx.beginPath(); smoothPolyline(pts, radius); ctx.stroke();
        drawLimbEndCaps(pts, lightLW, f.light.color);
        ctx.restore();
      }
      if (isArm && f.joint.enabled) {
        const baseColor = getLimbColor(limbName);
        drawLimbWithGradient(f, pts, radius, f.joint.len, (isGhost && tint) ? tint : null, baseColor);
      } else {
        const strokeColor = getLimbColor(limbName);
          const spatial = SKFE.systems.spatial.getSpatialConfig(f);
          if (spatial) {
            /* v5.7：每条线独立的头/尾倍率（骨盆/脖子端在 UI 层已同步进 lines） */
            const line = spatial.lines[limbName] || { start: 1, end: 1 };
            SKFE.systems.spatial.drawZVariedLimb(ctx, pts, radius, curLW, strokeColor,
              { start: line.start, end: line.end }, spatial.strength);
          } else {
          ctx.strokeStyle = strokeColor;
          ctx.lineCap = 'round';
          ctx.beginPath(); smoothPolyline(pts, radius); ctx.stroke();
          drawLimbEndCaps(pts, curLW, strokeColor);
        }
      }
      ctx.restore();
      if (needsMask) ctx.restore();
    };

    let layerLegL = f.layer.legL;
    let layerArmL = f.layer.armL;
    if (f.depth && f.depth.enabled) {
      layerLegL = Math.min(layerLegL, f.layer.body - 1);
      layerArmL = Math.min(layerArmL, f.layer.body - 1);
    }

    // ==========================================
    // 新增：骨骼级局部遮罩渲染逻辑
    // ==========================================
    const drawMaskedLimb = (limbName, pts, isArm) => {
      const strokes = (f.eraser && f.eraser[limbName]) ? f.eraser[limbName] : [];
      if (!strokes.length) {
        drawLimbMasked(limbName, pts, isArm);
        return;
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const pad = curLW * 2 + 20;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const sw = maxX - minX, sh = maxY - minY;
      const tr = ctx.getTransform();
      const scale = Math.sqrt(tr.a * tr.a + tr.b * tr.b) || 1;

      const scratch = document.createElement('canvas');
      scratch.width = Math.ceil(sw * scale);
      scratch.height = Math.ceil(sh * scale);
      const sctx = scratch.getContext('2d');
      sctx.scale(scale, scale);
      sctx.translate(-minX, -minY);

      const savedCtx = ctx;
      ctx = sctx;
      try {
        drawLimbMasked(limbName, pts, isArm);
        sctx.globalCompositeOperation = 'destination-out';
        sctx.lineCap = 'round'; sctx.lineJoin = 'round';

        const segs = SKFE.systems.eraser.getLimbSegs(j, limbName);
        for (const st of strokes) {
          const segIdx = (typeof st.seg === 'number' && st.seg >= 0 && st.seg < segs.length) ? st.seg : 0;
          const seg = segs[segIdx] || segs[0];
          if (!seg) continue;
          sctx.beginPath();
          for (let i = 0; i < st.points.length; i++) {
            const P = SKFE.systems.eraser.segLocalToWorld(st.points[i], seg[0], seg[1]);
            if (i === 0) sctx.moveTo(P.x, P.y);
            else sctx.lineTo(P.x, P.y);
          }
          /* size 存的是"figure 局部单位"，需乘 f.scale 还原为世界单位 */
          sctx.lineWidth = st.size * f.scale;
          sctx.strokeStyle = '#000';
          sctx.stroke();
        }
      } finally {
        ctx = savedCtx;
      }
      ctx.drawImage(scratch, minX, minY, sw, sh);
    };

    const drawMaskedHead = () => {
      const strokes = (f.eraser && f.eraser.head) ? f.eraser.head : [];
      if (!strokes.length) { drawHead(); return; }

      const pad = j.headR + curLW * 2 + 20;
      const minX = j.headC.x - pad, minY = j.headC.y - pad;
      const sw = pad * 2, sh = pad * 2;
      const tr = ctx.getTransform();
      const scale = Math.sqrt(tr.a * tr.a + tr.b * tr.b) || 1;

      const scratch = document.createElement('canvas');
      scratch.width = Math.ceil(sw * scale);
      scratch.height = Math.ceil(sh * scale);
      const sctx = scratch.getContext('2d');
      sctx.scale(scale, scale);
      sctx.translate(-minX, -minY);

      const savedCtx = ctx;
      ctx = sctx;
      try {
        drawHead();
        sctx.globalCompositeOperation = 'destination-out';
        sctx.lineCap = 'round'; sctx.lineJoin = 'round';
        for (const st of strokes) {
          sctx.beginPath();
          for (let i = 0; i < st.points.length; i++) {
            const P = { x: j.headC.x + st.points[i].x, y: j.headC.y + st.points[i].y };
            if (i === 0) sctx.moveTo(P.x, P.y);
            else sctx.lineTo(P.x, P.y);
          }
          /* 修复笔刷大小：size 存 figure 局部单位，乘 f.scale 还原为世界单位 */
          sctx.lineWidth = st.size * f.scale;
          sctx.strokeStyle = '#000';
          sctx.stroke();
        }
      } finally {
        ctx = savedCtx;
      }
      ctx.drawImage(scratch, minX, minY, sw, sh);
    };

    const drawMaskedBody = () => {
      const strokes = (f.eraser && f.eraser.body) ? f.eraser.body : [];
      if (!strokes.length) { drawBody(); return; }

      const pts = [j.pelvis, j.waistPoint, j.neck];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const pad = curLW * 2 + 20;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const sw = maxX - minX, sh = maxY - minY;
      const tr = ctx.getTransform();
      const scale = Math.sqrt(tr.a * tr.a + tr.b * tr.b) || 1;

      const scratch = document.createElement('canvas');
      scratch.width = Math.ceil(sw * scale);
      scratch.height = Math.ceil(sh * scale);
      const sctx = scratch.getContext('2d');
      sctx.scale(scale, scale);
      sctx.translate(-minX, -minY);

      const savedCtx = ctx;
      ctx = sctx;
      try {
        drawBody();
        sctx.globalCompositeOperation = 'destination-out';
        sctx.lineCap = 'round'; sctx.lineJoin = 'round';

        const segs = [[j.pelvis, j.waistPoint], [j.waistPoint, j.neck]];
        for (const st of strokes) {
          const segIdx = (typeof st.seg === 'number' && st.seg >= 0 && st.seg < segs.length) ? st.seg : 0;
          const seg = segs[segIdx] || segs[0];
          sctx.beginPath();
          for (let i = 0; i < st.points.length; i++) {
            const P = SKFE.systems.eraser.segLocalToWorld(st.points[i], seg[0], seg[1]);
            if (i === 0) sctx.moveTo(P.x, P.y);
            else sctx.lineTo(P.x, P.y);
          }
          sctx.lineWidth = st.size * f.scale;
          sctx.strokeStyle = '#000';
          sctx.stroke();
        }
      } finally {
        ctx = savedCtx;
      }
      ctx.drawImage(scratch, minX, minY, sw, sh);
    };

    // 将新写的遮罩函数塞入渲染队列
    renderQueue.push({ level: layerLegL, draw: wrapFig(() => drawMaskedLimb('legL', legLpts, false)) });
    renderQueue.push({ level: layerArmL, draw: wrapFig(() => drawMaskedLimb('armL', armLpts, true)) });
    renderQueue.push({ level: f.layer.legR, draw: wrapFig(() => drawMaskedLimb('legR', legRpts, false)) });
    renderQueue.push({ level: f.layer.armR, draw: wrapFig(() => drawMaskedLimb('armR', armRpts, true)) });
    renderQueue.push({ level: f.layer.head, draw: wrapFig(drawMaskedHead) });
    renderQueue.push({ level: f.layer.body, draw: wrapFig(drawMaskedBody) });

    if (isSel && !isExporting && !hideJointsEnabled) {
      renderQueue.push({ level: 99999, draw: wrapFig(() => paintJointDots(f, j, null)) });
    }
  }

  /**
   * 画关节手柄圆点。
   * @param posOf 可选：把关节源坐标换成「实际要画的世界坐标」。
   *              未变形时传 null（直接用 h.p）；变形时传 mapWorld 后的位置。
   */
  function paintJointDots(f, j, posOf) {
    for (const h of getHandles(j, f)) {
      if (!isJointInGroup(h.name, isolatedJointName)) continue; // 隔离模式：只画选中的那一组
      const p = posOf ? posOf(h) : h.p;
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      const isPinned = f.pinned && f.pinned[h.name];
      let color = 'rgba(74,144,255,.85)';
      if (isPinned) color = '#ef4444';
      else if (jointColorDiff) {
        if (h.name === 'head') color = '#f59e0b';
        else if (['pelvis', 'waist', 'neck'].includes(h.name)) color = '#3b82f6';
        else if (['elbowL', 'handL', 'wristL'].includes(h.name)) color = '#10b981';
        else if (['elbowR', 'handR', 'wristR'].includes(h.name)) color = '#ef4444';
        else if (['kneeL', 'footL', 'toeL'].includes(h.name)) color = '#8b5cf6';
        else if (['kneeR', 'footR', 'toeR'].includes(h.name)) color = '#ec4899';
      }
      ctx.beginPath(); ctx.arc(p.x, p.y, jointSize, 0, TAU);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
      if (isPinned) {
        ctx.font = '10px system-ui';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('●', p.x, p.y + 1);
      }
    }
  }

  /* ---- 通用：对象锚点偏移（世界单位） ---- */
  function getAnchorOffset(o, finalScale) {
    const ax = (o.ax || 0) * finalScale;
    const ay = (o.ay || 0) * finalScale;
    return { ax, ay };
  }

  function queueImageObj(im, isSel, isExporting, opts) {
    opts = opts || {};
    const alphaMul = resolveAlphaMul(opts, im);
    const b = imageBounds(im);
    const { ax, ay } = getAnchorOffset(im, im.scale);
    const rot = (im.rot || 0) * Math.PI / 180;
    /* v5.2.0 四角扭曲：位图走 16x16 网格切片（Mesh Warping），绝不逐像素 CPU 插值 */
    const distMap = SKFE.systems.distort.getMapping(im);
    if (distMap) {
      renderQueue.push({ level: im.layer, draw: () => {
        ctx.save();
        ctx.globalAlpha = im.alpha * alphaMul;
        SKFE.systems.distort.drawWarpedBitmap(ctx, im.img, distMap);
        ctx.restore();
      }});
      return;
    }
    renderQueue.push({ level: im.layer, draw: () => {
      ctx.save();
      ctx.globalAlpha = im.alpha * alphaMul;
      ctx.translate(im.x + ax, im.y + ay);
      if (rot) ctx.rotate(rot);
      if (im.mirror) ctx.scale(-1, 1);
      ctx.drawImage(im.img, -b.w / 2 - ax, -b.h / 2 - ay, b.w, b.h);
      ctx.restore();
      if (isSel && !isExporting && !transformBoxOn) {
        ctx.save();
        ctx.translate(im.x + ax, im.y + ay);
        if (rot) ctx.rotate(rot);
        if (im.mirror) ctx.scale(-1, 1);
        ctx.strokeStyle = im.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(74,144,255,.95)';
        ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.strokeRect(-b.w / 2 - ax, -b.h / 2 - ay, b.w, b.h);
        ctx.restore();
      }
    }});
  }

  function getBoundFigureTransform(o) {
    if (!o || o.bindTo === 'none' || !o.targetId) return null;
    const list = _renderList || AppState.objects;
    const fig = list.find(f => f.id === o.targetId && f.type === 'figure');
    if (!fig) return null;
    if (!fig.rot && !fig.mirror) return null;
    return { x: fig.x, y: fig.y, rot: fig.rot || 0, mirror: !!fig.mirror };
  }

  function applyFigTransformCtx(tr) {
    if (!tr) return;
    ctx.translate(tr.x, tr.y);
    if (tr.rot) ctx.rotate(tr.rot * Math.PI / 180);
    if (tr.mirror) ctx.scale(-1, 1);
    ctx.translate(-tr.x, -tr.y);
  }

  /* v5.3.1：变形对象的选中虚线框 —— 沿变形后的四边形走，而不是原始矩形 */
  function strokeWarpQuad(mp, color) {
    if (!mp) return;
    const q = mp.dst.map(p => SKFE.systems.distort.boxToWorld(mp.frame, p));
    if (!q.every(p => isFinite(p.x) && isFinite(p.y))) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { if (i === 0) ctx.moveTo(q[i].x, q[i].y); else ctx.lineTo(q[i].x, q[i].y); }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function queueAcc(acc, isSel, isExporting, opts) {
    opts = opts || {};
    const alphaMul = resolveAlphaMul(opts, acc);
    const trans = getBindTransform(acc);
    const figTr = getBoundFigureTransform(acc);
    const finalScale = acc.scale * trans.syncScale;
    const w = acc.w * finalScale, h = acc.h * finalScale;
    const { ax, ay } = getAnchorOffset(acc, finalScale);
    /* v5.2.0 四角扭曲：配饰同样是位图，走网格切片 */
    const distMap = SKFE.systems.distort.getMapping(acc);
    if (distMap) {
      renderQueue.push({ level: acc.layer, draw: () => {
        ctx.save();
        ctx.globalAlpha = acc.alpha * alphaMul;
        SKFE.systems.distort.drawWarpedBitmap(ctx, acc.img, distMap);
        ctx.restore();
        if (isSel && !isExporting && !transformBoxOn) {
          strokeWarpQuad(distMap, acc.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)');
        }
      }});
      return;
    }
    renderQueue.push({ level: acc.layer, draw: () => {
      ctx.save();
      applyFigTransformCtx(figTr);
      ctx.globalAlpha = acc.alpha * alphaMul;
      ctx.translate(trans.x + ax, trans.y + ay);
      ctx.rotate(trans.angle);
      if (acc.mirror) ctx.scale(-1, 1);
      ctx.drawImage(acc.img, -w / 2 - ax, -h / 2 - ay, w, h);
      ctx.restore();
      if (isSel && !isExporting && !transformBoxOn) {
        ctx.save();
        applyFigTransformCtx(figTr);
        ctx.strokeStyle = acc.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)';
        ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.translate(trans.x + ax, trans.y + ay);
        ctx.rotate(trans.angle);
        if (acc.mirror) ctx.scale(-1, 1);
        ctx.strokeRect(-w / 2 - ax, -h / 2 - ay, w, h);
        ctx.restore();
      }
    }});
  }

  function queueShape(shape, isSel, isExporting, opts) {
    opts = opts || {};
    const alphaMul = resolveAlphaMul(opts, shape);
    const tint = opts.tint || null;
    const trans = getBindTransform(shape);
    const figTr = getBoundFigureTransform(shape);
    const finalScale = shape.scale * trans.syncScale;
    const w = shape.w * finalScale, h = shape.h * finalScale;
    const lw = shape.strokeWidth * finalScale;
    const { ax, ay } = getAnchorOffset(shape, finalScale);
    /* v5.2.0 四角扭曲：图形走「路径顶点映射」，填充/描边重新成路径，缩放不失真 */
    const distMap = SKFE.systems.distort.getMapping(shape);
    if (distMap) {
      /* 盒空间多边形（形状的本地路径坐标与 OBB 的盒坐标完全对齐） */
      let pts;
      if (shape.shape === 'circle') {
        pts = SKFE.systems.distort.ellipsePoints(w / 2, h / 2, 64);
      } else if (shape.shape === 'rect') {
        pts = [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
      } else {
        pts = [{ x: 0, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
      }
      const lwD = lw * SKFE.systems.distort.centerScale(distMap);
      renderQueue.push({ level: shape.layer, draw: () => {
        ctx.save();
        ctx.globalAlpha = shape.alpha * alphaMul;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        SKFE.systems.distort.tracePath(ctx, distMap, pts, true);
        const fc = tint || shape.fillColor;
        if (fc !== 'transparent' && fc !== '#00000000') { ctx.fillStyle = fc; ctx.fill(); }
        if (lwD > 0) { ctx.lineWidth = lwD; ctx.strokeStyle = tint || shape.strokeColor; ctx.stroke(); }
        ctx.restore();
        if (isSel && !isExporting && !transformBoxOn) {
          strokeWarpQuad(distMap, shape.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)');
        }
      }});
      return;
    }
    renderQueue.push({ level: shape.layer, draw: () => {
      ctx.save();
      applyFigTransformCtx(figTr);
      ctx.globalAlpha = shape.alpha * alphaMul;
      ctx.translate(trans.x + ax, trans.y + ay);
      ctx.rotate(trans.angle);
      if (shape.mirror) ctx.scale(-1, 1);
      ctx.translate(-ax, -ay);
      ctx.beginPath();
      if (shape.shape === 'circle') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, TAU);
      else if (shape.shape === 'rect') ctx.rect(-w / 2, -h / 2, w, h);
      else if (shape.shape === 'tri') { ctx.moveTo(0, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(-w / 2, h / 2); ctx.closePath(); }
      const fc = tint || shape.fillColor;
      if (fc !== 'transparent' && fc !== '#00000000') { ctx.fillStyle = fc; ctx.fill(); }
      if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = tint || shape.strokeColor; ctx.stroke(); }
      ctx.restore();
      if (isSel && !isExporting && !transformBoxOn) {
        ctx.save();
        applyFigTransformCtx(figTr);
        ctx.strokeStyle = shape.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)';
        ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.translate(trans.x + ax, trans.y + ay);
        ctx.rotate(trans.angle);
        if (shape.mirror) ctx.scale(-1, 1);
        ctx.strokeRect(-w / 2 - ax, -h / 2 - ay, w, h);
        ctx.restore();
      }
    }});
  }

  function queueBubble(bubble, isSel, isExporting, opts) {
    opts = opts || {};
    const alphaMul = resolveAlphaMul(opts, bubble);
    const trans = getBindTransform(bubble);
    const figTr = getBoundFigureTransform(bubble);
    const finalScale = bubble.scale * trans.syncScale;
    const lw = bubble.strokeWidth * finalScale;
    const fontSize = bubble.fontSize * finalScale;
    const { ax, ay } = getAnchorOffset(bubble, finalScale);
    renderQueue.push({ level: bubble.layer, draw: () => {
      /* v5.2.0：扭曲分支需要回到「纯世界坐标」下重绘，这里先记下父级变换 */
      const baseM = ctx.getTransform();
      ctx.save();
      applyFigTransformCtx(figTr);
      ctx.translate(trans.x + ax, trans.y + ay);
      ctx.rotate(trans.angle);
      ctx.translate(-ax, -ay);
      const paddingX = 24 * finalScale;
      const paddingY = 16 * finalScale;
      const lineHeight = fontSize * 1.3;
      const wrapWidth = bubble.customSize ? Math.max(fontSize, bubble.customW * finalScale - paddingX * 2) : 260 * finalScale;
      ctx.font = `${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
      let maxLineWidth = 0;
      const lines = [];
      const paragraphs = bubble.text.split('\n');
      paragraphs.forEach(p => {
        let currentLine = '';
        for (let i = 0; i < p.length; i++) {
          const char = p[i];
          const testLine = currentLine + char;
          const metrics = ctx.measureText(testLine);
          if (metrics.width > wrapWidth && currentLine !== '') {
            lines.push(currentLine); currentLine = char;
          } else { currentLine = testLine; }
        }
        lines.push(currentLine);
      });
      lines.forEach(line => {
        const w2 = ctx.measureText(line).width;
        if (w2 > maxLineWidth) maxLineWidth = w2;
      });
      let w, h;
      if (bubble.customSize) {
        w = Math.max(40 * finalScale, bubble.customW * finalScale);
        h = Math.max(30 * finalScale, bubble.customH * finalScale);
      } else {
        w = Math.max(80 * finalScale, maxLineWidth + paddingX * 2);
        h = Math.max(50 * finalScale, lines.length * lineHeight + paddingY * 2);
      }
      bubble.w = w / finalScale; bubble.h = h / finalScale;
      /* v5.2.0 四角扭曲：轮廓按采样点逐点映射重绘；文字按盒中心的雅可比做局部仿射，
         字号与倾角随透视自然变化，仍然是矢量文字而不是贴图。 */
      const distMap = SKFE.systems.distort.getMapping(bubble);
      if (distMap) {
        const outline = SKFE.systems.distort.bubblePoints(w, h, 10);
        const lwD = lw * SKFE.systems.distort.centerScale(distMap);
        ctx.save();
        ctx.setTransform(baseM.a, baseM.b, baseM.c, baseM.d, baseM.e, baseM.f);
        ctx.globalAlpha = bubble.alpha * alphaMul;
        ctx.beginPath();
        SKFE.systems.distort.tracePath(ctx, distMap, outline, true);
        if (bubble.fillColor !== 'transparent') { ctx.fillStyle = bubble.fillColor; ctx.fill(); }
        if (lwD > 0) {
          ctx.lineWidth = lwD; ctx.strokeStyle = bubble.strokeColor;
          ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
        }
        ctx.restore();

        if (bubble.text) {
          const A = SKFE.systems.distort.localAffine(distMap);
          ctx.save();
          ctx.setTransform(baseM.a, baseM.b, baseM.c, baseM.d, baseM.e, baseM.f);
          ctx.globalAlpha = bubble.alpha * alphaMul;
          ctx.transform(A.a, A.b, A.c, A.d, A.e, A.f);
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = `${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
          const totalHeight = lines.length * lineHeight;
          const startY = -totalHeight / 2 + lineHeight / 2;
          lines.forEach((line, i) => {
            const y = startY + i * lineHeight;
            if (bubble.isGradient) {
              const g = ctx.createLinearGradient(0, y - lineHeight / 2, 0, y + lineHeight / 2);
              g.addColorStop(0, bubble.textColor); g.addColorStop(1, bubble.gradientColor);
              ctx.fillStyle = g;
            } else {
              ctx.fillStyle = bubble.textColor;
            }
            ctx.fillText(line, 0, y);
          });
          ctx.restore();
        }
        ctx.restore();
        if (isSel && !isExporting && !transformBoxOn) {
          strokeWarpQuad(distMap, bubble.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)');
        }
        return;
      }
      ctx.save();
      ctx.globalAlpha = bubble.alpha * alphaMul;
      if (bubble.isMirrored) ctx.scale(-1, 1);
      drawSmoothBubble(ctx, w, h, lw, bubble.strokeColor, bubble.fillColor);
      ctx.restore();
      if (bubble.text) {
        ctx.save();
        ctx.globalAlpha = bubble.alpha * alphaMul;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const totalHeight = lines.length * lineHeight;
        let startY = -totalHeight / 2 + lineHeight / 2;
        lines.forEach((line, i) => {
          const y = startY + i * lineHeight;
          if (bubble.isGradient) {
            const g = ctx.createLinearGradient(0, y - lineHeight / 2, 0, y + lineHeight / 2);
            g.addColorStop(0, bubble.textColor); g.addColorStop(1, bubble.gradientColor);
            ctx.fillStyle = g;
          } else {
            ctx.fillStyle = bubble.textColor;
          }
          ctx.fillText(line, 0, y);
        });
        ctx.restore();
      }
      ctx.restore();
      if (isSel && !isExporting && !transformBoxOn) {
        ctx.save();
        applyFigTransformCtx(figTr);
        ctx.translate(trans.x + ax, trans.y + ay);
        ctx.rotate(trans.angle);
        ctx.strokeStyle = bubble.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)';
        ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        const pad = Math.max(12, lw * 2);
        const extraBottom = 24 * finalScale;
        ctx.strokeRect(-w / 2 - ax - pad, -h / 2 - ay - pad, w + pad * 2, h + pad * 2 + extraBottom);
        ctx.restore();
      }
    }});
  }

  /* ==================== 画笔元件 ink：局部矩阵与渲染（brush-v5.1.0） ==================== */
  /* ink 的局部坐标 → 世界坐标矩阵，必须与 queueInk 中的 ctx 变换顺序完全一致，
     供 eraser.js / brush.js 复用（反算局部坐标、擦除遮罩定位）。 */
  function getInkLocalMatrix(ink) {
    const trans = getBindTransform(ink);
    const figTr = getBoundFigureTransform(ink);
    const finalScale = (ink.scale || 1) * (trans.syncScale || 1);
    const { ax, ay } = getAnchorOffset(ink, finalScale);
    let m = tboxMatIdentity();
    if (figTr) {
      m = tboxMatMul(m, tboxMatT(figTr.x, figTr.y));
      if (figTr.rot) m = tboxMatMul(m, tboxMatR(figTr.rot * Math.PI / 180));
      if (figTr.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
      m = tboxMatMul(m, tboxMatT(-figTr.x, -figTr.y));
    }
    m = tboxMatMul(m, tboxMatT(trans.x + ax, trans.y + ay));
    m = tboxMatMul(m, tboxMatR(trans.angle));
    if (ink.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
    m = tboxMatMul(m, tboxMatT(-ax, -ay));
    m = tboxMatMul(m, tboxMatS(finalScale, finalScale));
    return m;
  }

  /* 世界坐标 → 屏幕坐标（普通视图 / 摄像机子轨道视角） */
  function worldToScreenPoint(p) {
    const cam = SKFE.systems.camera.getCameraViewObject();
    if (cam) {
      const t = SKFE.systems.camera.getCameraViewTransform(cam);
      const A = (p.x - cam.x) * t.fit;
      const B = (p.y - cam.y) * t.fit;
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      return { x: t.cx + A * c + B * s, y: t.cy - A * s + B * c };
    }
    return {
      x: p.x * AppState.viewScale + AppState.viewOffset.x,
      y: p.y * AppState.viewScale + AppState.viewOffset.y
    };
  }

  /* brush-v5.1.2: 在 ink 自己的坐标系里画一段擦除遮罩（destination-out）。
     与 eraser.js 的 drawEraseMask 等价，区别是它可以和笔迹交替绘制，
     从而支持"擦除之后又画上去"这种顺序关系。
     此时 ctx 已套用 fig 旋转/镜像，坐标按 local * finalScale 给，线宽是世界单位。 */
  function drawInkMaskLocal(c, er, fs) {
    const pts = er && er.points;
    if (!pts || !pts.length) return;
    const width = Math.max(0.0001, er.size || 1);
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.globalAlpha = 1;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = width;
    c.strokeStyle = '#000';
    c.fillStyle = '#000';
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x * fs, pts[0].y * fs, width / 2, 0, TAU);
      c.fill();
    } else {
      c.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = pts[i].x * fs, y = pts[i].y * fs;
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
    c.restore();
  }

  /* 6.3.2 画笔元件渲染（边先芯后：同一笔内"边被芯覆盖"） */
  /* ==================== v5.3.1 画笔 ink 的四角扭曲 ==================== */
  /* 笔迹点逐个过单应性，线宽按该点的局部比例缩放；擦除遮罩走同一套映射，
     保证"被擦掉的洞"跟着一起变形。挂载在火柴人身上时 mp 里已经合成父级单应性，
     所以整条笔迹会和身体走同一个投影（而不是只在挂载点附近做一阶近似）。 */
  function drawInkWarped(c, ink, mp, alphaMul) {
    const DL = SKFE.systems.distort;
    const LM = getInkLocalMatrix(ink);
    const syncScale = (ink.scale || 1) * ((getBindTransform(ink).syncScale) || 1);
    const alpha = (ink.alpha === undefined ? 1 : ink.alpha) * alphaMul;

    /* 局部坐标 → 变形后的世界坐标 */
    const toW = (x, y) => DL.mapWorld(mp, {
      x: LM.a * x + LM.c * y + LM.e,
      y: LM.b * x + LM.d * y + LM.f
    });
    /* 局部 1 单位在 (x,y) 处对应多长世界距离 */
    const kAt = (x, y) => {
      const a = toW(x, y), b = toW(x + 1, y);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      return isFinite(d) && d > 0 ? d : 0;
    };

    c.save();
    c.globalAlpha = alpha;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    /* v6.2.0：把「边」「芯」「橡皮」拆成三个独立动作，方便按描边铺底规则重新排序 */
    const paintBorder = (s, pts) => {
      if (!(s.borderWidth > 0) || !s.borderColor) return;
      c.strokeStyle = s.borderColor;
      c.fillStyle = s.borderColor;
      if (pts.length === 1) {
        const p = pts[0], q = toW(p.x, p.y);
        const kk = kAt(p.x, p.y);
        c.beginPath();
        c.arc(q.x, q.y, Math.max(p.w * kk / 2, 0.4) + s.borderWidth * kk, 0, TAU);
        c.fill();
      } else {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const qa = toW(a.x, a.y), qb = toW(b.x, b.y);
          const kk = (kAt(a.x, a.y) + kAt(b.x, b.y)) / 2;
          c.lineWidth = Math.max(0.5, ((a.w + b.w) / 2) * kk + s.borderWidth * 2 * kk);
          c.beginPath(); c.moveTo(qa.x, qa.y); c.lineTo(qb.x, qb.y); c.stroke();
        }
      }
    };

    const paintCore = (s, pts) => {
      c.strokeStyle = s.color;
      c.fillStyle = s.color;
      if (pts.length === 1) {
        const p = pts[0], q = toW(p.x, p.y);
        const kk = kAt(p.x, p.y);
        c.beginPath();
        c.arc(q.x, q.y, Math.max(p.w * kk / 2, 0.4), 0, TAU);
        c.fill();
      } else {
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i];
          const qa = toW(a.x, a.y), qb = toW(b.x, b.y);
          const kk = (kAt(a.x, a.y) + kAt(b.x, b.y)) / 2;
          c.lineWidth = Math.max(0.4, ((a.w + b.w) / 2) * kk);
          c.beginPath(); c.moveTo(qa.x, qa.y); c.lineTo(qb.x, qb.y); c.stroke();
        }
      }
    };

    const paintMask = (item) => {
      const pts = item.er && item.er.points;
      if (!pts || !pts.length) return;
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.globalAlpha = 1;
      c.strokeStyle = '#000'; c.fillStyle = '#000';
      if (unitsSafe(syncScale)) {
        if (pts.length === 1) {
          const p = toW(pts[0].x, pts[0].y);
          const kk = kAt(pts[0].x, pts[0].y) / syncScale;
          c.beginPath();
          c.arc(p.x, p.y, Math.max((item.er.size || 1) * kk / 2, 0.3), 0, TAU);
          c.fill();
        } else {
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const pa = toW(a.x, a.y), pb = toW(b.x, b.y);
            const kk = ((kAt(a.x, a.y) + kAt(b.x, b.y)) / 2) / syncScale;
            c.lineWidth = Math.max(0.3, (item.er.size || 1) * kk);
            c.beginPath(); c.moveTo(pa.x, pa.y); c.lineTo(pb.x, pb.y); c.stroke();
          }
        }
      }
      c.restore();
    };

    const inkErasers = ink.eraser || [];
    let ordered = ink.strokes;
    if (inkErasers.length) {
      ordered = [];
      for (const s of ink.strokes) ordered.push({ __inkMask: false, z: (typeof s.z === 'number' ? s.z : 0), s });
      for (const er of inkErasers) ordered.push({ __inkMask: true, z: (typeof er.z === 'number' ? er.z : 1e9), er });
      ordered.sort((a, b) => a.z - b.z);
    }

    /* 勾了「描边铺底」的连续几笔合并成一组：先把组内所有边画完，再统一画芯。
       橡皮与未勾选的笔会打断分组，保持原来的落笔顺序。 */
    let group = [];
    const flushGroup = () => {
      if (!group.length) return;
      for (const g of group) paintBorder(g.s, g.pts);
      for (const g of group) paintCore(g.s, g.pts);
      group = [];
    };

    for (const item of ordered) {
      if (item.__inkMask) { flushGroup(); paintMask(item); continue; }
      const s = item.__inkMask === false ? item.s : item;
      const pts = s.points;
      if (!pts || !pts.length) continue;
      if (s.outlineUnder) { group.push({ s, pts }); continue; }
      flushGroup();
      paintBorder(s, pts);
      paintCore(s, pts);
    }
    flushGroup();
    c.restore();
  }

  function unitsSafe(v) { return isFinite(v) && Math.abs(v) > 1e-9; }

  function queueInk(ink, isSel, isExporting, opts) {
    opts = opts || {};
    if (!ink || !ink.strokes || !ink.strokes.length) return;
    /* 正在重绘编辑的元件由 overlay 实时绘制，主画布跳过它，避免重影 */
    const brushMod = SKFE.systems.brush;
    if (!isExporting && brushMod && brushMod.getEditingInk && brushMod.getEditingInk() === ink) return;

    const alphaMul = resolveAlphaMul(opts, ink);
    const trans = getBindTransform(ink);
    const figTr = getBoundFigureTransform(ink);
    const finalScale = (ink.scale || 1) * (trans.syncScale || 1);
    const { ax, ay } = getAnchorOffset(ink, finalScale);
    const halfW = ((ink.w || 0) * finalScale) / 2;
    const halfH = ((ink.h || 0) * finalScale) / 2;
    const alpha = (ink.alpha === undefined ? 1 : ink.alpha);

    renderQueue.push({ level: ink.layer, draw: () => {
      /* v5.3.1：有扭曲时（自身的，或挂载继承父火柴人的）回到世界坐标逐点映射重绘 */
      const distInk = SKFE.systems.distort.getMapping(ink);
      if (distInk) {
        drawInkWarped(ctx, ink, distInk, alphaMul);
        if (isSel && !isExporting && !transformBoxOn) {
          strokeWarpQuad(distInk, ink.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)');
        }
        return;
      }
      ctx.save();
      applyFigTransformCtx(figTr);
      ctx.globalAlpha = alpha * alphaMul;
      ctx.translate(trans.x + ax, trans.y + ay);
      ctx.rotate(trans.angle);
      if (ink.mirror) ctx.scale(-1, 1);
      ctx.translate(-ax, -ay);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      /* brush-v5.1.2: 笔迹与擦除遮罩按落笔顺序 z 交替绘制 —— 遮罩只吃掉它之前的笔迹。
         以前是"先画完所有笔迹、再统一叠遮罩"，导致编辑时"先擦除再画上去"的新笔迹
         在确定后又被旧遮罩擦掉（看起来像没保存）。 */
      const inkErasers = ink.eraser || [];
      let ordered = ink.strokes;
      if (inkErasers.length) {
        ordered = [];
        for (const s of ink.strokes) ordered.push({ __inkMask: false, z: (typeof s.z === 'number' ? s.z : 0), s });
        for (const er of inkErasers) ordered.push({ __inkMask: true, z: (typeof er.z === 'number' ? er.z : 1e9), er });
        ordered.sort((a, b) => a.z - b.z);   /* 稳定排序：同 z 时笔迹先于遮罩 */
      }

      /* ---- 边 ---- */
      const paintBorder = (s, pts) => {
        if (!(s.borderWidth > 0 && s.borderColor)) return;
        ctx.strokeStyle = s.borderColor;
        ctx.fillStyle = s.borderColor;
        if (pts.length === 1) {
          const p = pts[0];
          ctx.beginPath();
          ctx.arc(p.x * finalScale, p.y * finalScale,
            Math.max(p.w * finalScale / 2, 0.4) + s.borderWidth * finalScale, 0, TAU);
          ctx.fill();
        } else {
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            ctx.lineWidth = Math.max(0.5,
              ((a.w + b.w) / 2) * finalScale + s.borderWidth * 2 * finalScale);
            ctx.beginPath();
            ctx.moveTo(a.x * finalScale, a.y * finalScale);
            ctx.lineTo(b.x * finalScale, b.y * finalScale);
            ctx.stroke();
          }
        }
      };

      /* ---- 芯 ---- */
      const paintCore = (s, pts) => {
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        if (pts.length === 1) {
          const p = pts[0];
          ctx.beginPath();
          ctx.arc(p.x * finalScale, p.y * finalScale, Math.max(p.w * finalScale / 2, 0.4), 0, TAU);
          ctx.fill();
        } else {
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            ctx.lineWidth = Math.max(0.4, ((a.w + b.w) / 2) * finalScale);
            ctx.beginPath();
            ctx.moveTo(a.x * finalScale, a.y * finalScale);
            ctx.lineTo(b.x * finalScale, b.y * finalScale);
            ctx.stroke();
          }
        }
      };

      /* v6.2.0 描边铺底：勾了 outlineUnder 的连续几笔合并成一组，
         先把组内所有边画完，再统一画芯 —— 后一笔的边不会压住前一笔的芯。
         橡皮与未勾选的笔会打断分组，保持原来的落笔顺序。 */
      let group = [];
      const flushGroup = () => {
        if (!group.length) return;
        for (const g of group) paintBorder(g.s, g.pts);
        for (const g of group) paintCore(g.s, g.pts);
        group = [];
      };

      for (const item of ordered) {
        if (item.__inkMask) { flushGroup(); drawInkMaskLocal(ctx, item.er, finalScale); continue; }
        const s = item.__inkMask === false ? item.s : item;
        const pts = s.points;
        if (!pts || !pts.length) continue;
        if (s.outlineUnder) { group.push({ s, pts }); continue; }
        flushGroup();
        paintBorder(s, pts);
        paintCore(s, pts);
      }
      flushGroup();
      ctx.restore();

      /* ---- 选中虚线框（与其它元件一致；变换框开启时由变换框代替） ---- */
      if (isSel && !isExporting && !transformBoxOn) {
        ctx.save();
        applyFigTransformCtx(figTr);
        ctx.strokeStyle = ink.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)';
        ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.translate(trans.x + ax, trans.y + ay);
        ctx.rotate(trans.angle);
        if (ink.mirror) ctx.scale(-1, 1);
        ctx.strokeRect(-halfW - ax, -halfH - ay, halfW * 2, halfH * 2);
        ctx.restore();
      }
    }});
  }

  function queueVideo(v, isSel, isExporting, opts) {
    if (isExporting) return;
    opts = opts || {};
    const alphaMul = resolveAlphaMul(opts, v);
    renderQueue.push({ level: v.layer, draw: () => {
      if (!refVideo || refVideo.readyState < 2 || !refVideoVisible) return;
      const sc = v.scale;
      const dw = v.w * sc, dh = v.h * sc;
      ctx.save();
      ctx.globalAlpha = v.alpha * alphaMul;
      if (!refVideoPlaying && videoCache[AppState.currentFrameIndex]) {
        ctx.drawImage(videoCache[AppState.currentFrameIndex], v.x - dw / 2, v.y - dh / 2, dw, dh);
      } else {
        ctx.drawImage(refVideo, v.x - dw / 2, v.y - dh / 2, dw, dh);
      }
      ctx.restore();
      if (isSel && !isExporting) {
        ctx.save();
        ctx.strokeStyle = v.locked ? 'rgba(239, 68, 68, 0.95)' : 'rgba(255,165,0,.95)';
        ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.strokeRect(v.x - dw / 2, v.y - dh / 2, dw, dh);
        ctx.restore();
      }
    }});
  }

  function imageBounds(im) {
    const w = im.w * im.scale, h = im.h * im.scale;
    return { x: im.x - w / 2, y: im.y - h / 2, w, h };
  }

  function renderScene(list, opts) {
    opts = opts || {};
    const isExporting = !!opts.isExporting;
    /* 渲染出口的绘制列表会剔除被小眼睛隐藏的元件，
       但 _renderList 必须保留**完整**列表：绑定件的父级查找（getBindTransform / getBindBase /
       getParentWarp / getMountedExtent）都依赖它。若把隐藏的 figure 摘掉，挂在它身上的画笔
       会查不到父级、回退到自身 x/y，看起来就是「隐藏火柴人后元件四散」。 */
    const prevList = _renderList;
    _renderList = opts.refList || list;
    const drawList = opts.includeHidden ? list : list.filter(o => o && !o.hidden);
    const prevQueue = renderQueue;
    renderQueue = [];

    for (const o of drawList) {
      const isSel = !isExporting && !opts.isGhost && o === AppState.selected;
      if (o.type === 'camera') { SKFE.systems.camera.queueCamera(o, isSel, isExporting, opts); continue; }
      // figure 的橡皮擦走 queueFigure 内部的肢体局部遮罩（drawMaskedLimb 等），
      // 只有图片/图形/对话框这类整体对象才走 drawErasedObjectGroup。
      if (o.type !== 'figure' && SKFE.systems.eraser.hasStrokes(o)) {
        const before = renderQueue.length;
        queueObjectByType(o, isSel, isExporting, opts);
        const produced = renderQueue.splice(before);
        const content = produced.filter(it => (it.level || 0) < 90000);
        const overlays = produced.filter(it => (it.level || 0) >= 90000);
        if (content.length) {
          const minLevel = Math.min.apply(null, content.map(it => it.level));
          renderQueue.push({ level: minLevel, draw: () => drawErasedObjectGroup(o, content) });
        }
        overlays.forEach(it => renderQueue.push(it));
        continue;
      }
      queueObjectByType(o, isSel, isExporting, opts);
    }

    const q = renderQueue;
    renderQueue = prevQueue;
    q.sort((a, b) => a.level - b.level);
    try {
      for (const item of q) item.draw();
    } finally {
      _renderList = prevList;
    }
  }

  /* ==================== v4.7.0 变换框系统 ==================== */
  /*
   * 说明：
   * 1. 框体基于对象渲染矩阵推导的 OBB（有向包围盒），不是 AABB，
   *    这样对象旋转/镜像后框仍然与渲染结果严格对齐。
   * 2. 四角按钮使用 DOM 绝对定位，位置随 render() 刷新，触摸命中更稳。
   * 3. 框内空白区域支持拖拽平移；四角按钮分别负责移动 / 缩放 / 旋转 / 镜像。
   */

  /* ---------- 2D 仿射矩阵（与 canvas 变换顺序一致） ---------- */
  function tboxMat(a, b, c, d, e, f) { return { a, b, c, d, e, f }; }
  function tboxMatIdentity() { return tboxMat(1, 0, 0, 1, 0, 0); }
  function tboxMatT(x, y) { return tboxMat(1, 0, 0, 1, x, y); }
  function tboxMatR(rad) { const c = Math.cos(rad), s = Math.sin(rad); return tboxMat(c, s, -s, c, 0, 0); }
  function tboxMatS(sx, sy) { return tboxMat(sx, 0, 0, sy, 0, 0); }
  function tboxMatMul(m1, m2) {
    return tboxMat(
      m1.a * m2.a + m1.c * m2.b,
      m1.b * m2.a + m1.d * m2.b,
      m1.a * m2.c + m1.c * m2.d,
      m1.b * m2.c + m1.d * m2.d,
      m1.a * m2.e + m1.c * m2.f + m1.e,
      m1.b * m2.e + m1.d * m2.f + m1.f
    );
  }
  function tboxMatApply(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }
  function tboxClamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  /* 把本地矩形四角经矩阵映射为世界四点（顺序：左上、右上、右下、左下） */
  function tboxQuadFromMatrix(m, x0, y0, x1, y1) {
    return [
      tboxMatApply(m, { x: x0, y: y0 }),
      tboxMatApply(m, { x: x1, y: y0 }),
      tboxMatApply(m, { x: x1, y: y1 }),
      tboxMatApply(m, { x: x0, y: y1 })
    ];
  }

  function tboxObbFromCorners(corners) {
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    let ex = corners[1].x - corners[0].x, ey = corners[1].y - corners[0].y;
    let fx = corners[3].x - corners[0].x, fy = corners[3].y - corners[0].y;
    let w = Math.hypot(ex, ey), h = Math.hypot(fx, fy);
    const angle = Math.atan2(ey, ex);
    return { cx, cy, w, h, angle, corners };
  }

  /* 变换框目标：优先画布边界，其次当前选中对象 */
  function getTransformBoxTarget() {
    if (AppState.canvasSelected && AppState.canvasBoundsEnabled) return CANVAS_BOUNDS_TARGET;
    if (AppState.selected && AppState.selected.type !== 'video') return AppState.selected;
    return null;
  }

  /* ---------- 各类型对象的 OBB（与 queueXxx 渲染矩阵严格一致） ---------- */
  /* v5.3.1：挂在该火柴人身上的所有元件的整体范围（换算到火柴人自己的「未旋转局部坐标」）。
     用于把控制点框从"光秃秃的火柴人"扩到"整个角色"，避免配饰被外推到盒外。 */
  function getMountedExtent(fig) {
    if (!fig) return null;
    const list = _renderList || AppState.objects;
    if (!list || !list.length) return null;
    const fid = String(fig.id);
    const rot = (fig.rot || 0) * Math.PI / 180;
    const cs = Math.cos(-rot), sn = Math.sin(-rot);
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, hit = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || c === fig) continue;
      if (c.type !== 'acc' && c.type !== 'shape' && c.type !== 'bubble' && c.type !== 'ink') continue;
      if (c.bindTo === 'none' || !c.targetId || String(c.targetId) !== fid) continue;
      const obb = getSourceOBB(c);
      if (!obb || !obb.corners) continue;
      for (let k = 0; k < 4; k++) {
        const p = obb.corners[k];
        if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
        /* 世界 → 火柴人未旋转局部坐标（T·R·M·T⁻¹ 的逆） */
        let dx = p.x - fig.x, dy = p.y - fig.y;
        if (fig.rot) { const nx = dx * cs - dy * sn; const ny = dx * sn + dy * cs; dx = nx; dy = ny; }
        if (fig.mirror) dx = -dx;
        const lx = fig.x + dx, ly = fig.y + dy;
        if (lx < l) l = lx;
        if (lx > r) r = lx;
        if (ly < t) t = ly;
        if (ly > b) b = ly;
        hit = true;
      }
    }
    return hit ? { l, r, t, b } : null;
  }

  /* v5.3.1：这是「原始（未变形）」的 OBB —— distort 模块要靠它反算盒空间，
     所以绝不能做变形，否则 getMapping 会自己递归自己。展示用的版本在 getObjectOBB。 */
  function getSourceOBB(o, skipMounted) {
    if (!o) return null;
    if (o === CANVAS_BOUNDS_TARGET) {
      const w = AppState.canvasBounds.w, h = AppState.canvasBounds.h;
      const cx = AppState.canvasBounds.x + w / 2, cy = AppState.canvasBounds.y + h / 2;
      const m = tboxMatMul(tboxMatT(cx, cy), tboxMatR(AppState.canvasBounds.rotation || 0));
      return tboxObbFromCorners(tboxQuadFromMatrix(m, -w / 2, -h / 2, w / 2, h / 2));
    }
    if (o.type === 'figure') {
      const j = jointData(o);
      /* v5.5.2：X 方向必须带上头部半径。以前这里只放了 headC.x 一个「点」，
         而 Y 方向是 ±headR 的「范围」—— 结果脑袋比盒子宽出一大截
         （实测头半径 54.4、盒子半宽 45.8，两侧各溢出 18.3px），
         控制点框切着脑袋过去；超出 margin 的部分还会被离屏画布裁掉。 */
      const xs = [j.headC.x - j.headR, j.headC.x + j.headR, j.pelvis.x, j.neck.x, j.handL.x, j.handR.x, j.footL.x, j.footR.x, j.wristL.x, j.wristR.x, j.toeL.x, j.toeR.x];
      const ys = [j.headC.y - j.headR, j.headC.y + j.headR, j.pelvis.y, j.neck.y, j.handL.y, j.handR.y, j.footL.y, j.footR.y, j.wristL.y, j.wristR.y, j.toeL.y, j.toeR.y];
      const pad = (o.lw * o.scale * SKFE.systems.spatial.maxLimbWidthFactor(o)) / 2 + 4;
      let l = Math.min.apply(null, xs) - pad, r = Math.max.apply(null, xs) + pad;
      let t = Math.min.apply(null, ys) - pad, b = Math.max.apply(null, ys) + pad;
      /* v5.3.1：把「挂在这具火柴人身上的元件」一起并进来。
         否则控制点只框住火柴人那个很窄的盒子，配饰被外推到盒外十几倍，投影会直接飞掉。
         并进来之后，4 个控制点框住的是【整个角色】，整张图才像一个整体。 */
      const ext = skipMounted ? null : getMountedExtent(o);
      if (ext) { l = Math.min(l, ext.l); r = Math.max(r, ext.r); t = Math.min(t, ext.t); b = Math.max(b, ext.b); }
      let m = tboxMatMul(tboxMatT(o.x, o.y), tboxMatR((o.rot || 0) * Math.PI / 180));
      if (o.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
      m = tboxMatMul(m, tboxMatT(-o.x, -o.y));
      return tboxObbFromCorners(tboxQuadFromMatrix(m, l, t, r, b));
    }
    if (o.type === 'image') {
      const b = imageBounds(o);
      const { ax, ay } = getAnchorOffset(o, o.scale);
      let m = tboxMatMul(tboxMatT(o.x + ax, o.y + ay), tboxMatR((o.rot || 0) * Math.PI / 180));
      if (o.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
      return tboxObbFromCorners(tboxQuadFromMatrix(m, -b.w / 2 - ax, -b.h / 2 - ay, b.w / 2 - ax, b.h / 2 - ay));
    }
    if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble') {
      const trans = getBindTransform(o);
      const figTr = getBoundFigureTransform(o);
      const finalScale = o.scale * trans.syncScale;
      /* v5.3.0：父火柴人变形时，残差必须并进 OBB，否则手柄/命中框会留在没变形的位置 */
      let m = tboxMatIdentity();
      if (figTr) {
        m = tboxMatMul(tboxMatT(figTr.x, figTr.y), tboxMatR(figTr.rot * Math.PI / 180));
        if (figTr.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
        m = tboxMatMul(m, tboxMatT(-figTr.x, -figTr.y));
      }
      const w = o.w * finalScale, h = o.h * finalScale;
      const { ax, ay } = getAnchorOffset(o, finalScale);
      m = tboxMatMul(m, tboxMatT(trans.x + ax, trans.y + ay));
      m = tboxMatMul(m, tboxMatR(trans.angle));
      if (o.type !== 'bubble' && o.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
      if (o.type === 'shape') m = tboxMatMul(m, tboxMatT(-ax, -ay));
      if (o.type === 'acc') {
        return tboxObbFromCorners(tboxQuadFromMatrix(m, -w / 2 - ax, -h / 2 - ay, w / 2 - ax, h / 2 - ay));
      }
      return tboxObbFromCorners(tboxQuadFromMatrix(m, -w / 2, -h / 2, w / 2, h / 2));
    }
    if (o.type === 'ink') { // brush-v5.1.0: §6.3.3
      const trans = getBindTransform(o);
      const figTr = getBoundFigureTransform(o);
      const finalScale = (o.scale || 1) * (trans.syncScale || 1);
      let m = tboxMatIdentity();
      if (figTr) {
        m = tboxMatMul(tboxMatT(figTr.x, figTr.y), tboxMatR(figTr.rot * Math.PI / 180));
        if (figTr.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
        m = tboxMatMul(m, tboxMatT(-figTr.x, -figTr.y));
      }
      const w = (o.w || 0) * finalScale, h = (o.h || 0) * finalScale;
      const { ax, ay } = getAnchorOffset(o, finalScale);
      m = tboxMatMul(m, tboxMatT(trans.x + ax, trans.y + ay));
      m = tboxMatMul(m, tboxMatR(trans.angle));
      if (o.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
      m = tboxMatMul(m, tboxMatT(-ax, -ay));
      return tboxObbFromCorners(tboxQuadFromMatrix(m, -w / 2, -h / 2, w / 2, h / 2));
    }
    if (o.type === 'camera') {
      const w = o.w * (o.scale || 1), h = o.h * (o.scale || 1);
      const m = tboxMatMul(tboxMatT(o.x, o.y), tboxMatR((o.rot || 0) * Math.PI / 180));
      return tboxObbFromCorners(tboxQuadFromMatrix(m, -w / 2, -h / 2, w / 2, h / 2));
    }
    return null;
  }

  /* ==================== v5.6.1 冻结变形框架 ====================
   *
   * 问题：火柴人的 OBB 是【每次渲染按当前姿势现算】的。distort 用 OBB 建「盒空间」，
   * 又把用户拖出来的 4 个角点按 sx = 当前盒宽 / baseW 做「角点自适应缩放」再贴回去。
   * 于是姿势一变（抬手 → 盒宽 136→315）→ sx 翻倍 → 变形结果整体被放大 →
   * 骨盆跟着漂 18~33px。用户看到的现象是「转个关节，盆骨就跑了」。
   *
   * 注意：这跟「画不画包围框」完全无关 —— getSourceOBB 是渲染管线里必然要算的，
   * 不显示框只是少描一层虚线，盒子照样每帧在算。所以「关掉包围框就能钉住骨盆」不成立。
   *
   * 解法：把变形框架「冻结」成一份与姿势无关的快照 d.frame0：
   *   - w/h     冻结时的盒宽高（之后不再随姿势变）
   *   - dx/dy   冻结时「盒中心 - 骨盆」在盒坐标轴上的分量
   *   - scale0  冻结时的 o.scale（关节长度按 scale 以骨盆为原点缩放，要同步跟上）
   *
   * 每帧还原框架时：轴线（ux/uy/vx/vy）用当前的（自动跟住 rot / mirror），
   * 中心 = 当前骨盆 + (dx·û + dy·v̂)·k。因为 rigid 变换对「骨盆 + 偏移」是线性的，
   * 这个式子天然跟住平移、旋转、镜像；而姿势变化只会改变【现算的盒子】，
   * 骨盆本身不动 → 框架不动 → 变形结果不动 → 盆骨钉死。
   *
   * frame0 全部是「相对骨盆 + 尺寸」，不含任何绝对世界坐标，所以存档 / 跨帧同步都安全。
   */

  /** 火柴人自身的刚性矩阵（绕 o.x,o.y 旋转 + 镜像），与 getSourceOBB 里那段保持一致 */
  function figureRigidMatrix(o) {
    let m = tboxMatMul(tboxMatT(o.x, o.y), tboxMatR((o.rot || 0) * Math.PI / 180));
    if (o.mirror) m = tboxMatMul(m, tboxMatS(-1, 1));
    return tboxMatMul(m, tboxMatT(-o.x, -o.y));
  }

  /** 从当前姿势的盒子 + 骨盆，生成（或重设）冻结框架。不碰 baseW/baseH，保证角点形状不被改。 */
  function captureWarpFrame(o) {
    if (!o || o.type !== 'figure' || !o.distort) return;
    const obb = getSourceOBB(o);
    if (!obb || !obb.corners || obb.corners.length < 4) return;
    const q = obb.corners, TL = q[0], TR = q[1], BL = q[3];
    const w = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    const h = Math.hypot(BL.x - TL.x, BL.y - TL.y);
    if (!(w > 1e-4) || !(h > 1e-4)) return;
    const ux = (TR.x - TL.x) / w, uy = (TR.y - TL.y) / w;
    const vx = (BL.x - TL.x) / h, vy = (BL.y - TL.y) / h;
    const ox = TL.x + ux * (w / 2) + vx * (h / 2);
    const oy = TL.y + uy * (w / 2) + vy * (h / 2);
    let j = null;
    try { j = jointData(o); } catch (_) { return; }
    if (!j || !j.pelvis) return;
    const pw = tboxMatApply(figureRigidMatrix(o), j.pelvis);
    const ddx = ox - pw.x, ddy = oy - pw.y;
    o.distort.frame0 = {
      w, h,
      dx: ddx * ux + ddy * uy,
      dy: ddx * vx + ddy * vy,
      scale0: o.scale || 1
    };
  }

  /** 还原当前该用的变形框架；没有冻结快照（旧存档 / 非火柴人）就返回 null，退回老逻辑 */
  function getFrozenFrame(o) {
    if (!o || o.type !== 'figure') return null;
    const d = o.distort;
    if (!d) return null;
    /* v5.6.1：老存档里没有 frame0（但扭曲是开着的）——首次渲染补拍一张，之后固定。
       getMapping 只在 ownOn 时才会问到这儿，所以不用再判 enabled。 */
    if (!d.frame0) {
      captureWarpFrame(o);
      if (!d.frame0) return null;
    }
    const f0 = d.frame0;
    if (!(f0.w > 1e-4) || !(f0.h > 1e-4)) return null;
    const obb = getSourceOBB(o);
    if (!obb || !obb.corners || obb.corners.length < 4) return null;
    const q = obb.corners, TL = q[0], TR = q[1], BL = q[3];
    const lw = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    const lh = Math.hypot(BL.x - TL.x, BL.y - TL.y);
    if (!(lw > 1e-4) || !(lh > 1e-4)) return null;
    /* 轴线永远取「当前」的 —— 旋转 / 镜像时框架跟着一起转，不用额外写分支 */
    const ux = (TR.x - TL.x) / lw, uy = (TR.y - TL.y) / lw;
    const vx = (BL.x - TL.x) / lh, vy = (BL.y - TL.y) / lh;
    let j = null;
    try { j = jointData(o); } catch (_) { return null; }
    if (!j || !j.pelvis) return null;
    const pw = tboxMatApply(figureRigidMatrix(o), j.pelvis);
    const k = (f0.scale0 > 0) ? Math.max(0.02, (o.scale || 1) / f0.scale0) : 1;
    const ax = (f0.dx * ux + f0.dy * vx) * k;
    const ay = (f0.dx * uy + f0.dy * vy) * k;
    return {
      w: f0.w * k, h: f0.h * k,
      ux, uy, vx, vy,
      ox: pw.x + ax, oy: pw.y + ay
    };
  }

  /* v5.3.1 展示用 OBB：对象有扭曲（自身开启，或挂载继承父火柴人）时返回变形后的四边形，
     让选中框 / 变换框跟着一起变形，而不是留在没变形的旧位置。 */
  function getObjectOBB(o) {
    const src = getSourceOBB(o);
    if (!src || o === CANVAS_BOUNDS_TARGET) return src;
    const mp = SKFE.systems.distort.getMapping(o);
    if (!mp) return src;
    const corners = mp.dst.map(p => SKFE.systems.distort.boxToWorld(mp.frame, p));
    if (!corners.every(c => isFinite(c.x) && isFinite(c.y))) return src;
    return tboxObbFromCorners(corners);
  }

  /* v5.5.0：变形的逆映射 —— 世界坐标（变形后）→ 世界坐标（源态）。
     拖动关节时指针落在变形后的图像上，必须反算回未变形空间才能改姿势；
     命中测试同理（否则「看到的位置点不到」）。
     getMapping 返回 null（未变形 / 类型不支持）时原样返回，零行为变化。 */
  function distortInvWorld(o, p) {
    const DZ = SKFE.systems.distort;
    if (!o || !p || !DZ) return p;
    const mp = DZ.getMapping(o);
    if (!mp) return p;
    const b = DZ.worldToBox(mp.frame, p);
    const inv = DZ.invertHomography(mp.H);
    if (!inv) return p;
    const q = DZ.applyHomography(b.x, b.y, inv);
    if (!isFinite(q.x) || !isFinite(q.y)) return p;
    return DZ.boxToWorld(mp.frame, q);
  }

  /* ---------- 世界坐标 → 屏幕坐标（普通视图 / 摄像机子轨道视角） ---------- */
  function tboxWorldToScreen(p) {
    const cam = SKFE.systems.camera.getCameraViewObject();
    if (cam) {
      const t = SKFE.systems.camera.getCameraViewTransform(cam);
      const dx = p.x - cam.x, dy = p.y - cam.y;
      const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
      return {
        x: t.cx + (dx * c - dy * s) * t.fit,
        y: t.cy + (dx * s + dy * c) * t.fit
      };
    }
    return { x: p.x * AppState.viewScale + AppState.viewOffset.x, y: p.y * AppState.viewScale + AppState.viewOffset.y };
  }

  /* 屏幕坐标 → 绑定空间（绑定对象在火柴人旋转/镜像后仍能正确移动） */
  function tboxWorldToBindSpace(o, p) {
    if (!o || (o.type !== 'acc' && o.type !== 'shape' && o.type !== 'bubble' && o.type !== 'ink')) return { x: p.x, y: p.y };
    const tr = getBoundFigureTransform(o);
    if (!tr) return { x: p.x, y: p.y };
    const dx = p.x - tr.x, dy = p.y - tr.y;
    const rad = tr.rot * Math.PI / 180;
    const c = Math.cos(-rad), s = Math.sin(-rad);
    let rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    if (tr.mirror) rx = -rx;
    return { x: tr.x + rx, y: tr.y + ry };
  }

  /* ---------- 计算视觉框（屏幕坐标，最小 80px） ---------- */
  function getTransformBoxGeometry() {
    if (!transformBoxOn || isPlaying || window.__isExporting) return null;
    const target = getTransformBoxTarget();
    if (!target) return null;
    if (target !== CANVAS_BOUNDS_TARGET && target.locked) return null;
    const obb = getObjectOBB(target);
    if (!obb) return null;
    const pts = obb.corners.map(tboxWorldToScreen);
    if (!pts.every(q => isFinite(q.x) && isFinite(q.y))) return null;
    const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    let ex = pts[1].x - pts[0].x, ey = pts[1].y - pts[0].y;
    let fx = pts[3].x - pts[0].x, fy = pts[3].y - pts[0].y;
    let w = Math.hypot(ex, ey), h = Math.hypot(fx, fy);
    if (!isFinite(w) || w < 0.001) { w = 1; ex = 1; ey = 0; }
    if (!isFinite(h) || h < 0.001) { h = 1; fx = 0; fy = 1; }
    const ux = ex / w, uy = ey / w;
    const vx = fx / h, vy = fy / h;
    const vw = Math.max(80, w), vh = Math.max(80, h);
    const hw = vw / 2, hh = vh / 2;

    /* v5.5.0：目标开着扭曲时，框体必须用「变形后的真实四边形」。
       原来的做法是从质心 + 两条边向量重建成平行四边形 —— 透视四边形不是平行四边形，
       重建出来的角会明显偏离真实角点（实测能偏 9px 以上），
       于是按钮被推到边中点上，跟扭曲控制点撞在一起。
       直接取 obb.corners（getObjectOBB 对变形对象返回的就是变形后的四角）即可，
       框线也和扭曲外轮廓完全重合。太小的对象仍按 80px 等比放大，保证按钮不挤。 */
    const hasDistort = !!(target !== CANVAS_BOUNDS_TARGET && target &&
                          SKFE.systems.distort.isActive(target));
    let corners;
    if (hasDistort) {
      const k = Math.min(w, h) < 80 ? 80 / Math.max(1, Math.min(w, h)) : 1;
      corners = pts.map(p => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
    } else {
      corners = [
        { x: cx - ux * hw - vx * hh, y: cy - uy * hw - vy * hh }, /* 左上 */
        { x: cx + ux * hw - vx * hh, y: cy + uy * hw - vy * hh }, /* 右上 */
        { x: cx + ux * hw + vx * hh, y: cy + uy * hw + vy * hh }, /* 右下 */
        { x: cx - ux * hw + vx * hh, y: cy - uy * hw + vy * hh }  /* 左下 */
      ];
    }
    return { target, obb, cx, cy, w: vw, h: vh, angle: Math.atan2(uy, ux), corners, hasDistort };
  }

  /* 屏幕点是否落在视觉框内 */
  function pointInTransformBoxScreen(screen) {
    const g = getTransformBoxGeometry();
    if (!g) return false;
    /* v5.5.0：变形对象的框是任意四边形，用多边形判定（矩形时结果与原来的旋转矩形判定等价） */
    return pointInQuad(screen, g.corners);
  }

  /* ---------- 绘制框体（屏幕坐标系，导出时不绘制） ---------- */
  function drawTransformBox() {
    if (!transformBoxOn || window.__isExporting) return;
    const g = getTransformBoxGeometry();
    if (!g) return;
    /* v5.5.0 曾经在这里 `if (hasDistort) return` —— 理由是「扭曲叠加层已经画了同一圈轮廓」。
       v5.6.2：叠加层现在只在 四角扭曲编辑模式 下画，而 activeTarget() 判定里
       `if (transformBoxOn) return null` —— 也就是说【开着变换框时叠加层必然不画】，
       两边互斥，再让位就变成谁都不画了。所以这里必须照常描出来。 */
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.moveTo(g.corners[0].x, g.corners[0].y);
    ctx.lineTo(g.corners[1].x, g.corners[1].y);
    ctx.lineTo(g.corners[2].x, g.corners[2].y);
    ctx.lineTo(g.corners[3].x, g.corners[3].y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(74,144,255,.92)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* ---------- 四角按钮定位 / 禁用状态 ---------- */
  function updateTransformBoxDOM() {
    const wrap = document.getElementById('transformBoxUI');
    if (!wrap) return;
    const g = getTransformBoxGeometry();
    if (!g) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    const rect = canvas.getBoundingClientRect();

    const place = (id, p) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.style.left = (rect.left + p.x) + 'px';
      btn.style.top = (rect.top + p.y) + 'px';
      btn.style.display = 'flex';
    };
    /* 右上 ✥ / 右下 ↘ / 左下 ↻ / 左上 ⇆ */
    place('tbBtnMove', g.corners[1]);
    place('tbBtnScale', g.corners[2]);
    place('tbBtnRotate', g.corners[3]);
    const mirrorBtn = document.getElementById('tbBtnMirror');
    const target = g.target;
    const canMirror = target !== CANVAS_BOUNDS_TARGET && ['figure', 'image', 'acc', 'shape', 'ink'].includes(target.type); // brush-v5.1.0: §6.3.4
    if (canMirror) place('tbBtnMirror', g.corners[0]);
    else if (mirrorBtn) mirrorBtn.style.display = 'none';

    const pinned = target !== CANVAS_BOUNDS_TARGET && target.type === 'figure' && hasAnyPinInAllFrames(target);
    const moveBtn = document.getElementById('tbBtnMove');
    const rotBtn = document.getElementById('tbBtnRotate');
    if (moveBtn) moveBtn.classList.toggle('disabled', !!pinned);
    if (rotBtn) rotBtn.classList.toggle('disabled', !!pinned);
    const scaleBtn = document.getElementById('tbBtnScale');
    if (scaleBtn) scaleBtn.classList.toggle('disabled', false);
  }

  /* ---------- 是否允许执行某类操作 ---------- */
  function tboxCanOperate(target, mode) {
    if (!target) return false;
    if (target !== CANVAS_BOUNDS_TARGET && target.locked) return false;
    if (mode === 'mirror') {
      return target !== CANVAS_BOUNDS_TARGET && ['figure', 'image', 'acc', 'shape', 'ink'].includes(target.type); // brush-v5.1.0: §6.3.4
    }
    if (target !== CANVAS_BOUNDS_TARGET && target.type === 'figure' && (mode === 'move' || mode === 'rotate')) {
      if (hasAnyPinInAllFrames(target)) {
        alert(tr2('alert.ikGroup', '当前元件存在关节固定，请先在「关节」面板中解除所有帧的固定，才能整体位移或旋转。'));
        return false;
      }
    }
    return true;
  }

  /* ---------- 拖拽状态 ---------- */
  function tboxScreenFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function beginTBoxDrag(mode, e, g) {
    if (!g || tboxDrag) return true;
    const target = g.target;
    if (!tboxCanOperate(target, mode)) return true;
    const screen = tboxScreenFromEvent(e);
    const world = getPos(e);
    const d = {
      mode, target, pointerId: e.pointerId,
      pre: getSnapshot(), moved: false,
      screenStart: screen, worldStart: world,
      screenCenter: { x: g.cx, y: g.cy },
      centerWorld: { x: g.obb.cx, y: g.obb.cy },
      startDist: Math.max(1, Math.hypot(screen.x - g.cx, screen.y - g.cy)),
      angle: g.angle,
      targetIsCanvas: target === CANVAS_BOUNDS_TARGET
    };
    {
      const dx = screen.x - g.cx, dy = screen.y - g.cy;
      const c = Math.cos(-g.angle), s = Math.sin(-g.angle);
      d.startLocal = { x: dx * c - dy * s, y: dx * s + dy * c };
    }
    if (target === CANVAS_BOUNDS_TARGET) {
      d.canvas0 = { x: AppState.canvasBounds.x, y: AppState.canvasBounds.y, w: AppState.canvasBounds.w, h: AppState.canvasBounds.h };
      d.centerWorld = { x: AppState.canvasBounds.x + AppState.canvasBounds.w / 2, y: AppState.canvasBounds.y + AppState.canvasBounds.h / 2 };
      d.startRotDeg = d.accumRot = (AppState.canvasBounds.rotation || 0) * 180 / Math.PI;
      d.lastAngle = Math.atan2(world.y - d.centerWorld.y, world.x - d.centerWorld.x);
    } else {
      d.startX = target.x; d.startY = target.y;
      d.startScale = target.scale || 1;
      d.startW = target.w; d.startH = target.h;
      d.startRot = target.rot || 0;
      d.accumRot = d.startRot;
      d.startPos = getObjectWorldPos(target);
      d.bound = isBoundObj(target);
      d.bindStart = tboxWorldToBindSpace(target, world);
      d.pivot = getRotatePivot(target) || d.startPos;
      const rp = d.bound ? d.bindStart : world;
      d.lastAngle = Math.atan2(rp.y - d.pivot.y, rp.x - d.pivot.x);
    }
    tboxDrag = d;
    document.addEventListener('pointermove', onTBoxDragMove, true);
    document.addEventListener('pointerup', onTBoxDragEnd, true);
    document.addEventListener('pointercancel', onTBoxDragEnd, true);
    try { if (e.target && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (_) {}
    return true;
  }

  function applyTBoxMove(d, world) {
    const target = d.target;
    if (target === CANVAS_BOUNDS_TARGET) {
      const dx = world.x - d.worldStart.x, dy = world.y - d.worldStart.y;
      const cx = d.centerWorld.x + dx, cy = d.centerWorld.y + dy;
      AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
      AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
      syncCanvasUI();
      return;
    }
    if (d.bound) {
      const bp = tboxWorldToBindSpace(target, world);
      const tx = d.startPos.x + (bp.x - d.bindStart.x);
      const ty = d.startPos.y + (bp.y - d.bindStart.y);
      setObjectWorldPos(target, tx, ty);
      setGlobalPropForBound(target, 'offX', target.offX);
      setGlobalPropForBound(target, 'offY', target.offY);
      return;
    }
    let tx = d.startX + (world.x - d.worldStart.x);
    let ty = d.startY + (world.y - d.worldStart.y);
    if (target.type !== 'camera') {
      const snap = calcSnap(tx, ty);
      tx += snap.dx; ty += snap.dy;
      snapLines.x = snap.lineX;
      snapLines.y = snap.lineY;
    }
    setObjectWorldPos(target, tx, ty);
  }

  function applyTBoxRotate(d, world) {
    const target = d.target;
    if (target === CANVAS_BOUNDS_TARGET) {
      const ang = Math.atan2(world.y - d.centerWorld.y, world.x - d.centerWorld.x);
      const raw = ang - d.lastAngle;
      d.accumRot += Math.atan2(Math.sin(raw), Math.cos(raw)) * 180 / Math.PI;
      d.lastAngle = ang;
      AppState.canvasBounds.rotation = d.accumRot * Math.PI / 180;
      // 同步更新基础属性面板里的旋转输入框
      if (objRotationInput && document.activeElement !== objRotationInput) {
        const deg = Math.round(d.accumRot);
        objRotationInput.value = deg;
        if (objRotationVal) objRotationVal.textContent = deg + '°';
      }
      return;
    }
    const rp = d.bound ? tboxWorldToBindSpace(target, world) : world;
    const ang = Math.atan2(rp.y - d.pivot.y, rp.x - d.pivot.x);
    const raw = ang - d.lastAngle;
    d.accumRot += Math.atan2(Math.sin(raw), Math.cos(raw)) * 180 / Math.PI;
    d.lastAngle = ang;
    target.rot = d.accumRot;
    if (d.bound) setGlobalPropForBound(target, 'rot', target.rot);
    else setGlobalProp(target, 'rot', target.rot);
    if (objRotationInput && document.activeElement !== objRotationInput) {
      objRotationInput.value = Math.round(d.accumRot);
      if (objRotationVal) objRotationVal.textContent = Math.round(d.accumRot) + '°';
    }
  }

  function applyTBoxScale(d, screen) {
    const target = d.target;
    const isFreeType = target === CANVAS_BOUNDS_TARGET || ['image', 'shape', 'acc'].includes(target.type);
    if (freeStretchOn && isFreeType) {
      /* 自由拉伸：按框的 X/Y 轴分别计算 kx / ky（不依赖视觉框最小尺寸） */
      const cos = Math.cos(-d.angle), sin = Math.sin(-d.angle);
      const dx = screen.x - d.screenCenter.x, dy = screen.y - d.screenCenter.y;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      const bx = Math.abs(d.startLocal.x) > 4 ? d.startLocal.x : (d.startLocal.x < 0 ? -4 : 4);
      const by = Math.abs(d.startLocal.y) > 4 ? d.startLocal.y : (d.startLocal.y < 0 ? -4 : 4);
      const kx = tboxClamp(lx / bx, 0.05, 10);
      const ky = tboxClamp(ly / by, 0.05, 10);
      if (target === CANVAS_BOUNDS_TARGET) {
        const cx = d.centerWorld.x, cy = d.centerWorld.y;
        AppState.canvasBounds.w = Math.max(10, d.canvas0.w * kx);
        AppState.canvasBounds.h = Math.max(10, d.canvas0.h * ky);
        AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
        AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
        syncCanvasUI();
      } else {
        target.w = Math.max(1, (d.startW || 1) * kx);
        target.h = Math.max(1, (d.startH || 1) * ky);
        if (d.bound) {
          setGlobalPropForBound(target, 'w', target.w);
          setGlobalPropForBound(target, 'h', target.h);
        } else {
          setGlobalProp(target, 'w', target.w);
          setGlobalProp(target, 'h', target.h);
        }
      }
      return;
    }

    /* 等比缩放：以鼠标到框中心距离比作为因子 */
    const dist = Math.hypot(screen.x - d.screenCenter.x, screen.y - d.screenCenter.y);
    let k = tboxClamp(dist / d.startDist, 0.05, 10);
    if (target === CANVAS_BOUNDS_TARGET) {
      const cx = d.centerWorld.x, cy = d.centerWorld.y;
      AppState.canvasBounds.w = Math.max(10, d.canvas0.w * k);
      AppState.canvasBounds.h = Math.max(10, d.canvas0.h * k);
      AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
      AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
      syncCanvasUI();
      return;
    }
    const ns = Math.max(0.01, d.startScale * k);
    target.scale = ns;
    const pinnedFig = target.type === 'figure' && hasAnyPinInAllFrames(target);
    if (!d.bound && !pinnedFig && target.type !== 'camera') {
      /* 围绕 OBB 中心缩放：位置随因子反算，保持中心不动 */
      target.x = d.centerWorld.x + (d.startPos.x - d.centerWorld.x) * k;
      target.y = d.centerWorld.y + (d.startPos.y - d.centerWorld.y) * k;
      if (target.type === 'figure') enforcePins(target);
    }
    if (d.bound) setGlobalPropForBound(target, 'scale', target.scale);
    else setGlobalProp(target, 'scale', target.scale);
  }

  function onTBoxDragMove(e) {
    const d = tboxDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (isPlaying) { cancelTransformBoxDrag(); return; }
    if (d.target === CANVAS_BOUNDS_TARGET) {
      if (!AppState.canvasSelected || !AppState.canvasBoundsEnabled) { cancelTransformBoxDrag(); return; }
    } else if (AppState.selected !== d.target) {
      cancelTransformBoxDrag(); return;
    }
    const screen = tboxScreenFromEvent(e);
    if (!d.moved && Math.hypot(screen.x - d.screenStart.x, screen.y - d.screenStart.y) > 0.5) d.moved = true;
    const world = getPos(e);
    if (d.mode === 'move') applyTBoxMove(d, world);
    else if (d.mode === 'rotate') applyTBoxRotate(d, world);
    else if (d.mode === 'scale') applyTBoxScale(d, screen);
    EventBus.emit('need:render');
  }

  function removeTBoxDragListeners() {
    document.removeEventListener('pointermove', onTBoxDragMove, true);
    document.removeEventListener('pointerup', onTBoxDragEnd, true);
    document.removeEventListener('pointercancel', onTBoxDragEnd, true);
  }

  function cancelTransformBoxDrag() {
    if (!tboxDrag) return;
    removeTBoxDragListeners();
    tboxDrag = null;
    snapLines = { x: null, y: null };
  }

  function onTBoxDragEnd(e) {
    const d = tboxDrag;
    if (!d) return;
    removeTBoxDragListeners();
    tboxDrag = null;
    if (e) {
      try { if (e.target && e.target.releasePointerCapture) e.target.releasePointerCapture(e.pointerId); } catch (_) {}
      pointers.delete(e.pointerId);
    }
    snapLines = { x: null, y: null };
    if (!d.moved) { EventBus.emit('need:render'); return; }
    if (d.mode === 'move' && d.target !== CANVAS_BOUNDS_TARGET && !d.bound) {
      applyGlobalPositionDeltaForObject(d.target, d.startPos);
    }
    let label = '变换对象';
    if (d.mode === 'move') label = d.target === CANVAS_BOUNDS_TARGET ? '拖动画布边界' : '移动对象';
    else if (d.mode === 'scale') label = d.target === CANVAS_BOUNDS_TARGET ? '缩放画布' : '缩放对象';
    else if (d.mode === 'rotate') label = d.target === CANVAS_BOUNDS_TARGET ? '旋转画布' : '旋转对象';
    pushPreSnapshot(d.pre, label);
    markCurrentFrameModified();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:syncUI');
    EventBus.emit('need:render');
  }

  /* 移动后把世界位移同步到该元件的其他帧 */
  function applyGlobalPositionDeltaForObject(o, prev) {
    if (!globalEditEnabled || !o || !prev) return;
    if (o.type === 'figure') { applyGlobalPositionDelta(o, prev); return; }
    if (o.type === 'camera') { /* 摄像机也按位移同步 */ }
    if (o.type === 'video') return;
    /* global-v5.1.1: 绑定元件的位置由 offX/offY 表达（拖动过程中已全局同步），这里跳过，
       否则会拿世界坐标差去改 x/y，造成个别帧跑位 */
    if (isBoundObj(o)) return;
    const dx = o.x - prev.x, dy = o.y - prev.y;
    if (!dx && !dy) return;
    const tid = String(o.id);
    const t = AppState.tracks[tid];
    if (!t || !t.frames) return;
    for (let i = 0; i < t.frames.length; i++) {
      if (i === AppState.currentFrameIndex) continue;
      const data = t.frames[i];
      if (data && String(data.id) === tid) { data.x += dx; data.y += dy; }
    }
    invalidateAllFrameThumbs();
  }

  /* 单击镜像 */
  function toggleTransformBoxMirror(target) {
    if (!target || target === CANVAS_BOUNDS_TARGET) return;
    if (!['figure', 'image', 'acc', 'shape', 'ink'].includes(target.type) || target.locked) return; // brush-v5.1.0: §6.3.4
    target.mirror = !target.mirror;
    if (isBoundObj(target)) setGlobalPropForBound(target, 'mirror', target.mirror);
    else setGlobalProp(target, 'mirror', target.mirror);
    markCurrentFrameModified();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:render');
    EventBus.emit('history:save', '镜像对象');
  }

  /* 绑定四角按钮 */
  (function initTransformBoxButtons() {
    const bindBtn = (id, mode) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (isPlaying) return;
        const g = getTransformBoxGeometry();
        if (!g) return;
        if (mode === 'mirror') { toggleTransformBoxMirror(g.target); return; }
        beginTBoxDrag(mode, e, g);
      });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    bindBtn('tbBtnMove', 'move');
    bindBtn('tbBtnScale', 'scale');
    bindBtn('tbBtnRotate', 'rotate');
    bindBtn('tbBtnMirror', 'mirror');

    const btnBox = document.getElementById('btnTransformBox');
    if (btnBox) {
      btnBox.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        transformBoxOn = !transformBoxOn;
        try { localStorage.setItem('skfe_transform_box_v1', transformBoxOn ? '1' : '0'); } catch (_) {}
        /* v5.5.2：开变换框就把扭曲的编辑模式让出去（两套手柄都在四角，同时显示必然打架）。
           注意只关「编辑模式」，不动 obj.distort.enabled —— 变形照常生效。 */
        if (transformBoxOn) distortEditOn = false;
        if (!transformBoxOn) cancelTransformBoxDrag();
        EventBus.emit('need:syncUI');
        EventBus.emit('need:render');
      });
    }
    const btnFree = document.getElementById('btnFreeStretch');
    if (btnFree) {
      btnFree.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (btnFree.disabled) return;
        freeStretchOn = !freeStretchOn;
        try { localStorage.setItem('skfe_free_stretch_v1', freeStretchOn ? '1' : '0'); } catch (_) {}
        EventBus.emit('need:syncUI');
        EventBus.emit('need:render');
      });
    }
  })();

  /* ==================== v5.2.0 四角扭曲（8 点透视变形）接线 ==================== */

  (function initDistortSystem() {
    const DZ = SKFE.systems.distort;
    if (!DZ) return;

    /* 把主程序的世界坐标能力注入系统，避免 distort.js 反向依赖 app.js 内部作用域 */
    DZ.setHooks({
      getObbCorners: (o) => {
        const obb = getSourceOBB(o);   /* 必须是未变形的，否则 getMapping 会自递归 */
        return (obb && obb.corners) ? obb.corners : null;
      },
      /* v5.6.1：火柴人的变形框架要冻结，否则姿势一变骨盆就漂（详见 captureWarpFrame 注释） */
      getFrozenFrame: (o) => getFrozenFrame(o),
      captureFrame: (o) => captureWarpFrame(o),
      /* v5.3.1：挂载元件继承父火柴人的单应性 —— 整个角色像一张图一起变形 */
      getParentWarp: (o) => getParentWarp(o),
      /* v5.5.1：变换框开着时，8 个扭曲控制点让位（按钮和角点天然互斥，不再错位） */
      isTransformBoxOn: () => !!transformBoxOn,
      /* v5.5.2：扭曲的编辑模式开关 —— 只有它为 true 才画控制点和网格 */
      isDistortEditOn: () => !!distortEditOn,
      worldToScreen: (p) => tboxWorldToScreen(p),
      screenToWorld: (sx, sy) => {
        const camView = SKFE.systems.camera.getCameraViewObject();
        if (camView) {
          const t = SKFE.systems.camera.getCameraViewTransform(camView);
          return SKFE.systems.camera.cameraScreenToWorld({ x: sx, y: sy }, camView, t);
        }
        return {
          x: (sx - AppState.viewOffset.x) / AppState.viewScale,
          y: (sy - AppState.viewOffset.y) / AppState.viewScale
        };
      },
      getSelected: () => AppState.selected,
      getCanvasRect: () => canvas.getBoundingClientRect(),
      requestRender: () => EventBus.emit('need:render'),
      syncUI: () => EventBus.emit('need:syncUI'),
      markModified: () => { markCurrentFrameModified(); invalidateAllFrameThumbs(); updateFrameBar(); },
      saveHistory: (label) => EventBus.emit('history:save', label),
      syncGlobal: (o) => syncDistortToAllFrames(o),
      isBlocked: () => isPlaying || !!window.__isExporting || !!SKFE.systems.camera.getCameraViewObject()
    });

    const btn = document.getElementById('btnDistort');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        toggleDistortMode();
      });
    }
    const btnOff = document.getElementById('btnDistortOff');
    if (btnOff) {
      btnOff.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btnOff.disabled) return;
        closeDistortMode();
      });
    }
  })();

  /* v5.5.2：编辑模式 —— 「四角扭曲」按钮只控制这 8 个控制点显不显示，
     和变换框按钮的逻辑一致（点一下出现、再点一下消失）。变形本身不受影响。
     真正的「取消变形」在旁边的「关闭扭曲」按钮。
     （状态变量 distortEditOn 声明在文件上方的变换框状态区，避免 TDZ） */

  /** 四角扭曲按钮：显示 / 隐藏 8 个控制点（首次点击会顺便开启变形，角点为恒等 = 视觉无变化） */
  function toggleDistortMode() {
    const DZ = SKFE.systems.distort;
    const o = AppState.selected;
    if (!o || o.locked || !DZ.supports(o)) return;
    if (isPlaying) return;

    const editingThis = distortEditOn && DZ.isActive(o);

    if (editingThis) {
      /* 再点一下：只隐藏控制点，已经做出来的变形保持原样 */
      DZ.cancelDrag();
      distortEditOn = false;
      EventBus.emit('need:syncUI');
      EventBus.emit('need:render');
      return;
    }

    DZ.ensure(o);            /* 四个角点按当前 OBB 现场生成 */
    DZ.setEnabled(o, true);  /* 首次开启时角点等于原矩形，画面不会有任何变化 */
    distortEditOn = true;

    /* 变换框和扭曲控制点都在四个角上，同时显示必然打架。
       进入扭曲编辑时把变换框让出去 —— 否则点了按钮看起来「没反应」。 */
    if (transformBoxOn) {
      transformBoxOn = false;
      try { localStorage.setItem('skfe_transform_box_v1', '0'); } catch (_) {}
      cancelTransformBoxDrag();
    }

    /* 全局属性开启时：开关状态 + 四角坐标一起下发到该元件的所有帧 */
    syncDistortToAllFrames(o);

    markCurrentFrameModified();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:syncUI');
    EventBus.emit('need:render');
    EventBus.emit('history:save', '编辑四角扭曲');
  }

  /** 关闭扭曲按钮：真的把变形关掉，对象恢复原状（角点数据保留，可再点「四角扭曲」继续调） */
  function closeDistortMode() {
    const DZ = SKFE.systems.distort;
    const o = AppState.selected;
    if (!o || !DZ.supports(o)) return;

    DZ.cancelDrag();
    DZ.setEnabled(o, false);
    distortEditOn = false;

    syncDistortToAllFrames(o);

    markCurrentFrameModified();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:syncUI');
    EventBus.emit('need:render');
    EventBus.emit('history:save', '关闭四角扭曲');
  }

  /* ==================== 锚点标记 ==================== */

  function drawAnchorMarker() {
    if (!AppState.selected || AppState.selected.locked) return;
    const a = getRotatePivot(AppState.selected);
    if (!a) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(239,68,68,0.95)';
    ctx.lineWidth = 2 / AppState.viewScale;
    ctx.setLineDash([5 / AppState.viewScale, 4 / AppState.viewScale]);
    ctx.beginPath(); ctx.arc(a.x, a.y, 11 / AppState.viewScale, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(a.x - 15 / AppState.viewScale, a.y); ctx.lineTo(a.x + 15 / AppState.viewScale, a.y);
    ctx.moveTo(a.x, a.y - 15 / AppState.viewScale); ctx.lineTo(a.x, a.y + 15 / AppState.viewScale);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(a.x, a.y, 4 / AppState.viewScale, 0, TAU);
    ctx.fillStyle = 'rgba(239,68,68,0.95)'; ctx.fill();
    ctx.restore();
  }

  /* 获取对象旋转轴心（世界坐标） */
  function getRotatePivot(o) {
    if (!o) return null;
    if (o.type === 'image') {
      return { x: o.x + (o.ax || 0) * o.scale, y: o.y + (o.ay || 0) * o.scale };
    }
    if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') {
      if (o.bindTo === 'none' || !o.targetId) {
        return { x: o.x + (o.ax || 0) * o.scale, y: o.y + (o.ay || 0) * o.scale };
      }
      const tr = getBindTransform(o);
      const fs = o.scale * tr.syncScale;
      return { x: tr.x + (o.ax || 0) * fs, y: tr.y + (o.ay || 0) * fs };
    }
    return { x: o.x, y: o.y };
  }

  /* ==================== 画布渲染 ==================== */
  let coordFlashTimer = null;
  function flashCoordDisplay() {
    const el = document.getElementById('coordDisplay');
    if (!el) return;
    el.style.display = 'block';
    void el.offsetWidth;
    el.style.opacity = '1';
    
    if (coordFlashTimer) clearTimeout(coordFlashTimer);
    coordFlashTimer = setTimeout(() => {
      coordFlashTimer = null;
      const el2 = document.getElementById('coordDisplay');
      if (tboxDrag) return;
      el2.style.opacity = '0';
      setTimeout(() => {
        if (!tboxDrag && !coordFlashTimer && el2.style.opacity === '0') {
          el2.style.display = 'none';
        }
      }, 300);
    }, 1000);
  }

  function updateCoordDisplay() {
    const el = document.getElementById('coordDisplay');
    if (!el) return;
    
    if (AppState.canvasSelected && AppState.canvasBoundsEnabled && !isPlaying) {
      document.getElementById('coordType').innerHTML = ic('picture') + tr2('coord.canvas', ' 画布');
      document.getElementById('coordXY').textContent =
        `X: ${Math.round(AppState.canvasBounds.x + AppState.canvasBounds.w / 2)}  Y: ${Math.round(displayY(AppState.canvasBounds.y + AppState.canvasBounds.h / 2))}`;
    } else if (AppState.selected && !isPlaying) {
      let x, y, typeIcon, typeName;
      if (AppState.selected.type === 'figure' || AppState.selected.type === 'image' || AppState.selected.type === 'video') {
        x = AppState.selected.x; y = AppState.selected.y;
        typeIcon = AppState.selected.type === 'figure' ? 'stickman' : AppState.selected.type === 'image' ? 'add-picture' : 'videocamera';
        typeName = AppState.selected.name;
      } else if (AppState.selected.type === 'camera') {
        x = AppState.selected.x; y = AppState.selected.y;
        typeIcon = 'videocamera';
        typeName = AppState.selected.name;
      } else {
        const tr = getBindTransform(AppState.selected);
        x = tr.x; y = tr.y;
        typeIcon = AppState.selected.type === 'acc' ? 'crown' : AppState.selected.type === 'shape' ? 'square' : 'comment-one';
        typeName = AppState.selected.name;
      }
      document.getElementById('coordType').innerHTML = ic(typeIcon) + ' ' + typeName;
      document.getElementById('coordXY').textContent = `X: ${Math.round(x)}  Y: ${Math.round(displayY(y))}`;
    } else {
      if (!tboxDrag && !coordFlashTimer && el.style.opacity !== '0' && el.style.display !== 'none') {
        el.style.opacity = '0';
        setTimeout(() => {
          if (!tboxDrag && !coordFlashTimer && el.style.opacity === '0') el.style.display = 'none';
        }, 300);
      }
      return;
    }
    
    if (tboxDrag && (AppState.selected || AppState.canvasSelected)) {
      el.style.display = 'block';
      el.style.opacity = '1';
    } else if (!coordFlashTimer && el.style.opacity !== '0' && el.style.display !== 'none') {
      el.style.opacity = '0';
      setTimeout(() => {
        if (!tboxDrag && !coordFlashTimer && el.style.opacity === '0') el.style.display = 'none';
      }, 300);
    }
  }

  function getObjectWorldPos(o) {
    if (!o) return { x: 0, y: 0 };
    if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') { // brush-v5.1.0: ink 走绑定坐标
      const tr = getBindTransform(o);
      return { x: tr.x, y: tr.y };
    }
    return { x: o.x, y: o.y };
  }

  /* 用四角变换计算轴对齐包围盒 */
  function cornersBounds(A, ax, ay, w, h, angle) {
    const lc = [
      [-w / 2 - ax, -h / 2 - ay], [w / 2 - ax, -h / 2 - ay],
      [w / 2 - ax, h / 2 - ay], [-w / 2 - ax, h / 2 - ay]
    ];
    const c = Math.cos(angle), s = Math.sin(angle);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx, ly] of lc) {
      const x = A.x + lx * c - ly * s;
      const y = A.y + lx * s + ly * c;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { left: minX, right: maxX, top: minY, bottom: maxY };
  }

  /* v5.2.0 四角扭曲：单应性把直线映射成直线，所以变形后的外轮廓恰好就是 4 角围成的四边形，
     把 4 个角点并进包围盒即可得到精确结果（导出裁剪、擦除局部画布都依赖它）。 */
  function expandBoundsForDistort(o, b) {
    if (!b) return b;
    const mp = SKFE.systems.distort.getMapping(o);   /* 自身扭曲 or 继承父级扭曲 */
    if (!mp) return b;
    let { left, right, top, bottom } = b;
    for (let i = 0; i < 4; i++) {
      const p = SKFE.systems.distort.boxToWorld(mp.frame, mp.dst[i]);
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      if (p.x < left) left = p.x;
      if (p.x > right) right = p.x;
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
    return { left, right, top, bottom };
  }

  function getObjectBounds(o) {
    return expandBoundsForDistort(o, getObjectBoundsBase(o));
  }

  function getObjectBoundsBase(o) {
    if (!o) return { left: 0, right: 0, top: 0, bottom: 0 };
    let b;
    if (o.type === 'camera') {
      const w = o.w * (o.scale || 1), h = o.h * (o.scale || 1);
      return cornersBounds({ x: o.x, y: o.y }, 0, 0, w, h, (o.rot || 0) * Math.PI / 180);
    }
    if (o.type === 'figure') {
      const j = jointData(o);
      const xs = [j.headC.x - j.headR, j.headC.x + j.headR, j.pelvis.x, j.neck.x, j.handL.x, j.handR.x, j.footL.x, j.footR.x, j.wristL.x, j.wristR.x, j.toeL.x, j.toeR.x];
      const ys = [j.headC.y - j.headR, j.headC.y + j.headR, j.pelvis.y, j.neck.y, j.handL.y, j.handR.y, j.footL.y, j.footR.y, j.wristL.y, j.wristR.y, j.toeL.y, j.toeR.y];
      const pad = (o.lw * o.scale) / 2 + 4;
      b = { left: Math.min(...xs) - pad, right: Math.max(...xs) + pad, top: Math.min(...ys) - pad, bottom: Math.max(...ys) + pad };
      if (o.rot || o.mirror) {
        const corners = [
          { x: b.left, y: b.top }, { x: b.right, y: b.top },
          { x: b.left, y: b.bottom }, { x: b.right, y: b.bottom }
        ];
        const transformed = corners.map(c => {
          let dx = c.x - o.x, dy = c.y - o.y;
          if (o.rot) {
            const r = o.rot * Math.PI / 180;
            const nx = dx * Math.cos(r) - dy * Math.sin(r);
            const ny = dx * Math.sin(r) + dy * Math.cos(r);
            dx = nx; dy = ny;
          }
          if (o.mirror) dx = -dx;
          return { x: o.x + dx, y: o.y + dy };
        });
        b = {
          left: Math.min(...transformed.map(c => c.x)),
          right: Math.max(...transformed.map(c => c.x)),
          top: Math.min(...transformed.map(c => c.y)),
          bottom: Math.max(...transformed.map(c => c.y))
        };
      }
      return b;
    }
    if (o.type === 'image') {
      const bb = imageBounds(o);
      const { ax, ay } = getAnchorOffset(o, o.scale);
      return cornersBounds({ x: o.x + ax, y: o.y + ay }, ax, ay, bb.w, bb.h, (o.rot || 0) * Math.PI / 180);
    }
    if (o.type === 'video') {
      const w = o.w * o.scale, h = o.h * o.scale;
      return { left: o.x - w / 2, right: o.x + w / 2, top: o.y - h / 2, bottom: o.y + h / 2 };
    }
    const tr = getBindTransform(o);
    const sc = o.scale * (tr.syncScale || 1);
    const w = o.w * sc, h = o.h * sc;
    const { ax, ay } = getAnchorOffset(o, sc);
    return cornersBounds({ x: tr.x + ax, y: tr.y + ay }, ax, ay, w, h, tr.angle);
  }

  function updatePosInputs() {
    if (!objXInput || !objYInput) return;
    
    if (AppState.canvasSelected && AppState.canvasBoundsEnabled) { 
      objXInput.value = Math.round(AppState.canvasBounds.x + AppState.canvasBounds.w / 2); 
      objYInput.value = Math.round(displayY(AppState.canvasBounds.y + AppState.canvasBounds.h / 2)); 
      if (objSizeInput) {
        objSizeInput.value = (canvasBaseBounds ? (AppState.canvasBounds.w / canvasBaseBounds.w) : 1).toFixed(2);
      }
      return; 
    }
    
    if (!AppState.selected) { 
      objXInput.value = ''; 
      objYInput.value = ''; 
      if (objSizeInput) objSizeInput.value = ''; 
      return; 
    }
    
    const p = getObjectWorldPos(AppState.selected);
    if (document.activeElement !== objXInput) objXInput.value = Math.round(p.x);
    if (document.activeElement !== objYInput) objYInput.value = Math.round(displayY(p.y));
    
    if (objSizeInput && document.activeElement !== objSizeInput) {
      objSizeInput.value = (AppState.selected.scale || 1).toFixed(2);
    }
  }

  function getBindBase(o) {
    if (!o || o.bindTo === 'none' || !o.targetId) return null;
    const list = _renderList || AppState.objects;
    const fig = list.find(f => f.id === o.targetId && f.type === 'figure');
    if (!fig) return null;
    const j = jointData(fig);
    let baseX = 0, baseY = 0, baseAngle = 0;
    switch (o.bindTo) {
      /* ---- 躯干 ---- */
      case 'head':
        baseX = j.headC.x; baseY = j.headC.y;
        baseAngle = fig.headAngle;
        break;
      case 'neck':
      case 'torso_upper':
        baseX = j.neck.x; baseY = j.neck.y;
        baseAngle = fig.a.torso + fig.a.waist;
        break;
      case 'waist':
      case 'torso_lower':
        baseX = j.waistPoint.x; baseY = j.waistPoint.y;
        baseAngle = fig.a.torso;
        break;
      case 'pelvis':
        baseX = j.pelvis.x; baseY = j.pelvis.y;
        baseAngle = fig.a.torso;
        break;

      /* ---- 上肢 ---- */
      case 'elbowL':
        baseX = j.elbowL.x; baseY = j.elbowL.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armL.u;
        break;
      case 'elbowR':
        baseX = j.elbowR.x; baseY = j.elbowR.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armR.u;
        break;
      case 'handL':
        baseX = j.handL.x; baseY = j.handL.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armL.u + fig.a.armL.f;
        break;
      case 'handR':
        baseX = j.handR.x; baseY = j.handR.y;
        baseAngle = fig.a.torso + fig.a.waist + fig.a.armR.u + fig.a.armR.f;
        break;

      /* ---- 下肢 ---- */
      case 'kneeL':
        baseX = j.thighL.x; baseY = j.thighL.y;
        baseAngle = fig.a.torso + fig.a.legL.u;
        break;
      case 'kneeR':
        baseX = j.thighR.x; baseY = j.thighR.y;
        baseAngle = fig.a.torso + fig.a.legR.u;
        break;
      case 'footL':
        baseX = j.footL.x; baseY = j.footL.y;
        baseAngle = fig.a.torso + fig.a.legL.u + fig.a.legL.f;
        break;
      case 'footR':
        baseX = j.footR.x; baseY = j.footR.y;
        baseAngle = fig.a.torso + fig.a.legR.u + fig.a.legR.f;
        break;
      default: return null;
    }
    return { x: baseX, y: baseY, angle: baseAngle, scale: fig.scale };
  }

  function setObjectWorldPos(o, wx, wy) {
    if (!o) return;
    const base = getBindBase(o);
    if (base) {
      const dx = wx - base.x, dy = wy - base.y;
      const c = Math.cos(base.angle), s = Math.sin(base.angle);
      o.offX = (dx * c + dy * s) / base.scale;
      o.offY = (-dx * s + dy * c) / base.scale;
    } else {
      o.x = wx; o.y = wy;
    }
    if (o.type === 'figure') enforcePins(o);
  }
  /* 绑定前坐标系 → 真实世界坐标（把火柴人自身的旋转/镜像算回去，顺序与 applyFigTransformCtx 一致） */
  function figTrForward(ftr, p) {
    if (!ftr) return { x: p.x, y: p.y };
    let dx = p.x - ftr.x, dy = p.y - ftr.y;
    if (ftr.mirror) dx = -dx;
    if (ftr.rot) {
      const r = ftr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      const nx = dx * c - dy * s, ny = dx * s + dy * c;
      dx = nx; dy = ny;
    }
    return { x: ftr.x + dx, y: ftr.y + dy };
  }
  /* 真实世界坐标 → 绑定前坐标系（上式的逆） */
  function figTrInverse(ftr, p) {
    if (!ftr) return { x: p.x, y: p.y };
    let dx = p.x - ftr.x, dy = p.y - ftr.y;
    if (ftr.rot) {
      const r = -ftr.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      const nx = dx * c - dy * s, ny = dx * s + dy * c;
      dx = nx; dy = ny;
    }
    if (ftr.mirror) dx = -dx;
    return { x: ftr.x + dx, y: ftr.y + dy };
  }

  /* bind-keep-v5.1.2: 切换「挂载点 / 绑定目标」时保持元件当前的大小、位置、旋转不变。
     只重算"依附于挂载点"的相对量（offX/offY/rot），绝不把 offX/offY/rot 归零，
     也不改动 scale / w / h / alpha —— 用户自己会微调对齐，绑定动作不该再改他的属性。
     mutate: 只改 bindTo / targetId 的回调。 */
  function rebindKeepPlacement(o, mutate) {
    if (!o) { if (mutate) mutate(); return; }
    const trBefore = getBindTransform(o);
    const ftrBefore = getBoundFigureTransform(o);
    /* 视觉大小：绑定元件会跟随火柴人缩放（syncScale），所以"看到的尺寸"要乘一次 */
    const syncBefore = trBefore.syncScale || 1;
    const visScale = (o.scale || 1) * syncBefore;
    /* 先折算成"真实世界"位置与角度：绑定/解绑时火柴人自身的旋转镜像会加进来或去掉 */
    const worldPos = figTrForward(ftrBefore, { x: trBefore.x, y: trBefore.y });
    let worldAng = trBefore.angle;
    if (ftrBefore) {
      const f = ftrBefore.rot * Math.PI / 180;
      worldAng = f + (ftrBefore.mirror ? -worldAng : worldAng);
    }
    if (mutate) mutate();

    const base = getBindBase(o);
    const ftrAfter = getBoundFigureTransform(o);
    /* 换挂载点/绑定目标时火柴人缩放会变，用元件自身 scale 抵一次，保证"看到的尺寸"不变 */
    const syncAfter = base ? (base.scale || 1) : 1;
    if (Math.abs(syncAfter - syncBefore) > 1e-9) o.scale = visScale / syncAfter;
    o.x = worldPos.x;
    o.y = worldPos.y;
    if (base) {
      const p = figTrInverse(ftrAfter, worldPos);
      const dx = p.x - base.x, dy = p.y - base.y;
      const c = Math.cos(base.angle), s = Math.sin(base.angle);
      const sc = base.scale || 1;
      o.offX = (dx * c + dy * s) / sc;              /* 世界差 → 挂载点局部（逆旋转 + 除缩放） */
      o.offY = (-dx * s + dy * c) / sc;
      /* 世界角 → 绑定前坐标系角（去掉火柴人旋转镜像）→ 减掉挂载角 = rot */
      let bindAng = worldAng;
      if (ftrAfter) bindAng = (ftrAfter.mirror ? -1 : 1) * (worldAng - ftrAfter.rot * Math.PI / 180);
      o.rot = (bindAng - base.angle) * 180 / Math.PI;
      /* 位置角度反算后，x/y 作为兜底缓存改回真实世界位置 */
      o.x = worldPos.x;
      o.y = worldPos.y;
    } else {
      o.offX = 0; o.offY = 0;                       /* 解绑：位置直接落在世界坐标上 */
      o.rot = worldAng * 180 / Math.PI;
    }
  }

  /* 把绑定相关的相对量同步到该元件的所有帧（全局属性修改关闭时只写当前帧） */
  function syncBindingPlacement(o) {
    if (!o) return;
    setGlobalPropForBound(o, 'x', o.x);
    setGlobalPropForBound(o, 'y', o.y);
    setGlobalPropForBound(o, 'offX', o.offX);
    setGlobalPropForBound(o, 'offY', o.offY);
    setGlobalPropForBound(o, 'rot', o.rot);
    setGlobalPropForBound(o, 'scale', o.scale);
  }

  function applyGlobalPositionDelta(fig, prevPos) {
    if (!globalEditEnabled) return;
    if (!fig || fig.type !== 'figure' || !prevPos) return;
    const dx = fig.x - prevPos.x;
    const dy = fig.y - prevPos.y;
    if (dx === 0 && dy === 0) return;
    const tid = String(fig.id);
    const t = AppState.tracks[tid];
    if (!t || !t.frames) return;
    for (let i = 0; i < t.frames.length; i++) {
      if (i === AppState.currentFrameIndex) continue;
      const data = t.frames[i];
      if (data && String(data.id) === tid) {
        data.x += dx;
        data.y += dy;
      }
    }
    invalidateAllFrameThumbs();
  }

  function hasAnyPinInAllFrames(fig) {
    if (!fig || fig.type !== 'figure') return false;
    const tid = String(fig.id);
    const t = AppState.tracks[tid];
    if (!t || !t.frames) return false;
    for (let i = 0; i < t.frames.length; i++) {
      const data = t.frames[i];
      if (data && String(data.id) === tid && data.ikEnabled && data.pinned) {
        if (data.pinned.footL || data.pinned.footR || data.pinned.handL || data.pinned.handR || data.pinned.pelvis) {
          return true;
        }
      }
    }
    return false;
  }
  let headHandleOn = false;
  let headHandleDrag = null;

  function updateAnchorHandle() {
    if (!anchorHandleEl) return;
    if (!anchorModeOn || !AppState.selected || isPlaying || AppState.selected.locked) { 
      anchorHandleEl.style.display = 'none'; 
      return; 
    }
    if (!(AppState.selected.type === 'image' || AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble')) {
      anchorHandleEl.style.display = 'none';
      return;
    }
    
    const ap = getRotatePivot(AppState.selected);
    if (!ap) { anchorHandleEl.style.display = 'none'; return; }
    
    // 显示在锚点右侧
    const leftScreen = ap.x * AppState.viewScale + AppState.viewOffset.x;
    const midY = ap.y * AppState.viewScale + AppState.viewOffset.y;
    
    const margin = 56;
    let x = leftScreen + margin; 
    x = Math.max(44, Math.min(window.innerWidth - 44, x));
    const viewH = canvas.clientHeight || window.innerHeight;
    const y = Math.max(46, Math.min(viewH - 46, midY));
    
    const rect = canvas.getBoundingClientRect();
    anchorHandleEl.style.left = (x + rect.left) + 'px';
    anchorHandleEl.style.top = (y + rect.top) + 'px';
    anchorHandleEl.style.display = 'flex';
  }

  function updateHeadMoveHandle() {
    const el = document.getElementById('headMoveHandle');
    if (!el) return;
    if (!headHandleOn || !AppState.selected || AppState.selected.type !== 'figure' || isPlaying || AppState.selected.locked) {
      el.style.display = 'none';
      return;
    }
    const j = jointData(AppState.selected);
    const b = getObjectBounds(AppState.selected);
    
    // 将世界坐标转换到屏幕坐标
    let x = j.headC.x * AppState.viewScale + AppState.viewOffset.x;
    let y = j.headC.y * AppState.viewScale + AppState.viewOffset.y;
    
    // 如果头部超出屏幕边缘，做一点限制（可选）
    x = Math.max(44, Math.min(window.innerWidth - 44, x));
    y = Math.max(46, Math.min(window.innerHeight - 46, y));

    const rect = canvas.getBoundingClientRect();
    el.style.left = (x + rect.left) + 'px';
    el.style.top = (y + rect.top) + 'px';
    el.style.display = 'flex';
  }

  function getTrackObjectsAt(idx) {
    const list = [];
    for (const id in AppState.tracks) {
      const data = getTrackFrame(id, idx);
      if (data) list.push(data);
    }
    return list;
  }

  function getCombinedObjectsForRenderAt(idx) {
    const list = [];
    if (videoObj) list.push(videoObj);
    for (const id in AppState.tracks) {
      const data = getTrackFrame(id, idx);
      /* v6.1.0：轨道里理论上不该有参考视频；万一有（老项目文件），也不要重复加入 */
      if (data && data !== videoObj) list.push(data);
    }
    return list;
  }

  function getObjectsForFrameAt(idx, trackId) {
    if (trackId != null && trackId !== TRACK_ALL_ID) {
      if (isCameraTrackId(String(trackId))) return getTrackObjectsAt(idx);
      const data = getTrackFrame(String(trackId), idx);
      return data ? [data] : [];
    }
    return getTrackObjectsAt(idx);
  }

  function getCombinedObjectsForRender() {
    return getCombinedObjectsForRenderAt(AppState.currentFrameIndex);
  }

  /* v6.4.0：铺满整块画布的底色 / 清屏。
     导出时 exportImage 会先给 ctx 设一套 scale+translate 的变换，
     之前这里直接用 canvas.width（设备像素）当宽高，被变换放大后又整体偏移，
     结果只盖住画布约 1/4（JPG 导出背景 3/4 变黑）。这里改成回到单位变换再铺，
     与当前变换无关，任何缩放下都能铺满。 */
  function paintWholeCanvas(color) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (color == null) ctx.clearRect(0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.restore();
  }

  function renderCanvas(isExporting) {
    isExporting = !!isExporting;
    const trackAlphaOpts = (!isExporting && isSubTrackMode()) ? { alphaFor: getTrackRenderAlpha } : {};
    const w = canvas.width, h = canvas.height;
    paintWholeCanvas(null);

    if (!isExporting) {
      paintWholeCanvas(pageBgAlpha < 1 ? themeHexToRgba(pageBgColor, pageBgAlpha) : pageBgColor);
    } else if (window.exportFormat === 'jpg') {
      paintWholeCanvas('#ffffff');
    }

    /* 摄像机子轨道：整块画布切换为摄像机取景视角 */
    const camView = !isExporting ? SKFE.systems.camera.getCameraViewObject() : null;
    if (camView) {
      SKFE.systems.camera.renderCameraViewScene(camView, trackAlphaOpts);
      drawLayerNumbers();
      drawTransformBox();
      return;
    }

    if (!isExporting) {
      ctx.save();
      ctx.translate(AppState.viewOffset.x, AppState.viewOffset.y);
      ctx.scale(AppState.viewScale, AppState.viewScale);
      drawGrid(w / AppState.viewScale, h / AppState.viewScale);
      if (groundLineEnabled) drawGroundLine();
    }

    if (!isExporting && onionEnabled && !isPlaying) {
      for (let d = onionBefore; d >= 1; d--) {
        const idx = AppState.currentFrameIndex - d;
        if (idx < 0 || idx >= AppState.frames.length) continue;
        const a = ONION_ALPHA * Math.pow(0.85, d - 1);
        renderScene(getTrackObjectsAt(idx), Object.assign({ alphaMul: a, tint: ONION_COLOR_BEFORE, isGhost: true }, trackAlphaOpts));
      }
      for (let d = onionAfter; d >= 1; d--) {
        const idx = AppState.currentFrameIndex + d;
        if (idx < 0 || idx >= AppState.frames.length) continue;
        const a = ONION_ALPHA * Math.pow(0.85, d - 1);
        renderScene(getTrackObjectsAt(idx), Object.assign({ alphaMul: a, tint: ONION_COLOR_AFTER, isGhost: true }, trackAlphaOpts));
      }
    }

    const objsToRender = getCombinedObjectsForRender();
    renderScene(objsToRender, Object.assign({ isExporting }, trackAlphaOpts));

    if (!isExporting) {
      ctx.restore();

      if (canvasMaskEnabled && AppState.canvasBoundsEnabled) {
        ctx.save();
        // 1. 遮罩背景颜色
        const rgbBg = hexToRgb(canvasMaskBgColor);
        ctx.fillStyle = `rgba(${rgbBg[0]}, ${rgbBg[1]}, ${rgbBg[2]}, ${canvasMaskAlpha})`;
        ctx.beginPath();
        ctx.rect(0, 0, canvas.clientWidth, canvas.clientHeight);
        ctx.translate(AppState.viewOffset.x, AppState.viewOffset.y);
        ctx.scale(AppState.viewScale, AppState.viewScale);
        ctx.translate(AppState.canvasBounds.x + AppState.canvasBounds.w / 2, AppState.canvasBounds.y + AppState.canvasBounds.h / 2);
        ctx.rotate(AppState.canvasBounds.rotation || 0);
        ctx.rect(-AppState.canvasBounds.w / 2, -AppState.canvasBounds.h / 2, AppState.canvasBounds.w, AppState.canvasBounds.h);
        ctx.fill('evenodd'); 

        // 2. 在遮罩区域内绘制固定大小的网格
        if (canvasMaskAlpha > 0.05) {
          ctx.clip('evenodd'); 
          ctx.rotate(-(AppState.canvasBounds.rotation || 0));
          ctx.translate(-(AppState.canvasBounds.x + AppState.canvasBounds.w / 2), -(AppState.canvasBounds.y + AppState.canvasBounds.h / 2));

          // 核心：把固定的屏幕像素大小（gridSize）除以当前的缩放比例，使其不跟随视图缩放
          const s = Math.max(8, gridSize) / AppState.viewScale; 
          const x0 = -AppState.viewOffset.x / AppState.viewScale;
          const y0 = -AppState.viewOffset.y / AppState.viewScale;
          const x1 = (canvas.clientWidth - AppState.viewOffset.x) / AppState.viewScale;
          const y1 = (canvas.clientHeight - AppState.viewOffset.y) / AppState.viewScale;

          const rgbGrid = hexToRgb(canvasMaskGridColor);
          ctx.strokeStyle = `rgba(${rgbGrid[0]}, ${rgbGrid[1]}, ${rgbGrid[2]}, ${0.15 * canvasMaskAlpha})`; 
          ctx.lineWidth = 1 / AppState.viewScale;
          ctx.beginPath();

          // 让网格线完美对齐画布的左上角边缘
          const startX = AppState.canvasBounds.x + Math.floor((x0 - AppState.canvasBounds.x) / s) * s;
          for (let x = startX; x <= x1; x += s) {
            ctx.moveTo(x, y0);
            ctx.lineTo(x, y1);
          }
          
          const startY = AppState.canvasBounds.y + Math.floor((y0 - AppState.canvasBounds.y) / s) * s;
          for (let y = startY; y <= y1; y += s) {
            ctx.moveTo(x0, y);
            ctx.lineTo(x1, y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.save();
      ctx.translate(AppState.viewOffset.x, AppState.viewOffset.y);
      ctx.scale(AppState.viewScale, AppState.viewScale);
      drawCanvasBounds();
      if (anchorModeOn && AppState.selected && !AppState.selected.locked &&
          (AppState.selected.type === 'image' || AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble')) {
        drawAnchorMarker();
      }
      ctx.restore();

      /* 绘制吸附紫色辅助线 */
      if (snapLines.x !== null || snapLines.y !== null) {
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); /* 强制回到屏幕坐标系 */
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        if (snapLines.x !== null) {
          const sx = snapLines.x * AppState.viewScale + AppState.viewOffset.x;
          ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, window.innerHeight); ctx.stroke();
        }
        if (snapLines.y !== null) {
          const sy = snapLines.y * AppState.viewScale + AppState.viewOffset.y;
          ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(window.innerWidth, sy); ctx.stroke();
        }
        ctx.restore();
      }

      drawLayerNumbers();
      drawTransformBox();
      SKFE.systems.distort.drawOverlay(ctx); /* v5.2.0 扭曲网格与轮廓（导出时不画） */
    }
  }

  let scrubberSide = null;

  function formatTimeMs(ms) {
    const sec = Math.max(0, ms) / 1000;
    if (sec < 60) return sec.toFixed(2) + 's';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m + ':' + s.toFixed(1).padStart(4, '0');
  }

  function pulseScrubberTime(moveLeft) {
    const cls = moveLeft ? 'st-slide-left' : 'st-slide-right';
    ['scrubberTimeNow', 'scrubberTimeTotal'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('st-slide-left', 'st-slide-right');
      void el.offsetWidth;   /* 强制 reflow，让动画可重复触发 */
      el.classList.add(cls);
    });
  }

  function updateScrubberTime() {
    const wrap = document.getElementById('scrubberWrap');
    const nowEl = document.getElementById('scrubberTimeNow');
    const totalEl = document.getElementById('scrubberTimeTotal');
    const scrubber = document.getElementById('timelineScrubber');
    if (!wrap || !nowEl || !totalEl || !scrubber) return;

    const show = AppState.frames.length > 1;
    wrap.classList.toggle('visible', show);
    if (!show) { scrubberSide = null; return; }

    const totalMs = AppState.frames.reduce((s, f) => s + (f.duration || 0), 0);
    const idx = Math.max(0, Math.min(AppState.currentFrameIndex, AppState.frames.length - 1));
    let nowMs = 0;
    for (let i = 0; i < idx; i++) nowMs += AppState.frames[i].duration || 0;

    nowEl.textContent = formatTimeMs(nowMs);
    totalEl.textContent = formatTimeMs(totalMs);

    const max = AppState.frames.length - 1;
    const ratio = max > 0 ? idx / max : 0;
    const useLeft = ratio >= 0.5;   /* true: 当前时刻在 thumb 左侧，总时长在左端 */

    const W = scrubber.clientWidth;
    if (W <= 0) return;
    const thumbW = 13;
    const trackLeft = thumbW / 2;
    const trackRight = Math.max(trackLeft, W - thumbW / 2);
    const thumbCenter = trackLeft + (trackRight - trackLeft) * ratio;
    const GAP = 9;

    if (useLeft) {
      nowEl.style.left = 'auto';
      nowEl.style.right = (W - thumbCenter + GAP) + 'px';
      totalEl.style.left = '0';
      totalEl.style.right = 'auto';
    } else {
      nowEl.style.right = 'auto';
      nowEl.style.left = (thumbCenter + GAP) + 'px';
      totalEl.style.right = '0';
      totalEl.style.left = 'auto';
    }

    if (scrubberSide !== null && scrubberSide !== useLeft) {
      pulseScrubberTime(useLeft);
    }
    scrubberSide = useLeft;
  }

  function updateFrameBarHighlight() {
    const bar = document.getElementById('frameBar');
    if (!bar) return;
    const chips = bar.querySelectorAll('.frame-chip');
    chips.forEach((chip, i) => {
      if (i === AppState.currentFrameIndex) chip.classList.add('active');
      else chip.classList.remove('active');
    });
    const scrubber = document.getElementById('timelineScrubber');
    if (scrubber && +scrubber.value !== AppState.currentFrameIndex) {
      scrubber.value = AppState.currentFrameIndex;
    }
    updateScrubberTime();
    /* v7.0.0：播放头动了，段曲线上的进度点也要跟着走 */
    if (typeof renderKfCurveStrip === 'function') renderKfCurveStrip();
    if (typeof syncKeyframeButtonState === 'function') syncKeyframeButtonState();
  }

  /* ==================== 显示图层数字 ==================== */
  function drawLayerNumbers() {
    if (activeTool !== 'layer') return;

    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    /* 文字颜色使用画布背景色 */
    const textColor = pageBgColor;

    const formatL = (val) => {
      if (val === undefined || val === null) return '';
      if (val > 999) return '>999';
      if (val < -999) return '<-999';
      return String(val);
    };

    /* figure 局部坐标 → 世界坐标（应用 rot / mirror，绕 o.x, o.y） */
    const figLocalToWorld = (o, lx, ly) => {
      let dx = lx - o.x, dy = ly - o.y;
      if (o.rot) {
        const r = o.rot * Math.PI / 180;
        const nx = dx * Math.cos(r) - dy * Math.sin(r);
        const ny = dx * Math.sin(r) + dy * Math.cos(r);
        dx = nx; dy = ny;
      }
      if (o.mirror) dx = -dx;
      return { x: o.x + dx, y: o.y + dy };
    };

    const drawNum = (wx, wy, num) => {
      if (num === undefined || num === null) return;
      const text = formatL(num);
      if (!text) return;

      const sx = wx * AppState.viewScale + AppState.viewOffset.x;
      const sy = wy * AppState.viewScale + AppState.viewOffset.y;

      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;

      ctx.fillStyle = textColor;
      ctx.fillText(text, sx, sy);

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    };

    const isSub = isSubTrackMode();
    const hideOthers = otherTracksVisibility === 'hide';

    for (const o of AppState.objects) {
      if (o.type === 'video') continue;

      if (isSub && hideOthers && String(o.id) !== AppState.activeTrackId) {
        continue;
      }

      if (o.type === 'figure') {
        const j = jointData(o);
        const L = o.layer;
        const toWorld = (p) => figLocalToWorld(o, p.x, p.y);

        // 1. 躯干：盆骨-腰部中点（跟随旋转/镜像）
        let w = toWorld({ x: (j.pelvis.x + j.waistPoint.x) / 2, y: (j.pelvis.y + j.waistPoint.y) / 2 });
        drawNum(w.x, w.y, L.body);

        // 2. 头部：局部右侧偏移，向量跟随旋转/镜像
        const headWorld = toWorld({ x: j.headC.x, y: j.headC.y });
        let dxR = j.headR, dyR = 0;
        if (o.rot) {
          const r = o.rot * Math.PI / 180;
          const nx = dxR * Math.cos(r) - dyR * Math.sin(r);
          const ny = dxR * Math.sin(r) + dyR * Math.cos(r);
          dxR = nx; dyR = ny;
        }
        if (o.mirror) dxR = -dxR;
        drawNum(headWorld.x + dxR, headWorld.y + dyR, L.head);

        // 3. 左臂：小臂中点
        w = toWorld({ x: (j.elbowL.x + j.handL.x) / 2, y: (j.elbowL.y + j.handL.y) / 2 });
        drawNum(w.x, w.y, L.armL);

        // 4. 右臂：小臂中点
        w = toWorld({ x: (j.elbowR.x + j.handR.x) / 2, y: (j.elbowR.y + j.handR.y) / 2 });
        drawNum(w.x, w.y, L.armR);

        // 5. 左腿：小腿中点
        w = toWorld({ x: (j.thighL.x + j.footL.x) / 2, y: (j.thighL.y + j.footL.y) / 2 });
        drawNum(w.x, w.y, L.legL);

        // 6. 右腿：小腿中点
        w = toWorld({ x: (j.thighR.x + j.footR.x) / 2, y: (j.thighR.y + j.footR.y) / 2 });
        drawNum(w.x, w.y, L.legR);

      } else if (o.type === 'camera') {
        // 摄像机：局部左上角，位置跟随 cam.rot
        const w = o.w * (o.scale || 1);
        const h = o.h * (o.scale || 1);
        const offsetDist = 12 / AppState.viewScale;
        let dx = -w / 2 + offsetDist, dy = -h / 2 + offsetDist;
        if (o.rot) {
          const r = o.rot * Math.PI / 180;
          const nx = dx * Math.cos(r) - dy * Math.sin(r);
          const ny = dx * Math.sin(r) + dy * Math.cos(r);
          dx = nx; dy = ny;
        }
        drawNum(o.x + dx, o.y + dy, o.layer);

      } else {
        // 其他元件：AABB 中心（getObjectBounds 本身已考虑旋转，中心即旋转后的中心）
        const b = getObjectBounds(o);
        drawNum((b.left + b.right) / 2, (b.top + b.bottom) / 2, o.layer);
      }
    }

    ctx.restore();
  }

  function render() {
    refreshSubTrackOptions();
    syncSubTrackSelection();
    for (const o of AppState.objects) {
      if (o.type === 'figure' && o.ikEnabled) {
        applyIK(o);
        enforcePins(o);
      }
    }
    renderCanvas(false);
    updateLayerList();
    updateFrameBar();
    updateCoordDisplay();
    updateTransformBoxDOM();
    SKFE.systems.distort.updateUI(); /* v5.2.0 同步 8 个扭曲控制点的位置 */
    updateAnchorHandle();
    updatePosInputs();
    SKFE.systems.camera.updateCameraPreview();
  }

  /* ==================== 图层列表 ==================== */
  /* ==================== v6.3.0 元件浮窗（缩略图 / 眼睛隐藏 / 长按拖动排序） ====================
     交互约定：
       · 元件栏最左侧 ▾ 展开一条浮在画布上的横向缩略图栏；
       · 每格右侧 👁 = 隐藏/显示，永远全帧生效（和透明度 alpha 是两回事：隐藏＝完全不画、不导出、点不到）；
       · 每格右侧 ≡ 长按 0.5 秒后左右拖动 = 调整上下层级，写入走 setGlobalProp，遵守「全局属性修改」开关；
       · 火柴人整体按躯干 layer.body 参与排序；置顶/置底用「当前最高/最低层 ±1」，不再用 999 极限值。 */
  const layerPopEl = document.getElementById('layerPop');
  const layerPopListEl = document.getElementById('layerPopList');
  const layerPopCountEl = document.getElementById('layerPopCount');
  const btnLayerPop = document.getElementById('btnLayerPop');
  let layerPopOpen = false;
  let layerThumbCache = new Map();
  let layerThumbCacheV = -1;
  let layerDragState = null;

  /* 排序用的层级：火柴人按躯干算 */
  function layerSortVal(o) {
    if (!o) return 0;
    if (o.type === 'figure') {
      if (o.layer && typeof o.layer === 'object') return o.layer.body || 0;
      return o.layer || 0;
    }
    return (typeof o.layer === 'number') ? o.layer : 0;
  }

  /* 当前帧、可参与排序的元件（参考视频不参与，和图层列表保持一致） */
  function getLayerUIObjects() {
    return AppState.objects
      .filter(o => o && o.type !== 'video')
      .sort((a, b) => layerSortVal(b) - layerSortVal(a));
  }

  /* 元件类型 → 图标 id（原来是 emoji，现在是 SVG，统一交给 ic() 渲染） */
  function layerItemIconId(o) {
    if (o.type === 'figure') return 'stickman';
    if (o.type === 'image') return 'add-picture';
    if (o.type === 'acc') return 'crown';
    if (o.type === 'shape') return 'square';
    if (o.type === 'bubble') return 'comment-one';
    if (o.type === 'ink') return 'pencil';
    if (o.type === 'camera') return 'videocamera';
    return 'help';
  }

  function layerThumbURL(o) {
    if (layerThumbCacheV !== thumbVersion) { layerThumbCache.clear(); layerThumbCacheV = thumbVersion; }
    /* key 要带帧号：切帧后元件位置/姿态都变了，只按 id 缓存会显示上一帧的旧图 */
    const key = AppState.currentFrameIndex + '|' + String(o.id);
    if (layerThumbCache.has(key)) return layerThumbCache.get(key);
    let url = null;
    try {
      const off = renderFrameToDataURL(AppState.currentFrameIndex, 96, 96, {
        transparent: true, ignoreCamera: true, onlyId: o.id, includeHidden: true, noRotate: true
      });
      url = off.toDataURL('image/png');
    } catch (_) { url = null; }
    layerThumbCache.set(key, url);
    return url;
  }

  /* 拖动排序：把整张列表重新编号，顶部最大 */
  function applyLayerOrder(ordered) {
    const n = ordered.length;
    ordered.forEach((o, i) => {
      const target = n - i;
      const cur = layerSortVal(o);
      if (o.type === 'figure' && o.layer && typeof o.layer === 'object') {
        const delta = target - cur;
        if (!delta) return;
        Object.keys(o.layer).forEach(k => {
          o.layer[k] = (o.layer[k] || 0) + delta;
          setGlobalProp(o, 'layer.' + k, o.layer[k]);
        });
      } else {
        if (cur === target) return;
        o.layer = target;
        setGlobalProp(o, 'layer', target);
      }
    });
    EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', '调整图层顺序');
    updateLayerList();
  }

  /* 眼睛：隐藏/显示，永远全帧生效（不看全局属性开关） */
  function setObjectHiddenGlobal(o, hidden) {
    if (!o) return;
    const id = String(o.id);
    const apply = (data) => {
      if (data && String(data.id) === id) data.hidden = !!hidden;
    };
    apply(o);
    for (const tid in AppState.tracks) {
      const t = AppState.tracks[tid];
      if (!t || !t.frames) continue;
      for (const data of t.frames) apply(data);
    }
    if (AppState.selected) apply(AppState.selected);
    EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', hidden ? '隐藏元件' : '显示元件');
    if (layerPopOpen) renderLayerPop();
    updateLayerList();
  }

  function positionLayerPop() {
    if (!layerPopEl || !btnLayerPop) return;
    if (layerPopEl.classList.contains('lp-inline')) return;   /* v7.0.6：内联模式不算坐标 */
    const r = btnLayerPop.getBoundingClientRect();
    const w = layerPopEl.offsetWidth || 300;
    const h = layerPopEl.offsetHeight || 140;
    let left = r.left;
    let top = r.bottom + 6;
    /* 宽视口：控制面板右侧还放得下就浮到画布上，别压住下面的属性面板 */
    const uiEl = document.getElementById('ui');
    if (uiEl) {
      const ur = uiEl.getBoundingClientRect();
      if (window.innerWidth - ur.right > w + 26 && ur.width > 0) {
        left = ur.right + 10;
        top = Math.max(8, r.top);
      }
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    /* 空间不够就往上翻 */
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, r.top - 6 - h);
    }
    layerPopEl.style.left = Math.round(left) + 'px';
    layerPopEl.style.top = Math.round(top) + 'px';
  }

  function setLayerPopOpen(open) {
    /* v7.0.6：列表已经内联进「元件」分区，永远展开，别再被别处调用的 close 关掉 */
    const inline = !!(layerPopEl && layerPopEl.classList.contains('lp-inline'));
    layerPopOpen = inline ? true : !!open;
    if (!layerPopEl) return;
    layerPopEl.classList.toggle('open', layerPopOpen);
    if (btnLayerPop) btnLayerPop.classList.toggle('on', layerPopOpen);
    if (layerPopOpen) { renderLayerPop(); positionLayerPop(); }
  }

  /* 防抖：拖拽元件时 need:syncUI 触发很频繁，别每帧都重建整条浮窗（缩略图重算很贵） */
  let layerPopTimer = 0;
  let layerPopAnimUntil = 0;   /* 落地动效期间不要重建，否则会把过渡打断 */
  function scheduleRenderLayerPop() {
    if (!layerPopOpen) return;
    if (layerPopTimer) return;
    const wait = Math.max(120, layerPopAnimUntil - Date.now());
    layerPopTimer = setTimeout(() => { layerPopTimer = 0; renderLayerPop(); }, wait);
  }

  function renderLayerPop() {
    if (!layerPopOpen || !layerPopListEl) return;
    if (layerDragState) return;   /* 拖动中重建会把 DOM 换掉，手势就断了 */
    const list = getLayerUIObjects();
    if (layerPopCountEl) layerPopCountEl.textContent = list.length + tr2('layerPop.countSuffix', ' 个');
    layerPopListEl.innerHTML = '';
    list.forEach((o) => {
      const item = document.createElement('div');
      item.className = 'lp-item'
        + (o === AppState.selected ? ' active' : '')
        + (o.hidden ? ' hidden-obj' : '');
      item.dataset.id = String(o.id);

      const wrap = document.createElement('div');
      wrap.className = 'lp-thumb-wrap';
      const url = layerThumbURL(o);
      if (url) {
        const im = document.createElement('img');
        im.className = 'lp-thumb';
        im.src = url;
        im.draggable = false;
        wrap.appendChild(im);
      } else {
        const em = document.createElement('span');
        em.className = 'lp-emoji';
        em.innerHTML = ic(layerItemIconId(o));
        wrap.appendChild(em);
      }
      item.appendChild(wrap);

      const rail = document.createElement('div');
      rail.className = 'lp-rail';

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'lp-eye' + (o.hidden ? ' on' : '');
      eye.innerHTML = o.hidden ? ic('forbid') : ic('preview-open');
      eye.title = o.hidden ? tr2('layerPop.showTip', tr2('layerPop.showTip', '点击显示（全帧生效）')) : tr2('layerPop.hideTip', tr2('layerPop.hideTip', '点击隐藏（全帧生效）'));
      eye.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        setObjectHiddenGlobal(o, !o.hidden);
      });
      rail.appendChild(eye);

      /* v7.0.6：每行一个锁定按钮（替换掉横向条旁边那个"只作用于选中项"的全局按钮）。
         锁住的元件在画布上拖不动、选不中，图标实心；没锁的用淡一点的开锁图标。 */
      const lock = document.createElement('button');
      lock.type = 'button';
      lock.className = 'lp-lock' + (o.locked ? ' on' : '');
      lock.innerHTML = o.locked ? ic('lock') : ic('unlock');
      lock.title = o.locked ? tr2('layerPop.unlockTip', tr2('layerPop.unlockTip', '点击解锁')) : tr2('layerPop.lockTip', tr2('layerPop.lockTip', '点击锁定（锁定后画布上无法拖动/选中）'));
      lock.setAttribute('aria-pressed', o.locked ? 'true' : 'false');
      lock.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        o.locked = !o.locked;
        EventBus.emit('need:syncUI');
        EventBus.emit('need:render');
        EventBus.emit('history:save', o.locked ? '锁定对象' : '解锁对象');
        renderLayerPop();
      });
      rail.appendChild(lock);

      /* v7.1.0：每行一个删除按钮 —— 顶部那排的「删除」已经拿掉，删除统一在这里做。
         点哪行删哪行，不用先选中；删火柴人时挂在他身上的配饰/画笔会一起删（deleteSelected 的逻辑）。 */
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'lp-del';
      del.innerHTML = ic('delete');
      del.title = tr2('layerPop.delTip', tr2('layerPop.delTip', '删除这个元件'));
      del.setAttribute('aria-label', tr2('layerPop.delTip', tr2('layerPop.delTip', '删除这个元件')));
      del.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (AppState.selected !== o) select(o);   /* deleteSelected 作用于当前选中项 */
        deleteSelected();
      });
      rail.appendChild(del);

      const handle = document.createElement('div');
      handle.className = 'lp-drag';
      handle.textContent = '≡';
      handle.title = tr2('layerPop.dragTip', tr2('layerPop.dragTip', '长按 0.5 秒后左右拖动，调整图层上下顺序'));
      attachLayerDragHandle(handle, o, item);
      rail.appendChild(handle);

      item.appendChild(rail);

      const name = document.createElement('span');
      name.className = 'lp-name';
      if (o.name) name.textContent = o.name;
      else name.innerHTML = ic(layerItemIconId(o));
      item.appendChild(name);

      item.title = (o.name || '') + (o.hidden ? tr2('layerPop.hiddenTag', '（已隐藏）') : '') + (o.locked ? tr2('layerPop.lockedTag', '（已锁定）') : '');
      item.addEventListener('click', (e) => {
        if (e.target.closest('.lp-eye') || e.target.closest('.lp-drag') || e.target.closest('.lp-lock') || e.target.closest('.lp-del')) return;
        select(o);
        EventBus.emit('need:render');
        renderLayerPop();
      });

      layerPopListEl.appendChild(item);
    });
  }

  /* 长按 0.5 秒进入拖动；v6.3.1 起不画竖线指示器，改为「被拖行跟手 + 其余行实时让位」 */
  function attachLayerDragHandle(handle, o, item) {
    let timer = 0;
    let armed = false;
    const cancelTimer = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      armed = false;
      cancelTimer();
      const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
      timer = setTimeout(() => {
        timer = 0;
        armed = true;
        beginLayerDrag(item, o, pid, sy);
      }, 500);
      /* 长按未满就明显移动 → 视为滑动列表，取消长按 */
      const onPreMove = (ev) => {
        if (ev.pointerId !== pid) return;
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
          cancelTimer();
          window.removeEventListener('pointermove', onPreMove, true);
        }
      };
      const onPreUp = () => {
        cancelTimer();
        window.removeEventListener('pointermove', onPreMove, true);
        window.removeEventListener('pointerup', onPreUp, true);
      };
      window.addEventListener('pointermove', onPreMove, true);
      window.addEventListener('pointerup', onPreUp, true);
    });
  }

  function beginLayerDrag(item, o, pointerId, startY) {
    const items = Array.from(layerPopListEl.children);
    const rects = items.map(el => el.getBoundingClientRect());
    const from = items.indexOf(item);
    layerDragState = {
      id: String(o.id), item, items, rects,
      from, to: from, pointerId,
      startY: startY, dy: 0,
      moved: false
    };
    item.classList.add('dragging');
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
    window.addEventListener('pointermove', onLayerDragMove, true);
    window.addEventListener('pointerup', onLayerDragEnd, true);
    window.addEventListener('pointercancel', onLayerDragEnd, true);
  }

  /* 其余行平移到「前一/后一行的原始槽位」，让出被拖行最终要落的位置 */
  function applyLayerShift() {
    const st = layerDragState;
    if (!st) return;
    const { items, rects, from, to } = st;
    for (let i = 0; i < items.length; i++) {
      if (i === from) continue;
      const el = items[i];
      let shift = 0;
      if (to > from) {
        /* 往下拖：from 之后的行依次上移一格填坑 */
        if (i > from && i < to) shift = rects[i - 1].top - rects[i].top;
      } else if (to < from) {
        /* 往上拖：to 到 from-1 的行依次下移一格腾位 */
        if (i >= to && i < from) shift = rects[i + 1].top - rects[i].top;
      }
      el.style.transform = shift ? 'translateY(' + Math.round(shift) + 'px)' : '';
    }
  }

  function onLayerDragMove(e) {
    const st = layerDragState;
    if (!st) return;
    e.preventDefault();

    /* 靠近上下边缘时自动滚动，并把滚动量补给 rects / startY，避免跟手错位 */
    const lr = layerPopListEl.getBoundingClientRect();
    let ds = 0;
    if (e.clientY < lr.top + 26) ds = -8;
    else if (e.clientY > lr.bottom - 26) ds = 8;
    if (ds) {
      const before = layerPopListEl.scrollTop;
      layerPopListEl.scrollTop += ds;
      const actual = layerPopListEl.scrollTop - before;
      if (actual) {
        st.rects.forEach(r => { r.top -= actual; r.bottom -= actual; });
        st.startY -= actual;
      }
    }

    /* 被拖行跟手 */
    const dy = e.clientY - st.startY;
    if (Math.abs(dy) > 3) st.moved = true;
    st.dy = dy;
    st.item.style.transform = 'translateY(' + Math.round(dy) + 'px)';

    /* 插入位置：指针落在哪一行的上半部分就插到它前面 */
    const y = e.clientY;
    let to = st.items.length;
    for (let i = 0; i < st.items.length; i++) {
      const r = st.rects[i];
      if (y < r.top + r.height / 2) { to = i; break; }
    }
    if (to !== st.to) { st.to = to; }
    applyLayerShift();
  }

  function onLayerDragEnd() {
    const st = layerDragState;
    if (!st) return;
    layerDragState = null;
    window.removeEventListener('pointermove', onLayerDragMove, true);
    window.removeEventListener('pointerup', onLayerDragEnd, true);
    window.removeEventListener('pointercancel', onLayerDragEnd, true);

    const { item, items, from, to } = st;
    item.classList.remove('dragging');

    if (!st.moved || to === from || to === from + 1) {
      /* 没真正挪位置：让所有行滑回原处 */
      item.style.transform = '';
      items.forEach(el => { el.style.transform = ''; });
      return;
    }

    /* 真正的 DOM 重排：其余行已经让到目标槽位，重排后清掉 transform 不会跳 */
    const rest = items.filter(el => el !== item);
    const targetIdx = (to > from) ? to - 1 : to;
    const ref = rest[targetIdx] || null;
    const visTop = item.getBoundingClientRect().top;   /* 指针处的视觉位置 */
    layerPopListEl.insertBefore(item, ref);
    items.forEach(el => { el.style.transform = ''; });

    /* 被拖行从指针位置平滑落到最终槽位 */
    const newTop = item.getBoundingClientRect().top;
    const delta = visTop - newTop;
    layerPopAnimUntil = Date.now() + 300;
    if (Math.abs(delta) > 1) {
      item.style.transition = 'none';
      item.style.transform = 'translateY(' + Math.round(delta) + 'px)';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          item.style.transition = '';
          item.style.transform = '';
        });
      });
    }

    /* 按 DOM 顺序落地成新的层级 */
    const ordered = Array.from(layerPopListEl.children)
      .map(el => AppState.objects.find(o => String(o.id) === el.dataset.id))
      .filter(Boolean);
    applyLayerOrder(ordered);
    /* v6.3.0：排序遵守「全局属性」开关——关着时只改当前帧，给个提示免得以为全帧都变了 */
    if (!globalEditEnabled) showHistoryToast(tr2('layerPop.onlyThisFrame', '图层顺序仅应用于当前帧（全局属性开关已关闭）'), 'undo', 2400);
  }

  if (btnLayerPop) {
    btnLayerPop.addEventListener('click', (e) => {
      e.stopPropagation();
      setLayerPopOpen(!layerPopOpen);
    });
  }
  const btnLayerPopClose = document.getElementById('btnLayerPopClose');
  if (btnLayerPopClose) {
    btnLayerPopClose.addEventListener('click', (e) => { e.stopPropagation(); setLayerPopOpen(false); });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!layerPopOpen) return;
    if (layerPopEl && layerPopEl.classList.contains('lp-inline')) return;  /* v7.0.6：常驻，不用点外关闭 */
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#layerPop') || t.closest('#btnLayerPop')) return;
    setLayerPopOpen(false);
  }, true);
  window.addEventListener('resize', () => { if (layerPopOpen) positionLayerPop(); });
  if (uiPanel) uiPanel.addEventListener('scroll', () => { if (layerPopOpen) positionLayerPop(); }, { passive: true });
  EventBus.on('need:syncUI', () => { scheduleRenderLayerPop(); });

  /* name-v5.1.1: 图层按钮上的元件名称（安全文本节点，兼容图片/配饰等所有类型） */
  function attachLayerName(btn, o) {
    const raw = (o && typeof o.name === 'string') ? o.name.trim() : '';
    if (!raw) return;
    const label = document.createElement('span');
    label.className = 'layer-name';
    label.textContent = raw;
    btn.title = raw;
    const last = btn.lastElementChild;
    if (last) btn.insertBefore(label, last);
    else btn.appendChild(label);
  }

  function updateLayerList() {
    /* v7.1.0：横向缩略图条恢复了（住在「基础属性」正上方，吸顶）。
       v7.0.6 期间它被删掉、这个函数只转发重绘信号；现在有 #layerList 就正常画，
       没有（老 HTML）就退回只刷新纵向列表。 */
    if (!layerListEl) { scheduleRenderLayerPop(); return; }
    layerListEl.innerHTML = '';
    let idx = 1;
    if (videoObj) {
      if (videoObj.locked === undefined) videoObj.locked = false;
      const btn = document.createElement('div');
      btn.className = 'layer-btn' + (videoObj === AppState.selected ? ' active' : '') + (videoObj.locked ? ' locked' : '');
      btn.innerHTML = `<span>🎥</span><span class="idx">${idx++}</span>`;
      attachLayerName(btn, videoObj);
      btn.onclick = () => { select(videoObj); EventBus.emit('need:render'); };
      layerListEl.appendChild(btn);
    }
    const sorted = [...AppState.objects].sort((a, b) => (b.layer.body || b.layer) - (a.layer.body || a.layer));
    sorted.forEach(o => {
      /* v6.1.0：参考视频在 AppState.objects 里也会出现一份（渲染合并视图需要它），
         但列表顶部已经单独渲染了 🎥 那一行。这里必须跳过，否则会多出一个
         图标兜底成 ❓、又因为视频不允许 delete 而删不掉的幽灵元件。 */
      if (o.type === 'video' || o === videoObj) return;
      if (o.locked === undefined) o.locked = false;
      const btn = document.createElement('div');
      btn.className = 'layer-btn' + (o === AppState.selected ? ' active' : '') + (o.locked ? ' locked' : '');
      let icon = 'help';
      if (o.type === 'figure') icon = 'stickman';
      else if (o.type === 'image') icon = 'add-picture';
      else if (o.type === 'acc') icon = 'crown';
      else if (o.type === 'shape') icon = 'square';
      else if (o.type === 'bubble') icon = 'comment-one';
      else if (o.type === 'ink') icon = 'pencil'; // brush-v5.1.0: §6.3.9
      else if (o.type === 'camera') icon = 'videocamera';
      else if (o.type === 'video') icon = 'video'; /* 兜底：万一别处把视频带进来，也不要显示问号 */
      btn.innerHTML = `<span>${ic(icon)}</span><span class="idx">${idx++}</span>`;
      attachLayerName(btn, o);
      if (o.hidden) { btn.classList.add('hidden-obj'); btn.title = (o.name || '') + tr2('layerPop.hiddenTag', '（已隐藏）'); }
      btn.onclick = () => { select(o); EventBus.emit('need:render'); };
      layerListEl.appendChild(btn);
    });

    if (AppState.selected && btnToggleLock) {
      btnToggleLock.style.display = 'block';
      if (AppState.selected.locked) {
        btnToggleLock.innerHTML = ic('unlock') + tr2('lock.unlock', '解锁');
        btnToggleLock.classList.add('danger');
      } else {
        btnToggleLock.innerHTML = ic('lock') + tr2('lock.lock', '锁定');
        btnToggleLock.classList.remove('danger');
      }
    } else if (btnToggleLock) {
      btnToggleLock.style.display = 'none';
    }
    scheduleRenderLayerPop();
  }

  /* v7.0.6：原来那个全局「锁定」按钮随横向条一起删了，锁定改到列表每行一个。
     这里保留旧引用兜底（HTML 里已经没有该节点时直接跳过）。 */
  if (btnToggleLock) {
    btnToggleLock.onclick = () => {
      if (AppState.selected) {
        AppState.selected.locked = !AppState.selected.locked;
        EventBus.emit('need:syncUI');
        EventBus.emit('need:render');
        EventBus.emit('history:save', '锁定/解锁对象');
      }
    };
  }

  /* ==================== 元件列表横向拖拽滚动（鼠标端） ==================== */
  (function initLayerListDragScroll() {
    if (!layerListEl) return;
    let isDown = false;
    let startX = 0;
    let startScrollLeft = 0;
    let dragged = false;

    layerListEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      isDown = true;
      dragged = false;
      startX = e.clientX;
      startScrollLeft = layerListEl.scrollLeft;
    });

    layerListEl.addEventListener('pointermove', (e) => {
      if (!isDown) return;
      const dx = e.clientX - startX;
      if (!dragged && Math.abs(dx) > 4) {
        dragged = true;
        layerListEl.classList.add('dragging');
        try { layerListEl.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (dragged) {
        e.preventDefault();
        layerListEl.scrollLeft = startScrollLeft - dx;
      }
    });

    const end = (e) => {
      if (!isDown) return;
      isDown = false;
      layerListEl.classList.remove('dragging');
      try { layerListEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);

    /* 拖动结束后吞掉这一次 click，避免误触发元件切换 */
    layerListEl.addEventListener('click', (e) => {
      if (dragged) {
        dragged = false;
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);
  })();

  /* ==================== 多轨道：轨道选择 / 数据隔离 ==================== */
  function isSubTrackMode() {
    return AppState.activeTrackId !== TRACK_ALL_ID;
  }

  /* ---------- 数据层访问器（所有轨道读写统一入口） ---------- */
  function cloneObjectKeepImg(src) {
    if (!src) return null;
    const c = JSON.parse(JSON.stringify(src, (k, v) => (k === 'img' ? undefined : v)));
    if (src.img) c.img = src.img;
    return c;
  }

  function cloneTracksMap(src) {
    const out = {};
    for (const id in src) {
      const t = src[id];
      if (!t) continue;
      out[id] = {
        name: t.name,
        frames: (t.frames || []).map(d => d ? cloneObjectKeepImg(d) : null)
      };
    }
    return out;
  }

  /* 主时间轴长度 = 所有轨道里「最后一个有内容的帧」的下标 + 1。
     v6.1.0：以前取的是 frames.length 的最大值，一旦某条轨道被补过尾部空占位
     （补间插帧、绑定元件对齐、套动作时自动补帧都会留下），空帧就会把主时间轴顶长，
     表现就是「在其他元件的时间轴补间后，后面多出一截空白帧」。 */
  function getMainLength() {
    let max = 1;
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      const arr = t.frames;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]) { if (i + 1 > max) max = i + 1; break; }
      }
    }
    return max;
  }

  /* ---------- 帧数据的两个访问层级（v7.0.0） ----------
     getTrackSlot  = 原始存储：可能返回派生帧哨兵，只给需要判槽位身份的地方用
     getTrackFrame = 渲染/导出/缩略图统一入口：派生帧在这里按段求值

     求值结果要缓存，否则同一帧连续调用两次会拿到两个不同的克隆实例，
     AppState.selected 与 AppState.objects 里的元素就不是同一个对象，
     拖拽改的是 A、画的是 B。缓存按 (轨道, 帧号) 存，任何改动都整表清空。 */
  const kfEvalCache = new Map();
  let kfEvalEpoch = 0;
  /* 缓动提供者：补间缓动系统初始化后挂上来（避免 tweenEaseKey 的 TDZ） */
  let kfEaseProvider = null;

  function bumpKfEval() {
    kfEvalEpoch++;
    if (kfEvalCache.size) kfEvalCache.clear();
  }

  /* 全轨道归一化：段内的普通/空白帧接管成派生，段外的悬空派生退回空白。
     opts.adoptPlain=false 时只清悬空派生（用于旧工程原样加载）。 */
  function reconcileAllTracks(opts) {
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (t) KF.reconcileTrack(t, opts);
    }
    bumpKfEval();
  }

  function getTrackSlot(trackId, idx) {
    const t = AppState.tracks[trackId];
    if (!t || !t.frames) return null;
    if (idx < 0 || idx >= t.frames.length) return null;
    return t.frames[idx];
  }

  function getTrackFrame(trackId, idx) {
    const slot = getTrackSlot(trackId, idx);
    if (!KF.isDerived(slot)) return slot || null;
    return evaluateDerived(trackId, idx);
  }

  /* 派生帧求值：找段 → 取两端关键帧 → 按段曲线插值 → 缓存 */
  function evaluateDerived(trackId, idx) {
    const t = AppState.tracks[trackId];
    if (!t || !t.frames) return null;
    const loc = KF.locate(t.frames, idx);
    if (loc.kind !== 'derived') return null;
    const key = trackId + '|' + idx + '|' + kfEvalEpoch;
    const hit = kfEvalCache.get(key);
    if (hit) return hit;
    const o1 = t.frames[loc.a], o2 = t.frames[loc.b];
    if (!KF.isReal(o1) || !KF.isReal(o2)) return null;
    const curve = KF.curveOf(o1);
    /* v7.0.1：段上没有曲线就是匀速。绝不再回退到「全局当前缓动」——
       那条会漏，改一段会连带影响所有没设过曲线的段。曲线只属于它自己那一段。 */
    const easeKey = (curve && curve.ease) || 'linear';
    const chMap = (curve && curve.ch) || null;
    const obj = KF.interpolateObject(o1, o2, loc.u, {
      ease: (u) => {
        const fn = kfEaseProvider ? kfEaseProvider.fn(easeKey) : null;
        return fn ? fn(u) : u;
      },
      /* 通道级缓动：段曲线优先，其次沿用旧的「分部缓动」全局配置 */
      partEase: (part, tt, u) => {
        const ek = chMap ? chMap[part] : null;
        const fallback = kfEaseProvider ? kfEaseProvider.channel(o1.id, part) : null;
        const use = ek || fallback;
        const fn = use && kfEaseProvider ? kfEaseProvider.fn(use) : null;
        return fn ? fn(u) : tt;
      },
      enforcePins: (o) => { try { enforcePins(o); } catch (_) {} }
    });
    if (obj) kfEvalCache.set(key, obj);
    return obj;
  }

  function setTrackFrame(trackId, idx, data) {
    const t = AppState.tracks[trackId];
    if (!t) return;
    if (!t.frames) t.frames = [];
    while (t.frames.length <= idx) t.frames.push(null);
    t.frames[idx] = data || null;
    bumpKfEval();
    syncMainLengthFromTracks();
  }

  function getTrackLength(trackId) {
    const t = AppState.tracks[trackId];
    return (t && t.frames) ? t.frames.length : 0;
  }

  function syncMainLengthFromTracks() {
    const target = Math.max(1, getMainLength());
    while (AppState.frames.length < target) {
      const last = AppState.frames[AppState.frames.length - 1];
      AppState.frames.push({
        id: ((last && last.id) || AppState.frames.length) + 1,
        duration: (last && last.duration) || Math.round(1000 / defaultFPS),
        isTween: false
      });
    }
  }

  function ensureTrack(id, name) {
    const key = String(id);
    if (!AppState.tracks[key]) AppState.tracks[key] = { name: name || key, frames: [] };
    else if (name) AppState.tracks[key].name = name;
    if (!AppState.tracks[key].frames) AppState.tracks[key].frames = [];
    return AppState.tracks[key];
  }

  function getFrameTrackObject(fr, idx) {
    if (!isSubTrackMode()) return null;
    let i = idx;
    if (i === undefined || i === null) {
      if (typeof fr === 'number') i = fr;
      else i = AppState.frames.indexOf(fr);
    }
    if (!(i >= 0)) return null;
    return getTrackFrame(AppState.activeTrackId, i);
  }

  function getActiveTrackObject() {
    return getTrackFrame(AppState.activeTrackId, AppState.currentFrameIndex);
  }

  function collectTrackEntries() {
    return Object.keys(AppState.tracks).map(id => ({ id, name: AppState.tracks[id].name || id }));
  }

  function updateOtherTracksVisibilityUI() {
    const sel = document.getElementById('otherTracksVisibility');
    const hint = document.getElementById('otherTracksVisibilityHint');
    if (!sel) return;
    const enabled = isSubTrackMode();
    sel.disabled = !enabled;
    sel.value = otherTracksVisibility;
    sel.title = enabled ? tr2('track.otherTitle', '设置非当前元件轨道的画布显示方式') : tr2('track.disabledTitle', '仅在元件子轨道模式下可用');
    if (hint) hint.textContent = enabled ? tr2('track.hintOn', '非当前元件轨道') : tr2('track.hintOff', '选择元件子轨道后可调整');
  }

  function refreshSubTrackOptions() {
    const sel = document.getElementById('trackSelector');
    if (!sel) return;
    const entries = collectTrackEntries();
    const sig = entries.map(e => e.id + '\u0001' + e.name).join('\u0002');
    const exists = entries.some(e => e.id === AppState.activeTrackId);
    if (AppState.activeTrackId !== TRACK_ALL_ID && !exists) {
      AppState.activeTrackId = TRACK_ALL_ID;
      if (AppState.selected && !AppState.objects.includes(AppState.selected)) AppState.selected = null;
    }
    if (sig !== subTrackOptionSignature) {
      subTrackOptionSignature = sig;
      sel.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = TRACK_ALL_ID;
      allOpt.textContent = tr2('track.all', '[全局主时间轴]');
      allOpt.setAttribute('data-i18n', 'track.all'); /* v7.2.2：挂上 data-i18n，切语言时选项文字跟着换 */
      sel.appendChild(allOpt);
      entries.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.name;
        sel.appendChild(opt);
      });
    }
    sel.value = exists ? AppState.activeTrackId : TRACK_ALL_ID;
    sel.classList.toggle('sub-track-active', isSubTrackMode());
    updateOtherTracksVisibilityUI();
  }

  function syncSubTrackSelection() {
    if (!isSubTrackMode() || isPlaying) return;
    const obj = getActiveTrackObject();
    if (AppState.selected !== obj) AppState.selected = obj;
  }

  function getTrackRenderAlpha(o) {
    if (!isSubTrackMode() || !o || o.type === 'video') return 1;
    if (String(o.id) === AppState.activeTrackId) return 1;
    // 【新增】：如果它是绑定在当前元件上的配件/形状/气泡，也视为自身的一部分
    if ((o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') && String(o.targetId) === AppState.activeTrackId) {
      return 1;
    }
    if (otherTracksVisibility === 'hide') return 0;
    if (otherTracksVisibility === 'half') return 0.5;
    return 1;
  }

  function setActiveTrack(id) {
    AppState.activeTrackId = (id == null) ? TRACK_ALL_ID : String(id);
    /* 切换轨道时重置摄像机视角的缩放/偏移 */
    camViewZoom = 1;
    camViewOffset = { x: 0, y: 0 };
    refreshSubTrackOptions();
    AppState.canvasSelected = false;
    drag = null;
    isPanning = false;
    cancelTransformBoxDrag();
    anchorModeOn = false;
    AppState.selected = isSubTrackMode() ? getActiveTrackObject() : AppState.selected;
    /* 进入摄像机轨道 → 自动适配可用区域，避免被 UI 面板 / 时间轴遮挡 */
    if (isCameraTrackId(AppState.activeTrackId)) {
      SKFE.systems.camera.fitCameraViewToAvailableArea();
    }
    EventBus.emit('app:update');
  }

  document.getElementById('trackSelector').addEventListener('change', e => {
    setActiveTrack(e.target.value);
  });
  document.getElementById('otherTracksVisibility').addEventListener('change', e => {
    otherTracksVisibility = e.target.value;
    updateOtherTracksVisibilityUI();
    EventBus.emit('need:render');
  });

  /* ==================== 轨道同步 ==================== */
  function updateTrackOptions() {
    const sel = document.getElementById('editTargetSelect');
    if (sel) {
      sel.innerHTML = tr2('track.allOption', '<option value="all">全部对象 (主时间线)</option>');
      sel.disabled = true;
    }
  }

  function updateTargetFigureOptions() {
    const figures = AppState.objects.filter(o => o.type === 'figure');
    targetFigureSelect.innerHTML = tr2('track.placeholder', '<option value="">-- 请选择 --</option>');
    figures.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id; opt.textContent = f.name;
      targetFigureSelect.appendChild(opt);
    });
    if (AppState.selected && AppState.selected.targetId) targetFigureSelect.value = AppState.selected.targetId;
    else targetFigureSelect.value = '';
  }

  /* ==================== 尺寸/帧管理 ==================== */
  function resize() {
    const timelineEl = document.getElementById('timeline');
    if (timelineEl && getComputedStyle(timelineEl).display !== 'none') {
      const actualTimelineH = timelineEl.offsetHeight;
      if (actualTimelineH > 0) TIMELINE_H = actualTimelineH;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateStickyHeaderHeight();
    refreshTimelineDockOffsets();
    if (uiResizable && uiCustomSize) applyCustomSize(); // 防冲突新增
    updateResizeHandlePos();
    EventBus.emit('need:render');
  }

  function deepCloneObjects(list) {
    return list.map(o => {
      const img = o.img;
      const c = JSON.parse(JSON.stringify(o, (k, v) => (k === 'img' ? undefined : v)));
      if (img) c.img = img;
      return c;
    });
  }

  function syncFrameRef() {
    const idx = AppState.currentFrameIndex;
    if (isSubTrackMode()) {
      const t = AppState.tracks[AppState.activeTrackId];
      if (!t) return;
      if (!t.frames) t.frames = [];
      /* v7.0.0：派生帧不写回。它本来就不存画面，随手写回等于把段静默烘焙掉，
         用户会发现自己什么都没做、段却断了。要落地必须先由 markCurrentFrameModified
         把它升格成关键帧（那一刻槽位已经不是派生帧了）。 */
      if (KF.isDerived(t.frames[idx])) return;
      const mine = AppState.objects.find(o => o && o.type !== 'video' && String(o.id) === String(AppState.activeTrackId)) || null;
      while (t.frames.length <= idx) t.frames.push(null);
      const prev = t.frames[idx];
      if (prev === mine) return;
      t.frames[idx] = mine;
      bumpKfEval();
      syncMainLengthFromTracks();
      return;
    }
    /* 全局模式：把当前帧合并视图按 id 分发回各 track */
    const present = new Set();
    let changed = false;
    for (const o of AppState.objects) {
      if (!o || o.type === 'video') continue;
      const id = String(o.id);
      present.add(id);
      const t = ensureTrack(id, o.name);
      while (t.frames.length <= idx) t.frames.push(null);
      if (KF.isDerived(t.frames[idx])) continue;   /* 派生帧不写回 */
      if (t.frames[idx] === o) continue;
      t.frames[idx] = o;
      changed = true;
    }
    for (const id in AppState.tracks) {
      if (present.has(id)) continue;
      const arr = AppState.tracks[id].frames;
      if (!arr || idx >= arr.length) continue;
      if (KF.isDerived(arr[idx])) continue;        /* 派生槽位不能被抹成空白 */
      if (arr[idx] !== null) { arr[idx] = null; changed = true; }
    }
    if (changed) bumpKfEval();
    syncMainLengthFromTracks();
  }

  function goToFrame(i) {
    if (i < 0 || i >= AppState.frames.length) return;
    if (isPlaying) pause();
    syncFrameRef();
    /* v7.4.5：换帧不再清掉选中。用户点时间轴只是「看这一帧」，
       选中一没，自动关键帧就把当前元件当成「非选中件」而落不下来
       （allowPlain=false 直接 return），表现为「改了半天没菱形、也不补间」。
       每帧的对象是不同实例，所以按 id 去新列表里找回同 id 的那个。 */
    const keepSelId = AppState.selected ? String(AppState.selected.id) : null;
    AppState.currentFrameIndex = i;
    AppState.objects = getCombinedObjectsForRender();
    if (isSubTrackMode()) {
      AppState.selected = getActiveTrackObject();
    } else {
      AppState.selected = (keepSelId && AppState.objects.find(o => o && String(o.id) === keepSelId)) || null;
    }
    drag = null; isPanning = false; AppState.canvasSelected = false;
    cancelTransformBoxDrag(); anchorModeOn = false;
    seekVideoToFrame(AppState.currentFrameIndex);
    updateTweenEaseLabel();   /* v7.4.5：跨进/跨出段时，标签栏的曲线跟着换 */
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
  }

  let pressTimer = null;
  let dragStartX = 0, dragStartY = 0;

  function invalidateFrameThumb(idx, trackId) {
    if (AppState.frames[idx]) delete AppState.frames[idx]._thumb;
    if (trackId != null) trackThumbCache.delete(String(trackId) + '|' + idx);
  }

  function invalidateAllFrameThumbs() {
    AppState.frames.forEach(fr => delete fr._thumb);
    trackThumbCache.clear();
    bumpKfEval();
  }

  /* v7.0.0：时间轴下方的段曲线可视化。
     每个段画一条曲线：当前段用主题色加粗，其余段淡显；末端画出播放头位置。
     没有段时整块隐藏，不影响老工程布局。 */
  let kfCurveScrollBound = false;
  function renderKfCurveStrip() {
    const wrap = document.getElementById('kfCurveWrap');
    const cvs = document.getElementById('kfCurveStrip');
    const bar = document.getElementById('frameBar');
    if (!wrap || !cvs || !bar) return;

    if (!kfCurveScrollBound) {
      kfCurveScrollBound = true;
      bar.addEventListener('scroll', () => {
        const c = document.getElementById('kfCurveStrip');
        if (c) c.style.transform = 'translateX(' + (-bar.scrollLeft) + 'px)';
      }, { passive: true });
    }

    const ids = currentScopeTrackIds();
    const segs = [];
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      for (const s of KF.segments(t.frames)) segs.push({ id: id, s: s, frames: t.frames });
    }
    if (!segs.length) {
      wrap.classList.remove('visible');
      return;
    }
    wrap.classList.add('visible');

    const chips = bar.querySelectorAll('.frame-chip');
    const barRect = bar.getBoundingClientRect();
    const w = Math.max(1, bar.scrollWidth);
    const h = 26;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
    cvs.style.width = w + 'px';
    cvs.style.height = h + 'px';
    cvs.style.transform = 'translateX(' + (-bar.scrollLeft) + 'px)';
    const g = cvs.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const accent = (css.getPropertyValue('--color-primary') || '#4a90e2').trim();
    const dim = (css.getPropertyValue('--text-sub') || '#888888').trim();
    const cx = (i) => {
      const c = chips[i];
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return r.left - barRect.left + bar.scrollLeft + r.width / 2;
    };
    const top = 3, bottom = h - 3;

    /* 当前段：与 updateFrameBar 里的整段高亮同一口径 */
    const curSeg = currentSegmentAheadAny();

    for (const item of segs) {
      const x1 = cx(item.s.a), x2 = cx(item.s.b);
      if (x1 === null || x2 === null || x2 <= x1) continue;
      const curve = KF.curveOf(item.frames[item.s.a]) || {};
      /* v7.0.2：没设曲线的段就是匀速，别拿全局残留值来画，否则看起来像被改过 */
      const ek = curve.ease || 'linear';
      const fn = getEaseFunction(ek || 'linear') || ((u) => u);
      const isCur = curSeg && curSeg.a === item.s.a && curSeg.b === item.s.b;
      g.beginPath();
      for (let n = 0; n <= 48; n++) {
        const u = n / 48;
        const p = Math.max(0, Math.min(1, fn(u)));
        const x = x1 + (x2 - x1) * u;
        const y = bottom - (bottom - top) * p;
        if (n === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = isCur ? accent : dim;
      g.globalAlpha = isCur ? 1 : 0.35;
      g.lineWidth = isCur ? 2 : 1;
      g.stroke();
      g.globalAlpha = isCur ? 1 : 0.45;
      g.fillStyle = isCur ? accent : dim;
      g.beginPath(); g.arc(x1, bottom, 2, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(x2, top, 2, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;

    /* 播放头：画在当前段上，直观看清「这一帧的进度落在曲线哪一点」 */
    const idx = AppState.currentFrameIndex;
    const cur = currentSegmentAheadAny();
    if (cur) {
      const xa = cx(cur.a), xb = cx(cur.b);
      if (xa !== null && xb !== null && xb > xa) {
        const u = (idx - cur.a) / (cur.b - cur.a);
        const curve = KF.curveOf(AppState.tracks[cur.id].frames[cur.a]) || {};
        const fn = getEaseFunction(curve.ease || (kfEaseProvider ? kfEaseProvider.key() : 'linear')) || ((v) => v);
        const p = Math.max(0, Math.min(1, fn(u)));
        const px = xa + (xb - xa) * u;
        const py = bottom - (bottom - top) * p;
        g.strokeStyle = accent;
        g.globalAlpha = 0.55;
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = accent;
        g.beginPath(); g.arc(px, py, 3.2, 0, Math.PI * 2); g.fill();
      }
    }
  }

  /* 当前作用域下「播放头所在（或即将进入）的段」，跨轨道取第一个命中 */
  function currentSegmentAheadAny() {
    const ids = currentScopeTrackIds();
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      const s = segmentAhead(t.frames, AppState.currentFrameIndex);
      if (s) return { id: id, a: s.a, b: s.b };
    }
    return null;
  }

  /* v7.0.0：帧块上的槽位身份标记。
     子轨看自己那条轨道；主轨看全部轨道（全有 = 关键帧，部分有 = 半填充）。 */
  function kfChipKind(idx) {
    const ids = isSubTrackMode() ? [String(AppState.activeTrackId)] : Object.keys(AppState.tracks);
    let hasKey = 0, hasContent = 0, hasDerived = 0;
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t || !t.frames || idx >= t.frames.length) continue;
      const slot = t.frames[idx];
      const k = KF.kindOf(slot);
      if (k !== 'blank') hasContent++;
      if (k === 'key') hasKey++;
      else if (k === 'derived') hasDerived++;
    }
    if (!hasContent) return 'blank';
    if (hasKey && hasKey === hasContent) return 'key';
    if (hasKey) return 'partial';
    if (hasDerived) return 'derived';
    return 'plain';
  }

  /* D10：这一帧「部分关键帧」到底是哪几个元件有锚点（主轨显示用） */
  function kfPartialNames(idx) {
    const out = [];
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames || idx >= t.frames.length) continue;
      if (KF.isKey(t.frames[idx])) out.push(t.name || id);
    }
    return out;
  }

  /* D10：主轨上点「部分关键帧」的帧块 → 直接说清谁有锚点、谁没有 */
  function announcePartialKeys(idx) {
    if (isSubTrackMode()) return;
    if (kfChipKind(idx) !== 'partial') return;
    const has = [], missing = [];
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      const slot = (idx < t.frames.length) ? t.frames[idx] : undefined;
      const hasKey = slot !== undefined && KF.isKey(slot);
      if (!hasKey) {
        const live = AppState.objects.find(o => o && o.type !== 'video' && String(o.id) === String(id));
        if (!live) continue;          /* 这一帧本来就没这个元件，不算「缺」 */
        missing.push(t.name || id);
      } else has.push(t.name || id);
    }
    if (!has.length) return;
    const msg = tr2('kf.partialHead', '部分关键帧：') + has.join('、') + ' 有锚点' + (missing.length ? ('；' + missing.join('、') + ' 没有') : '');
    showHistoryToast(msg, undefined, 2600);
  }

  /* 关键帧按钮的三种状态：全部有锚点 / 部分 / 没有
     v7.4.7：子轨道模式只看这一条轨 —— 「关键帧」按钮点下去改的就是这一条轨
     （currentScopeTrackIds 同一套作用域），状态却按全部轨道算的话，
     在子轨里明明已经是关键帧，按钮还是「部分」，图标也跟着显示 ＋。 */
  function mainKeyStateAt(idx) {
    let has = 0, can = 0;
    const scope = isSubTrackMode() ? [String(AppState.activeTrackId)] : Object.keys(AppState.tracks);
    for (const id of scope) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      const slot = (idx < t.frames.length) ? t.frames[idx] : undefined;
      const hasKey = slot !== undefined && KF.isKey(slot);
      if (hasKey) { has++; can++; continue; }
      /* 有画面但没有锚点 → 这一帧「本可以有」 */
      const live = AppState.objects.find(o => o && o.type !== 'video' && String(o.id) === String(id));
      if (live) can++;
    }
    if (!has) return 'none';
    return has === can ? 'all' : 'partial';
  }

  function syncKeyframeButtonState() {
    const btn = document.getElementById('btnKeyframe');
    if (!btn) return;
    const st = mainKeyStateAt(AppState.currentFrameIndex);
    btn.classList.toggle('kf-on', st === 'all');
    btn.classList.toggle('kf-partial-on', st === 'partial');
    /* v7.4.7：菱形图标直接说明「点一下会怎样」——
       这一帧还没有关键帧（或只有一部分元件有）就画「＋」，已经是了就画「−」。
       改的是 data-icon 属性本身，SKFEApplyIcons 认得，会就地重画。 */
    const icEl = btn.querySelector('i[data-icon]');
    if (icEl) {
      const want = (st === 'all') ? 'diamond-sub' : 'diamond-add';
      if (icEl.getAttribute('data-icon') !== want) {
        icEl.setAttribute('data-icon', want);
        if (window.SKFEApplyIcons) window.SKFEApplyIcons(btn);
      }
    }
    /* v7.2.1：i18n 实际挂在 window.t / window.SKFE_I18N 上，SKFE.i18n 一直是 undefined */
    const base = (typeof window.t === 'function' ? window.t('timeline.keyframeTitle') : '') || '把当前帧设为 / 取消关键帧';
    if (st === 'all') btn.title = tr2('kf.titleFull', '这一帧已是关键帧，点一下取消（只取消主轨广播的锚点）');
    else if (st === 'partial') {
      const names = kfPartialNames(AppState.currentFrameIndex);
      btn.title = tr2('kf.partialHead', '部分关键帧：') + (names.join('、') || '—') + tr2('kf.partialTail', ' 已有锚点，点一下补齐其余元件');
    } else btn.title = base;
  }

  /* 当前帧所在的段范围（用于整段高亮） */
  function kfSegRangeNow() {
    const ids = isSubTrackMode() ? [String(AppState.activeTrackId)] : Object.keys(AppState.tracks);
    let lo = null, hi = null;
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      /* 停在关键帧上时高亮它后面那一段（D4：点关键帧本身就等于选它后面的段） */
      const s = segmentAhead(t.frames, AppState.currentFrameIndex);
      if (!s) continue;
      lo = (lo === null) ? s.a : Math.min(lo, s.a);
      hi = (hi === null) ? s.b : Math.max(hi, s.b);
    }
    return (lo === null) ? null : { lo: lo, hi: hi };
  }

  /* ==================== 帧槽位移动（v7.2.0） ====================
     拖动帧块和调试入口共用这一份逻辑。

     以前有个憋屈的现象：9 帧的动画、k9 是这一段的最后一个关键帧，
     把 k9 拖到第 5 帧之后，第 6~9 帧会集体变空白 ——
     段变成 1→5 之后，第 5 帧后面那些派生帧既不在任何段里（orphan），
     又被当成「没有内容的槽位」，于是整条尾巴一起消失。

     现在分两步：
     ① 落点：把源帧的槽位数据搬到落点（覆盖落点原来的内容），源位留空；
     ② 补空：第一个关键帧之前、最后一个关键帧之后的空槽 / 悬空派生槽，
        一律补成最近关键帧的复制帧（普通帧，不带关键帧身份），
        姿态自然延展到首尾；有实体数据的普通帧保持原样，不会被覆盖。
     段内的空槽交给 reconcile 归一化成派生帧，不做实体复制。

     第 ① 步为什么用「覆盖」而不是「插入位移」：
     帧是姿态，不是列表项。k9 拖到第 5 格，就是「第 5 格改用 k9 的姿态」，
     后面的 6~9 跟着这个姿态延展；如果改成插入位移，被挤到后面的旧 k5
     会插在中间，尾巴就不是同一姿态了。 */
  function fillLooseFrames(trackId) {
    const t = AppState.tracks[trackId];
    if (!t || !t.frames || !t.frames.length) return 0;
    const arr = t.frames;
    let first = -1, last = -1;
    for (let i = 0; i < arr.length; i++) { if (KF.isKey(arr[i])) { first = i; break; } }
    if (first < 0) return 0;                     /* 一个关键帧都没有，无从补起 */
    for (let i = arr.length - 1; i >= 0; i--) { if (KF.isKey(arr[i])) { last = i; break; } }
    let filled = 0;
    const put = (i, src) => {
      const d = arr[i];
      if (d != null && !KF.isDerived(d)) return; /* 有实体数据，别动 */
      const c = cloneObjectKeepImg(src);
      if (!c) return;
      delete c[KF.KEY];                          /* 复制品是普通帧 */
      delete c[KF.DERIVED];
      if (src.img) c.img = src.img;
      arr[i] = c;
      filled++;
    };
    const headSrc = arr[first];
    for (let i = 0; i < first; i++) put(i, headSrc);           /* 段前留白 → 首帧姿态 */
    const tailSrc = arr[last];
    for (let i = last + 1; i < arr.length; i++) put(i, tailSrc); /* 段后留白 → 末关键帧姿态 */
    return filled;
  }

  /* 老名字保留（调试脚本还在用），只补尾巴 */
  function repairTailAfterLastKey(trackId) {
    const t = AppState.tracks[trackId];
    if (!t || !t.frames || !t.frames.length) return 0;
    const arr = t.frames;
    let last = -1;
    for (let i = arr.length - 1; i >= 0; i--) { if (KF.isKey(arr[i])) { last = i; break; } }
    if (last < 0 || last >= arr.length - 1) return 0;
    const src = arr[last];
    if (!KF.isReal(src)) return 0;
    let filled = 0;
    for (let i = last + 1; i < arr.length; i++) {
      const d = arr[i];
      if (d != null && !KF.isDerived(d)) continue;
      const c = cloneObjectKeepImg(src);
      if (!c) continue;
      delete c[KF.KEY];
      delete c[KF.DERIVED];
      if (src.img) c.img = src.img;
      arr[i] = c;
      filled++;
    }
    return filled;
  }

  function applyFrameMove(fromIndex, targetIndex, opts) {
    const total = AppState.frames.length;
    if (!total) return false;
    const from = Math.max(0, Math.min(fromIndex, total - 1));
    const to = Math.max(0, Math.min(targetIndex, total - 1));
    if (from === to) return false;
    const reorder = !!(opts && opts.reorder);     /* 按住 Alt 拖动 = 整帧挪位重排 */

    if (isSubTrackMode()) {
      /* 子轨道：只在当前 track 内动，绝不碰其他 track */
      const t = AppState.tracks[AppState.activeTrackId];
      if (!t || !t.frames) return false;
      const arr = t.frames;
      while (arr.length < total) arr.push(null);
      const a = Math.min(from, arr.length - 1);
      const b = Math.min(to, arr.length - 1);
      if (reorder) {
        const [mv] = arr.splice(a, 1);
        arr.splice(b, 0, mv);
      } else {
        const mv = arr[a];
        arr[a] = null;
        arr[b] = mv;
      }
      fillLooseFrames(AppState.activeTrackId);
      AppState.currentFrameIndex = b;
    } else if (reorder) {
      /* 全局重排：帧元信息与所有 track 同步位移一位 */
      const [moved] = AppState.frames.splice(from, 1);
      AppState.frames.splice(to, 0, moved);
      for (const id in AppState.tracks) {
        const t = AppState.tracks[id];
        if (!t) continue;
        if (!t.frames) t.frames = [];
        const arr = t.frames;
        while (arr.length < from) arr.push(null);
        const removed = arr.splice(from, 1);
        const movedData = removed.length ? removed[0] : null;
        const insertAt = Math.max(0, Math.min(to, arr.length));
        arr.splice(insertAt, 0, movedData);
        fillLooseFrames(id);
      }
      AppState.currentFrameIndex = to;
    } else {
      /* 全局覆盖：默认行为 —— 落点那一格改用源帧的姿态，源位腾空后补空 */
      for (const id in AppState.tracks) {
        const t = AppState.tracks[id];
        if (!t) continue;
        if (!t.frames) t.frames = [];
        const arr = t.frames;
        while (arr.length < total) arr.push(null);
        const mv = arr[from];
        arr[from] = null;
        arr[to] = mv;
        fillLooseFrames(id);
      }
      const mFrom = AppState.frames[from], mTo = AppState.frames[to];
      if (mFrom && mTo) { mTo.isTween = mFrom.isTween; mTo.duration = mFrom.duration; }
      AppState.currentFrameIndex = to;
    }

    /* 重排后重新归一化槽位身份（段内 → 派生，段外悬空派生 → 空白），
       顺序必须在补空之后：先补，reconcile 才不会把刚补的实体帧又抹掉。 */
    reconcileAllTracks();
    syncMainLengthFromTracks();
    trimTrailingEmptyFrames();
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = isSubTrackMode() ? getActiveTrackObject() : null;
    if (isSubTrackMode()) { AppState.canvasSelected = false; cancelTransformBoxDrag(); anchorModeOn = false; }
    seekVideoToFrame(AppState.currentFrameIndex);
    updateFrameBar();
    EventBus.emit('history:save', reorder ? '调整帧顺序' : '覆盖帧姿态');
    EventBus.emit('need:render');
    EventBus.emit('need:syncUI');
    return true;
  }

  function updateFrameBar() {
    syncMainLengthFromTracks();
    syncTweenButtonLabel();   /* v7.2.1：段内/段外决定按钮是「插 N 帧」还是「补间 N 帧」 */
    refreshSubTrackOptions();
    const bar = document.getElementById('frameBar');
    const scrubber = document.getElementById('timelineScrubber');
    if (!bar) return;
    bar.classList.toggle('thumb-mode', frameThumbMode);
    /* v7.2.0：拖动语义写在容器标题上，Alt 重排不靠猜 */
    bar.title = tr2('frame.dragTitle', '拖动帧块：把这一帧的姿态覆盖到落点，后面跟着延展；按住 Alt 拖动：整帧挪位（重排顺序）');

    if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = Math.max(0, AppState.frames.length - 1);
    if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;

    if (scrubber) {
      scrubber.max = AppState.frames.length - 1;
      scrubber.value = AppState.currentFrameIndex;
    }
    updateScrubberTime();

    let dragIndicator = document.getElementById('dragIndicator');
    if (!dragIndicator) {
      dragIndicator = document.createElement('div');
      dragIndicator.id = 'dragIndicator';
      bar.appendChild(dragIndicator);
    }

    const chips = bar.querySelectorAll('.frame-chip');
    chips.forEach(c => c.remove());

    const kfSeg = kfSegRangeNow();

    AppState.frames.forEach((fr, i) => {
      const chip = document.createElement('div');
      chip.className = 'frame-chip';
      if (fr.isTween) chip.classList.add('tween-frame');
      const emptyTrackFrame = isSubTrackMode() && !getFrameTrackObject(fr, i);
      if (emptyTrackFrame) {
        chip.classList.add('empty-frame');
        chip.title = trv('frame.chipAway', { n: i + 1 }, `第 ${i + 1} 帧 · 当前元件未出场`);
        chip.setAttribute('aria-label', `第 ${i + 1} 帧，当前元件未出场`);
      }
      chip.dataset.index = i;

      /* v7.0.0：关键帧 / 派生帧标记 + 整段高亮 */
      const kfKind = kfChipKind(i);
      if (kfKind === 'key') chip.classList.add('kf-key');
      else if (kfKind === 'partial') { chip.classList.add('kf-partial'); chip.dataset.kfPartial = '1'; }
      else if (kfKind === 'derived') { chip.classList.add('tween-frame'); chip.classList.add('kf-nodrag'); }
      if (kfSeg && i >= kfSeg.lo && i <= kfSeg.hi) chip.classList.add('kf-seg');

      if (frameThumbMode) {
        if (!emptyTrackFrame) {
          let url = null;
          
          // 新增：判断是否是摄像机轨道。如果是，就显示摄像机画面；如果不是，就忽略摄像机显示自身画面。
          const isCamTrack = isSubTrackMode() && isCameraTrackId(AppState.activeTrackId);
          const ignoreCamera = !isCamTrack;

          if (isSubTrackMode()) {
            const key = AppState.activeTrackId + '|' + i;
            const hit = trackThumbCache.get(key);
            if (hit && hit.v === thumbVersion) {
              url = hit.url;
            } else {
              try {
                const off = renderFrameToDataURL(fr, 96, 96, { transparent: true, ignoreCamera }, AppState.activeTrackId);
                url = off.toDataURL('image/png');
              } catch (_) { url = null; }
              if (url) trackThumbCache.set(key, { v: thumbVersion, url });
              else trackThumbCache.delete(key);
            }
          } else if (fr._thumb && fr._thumb.v === thumbVersion) {
            url = fr._thumb.url;
          } else {
            try {
              const off = renderFrameToDataURL(fr, 96, 96, { transparent: true, ignoreCamera });
              url = off.toDataURL('image/png');
            } catch (_) { url = null; }
            fr._thumb = { v: thumbVersion, url };
          }
          if (url) {
            const im = document.createElement('img');
            im.className = 'frame-thumb';
            im.src = url;
            chip.appendChild(im);
          }
        }
        const idxSpan = document.createElement('span');
        idxSpan.className = 'frame-idx';
        idxSpan.textContent = (i + 1);
        chip.appendChild(idxSpan);
      } else {
        chip.textContent = (i + 1);
      }

      if (multiSelectMode && multiSelectedFrames.has(i)) chip.classList.add('multi-selected');

      chip.addEventListener('pointerdown', (e) => {
        if (isPlaying) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        if (multiSelectMode) {
          if (multiSelectedFrames.has(i)) {
            multiSelectedFrames.delete(i);
            chip.classList.remove('multi-selected');
          } else {
            multiSelectedFrames.add(i);
            chip.classList.add('multi-selected');
          }
          updateMultiActions();
          return;
        }

        const isMouse = e.pointerType === 'mouse';
        /* v7.0.0（D8）：派生帧是算出来的，不许单独拖拽。
           点选、多选、切帧照旧，只是拖不起来。 */
        const isDerivedChip = (kfChipKind(i) === 'derived');
        dragStartX = e.clientX; 
        dragStartY = e.clientY;
        const dragStartIndex = i;
        let hasMoved = false;
        let isDragging = false;
        let insertIndex = i;
        let startScrollLeft = bar.scrollLeft;

        const allChips = Array.from(bar.querySelectorAll('.frame-chip'));
        let dragRects = null;   /* v6.3.1：拖动开始时的槽位快照，用于实时让位 */
        const startDrag = () => {
          if (isDerivedChip) return;   /* 派生帧禁止拖起 */
          isDragging = true;
          chip.classList.add('dragging');
          dragRects = allChips.map(c => c.getBoundingClientRect());
        };

        // 鼠标按下直接开始拖拽，触屏则需要按住 300ms（防止和横向滑动冲突）
        if (isMouse) {
          startDrag();
        } else {
          pressTimer = setTimeout(() => {
            if (isDerivedChip) {
              /* 长按派生帧：解释为什么拖不动，而不是毫无反应 */
              showHistoryToast('派生帧由关键帧算出，不能拖动；要改就在这一帧直接编辑', 'redo', 2200);
              return;
            }
            startDrag();
            if (navigator.vibrate) navigator.vibrate(40); // 增加振动反馈，告知已触发拖拽
          }, 300);
        }

        const onPointerMove = (me) => {
          if (!isDragging) {
            const dx = me.clientX - dragStartX;
            const dy = me.clientY - dragStartY;
            
            // 判定为移动：放宽到 8px 的抖动容错
            if (!hasMoved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
              clearTimeout(pressTimer);
              hasMoved = true;
            }
            
            // 如果进入移动状态并且是触屏，允许横向滑动时间轴
            if (hasMoved && !isMouse) {
              bar.scrollLeft = startScrollLeft - dx;
            }
            return;
          }

          // 拖拽中：边缘自动滚动（滚动量要补给槽位快照，否则跟手会错位）
          const barRect = bar.getBoundingClientRect();
          let ds = 0;
          if (me.clientX > barRect.right - 40) ds = 10;
          else if (me.clientX < barRect.left + 40) ds = -10;
          if (ds) {
            const before = bar.scrollLeft;
            bar.scrollLeft += ds;
            const actual = bar.scrollLeft - before;
            if (actual && dragRects) {
              dragRects.forEach(r => { r.left -= actual; r.right -= actual; });
              dragStartX -= actual;
            }
          }

          /* 被拖帧块跟手 */
          const dx = me.clientX - dragStartX;
          chip.style.transform = 'translateX(' + Math.round(dx) + 'px) scale(1.08)';

          /* 插到哪：指针越过某个帧块的中线就插到它前面 */
          for (let j = 0; j < allChips.length; j++) {
            const rect = dragRects ? dragRects[j] : allChips[j].getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (me.clientX < mid) { insertIndex = j; break; }
            if (j === allChips.length - 1) insertIndex = allChips.length;
          }

          /* 其余帧块实时让位：整体前移/后移一格，露出落点 */
          for (let j = 0; j < allChips.length; j++) {
            if (j === dragStartIndex) continue;
            let shift = 0;
            if (insertIndex > dragStartIndex) {
              if (j > dragStartIndex && j < insertIndex) shift = dragRects[j - 1].left - dragRects[j].left;
            } else if (insertIndex < dragStartIndex) {
              if (j >= insertIndex && j < dragStartIndex) shift = dragRects[j + 1].left - dragRects[j].left;
            }
            allChips[j].style.transform = shift ? 'translateX(' + Math.round(shift) + 'px)' : '';
          }
        };

        const onPointerUp = (ev) => {
          clearTimeout(pressTimer);
          chip.classList.remove('dragging');
          /* v6.3.1：清掉跟手/让位的位移，重排后由 updateFrameBar 重建 */
          chip.style.transform = '';
          allChips.forEach(c => { if (c !== chip) c.style.transform = ''; });
          dragRects = null;
          if (dragIndicator) dragIndicator.style.display = 'none';
          document.removeEventListener('pointermove', onPointerMove);
          document.removeEventListener('pointerup', onPointerUp);
          document.removeEventListener('pointercancel', onPointerUp);

          if (isDragging) {
            let targetIndex = insertIndex;
            if (targetIndex > dragStartIndex) targetIndex--;
            
            if (targetIndex !== dragStartIndex) {
              /* v7.2.0：落点处理抽成 applyFrameMove()，方便调试入口直接调用。
                 默认「覆盖」：落点这一格改用源帧的姿态，后面的帧跟着延展；
                 按住 Alt 才是「重排」：整帧挪位、中间帧依次让位。 */
              applyFrameMove(dragStartIndex, targetIndex, { reorder: !!(ev && ev.altKey) });
            } else {
              // 鼠标拖拽了但位置没有变化，当作点击处理
              if (isMouse && !hasMoved) { goToFrame(dragStartIndex); announcePartialKeys(dragStartIndex); }
            }
          } else if (!hasMoved) {
            goToFrame(dragStartIndex);
            announcePartialKeys(dragStartIndex);
          }
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
      });

      bar.insertBefore(chip, dragIndicator);
    });

    const newChips = bar.querySelectorAll('.frame-chip');
    const totalFrames = AppState.frames.length; // 获取总帧数
    
    newChips.forEach((chip, i) => {
      const isActive = (i === AppState.currentFrameIndex);
      
      if (isActive) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
      
      // 动态修改文字显示
      const textToShow = isActive ? `${i + 1}/${totalFrames}` : `${i + 1}`;
      
      // 如果开启了缩略图模式，修改内部的 .frame-idx
      const idxSpan = chip.querySelector('.frame-idx');
      if (idxSpan) {
        idxSpan.textContent = textToShow;
      } else {
        // 如果没开启缩略图模式，直接修改按钮的文本
        chip.textContent = textToShow;
      }

      /* D10：部分关键帧要说清是哪几个元件有锚点 */
      if (chip.dataset.kfPartial) {
        const names = kfPartialNames(i);
        chip.title = tr2('frame.chipHead', '第 ') + (i + 1) + tr2('frame.chipMid', ' 帧 · 部分关键帧：') + (names.join('、') || '—') + tr2('frame.chipTail', ' 有锚点，其余元件没有');
      }
    });

    const active = bar.querySelector('.frame-chip.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateMultiActions();
    renderKfCurveStrip();
    syncKeyframeButtonState();
  }

  function addFrame() {
    if (isPlaying) pause();
    syncFrameRef();
    if (isSubTrackMode()) {
      const t = ensureTrack(AppState.activeTrackId, (AppState.selected && AppState.selected.name) || AppState.activeTrackId);
      /* v7.0.0：在段内加帧只是把段拉长一格，插出来的是派生帧；
         段外维持原来的克隆行为，且克隆必须剥掉关键帧身份，否则一加帧就多出个锚点。 */
      const inSeg = !!segmentAhead(t.frames, AppState.currentFrameIndex);
      const srcObj = getFrameTrackObject(null, AppState.currentFrameIndex);
      let clone = null;
      if (inSeg) clone = KF.DERIVED_SLOT;
      else if (srcObj) { clone = cloneObjectKeepImg(srcObj); clone.id = srcObj.id; delete clone[KF.KEY]; }
      const nextIdx = AppState.currentFrameIndex + 1;
      if (nextIdx < t.frames.length && t.frames[nextIdx] == null) {
        /* 下一帧对当前轨道是空白帧：直接占用该槽位，不把后面的帧挤开 */
        t.frames[nextIdx] = clone;
      } else {
        while (t.frames.length < nextIdx) t.frames.push(null);
        t.frames.splice(nextIdx, 0, clone);
      }
      AppState.currentFrameIndex = nextIdx;
      reconcileAllTracks();
      syncMainLengthFromTracks();
      trimTrailingEmptyFrames();
      invalidateAllFrameThumbs();
      AppState.objects = getCombinedObjectsForRender();
      AppState.selected = getActiveTrackObject();
      AppState.canvasSelected = false;
      cancelTransformBoxDrag(); anchorModeOn = false;
      seekVideoToFrame(AppState.currentFrameIndex);
      updateFrameBar();
      EventBus.emit('need:render'); EventBus.emit('need:syncUI');
      EventBus.emit('history:save', '添加帧');
      return;
    }
    const insertAt = AppState.currentFrameIndex + 1;
    const last = AppState.frames[AppState.frames.length - 1];
    const newFrame = {
      id: ((last && last.id) || AppState.frames.length) + 1,
      duration: Math.round(1000 / defaultFPS),
      isTween: false
    };
    AppState.frames.splice(insertAt, 0, newFrame);
    /* 全局模式：所有 track 同步插入并各自克隆当前帧；段内的轨道插派生帧 */
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t) continue;
      if (!t.frames) t.frames = [];
      while (t.frames.length < insertAt) t.frames.push(null);
      if (segmentAhead(t.frames, AppState.currentFrameIndex)) {
        t.frames.splice(insertAt, 0, KF.DERIVED_SLOT);
        continue;
      }
      const src = t.frames[AppState.currentFrameIndex];
      const clone = KF.isReal(src) ? cloneObjectKeepImg(src) : null;
      if (clone) { clone.id = src.id; delete clone[KF.KEY]; }
      t.frames.splice(insertAt, 0, clone);
    }
    reconcileAllTracks();
    syncMainLengthFromTracks();
    AppState.currentFrameIndex = insertAt;
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = null; AppState.canvasSelected = false;
    cancelTransformBoxDrag(); anchorModeOn = false;
    seekVideoToFrame(AppState.currentFrameIndex);
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '添加帧');
  }

  /* v7.0.1：删除关键帧 ≠ 清空。
     落在所有段之外的帧不该变成空白，而是延续最近的关键帧姿势（静止延续）：
       · 删的是末端关键帧 → 这一段剩下的帧全部延续上一关键帧
       · 删的是首位关键帧 → 段内剩下的帧全部延续下一关键帧
       · 删的是中间关键帧 → 前后两段合并，交给 reconcile 自动补帧 */
  function fillHoldRange(t, from, to, srcIdx) {
    if (!t || !t.frames || !KF.isReal(t.frames[srcIdx])) return 0;
    if (from > to) return 0;
    let n = 0;
    const lo = Math.max(0, from), hi = Math.min(to, t.frames.length - 1);
    for (let i = lo; i <= hi; i++) {
      if (i === srcIdx) continue;
      const c = cloneObjectKeepImg(t.frames[srcIdx]);
      delete c[KF.KEY];
      t.frames[i] = c;
      n++;
    }
    return n;
  }

  function keyNeighbors(frames, k) {
    let prev = null, next = null;
    for (let i = 0; i < frames.length; i++) {
      if (!KF.isKey(frames[i])) continue;
      if (i < k) prev = i;
      else if (i > k && next === null) next = i;
    }
    return { prev: prev, next: next };
  }

  /* 抽掉某一格之前先给「末端/首位关键帧」补静止延续 */
  function prepareHoldBeforeSplice(k, onlyTrackId) {
    for (const id in AppState.tracks) {
      if (onlyTrackId != null && String(id) !== String(onlyTrackId)) continue;
      const t = AppState.tracks[id];
      if (!t || !t.frames || !KF.isKey(t.frames[k])) continue;
      const nb = keyNeighbors(t.frames, k);
      if (nb.prev !== null && nb.next === null) fillHoldRange(t, nb.prev + 1, k - 1, nb.prev);
      else if (nb.prev === null && nb.next !== null) fillHoldRange(t, k + 1, nb.next, nb.next);
    }
  }

  function deleteFrame() {
    if (isPlaying) pause();
    if (isSubTrackMode()) {
      syncFrameRef();
      const t = AppState.tracks[AppState.activeTrackId];
      const target = getFrameTrackObject(null, AppState.currentFrameIndex);
      if (!t) return;
      if (AppState.currentFrameIndex < 0 || AppState.currentFrameIndex >= t.frames.length) return;
      /* v7.0.1：删掉的是末端 / 首位关键帧 → 剩下的帧延续相邻关键帧，不要留空 */
      prepareHoldBeforeSplice(AppState.currentFrameIndex, AppState.activeTrackId);
      t.frames.splice(AppState.currentFrameIndex, 1);
      if (t.frames.length === 0) t.frames.push(null);
      reconcileAllTracks();
      trimTrailingEmptyFrames();
      if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = AppState.frames.length - 1;
      if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
      invalidateAllFrameThumbs();
      AppState.objects = getCombinedObjectsForRender();
      AppState.selected = getActiveTrackObject();
      AppState.canvasSelected = false;
      cancelTransformBoxDrag(); anchorModeOn = false;
      seekVideoToFrame(AppState.currentFrameIndex);
      updateFrameBar();
      EventBus.emit('need:render'); EventBus.emit('need:syncUI');
      EventBus.emit('history:save', '删除元件帧');
      return;
    }
    if (AppState.frames.length <= 1) { alert(tr2('timeline.keepOne', '至少保留一帧')); return; }
    /* v7.0.1：删掉的是末端 / 首位关键帧 → 先按相邻关键帧铺满，再抽掉这一格。
       中间关键帧不用铺：抽掉后前后两段合并，reconcile 会自动补出插值帧。 */
    prepareHoldBeforeSplice(AppState.currentFrameIndex);
    AppState.frames.splice(AppState.currentFrameIndex, 1);
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      if (AppState.currentFrameIndex < t.frames.length) t.frames.splice(AppState.currentFrameIndex, 1);
    }
    reconcileAllTracks();
    trimTrailingEmptyFrames();
    if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = AppState.frames.length - 1;
    if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = null; AppState.canvasSelected = false;
    cancelTransformBoxDrag(); anchorModeOn = false;
    seekVideoToFrame(AppState.currentFrameIndex);
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', tr2('timeline.delFrame', '删除帧'));
  }

  function applyFPS(fps) {
    defaultFPS = fps;
    const dur = Math.round(1000 / fps);
    AppState.frames.forEach(fr => fr.duration = dur);
    document.getElementById('fpsVal').textContent = fps;
    document.getElementById('fpsSlider').value = fps;
    seekVideoToFrame(AppState.currentFrameIndex);
  }

  /* ==================== 播放 ==================== */
  function play() {
    if (isPlaying || AppState.frames.length < 2) return;
    syncFrameRef();
    isPlaying = true;
    AppState.selected = null; drag = null; AppState.canvasSelected = false;
    cancelTransformBoxDrag(); anchorModeOn = false;
    document.getElementById('btnPlay').innerHTML = ic('pause') + '<span data-i18n="play.pause">' + tr2('play.pause', '暂停') + '</span>';
    document.getElementById('playBadge').style.display = 'block';
    let idx = AppState.currentFrameIndex;
    playState = { idx, acc: 0, last: performance.now() };
    AppState.objects = getCombinedObjectsForRenderAt(idx);
    AppState.currentFrameIndex = idx;
    seekVideoToFrame(idx);

    if (refVideo) {
      refVideo.muted = false;
      refVideo.currentTime = getFrameStartTime(idx);
      refVideo.play().catch(() => {});
      refVideoPlaying = true;
      startVideoRaf();
    }

    EventBus.emit('need:render');
    playTimer = requestAnimationFrame(playTick);
  }

  function pause() {
    isPlaying = false;
    if (playTimer) cancelAnimationFrame(playTimer);
    playTimer = null;
    document.getElementById('btnPlay').innerHTML = ic('play') + '<span data-i18n="play.play">' + tr2('play.play', '播放') + '</span>';
    document.getElementById('playBadge').style.display = 'none';
    if (refVideo && refVideoPlaying) {
      refVideo.pause();
      refVideo.muted = true;
      refVideoPlaying = false;
      if (refVideoRaf) { cancelAnimationFrame(refVideoRaf); refVideoRaf = null; }
      updateVideoUI();
    }
    EventBus.emit('need:render');
  }

  function togglePlay() { if (isPlaying) pause(); else play(); }

  function playTick(now) {
    if (!isPlaying || !playState) return;
    const st = playState;
    st.acc += now - st.last;
    st.last = now;
    let changed = false;
    let guard = 0;
    while (st.acc >= AppState.frames[st.idx].duration && guard++ < 100) {
      st.acc -= AppState.frames[st.idx].duration;
      st.idx = (st.idx + 1) % AppState.frames.length;
      changed = true;
    }
    if (changed) {
      AppState.objects = getCombinedObjectsForRenderAt(st.idx);
      AppState.currentFrameIndex = st.idx;
      if (!refVideoPlaying) seekVideoToFrame(AppState.currentFrameIndex);
      renderCanvas(false);
      updateFrameBarHighlight();
      SKFE.systems.camera.updateCameraPreview(); // ⬅️ 新增这一行！让预览窗口跟着刷新
    }
    playTimer = requestAnimationFrame(playTick);
  }

  /* ==================== 缓动曲线 ==================== */
  let tweenEaseKey = 'linear';
  let tweenCustomBezier = [0.42, 0, 0.58, 1];

  const CUSTOM_EASE_KEY = 'skfe_ease_presets_v1';
  let customEasePresets = [];

  /* ==================== 缓动核心（已迁移至 js/features/ease.js） ==================== */
  const { TWEEN_EASE_PRESETS, bezierAxis, cubicBezierEase, easeElastic1, easeElastic2, easeThumbPath } = SKFE.features.ease;
  function getEaseBezier(key) {
    return SKFE.features.ease.getEaseBezier(key, { customEasePresets, tweenCustomBezier });
  }
  function getEaseFunction(key) {
    return SKFE.features.ease.getEaseFunction(key, {
      customEasePresets, elastic1Params, elastic2Params, tweenCustomBezier,
    });
  }

  function loadCustomEasePresets() {
    try {
      const raw = localStorage.getItem(CUSTOM_EASE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      customEasePresets = Array.isArray(arr)
        ? arr.filter(p => p && p.id && p.name).map(p => {
            if (!p.type) {
              p.type = 'bezier'; // 兼容旧版未分类预设
              if (!p.bezier) p.bezier = [0.42, 0, 0.58, 1];
            }
            return p;
          })
        : [];
    } catch (_) { customEasePresets = []; }
  }
  function persistCustomEasePresets() {
    try { localStorage.setItem(CUSTOM_EASE_KEY, JSON.stringify(customEasePresets)); } catch (_) {}
  }

  const tweenEaseBtn = document.getElementById('btnTweenMore');
  const tweenMoreMenu = document.getElementById('tweenMoreMenu');
  const tweenEaseName = document.getElementById('tweenEaseName');
  const tweenEaseMenu = document.getElementById('tweenEaseMenu');
  /* v7.0.5：时间轴上的「⚙️ 高级设置」按钮已移除（内容搬到控制面板底部栏的「高级」分区），
     这里保持判空，v6/v7 的调用点不用逐个改。 */
  const advSettingsBtn = document.getElementById('btnAdvancedSettings');
  const advPanel = document.getElementById('timelineAdvancedPanel');
  const easeOverlay = document.getElementById('easeEditorOverlay');
  const easeCanvas = document.getElementById('easeEditorCanvas');
  const easeValueEl = document.getElementById('easeEditorValue');
  const easeCtx = easeCanvas.getContext('2d');
  const easePresetNameInline = document.getElementById('easePresetNameInline');
  const btnSaveEasePresetInline = document.getElementById('btnSaveEasePresetInline');
  const easePresetListInline = document.getElementById('easePresetListInline');

  let easeDraft = tweenCustomBezier.slice();
  let easeDrag = -1;
  let easeCanvasW = 300;
  let easeCanvasH = 180;

  function tweenEaseProgress(u) {
    return getEaseFunction(tweenEaseKey)(u);
  }

  /* v7.0.0：把缓动系统交给关键帧求值器。
     段上没有存曲线时退回当前选中的缓动（保持旧补间的手感）；
     通道级缓动优先用段曲线里的 ch[part]，其次才是旧的「分部缓动」全局表。 */
  kfEaseProvider = {
    key: () => tweenEaseKey,
    fn: (k) => getEaseFunction(k || 'linear'),
    channel: (objId, part) => {
      const ek = tweenJointEases[String(objId) + ':' + part];
      return ek || null;
    }
  };
  let elastic1Params = { damping: 0.6, period: 0.8 };
  let elastic2Params = { period: 0.5, skew: 0 };



  function updateTweenEaseLabel() {
    /* v7.0.0：有段就显示段自己的曲线，没有段才显示全局默认值 */
    const segEase = (typeof currentSegmentEase === 'function') ? currentSegmentEase() : null;
    const ek = segEase || 'linear';   /* 没有段曲线就是匀速，别再显示全局残留值 */
    let label;
    if (ek && ek.startsWith('preset:')) {
      const id = ek.slice(7);
      const p = customEasePresets.find(x => x.id === id);
      label = p ? p.name : tr2('ease.customName', '自定义');
    } else if (ek === 'custom') {
      label = tr2('ease.customName', '自定义');
    } else if (ek === 'elastic1') {
      label = tr2('ease.elastic1Name', '阻尼振荡');
    } else if (ek === 'elastic2') {
      label = tr2('ease.elastic2Name', '周期');
    } else {
      label = tr2('ease.' + ((TWEEN_EASE_PRESETS[ek] ? ek : 'linear')), (TWEEN_EASE_PRESETS[ek] || TWEEN_EASE_PRESETS.linear).label);
    }
    tweenEaseName.textContent = label;
    tweenEaseBtn.title = (segEase ? tr2('ease.segmentTitle', '当前段曲线 · ') : tr2('ease.defaultTitle', '段曲线（默认）· ')) + label;
  }

  function renderTweenEaseMenu() {
    const builtins = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'custom'];
    const segEase = (typeof currentSegmentEase === 'function') ? currentSegmentEase() : null;
    const activeKey = segEase || 'linear';
    let html = '';
    builtins.forEach(key => {
      const custom = key === 'custom';
      let label, thumbInput;
      
      if (key === 'elastic1') {
        label = tr2('ease.elastic1Name', '阻尼振荡');
        thumbInput = u => easeElastic1(u, elastic1Params.damping, elastic1Params.period);
      } else if (key === 'elastic2') {
        label = tr2('ease.elastic2Name', '周期');
        thumbInput = u => easeElastic2(u, elastic2Params.period, elastic2Params.skew);
      } else if (custom) {
        label = tr2('ease.customCurve', '自定义曲线…');
        thumbInput = tweenCustomBezier;
      } else {
        label = tr2('ease.' + key, TWEEN_EASE_PRESETS[key].label);
        thumbInput = TWEEN_EASE_PRESETS[key].bezier;
      }
      
      const active = activeKey === key;
      html += (custom ? '<div class="ease-divider"></div>' : '') +
        '<button type="button" class="ease-item' + (active ? ' active' : '') + '" data-ease="' + key + '" role="menuitemradio" aria-checked="' + active + '">' +
          '<svg class="ease-thumb" viewBox="0 0 40 28" aria-hidden="true"><path d="' + easeThumbPath(thumbInput) + '"/></svg>' +
          '<span class="ease-label">' + label + '</span>' +
          '<span class="ease-check">' + (active ? ic('check-correct') : '') + '</span>' +
        '</button>';
    });
    if (customEasePresets.length) {
      html += '<div class="ease-divider"></div>';
      customEasePresets.forEach(p => {
        const key = 'preset:' + p.id;
        const active = activeKey === key;
        html += '<button type="button" class="ease-item' + (active ? ' active' : '') + '" data-ease="' + key + '" role="menuitemradio" aria-checked="' + active + '">' +
          '<svg class="ease-thumb" viewBox="0 0 40 28" aria-hidden="true"><path d="' + easeThumbPath(p.bezier) + '"/></svg>' +
          '<span class="ease-label">' + p.name + '</span>' +
          '<span class="ease-check">' + (active ? ic('check-correct') : '') + '</span>' +
        '</button>';
      });
    }
    html += '<div class="ease-divider"></div>' +
      '<button type="button" class="ease-item ease-preset-add" data-action="add-preset" role="menuitem">' +
        '<span class="ease-label">' + tr2('ease.newPreset', '＋ 新建自定义预设…') + '</span>' +
      '</button>';
    tweenEaseMenu.innerHTML = html;
  }
  function setAdvPanelOpen(open) {
    if (!advPanel) return;
    advPanel.hidden = !open;
    if (advSettingsBtn) {
      advSettingsBtn.classList.toggle('open', open);
      advSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) setEaseMenuOpen(false);
  }
  /* v7.0.4：段曲线菜单改成 fixed 定位，按按钮的实际屏幕位置摆放。
     因为控制栏 .timeline-controls 现在是横向滚动容器（overflow-x:auto），
     absolute 定位的子元素会被裁剪掉，所以必须脱离文档流手动算位置。 */
  function positionEaseMenu() {
    if (!tweenMoreMenu || tweenMoreMenu.hidden) return;
    const r = tweenEaseBtn.getBoundingClientRect();
    const mw = tweenMoreMenu.offsetWidth || 240;
    const mh = tweenMoreMenu.offsetHeight || 280;
    const pad = 8;
    let left = r.left;
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
    if (left < pad) left = pad;
    let top = r.top - mh - 8;                       /* 默认开在按钮上方 */
    if (top < pad) top = r.bottom + 8;              /* 上方不够就开在下方 */
    if (top + mh > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - mh - pad);

    /* v7.2.1：菜单是 position:fixed，但时间轴坞 #timeline 上挂着 transform（置顶/置底的位移），
       fixed 元素在有 transform 的祖先里会退化成「相对那个祖先」定位 —— 
       时间轴置底时按钮在 y≈690，菜单按视口算的 top 再加一次 682 的位移，就整个跑到屏幕外面，
       表现就是「曲线菜单点不开」。这里量一次实际位置，把差值补回去（位移是常量，补一次就准）。 */
    tweenMoreMenu.style.left = Math.round(left) + 'px';
    tweenMoreMenu.style.top = Math.round(top) + 'px';
    const real = tweenMoreMenu.getBoundingClientRect();
    const dx = real.left - left, dy = real.top - top;
    if (Math.abs(dx) > 0.5) tweenMoreMenu.style.left = Math.round(left - dx) + 'px';
    if (Math.abs(dy) > 0.5) tweenMoreMenu.style.top = Math.round(top - dy) + 'px';
  }
  function setEaseMenuOpen(open) {
    if (open) { renderTweenEaseMenu(); setAdvPanelOpen(false); }
    tweenMoreMenu.hidden = !open;
    tweenEaseBtn.classList.toggle('open', open);
    tweenEaseBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) positionEaseMenu();   /* 必须先显示出来才能量到宽高 */
  }
  /* 窗口尺寸变了、或控制栏被横向滑动时，菜单要跟着按钮走 */
  window.addEventListener('resize', () => { if (!tweenMoreMenu.hidden) positionEaseMenu(); });
  (function bindEaseMenuFollow() {
    const bar = document.querySelector('.timeline-controls');
    if (bar) bar.addEventListener('scroll', () => { if (!tweenMoreMenu.hidden) positionEaseMenu(); }, { passive: true });
  })();

  tweenEaseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setEaseMenuOpen(tweenMoreMenu.hidden);
  });
  tweenEaseMenu.addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-action="add-preset"]');
    if (addBtn) { setEaseMenuOpen(false); openEaseEditor(); return; }
    const item = e.target.closest('.ease-item');
    if (!item) return;
    const key = item.dataset.ease;
    if (key === 'custom') { setEaseMenuOpen(false); openEaseEditor(); return; }
    /* v7.0.1：曲线只作用于相邻两个关键帧之间的那一段。
       当前帧不在段内就不该偷偷改全局默认值，否则别的段会跟着变。 */
    const touched = applyEaseToCurrentSegments(key);
    if (!touched) {
      showHistoryToast(!isSubTrackMode() && !(AppState.selected && AppState.selected.id != null)
        ? '先在画布上选中一个元件，再改它这一段的曲线（曲线只作用于这一个元件相邻两个关键帧之间）'
        : '曲线只作用于相邻两个关键帧之间的段 —— 当前帧不在任何段内，先把两侧打好关键帧',
        'redo', 2800);
      setEaseMenuOpen(false);
      return;
    }
    tweenEaseKey = key;
    updateTweenEaseLabel();
    setEaseMenuOpen(false);
  });

  /* v7.0.2：改曲线的目标轨道 —— 只认「当前这一个元件」的那一段。
     子轨 = 正在编辑的那条轨道；主轨 = 画布上选中的那个元件。
     以前这里用 currentScopeTrackIds()，主轨模式下等于「全部元件」，
     于是改一次曲线把所有元件同一位置的段一起改了 —— 曲线串台就是这么来的。 */
  function easeTargetTrackIds() {
    if (isSubTrackMode()) return [String(AppState.activeTrackId)];
    const sel = AppState.selected;
    if (sel && sel.id != null) {
      const id = String(sel.id);
      if (AppState.tracks[id]) return [id];
    }
    /* 没选中元件时，只有一个元件的工程就没歧义，直接给它 */
    const all = Object.keys(AppState.tracks);
    if (all.length === 1) return [all[0]];
    return [];
  }

  /* v7.0.0（D4 / D11）：把缓动写到「当前选中的段」上。
     选中段内任意帧即定位整段，末端关键帧在选区外也一起生效。
     没有段可写时不改任何东西（全局默认值只影响以后新建的段）。 */
  function applyEaseToCurrentSegments(key) {
    const idxs = (multiSelectMode && multiSelectedFrames.size)
      ? Array.from(multiSelectedFrames)
      : [AppState.currentFrameIndex];
    const ids = easeTargetTrackIds();
    const touched = [];
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      const seen = new Set();
      for (const i of idxs) {
        const seg = segmentAhead(t.frames, i);
        if (!seg || seen.has(seg.a)) continue;
        seen.add(seg.a);
        const old = KF.curveOf(t.frames[seg.a]) || {};
        KF.setCurve(t.frames[seg.a], { ease: key, ch: old.ch || null });
        touched.push(id + ':' + seg.a + '-' + seg.b);
      }
    }
    if (!touched.length) return 0;
    bumpKfEval();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:render');
    EventBus.emit('history:save', '改段曲线', 900);
    showHistoryToast('已把曲线应用到 ' + touched.length + ' 个段', undefined, 1500);
    return touched.length;
  }

  /* 当前段实际用的缓动（用于菜单高亮与按钮文字）。目标轨道同上，只看当前元件。 */
  function currentSegmentEase() {
    const ids = easeTargetTrackIds();
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      const seg = segmentAhead(t.frames, AppState.currentFrameIndex);
      if (!seg) continue;
      const c = KF.curveOf(t.frames[seg.a]);
      if (c && c.ease) return c.ease;
    }
    return null;
  }
  if (advSettingsBtn) advSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setAdvPanelOpen(advPanel.hidden);
  });
  document.getElementById('btnCloseAdvanced').addEventListener('click', () => setAdvPanelOpen(false));

  document.addEventListener('pointerdown', (e) => {
    if (!tweenMoreMenu.hidden && !e.target.closest('#tweenMoreMenu') && !e.target.closest('#btnTweenMore')) setEaseMenuOpen(false);
    if (!advPanel.hidden && !e.target.closest('#timelineAdvancedPanel') && !e.target.closest('#btnAdvancedSettings')) setAdvPanelOpen(false);
  });

  function renderEasePresetListInline() {
    if (!easePresetListInline) return;
    if (!customEasePresets.length) {
      easePresetListInline.innerHTML = tr2('ease.emptyPreset', '<div class="empty-state">暂无自定义预设</div>');
      return;
    }
    
    easePresetListInline.innerHTML = customEasePresets.map(p => {
      let metaText = '';
      let typeName = '';
      if (p.type === 'elastic1') { 
        metaText = tr2('ease.shortDamping', '阻') + ':' + p.params.damping.toFixed(2) + ' ' + tr2('ease.shortPeriod', '周') + ':' + p.params.period.toFixed(2); typeName = tr2('ease.tagDamped', '[阻尼]'); 
      } else if (p.type === 'elastic2') { 
        metaText = tr2('ease.shortPeriod', '周') + ':' + p.params.period.toFixed(2) + ' ' + tr2('ease.shortSkew', '偏') + ':' + p.params.skew.toFixed(2); typeName = tr2('ease.tagPeriod', '[周期]'); 
      } else { 
        metaText = p.bezier ? p.bezier.map(v => v.toFixed(2)).join(', ') : ''; typeName = tr2('ease.tagBezier', '[贝塞尔]'); 
      }
      
      const isSelected = (p.id === easeEditorSelectedPresetId);
      const bgStyle = isSelected ? 'background: var(--color-primary-soft); outline: 1px solid var(--color-primary);' : '';
      
      return `<div class="ease-preset-item" data-id="${p.id}" style="${bgStyle}">
        <span class="name">${typeName} ${p.name}</span>
        <span class="preset-bezier">${metaText}</span>
        <span class="del" title="${tr2('common.delete', '删除')}">${ic('close')}</span>
      </div>`;
    }).join('');
    easePresetListInline.querySelectorAll('.ease-preset-item').forEach(row => {
      const id = row.dataset.id;
      const p = customEasePresets.find(x => x.id === id);
      row.addEventListener('click', (e) => {
        if (e.target.closest('.del')) {
          customEasePresets = customEasePresets.filter(x => x.id !== id);
          persistCustomEasePresets();
          renderEasePresetListInline();
          if (tweenEaseKey === 'preset:' + id) { tweenEaseKey = 'linear'; updateTweenEaseLabel(); }
          return;
        }
        if (p) {
          easeEditorMode = p.type || 'bezier';
          easeEditorSelectedPresetId = p.id;
          if (easeEditorMode === 'bezier' && p.bezier) easeDraft = [...p.bezier];
          if (easeEditorMode === 'elastic1' && p.params) { elastic1Params.damping = p.params.damping; elastic1Params.period = p.params.period; }
          if (easeEditorMode === 'elastic2' && p.params) { elastic2Params.period = p.params.period; elastic2Params.skew = p.params.skew; }
          easePresetNameInline.value = p.name;
          updateEaseTabs();
          drawEaseEditor();
          renderEasePresetListInline();
        }
      });
    });
  }

  btnSaveEasePresetInline.addEventListener('click', () => {
    const name = easePresetNameInline.value.trim() || ('预设 ' + (customEasePresets.length + 1));
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    
    let presetData = { id, name, type: easeEditorMode };
    if (easeEditorMode === 'bezier') {
      const bezier = easeDraft.slice();
      bezier[0] = Math.max(0, Math.min(1, bezier[0]));
      bezier[2] = Math.max(0, Math.min(1, bezier[2]));
      presetData.bezier = bezier;
    } else if (easeEditorMode === 'elastic1') {
      presetData.params = { ...elastic1Params };
    } else if (easeEditorMode === 'elastic2') {
      presetData.params = { ...elastic2Params };
    }
    
    customEasePresets.push(presetData);
    persistCustomEasePresets();
    
    tweenEaseKey = 'preset:' + id;
    easeEditorSelectedPresetId = id;
    updateTweenEaseLabel();
    renderTweenEaseMenu();
    renderEasePresetListInline();
    easePresetNameInline.value = '';
  });

  function easeToCanvas(p) {
    const pad = 22;
    return { x: pad + p.x * (easeCanvasW - pad * 2), y: easeCanvasH - pad - p.y * (easeCanvasH - pad * 2) };
  }
  function easeFromCanvas(x, y) {
    const pad = 22;
    return {
      x: Math.max(0, Math.min(1, (x - pad) / (easeCanvasW - pad * 2))),
      y: Math.max(0, Math.min(1, (easeCanvasH - pad - y) / (easeCanvasH - pad * 2)))
    };
  }
  function drawEaseEditor() {
    if (easeOverlay.hidden) return;
    if (easeEditorMode === 'elastic1' || easeEditorMode === 'elastic2') {
      drawElasticEditor();
      return;
    }
    
    // 下面全是原版贝塞尔的绘图代码，不需要动
    const W = easeCanvasW, H = easeCanvasH, pad = 22;
    easeCtx.clearRect(0, 0, W, H);
    easeCtx.fillStyle = '#f8fafc';
    easeCtx.fillRect(0, 0, W, H);
    easeCtx.strokeStyle = '#e8eef6';
    easeCtx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = pad + (W - pad * 2) * i / 4;
      const gy = pad + (H - pad * 2) * i / 4;
      easeCtx.beginPath(); easeCtx.moveTo(gx, pad); easeCtx.lineTo(gx, H - pad); easeCtx.stroke();
      easeCtx.beginPath(); easeCtx.moveTo(pad, gy); easeCtx.lineTo(W - pad, gy); easeCtx.stroke();
    }
    easeCtx.strokeStyle = '#cfdae8';
    easeCtx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);
    easeCtx.save();
    easeCtx.setLineDash([4, 4]);
    easeCtx.strokeStyle = '#cbd5e1';
    easeCtx.beginPath();
    easeCtx.moveTo(pad, H - pad);
    easeCtx.lineTo(W - pad, pad);
    easeCtx.stroke();
    easeCtx.restore();

    const p1 = easeToCanvas({ x: easeDraft[0], y: easeDraft[1] });
    const p2 = easeToCanvas({ x: easeDraft[2], y: easeDraft[3] });

    easeCtx.strokeStyle = '#b9cbe6';
    easeCtx.lineWidth = 1.5;
    easeCtx.beginPath(); easeCtx.moveTo(pad, H - pad); easeCtx.lineTo(p1.x, p1.y); easeCtx.stroke();
    easeCtx.beginPath(); easeCtx.moveTo(W - pad, pad); easeCtx.lineTo(p2.x, p2.y); easeCtx.stroke();

    easeCtx.strokeStyle = '#4a90ff';
    easeCtx.lineWidth = 2.5;
    easeCtx.lineCap = 'round';
    easeCtx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const u = i / 60;
      const cp = easeToCanvas({ x: bezierAxis(u, easeDraft[0], easeDraft[2]), y: bezierAxis(u, easeDraft[1], easeDraft[3]) });
      if (i === 0) easeCtx.moveTo(cp.x, cp.y); else easeCtx.lineTo(cp.x, cp.y);
    }
    easeCtx.stroke();

    easeCtx.fillStyle = '#94a3b8';
    [[pad, H - pad], [W - pad, pad]].forEach(([x, y]) => {
      easeCtx.beginPath(); easeCtx.arc(x, y, 3, 0, Math.PI * 2); easeCtx.fill();
    });

    [p1, p2].forEach((p, i) => {
      easeCtx.fillStyle = '#fff';
      easeCtx.strokeStyle = '#4a90ff';
      easeCtx.lineWidth = 2.5;
      easeCtx.beginPath(); easeCtx.arc(p.x, p.y, 7, 0, Math.PI * 2); easeCtx.fill(); easeCtx.stroke();
      easeCtx.fillStyle = '#4a90ff';
      easeCtx.font = 'bold 9px system-ui, sans-serif';
      easeCtx.textAlign = 'center';
      easeCtx.textBaseline = 'middle';
      easeCtx.fillText(String(i + 1), p.x, p.y + 0.5);
    });

    easeValueEl.textContent = 'cubic-bezier(' + easeDraft.map(v => v.toFixed(2)).join(', ') + ')';
  }

  function drawElasticEditor() {
    const W = easeCanvasW, H = easeCanvasH, pad = 22;
    let p1x, p1y, p2x, p2y;
    
    let drawH = (H - pad * 2);
    if (easeEditorMode === 'elastic1') drawH *= 0.6; // 阻尼振荡留出余量防超框
    const drawY = (H - drawH) / 2;
    
    if (easeEditorMode === 'elastic1') {
      p1x = pad + 0.5 * (W - pad * 2);
      p1y = (H - drawY) - ((elastic1Params.damping - 0.1) / 0.9) * drawH;
      p2x = pad + (elastic1Params.period - 0.1) / 0.9 * (W - pad * 2);
      p2y = H - drawY;
    } else {
      p1x = pad + 0.5 * (W - pad * 2) + (elastic2Params.skew / 0.4) * (W - pad * 2) * 0.5;
      p1y = pad + 30;
      p2x = pad + (elastic2Params.period - 0.1) / 0.9 * (W - pad * 2);
      p2y = H - drawY;
    }

    easeCtx.clearRect(0, 0, W, H);
    easeCtx.fillStyle = '#f8fafc';
    easeCtx.fillRect(0, 0, W, H);
    easeCtx.strokeStyle = '#e8eef6';
    easeCtx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = pad + (W - pad * 2) * i / 4;
      const gy = pad + (H - pad * 2) * i / 4;
      easeCtx.beginPath(); easeCtx.moveTo(gx, pad); easeCtx.lineTo(gx, H - pad); easeCtx.stroke();
      easeCtx.beginPath(); easeCtx.moveTo(pad, gy); easeCtx.lineTo(W - pad, gy); easeCtx.stroke();
    }
    easeCtx.strokeStyle = '#cfdae8';
    easeCtx.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

    easeCtx.strokeStyle = '#4a90ff';
    easeCtx.lineWidth = 2.5;
    easeCtx.lineCap = 'round';
    easeCtx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const u = i / 120;
      const y = easeEditorMode === 'elastic1' 
        ? easeElastic1(u, elastic1Params.damping, elastic1Params.period) 
        : easeElastic2(u, elastic2Params.period, elastic2Params.skew);
      const cx = pad + u * (W - pad * 2);
      const cy = (H - drawY) - y * drawH;
      if (i === 0) easeCtx.moveTo(cx, cy); else easeCtx.lineTo(cx, cy);
    }
    easeCtx.stroke();

    easeCtx.strokeStyle = '#b9cbe6';
    easeCtx.lineWidth = 1.5;
    easeCtx.beginPath(); easeCtx.moveTo(pad, H - drawY); easeCtx.lineTo(p1x, p1y); easeCtx.stroke();
    easeCtx.beginPath(); easeCtx.moveTo(p1x, p1y); easeCtx.lineTo(p2x, p2y); easeCtx.stroke();

    [ {x: p1x, y: p1y, label: '1'}, {x: p2x, y: p2y, label: '2'} ].forEach((p, i) => {
      easeCtx.fillStyle = '#fff';
      easeCtx.strokeStyle = '#4a90ff';
      easeCtx.lineWidth = 2.5;
      easeCtx.beginPath(); easeCtx.arc(p.x, p.y, 7, 0, Math.PI * 2); easeCtx.fill(); easeCtx.stroke();
      easeCtx.fillStyle = '#4a90ff';
      easeCtx.font = 'bold 9px system-ui, sans-serif';
      easeCtx.textAlign = 'center';
      easeCtx.textBaseline = 'middle';
      easeCtx.fillText(p.label, p.x, p.y + 0.5);
    });

    if (easeEditorMode === 'elastic1') {
      easeValueEl.textContent = tr2('ease.damping', '阻尼') + ': ' + elastic1Params.damping.toFixed(2) + ' | ' + tr2('ease.period', '周期') + ': ' + elastic1Params.period.toFixed(2);
    } else {
      easeValueEl.textContent = tr2('ease.period', '周期') + ': ' + elastic2Params.period.toFixed(2) + ' | ' + tr2('ease.skew', '偏斜') + ': ' + elastic2Params.skew.toFixed(2);
    }
  }

  function sizeEaseCanvas() {
    const rect = easeCanvas.getBoundingClientRect();
    easeCanvasW = Math.max(120, Math.round(rect.width));
    easeCanvasH = Math.max(120, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    easeCanvas.width = Math.round(easeCanvasW * dpr);
    easeCanvas.height = Math.round(easeCanvasH * dpr);
    easeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawEaseEditor();
  }
  let easeEditorMode = 'bezier';
  let easeEditorSelectedPresetId = null; // 记录当前是否选中了预设

  function openEaseEditor() {
    easeDraft = tweenCustomBezier.slice();
    document.getElementById('easeEditorTitle').textContent = tr2('ease.customTitle', '自定义曲线');
    document.getElementById('easeEditorHint').textContent = tr2('ease.customHint', '拖动两个控制点调整曲线');
    
    // 恢复默认状态
    document.querySelector('.ease-preset-row').style.display = 'flex';
    document.querySelector('.ease-preset-row').nextElementSibling.style.display = 'block';
    document.querySelector('.ease-editor-actions > div:first-child').style.display = 'flex';

    if (tweenEaseKey && tweenEaseKey.startsWith('preset:')) {
      const id = tweenEaseKey.slice(7);
      const p = customEasePresets.find(x => x.id === id);
      if (p) {
        easeEditorMode = p.type || 'bezier';
        easeEditorSelectedPresetId = p.id;
        if (easeEditorMode === 'bezier' && p.bezier) easeDraft = [...p.bezier];
        if (easeEditorMode === 'elastic1' && p.params) { elastic1Params.damping = p.params.damping; elastic1Params.period = p.params.period; }
        if (easeEditorMode === 'elastic2' && p.params) { elastic2Params.period = p.params.period; elastic2Params.skew = p.params.skew; }
        easePresetNameInline.value = p.name;
      }
    } else {
      if (tweenEaseKey === 'elastic1') easeEditorMode = 'elastic1';
      else if (tweenEaseKey === 'elastic2') easeEditorMode = 'elastic2';
      else easeEditorMode = 'bezier';
      easeEditorSelectedPresetId = null;
      easePresetNameInline.value = '';
    }

    updateEaseTabs();
    easeDrag = -1;
    easeOverlay.hidden = false;
    requestAnimationFrame(() => { sizeEaseCanvas(); drawEaseEditor(); renderEasePresetListInline(); });
  }

  function updateEaseTabs() {
    document.querySelectorAll('.ease-tab-btn').forEach(btn => {
      const isActive = btn.dataset.mode === easeEditorMode;
      btn.classList.toggle('active', isActive);
      if (isActive) {
        btn.style.background = 'var(--color-primary)';
        btn.style.color = 'var(--color-primary-text)';
        btn.style.borderColor = 'transparent';
      } else {
        btn.style.background = 'var(--bg-panel)';
        btn.style.color = 'var(--text-main)';
        btn.style.borderColor = 'var(--border-color)';
      }
    });
    
    // 现在所有 Tab 都支持预设，不再隐藏预设框
    const hint = document.getElementById('easeEditorHint');
    if (easeEditorMode === 'elastic1') {
      hint.textContent = tr2('ease.hintElastic1', '拖动上方点调阻尼(衰减)，下方点调周期(快慢)');
    } else if (easeEditorMode === 'elastic2') {
      hint.textContent = tr2('ease.hintElastic2', '下方点控制周期，上方点左右拖动控制波形倾斜');
    } else {
      hint.textContent = tr2('ease.customHint', '拖动两个控制点调整曲线');
    }
  }

  // 绑定 Tab 切换事件
  document.querySelectorAll('.ease-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      easeEditorMode = btn.dataset.mode;
      easeEditorSelectedPresetId = null;
      renderEasePresetListInline();
      updateEaseTabs();
      drawEaseEditor();
    });
  });
  function closeEaseEditor() {
    easeOverlay.hidden = true;
    easeDrag = -1;
  }
  function easePointerPos(e) {
    const r = easeCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * easeCanvasW, y: (e.clientY - r.top) / r.height * easeCanvasH };
  }
  easeCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const pos = easePointerPos(e);

    easeEditorSelectedPresetId = null;
    renderEasePresetListInline();
    
    if (easeEditorMode === 'elastic1' || easeEditorMode === 'elastic2') {
      const W = easeCanvasW, H = easeCanvasH, pad = 22;
      let p1x, p1y, p2x, p2y;
      let drawH = (H - pad * 2);
      if (easeEditorMode === 'elastic1') drawH *= 0.6;
      const drawY = (H - drawH) / 2;

      if (easeEditorMode === 'elastic1') {
        p1x = pad + 0.5 * (W - pad * 2); 
        p1y = (H - drawY) - ((elastic1Params.damping - 0.1) / 0.9) * drawH;
        p2x = pad + (elastic1Params.period - 0.1) / 0.9 * (W - pad * 2); 
        p2y = H - drawY;
      } else {
        p1x = pad + 0.5 * (W - pad * 2) + (elastic2Params.skew / 0.4) * (W - pad * 2) * 0.5; 
        p1y = pad + 30;
        p2x = pad + (elastic2Params.period - 0.1) / 0.9 * (W - pad * 2); 
        p2y = H - drawY;
      }
      
      const d1 = Math.hypot(pos.x - p1x, pos.y - p1y);
      const d2 = Math.hypot(pos.x - p2x, pos.y - p2y);
      if (Math.min(d1, d2) > 30) return;
      easeDrag = d1 <= d2 ? 0 : 1;
      easeCanvas.setPointerCapture(e.pointerId);
      return;
    }

    const p1 = easeToCanvas({ x: easeDraft[0], y: easeDraft[1] });
    const p2 = easeToCanvas({ x: easeDraft[2], y: easeDraft[3] });
    const d1 = Math.hypot(pos.x - p1.x, pos.y - p1.y);
    const d2 = Math.hypot(pos.x - p2.x, pos.y - p2.y);
    if (Math.min(d1, d2) > 26) return;
    easeDrag = d1 <= d2 ? 0 : 1;
    easeCanvas.setPointerCapture(e.pointerId);
  });

  easeCanvas.addEventListener('pointermove', (e) => {
    if (easeDrag < 0) return;
    const pos = easePointerPos(e);
    
    if (easeEditorMode === 'elastic1') {
      const pad = 22, W = easeCanvasW, H = easeCanvasH;
      let drawH = (H - pad * 2) * 0.6;
      let drawY = (H - drawH) / 2;
      
      if (easeDrag === 0) {
        let y = Math.max(drawY, Math.min(H - drawY, pos.y));
        let val = 0.1 + ((H - drawY) - y) / drawH * 0.9;
        elastic1Params.damping = Math.max(0.1, Math.min(1.0, val));
      } else {
        let x = Math.max(pad, Math.min(W - pad, pos.x));
        let val = 0.1 + (x - pad) / (W - pad * 2) * 0.9;
        elastic1Params.period = Math.max(0.1, Math.min(1.0, val));
      }
      drawEaseEditor();
      return;
    }

    if (easeEditorMode === 'elastic2') {
      const pad = 22, W = easeCanvasW, H = easeCanvasH;
      if (easeDrag === 0) {
        let centerX = pad + 0.5 * (W - pad * 2);
        let val = ((pos.x - centerX) / ((W - pad * 2) * 0.5)) * 0.4;
        elastic2Params.skew = Math.max(-0.4, Math.min(0.4, val));
      } else {
        let x = Math.max(pad, Math.min(W - pad, pos.x));
        let val = 0.1 + (x - pad) / (W - pad * 2) * 0.9;
        elastic2Params.period = Math.max(0.1, Math.min(1.0, val));
      }
      drawEaseEditor();
      return;
    }

    const p = easeFromCanvas(pos.x, pos.y);
    easeDraft[easeDrag * 2] = p.x;
    easeDraft[easeDrag * 2 + 1] = p.y;
    drawEaseEditor();
  });
  function endEaseDrag(e) {
    if (easeDrag < 0) return;
    easeDrag = -1;
    if (easeCanvas.hasPointerCapture && easeCanvas.hasPointerCapture(e.pointerId)) easeCanvas.releasePointerCapture(e.pointerId);
  }
  easeCanvas.addEventListener('pointerup', endEaseDrag);
  easeCanvas.addEventListener('pointercancel', endEaseDrag);

  document.getElementById('btnEaseApply').addEventListener('click', () => {
    if (easeEditorSelectedPresetId) {
      tweenEaseKey = 'preset:' + easeEditorSelectedPresetId;
    } else {
      if (easeEditorMode === 'bezier') {
        tweenCustomBezier = easeDraft.slice();
        tweenEaseKey = 'custom';
      } else {
        tweenEaseKey = easeEditorMode;
      }
    }
    /* v7.0.1：自定义曲线也要落到段上，否则只改全局默认值 → 哪一段都不会变 */
    if (!applyEaseToCurrentSegments(tweenEaseKey)) {
      showHistoryToast('曲线只作用于相邻两个关键帧之间的段 —— 当前帧不在任何段内', 'redo', 2800);
    }
    updateTweenEaseLabel();
    closeEaseEditor();
  });
  document.getElementById('btnEaseReset').addEventListener('click', () => {
    easeDraft = TWEEN_EASE_PRESETS.easeInOut.bezier.slice();
    drawEaseEditor();
  });
  document.getElementById('btnEaseCancel').addEventListener('click', closeEaseEditor);
  document.getElementById('btnEaseEditorClose').addEventListener('click', closeEaseEditor);
  easeOverlay.addEventListener('pointerdown', (e) => { if (e.target === easeOverlay) closeEaseEditor(); });
  window.addEventListener('resize', () => { if (!easeOverlay.hidden) sizeEaseCanvas(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!easeOverlay.hidden) { e.preventDefault(); closeEaseEditor(); }
    else if (!tweenMoreMenu.hidden) setEaseMenuOpen(false);
    else if (!advPanel.hidden) setAdvPanelOpen(false);
  });

  updateTweenEaseLabel();

  /* ==================== 分部缓动（位置/缩放/旋转/关节） ==================== */
  const jointEaseOverlay = document.getElementById('jointEaseOverlay');
  const jointEaseList = document.getElementById('jointEaseList');
  const btnJointEase = document.getElementById('btnJointEase');
  let tweenJointEases = {};

  const JOINT_LABELS = {
    x: '位置 X', y: '位置 Y', scale: '缩放', rot: '旋转',
    width: '宽度', height: '高度',
    torso: '躯干', waist: '腰部', headAngle: '头部',
    armL_u: '左大臂', armL_f: '左小臂', armR_u: '右大臂', armR_f: '右小臂',
    legL_u: '左大腿', legL_f: '左小腿', legR_u: '右大腿', legR_f: '右小腿',
    ext_armL: '左手腕', ext_armR: '右手腕', ext_legL: '左脚踝', ext_legR: '右脚踝'
  };

  function populateEaseSelect(select, currentKey) {
    let html = '<option value="">' + tr2('ease.followGlobal', '跟随全局') + '</option>';
    ['linear', 'easeIn', 'easeOut', 'easeInOut'].forEach(key => {
      html += '<option value="' + key + '">' + TWEEN_EASE_PRESETS[key].label + '</option>';
    });
    html += '<option value="custom">' + tr2('ease.customName', '自定义') + '</option>';
    customEasePresets.forEach(p => {
      html += '<option value="preset:' + p.id + '">' + p.name + '</option>';
    });
    select.innerHTML = html;
    if (currentKey && Array.from(select.options).some(o => o.value === currentKey)) select.value = currentKey;
    else select.value = '';
  }

  function getJointChanges() {
    if (AppState.frames.length < 2 || AppState.currentFrameIndex >= AppState.frames.length - 1) return [];
    const easeTrackId = isSubTrackMode() ? AppState.activeTrackId : null;
    const f1Objs = getObjectsForFrameAt(AppState.currentFrameIndex, easeTrackId);
    const f2Objs = getObjectsForFrameAt(AppState.currentFrameIndex + 1, easeTrackId);
    const changes = [];
    const add = (o, joint, v1, v2, angle) => {
      const eps = angle ? 0.005 : 0.5;
      if (Math.abs(v1 - v2) > eps) {
        changes.push({ figId: o.id, figName: o.name, joint, key: o.id + ':' + joint });
      }
    };
    f1Objs.filter(o => o.type === 'figure').forEach(o1 => {
      const o2 = f2Objs.find(o => o.id === o1.id && o.type === 'figure');
      if (!o2) return;
      add(o1, 'x', o1.x, o2.x);
      add(o1, 'y', o1.y, o2.y);
      add(o1, 'scale', o1.scale || 1, o2.scale || 1);
      add(o1, 'rot', o1.rot || 0, o2.rot || 0, true);
      add(o1, 'torso', o1.a.torso, o2.a.torso, true);
      add(o1, 'waist', o1.a.waist || 0, o2.a.waist || 0, true);
      add(o1, 'headAngle', o1.headAngle, o2.headAngle, true);
      add(o1, 'armL_u', o1.a.armL.u, o2.a.armL.u, true);
      add(o1, 'armL_f', o1.a.armL.f, o2.a.armL.f, true);
      add(o1, 'armR_u', o1.a.armR.u, o2.a.armR.u, true);
      add(o1, 'armR_f', o1.a.armR.f, o2.a.armR.f, true);
      add(o1, 'legL_u', o1.a.legL.u, o2.a.legL.u, true);
      add(o1, 'legL_f', o1.a.legL.f, o2.a.legL.f, true);
      add(o1, 'legR_u', o1.a.legR.u, o2.a.legR.u, true);
      add(o1, 'legR_f', o1.a.legR.f, o2.a.legR.f, true);
      if (o1.extremity && o1.extremity.enabled && o2.extremity && o2.extremity.enabled) {
        add(o1, 'ext_armL', o1.extremity.armAngleL, o2.extremity.armAngleL, true);
        add(o1, 'ext_armR', o1.extremity.armAngleR, o2.extremity.armAngleR, true);
        add(o1, 'ext_legL', o1.extremity.legAngleL, o2.extremity.legAngleL, true);
        add(o1, 'ext_legR', o1.extremity.legAngleR, o2.extremity.legAngleR, true);
      }
    });
    /* 图片 / 配饰 / 图形 / 对话框 / 摄像机：位置、缩放、旋转、宽高也可分部缓动 */
    f1Objs.filter(o => o.type !== 'figure').forEach(o1 => {
      const o2 = f2Objs.find(o => o.id === o1.id);
      if (!o2) return;
      add(o1, 'x', o1.x, o2.x);
      add(o1, 'y', o1.y, o2.y);
      add(o1, 'scale', o1.scale || 1, o2.scale || 1);
      add(o1, 'rot', o1.rot || 0, o2.rot || 0, true);
      
      // 检测宽高变化 (包含图片、形状、摄像机)
      if (o1.w !== undefined && o2.w !== undefined) add(o1, 'width', o1.w, o2.w);
      if (o1.h !== undefined && o2.h !== undefined) add(o1, 'height', o1.h, o2.h);
      
      // 对话框特殊处理自定义尺寸
      if (o1.type === 'bubble' && o1.customSize && o2.customSize) {
        if (o1.customW !== undefined && o2.customW !== undefined) add(o1, 'width', o1.customW, o2.customW);
        if (o1.customH !== undefined && o2.customH !== undefined) add(o1, 'height', o1.customH, o2.customH);
      }
    });
    return changes;
  }

  function openJointEasePanel() {
    const changes = getJointChanges();
    jointEaseList.innerHTML = '';
    if (!changes.length) {
      jointEaseList.innerHTML = tr2('jointEase.empty', '<div class="empty-state">当前两帧之间没有检测到分部变化。<br>请先制作两个不同姿势/位置的关键帧。</div>');
    } else {
      changes.forEach(ch => {
        const row = document.createElement('div');
        row.className = 'joint-ease-row';
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = ch.figName + ' · ' + (JOINT_LABELS[ch.joint] || ch.joint);
        const select = document.createElement('select');
        populateEaseSelect(select, tweenJointEases[ch.key] || '');
        select.addEventListener('change', () => {
          if (select.value) tweenJointEases[ch.key] = select.value;
          else delete tweenJointEases[ch.key];
          /* v7.0.0：分部缓动的作用域是 (轨道, 段)，写进段起始关键帧的 __k.c.ch */
          const cut = String(ch.key).indexOf(':');
          if (cut > 0) pushChannelEaseToSegments(ch.key.slice(0, cut), ch.key.slice(cut + 1), select.value || null);
        });
        row.appendChild(label);
        row.appendChild(select);
        jointEaseList.appendChild(row);
      });
    }
    jointEaseOverlay.hidden = false;
  }
  function closeJointEasePanel() { jointEaseOverlay.hidden = true; }

  /* 把某一个分部（x / rot / torso / armL_u …）的缓动写进当前段。
     idxs 规则同 D4：选中段内任意帧即定位整段。 */
  function pushChannelEaseToSegments(objId, part, easeKey) {
    const id = String(objId);
    const t = AppState.tracks[id];
    if (!t || !t.frames) return 0;
    const idxs = (multiSelectMode && multiSelectedFrames.size)
      ? Array.from(multiSelectedFrames)
      : [AppState.currentFrameIndex];
    const seen = new Set();
    const touched = [];
    for (const i of idxs) {
      const seg = segmentAhead(t.frames, i);
      if (!seg || seen.has(seg.a)) continue;
      seen.add(seg.a);
      const cur = KF.curveOf(t.frames[seg.a]) || {};
      const ch = Object.assign({}, cur.ch || {});
      if (easeKey) ch[part] = easeKey; else delete ch[part];
      KF.setCurve(t.frames[seg.a], {
        ease: cur.ease || null,   /* 没设过段曲线就留空 → 匀速，别把全局默认值带进来 */
        ch: Object.keys(ch).length ? ch : null
      });
      touched.push(seg.a);
    }
    if (touched.length) {
      bumpKfEval();
      invalidateAllFrameThumbs();
      updateFrameBar();
      EventBus.emit('need:render');
      EventBus.emit('history:save', '改分部缓动', 900);
    }
    return touched.length;
  }
  btnJointEase.addEventListener('click', () => { setEaseMenuOpen(false); openJointEasePanel(); });
  document.getElementById('btnJointEaseClose').addEventListener('click', closeJointEasePanel);
  document.getElementById('btnJointEaseApply').addEventListener('click', closeJointEasePanel);
  document.getElementById('btnJointEaseReset').addEventListener('click', () => {
    tweenJointEases = {};
    jointEaseList.querySelectorAll('select').forEach(sel => sel.value = '');
  });
  jointEaseOverlay.addEventListener('pointerdown', (e) => { if (e.target === jointEaseOverlay) closeJointEasePanel(); });

  /* ==================== 多选：按钮状态 ==================== */
  function updateMultiActions() {
    const el = document.getElementById('multiActions');
    if (el) el.style.display = multiSelectMode ? 'inline-flex' : 'none';
    const has = multiSelectedFrames.size > 0;
    const cnt = document.getElementById('multiCount');
    if (cnt) cnt.textContent = has ? multiSelectedFrames.size + tr2('timeline.frameSuffix', ' 帧') : '';
    
    const btnT = document.getElementById('btnMultiTween');
    if (btnT) btnT.disabled = multiSelectedFrames.size < 2;

    // ==== 联动修改其他面板的按钮文字 ====
    const isMulti = multiSelectMode;
    
    // 1. 动画面板的删除帧
    const delBtn = document.getElementById('btnDelFrame');
    if (delBtn) {
      delBtn.innerHTML = ic('delete') + (isMulti ? tr2('timeline.delFrames', '删除多选帧') : tr2('timeline.delFrame', '删除帧'));
      delBtn.title = isMulti ? tr2('timeline.delFramesTitle', '删除所有勾选的帧') : tr2('timeline.delFrameTitle', '删除当前帧');
    }

    // 2. 控制面板的导出 PNG / JPG
    const pngBtn = document.getElementById('btnExportPNG');
    if (pngBtn) pngBtn.textContent = isMulti ? tr2('export.multiPng', '导出多选帧PNG') : tr2('export.png', '导出PNG');
    const jpgBtn = document.getElementById('btnExportJPG');
    if (jpgBtn) jpgBtn.textContent = isMulti ? tr2('export.multiJpg', '导出多选帧JPG') : tr2('export.jpg', '导出JPG');

    // 3. 高级设置的 GIF / PNG序列
    const gifBtn = document.getElementById('btnExportGIF');
    if (gifBtn) gifBtn.textContent = isMulti ? tr2('export.multiGif', '导出多选帧GIF') : tr2('export.gif', '导出 GIF');
    const seqBtn = document.getElementById('btnExportPNGSeq');
    if (seqBtn) seqBtn.textContent = isMulti ? tr2('export.multiPngSeq', '导出多选帧PNG序列') : tr2('export.pngSeq', '导出 PNG序列');

    // 4. 全局属性修改标签
    const geBtn = document.querySelector('.adv-toggle[data-toggle="globalEdit"]');
    if (geBtn) geBtn.textContent = isMulti ? tr2('prop.multiGlobalEdit', '多选帧全局属性修改') : tr2('prop.globalEdit', '全局属性修改');
    const geHelp = document.getElementById('globalEditHelpBtn');
    if (geHelp) geHelp.style.display = isMulti ? 'none' : 'inline'; // 多选模式下隐藏原说明
  }

  /* ==================== 补间帧生成 ==================== */
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }
  /* v7.2.1：角度制（0-360）最短弧插值 —— 侧面高光的「高光方向」滑条用的是角度，
     350° → 10° 应该走 20° 的小弧，而不是反向绕 340°。 */
  function lerpAngleDeg(a, b, t) {
    let diff = b - a;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return a + diff * t;
  }

  function buildTweenFrames(f1, f2, count, trackId, i1, i2) {
    const targetTrackId = (trackId != null && trackId !== TRACK_ALL_ID) ? String(trackId) : null;
    const idx1 = (i1 != null) ? i1 : (typeof f1 === 'number' ? f1 : AppState.frames.indexOf(f1));
    const idx2 = (i2 != null) ? i2 : (typeof f2 === 'number' ? f2 : AppState.frames.indexOf(f2));
    const sf1 = AppState.frames[idx1] || AppState.frames[AppState.currentFrameIndex] || {};
    const sf2 = AppState.frames[idx2] || AppState.frames[AppState.currentFrameIndex] || {};
    const objList1 = getObjectsForFrameAt(idx1 >= 0 ? idx1 : AppState.currentFrameIndex, targetTrackId);
    const objList2 = getObjectsForFrameAt(idx2 >= 0 ? idx2 : AppState.currentFrameIndex, targetTrackId);
    const dur1 = sf1.duration || Math.round(1000 / defaultFPS);
    const dur2 = sf2.duration || Math.round(1000 / defaultFPS);
    const cloneTweenObject = (src) => {
      const cp = JSON.parse(JSON.stringify(src, (k, v) => k === 'img' ? undefined : v));
      if (src.img) cp.img = src.img;
      return cp;
    };
    const newFrames = [];
    for (let i = 1; i <= count; i++) {
      const u = i / (count + 1);
      const tt = tweenEaseProgress(u);
      const frameObjects = [];
      const partProgress = (objId, part, fallback) => {
        const key = objId + ':' + part;
        const ek = tweenJointEases[key];
        if (!ek) return fallback;
        return getEaseFunction(ek)(u);
      };
      objList1.forEach(o1 => {
        const o2 = objList2.find(o => o.id === o1.id);
        if (!o2) {
          frameObjects.push(cloneTweenObject(o1));
          return;
        }
        if (targetTrackId !== null && String(o1.id) !== targetTrackId) {
          frameObjects.push(cloneTweenObject(o1));
          return;
        }
        const obj = JSON.parse(JSON.stringify(o1, (k, v) => k === 'img' ? undefined : v));
        if (o1.img) obj.img = o1.img;
        if (obj.ax === undefined) obj.ax = 0;
        if (obj.ay === undefined) obj.ay = 0;

        if (obj.type === 'figure') {
          obj.x = lerp(o1.x, o2.x, partProgress(o1.id, 'x', tt));
          obj.y = lerp(o1.y, o2.y, partProgress(o1.id, 'y', tt));
          obj.scale = lerp(o1.scale || 1, o2.scale || 1, partProgress(o1.id, 'scale', tt));
          obj.alpha = lerp(o1.alpha || 1, o2.alpha || 1, tt);
          obj.rot = lerp(o1.rot || 0, o2.rot || 0, partProgress(o1.id, 'rot', tt));
          obj.ikEnabled = tt < 0.5 ? o1.ikEnabled : o2.ikEnabled;
          if (o1.bodyScale && o2.bodyScale) {
            obj.bodyScale = {};
            Object.keys(o1.bodyScale).forEach(k => {
              obj.bodyScale[k] = lerp(o1.bodyScale[k], o2.bodyScale[k] !== undefined ? o2.bodyScale[k] : o1.bodyScale[k], tt);
            });
          }
          if (o1.color && o2.color) obj.color = lerpColor(o1.color, o2.color, tt);
          if (o1.light && o1.light.color && o2.light && o2.light.color) obj.light.color = lerpColor(o1.light.color, o2.light.color, tt);
          if (o1.glow && o1.glow.color && o2.glow && o2.glow.color) obj.glow.color = lerpColor(o1.glow.color, o2.glow.color, tt);
          if (o1.glow && o2.glow) {
            const g = obj.glow = obj.glow || {};
            g.blur = (o1.glow.blur || 0) + ((o2.glow.blur || 0) - (o1.glow.blur || 0)) * tt;
            g.spread = (o1.glow.spread || 0) + ((o2.glow.spread || 0) - (o1.glow.spread || 0)) * tt;
            g.offsetX = (o1.glow.offsetX || 0) + ((o2.glow.offsetX || 0) - (o1.glow.offsetX || 0)) * tt;
            g.offsetY = (o1.glow.offsetY || 0) + ((o2.glow.offsetY || 0) - (o1.glow.offsetY || 0)) * tt;
            g.alpha = (o1.glow.alpha == null ? 1 : o1.glow.alpha) + ((o2.glow.alpha == null ? 1 : o2.glow.alpha) - (o1.glow.alpha == null ? 1 : o1.glow.alpha)) * tt;
            g.enabled = !!o1.glow.enabled;
            g.includeAcc = !!o1.glow.includeAcc;   /* v7.2.1：离散量，取起点 */
            g.color = obj.glow.color || o1.glow.color || '#000000';
          }
          if (o1.joint && o1.joint.color && o2.joint && o2.joint.color) obj.joint.color = lerpColor(o1.joint.color, o2.joint.color, tt);
          /* v7.2.1：侧面高光的粗细 / 方向、手部渐变的起始位置，以前补间是硬跳的 */
          if (o1.light && o2.light) {
            const l = obj.light = obj.light || {};
            l.enabled = !!o1.light.enabled;
            const s1 = o1.light.size == null ? 1 : o1.light.size;
            const s2 = o2.light.size == null ? 1 : o2.light.size;
            l.size = s1 + (s2 - s1) * tt;
            const a1 = o1.light.angle == null ? 0 : o1.light.angle;
            const a2 = o2.light.angle == null ? 0 : o2.light.angle;
            l.angle = lerpAngleDeg(a1, a2, tt);
          }
          if (o1.joint && o2.joint) {
            const jj = obj.joint = obj.joint || {};
            jj.enabled = !!o1.joint.enabled;
            const n1 = o1.joint.len == null ? 0.5 : o1.joint.len;
            const n2 = o2.joint.len == null ? 0.5 : o2.joint.len;
            jj.len = n1 + (n2 - n1) * tt;
          }
          /* v7.2.1：地面阴影（每个火柴人独立）也参与补间 */
          if (o1.shadowEnabled !== undefined || o2.shadowEnabled !== undefined) {
            obj.shadowEnabled = !!o1.shadowEnabled;
            obj.shadowColor = lerpColor(o1.shadowColor || '#000000', o2.shadowColor || o1.shadowColor || '#000000', tt);
            const al1 = o1.shadowAlpha == null ? 0.3 : o1.shadowAlpha;
            const al2 = o2.shadowAlpha == null ? 0.3 : o2.shadowAlpha;
            obj.shadowAlpha = al1 + (al2 - al1) * tt;
            const sx1 = o1.shadowScaleX == null ? 1 : o1.shadowScaleX;
            const sx2 = o2.shadowScaleX == null ? 1 : o2.shadowScaleX;
            obj.shadowScaleX = sx1 + (sx2 - sx1) * tt;
            const sy1 = o1.shadowScaleY == null ? 1 : o1.shadowScaleY;
            const sy2 = o2.shadowScaleY == null ? 1 : o2.shadowScaleY;
            obj.shadowScaleY = sy1 + (sy2 - sy1) * tt;
            obj.shadowOffX = (o1.shadowOffX || 0) + ((o2.shadowOffX || 0) - (o1.shadowOffX || 0)) * tt;
            obj.shadowOffY = (o1.shadowOffY || 0) + ((o2.shadowOffY || 0) - (o1.shadowOffY || 0)) * tt;
          }
          if (o1.depth && o2.depth) {
            if (!obj.depth) obj.depth = {};
            obj.depth.enabled = tt < 0.5 ? o1.depth.enabled : o2.depth.enabled;
            obj.depth.useCustom = tt < 0.5 ? o1.depth.useCustom : o2.depth.useCustom;
            if (o1.depth.customColor && o2.depth.customColor) obj.depth.customColor = lerpColor(o1.depth.customColor, o2.depth.customColor, tt);
          }
          obj.headAngle = lerpAngle(o1.headAngle, o2.headAngle, partProgress(o1.id, 'headAngle', tt));
          obj.a.torso = lerpAngle(o1.a.torso, o2.a.torso, partProgress(o1.id, 'torso', tt));
          obj.a.waist = lerpAngle(o1.a.waist || 0, o2.a.waist || 0, partProgress(o1.id, 'waist', tt));
          obj.a.armL.u = lerpAngle(o1.a.armL.u, o2.a.armL.u, partProgress(o1.id, 'armL_u', tt));
          obj.a.armL.f = lerpAngle(o1.a.armL.f, o2.a.armL.f, partProgress(o1.id, 'armL_f', tt));
          obj.a.armR.u = lerpAngle(o1.a.armR.u, o2.a.armR.u, partProgress(o1.id, 'armR_u', tt));
          obj.a.armR.f = lerpAngle(o1.a.armR.f, o2.a.armR.f, partProgress(o1.id, 'armR_f', tt));
          obj.a.legL.u = lerpAngle(o1.a.legL.u, o2.a.legL.u, partProgress(o1.id, 'legL_u', tt));
          obj.a.legL.f = lerpAngle(o1.a.legL.f, o2.a.legL.f, partProgress(o1.id, 'legL_f', tt));
          obj.a.legR.u = lerpAngle(o1.a.legR.u, o2.a.legR.u, partProgress(o1.id, 'legR_u', tt));
          obj.a.legR.f = lerpAngle(o1.a.legR.f, o2.a.legR.f, partProgress(o1.id, 'legR_f', tt));
          if (o1.extremity && o1.extremity.enabled && o2.extremity && o2.extremity.enabled) {
            obj.extremity.armAngleL = lerpAngle(o1.extremity.armAngleL, o2.extremity.armAngleL, partProgress(o1.id, 'ext_armL', tt));
            obj.extremity.armAngleR = lerpAngle(o1.extremity.armAngleR, o2.extremity.armAngleR, partProgress(o1.id, 'ext_armR', tt));
            obj.extremity.legAngleL = lerpAngle(o1.extremity.legAngleL, o2.extremity.legAngleL, partProgress(o1.id, 'ext_legL', tt));
            obj.extremity.legAngleR = lerpAngle(o1.extremity.legAngleR, o2.extremity.legAngleR, partProgress(o1.id, 'ext_legR', tt));
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
          enforcePins(obj);
        } else if (obj.type === 'image') {
          obj.x = lerp(o1.x, o2.x, partProgress(o1.id, 'x', tt));
          obj.y = lerp(o1.y, o2.y, partProgress(o1.id, 'y', tt));
          obj.scale = lerp(o1.scale || 1, o2.scale || 1, partProgress(o1.id, 'scale', tt));
          obj.alpha = lerp(o1.alpha || 1, o2.alpha || 1, tt);
          obj.rot = lerp(o1.rot || 0, o2.rot || 0, partProgress(o1.id, 'rot', tt));
          obj.ax = lerp(o1.ax || 0, o2.ax || 0, tt);
          obj.ay = lerp(o1.ay || 0, o2.ay || 0, tt);
          if (o1.w !== undefined && o2.w !== undefined) obj.w = lerp(o1.w, o2.w, partProgress(o1.id, 'width', tt));
          if (o1.h !== undefined && o2.h !== undefined) obj.h = lerp(o1.h, o2.h, partProgress(o1.id, 'height', tt));
        } else if (obj.type === 'shape' || obj.type === 'bubble') {
          obj.x = lerp(o1.x, o2.x, partProgress(o1.id, 'x', tt));
          obj.y = lerp(o1.y, o2.y, partProgress(o1.id, 'y', tt));
          obj.scale = lerp(o1.scale || 1, o2.scale || 1, partProgress(o1.id, 'scale', tt));
          obj.alpha = lerp(o1.alpha || 1, o2.alpha || 1, tt);
          obj.rot = lerp(o1.rot || 0, o2.rot || 0, partProgress(o1.id, 'rot', tt));
          obj.offX = lerp(o1.offX || 0, o2.offX || 0, tt);
          obj.offY = lerp(o1.offY || 0, o2.offY || 0, tt);
          obj.ax = lerp(o1.ax || 0, o2.ax || 0, tt);
          obj.ay = lerp(o1.ay || 0, o2.ay || 0, tt);
          
          obj.w = lerp(o1.w || 60, o2.w || 60, partProgress(o1.id, 'width', tt));
          obj.h = lerp(o1.h || 60, o2.h || 60, partProgress(o1.id, 'height', tt));
          
          if (obj.type === 'shape') {
            if (o1.fillColor && o2.fillColor) obj.fillColor = lerpColor(o1.fillColor, o2.fillColor, tt);
            if (o1.strokeColor && o2.strokeColor) obj.strokeColor = lerpColor(o1.strokeColor, o2.strokeColor, tt);
          }
          if (obj.type === 'bubble') {
            if (o1.customW !== undefined && o2.customW !== undefined) obj.customW = lerp(o1.customW, o2.customW, partProgress(o1.id, 'width', tt));
            if (o1.customH !== undefined && o2.customH !== undefined) obj.customH = lerp(o1.customH, o2.customH, partProgress(o1.id, 'height', tt));
            obj.fontSize = lerp(o1.fontSize, o2.fontSize, tt);
            if (o1.textColor && o2.textColor) obj.textColor = lerpColor(o1.textColor, o2.textColor, tt);
            if (o1.gradientColor && o2.gradientColor) obj.gradientColor = lerpColor(o1.gradientColor, o2.gradientColor, tt);
            if (o1.fillColor && o2.fillColor) obj.fillColor = lerpColor(o1.fillColor, o2.fillColor, tt);
            if (o1.strokeColor && o2.strokeColor) obj.strokeColor = lerpColor(o1.strokeColor, o2.strokeColor, tt);
          }
        } else if (obj.type === 'acc') {
          obj.x = lerp(o1.x, o2.x, partProgress(o1.id, 'x', tt));
          obj.y = lerp(o1.y, o2.y, partProgress(o1.id, 'y', tt));
          obj.scale = lerp(o1.scale || 1, o2.scale || 1, partProgress(o1.id, 'scale', tt));
          obj.alpha = lerp(o1.alpha || 1, o2.alpha || 1, tt);
          obj.rot = lerp(o1.rot || 0, o2.rot || 0, partProgress(o1.id, 'rot', tt));
          obj.offX = lerp(o1.offX || 0, o2.offX || 0, tt);
          obj.offY = lerp(o1.offY || 0, o2.offY || 0, tt);
          obj.ax = lerp(o1.ax || 0, o2.ax || 0, tt);
          obj.ay = lerp(o1.ay || 0, o2.ay || 0, tt);
          if (o1.w !== undefined && o2.w !== undefined) obj.w = lerp(o1.w, o2.w, partProgress(o1.id, 'width', tt));
          if (o1.h !== undefined && o2.h !== undefined) obj.h = lerp(o1.h, o2.h, partProgress(o1.id, 'height', tt));
        } else if (obj.type === 'camera') {
          obj.x = lerp(o1.x, o2.x, partProgress(o1.id, 'x', tt));
          obj.y = lerp(o1.y, o2.y, partProgress(o1.id, 'y', tt));
          obj.scale = lerp(o1.scale || 1, o2.scale || 1, partProgress(o1.id, 'scale', tt));
          obj.rot = lerp(o1.rot || 0, o2.rot || 0, partProgress(o1.id, 'rot', tt));
          obj.alpha = lerp(o1.alpha || 1, o2.alpha || 1, tt);
          obj.w = lerp(o1.w || 640, o2.w || 640, partProgress(o1.id, 'width', tt));
          obj.h = lerp(o1.h || 360, o2.h || 360, partProgress(o1.id, 'height', tt));
        }
        frameObjects.push(obj);
      });
      objList2.forEach(o2 => {
        if (!objList1.find(o => o.id === o2.id)) {
          const obj = JSON.parse(JSON.stringify(o2, (k, v) => k === 'img' ? undefined : v));
          if (o2.img) obj.img = o2.img;
          frameObjects.push(obj);
        }
      });
      const dur = Math.round((dur1 + dur2) / 2);
      newFrames.push({ id: ++uid, duration: dur, objects: frameObjects, isTween: true });
    }
    return newFrames;
  }

  /* ==================== 多选：删除 / 补间 / 导出 ==================== */
  function deleteSelectedFrames() {
    if (!multiSelectMode || multiSelectedFrames.size === 0) return;
    if (isPlaying) pause();
    syncFrameRef();
    if (isSubTrackMode()) {
      const t = AppState.tracks[AppState.activeTrackId];
      if (!t) return;
      if (t.frames.length - multiSelectedFrames.size < 1) { alert(tr2('timeline.keepOne', '至少保留一帧')); return; }
      const indices = Array.from(multiSelectedFrames).sort((a, b) => b - a);
      indices.forEach(i => {
        if (i >= 0 && i < t.frames.length) {
          prepareHoldBeforeSplice(i, AppState.activeTrackId);
          t.frames.splice(i, 1);
        }
      });
      if (t.frames.length === 0) t.frames.push(null);
      multiSelectedFrames.clear();
      reconcileAllTracks();
      trimTrailingEmptyFrames();
      if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = AppState.frames.length - 1;
      if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
      invalidateAllFrameThumbs();
      AppState.objects = getCombinedObjectsForRender();
      AppState.selected = getActiveTrackObject();
      AppState.canvasSelected = false;
      updateFrameBar();
      EventBus.emit('need:render'); EventBus.emit('need:syncUI');
      EventBus.emit('history:save', '删除选中帧');
      return;
    }
    if (AppState.frames.length - multiSelectedFrames.size < 1) { alert(tr2('timeline.keepOne', '至少保留一帧')); return; }
    const indices = Array.from(multiSelectedFrames).sort((a, b) => b - a);
    indices.forEach(i => {
      if (i < 0 || i >= AppState.frames.length) return;
      prepareHoldBeforeSplice(i);
      AppState.frames.splice(i, 1);
      for (const id in AppState.tracks) {
        const t = AppState.tracks[id];
        if (t && t.frames && i < t.frames.length) t.frames.splice(i, 1);
      }
    });
    multiSelectedFrames.clear();
    reconcileAllTracks();
    trimTrailingEmptyFrames();
    if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = AppState.frames.length - 1;
    if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = null; AppState.canvasSelected = false;
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '删除选中帧');
  }

  function tweenSelectedFrames() {
    if (!multiSelectMode || multiSelectedFrames.size < 2) return;
    const count = parseInt(document.getElementById('tweenCount').value) || 5;
    if (count < 1 || count > 60) { alert(tr2('alert.tweenCount', '补间帧数需在 1-60 之间')); return; }
    if (isPlaying) pause();
    syncFrameRef();
    const subMode = isSubTrackMode();
    const indices = Array.from(multiSelectedFrames).sort((a, b) => a - b);
    let pairs = 0;
    for (let k = indices.length - 1; k >= 1; k--) {
      const i1 = indices[k - 1];
      const i2 = indices[k];
      if (i2 !== i1 + 1) continue;
      if (i1 < 0 || i2 >= AppState.frames.length) continue;
      if (subMode) {
        const t = AppState.tracks[AppState.activeTrackId];
        if (!t) continue;
        if (!getFrameTrackObject(null, i1) || !getFrameTrackObject(null, i2)) continue;
        const tweenFrames = buildTweenFrames(AppState.frames[i1], AppState.frames[i2], count, AppState.activeTrackId, i1, i2);
        const copies = tweenFrames.map(tw => {
          const src = tw && tw.objects ? (tw.objects.find(o => String(o.id) === String(AppState.activeTrackId)) || tw.objects[0] || null) : null;
          const c = src ? cloneObjectKeepImg(src) : null;
          if (c && src) c.id = src.id;
          return c;
        });
        t.frames.splice(i1 + 1, 0, ...copies);
        pairs++;
      } else {
        const tweenFrames = buildTweenFrames(AppState.frames[i1], AppState.frames[i2], count, null, i1, i2);
        let insertPos = i1 + 1;
        for (const nf of tweenFrames) {
          AppState.frames.splice(insertPos, 0, { id: nf.id, duration: nf.duration, isTween: true });
          for (const id in AppState.tracks) {
            const t = AppState.tracks[id];
            if (!t) continue;
            if (!t.frames) t.frames = [];
            while (t.frames.length < insertPos) t.frames.push(null);
            const src = nf.objects.find(o => String(o.id) === id) || null;
            t.frames.splice(insertPos, 0, src ? cloneObjectKeepImg(src) : null);
          }
          insertPos++;
        }
        pairs++;
      }
    }
    if (pairs === 0) {
      if (subMode) alert(tr2('alert.tweenNoPair', '所选相邻帧中，没有两端对该元件都非空白的帧对，无法补间。'));
      else alert(tr2('alert.tweenNeedAdjacent', '请选择相邻的帧（例如 1、2、3），才能在这些相邻帧之间补间。'));
      return;
    }
    syncMainLengthFromTracks();
    trimTrailingEmptyFrames(); /* v6.1.0：多选补间后同样清掉尾部空帧 */
    multiSelectedFrames.clear();
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    if (subMode) AppState.selected = getActiveTrackObject();
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '批量补间');
    alert(trv('alert.tweened', { n: pairs }, `已在 ${pairs} 对相邻帧之间生成补间帧。`));
  }

  /* ==================== 离屏渲染导出（已迁移至 js/features/export.js） ==================== */
  SKFE.features.export.init({
    AppState,
    EventBus,
    TRACK_ALL_ID,
    isSubTrackMode,
    syncFrameRef,
    renderFrameToDataURL,
    getExportSize,
    getCropForFrames,
    getExportCrop,
    cameraToCrop,
    getCurrentCameraObject,
    getCameraAtFrame,
    shouldSkipCameraForExport,
    getPageBgColor: () => pageBgColor,
    getDefaultFPS: () => defaultFPS,
    getCtx: () => ctx,
    setCtx: (c) => { ctx = c; },
    renderScene,
    getObjectsForFrameAt,
    invalidateAllFrameThumbs,
    updateFrameBar,
    // 播放状态（导出前需暂停）
    getIsPlaying: () => isPlaying,
    pause: () => pause(),
  });

  function exportSelectedPNGs() {
    if (!multiSelectMode || multiSelectedFrames.size === 0) return;
    if (isPlaying) pause();
    syncFrameRef();
    const _sz = getExportSize();
    const transparent = document.getElementById('gifTransparent').checked;
    const trackId = isSubTrackMode() ? AppState.activeTrackId : null;
    const indices = Array.from(multiSelectedFrames).sort((a, b) => a - b);
    const list = indices.map(i => AppState.frames[i]).filter(Boolean);
    if (!list.length) return;
    
    const cam = shouldSkipCameraForExport() ? null : (getCurrentCameraObject() || getCameraAtFrame(0));
    const crop = cam ? null : getCropForFrames(list, _sz.w, _sz.h, trackId);
    
    SKFE.features.export.exportPNGsAsZip(list, trackId, {
      outW: _sz.w,
      outH: _sz.h,
      crop,
      transparent
    });
  }

  function exportSelectedJPGs() {
    if (!multiSelectMode || multiSelectedFrames.size === 0) return;
    if (isPlaying) pause();
    syncFrameRef();
    const _sz = getExportSize();
    const trackId = isSubTrackMode() ? AppState.activeTrackId : null;
    const indices = Array.from(multiSelectedFrames).sort((a, b) => a - b);
    const list = indices.map(i => AppState.frames[i]).filter(Boolean);
    if (!list.length) return;

    const cam = shouldSkipCameraForExport() ? null : (getCurrentCameraObject() || getCameraAtFrame(0));
    const crop = cam ? null : getCropForFrames(list, _sz.w, _sz.h, trackId);

    // 逐个下载 JPG
    list.forEach((fr, index) => {
      const idx = AppState.frames.indexOf(fr);
      const safeIdx = idx >= 0 ? idx : 0;
      
      // 使用不透明背景（JPG没有透明通道）
      const off = renderFrameToDataURL(fr, _sz.w, _sz.h, { transparent: false, crop }, trackId);
      const dataUrl = off.toDataURL('image/jpeg', 0.92);
      
      // 用延迟防止浏览器将连续下载判定为恶意弹窗
      setTimeout(() => {
        SKFE.platform.save(dataUrl, `frame_${String(safeIdx + 1).padStart(3, '0')}.jpg`);
      }, index * 150);
    });
  }

  function exportSelectedGIF() {
    if (!multiSelectMode || multiSelectedFrames.size === 0) return;
    const indices = Array.from(multiSelectedFrames).sort((a, b) => a - b);
    const list = indices.map(i => AppState.frames[i]).filter(Boolean);
    if (!list.length) return;
    SKFE.features.export.exportGIF(list, isSubTrackMode() ? AppState.activeTrackId : null);
  }

  const btnMultiTween = document.getElementById('btnMultiTween');
  if (btnMultiTween) btnMultiTween.onclick = setKeyframesForSelected;

  /* v7.0.0（R3 / D8）：多选不再「逐对补间」，改为给选中的每一帧批量打关键帧。
     曲线是一次性作用于段的东西，不该跟「选中哪几帧」绑定。 */
  function setKeyframesForSelected() {
    if (!multiSelectMode || multiSelectedFrames.size === 0) return;
    if (isPlaying) pause();
    syncFrameRef();
    const idxs = Array.from(multiSelectedFrames).sort((a, b) => a - b);
    const sub = isSubTrackMode();
    let on = 0;
    for (const idx of idxs) {
      for (const id of currentScopeTrackIds()) {
        const t = AppState.tracks[id];
        if (!t) continue;
        if (!t.frames) t.frames = [];
        while (t.frames.length <= idx) t.frames.push(null);
        const slot = t.frames[idx];
        if (KF.isKey(slot)) continue;
        /* 派生帧要先把求值结果固化成快照，否则没有实体可当锚点 */
        const data = KF.isDerived(slot) ? getTrackFrame(id, idx) : slot;
        if (!KF.isReal(data)) continue;
        t.frames[idx] = data;
        KF.markKey(data, sub ? 'sub' : 'main');
        on++;
      }
    }
    reconcileAllTracks();
    AppState.objects = getCombinedObjectsForRender();
    if (sub) AppState.selected = getActiveTrackObject();
    multiSelectedFrames.clear();
    multiSelectMode = false;
    const tgl = document.getElementById('multiSelectToggle');
    if (tgl) tgl.checked = false;
    updateMultiActions();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '批量设关键帧');
    showHistoryToast('已给 ' + idxs.length + ' 帧打上关键帧（' + on + ' 个锚点）', undefined, 1700);
  }

  /* ==================== 多轨道空白帧辅助 ==================== */
  function findNextTrackFrameIndex(startIdx) {
    if (isSubTrackMode()) {
      const len = getTrackLength(AppState.activeTrackId);
      for (let i = startIdx + 1; i < Math.max(AppState.frames.length, len); i++) {
        if (getTrackFrame(AppState.activeTrackId, i)) return i;
      }
      return -1;
    }
    for (let i = startIdx + 1; i < AppState.frames.length; i++) {
      if (getTrackObjectsAt(i).length > 0) return i;
    }
    return -1;
  }

  function insertTweenFrames(startIdx, count) {
    if (!(startIdx >= 0) || startIdx >= AppState.frames.length) return { ok: false, reason: 'last' };
    if (isSubTrackMode()) {
      const t = AppState.tracks[AppState.activeTrackId];
      if (!t) return { ok: false, reason: 'no-current' };
      if (!getFrameTrackObject(null, startIdx)) return { ok: false, reason: 'no-current' };
      const f2Idx = findNextTrackFrameIndex(startIdx);
      if (f2Idx < 0) return { ok: false, reason: 'no-target' };
      const tweenFrames = buildTweenFrames(AppState.frames[startIdx], AppState.frames[f2Idx], count, AppState.activeTrackId, startIdx, f2Idx);
      const trackKey = String(AppState.activeTrackId);
      /* 连续空白段：从 startIdx+1 开始，遇到内容帧立即停止 */
      const slots = [];
      for (let i = startIdx + 1; i < f2Idx; i++) {
        if (getTrackFrame(AppState.activeTrackId, i)) break;
        slots.push(i);
      }
      /* v5.4.2：绑定配饰的补间数据必须在插帧之前算（插帧会改变 f2Idx 的含义） */
      const childTweens = buildBoundChildTweens(trackKey, startIdx, f2Idx, count);
      let used = 0;
      for (; used < tweenFrames.length && used < slots.length; used++) {
        const tw = tweenFrames[used];
        const src = tw && tw.objects ? (tw.objects.find(o => String(o.id) === trackKey) || tw.objects[0] || null) : null;
        const c = src ? cloneObjectKeepImg(src) : null;
        if (c) c.id = src.id;
        setTrackFrame(AppState.activeTrackId, slots[used], c);
      }
      let inserted = 0;
      if (used < tweenFrames.length) {
        const rest = tweenFrames.slice(used).map(tw => {
          const src = tw && tw.objects ? (tw.objects.find(o => String(o.id) === trackKey) || tw.objects[0] || null) : null;
          const c = src ? cloneObjectKeepImg(src) : null;
          if (c) c.id = src.id;
          return c;
        });
        while (t.frames.length < f2Idx) t.frames.push(null);
        t.frames.splice(f2Idx, 0, ...rest);
        inserted = rest.length;
        syncMainLengthFromTracks();
      }

      /* v5.4.2：子轨道补的是火柴人 → 身上绑定的配饰/图形要一起补。
         插入帧的情况下先把子轨道在同一位置也撑开等量空帧，再把补间数据逐帧填进去，
         索引才不会错位；配饰的 offX/offY/缩放/旋转也走同一套补间曲线，不是简单克隆。 */
      const figTrackId = String(AppState.activeTrackId);
      if (inserted > 0) spliceBoundChildrenFrames(figTrackId, f2Idx, inserted);
      tweenBoundChildren(figTrackId, startIdx, f2Idx, count, used, slots, childTweens);

      /* v6.1.0：补间过程中各轨道可能被补上尾部空占位，收尾统一清掉，
         避免主时间轴后面多出一截空白帧 */
      trimTrailingEmptyFrames();
      return { ok: true };
    }
    if (startIdx >= AppState.frames.length - 1) return { ok: false, reason: 'last' };
    const newFrames = buildTweenFrames(AppState.frames[startIdx], AppState.frames[startIdx + 1], count, null, startIdx, startIdx + 1);
    let insertPos = startIdx + 1;
    for (const nf of newFrames) {
      AppState.frames.splice(insertPos, 0, { id: nf.id, duration: nf.duration, isTween: true });
      for (const id in AppState.tracks) {
        const t = AppState.tracks[id];
        if (!t) continue;
        if (!t.frames) t.frames = [];
        while (t.frames.length < insertPos) t.frames.push(null);
        const src = nf.objects.find(o => String(o.id) === id) || null;
        t.frames.splice(insertPos, 0, src ? cloneObjectKeepImg(src) : null);
      }
      insertPos++;
      syncMainLengthFromTracks();
    }
    /* v6.1.0：收尾清掉可能残留的尾部空帧 */
    trimTrailingEmptyFrames();
    return { ok: true };
  }

  /* v7.4.7：整条轨全是空白帧 = 这个元件在整条时间轴上都不出场，
     这条轨道已经没有意义了，直接删掉（轨道面板那一行也跟着消失）。
     以前只在「删除元件」那一个入口扫一次，导出的工程里攒下了空轨道，
     再打开就在轨道面板里留一行什么都没有的空壳。 */
  function pruneEmptyTracks() {
    let removed = 0;
    for (const tid in AppState.tracks) {
      const t = AppState.tracks[tid];
      if (!t || !t.frames) { delete AppState.tracks[tid]; removed++; continue; }
      if (!t.frames.some(d => d != null)) {
        delete AppState.tracks[tid];
        removed++;
        if (String(AppState.activeTrackId) === String(tid)) AppState.activeTrackId = TRACK_ALL_ID;
      }
    }
    /* 轨道少了一行，面板要重画（事件只是排进 rAF，不会打断当前的加载/删除流程） */
    if (removed && typeof EventBus !== 'undefined') EventBus.emit('need:render');
    return removed;
  }

  function trimTrailingEmptyFrames() {
    /* 每条 track 从尾部弹出连续空白帧，至少保留 1 帧 */
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      while (t.frames.length > 1 && t.frames[t.frames.length - 1] == null) t.frames.pop();
      if (t.frames.length === 0) t.frames.push(null);
    }
    const target = Math.max(1, getMainLength());
    if (AppState.frames.length > target) AppState.frames.length = target;
    else syncMainLengthFromTracks();
    if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = AppState.frames.length - 1;
    if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
    AppState.objects = getCombinedObjectsForRender();
    if (isSubTrackMode()) AppState.selected = getActiveTrackObject();
  }

  /* ==================== 关键帧开关 / 段内插帧（v7.0.0） ==================== */

  /* 当前作用域下要操作的轨道：子轨 = 该元件；主轨 = 全部元件（R6 广播） */
  function currentScopeTrackIds() {
    if (isSubTrackMode()) return [String(AppState.activeTrackId)];
    return Object.keys(AppState.tracks);
  }

  /* 插入 N 帧时，这一帧后面是否还落在一个段里（决定插派生帧还是克隆普通帧） */
  function segmentAhead(frames, idx) {
    if (!frames || !frames.length) return null;
    const inside = KF.segmentContaining(frames, idx);
    if (inside) return inside;
    if (KF.isKey(frames[idx])) {
      const b = KF.nextKeyIndex(frames, idx);
      if (b > idx) return { a: idx, b: b };
    }
    return null;
  }

  /* v7.0.2：主轨打关键帧只落给「这一帧参数真的变了」的元件。
     判据：拿轨道在这一帧的求值结果（= 没改过的样子）和画布上的活对象比。
     改参数 / 拖动都会走 markCurrentFrameModified → 元素会被升成 sub 关键帧，
     所以这里兜的是「没被升格、但内容确实和插值结果不一样」的边角情况。
     —— 这样主轨按 K 不会再给没动过的元件凭空插一个锚点，把它的插值打断。 */
  function sameObjectData(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const strip = (o) => JSON.stringify(o, (k, v) => ((k === '__k' || k === '__d' || k === 'img') ? undefined : v));
    return strip(a) === strip(b);
  }

  function trackChangedAt(tid, idx, live) {
    if (!live) return false;
    const t = AppState.tracks[tid];
    if (!t || !t.frames) return true;
    /* 这条轨道还一个关键帧都没有（新工程 / 刚加的元件）：
       整条轨道都还没被「关键帧化」，第一次按 K 必须真的落下锚点。 */
    if (!KF.keyIndices(t.frames).length) return true;
    if (idx >= t.frames.length) return true;
    if (KF.isBlank(t.frames[idx])) return true;      /* 这一帧本来没这个元件 */
    /* 这一帧不在任何段里（段外）：这里本来就没有插值，按 K 是有意义的「定边界」，
       不能因为「看起来没变」就跳过 —— 否则「两端各按一次 K 再插帧」的流程会断。 */
    if (!KF.segmentContaining(t.frames, idx)) return true;
    const cur = getTrackFrame(tid, idx);             /* 走缓存，和渲染同一份数据 */
    if (!KF.isReal(cur)) return true;
    return !sameObjectData(cur, live);
  }

  /* R1 / R6 / D9 / D10：点击当前帧设为 / 取消关键帧。
     子轨作用域 = 只锁该元件（origin='sub'）；
     主轨作用域 = 广播，规则是「保留手动、只补变了参数的」：
       · 已经有锚点的元件一律原样保留，不管它是谁打的；
       · 只给「参数确实变了、又还没有锚点」的元件补一个 main 锚点；
       · 取消时只回收 origin='main' 的锚点，手动锚点留着 → 主轨这一帧显示「部分关键帧」。
     这样 D9「按来源删除」才是真的：删得掉广播、删不掉用户自己打的。 */
  function toggleKeyframeAtCurrent() {
    const idx = AppState.currentFrameIndex;
    if (isPlaying) pause();
    syncFrameRef();
    const sub = isSubTrackMode();
    const ids = currentScopeTrackIds();
    const liveOf = (id) => AppState.objects.find(o => o && o.type !== 'video' && String(o.id) === String(id)) || null;

    /* 子轨：单件开关，保持旧语义 */
    if (sub) {
      const id = String(AppState.activeTrackId);
      const t = AppState.tracks[id];
      if (!t) { alert(tr2('alert.kfNone', '当前帧没有可打关键帧的元件')); return; }
      if (!t.frames) t.frames = [];
      const slot = (idx < t.frames.length) ? t.frames[idx] : undefined;
      if (slot !== undefined && KF.isKey(slot)) {
        KF.clearKey(slot);          /* 只删锚点，槽位数据留给 reconcile 判定 */
        finishKfToggle(idx, sub, 0, 1, 0, [id]);
        return;
      }
      const live = liveOf(id);
      if (!live) { alert(tr2('alert.kfNone', '当前帧没有可打关键帧的元件')); return; }
      while (t.frames.length <= idx) t.frames.push(null);
      t.frames[idx] = live;
      KF.markKey(live, 'sub');
      finishKfToggle(idx, sub, 1, 0, 0);
      return;
    }

    /* 主轨：先摸清这一帧的现状 */
    const rows = [];
    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t) continue;
      if (!t.frames) t.frames = [];
      const slot = (idx < t.frames.length) ? t.frames[idx] : undefined;
      const hasKey = slot !== undefined && KF.isKey(slot);
      const live = liveOf(id);
      if (!hasKey && !live) continue;      /* 这一帧本来就没这个元件，不参与广播 */
      rows.push({ id: id, t: t, hasKey: hasKey, origin: hasKey ? KF.originOf(slot) : null, live: live });
    }
    if (!rows.length) { alert(tr2('alert.kfNone', '当前帧没有可打关键帧的元件')); return; }

    /* 这一帧已经是「主轨广播」状态吗？还缺锚点、且参数确实变了的元件有几个？
       这两个数决定这次点击是「补」还是「收」。 */
    const mainRows = rows.filter(r => r.origin === 'main');
    const pending = rows.filter(r => !r.hasKey && trackChangedAt(r.id, idx, r.live));

    let on = 0, off = 0, kept = 0, skipped = 0;
    const cleared = [];

    if (mainRows.length && !pending.length) {
      /* 收回：只回收主轨广播出来的锚点 */
      for (const r of mainRows) { KF.clearKey(r.t.frames[idx]); off++; cleared.push(r.id); }
      kept = rows.length - mainRows.length;
    } else {
      /* 补齐：只给参数变了的元件补 main。
         没变过的元件保持自己的插值（补一个锚点反而会把它的段打断），直接跳过。 */
      for (const r of rows) {
        if (r.hasKey) { kept++; continue; }
        if (pending.indexOf(r) < 0) { skipped++; continue; }
        while (r.t.frames.length <= idx) r.t.frames.push(null);
        r.t.frames[idx] = r.live;
        KF.markKey(r.live, 'main');
        on++;
      }
      if (!on) {
        if (kept === rows.length) {
          showHistoryToast('这一帧的关键帧是手动打的，主轨取消不会删它们；要取消请到该元件的子轨里点', 'redo', 2600);
        } else {
          showHistoryToast('这一帧没有元件的参数发生变化，不用补关键帧（要锁住某个元件请到它的子轨里按 K）', 'redo', 2800);
        }
        return;
      }
    }
    finishKfToggle(idx, sub, on, off, kept, cleared, skipped);
  }

  /* 打 / 取消关键帧之后的统一收尾（两条路径共用，避免逻辑漂移） */
  function finishKfToggle(idx, sub, on, off, kept, cleared, skipped) {
    reconcileAllTracks();
    /* v7.0.1：删掉首 / 末关键帧后，落在段外的帧要延续相邻关键帧，不能变空白 */
    for (const cid of (cleared || [])) {
      const t = AppState.tracks[String(cid)];
      if (!t || !t.frames) continue;
      const nb = keyNeighbors(t.frames, idx);
      if (nb.prev !== null && nb.next === null) fillHoldRange(t, nb.prev + 1, idx, nb.prev);
      else if (nb.prev === null && nb.next !== null) fillHoldRange(t, idx, nb.next - 1, nb.next);
    }
    if (cleared && cleared.length) bumpKfEval();
    AppState.objects = getCombinedObjectsForRender();
    if (sub) AppState.selected = getActiveTrackObject();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', on ? '设为关键帧' : '取消关键帧');
    if (on) {
      const extra = kept ? ('（' + kept + ' 个已有锚点保留原样）') : '';
      const skip = skipped ? ('，' + skipped + ' 个参数没变已跳过') : '';
      showHistoryToast((sub ? '已设为关键帧' : ('已设为关键帧 · ' + on + ' 个元件' + skip)) + extra, undefined, 1900);
    } else {
      showHistoryToast(kept
        ? ('已取消 ' + off + ' 个广播锚点，保留 ' + kept + ' 个手动锚点')
        : '已取消关键帧', 'redo', 1800);
    }
  }

  /* 段内插入 N 帧：只改变段的长度，不生成任何画面数据。
     段内的槽位插派生帧（由两端关键帧实时求值），段外维持原来的克隆行为。 */
  /* v7.2.1：这个按钮的文案跟着「段内 / 段外」变 ——
       段内（后面还有关键帧）→「插 N 帧」：插的是派生帧，画面由两端关键帧算出来；
       段外且有下一帧        →「补间 N 帧」：在当前帧和下一帧之间补出过渡帧（老补间行为）；
       已经是最后一帧        →「插 N 帧」：没有终点可补，只能是复制当前帧往后续。 */
  function syncTweenButtonLabel() {
    const btn = document.getElementById('btnTween');
    if (!btn) return;
    const span = btn.querySelector('[data-i18n="timeline.insertFrames"],[data-i18n="timeline.tweenFrames"]');
    if (!span) return;
    const idx = AppState.currentFrameIndex;
    let anySeg = false;
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (t && t.frames && segmentAhead(t.frames, idx)) { anySeg = true; break; }
    }
    const isTween = !anySeg && idx < AppState.frames.length - 1;
    const key = isTween ? 'timeline.tweenFrames' : 'timeline.insertFrames';
    const tr = (k) => (typeof window.t === 'function' ? window.t(k) : k);
    if (span.getAttribute('data-i18n') !== key) {
      span.setAttribute('data-i18n', key);
      span.textContent = tr(key);
    }
    const titleKey = isTween ? 'timeline.tweenFramesTitle' : 'timeline.insertFramesTitle';
    if (btn.getAttribute('data-i18n-title') !== titleKey) {
      btn.setAttribute('data-i18n-title', titleKey);
      btn.title = tr(titleKey);
    }
  }

  /* v7.2.1：段外补间 —— 当前帧后面没有关键帧、但后面还有帧时，
     在当前帧和**下一帧**之间补出 N 帧过渡（这才是 v7.0 之前「补间」按钮的老行为）。
     原来这里是把当前帧克隆 N 份（续帧），用户摆好两端姿势后按插帧只会得到一叠静止画面。 */
  function insertTweenAfter(idx, count) {
    const ids = Object.keys(AppState.tracks);
    const tweenFrames = buildTweenFrames(AppState.frames[idx], AppState.frames[idx + 1], count, null, idx, idx + 1);
    if (!tweenFrames || !tweenFrames.length) return false;
    let insertPos = idx + 1;
    for (const nf of tweenFrames) {
      AppState.frames.splice(insertPos, 0, { id: nf.id, duration: nf.duration, isTween: false });
      for (const id of ids) {
        const t = AppState.tracks[id];
        if (!t) continue;
        if (!t.frames) t.frames = [];
        while (t.frames.length < insertPos) t.frames.push(null);
        if (segmentAhead(t.frames, idx)) {
          /* 这条轨道后面还有关键帧 → 继续插派生帧，别把它的插值烘死成静态画面 */
          t.frames.splice(insertPos, 0, KF.DERIVED_SLOT);
        } else {
          const src = nf.objects ? (nf.objects.find(o => String(o.id) === id) || null) : null;
          /* stripFrameMarks 会剥掉 __k / __d，补出来的帧是普通帧，不是关键帧 */
          t.frames.splice(insertPos, 0, src ? KF.stripFrameMarks(src) : null);
        }
      }
      insertPos++;
      syncMainLengthFromTracks();
    }
    reconcileAllTracks();
    trimTrailingEmptyFrames();
    AppState.objects = getCombinedObjectsForRender();
    if (isSubTrackMode()) AppState.selected = getActiveTrackObject();
    invalidateAllFrameThumbs();
    updateFrameBar();
    seekVideoToFrame(AppState.currentFrameIndex);
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '补间');
    return true;
  }

  function insertFramesInSegment(count) {
    const idx = AppState.currentFrameIndex;
    const at = idx + 1;
    if (isPlaying) pause();
    syncFrameRef();
    const ids = Object.keys(AppState.tracks);
    /* v7.2.0：段外也允许插帧，不再弹提示拦下来。
       v7.2.1：段外且后面还有帧 → 走**老补间**（当前帧 ↔ 下一帧之间补 N 帧）；
               段内 → 插派生帧，中间画面由两端关键帧自动补出来；
               段外且已经是最后一帧 → 还是克隆当前帧当普通帧（往后续画）。 */
    const anySeg = ids.some(id => {
      const t = AppState.tracks[id];
      return t && t.frames && segmentAhead(t.frames, idx);
    });
    if (!anySeg && idx < AppState.frames.length - 1 && insertTweenAfter(idx, count)) return;
    const metas = [];
    const dur = Math.round(1000 / defaultFPS);
    for (let k = 0; k < count; k++) metas.push({ id: ++uid, duration: dur, isTween: false });
    AppState.frames.splice(at, 0, ...metas);

    for (const id of ids) {
      const t = AppState.tracks[id];
      if (!t) continue;
      if (!t.frames) t.frames = [];
      while (t.frames.length < at) t.frames.push(null);
      if (segmentAhead(t.frames, idx)) {
        t.frames.splice(at, 0, ...new Array(count).fill(KF.DERIVED_SLOT));
      } else {
        /* 段外：保持老行为——克隆当前帧，但绝不能把关键帧身份也带过去 */
        const src = t.frames[idx];
        const clones = [];
        for (let k = 0; k < count; k++) {
          const c = KF.isReal(src) ? cloneObjectKeepImg(src) : null;
          if (c) { c.id = src.id; delete c[KF.KEY]; }
          clones.push(c);
        }
        t.frames.splice(at, 0, ...clones);
      }
    }
    reconcileAllTracks();
    trimTrailingEmptyFrames();
    AppState.objects = getCombinedObjectsForRender();
    if (isSubTrackMode()) AppState.selected = getActiveTrackObject();
    invalidateAllFrameThumbs();
    updateFrameBar();
    seekVideoToFrame(AppState.currentFrameIndex);
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', anySeg ? '段内插入帧' : '续帧');
  }

  const btnKeyframe = document.getElementById('btnKeyframe');
  if (btnKeyframe) btnKeyframe.onclick = () => toggleKeyframeAtCurrent();

  document.getElementById('btnTween').onclick = () => {
    const count = parseInt(document.getElementById('tweenCount').value) || 5;
    if (count < 1 || count > 60) { alert(tr2('alert.insertCount', '插入帧数需在 1-60 之间')); return; }
    insertFramesInSegment(count);
  };

  /* ==================== 复制帧（多选） ==================== */
  document.getElementById('multiSelectToggle').addEventListener('change', e => {
    multiSelectMode = e.target.checked;
    if (!multiSelectMode) multiSelectedFrames.clear();
    updateFrameBar();
    updateMultiActions();
  });

  document.getElementById('btnDupFrame').onclick = () => {
    if (isPlaying) pause();
    syncFrameRef();
    const subMode = isSubTrackMode();
    if (multiSelectMode && multiSelectedFrames.size > 0) {
      const indices = Array.from(multiSelectedFrames).sort((a, b) => a - b);
      const insertPos = indices[indices.length - 1] + 1;
      if (subMode) {
        const t = ensureTrack(AppState.activeTrackId, (AppState.selected && AppState.selected.name) || AppState.activeTrackId);
        const copies = indices.map(idx => {
          const slot = t.frames[idx];
          /* v7.0.1：复制关键帧 = 新关键帧（D8）。子轨也要取「存着的槽位」而不是求值结果，
             否则 __k 标记会在 getFrameTrackObject 求值时被剥掉，复制品会变成普通帧。 */
          let c = null;
          if (KF.isKey(slot)) c = cloneObjectKeepImg(slot);
          else if (KF.isDerived(slot)) c = KF.DERIVED_SLOT;
          else {
            const src = getFrameTrackObject(null, idx);
            c = src ? cloneObjectKeepImg(src) : null;
          }
          if (c && KF.isReal(c)) c.id = (KF.isReal(slot) ? slot.id : c.id);
          return c;
        });
        while (t.frames.length < insertPos) t.frames.push(null);
        t.frames.splice(insertPos, 0, ...copies);
        AppState.currentFrameIndex = insertPos + copies.length - 1;
        syncMainLengthFromTracks();
        AppState.objects = getCombinedObjectsForRender();
        AppState.selected = getActiveTrackObject();
      } else {
        const metas = indices.map(idx => ({
          id: ++uid,
          duration: (AppState.frames[idx] && AppState.frames[idx].duration) || Math.round(1000 / defaultFPS),
          isTween: false
        }));
        AppState.frames.splice(insertPos, 0, ...metas);
        for (const id in AppState.tracks) {
          const t = AppState.tracks[id];
          if (!t) continue;
          if (!t.frames) t.frames = [];
          const copies = indices.map(idx => {
            const src = t.frames[idx];
            const c = src ? cloneObjectKeepImg(src) : null;
            if (c && src) c.id = src.id;
            return c;
          });
          while (t.frames.length < insertPos) t.frames.push(null);
          t.frames.splice(insertPos, 0, ...copies);
        }
        syncMainLengthFromTracks();
        AppState.currentFrameIndex = insertPos + metas.length - 1;
        AppState.objects = getCombinedObjectsForRender();
        AppState.selected = null;
      }
      AppState.canvasSelected = false;
      multiSelectedFrames.clear();
      reconcileAllTracks();   /* v7.0.0：多选复制的槽位也要按段重新归一化 */
      invalidateAllFrameThumbs();
      updateFrameBar();
      EventBus.emit('need:render'); EventBus.emit('need:syncUI');
      EventBus.emit('history:save', '复制帧');
      return;
    }
    if (subMode) {
      const t = ensureTrack(AppState.activeTrackId, (AppState.selected && AppState.selected.name) || AppState.activeTrackId);
      /* v7.0.1：复制关键帧 = 新关键帧。必须克隆「存着的槽位」，求值结果是不带 __k 的。 */
      const curSlot = t.frames[AppState.currentFrameIndex];
      let clone = null;
      if (KF.isKey(curSlot)) { clone = cloneObjectKeepImg(curSlot); clone.id = curSlot.id; }
      else if (KF.isDerived(curSlot)) clone = KF.DERIVED_SLOT;
      else {
        const srcObj = getFrameTrackObject(null, AppState.currentFrameIndex);
        clone = srcObj ? cloneObjectKeepImg(srcObj) : null;
        if (clone && srcObj) clone.id = srcObj.id;
      }
      const nextIdx = AppState.currentFrameIndex + 1;
      if (nextIdx < t.frames.length && t.frames[nextIdx] == null) {
        /* 下一帧对当前轨道是空白帧：直接占用该槽位，不把后面的帧挤开 */
        t.frames[nextIdx] = clone;
      } else {
        while (t.frames.length < nextIdx) t.frames.push(null);
        t.frames.splice(nextIdx, 0, clone);
      }
      AppState.currentFrameIndex = nextIdx;
      reconcileAllTracks();
      syncMainLengthFromTracks();
      trimTrailingEmptyFrames();
      invalidateAllFrameThumbs();
      AppState.objects = getCombinedObjectsForRender();
      AppState.selected = getActiveTrackObject();
      AppState.canvasSelected = false;
      cancelTransformBoxDrag(); anchorModeOn = false;
      seekVideoToFrame(AppState.currentFrameIndex);
      updateFrameBar();
      EventBus.emit('need:render'); EventBus.emit('need:syncUI');
      EventBus.emit('history:save', '复制帧');
      return;
    }
    const insertAt = AppState.currentFrameIndex + 1;
    const last = AppState.frames[AppState.frames.length - 1];
    const newFrame = {
      id: ((last && last.id) || AppState.frames.length) + 1,
      duration: Math.round(1000 / defaultFPS),
      isTween: false
    };
    AppState.frames.splice(insertAt, 0, newFrame);
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t) continue;
      if (!t.frames) t.frames = [];
      while (t.frames.length < insertAt) t.frames.push(null);
      const src = t.frames[AppState.currentFrameIndex];
      /* v7.0.0：派生槽位直接沿用哨兵；关键帧/普通帧照常克隆（复制关键帧 = 新关键帧，D8） */
      const clone = KF.isReal(src) ? cloneObjectKeepImg(src) : (KF.isDerived(src) ? KF.DERIVED_SLOT : null);
      if (clone && KF.isReal(clone)) clone.id = src.id;
      t.frames.splice(insertAt, 0, clone);
    }
    reconcileAllTracks();
    syncMainLengthFromTracks();
    AppState.currentFrameIndex = insertAt;
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = null; AppState.canvasSelected = false;
    seekVideoToFrame(AppState.currentFrameIndex);
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '复制帧');
  };

  /* ==================== 导出尺寸 & 裁剪 ==================== */
  function getExportSize() {
    const el = document.getElementById('hd1080p');
    const is1080 = !!(el && el.checked);
    const cam = shouldSkipCameraForExport() ? null : (getCurrentCameraObject() || getCameraAtFrame(0));
    let base = 400;
    if (is1080) base = 1920;
    else {
      const is3x = document.getElementById('gifHD3x').checked;
      base = is3x ? 1200 : 400;
    }
    let w = base, h = base;
    if (cam && cam.w > 0 && cam.h > 0) {
      const a = cam.w / cam.h;
      if (a >= 1) { w = base; h = Math.round(base / a); }
      else { h = base; w = Math.round(base * a); }
    } else if (is1080 && AppState.canvasBoundsEnabled && AppState.canvasBounds.h > 0) {
      const a = AppState.canvasBounds.w / AppState.canvasBounds.h;
      if (a >= 1) { w = 1920; h = Math.round(1920 / a); }
      else { w = Math.round(1920 * a); h = 1920; }
    }
    return { w: Math.max(2, w - (w % 2)), h: Math.max(2, h - (h % 2)) };
  }

  function computeContentBounds(list, refList) {
    list = list || AppState.objects;
    const prevList = _renderList;
    /* refList：参与测量的范围，但绑定/父级查找仍用完整列表，否则挂载件会被算到错误位置 */
    _renderList = refList || list;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const extend = (x, y) => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const o of list) {
      if (o.type === 'camera') continue;
      if (o.type === 'figure') {
        const j = jointData(o);
        const pts = [j.pelvis, j.waistPoint, j.neck, j.headC, j.elbowL, j.handL, j.elbowR, j.handR, j.thighL, j.footL, j.thighR, j.footR];
        if (o.extremity && o.extremity.enabled) pts.push(j.wristL, j.wristR, j.toeL, j.toeR);
        for (const p of pts) extend(p.x, p.y);
        extend(j.headC.x - j.headR, j.headC.y - j.headR);
        extend(j.headC.x + j.headR, j.headC.y + j.headR);
        /* v5.2.0 扭曲后外轮廓 = 4 个变形角点围成的四边形，导出裁剪必须把它算进去 */
        if (SKFE.systems.distort.isActive(o)) {
          const dmp = SKFE.systems.distort.getMapping(o);
          if (dmp) {
            for (let i = 0; i < 4; i++) {
              const dp = SKFE.systems.distort.boxToWorld(dmp.frame, dmp.dst[i]);
              extend(dp.x, dp.y);
            }
          }
        }
        const m = o.lw * o.scale / 2 + 4;
        minX -= m; minY -= m; maxX += m; maxY += m;
      } else if (o.type === 'image') {
        const b = getObjectBounds(o);
        extend(b.left, b.top); extend(b.right, b.bottom);
      } else if (o.type === 'video') {
        // 忽略
      } else {
        const b = getObjectBounds(o);
        extend(b.left, b.top); extend(b.right, b.bottom);
      }
    }
    _renderList = prevList;
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function computeAllFramesBounds(trackId) {
    const tid = (trackId != null && trackId !== TRACK_ALL_ID) ? String(trackId) : null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < AppState.frames.length; i++) {
      const b = computeContentBounds(getObjectsForFrameAt(i, tid));
      if (b) {
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  function bboxToCrop(bbox, outW, outH, pad) {
    if (!bbox) return { cx: 0, cy: 0, scale: 1, rotation: 0 };
    const bw = bbox.maxX - bbox.minX;
    const bh = bbox.maxY - bbox.minY;
    const s = Math.max(bw, bh) * (pad || 1.15);
    return {
      scale: Math.min(outW, outH) / Math.max(1, s),
      cx: (bbox.minX + bbox.maxX) / 2,
      cy: (bbox.minY + bbox.maxY) / 2,
      rotation: 0
    };
  }

  function getExportCrop(outW, outH, trackId) {
    const cam = shouldSkipCameraForExport() ? null : (getCurrentCameraObject() || getCameraAtFrame(0));
    if (cam) return cameraToCrop(cam, outW, outH);
    if (AppState.canvasBoundsEnabled) {
      const rad = AppState.canvasBounds.rotation || 0;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      const w_rot = AppState.canvasBounds.w * absCos + AppState.canvasBounds.h * absSin;
      const h_rot = AppState.canvasBounds.w * absSin + AppState.canvasBounds.h * absCos;
      return {
        cx: AppState.canvasBounds.x + AppState.canvasBounds.w / 2,
        cy: AppState.canvasBounds.y + AppState.canvasBounds.h / 2,
        scale: Math.min(outW / w_rot, outH / h_rot),
        rotation: rad
      };
    }
    return bboxToCrop(computeAllFramesBounds(trackId), outW, outH, 1.15);
  }

  function getCropForFrames(frameList, outW, outH, trackId) {
    const tid = (trackId != null && trackId !== TRACK_ALL_ID) ? String(trackId) : null;
    if (!frameList || !frameList.length) return getExportCrop(outW, outH, tid);
    const firstIdx = AppState.frames.indexOf(frameList[0]);
    const cam = shouldSkipCameraForExport() ? null :
      (getCameraAtFrame(firstIdx >= 0 ? firstIdx : AppState.currentFrameIndex) || getCurrentCameraObject() || getCameraAtFrame(0));
    if (cam) return cameraToCrop(cam, outW, outH);
    if (AppState.canvasBoundsEnabled) {
      const rad = AppState.canvasBounds.rotation || 0;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      const w_rot = AppState.canvasBounds.w * absCos + AppState.canvasBounds.h * absSin;
      const h_rot = AppState.canvasBounds.w * absSin + AppState.canvasBounds.h * absCos;
      return {
        cx: AppState.canvasBounds.x + AppState.canvasBounds.w / 2,
        cy: AppState.canvasBounds.y + AppState.canvasBounds.h / 2,
        scale: Math.min(outW / w_rot, outH / h_rot),
        rotation: rad
      };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const fr of frameList) {
      const idx = AppState.frames.indexOf(fr);
      const b = computeContentBounds(getObjectsForFrameAt(idx >= 0 ? idx : 0, tid));
      if (b) {
        if (b.minX < minX) minX = b.minX;
        if (b.minY < minY) minY = b.minY;
        if (b.maxX > maxX) maxX = b.maxX;
        if (b.maxY > maxY) maxY = b.maxY;
      }
    }
    const bbox = isFinite(minX) ? { minX, minY, maxX, maxY } : null;
    return bboxToCrop(bbox, outW, outH, 1.15);
  }

  function renderFrameToDataURL(frame, outW, outH, options, trackId) {
    options = options || {};
    const transparent = !!options.transparent;
    const idx = (typeof frame === 'number') ? frame : AppState.frames.indexOf(frame);
    const safeIdx = idx >= 0 ? idx : AppState.currentFrameIndex;
    const tid = (trackId != null && trackId !== TRACK_ALL_ID)
      ? String(trackId)
      : ((options.trackId != null && options.trackId !== TRACK_ALL_ID) ? String(options.trackId) : null);
    const safeTid = (tid && isCameraTrackId(tid)) ? null : tid;
    /* v6.3.0：可以只渲染某一个元件（元件浮窗的缩略图），也可以强制包含被隐藏的元件 */
    const fullList = getObjectsForFrameAt(safeIdx, safeTid);
    let objList = fullList;
    if (options.onlyId != null) objList = objList.filter(o => o && String(o.id) === String(options.onlyId));
    if (!options.includeHidden) objList = objList.filter(o => o && !o.hidden);
    const off = document.createElement('canvas');
    off.width = outW; off.height = outH;
    const octx = off.getContext('2d');
    let scale, cx, cy, rotation = 0;
    const camAt = (options.crop || options.ignoreCamera || shouldSkipCameraForExport()) ? null : getCameraAtFrame(safeIdx);
    if (options.crop) {
      scale = options.crop.scale; cx = options.crop.cx; cy = options.crop.cy;
      rotation = options.crop.rotation || 0;
    } else if (camAt) {
      const cc = cameraToCrop(camAt, outW, outH);
      scale = cc.scale; cx = cc.cx; cy = cc.cy; rotation = cc.rotation;
    } else if (AppState.canvasBoundsEnabled) {
      const rad = AppState.canvasBounds.rotation || 0;
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      const w_rot = AppState.canvasBounds.w * absCos + AppState.canvasBounds.h * absSin;
      const h_rot = AppState.canvasBounds.w * absSin + AppState.canvasBounds.h * absCos;
      scale = Math.min(outW / w_rot, outH / h_rot);
      cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
      cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
      rotation = rad;
    } else {
      const c = bboxToCrop(computeContentBounds(objList, fullList), outW, outH, 1.15);
      scale = c.scale; cx = c.cx; cy = c.cy;
    }
    /* v6.3.1：缩略图不跟随画布/取景框旋转，保持正立 */
    if (options.noRotate) rotation = 0;
    if (!transparent) { octx.fillStyle = pageBgColor; octx.fillRect(0, 0, outW, outH); }
    octx.translate(outW / 2, outH / 2);
    octx.rotate(-rotation);
    octx.scale(scale, scale);
    octx.translate(-cx, -cy);
    const savedCtx = ctx;
    ctx = octx;
    window.__isExporting = true;
    try {
      octx.save();
      if (AppState.canvasBoundsEnabled) {
        octx.save();
        octx.translate(cx, cy);
        octx.rotate(rotation);
        octx.beginPath();
        octx.rect(-AppState.canvasBounds.w / 2, -AppState.canvasBounds.h / 2, AppState.canvasBounds.w, AppState.canvasBounds.h);
        octx.clip();
        octx.restore();
      }
      renderScene(objList, { isExporting: true, includeHidden: !!options.includeHidden, refList: fullList });
      octx.restore();
    } finally { ctx = savedCtx; window.__isExporting = false; }
    return off;
  }

  function renderSingleTrackFrameToDataURL(trackId, idx, outW, outH, options) {
    const off = renderFrameToDataURL(AppState.frames[idx] || idx, outW, outH, options || { transparent: true }, trackId);
    return off.toDataURL('image/png');
  }

  /* ==================== 更多设置：工具芯片 ==================== */
  const toolChips = Array.from(document.querySelectorAll('#toolChips .tool-chip'));
  const toolPanels = Array.from(document.querySelectorAll('.tool-panel'));
  const FIGURE_ONLY_TOOLS = ['layer', 'proportion', 'joints', 'glow'];
  /* brush-v5.1.0: 「画笔」面板在未选中任何元件时也必须可用（无选中 → 自动绑最近的关节点） */
  const NON_CAMERA_TOOLS = [];
  const ALWAYS_TOOLS = ['eraser'];
  let activeTool = null;

  function updateStickyHeaderHeight() {
    const sh = document.querySelector('.sticky-header');
    if (!uiPanel) return;
    /* v7.0.5：元件列表搬到「元件」分区后会处于隐藏状态，隐藏时 offsetHeight 是 0，
       但 offsetParent 也会是 null —— 用它区分"隐藏"和"真的没高度"，避免把 0 写进变量。 */
    const visible = sh && sh.offsetParent !== null;
    uiPanel.style.setProperty('--sticky-header-h', (visible ? sh.offsetHeight : 0) + 'px');
  }

  function setActiveTool(name) {
    if (name === activeTool) name = null;
    activeTool = name;
    if (activeTool !== 'proportion' && headHandleOn) {
      headHandleOn = false;
      headHandleDrag = null;
      updateHeadMoveHandle();
      EventBus.emit('need:syncUI');
    }
    toolChips.forEach(ch => {
      const on = !!name && ch.dataset.tool === name;
      ch.classList.toggle('active', on);
      ch.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    toolPanels.forEach(p => p.classList.toggle('active', !!name && p.dataset.tool === name));
    uiPanel.classList.toggle('has-active-tool', !!name);
    shadowEditMode = name === 'glow';
    groundLineEditMode = name === 'canvas';
    canvasBoundsEditMode = name === 'canvas';
    updateStickyHeaderHeight();
    EventBus.emit('need:render');
  }

  function updateToolVisibility(isFig, hasSel, isCamera) {
    toolChips.forEach(ch => {
      const tool = ch.dataset.tool;
      const figOnly = FIGURE_ONLY_TOOLS.indexOf(tool) !== -1;
      const nonCamOnly = NON_CAMERA_TOOLS.indexOf(tool) !== -1;
      const always = ALWAYS_TOOLS.indexOf(tool) !== -1;
      let hidden = false;
      if (always) hidden = !!isCamera;              /* 画笔面板仅摄像机不可用 */
      else {
        if (figOnly && !isFig) hidden = true;
        if (nonCamOnly && (!hasSel || isCamera)) hidden = true;
      }
      ch.classList.toggle('hidden', hidden);
    });
    if (activeTool) {
      const isFigActive = FIGURE_ONLY_TOOLS.indexOf(activeTool) !== -1;
      const isNonCamActive = NON_CAMERA_TOOLS.indexOf(activeTool) !== -1;
      if ((isFigActive && !isFig) || (isNonCamActive && (!hasSel || isCamera))) setActiveTool(null);
    }
  }

  /* 点击更多设置按钮后：把滚动区平滑滚到让该信息栏刚好出现在 chips 下方。
     v7.0.5：元件列表（.sticky-header）已搬到「元件」分区，主区没有吸顶层了，
     所以拿不到 header 时就不再判断"是否悬浮"，直接滚。 */
     function maybeScrollToActiveToolPanel() {
    if (!activeTool || !uiPanel) return;
    const scroll = document.getElementById('uiScroll') || uiPanel;
    const panel = uiPanel.querySelector('.tool-panel[data-tool="' + activeTool + '"]');
    if (!panel) return;
    const chips = uiPanel.querySelector('.settings-chips-wrapper');
    const header = uiPanel.querySelector('.sticky-header');
    if (!chips) return;

    const uiRect = uiPanel.getBoundingClientRect();
    const chipsRect = chips.getBoundingClientRect();
    const headerH = header ? header.offsetHeight : 0;
    const chipsH = chips.offsetHeight;

    /* sticky-header 的 top 是 -10px、chips 的 top 是 headerH - 11px，
       悬浮时 chips 顶部可视位置 ≈ uiRect.top + headerH - 1 */
    const stickyViewportTop = uiRect.top + headerH - 1;
    const isStuck = header ? (chipsRect.top <= stickyViewportTop + 2) : true;
    if (!isStuck) return; /* 按钮还在文档流里 → 不滚动 */

    /* 目标：让 panel 顶部刚好落在 chips 悬浮层底部下方 8px */
    const panelRect = panel.getBoundingClientRect();
    const desiredTop = uiRect.top + headerH + chipsH - 1 + 8;
    const delta = panelRect.top - desiredTop;
    scroll.scrollTo({ top: Math.max(0, scroll.scrollTop + delta), behavior: 'smooth' });
  }

  toolChips.forEach(ch => {
    ch.addEventListener('click', () => {
      setActiveTool(ch.dataset.tool);
      if (isMobile) {
        setTimeout(() => {
          const panel = document.querySelector(`.tool-panel[data-tool="${activeTool}"]`);
          if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      } else if (activeTool) {
        setTimeout(maybeScrollToActiveToolPanel, 60);
      }
    });
  });

  /* ==================== 主题系统（已迁移至 js/features/theme.js） ==================== */
  SKFE.features.theme.init({
    EventBus,
    // 主题 → 画布背景同步，通过回调交回 app.js 处理（theme.js 不直接碰 pageBgColor）
    onThemeApplied: (cfg) => {
      // 修复：不再覆盖 pageBgColor（画布设置里用户选的背景色），
      //       主题色只控制 UI 的 --bg-page，二者解耦。
      pageBgAlpha = Math.max(0, Math.min(1, Number(cfg.canvasAlpha)));

      // 若用户还没有手动调整「画布背景」，就让主题色同步一次，作为初始默认值
      if (pageBgColorInput) {
        if (!pageBgColorInput.dataset.manual) {
          pageBgColor = cfg.canvasBg;
          pageBgColorInput.value = cfg.canvasBg;
        } else {
          // 用户已手动改过，主题面板不覆盖
          pageBgColorInput.value = pageBgColor;
        }
      }
      if (mp4BgColorInput && !mp4BgColorInput.dataset.manual) mp4BgColorInput.value = pageBgColor;

      EventBus.emit('need:render');
    },
  });
  SKFE.features.theme.boot();
  
  /* ==================== 页面外观 ==================== */
  const pageBgColorInput = document.getElementById('pageBgColor');
  const gridEnabledCheckbox = document.getElementById('gridEnabled');
  const gridSizeInput = document.getElementById('gridSize');
  const gridSizeVal = document.getElementById('gridSizeVal');
  const mp4BgColorInput = document.getElementById('mp4BgColor');

  function syncPageAppearanceUI() {
    if (pageBgColorInput) pageBgColorInput.value = pageBgColor;
    if (gridEnabledCheckbox) gridEnabledCheckbox.checked = gridEnabled;
    if (gridSizeInput) gridSizeInput.value = gridSize;
    if (gridSizeVal) gridSizeVal.textContent = gridSize;
    if (mp4BgColorInput && !mp4BgColorInput.dataset.manual) mp4BgColorInput.value = pageBgColor;
  }

  if (pageBgColorInput) {
    pageBgColorInput.addEventListener('input', e => {
      pageBgColor = e.target.value;
      // 标记用户手动改过，主题面板从此不再覆盖它
      pageBgColorInput.dataset.manual = '1';
      if (mp4BgColorInput && !mp4BgColorInput.dataset.manual) mp4BgColorInput.value = pageBgColor;
      EventBus.emit('need:render');
    });
  }
  if (mp4BgColorInput) {
    mp4BgColorInput.addEventListener('change', e => { e.target.dataset.manual = '1'; });
  }
  if (gridEnabledCheckbox) gridEnabledCheckbox.addEventListener('change', e => { gridEnabled = e.target.checked; EventBus.emit('need:render'); });
  if (gridSizeInput) {
    gridSizeInput.addEventListener('input', e => {
      gridSize = +e.target.value;
      if (gridSizeVal) gridSizeVal.textContent = gridSize;
      EventBus.emit('need:render');
    });
  }

  /* ==================== 地面阴影 ==================== */
  const btnGroundShadow = document.getElementById('btnGroundShadow');
  const shadowColorInput = document.getElementById('shadowColor');
  const shadowAlphaInput = document.getElementById('shadowAlpha');
  const shadowAlphaVal = document.getElementById('shadowAlphaVal');
  const shadowScaleXInput = document.getElementById('shadowScaleX');
  const shadowScaleXVal = document.getElementById('shadowScaleXVal');
  const shadowScaleYInput = document.getElementById('shadowScaleY');
  const shadowScaleYVal = document.getElementById('shadowScaleYVal');

  /* v7.2.1：地面阴影改成每个火柴人独立（原来是一套工程级全局参数，
     所有火柴人共用、也没法打关键帧）。现在 6 个参数都挂在火柴人对象上，
     改任何一项都走 setGlobalProp + markCurrentFrameModified，和描边阴影其余控件完全一致。 */
  const shadowFig = () => (AppState.selected && AppState.selected.type === 'figure') ? AppState.selected : null;

  btnGroundShadow.onclick = () => {
    const f = shadowFig();
    if (!f) return;
    shadowFill(f);
    f.shadowEnabled = !f.shadowEnabled;
    setGlobalProp(f, 'shadowEnabled', f.shadowEnabled);
    btnGroundShadow.classList.toggle('on', f.shadowEnabled);
    btnGroundShadow.textContent = f.shadowEnabled ? tr2('shadow.off', '关闭地面阴影') : tr2('shadow.on', '开启地面阴影');
    shadowEditMode = activeTool === 'glow';
    EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', '切换地面阴影');
  };

  shadowColorInput.addEventListener('input', e => {
    const f = shadowFig(); if (!f) return;
    shadowFill(f); f.shadowColor = e.target.value;
    setGlobalProp(f, 'shadowColor', f.shadowColor);
    EventBus.emit('need:render'); markCurrentFrameModified();
  });
  shadowAlphaInput.addEventListener('input', e => {
    const f = shadowFig(); if (!f) return;
    shadowFill(f); f.shadowAlpha = +e.target.value;
    shadowAlphaVal.textContent = f.shadowAlpha.toFixed(2);
    setGlobalProp(f, 'shadowAlpha', f.shadowAlpha);
    EventBus.emit('need:render'); markCurrentFrameModified();
  });
  shadowColorInput.addEventListener('change', () => EventBus.emit('history:save', '修改阴影颜色'));
  shadowAlphaInput.addEventListener('change', () => EventBus.emit('history:save', '修改阴影透明度'));

  shadowScaleXInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.shadowScaleX = +e.target.value;
      shadowScaleXVal.textContent = AppState.selected.shadowScaleX.toFixed(2);
      setGlobalProp(AppState.selected, 'shadowScaleX', AppState.selected.shadowScaleX);
      EventBus.emit('need:render');
      markCurrentFrameModified();
    }
  });
  shadowScaleXInput.addEventListener('change', () => EventBus.emit('history:save', '调整阴影宽度'));

  shadowScaleYInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.shadowScaleY = +e.target.value;
      shadowScaleYVal.textContent = AppState.selected.shadowScaleY.toFixed(2);
      setGlobalProp(AppState.selected, 'shadowScaleY', AppState.selected.shadowScaleY);
      EventBus.emit('need:render');
      markCurrentFrameModified();
    }
  });
  shadowScaleYInput.addEventListener('change', () => EventBus.emit('history:save', '调整阴影高度'));

  /* ==================== 地面参考线 ==================== */
  const btnGroundLine = document.getElementById('btnGroundLine');
  const groundLineYInput = document.getElementById('groundLineY');
  const groundLineYVal = document.getElementById('groundLineYVal');

  function syncGroundLineUI() {
    const disp = Math.round(displayY(groundLineY));
    groundLineYInput.value = disp;
    groundLineYVal.textContent = disp;
  }

  btnGroundLine.onclick = () => {
    groundLineEnabled = !groundLineEnabled;
    btnGroundLine.classList.toggle('on', groundLineEnabled);
    btnGroundLine.textContent = groundLineEnabled ? tr2('groundLine.off', '关闭地面参考线') : tr2('groundLine.on', '开启地面参考线');
    if (groundLineEnabled) {
      const firstFig = AppState.objects.find(o => o.type === 'figure');
      if (firstFig) {
        const j = jointData(firstFig);
        groundLineY = Math.max(j.footL.y, j.footR.y, j.toeL.y, j.toeR.y);
      } else {
        groundLineY = 0;
      }
      syncGroundLineUI();
    }
    groundLineEditMode = activeTool === 'canvas';
    EventBus.emit('need:render');
    EventBus.emit('history:save', '切换地面参考线');
  };

  groundLineYInput.addEventListener('input', e => {
    groundLineY = -(+e.target.value);
    groundLineYVal.textContent = Math.round(displayY(groundLineY));
    EventBus.emit('need:render');
  });
  groundLineYInput.addEventListener('change', () => EventBus.emit('history:save', '调整参考线位置'));

  /* ==================== 关节旋转与隐藏 ==================== */
  const hideJointsCheckbox = document.getElementById('hideJoints');
  const jointSizeInput = document.getElementById('jointSize');
  const jointSizeVal = document.getElementById('jointSizeVal');
  const jointSmoothInput = document.getElementById('jointSmooth');
  const jointSmoothVal = document.getElementById('jointSmoothVal');
  const jointColorDiffCheckbox = document.getElementById('jointColorDiff');

  hideJointsCheckbox.addEventListener('change', e => {
    hideJointsEnabled = e.target.checked;
    EventBus.emit('need:render');
    EventBus.emit('history:save', '切换关节显示');
  });
  jointSizeInput.addEventListener('input', e => {
    jointSize = +e.target.value;
    jointSizeVal.textContent = jointSize;
    EventBus.emit('need:render');
  });
  jointSizeInput.addEventListener('change', () => EventBus.emit('history:save', '调整关节大小'));
  
  jointSmoothInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.jointSmooth = +e.target.value;
      jointSmoothVal.textContent = AppState.selected.jointSmooth.toFixed(2);
      setGlobalProp(AppState.selected, 'jointSmooth', AppState.selected.jointSmooth);
      EventBus.emit('need:render');
    }
  });
  jointSmoothInput.addEventListener('change', () => EventBus.emit('history:save', '调整关节圆滑度'));

  jointColorDiffCheckbox.addEventListener('change', e => {
    jointColorDiff = e.target.checked;
    EventBus.emit('need:render');
    EventBus.emit('history:save', '关节颜色区分');
  });

  /* ==================== 关节分组逻辑 ==================== */
  function getJointGroup(target) {
    if (['head', 'neck', 'waist'].includes(target)) return 'body';
    if (['legL_u', 'legL_f', 'extLegL'].includes(target)) return 'legL';
    if (['legR_u', 'legR_f', 'extLegR'].includes(target)) return 'legR';
    if (['armL_u', 'armL_f', 'extL'].includes(target)) return 'armL';
    if (['armR_u', 'armR_f', 'extR'].includes(target)) return 'armR';
    return null;
  }

  function isJointInGroup(hName, group) {
    if (!group) return true;
    if (group === 'body') return ['head', 'neck', 'waist', 'pelvis'].includes(hName);
    if (group === 'legL') return ['kneeL', 'footL', 'toeL'].includes(hName);
    if (group === 'legR') return ['kneeR', 'footR', 'toeR'].includes(hName);
    if (group === 'armL') return ['elbowL', 'handL', 'wristL'].includes(hName);
    if (group === 'armR') return ['elbowR', 'handR', 'wristR'].includes(hName);
    return false;
  }

  function syncJointButtonsUI() {
    document.querySelectorAll('.joint-name-btn').forEach(b => {
      b.classList.toggle('active', getJointGroup(b.dataset.target) === isolatedJointName);
    });
  }
  const jointSliders = document.querySelectorAll('.joint-rot-slider');

  function updateJointSliders() {
    if (!AppState.selected || AppState.selected.type !== 'figure') {
      jointSliders.forEach(slider => {
        slider.value = 0; slider._lastVal = 0;
        const valEl = slider.nextElementSibling;
        if (valEl) valEl.textContent = '0°';
      });
      return;
    }
    jointSliders.forEach(slider => {
      const target = slider.dataset.target;
      let deg = 0;
      if (target === 'head') deg = ((AppState.selected.headAngle - (-Math.PI / 2)) * 180 / Math.PI);
      else if (target === 'armL_u') deg = ((AppState.selected.a.armL.u - (Math.PI + 0.18)) * 180 / Math.PI);
      else if (target === 'armL_f') deg = ((AppState.selected.a.armL.f - 0.12) * 180 / Math.PI);
      else if (target === 'armR_u') deg = ((AppState.selected.a.armR.u - (Math.PI - 0.18)) * 180 / Math.PI);
      else if (target === 'armR_f') deg = ((AppState.selected.a.armR.f - (-0.12)) * 180 / Math.PI);
      else if (target === 'legL_u') deg = ((AppState.selected.a.legL.u - (Math.PI + 0.10)) * 180 / Math.PI);
      else if (target === 'legL_f') deg = ((AppState.selected.a.legL.f - (-0.05)) * 180 / Math.PI);
      else if (target === 'legR_u') deg = ((AppState.selected.a.legR.u - (Math.PI - 0.10)) * 180 / Math.PI);
      else if (target === 'legR_f') deg = ((AppState.selected.a.legR.f - 0.05) * 180 / Math.PI);
      else if (target === 'waist') deg = ((AppState.selected.a.waist || 0) * 180 / Math.PI);
      else if (target === 'neck') deg = ((AppState.selected.headAngle - (AppState.selected.a.torso + (AppState.selected.a.waist || 0))) * 180 / Math.PI);
      else if (target === 'extL') { if (AppState.selected.extremity) deg = (AppState.selected.extremity.armAngleL * 180 / Math.PI); }
      else if (target === 'extR') { if (AppState.selected.extremity) deg = (AppState.selected.extremity.armAngleR * 180 / Math.PI); }
      else if (target === 'extLegL') { if (AppState.selected.extremity) deg = (AppState.selected.extremity.legAngleL * 180 / Math.PI); }
      else if (target === 'extLegR') { if (AppState.selected.extremity) deg = (AppState.selected.extremity.legAngleR * 180 / Math.PI); }
      deg = Math.round(deg);
      while (deg > 180) deg -= 360;
      while (deg < -180) deg += 360;
      slider.value = deg;
      slider._lastVal = deg;
      const valEl = slider.nextElementSibling;
      if (valEl) valEl.textContent = deg + '°';
    });
  }

  /* ==================== 关节隔离按钮逻辑 ==================== */
  document.querySelectorAll('.joint-name-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const group = getJointGroup(btn.dataset.target);
      if (isolatedJointName === group) {
        isolatedJointName = null;
      } else {
        isolatedJointName = group;
      }
      syncJointButtonsUI();
      EventBus.emit('need:render');
    });
  });

  jointSliders.forEach(slider => {
    slider._lastVal = 0;
    slider.addEventListener('input', (e) => {
      const val = +e.target.value;
      const lastVal = slider._lastVal !== undefined ? slider._lastVal : 0;
      const delta = (val - lastVal) * Math.PI / 180;
      slider._lastVal = val;
      const valEl = slider.nextElementSibling;
      if (valEl) valEl.textContent = val + '°';
      if (AppState.selected && AppState.selected.type === 'figure') {
        const target = slider.dataset.target;
        if (target === 'head') AppState.selected.headAngle += delta;
        else if (target === 'armL_u') AppState.selected.a.armL.u += delta;
        else if (target === 'armL_f') AppState.selected.a.armL.f += delta;
        else if (target === 'armR_u') AppState.selected.a.armR.u += delta;
        else if (target === 'armR_f') AppState.selected.a.armR.f += delta;
        else if (target === 'legL_u') AppState.selected.a.legL.u += delta;
        else if (target === 'legL_f') AppState.selected.a.legL.f += delta;
        else if (target === 'legR_u') AppState.selected.a.legR.u += delta;
        else if (target === 'legR_f') AppState.selected.a.legR.f += delta;
        else if (target === 'waist') { if (AppState.selected.a.waist === undefined) AppState.selected.a.waist = 0; AppState.selected.a.waist += delta; }
        else if (target === 'neck') AppState.selected.headAngle += delta;
        else if (target === 'extL') { if (AppState.selected.extremity) AppState.selected.extremity.armAngleL += delta; }
        else if (target === 'extR') { if (AppState.selected.extremity) AppState.selected.extremity.armAngleR += delta; }
        else if (target === 'extLegL') { if (AppState.selected.extremity) AppState.selected.extremity.legAngleL += delta; }
        else if (target === 'extLegL') { if (AppState.selected.extremity) AppState.selected.extremity.legAngleL += delta; }
        else if (target === 'extLegR') { if (AppState.selected.extremity) AppState.selected.extremity.legAngleR += delta; }
        enforcePins(AppState.selected);
        markCurrentFrameModified();
        EventBus.emit('need:render');
      }
    });
    slider.addEventListener('change', () => EventBus.emit('history:save', '调整关节'));
  });

  /* ==================== 画布设置 ==================== */
  const btnToggleCanvasBounds = document.getElementById('btnToggleCanvasBounds');
  const canvasSliders = document.getElementById('canvasSliders');
  const canvasMaskCheckbox = document.getElementById('canvasMaskEnabled');
  const canvasMaskAlphaRow = document.getElementById('canvasMaskAlphaRow');
  const canvasMaskAlphaInput = document.getElementById('canvasMaskAlpha');
  const canvasMaskAlphaVal = document.getElementById('canvasMaskAlphaVal');

  function syncCanvasUI() {
    if (canvasSliders) {
      canvasSliders.style.display = AppState.canvasBoundsEnabled ? 'block' : 'none';
    }
    if (btnToggleCanvasBounds) {
      btnToggleCanvasBounds.classList.toggle('on', AppState.canvasBoundsEnabled);
      btnToggleCanvasBounds.textContent = AppState.canvasBoundsEnabled ? tr2('bounds.off', '关闭画布边界') : tr2('bounds.on', '开启画布边界');
    }
    syncExportCanvasFirstBtn();
    updatePosInputs(); // 确保基础属性面板中的 X/Y 同步
  }

  const btnExportCanvasFirst = document.getElementById('btnExportCanvasFirst');
  function syncExportCanvasFirstBtn() {
    if (!btnExportCanvasFirst) return;
    btnExportCanvasFirst.classList.toggle('on', exportCanvasFirst && AppState.canvasBoundsEnabled);
    btnExportCanvasFirst.disabled = !AppState.canvasBoundsEnabled;
    btnExportCanvasFirst.title = AppState.canvasBoundsEnabled
      ? (exportCanvasFirst ? '已开启：导出时优先使用画布边界（点击关闭）' : '开启后，导出时优先使用画布边界')
      : tr2('alert.boundsFirst', '请先开启画布边界');
  }
  if (btnExportCanvasFirst) {
    btnExportCanvasFirst.addEventListener('click', () => {
      if (!AppState.canvasBoundsEnabled) return;
      exportCanvasFirst = !exportCanvasFirst;
      try { localStorage.setItem('skfe_export_canvas_first_v1', exportCanvasFirst ? '1' : '0'); } catch (_) {}
      syncExportCanvasFirstBtn();
    });
  }

  function syncCanvasMaskUI() {
    if (!canvasMaskCheckbox) return;
    canvasMaskCheckbox.checked = canvasMaskEnabled;
    
    if (canvasMaskAlphaRow) canvasMaskAlphaRow.style.display = canvasMaskEnabled ? 'flex' : 'none';
    
    // 内部直接获取，避免外部变量未声明引发的崩溃
    const colorRow = document.getElementById('canvasMaskColorRow');
    if (colorRow) colorRow.style.display = canvasMaskEnabled ? 'flex' : 'none';
    
    const alphaInput = document.getElementById('canvasMaskAlpha');
    if (alphaInput) {
      alphaInput.value = canvasMaskAlpha;
      const alphaVal = document.getElementById('canvasMaskAlphaVal');
      if (alphaVal) alphaVal.textContent = canvasMaskAlpha.toFixed(2);
    }

    const bgColorInput = document.getElementById('canvasMaskBgColor');
    if (bgColorInput) bgColorInput.value = canvasMaskBgColor;

    const gridColorInput = document.getElementById('canvasMaskGridColor');
    if (gridColorInput) gridColorInput.value = canvasMaskGridColor;
  }

  btnToggleCanvasBounds.onclick = () => {
    AppState.canvasBoundsEnabled = !AppState.canvasBoundsEnabled;
    btnToggleCanvasBounds.classList.toggle('on', AppState.canvasBoundsEnabled);
    btnToggleCanvasBounds.textContent = AppState.canvasBoundsEnabled ? tr2('bounds.off', '关闭画布边界') : tr2('bounds.on', '开启画布边界');
    canvasSliders.style.display = AppState.canvasBoundsEnabled ? 'block' : 'none';
    if (AppState.canvasBoundsEnabled) {
      const bbox = computeAllFramesBounds();
      if (bbox) {
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;
        const side = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 100) * 1.2;
        AppState.canvasBounds = { x: cx - side / 2, y: cy - side / 2, w: side, h: side, rotation: 0 };
      }
      canvasBaseBounds = { ...AppState.canvasBounds };
      /* 新增：开启边界时，自动选中画布，这样变换框会直接弹出来 */
      AppState.canvasSelected = true;
      AppState.selected = null; 
      syncCanvasUI();
      syncCanvasMaskUI();
    } else {
      AppState.canvasSelected = false;
    }
    EventBus.emit('need:syncUI'); /* 新增：刷新面板，确保变换框按钮正确亮起 */
    EventBus.emit('need:render');
    EventBus.emit('history:save', '切换画布边界');
  };

  if (canvasMaskCheckbox) {
    canvasMaskCheckbox.addEventListener('change', e => {
      canvasMaskEnabled = e.target.checked;
      canvasMaskAlphaRow.style.display = canvasMaskEnabled ? 'flex' : 'none';
      EventBus.emit('need:render');
      EventBus.emit('history:save', '切换画布遮罩'); // 新增：记录撤销
    });
  }
  if (canvasMaskAlphaInput) {
    canvasMaskAlphaInput.addEventListener('input', e => {
      canvasMaskAlpha = +e.target.value;
      canvasMaskAlphaVal.textContent = canvasMaskAlpha.toFixed(2);
      EventBus.emit('need:render');
    });
  }

  const canvasMaskBgColorEl = document.getElementById('canvasMaskBgColor');
  const canvasMaskGridColorEl = document.getElementById('canvasMaskGridColor');

  if (canvasMaskBgColorEl) {
    canvasMaskBgColorEl.addEventListener('input', e => {
      canvasMaskBgColor = e.target.value;
      EventBus.emit('need:render');
    });
    canvasMaskBgColorEl.addEventListener('change', () => EventBus.emit('history:save', '修改遮罩颜色'));
  }
  if (canvasMaskGridColorEl) {
    canvasMaskGridColorEl.addEventListener('input', e => {
      canvasMaskGridColor = e.target.value;
      EventBus.emit('need:render');
    });
    canvasMaskGridColorEl.addEventListener('change', () => EventBus.emit('history:save', '修改网格颜色'));
  }

  document.querySelectorAll('.canvas-ratio-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!AppState.canvasBoundsEnabled) return;
      const ratioStr = btn.dataset.ratio;
      let r = 1;
      if (ratioStr === '16:9') r = 16 / 9;
      else if (ratioStr === '4:3') r = 4 / 3;
      else if (ratioStr === '9:16') r = 9 / 16;
      AppState.canvasBounds.h = AppState.canvasBounds.w / r;
      canvasBaseBounds = { ...AppState.canvasBounds };
      syncCanvasUI();
      EventBus.emit('need:render');
      EventBus.emit('history:save', '设置画布比例');
    });
  });

  const btnCenterCanvas = document.getElementById('btnCenterCanvas');
  if (btnCenterCanvas) {
    btnCenterCanvas.addEventListener('click', () => {
      if (!AppState.canvasBoundsEnabled) { alert(tr2('alert.boundsFirst', '请先开启画布边界')); return; }

      // ① 用 getComputedStyle 判断可见性（能识别 CSS display:none 的初始状态）
      const timelineVisible = getComputedStyle(timelineEl).display !== 'none';
      const uiRect = uiPanel.getBoundingClientRect();
      const timelineRect = timelineEl.getBoundingClientRect();

      let availLeft = 0, availRight = window.innerWidth;
      let availTop = 0, availBottom = window.innerHeight;

      // ② 左侧 / 底部 UI 面板占位
      if (isMobile) {
        /* v7.3.0：面板不会再整块隐藏（全关也留着底部栏），uiRect.top 就是它真正的上沿 ——
           全关时是那条栏的顶，展开时是半屏线，两种都对，直接取最小值即可。 */
        availBottom = Math.min(availBottom, uiRect.top);
      } else {
        availLeft = Math.max(availLeft, uiRect.right);
      }

      // ③ 时间轴可能置顶也可能置底，两种情况都要避让
      if (timelineVisible) {
        if (timelineDock === 'top') {
          availTop = Math.max(availTop, timelineRect.bottom);
        } else {
          availBottom = Math.min(availBottom, timelineRect.top);
        }
      }

      // ④ 加个安全下限，避免用户拉出畸形布局时缩放到 0
      const availW = Math.max(80, availRight - availLeft);
      const availH = Math.max(80, availBottom - availTop);

      const targetW = availW * 0.9;
      const targetH = availH * 0.9;
      const newScale = Math.min(targetW / AppState.canvasBounds.w, targetH / AppState.canvasBounds.h);
      AppState.viewScale = Math.max(VIEW_SCALE_MIN, Math.min(VIEW_SCALE_MAX, newScale));

      const cbCx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
      const cbCy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;

      AppState.viewOffset.x = (availLeft + availW / 2) - cbCx * AppState.viewScale;
      AppState.viewOffset.y = (availTop  + availH / 2) - cbCy * AppState.viewScale;

      if (viewPinned && pinnedView) {
        pinnedView.offset.x = AppState.viewOffset.x;
        pinnedView.offset.y = AppState.viewOffset.y;
        pinnedView.scale = AppState.viewScale;
      }

      EventBus.emit('need:render');
      EventBus.emit('history:save', '复位画布');
    });
  }

  const btnPinView = document.getElementById('btnPinView');
  function syncPinViewBtn() {
    if (!btnPinView) return;
    btnPinView.classList.toggle('on', viewPinned);
    { const pinKey = viewPinned ? 'pin.pinned' : 'pin.pin'; const pinTxt = viewPinned ? tr2('pin.pinned', '已固定') : tr2('pin.pin', '固定'); btnPinView.innerHTML = ic('pushpin') + '<span data-i18n="' + pinKey + '">' + pinTxt + '</span>'; }
  }
  if (btnPinView) {
    btnPinView.addEventListener('click', () => {
      if (!viewPinned) {
        viewPinned = true;
        pinnedView = {
          offset: { x: AppState.viewOffset.x, y: AppState.viewOffset.y },
          scale: AppState.viewScale
        };
      } else {
        viewPinned = false;
        pinnedView = null;
      }
      syncPinViewBtn();
      EventBus.emit('need:render');
    });
  }

  /* ==================== 控件引用 ==================== */
  const colorInput = document.getElementById('color');
  const lwInput = document.getElementById('lw');
  const lwVal = document.getElementById('lwVal');
  const btnHeadFill = document.getElementById('btnHeadFill');
  /* v6.4.0：头型切换按钮组（只有火柴人显示） */
  const headShapeRow = document.getElementById('headShapeRow');
  const headShapeBtns = Array.from(document.querySelectorAll('.head-shape-btn'));
  const headFillCustomCheckbox = document.getElementById('headFillCustom');
  const headFillColorInput = document.getElementById('headFillColor');
  const btnLight = document.getElementById('btnLight');
  const lightColorInput = document.getElementById('lightColor');
  const lightSizeInput = document.getElementById('lightSize');
  const lightSizeVal = document.getElementById('lightSizeVal');
  const lightAngleInput = document.getElementById('lightAngle');
  const lightAngleVal = document.getElementById('lightAngleVal');
  const headInput = document.getElementById('headSize');
  const headVal = document.getElementById('headVal');
  const armInput = document.getElementById('armLen');
  const armVal = document.getElementById('armVal');
  const legInput = document.getElementById('legLen');
  const legVal = document.getElementById('legVal');
  const torsoInput = document.getElementById('torsoLen');
  const torsoVal = document.getElementById('torsoVal');
  const foreArmRatioInput = document.getElementById('foreArmRatio');
  const foreArmRatioVal = document.getElementById('foreArmRatioVal');
  const shinRatioInput = document.getElementById('shinRatio');
  const shinRatioVal = document.getElementById('shinRatioVal');
  const limbIndepCheckbox = document.getElementById('limbIndep');
  const limbIndepPanel = document.getElementById('limbIndepPanel');
  const armLenLInput = document.getElementById('armLenL');
  const armLenLVal = document.getElementById('armLenLVal');
  const armLenRInput = document.getElementById('armLenR');
  const armLenRVal = document.getElementById('armLenRVal');
  const foreArmRatioLInput = document.getElementById('foreArmRatioL');
  const foreArmRatioLVal = document.getElementById('foreArmRatioLVal');
  const foreArmRatioRInput = document.getElementById('foreArmRatioR');
  const foreArmRatioRVal = document.getElementById('foreArmRatioRVal');
  const legLenLInput = document.getElementById('legLenL');
  const legLenLVal = document.getElementById('legLenLVal');
  const legLenRInput = document.getElementById('legLenR');
  const legLenRVal = document.getElementById('legLenRVal');
  const shinRatioLInput = document.getElementById('shinRatioL');
  const shinRatioLVal = document.getElementById('shinRatioLVal');
  const shinRatioRInput = document.getElementById('shinRatioR');
  const shinRatioRVal = document.getElementById('shinRatioRVal');
  const btnExtremity = document.getElementById('btnExtremity');
  const armExtRatio = document.getElementById('armExtRatio');
  const armExtRatioVal = document.getElementById('armExtRatioVal');
  const legExtRatio = document.getElementById('legExtRatio');
  const legExtRatioVal = document.getElementById('legExtRatioVal');
  const objXInput = document.getElementById('objX');
  const objYInput = document.getElementById('objY');
  const objSizeInput = document.getElementById('objSizeInput');
  const posRotSlider = document.getElementById('posRotSlider');
  const posScaleSlider = document.getElementById('posScaleSlider');
  const objNameInput = document.getElementById('objNameInput');
  const objRotationInput = document.getElementById('objRotation');
  const objRotationVal = document.getElementById('objRotationVal');
  const jointStretchToggle = document.getElementById('jointStretchToggle');
  const btnAnchorToggle = document.getElementById('btnAnchorToggle');
  const objAnchorRow = document.getElementById('objAnchorRow');
  const objAnchorX = document.getElementById('objAnchorX');
  const objAnchorY = document.getElementById('objAnchorY');
  const btnAnchorCenter = document.getElementById('btnAnchorCenter');
  const anchorHandleEl = document.getElementById('anchorHandle');
  let anchorHandleDrag = null;
  const btnGlow = document.getElementById('btnGlow');
  const glowColor = document.getElementById('glowColor');
  const glowAlpha = document.getElementById('glowAlpha');
  const glowAlphaVal = document.getElementById('glowAlphaVal');
  const glowBlur = document.getElementById('glowBlur');
  const glowBlurVal = document.getElementById('glowBlurVal');
  /* v7.2.0：描边阴影 —— 偏移 / 扩展 */
  const glowOffsetX = document.getElementById('glowOffsetX');
  const glowOffsetXVal = document.getElementById('glowOffsetXVal');
  const glowOffsetY = document.getElementById('glowOffsetY');
  const glowOffsetYVal = document.getElementById('glowOffsetYVal');
  const glowSpread = document.getElementById('glowSpread');
  const glowSpreadVal = document.getElementById('glowSpreadVal');
  const glowIncludeAcc = document.getElementById('glowIncludeAcc');

  /* 老工程里没有 offsetX / offsetY / spread 三个字段，统一在这里补 0，
     免得每个读的地方都写 || 0。 */
  function glowFill(g) {
    if (!g) return g;
    if (g.color == null) g.color = '#000000';
    if (g.alpha == null) g.alpha = 0.45;
    if (g.blur == null) g.blur = 14;
    if (g.offsetX == null) g.offsetX = 0;
    if (g.offsetY == null) g.offsetY = 0;
    if (g.spread == null) g.spread = 0;
    if (g.includeAcc == null) g.includeAcc = false;
    return g;
  }

  /* v7.2.1：地面阴影默认值。这些字段以前是工程级全局量，老工程加载时会统一迁移到火柴人身上
     （见 migrateGroundShadowToFigures），迁移后仍缺字段的（比如更老的存档）在这里兜底。 */
  function shadowFill(f) {
    if (!f) return f;
    if (f.shadowEnabled === undefined) f.shadowEnabled = false;
    if (f.shadowColor == null) f.shadowColor = '#000000';
    if (f.shadowAlpha == null) f.shadowAlpha = 0.3;
    if (f.shadowOffX == null) f.shadowOffX = 0;
    if (f.shadowOffY == null) f.shadowOffY = 0;
    if (f.shadowScaleX == null) f.shadowScaleX = 1;
    if (f.shadowScaleY == null) f.shadowScaleY = 1;
    return f;
  }
  const btnJoint = document.getElementById('btnJoint');
  const jointColor = document.getElementById('jointColor');
  const jointLen = document.getElementById('jointLen');
  const jointLenVal = document.getElementById('jointLenVal');
  const shapePanel = document.getElementById('shapePanel');
  const shapeWInput = document.getElementById('shapeW');
  const shapeWVal = document.getElementById('shapeWVal');
  const shapeHInput = document.getElementById('shapeH');
  const shapeHVal = document.getElementById('shapeHVal');
  const shapeFill = document.getElementById('shapeFill');
  const shapeStroke = document.getElementById('shapeStroke');
  const shapeLW = document.getElementById('shapeLW');
  const shapeLWVal = document.getElementById('shapeLWVal');
  const bubblePanel = document.getElementById('bubblePanel');
  const bubbleText = document.getElementById('bubbleText');
  const bubbleMirrorCheckbox = document.getElementById('bubbleMirror');
  const bubbleFontSizeInput = document.getElementById('bubbleFontSize');
  const bubbleFontSizeVal = document.getElementById('bubbleFontSizeVal');
  const bubbleTextColor = document.getElementById('bubbleTextColor');
  const bubbleGradientCheckbox = document.getElementById('bubbleGradientCheckbox');
  const bubbleGradientRow = document.getElementById('bubbleGradientRow');
  const bubbleGradientColor = document.getElementById('bubbleGradientColor');
  const bubbleBgColor = document.getElementById('bubbleBgColor');
  const bubbleStrokeColor = document.getElementById('bubbleStrokeColor');
  const bubbleStrokeWidthInput = document.getElementById('bubbleStrokeWidth');
  const bubbleStrokeWidthVal = document.getElementById('bubbleStrokeWidthVal');
  const bubbleCustomSizeCheckbox = document.getElementById('bubbleCustomSize');
  const bubbleSizeRow = document.getElementById('bubbleSizeRow');
  const bubbleWInput = document.getElementById('bubbleW');
  const bubbleWVal = document.getElementById('bubbleWVal');
  const bubbleHInput = document.getElementById('bubbleH');
  const bubbleHVal = document.getElementById('bubbleHVal');
  const bindPanel = document.getElementById('bindPanel');
  const accBind = document.getElementById('accBind');
  const objPanel = document.getElementById('objPanel');
  const objScale = document.getElementById('objScale');
  const objScaleVal = document.getElementById('objScaleVal');
  const objAlpha = document.getElementById('objAlpha');
  const objAlphaVal = document.getElementById('objAlphaVal');
  const btnUp = document.getElementById('btnUp');
  const btnDown = document.getElementById('btnDown');
  const btnTop = document.getElementById('btnTop');
  const btnBottom = document.getElementById('btnBottom');
  const statusHead = document.getElementById('statusHead');
  const statusArmL = document.getElementById('statusArmL');
  const statusArmR = document.getElementById('statusArmR');
  const statusLegL = document.getElementById('statusLegL');
  const statusLegR = document.getElementById('statusLegR');
  const btnPinFootL = document.getElementById('btnPinFootL');
  const btnPinFootR = document.getElementById('btnPinFootR');
  const btnPinPelvis = document.getElementById('btnPinPelvis');
  const btnPinHandL = document.getElementById('btnPinHandL');
  const btnPinHandR = document.getElementById('btnPinHandR');
  const ikMasterEnable = document.getElementById('ikMasterEnable');
  const depthEnabledInput = document.getElementById('depthEnabled');
  const depthCustomInput = document.getElementById('depthCustom');
  const depthColorInput = document.getElementById('depthColor');

  document.getElementById('globalEdit').addEventListener('change', e => { globalEditEnabled = e.target.checked; });
  
  const globalEditHelpBtn = document.getElementById('globalEditHelpBtn');
  const globalEditHelpBox = document.getElementById('globalEditHelpBox');
  if (globalEditHelpBtn && globalEditHelpBox) {
    globalEditHelpBtn.addEventListener('click', () => {
      const isOpen = globalEditHelpBox.style.display !== 'none';
      globalEditHelpBox.style.display = isOpen ? 'none' : 'block';
    });
  }
  
  /* ==================== 对象重命名 ==================== */
  function syncObjNameInput() {
    if (!objNameInput) return;
    if (!AppState.selected) {
      objNameInput.value = '';
      objNameInput.disabled = true;
      return;
    }
    objNameInput.disabled = false;
    if (document.activeElement !== objNameInput) {
      objNameInput.value = AppState.selected.name || '';
    }
  }

  if (objNameInput) {
    objNameInput.addEventListener('input', () => {
      if (!AppState.selected) return;
      const newName = objNameInput.value.slice(0, 24);
      AppState.selected.name = newName;
      const tid = String(AppState.selected.id);
      const t = AppState.tracks[tid];
      if (t) {
        t.name = newName || tid;
        for (const data of t.frames) {
          if (data) data.name = newName;
        }
      }
      refreshSubTrackOptions();
      updateCoordDisplay();
      /* name-v5.1.1: 图层列表即时显示新名称（图片/配饰等所有类型通用） */
      updateLayerList();
    });
    objNameInput.addEventListener('change', () => {
      if (AppState.selected) EventBus.emit('history:save', '重命名对象');
    });
  }

  /* ==================== 深度 / IK ==================== */
  depthEnabledInput.addEventListener('change', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      if (!AppState.selected.depth) AppState.selected.depth = { enabled: false, useCustom: false, customColor: '#555555' };
      AppState.selected.depth.enabled = e.target.checked;
      setGlobalProp(AppState.selected, 'depth.enabled', AppState.selected.depth.enabled);
      markCurrentFrameModified();
      EventBus.emit('need:render');
      EventBus.emit('history:save', '切换深色处理');
    }
  });
  depthCustomInput.addEventListener('change', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      if (!AppState.selected.depth) AppState.selected.depth = { enabled: false, useCustom: false, customColor: '#555555' };
      AppState.selected.depth.useCustom = e.target.checked;
      depthColorInput.disabled = !AppState.selected.depth.useCustom;
      setGlobalProp(AppState.selected, 'depth.useCustom', AppState.selected.depth.useCustom);
      markCurrentFrameModified();
      EventBus.emit('need:render');
      EventBus.emit('history:save', '自定义深色');
    }
  });
  depthColorInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      if (!AppState.selected.depth) AppState.selected.depth = { enabled: false, useCustom: false, customColor: '#555555' };
      AppState.selected.depth.customColor = e.target.value;
      setGlobalProp(AppState.selected, 'depth.customColor', AppState.selected.depth.customColor);
      markCurrentFrameModified();
      EventBus.emit('need:render');
    }
  });
  depthColorInput.addEventListener('change', () => EventBus.emit('history:save', '修改深色颜色'));

  ikMasterEnable.addEventListener('change', e => {
  if (!AppState.selected || AppState.selected.type !== 'figure') return;
  const newIK = e.target.checked;
  AppState.selected.ikEnabled = newIK;
  if (!newIK) {
    AppState.selected.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
    AppState.selected.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
  }
  if (globalEditEnabled) {
    const tid = String(AppState.selected.id);
    const t = AppState.tracks[tid];
    if (t && t.frames) {
      for (let i = 0; i < t.frames.length; i++) {
        if (i === AppState.currentFrameIndex) continue;
        const data = t.frames[i];
        if (!data || String(data.id) !== tid) continue;
        data.ikEnabled = newIK;
        if (!newIK) {
          data.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
          data.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
        }
      }
    }
  }
  EventBus.emit('need:syncUI');
  markCurrentFrameModified();
  invalidateAllFrameThumbs();
  EventBus.emit('need:render');
  EventBus.emit('history:save', '切换关节固定');
});

function togglePin(part) {
  if (!AppState.selected || AppState.selected.type !== 'figure' || !AppState.selected.ikEnabled) return;
  if (!AppState.selected.pinned) AppState.selected.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
  if (!AppState.selected.pinnedPos) AppState.selected.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
  const newState = !AppState.selected.pinned[part];
  const tid = String(AppState.selected.id);
  const readPos = (jd, p) => {
    if (p === 'footL') return { x: jd.footL.x, y: jd.footL.y };
    if (p === 'footR') return { x: jd.footR.x, y: jd.footR.y };
    if (p === 'handL') return { x: jd.handL.x, y: jd.handL.y };
    if (p === 'handR') return { x: jd.handR.x, y: jd.handR.y };
    return { x: jd.pelvis.x, y: jd.pelvis.y };
  };
  if (newState) {
    const j = jointData(AppState.selected);
    AppState.selected.pinned[part] = true;
    AppState.selected.pinnedPos[part] = readPos(j, part);
  } else {
    AppState.selected.pinned[part] = false;
    AppState.selected.pinnedPos[part] = null;
  }
  if (globalEditEnabled) {
    const t = AppState.tracks[tid];
    if (t && t.frames) {
      for (let i = 0; i < t.frames.length; i++) {
        if (i === AppState.currentFrameIndex) continue;
        const data = t.frames[i];
        if (!data || String(data.id) !== tid) continue;
        if (!data.ikEnabled) data.ikEnabled = true;
        if (!data.pinned) data.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
        if (!data.pinnedPos) data.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
        if (newState) {
          const dj = jointData(data);
          data.pinned[part] = true;
          data.pinnedPos[part] = readPos(dj, part);
        } else {
          data.pinned[part] = false;
          data.pinnedPos[part] = null;
        }
      }
    }
  }
  EventBus.emit('need:syncUI');
  invalidateAllFrameThumbs();
  EventBus.emit('need:render');
  EventBus.emit('history:save', '固定关节');
}

  btnPinFootL.onclick = () => togglePin('footL');
  btnPinFootR.onclick = () => togglePin('footR');
  btnPinPelvis.onclick = () => togglePin('pelvis');
  btnPinHandL.onclick = () => togglePin('handL');
  btnPinHandR.onclick = () => togglePin('handR');

  /* ==================== 肢体状态 ==================== */
  function updateLimbStatus() {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    statusHead.textContent = AppState.selected.layer.head;
    const statusBody = document.getElementById('statusBody');
    if (statusBody) statusBody.textContent = AppState.selected.layer.body;
    statusArmL.textContent = AppState.selected.layer.armL;
    statusArmR.textContent = AppState.selected.layer.armR;
    statusLegL.textContent = AppState.selected.layer.legL;
    statusLegR.textContent = AppState.selected.layer.legR;
  }

  /* ==================== UI 同步 ==================== */
  function updateAnchorUI() {
    if (!AppState.selected || (AppState.selected.type !== 'image' && AppState.selected.type !== 'acc' && AppState.selected.type !== 'shape' && AppState.selected.type !== 'bubble')) {
      btnAnchorToggle.style.display = 'none';
      objAnchorRow.style.display = 'none';
      anchorModeOn = false;
      btnAnchorToggle.classList.remove('on');
      return;
    }
    btnAnchorToggle.style.display = '';
    btnAnchorToggle.classList.toggle('on', anchorModeOn);
    objAnchorRow.style.display = anchorModeOn ? 'flex' : 'none';
    if (document.activeElement !== objAnchorX) objAnchorX.value = Math.round(AppState.selected.ax || 0);
    if (document.activeElement !== objAnchorY) objAnchorY.value = Math.round(AppState.selected.ay || 0);
  }

  function syncUI() {
    const isFig = AppState.selected && AppState.selected.type === 'figure';
    const isAcc = AppState.selected && AppState.selected.type === 'acc';
    const isShape = AppState.selected && AppState.selected.type === 'shape';
    const isBubble = AppState.selected && AppState.selected.type === 'bubble';
    const isInk = AppState.selected && AppState.selected.type === 'ink'; // brush-v5.1.0
    const isCamera = AppState.selected && AppState.selected.type === 'camera';
    const hasSel = !!AppState.selected;
    const hasCanvasSel = AppState.canvasSelected && AppState.canvasBoundsEnabled && !AppState.selected;
    const isIndep = !!(isFig && AppState.selected.bodyScale.armL !== undefined);

    document.getElementById('btnSavePreset').disabled = !isFig;
    document.getElementById('presetNameInput').disabled = !isFig;
    colorInput.disabled = !isFig;
    lwInput.disabled = !isFig;
    btnHeadFill.disabled = !isFig;
    /* v6.4.0：头型行只对火柴人出现 */
    if (headShapeRow) headShapeRow.style.display = isFig ? 'flex' : 'none';
    if (headFillCustomCheckbox) headFillCustomCheckbox.disabled = !isFig;
    if (headFillColorInput) headFillColorInput.disabled = !isFig || !(isFig && AppState.selected.headFillCustom);
    btnLight.disabled = !isFig;
    lightColorInput.disabled = !isFig;
    lightSizeInput.disabled = !isFig;
    lightAngleInput.disabled = !isFig;
    btnExtremity.disabled = !isFig;
    armExtRatio.disabled = !isFig;
    legExtRatio.disabled = !isFig;
    foreArmRatioInput.disabled = !isFig || isIndep;
    shinRatioInput.disabled = !isFig || isIndep;
    armInput.disabled = !isFig || isIndep;
    legInput.disabled = !isFig || isIndep;
    headInput.disabled = !isFig;
    torsoInput.disabled = !isFig;
    btnGlow.disabled = !isFig;
    glowColor.disabled = !isFig;
    glowAlpha.disabled = !isFig;
    glowBlur.disabled = !isFig;
    if (glowOffsetX) glowOffsetX.disabled = !isFig;
    if (glowOffsetY) glowOffsetY.disabled = !isFig;
    if (glowSpread) glowSpread.disabled = !isFig;
    if (glowIncludeAcc) glowIncludeAcc.disabled = !isFig;
    btnJoint.disabled = !isFig;
    jointColor.disabled = !isFig;
    jointLen.disabled = !isFig;
    limbIndepCheckbox.disabled = !isFig;
    limbIndepCheckbox.checked = isIndep;
    limbIndepPanel.style.display = isIndep ? 'block' : 'none';
    [armLenLInput, armLenRInput, foreArmRatioLInput, foreArmRatioRInput,
     legLenLInput, legLenRInput, shinRatioLInput, shinRatioRInput].forEach(el => el.disabled = !isFig || !isIndep);

    depthEnabledInput.disabled = !isFig;
    depthCustomInput.disabled = !isFig;
    if (isFig) {
      const d = AppState.selected.depth || { enabled: false, useCustom: false, customColor: '#555555' };
      depthEnabledInput.checked = d.enabled;
      depthCustomInput.checked = d.useCustom;
      depthColorInput.value = d.customColor;
      depthColorInput.disabled = !d.useCustom;
    } else {
      depthEnabledInput.checked = false;
      depthCustomInput.checked = false;
      depthColorInput.disabled = true;
    }

    ikMasterEnable.disabled = !isFig;
    if (isFig) {
      ikMasterEnable.checked = !!AppState.selected.ikEnabled;
      btnPinFootL.disabled = !AppState.selected.ikEnabled;
      btnPinFootR.disabled = !AppState.selected.ikEnabled;
      btnPinPelvis.disabled = !AppState.selected.ikEnabled;
      btnPinHandL.disabled = !AppState.selected.ikEnabled;
      btnPinHandR.disabled = !AppState.selected.ikEnabled;
    } else {
      ikMasterEnable.checked = false;
      btnPinFootL.disabled = true;
      btnPinFootR.disabled = true;
      btnPinPelvis.disabled = true;
      btnPinHandL.disabled = true;
      btnPinHandR.disabled = true;
    }

    if (isFig && AppState.selected.pinned) {
      btnPinFootL.classList.toggle('on', AppState.selected.pinned.footL);
      btnPinFootR.classList.toggle('on', AppState.selected.pinned.footR);
      btnPinPelvis.classList.toggle('on', AppState.selected.pinned.pelvis);
      btnPinHandL.classList.toggle('on', AppState.selected.pinned.handL);
      btnPinHandR.classList.toggle('on', AppState.selected.pinned.handR);
    } else {
      btnPinFootL.classList.remove('on');
      btnPinFootR.classList.remove('on');
      btnPinPelvis.classList.remove('on');
      btnPinHandL.classList.remove('on');
      btnPinHandR.classList.remove('on');
    }

    shadowScaleXInput.disabled = !isFig;
    shadowScaleYInput.disabled = !isFig;
    /* v7.2.1：地面阴影现在是每个火柴人自己的属性，非火柴人时整组禁用 */
    if (btnGroundShadow) btnGroundShadow.disabled = !isFig;
    if (shadowColorInput) shadowColorInput.disabled = !isFig;
    if (shadowAlphaInput) shadowAlphaInput.disabled = !isFig;
    if (isFig) {
      const sSx = AppState.selected.shadowScaleX || 1;
      const sSy = AppState.selected.shadowScaleY || 1;
      shadowScaleXInput.value = sSx; shadowScaleXVal.textContent = sSx.toFixed(2);
      shadowScaleYInput.value = sSy; shadowScaleYVal.textContent = sSy.toFixed(2);
    } else {
      shadowScaleXInput.value = 1; shadowScaleXVal.textContent = '1.00';
      shadowScaleYInput.value = 1; shadowScaleYVal.textContent = '1.00';
    }

    shapePanel.style.display = isShape ? 'block' : 'none';
    if (isShape) {
      shapeWInput.value = AppState.selected.w; shapeWVal.textContent = AppState.selected.w;
      shapeHInput.value = AppState.selected.h; shapeHVal.textContent = AppState.selected.h;
      shapeFill.value = AppState.selected.fillColor;
      shapeStroke.value = AppState.selected.strokeColor;
      shapeLW.value = AppState.selected.strokeWidth;
      shapeLWVal.textContent = AppState.selected.strokeWidth;
    }

    bubblePanel.style.display = isBubble ? 'block' : 'none';
    if (isBubble) {
      if (AppState.selected.isMirrored === undefined) AppState.selected.isMirrored = false;
      if (AppState.selected.customSize === undefined) AppState.selected.customSize = false;
      if (AppState.selected.customW === undefined) AppState.selected.customW = Math.round(AppState.selected.w || 180);
      if (AppState.selected.customH === undefined) AppState.selected.customH = Math.round(AppState.selected.h || 90);
      bubbleText.value = AppState.selected.text;
      bubbleMirrorCheckbox.checked = AppState.selected.isMirrored;
      bubbleFontSizeInput.value = AppState.selected.fontSize; bubbleFontSizeVal.textContent = AppState.selected.fontSize;
      bubbleTextColor.value = AppState.selected.textColor;
      bubbleGradientCheckbox.checked = AppState.selected.isGradient;
      bubbleGradientRow.style.display = AppState.selected.isGradient ? 'flex' : 'none';
      bubbleGradientColor.value = AppState.selected.gradientColor;
      bubbleBgColor.value = AppState.selected.fillColor;
      bubbleStrokeColor.value = AppState.selected.strokeColor;
      bubbleStrokeWidthInput.value = AppState.selected.strokeWidth; bubbleStrokeWidthVal.textContent = AppState.selected.strokeWidth;
      bubbleCustomSizeCheckbox.checked = AppState.selected.customSize;
      bubbleSizeRow.style.display = AppState.selected.customSize ? 'block' : 'none';
      bubbleWInput.value = AppState.selected.customW; bubbleWVal.textContent = AppState.selected.customW;
      bubbleHInput.value = AppState.selected.customH; bubbleHVal.textContent = AppState.selected.customH;
    }

    const camPanelEl = document.getElementById('cameraPanel');
    if (camPanelEl) camPanelEl.style.display = isCamera ? 'block' : 'none';
    if (isCamera) {
      const ratio = AppState.selected.w / Math.max(1, AppState.selected.h);
      document.querySelectorAll('.camera-ratio-btn').forEach(b => {
        const parts = (b.dataset.ratio || '').split(':').map(Number);
        const r = parts[0] / Math.max(1, parts[1]);
        b.classList.toggle('on', Math.abs(r - ratio) < 0.02);
      });
    }
    /* eraser 面板已打包为 tool-panel[data-tool="eraser"]，显示由 updateToolVisibility 统一控制 */

    const showBindPanel = (isAcc || isShape || isInk) && !isCamera; // brush-v5.1.0: §6.3.5
    bindPanel.style.display = showBindPanel ? 'block' : 'none';
    if (showBindPanel) {
      updateTargetFigureOptions();
      accBind.value = AppState.selected.bindTo;
    }

    updateToolVisibility(isFig, hasSel, isCamera);
    if (isFig) {
      if (!AppState.selected.light) AppState.selected.light = { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 };
      if (AppState.selected.light.size === undefined) AppState.selected.light.size = 1.0;
      if (AppState.selected.light.angle === undefined) AppState.selected.light.angle = 315;
      ensureExtremity(AppState.selected);
// 透视面板同步（v5.7：头/尾倍率模型，骨盆/脖子两端自动同步）
const sp = AppState.selected.spatial || { strength: 0, lines: SKFE.systems.spatial.defaultLines() };
ensureSpatialLines(AppState.selected);
const sEl = document.getElementById('spatialStrength');
if (sEl) {
  sEl.value = sp.strength || 0;
  const sVal = document.getElementById('spatialStrengthVal');
  if (sVal) sVal.textContent = (sp.strength || 0).toFixed(2);
}
const spatialGroupVals = spatialReadGroups(AppState.selected);
['pelvis', 'neck', 'handL', 'handR', 'footL', 'footR'].forEach(g => {
  const inp = document.getElementById('sp' + g.charAt(0).toUpperCase() + g.slice(1));
  if (!inp) return;
  inp.value = spatialGroupVals[g];
  const lbl = document.getElementById('sp' + g.charAt(0).toUpperCase() + g.slice(1) + 'Val');
  if (lbl) lbl.textContent = spatialGroupVals[g].toFixed(2);
});
      updateLimbStatus();
      colorInput.value = AppState.selected.color;
      lwInput.value = AppState.selected.lw; lwVal.textContent = (+AppState.selected.lw).toFixed(1);
      lightColorInput.value = AppState.selected.light.color;
      lightSizeInput.value = AppState.selected.light.size; lightSizeVal.textContent = AppState.selected.light.size.toFixed(1);
      lightAngleInput.value = AppState.selected.light.angle; lightAngleVal.textContent = AppState.selected.light.angle + '°';
      btnLight.textContent = AppState.selected.light.enabled ? tr2('light.off', '关闭侧面高光') : tr2('light.on', '开启侧面高光');
      btnLight.classList.toggle('on', AppState.selected.light.enabled);
      btnExtremity.textContent = AppState.selected.extremity.enabled ? tr2('ext.off', '关闭小手小脚') : tr2('ext.on', '开启小手小脚');
      btnExtremity.classList.toggle('on', AppState.selected.extremity.enabled);
      // 控制手腕脚踝面板显隐
      document.querySelectorAll('.ext-joint-row').forEach(el => {
        el.style.display = AppState.selected.extremity.enabled ? 'flex' : 'none';
      });
      // 如果小手小脚关了，且当前隔离的是手臂/腿部（包含了手腕脚踝），清空高亮防止错乱
      if (!AppState.selected.extremity.enabled) {
        if (isolatedJointName) {
          // 实际上关掉小手小脚不影响整条手臂/腿的高亮，只是少了 ext 节点
        }
      }
      syncJointButtonsUI();
      armExtRatio.value = AppState.selected.extremity.armRatio;
      armExtRatioVal.textContent = AppState.selected.extremity.armRatio.toFixed(2);
      legExtRatio.value = AppState.selected.extremity.legRatio;
      legExtRatioVal.textContent = AppState.selected.extremity.legRatio.toFixed(2);

      headInput.value = AppState.selected.bodyScale.head; headVal.textContent = AppState.selected.bodyScale.head.toFixed(2);
      armInput.value = AppState.selected.bodyScale.arm; armVal.textContent = AppState.selected.bodyScale.arm.toFixed(2);
      legInput.value = AppState.selected.bodyScale.leg; legVal.textContent = AppState.selected.bodyScale.leg.toFixed(2);
      torsoInput.value = AppState.selected.bodyScale.torso; torsoVal.textContent = AppState.selected.bodyScale.torso.toFixed(2);
      const fa = AppState.selected.bodyScale.foreArm !== undefined ? AppState.selected.bodyScale.foreArm : 0.37;
      foreArmRatioInput.value = fa; foreArmRatioVal.textContent = fa.toFixed(2);
      const sh = AppState.selected.bodyScale.shin !== undefined ? AppState.selected.bodyScale.shin : 0.49;
      shinRatioInput.value = sh; shinRatioVal.textContent = sh.toFixed(2);
      const bs = AppState.selected.bodyScale;
      armLenLInput.value = isIndep ? bs.armL : bs.arm; armLenLVal.textContent = (+armLenLInput.value).toFixed(2);
      armLenRInput.value = isIndep ? bs.armR : bs.arm; armLenRVal.textContent = (+armLenRInput.value).toFixed(2);
      foreArmRatioLInput.value = isIndep ? bs.foreArmL : fa; foreArmRatioLVal.textContent = (+foreArmRatioLInput.value).toFixed(2);
      foreArmRatioRInput.value = isIndep ? bs.foreArmR : fa; foreArmRatioRVal.textContent = (+foreArmRatioRInput.value).toFixed(2);
      legLenLInput.value = isIndep ? bs.legL : bs.leg; legLenLVal.textContent = (+legLenLInput.value).toFixed(2);
      legLenRInput.value = isIndep ? bs.legR : bs.leg; legLenRVal.textContent = (+legLenRInput.value).toFixed(2);
      shinRatioLInput.value = isIndep ? bs.shinL : sh; shinRatioLVal.textContent = (+shinRatioLInput.value).toFixed(2);
      shinRatioRInput.value = isIndep ? bs.shinR : sh; shinRatioRVal.textContent = (+shinRatioRInput.value).toFixed(2);
      btnHeadFill.textContent = AppState.selected.headFilled ? tr2('head.solid', '头部实心') : tr2('head.hollow', '头部空心');
      btnHeadFill.classList.toggle('on', AppState.selected.headFilled);
      /* v6.4.0：回填当前头型（旧工程没有这个字段 → 正圆） */
      const curHeadShape = AppState.selected.headShape || 'circle';
      headShapeBtns.forEach(b => b.classList.toggle('on', b.dataset.shape === curHeadShape));
      if (headFillCustomCheckbox) headFillCustomCheckbox.checked = !!AppState.selected.headFillCustom;
      if (headFillColorInput) headFillColorInput.value = AppState.selected.headFillColor || '#111111';
      
      const headIndepCb = document.getElementById('headIndep');
      if (headIndepCb) headIndepCb.checked = headHandleOn;
      updateHeadMoveHandle();
      const GV = glowFill(AppState.selected.glow) || {};
      glowColor.value = GV.color;
      glowAlpha.value = GV.alpha; glowAlphaVal.textContent = (+GV.alpha).toFixed(2);
      glowBlur.value = GV.blur; glowBlurVal.textContent = Math.round(GV.blur);
      if (glowOffsetX) { glowOffsetX.value = GV.offsetX; glowOffsetXVal.textContent = Math.round(GV.offsetX); }
      if (glowOffsetY) { glowOffsetY.value = GV.offsetY; glowOffsetYVal.textContent = Math.round(GV.offsetY); }
      if (glowSpread) { glowSpread.value = GV.spread; glowSpreadVal.textContent = Math.round(GV.spread); }
      if (glowIncludeAcc) glowIncludeAcc.checked = !!GV.includeAcc;
      btnGlow.textContent = GV.enabled ? tr2('glow.off', '关闭描边阴影') : tr2('glow.on', '开启描边阴影');
      btnGlow.classList.toggle('on', GV.enabled);
      jointColor.value = AppState.selected.joint.color;
      jointLen.value = AppState.selected.joint.len; jointLenVal.textContent = AppState.selected.joint.len.toFixed(2);
      btnJoint.textContent = AppState.selected.joint.enabled ? tr2('joint.off', '关闭渐变') : tr2('joint.on', '开启渐变');
      btnJoint.classList.toggle('on', AppState.selected.joint.enabled);
      /* v7.2.1：地面阴影（已改成每个火柴人独立，所以这里跟着选中对象走） */
      shadowFill(AppState.selected);
      if (btnGroundShadow) {
        btnGroundShadow.textContent = AppState.selected.shadowEnabled ? tr2('shadow.off', '关闭地面阴影') : tr2('shadow.on', '开启地面阴影');
        btnGroundShadow.classList.toggle('on', !!AppState.selected.shadowEnabled);
      }
      if (shadowColorInput) shadowColorInput.value = AppState.selected.shadowColor;
      if (shadowAlphaInput) {
        shadowAlphaInput.value = AppState.selected.shadowAlpha;
        shadowAlphaVal.textContent = (+AppState.selected.shadowAlpha).toFixed(2);
      }
    }

    if (hasCanvasSel) {
      objPanel.style.display = 'block';
      const k = canvasBaseBounds ? (AppState.canvasBounds.w / canvasBaseBounds.w) : 1;
      // 已删除 objScale.value = k; objScaleVal.textContent = k.toFixed(2);
      objAlpha.value = 1; objAlphaVal.textContent = '1.00';
      objAlpha.disabled = true;
      if (objXInput) { 
        objXInput.value = Math.round(AppState.canvasBounds.x + AppState.canvasBounds.w / 2); 
        objXInput.disabled = false; 
      }
      if (objYInput) { 
        objYInput.value = Math.round(displayY(AppState.canvasBounds.y + AppState.canvasBounds.h / 2)); 
        objYInput.disabled = false; 
      }
      if (objRotationInput) {
        const rotDeg = Math.round((AppState.canvasBounds.rotation || 0) * 180 / Math.PI);
        objRotationInput.value = rotDeg;
        objRotationVal.textContent = rotDeg + '°';
        objRotationInput.disabled = false;
      }
      btnUp.disabled = true; btnDown.disabled = true; btnTop.disabled = true; btnBottom.disabled = true;
      btnAnchorToggle.style.display = 'none';
      objAnchorRow.style.display = 'none';
    } else if (hasSel) {
      // 已删除 objScale.value = selected.scale; objScaleVal.textContent = selected.scale.toFixed(2);
      objAlpha.value = AppState.selected.alpha; objAlphaVal.textContent = AppState.selected.alpha.toFixed(2);
      objAlpha.disabled = false;
      updatePosInputs();
      objPanel.style.display = 'block';
      
      // 新增拉伸开关状态同步
      if (jointStretchToggle) {
        jointStretchToggle.disabled = !isFig;
        jointStretchToggle.checked = jointStretchOn;
      }
      btnUp.disabled = false; btnDown.disabled = false; btnTop.disabled = false; btnBottom.disabled = false;
      if (objRotationInput) {
        const rotDeg = Math.round(AppState.selected.rot || 0);
        objRotationInput.value = rotDeg;
        objRotationVal.textContent = rotDeg + '°';
        objRotationInput.disabled = false;
      }
      updateAnchorUI();
    } else {
      objPanel.style.display = 'none';
      btnUp.disabled = true; btnDown.disabled = true; btnTop.disabled = true; btnBottom.disabled = true;
      if (objRotationInput) objRotationInput.disabled = true;
      btnAnchorToggle.style.display = 'none';
      objAnchorRow.style.display = 'none';
      anchorModeOn = false;
    }

    /* v4.7.0 变换框 / 自由拉伸按钮状态 */
    const btnTBox = document.getElementById('btnTransformBox');
    if (btnTBox) {
      btnTBox.classList.toggle('on', !!transformBoxOn);
      btnTBox.setAttribute('aria-pressed', transformBoxOn ? 'true' : 'false');
    }
    const btnFree = document.getElementById('btnFreeStretch');
    if (btnFree) {
      const freeTargetOk = hasCanvasSel || (!!AppState.selected && !AppState.selected.locked && ['image', 'shape', 'acc'].includes(AppState.selected.type));
      btnFree.disabled = !freeTargetOk;
      btnFree.classList.toggle('on', !!freeStretchOn);
      btnFree.setAttribute('aria-pressed', freeStretchOn ? 'true' : 'false');
    }

    /* v5.5.2 四角扭曲按钮状态（选中不支持的类型时置灰）
       「四角扭曲」= 编辑模式开关：只控制 8 个控制点显不显示，类似变换框按钮
       「关闭扭曲」= 真正把变形关掉（画面回到原形，角点数据保留） */
    const btnDistortEl = document.getElementById('btnDistort');
    if (btnDistortEl && SKFE.systems.distort) {
      const dzTarget = AppState.selected;
      const dzOK = !hasCanvasSel && !!dzTarget && !dzTarget.locked && SKFE.systems.distort.supports(dzTarget);
      const dzOn = !!(dzOK && dzTarget.distort && dzTarget.distort.enabled);
      const dzEditing = !!(dzOn && distortEditOn);
      btnDistortEl.disabled = !dzOK;
      btnDistortEl.classList.toggle('on', dzEditing);
      btnDistortEl.setAttribute('aria-pressed', dzEditing ? 'true' : 'false');
      /* 文案不再随状态变化，交给 i18n 的 data-i18n 管，别在这里写死中文 */

      const btnDistortOffEl = document.getElementById('btnDistortOff');
      if (btnDistortOffEl) {
        btnDistortOffEl.disabled = !dzOn;
        btnDistortOffEl.classList.toggle('on', false);
      }
    }

    if (objXInput && objYInput && !hasCanvasSel) {
      objXInput.disabled = !AppState.selected || AppState.selected.locked;
      objYInput.disabled = !AppState.selected || AppState.selected.locked;
    }

    if (hideJointsCheckbox) hideJointsCheckbox.checked = hideJointsEnabled;
    if (jointSizeInput) { jointSizeInput.value = jointSize; jointSizeVal.textContent = jointSize; }
    
    if (jointSmoothInput) {
      if (isFig) {
        const js = AppState.selected.jointSmooth !== undefined ? AppState.selected.jointSmooth : 1;
        jointSmoothInput.value = js;
        jointSmoothVal.textContent = js.toFixed(2);
      } else {
        jointSmoothInput.value = 1;
        jointSmoothVal.textContent = '1.00';
      }
    }
    
    if (jointColorDiffCheckbox) jointColorDiffCheckbox.checked = jointColorDiff;

    updateJointSliders();
    syncCanvasUI();
    syncPageAppearanceUI();
    syncObjNameInput();
  }

  /* ==================== 透视滑条事件绑定（v5.7 头/尾倍率模型） ==================== */
  /* 补齐/迁移 spatial 数据：旧版 z 关节模型直接废弃，全部按 1（原始线宽）处理 */
  function ensureSpatialLines(f) {
    if (!f.spatial || typeof f.spatial !== 'object') f.spatial = { strength: 0, lines: null };
    if (!f.spatial.lines || typeof f.spatial.lines !== 'object') f.spatial.lines = SKFE.systems.spatial.defaultLines();
    for (const k of ['body', 'armL', 'armR', 'legL', 'legR']) {
      const l = f.spatial.lines[k] || (f.spatial.lines[k] = { start: 1, end: 1 });
      if (typeof l.start !== 'number' || !isFinite(l.start)) l.start = 1;
      if (typeof l.end !== 'number' || !isFinite(l.end)) l.end = 1;
    }
    return f.spatial;
  }

  /* 读六个滑条应显示的值（同步组取公共端点的值） */
  function spatialReadGroups(f) {
    ensureSpatialLines(f);
    const L = f.spatial.lines;
    return {
      pelvis: L.body.start, neck: L.body.end,
      handL: L.armL.end, handR: L.armR.end,
      footL: L.legL.end, footR: L.legR.end
    };
  }

  /* 写同步组：骨盆 = 躯干头 + 双腿头；脖子 = 躯干尾 + 双臂头；四肢末端各管各的 */
  function setSpatialGroup(group, val) {
    const f = AppState.selected;
    if (!f || f.type !== 'figure') return;
    ensureSpatialLines(f);
    const L = f.spatial.lines;
    const paths = [];
    if (group === 'pelvis') { L.body.start = val; L.legL.start = val; L.legR.start = val; paths.push('spatial.lines.body.start', 'spatial.lines.legL.start', 'spatial.lines.legR.start'); }
    else if (group === 'neck') { L.body.end = val; L.armL.start = val; L.armR.start = val; paths.push('spatial.lines.body.end', 'spatial.lines.armL.start', 'spatial.lines.armR.start'); }
    else if (group === 'handL') { L.armL.end = val; paths.push('spatial.lines.armL.end'); }
    else if (group === 'handR') { L.armR.end = val; paths.push('spatial.lines.armR.end'); }
    else if (group === 'footL') { L.legL.end = val; paths.push('spatial.lines.legL.end'); }
    else if (group === 'footR') { L.legR.end = val; paths.push('spatial.lines.legR.end'); }
    paths.forEach(p => setGlobalProp(f, p, val));
  }

  function bindSpatialEvents() {
    const strengthEl = document.getElementById('spatialStrength');
    if (strengthEl) {
      strengthEl.addEventListener('input', (e) => {
        if (!AppState.selected || AppState.selected.type !== 'figure') return;
        ensureSpatialLines(AppState.selected);
        AppState.selected.spatial.strength = +e.target.value;
        const v = document.getElementById('spatialStrengthVal');
        if (v) v.textContent = AppState.selected.spatial.strength.toFixed(2);
        setGlobalProp(AppState.selected, 'spatial.strength', AppState.selected.spatial.strength);
        EventBus.emit('need:render');
        markCurrentFrameModified();
      });
      strengthEl.addEventListener('change', () => EventBus.emit('history:save', '调整透视强度'));
    }

    const groupMap = { Pelvis: 'pelvis', Neck: 'neck', HandL: 'handL', HandR: 'handR', FootL: 'footL', FootR: 'footR' };
    Object.keys(groupMap).forEach(k => {
      const el = document.getElementById('sp' + k);
      if (!el) return;
      el.addEventListener('input', (e) => {
        if (!AppState.selected || AppState.selected.type !== 'figure') return;
        const val = +e.target.value;
        setSpatialGroup(groupMap[k], val);
        const lbl = document.getElementById('sp' + k + 'Val');
        if (lbl) lbl.textContent = val.toFixed(2);
        EventBus.emit('need:render');
        markCurrentFrameModified();
      });
      el.addEventListener('change', () => EventBus.emit('history:save', '调整透视粗细'));
    });
  }

  function select(f) {
    /* 子轨道下从图层列表等位置选择其他元件时，自动把轨道切到该元件，保持隔离 */
    if (isSubTrackMode() && f && String(f.id) !== AppState.activeTrackId) {
      AppState.activeTrackId = (f.type === 'video') ? TRACK_ALL_ID : String(f.id);
      refreshSubTrackOptions();
    }
    AppState.canvasSelected = false;
    AppState.selected = f;
    isolatedJointName = null; // 切换对象自动退出隔离模式
    cancelTransformBoxDrag();
    SKFE.systems.distort.cancelDrag(); // v5.2.0 切换对象时放弃未完成的扭曲拖拽
    anchorModeOn = false;
    if (f && f.type === 'camera') { anchorModeOn = false; }
    updateJointSliders();
    EventBus.emit('need:syncUI');
    updateLayerList();
    updateTrackOptions();
    /* v7.4.5：曲线标签跟着「选中谁」和「播放头在哪段」走 —— 换元件 / 换帧都要重算，
       否则切到另一条轨还显示上一条轨的曲线（或者一直停在初始的「匀速」）。 */
    updateTweenEaseLabel();
    if (f) flashCoordDisplay();
  }

  /* ==================== 指针交互 ==================== */
  let pointers = new Map();
  let lastDist = 0;
  let lastMid = { x: 0, y: 0 };

  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    const camView = SKFE.systems.camera.getCameraViewObject();
    if (camView) {
      const t = SKFE.systems.camera.getCameraViewTransform(camView);
      return SKFE.systems.camera.cameraScreenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }, camView, t);
    }
    return {
      x: (e.clientX - r.left - AppState.viewOffset.x) / AppState.viewScale,
      y: (e.clientY - r.top - AppState.viewOffset.y) / AppState.viewScale
    };
  }

  /* v5.2.0：点是否落在任意四边形内（凸/凹都适用，用射线交叉奇偶判定） */
  function pointInQuad(p, q) {
    let inside = false;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
      const xi = q[i].x, yi = q[i].y, xj = q[j].x, yj = q[j].y;
      if (((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function hitObj(o, p) {
    /* v5.2.1 扭曲对象的命中区域 = 变形后的四边形（含挂载时继承父级的扭曲），而不是原始矩形 */
    /* 火柴人的盒子会并进配饰（为了让整张图一起变形），但命中区不能跟着变大，
       否则点配饰会误选到火柴人 —— 这里单独用「不含配饰」的盒子。 */
    let dmp0;
    if (o.type === 'figure') {
      const src = getSourceOBB(o, true);
      dmp0 = src ? SKFE.systems.distort.getMappingOnBox(o, src.corners) : null;
    } else {
      dmp0 = SKFE.systems.distort.getMapping(o);
    }
    if (dmp0) {
      const quad = [];
      for (let i = 0; i < 4; i++) quad.push(SKFE.systems.distort.boxToWorld(dmp0.frame, dmp0.dst[i]));
      return pointInQuad(p, quad);
    }
    let fig = null;
    if (o.bindTo !== 'none' && o.targetId) fig = AppState.objects.find(f => f.id === o.targetId && f.type === 'figure');
    const tr = getBindTransform(o);
    let pp = p;
    if (fig && (fig.rot || fig.mirror)) pp = worldToFigureLocal(fig, p);
    const finalScale = o.scale * tr.syncScale;
    const w = o.w * finalScale, h = o.h * finalScale;
    const { ax, ay } = getAnchorOffset(o, finalScale);
    const dx = pp.x - (tr.x + ax), dy = pp.y - (tr.y + ay);
    const cos = Math.cos(-tr.angle), sin = Math.sin(-tr.angle);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    const extraBottom = (o.type === 'bubble') ? 24 * o.scale : 0;
    return (rx + ax >= -w / 2 && rx + ax <= w / 2 && ry + ay >= -h / 2 && ry + ay <= h / 2 + extraBottom);
  }

  function solveIK2Bone(start, target, L1, L2, flip) {
    let dx = target.x - start.x;
    let dy = target.y - start.y;
    let d = Math.hypot(dx, dy);
    const maxD = L1 + L2;
    if (d > maxD) d = maxD - 0.01;
    if (d < 0.01) d = 0.01;
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const dirX = dx / d, dirY = dy / d;
    const midX = start.x + a * dirX, midY = start.y + a * dirY;
    let nx = -dirY, ny = dirX;
    if (flip) { nx = -nx; ny = -ny; }
    return { knee: { x: midX + h * nx, y: midY + h * ny } };
  }

  function applyIK(o) {
    if (!o.ikEnabled) return;
    const currentPelvis = { x: o.x, y: o.y };
    const a = o.a, s = o.bodyScale, g = o.scale;
    const legBase = P.thigh + P.shin;
    const armBase = P.upperArm + P.foreArm;
    const getFlip = (start, target, jointCurr) => {
      const cross = (jointCurr.x - start.x) * (target.y - start.y) - (jointCurr.y - start.y) * (target.x - start.x);
      return cross > 0;
    };
    if (o.pinned.footL && o.pinnedPos.footL) {
      const ratio = (s.shinL !== undefined) ? s.shinL : s.shin;
      const scale = (s.legL !== undefined) ? s.legL : s.leg;
      const L1 = legBase * (1 - ratio) * scale * g;
      const L2 = legBase * ratio * scale * g;
      const j0 = jointData(o);
      const flip = getFlip(currentPelvis, o.pinnedPos.footL, j0.thighL);
      const res = solveIK2Bone(currentPelvis, o.pinnedPos.footL, L1, L2, flip);
      a.legL.u = norm(Math.atan2(res.knee.y - currentPelvis.y, res.knee.x - currentPelvis.x) - a.torso);
      a.legL.f = norm(Math.atan2(o.pinnedPos.footL.y - res.knee.y, o.pinnedPos.footL.x - res.knee.x) - (a.torso + a.legL.u));
    }
    if (o.pinned.footR && o.pinnedPos.footR) {
      const ratio = (s.shinR !== undefined) ? s.shinR : s.shin;
      const scale = (s.legR !== undefined) ? s.legR : s.leg;
      const L1 = legBase * (1 - ratio) * scale * g;
      const L2 = legBase * ratio * scale * g;
      const j0 = jointData(o);
      const flip = getFlip(currentPelvis, o.pinnedPos.footR, j0.thighR);
      const res = solveIK2Bone(currentPelvis, o.pinnedPos.footR, L1, L2, flip);
      a.legR.u = norm(Math.atan2(res.knee.y - currentPelvis.y, res.knee.x - currentPelvis.x) - a.torso);
      a.legR.f = norm(Math.atan2(o.pinnedPos.footR.y - res.knee.y, o.pinnedPos.footR.x - res.knee.x) - (a.torso + a.legR.u));
    }
    const waistPoint = along(currentPelvis, a.torso, P.torso * s.torso * g / 2);
    const neck = along(waistPoint, a.torso + a.waist, P.torso * s.torso * g / 2);
    if (o.pinned.handL && o.pinnedPos.handL) {
      const ratio = (s.foreArmL !== undefined) ? s.foreArmL : (s.foreArm !== undefined ? s.foreArm : 0.37);
      const scale = (s.armL !== undefined) ? s.armL : s.arm;
      const L1 = armBase * (1 - ratio) * scale * g;
      const L2 = armBase * ratio * scale * g;
      const j0 = jointData(o);
      const flip = getFlip(neck, o.pinnedPos.handL, j0.elbowL);
      const res = solveIK2Bone(neck, o.pinnedPos.handL, L1, L2, flip);
      a.armL.u = norm(Math.atan2(res.knee.y - neck.y, res.knee.x - neck.x) - (a.torso + a.waist));
      a.armL.f = norm(Math.atan2(o.pinnedPos.handL.y - res.knee.y, o.pinnedPos.handL.x - res.knee.x) - (a.torso + a.waist + a.armL.u));
    }
    if (o.pinned.handR && o.pinnedPos.handR) {
      const ratio = (s.foreArmR !== undefined) ? s.foreArmR : (s.foreArm !== undefined ? s.foreArm : 0.37);
      const scale = (s.armR !== undefined) ? s.armR : s.arm;
      const L1 = armBase * (1 - ratio) * scale * g;
      const L2 = armBase * ratio * scale * g;
      const j0 = jointData(o);
      const flip = getFlip(neck, o.pinnedPos.handR, j0.elbowR);
      const res = solveIK2Bone(neck, o.pinnedPos.handR, L1, L2, flip);
      a.armR.u = norm(Math.atan2(res.knee.y - neck.y, res.knee.x - neck.x) - (a.torso + a.waist));
      a.armR.f = norm(Math.atan2(o.pinnedPos.handR.y - res.knee.y, o.pinnedPos.handR.x - res.knee.x) - (a.torso + a.waist + a.armR.u));
    }
  }

  function enforcePins(o) {
    if (!o.ikEnabled) return;
    if (o.pinned.pelvis && o.pinnedPos.pelvis) {
      o.x = o.pinnedPos.pelvis.x; o.y = o.pinnedPos.pelvis.y;
    }
    let j = jointData(o);
    if (o.pinned.footL && o.pinnedPos.footL) {
      const scale = (o.bodyScale.legL !== undefined) ? o.bodyScale.legL : o.bodyScale.leg;
      const maxDist = (P.thigh + P.shin) * scale * o.scale;
      const dx = o.x - o.pinnedPos.footL.x, dy = o.y - o.pinnedPos.footL.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxDist) { o.x = o.pinnedPos.footL.x + dx / dist * maxDist; o.y = o.pinnedPos.footL.y + dy / dist * maxDist; }
    }
    if (o.pinned.footR && o.pinnedPos.footR) {
      const scale = (o.bodyScale.legR !== undefined) ? o.bodyScale.legR : o.bodyScale.leg;
      const maxDist = (P.thigh + P.shin) * scale * o.scale;
      const dx = o.x - o.pinnedPos.footR.x, dy = o.y - o.pinnedPos.footR.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxDist) { o.x = o.pinnedPos.footR.x + dx / dist * maxDist; o.y = o.pinnedPos.footR.y + dy / dist * maxDist; }
    }
    j = jointData(o);
    if (o.pinned.handL && o.pinnedPos.handL) {
      const scale = (o.bodyScale.armL !== undefined) ? o.bodyScale.armL : o.bodyScale.arm;
      const maxDist = (P.upperArm + P.foreArm) * scale * o.scale;
      const dx = j.neck.x - o.pinnedPos.handL.x, dy = j.neck.y - o.pinnedPos.handL.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxDist) {
        const nx = o.pinnedPos.handL.x + dx / dist * maxDist;
        const ny = o.pinnedPos.handL.y + dy / dist * maxDist;
        o.x += nx - j.neck.x; o.y += ny - j.neck.y;
      }
    }
    if (o.pinned.handR && o.pinnedPos.handR) {
      const scale = (o.bodyScale.armR !== undefined) ? o.bodyScale.armR : o.bodyScale.arm;
      const maxDist = (P.upperArm + P.foreArm) * scale * o.scale;
      const dx = j.neck.x - o.pinnedPos.handR.x, dy = j.neck.y - o.pinnedPos.handR.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxDist) {
        const nx = o.pinnedPos.handR.x + dx / dist * maxDist;
        const ny = o.pinnedPos.handR.y + dy / dist * maxDist;
        o.x += nx - j.neck.x; o.y += ny - j.neck.y;
      }
    }
    applyIK(o);
  }

  function hideHandles() {
    /* v4.7.0：变换框是常驻模式，这里只清理可能残留的变换框拖拽 */
    cancelTransformBoxDrag();
  }

  function onPointerDown(e) {
    if (isPlaying) return;
    /* v5.2.0 正在拖拽扭曲控制点时，画布完全不参与选中/平移 */
    if (SKFE.systems.distort.isDragging()) return;
    snapLines = { x: null, y: null }; /* 点击时清空线 */
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      drag = null; isPanning = false;
      const pts = Array.from(pointers.values());
      lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      /* 判断双指中点是否在摄像机取景框内 → 决定这次双指缩放摄像机还是缩放页面视图 */
      twoFingerMode = 'view';
      const camViewObj = SKFE.systems.camera.getCameraViewObject();
      if (camViewObj) {
        const rect = canvas.getBoundingClientRect();
        const midX = lastMid.x - rect.left;
        const midY = lastMid.y - rect.top;
        const ct = SKFE.systems.camera.getCameraViewTransform(camViewObj);
        const inside = (
          midX >= ct.left && midX <= ct.left + ct.viewW &&
          midY >= ct.top && midY <= ct.top + ct.viewH
        );
        if (inside) twoFingerMode = 'camera';
      }
      return;
    }
    if (pointers.size > 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('#transformBoxUI') || e.target.closest('#ui') || e.target.closest('#timeline') ||
        e.target.closest('#btnShowTimeline') ||
        e.target.closest('#uiResizeHandle') || e.target.closest('#historyControls') ||
        e.target.closest('#layerPop')) return;

    const p = getPos(e);
    const isTouch = e.pointerType === 'touch';
    const subTrackMode = isSubTrackMode();
    const subTrackObj = subTrackMode ? getActiveTrackObject() : null;

    /* 橡皮擦优先：直接开始一笔矢量擦除，拦截掉所有的点击 */
    if (SKFE.systems.eraser.isOn()) {
      SKFE.systems.eraser.startStroke(p, e); // 哪怕没点中也会在里面去尝试绑定当前选中对象
      if (e.pointerType === 'mouse' && e.button === 0) return; // 鼠标彻底禁止平移与穿透选中画布
    }

    /* 摄像机子轨道：取景框内拖动 = 平移摄像机；取景框外拖动 = 平移视图（避开 UI 面板） */
    const camViewObj = SKFE.systems.camera.getCameraViewObject();
    if (camViewObj) {
      AppState.selected = camViewObj;
      const insideRect = SKFE.systems.camera.pointInCameraRect(camViewObj, p, 0);
      if (insideRect) {
        const ct = SKFE.systems.camera.getCameraViewTransform(camViewObj);
        drag = {
          o: camViewObj, part: 'camera-view-pan',
          startClientX: e.clientX, startClientY: e.clientY,
          camX: camViewObj.x, camY: camViewObj.y,
          camRot: (camViewObj.rot || 0) * Math.PI / 180, fit: ct.fit
        };
      } else {
        drag = {
          part: 'camera-view-move',
          startClientX: e.clientX, startClientY: e.clientY,
          startOffsetX: camViewOffset.x, startOffsetY: camViewOffset.y
        };
      }
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // 移除直接点击锚点标记拖动，改为由专用手柄处理

    if (AppState.canvasBoundsEnabled && canvasBoundsEditMode) {
      const cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
      const cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
      const rot = AppState.canvasBounds.rotation || 0;
      const dx = p.x - cx, dy = p.y - cy;
      const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      const minDist = Math.min(
        Math.abs(lx - (-AppState.canvasBounds.w / 2)), Math.abs(lx - (AppState.canvasBounds.w / 2)),
        Math.abs(ly - (-AppState.canvasBounds.h / 2)), Math.abs(ly - (AppState.canvasBounds.h / 2))
      );
      if (minDist < 20 / AppState.viewScale) {
        /* === 新增：点击画布边框时，自动将选中目标切换为画布 === */
        if (!AppState.canvasSelected) {
          AppState.canvasSelected = true;
          AppState.selected = null;
          EventBus.emit('need:syncUI');
          updateLayerList();
          updateCoordDisplay();
          updatePosInputs();
          flashCoordDisplay();
        }
        /* ======================================================= */
        draggingCanvasBounds = true;
        canvasDragStart = { x: p.x, y: p.y, cx: AppState.canvasBounds.x, cy: AppState.canvasBounds.y };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    if (groundLineEnabled && groundLineEditMode) {
      const rect = canvas.getBoundingClientRect();
      const screenY = AppState.viewOffset.y + groundLineY * AppState.viewScale;
      const mouseScreenY = e.clientY - rect.top;
      if (Math.abs(mouseScreenY - screenY) < 10) {
        draggingGroundLine = true;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    /* 子轨道下：当前帧没有该元件时，画布不产生选中，只保留平移 */
    if (subTrackMode && !subTrackObj) {
      if (!isTouch) {
        isPanning = true;
        panStart = { x: e.clientX - AppState.viewOffset.x, y: e.clientY - AppState.viewOffset.y };
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    /* 点到其他任何位置 → 隐藏手柄 */
    hideHandles();

    /* 摄像机参考框：拖边框移动（选中后内部也可拖动） */
    const camHit = SKFE.systems.camera.findCameraHit(p);
    if (camHit) {
      if (camHit !== AppState.selected) select(camHit);
      drag = {
        o: camHit, part: 'camera-move',
        startX: p.x, startY: p.y, startCamX: camHit.x, startCamY: camHit.y
      };
      canvas.setPointerCapture(e.pointerId);
      EventBus.emit('need:render');
      return;
    }

    let clickedObj = false;
    const handleHitRadius = (isTouch ? 36 : 18) / AppState.viewScale;
    const bodyHitRadius = (isTouch ? 24 : 14) / AppState.viewScale;
    const shadowExtra = (isTouch ? 24 : 12) / AppState.viewScale;

    if (!subTrackMode && videoObj && refVideo && refVideo.readyState >= 2 && !videoObj.locked) {
      const w = videoObj.w * videoObj.scale, h = videoObj.h * videoObj.scale;
      if (p.x >= videoObj.x - w / 2 && p.x <= videoObj.x + w / 2 && p.y >= videoObj.y - h / 2 && p.y <= videoObj.y + h / 2) {
        if (videoObj === AppState.selected) {
          clickedObj = true;
          drag = { o: videoObj, part: 'move', dx: videoObj.x - p.x, dy: videoObj.y - p.y };
          canvas.setPointerCapture(e.pointerId);
          EventBus.emit('need:render'); return;
        } else {
          select(videoObj); EventBus.emit('need:render'); return;
        }
      }
    }

    /* v6.3.0：画布上点不到被小眼睛隐藏的元件（否则隐藏了还能拖出来） */
    const hitObjects = subTrackMode ? [subTrackObj] : AppState.objects.filter(o => o && !o.hidden);
    for (let i = hitObjects.length - 1; i >= 0; i--) {
      const o = hitObjects[i];
      if (!o || o.locked) continue;

      if (o.type === 'figure') {
        /* v5.5.0：变形状态下，指针要先逆映射回源态，才能和「源态关节坐标」比较。
           未变形时 distortInvWorld 原样返回，等于没有这段。 */
        const pSrc = distortInvWorld(o, p);
        const pLocal = (o.rot || o.mirror) ? worldToFigureLocal(o, pSrc) : pSrc;
        if (o.shadowEnabled && shadowEditMode && o === AppState.selected) {
          const jS = jointData(o);
          const lowestY = Math.max(jS.footL.y, jS.footR.y, jS.toeL.y, jS.toeR.y);
          const sx = o.x + (o.shadowOffX || 0);
          const sy = lowestY + 10 + (o.shadowOffY || 0);
          const rxS = 30 * o.scale * (o.shadowScaleX || 1) + shadowExtra;
          const ryS = 8 * o.scale * (o.shadowScaleY || 1) + shadowExtra;
          const dxS = pLocal.x - sx, dyS = pLocal.y - sy;
          if ((dxS * dxS) / (rxS * rxS) + (dyS * dyS) / (ryS * ryS) <= 1) {
            clickedObj = true; select(o);
            drag = { o, part: 'shadow', startX: p.x, startY: p.y, startShadowOffX: o.shadowOffX || 0, startShadowOffY: o.shadowOffY || 0 };
            canvas.setPointerCapture(e.pointerId);
            EventBus.emit('need:render'); return;
          }
        }
        const j = jointData(o);
        let best = null, bestD = handleHitRadius;
        for (const h of getHandles(j, o)) {
          if (!isJointInGroup(h.name, isolatedJointName)) continue; // 隔离时忽略其他点
          const d = Math.hypot(pLocal.x - h.p.x, pLocal.y - h.p.y);
          if (d < bestD) { bestD = d; best = h; }
        }
        if (best) {
          if (o === AppState.selected) {
            if (jointStretchOn && best.name) {
              let isPinned = false;
              if (o.ikEnabled && o.pinned) {
                if ((best.name === 'elbowL' || best.name === 'handL') && o.pinned.handL) isPinned = true;
                if ((best.name === 'elbowR' || best.name === 'handR') && o.pinned.handR) isPinned = true;
                if ((best.name === 'kneeL' || best.name === 'footL') && o.pinned.footL) isPinned = true;
                if ((best.name === 'kneeR' || best.name === 'footR') && o.pinned.footR) isPinned = true;
                if (best.name === 'waist' && o.pinned.pelvis) isPinned = true;
              }
              if (isPinned) {
                alert(tr2('alert.ikStretch', '该肢体正在被 IK（关节固定）保护，无法拉伸。\n请先在「关节」面板中解除固定。'));
                return;
              }
            }
            clickedObj = true;
            drag = { o, part: best.name, dx: o.x - p.x, dy: o.y - p.y, startFixedJ: JSON.parse(JSON.stringify(j)) };
            canvas.setPointerCapture(e.pointerId);
            EventBus.emit('need:render'); return;
          } else {
            select(o); EventBus.emit('need:render'); return;
          }
        }
        const torsoSegs = [[j.pelvis, j.waistPoint], [j.waistPoint, j.neck]];
        const torsoHit = torsoSegs.some(([a, b]) => distToSeg(pLocal, a, b) < bodyHitRadius);
        if (torsoHit) {
          if (o === AppState.selected) {
            clickedObj = true;
            drag = { o, part: 'pelvis', dx: o.x - p.x, dy: o.y - p.y, startFixedJ: JSON.parse(JSON.stringify(j)) };
            canvas.setPointerCapture(e.pointerId);
            EventBus.emit('need:render'); return;
          } else {
            select(o); EventBus.emit('need:render'); return;
          }
        }
        if (segments(j, o).some(([a, b]) => distToSeg(pLocal, a, b) < bodyHitRadius)) {
          if (o !== AppState.selected) { select(o); EventBus.emit('need:render'); }
          return;
        }
      } else if (o.type === 'image') {
        const b = imageBounds(o);
        const { ax, ay } = getAnchorOffset(o, o.scale);
        const dxr = p.x - (o.x + ax), dyr = p.y - (o.y + ay);
        const rot = (o.rot || 0) * Math.PI / 180;
        const c = Math.cos(-rot), s = Math.sin(-rot);
        const rx = dxr * c - dyr * s;
        const ry = dxr * s + dyr * c;
        const hit = Math.abs(rx + ax) <= b.w / 2 && Math.abs(ry + ay) <= b.h / 2;
        if (hit) {
          if (o === AppState.selected) {
            clickedObj = true;
            drag = { o, part: 'move', dx: o.x - p.x, dy: o.y - p.y, startWorldPos: getObjectWorldPos(o) }; // global-v5.1.1: 记录起始世界位置，松手后同步其它帧
            canvas.setPointerCapture(e.pointerId);
            EventBus.emit('need:render'); return;
          } else {
            select(o); EventBus.emit('need:render'); return;
          }
        }
      } else if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') { // brush-v5.1.0: ink 复用绑定拖动
        if (hitObj(o, p)) {
          if (o === AppState.selected) {
            clickedObj = true;
            drag = { o, part: 'move', startX: p.x, startY: p.y, startOffX: o.offX || 0, startOffY: o.offY || 0, dx: o.x - p.x, dy: o.y - p.y, startWorldPos: getObjectWorldPos(o) };
            canvas.setPointerCapture(e.pointerId);
            EventBus.emit('need:render'); return;
          } else {
            select(o); EventBus.emit('need:render'); return;
          }
        }
      }
    }

    if (!clickedObj) {
      /* v4.7.0 变换框：点击框内空白区域 → 拖拽移动对象 */
      if (transformBoxOn && !SKFE.systems.eraser.isOn()) {
        const g = getTransformBoxGeometry();
        if (g && pointInTransformBoxScreen(tboxScreenFromEvent(e))) {
          beginTBoxDrag('move', e, g);
          return;
        }
      }
      /* 子轨道隔离：点击其他元件或空白处不改变选中状态 */
      if (subTrackMode) {
        if (!isTouch) {
          isPanning = true;
          panStart = { x: e.clientX - AppState.viewOffset.x, y: e.clientY - AppState.viewOffset.y };
          canvas.setPointerCapture(e.pointerId);
        }
        return;
      }
      const insideCanvas = AppState.canvasBoundsEnabled && !SKFE.systems.eraser.isOn() && canvasBoundsEditMode && (() => {
        const cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
        const cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
        const rot = AppState.canvasBounds.rotation || 0;
        const dx = p.x - cx, dy = p.y - cy;
        const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
        const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
        return Math.abs(lx) <= AppState.canvasBounds.w / 2 && Math.abs(ly) <= AppState.canvasBounds.h / 2;
      })();
      if (insideCanvas) {
        AppState.canvasSelected = true;
        AppState.selected = null;
        EventBus.emit('need:syncUI');
        updateLayerList();
        updateCoordDisplay();
        updatePosInputs();
        flashCoordDisplay();
      } else {
        AppState.canvasSelected = false;
        select(null);
      }
      if (!isTouch && !SKFE.systems.eraser.isOn()) {
        isPanning = true;
        panStart = { x: e.clientX - AppState.viewOffset.x, y: e.clientY - AppState.viewOffset.y };
        canvas.setPointerCapture(e.pointerId);
      }
      EventBus.emit('need:render');
    }
  }

  /* 计算吸附位置（X、Y 独立计算，互不影响） */
  function calcSnap(tx, ty) {
    let res = { dx: 0, dy: 0, lineX: null, lineY: null };
    if (!snapEnabled || !AppState.selected || AppState.selected.locked) return res;
    if (AppState.selected.type === 'camera' || AppState.selected.type === 'video') return res;
    /* 绑定对象不参与吸附，避免配饰脱头 */
    if (AppState.selected.bindTo && AppState.selected.bindTo !== 'none' && AppState.selected.targetId) return res;

    const vs = SKFE.systems.eraser.getActiveViewScale();
    const THRESHOLD = 10 / vs; /* 屏幕 10px 换算为世界单位 */
    
    /* 1. 计算自身移动后的包围盒 (AABB) */
    const curBounds = getObjectBounds(AppState.selected);
    const dxMove = tx - AppState.selected.x;
    const dyMove = ty - AppState.selected.y;

    /* 自身 9 个候选点：左、中、右 + 上、中、下 + 骨盆 */
    let selfXPts = [curBounds.left + dxMove, (curBounds.left + curBounds.right) / 2 + dxMove, curBounds.right + dxMove];
    let selfYPts = [curBounds.top + dyMove, (curBounds.top + curBounds.bottom) / 2 + dyMove, curBounds.bottom + dyMove];
    if (AppState.selected.type === 'figure') {
      selfXPts.push(tx); /* 骨盆 x */
      selfYPts.push(ty); /* 骨盆 y */
    }

    /* 2. 收集所有目标的候选点 */
    let targetXPts = [];
    let targetYPts = [];
    for (const o of AppState.objects) {
      if (o === AppState.selected) continue;
      if (o.type === 'camera' || o.type === 'video') continue;
      if (o.type !== 'figure' && o.type !== 'image' && o.type !== 'acc' && o.type !== 'shape' && o.type !== 'bubble') continue;
      
      /* 其他轨道：隐藏的跳过，50% 的允许 */
      if (isSubTrackMode() && String(o.id) !== AppState.activeTrackId) {
        if (otherTracksVisibility === 'hide') continue;
      }

      const b = getObjectBounds(o);
      targetXPts.push(b.left, (b.left + b.right) / 2, b.right);
      targetYPts.push(b.top, (b.top + b.bottom) / 2, b.bottom);
      
      if (o.type === 'figure') {
        targetXPts.push(o.x); /* 目标骨盆 x */
        targetYPts.push(o.y); /* 目标骨盆 y */
      }
    }

    /* 3. X 轴找最近 */
    let minDistX = THRESHOLD;
    for (const sp of selfXPts) {
      for (const tp of targetXPts) {
        const d = Math.abs(sp - tp);
        if (d < minDistX) {
          minDistX = d;
          res.dx = tp - sp;
          res.lineX = tp;
        }
      }
    }

    /* 4. Y 轴找最近 */
    let minDistY = THRESHOLD;
    for (const sp of selfYPts) {
      for (const tp of targetYPts) {
        const d = Math.abs(sp - tp);
        if (d < minDistY) {
          minDistY = d;
          res.dy = tp - sp;
          res.lineY = tp;
        }
      }
    }
    return res;
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    /* v5.2.0 扭曲控制点拖拽期间，画布不响应移动（防止误触发平移/悬停高亮） */
    if (SKFE.systems.distort.isDragging()) return;

    if (SKFE.systems.eraser.isDragging()) {
      SKFE.systems.eraser.updateStroke(getPos(e));
      return;
    }

    if (drag && drag.part === 'camera-view-pan') {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      const c = Math.cos(drag.camRot), s = Math.sin(drag.camRot);
      const wx = (dx * c - dy * s) / drag.fit;
      const wy = (dx * s + dy * c) / drag.fit;
      /* v6.1.0：摄像机拖动也要走全局属性，否则只动当前帧 */
      const nx = drag.camX + wx, ny = drag.camY + wy;
      drag.o.x = nx;
      drag.o.y = ny;
      setGlobalProp(drag.o, 'x', nx);
      setGlobalProp(drag.o, 'y', ny);
      EventBus.emit('need:render');
      return;
    }

    if (drag && drag.part === 'camera-view-move') {
      camViewOffset.x = drag.startOffsetX + (e.clientX - drag.startClientX);
      camViewOffset.y = drag.startOffsetY + (e.clientY - drag.startClientY);
      EventBus.emit('need:render');
      return;
    }

    if (draggingCanvasBounds) {
      const p = getPos(e);
      AppState.canvasBounds.x = canvasDragStart.cx + (p.x - canvasDragStart.x);
      AppState.canvasBounds.y = canvasDragStart.cy + (p.y - canvasDragStart.y);
      syncCanvasUI();
      EventBus.emit('need:render');
      return;
    }

    if (draggingGroundLine) {
      const rect = canvas.getBoundingClientRect();
      const screenY = e.clientY - rect.top;
      groundLineY = (screenY - AppState.viewOffset.y) / AppState.viewScale;
      syncGroundLineUI();
      EventBus.emit('need:render');
      return;
    }

    if (groundLineEnabled && groundLineEditMode && !drag && !isPanning && pointers.size === 0) {
      const rect = canvas.getBoundingClientRect();
      const screenY = AppState.viewOffset.y + groundLineY * AppState.viewScale;
      const mouseScreenY = e.clientY - rect.top;
      canvas.style.cursor = Math.abs(mouseScreenY - screenY) < 10 ? 'ns-resize' : 'default';
    }

    if (AppState.canvasBoundsEnabled && canvasBoundsEditMode && !drag && !isPanning && pointers.size === 0) {
      const p = getPos(e);
      const cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
      const cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
      const rot = AppState.canvasBounds.rotation || 0;
      const dx = p.x - cx, dy = p.y - cy;
      const lx = dx * Math.cos(-rot) - dy * Math.sin(-rot);
      const ly = dx * Math.sin(-rot) + dy * Math.cos(-rot);
      const minDist = Math.min(
        Math.abs(lx - (-AppState.canvasBounds.w / 2)), Math.abs(lx - (AppState.canvasBounds.w / 2)),
        Math.abs(ly - (-AppState.canvasBounds.h / 2)), Math.abs(ly - (AppState.canvasBounds.h / 2))
      );
      canvas.style.cursor = minDist < 20 / AppState.viewScale ? 'move' : 'default';
    }

    /* v4.7.0 变换框：悬停框内显示移动光标 */
    if (transformBoxOn && !SKFE.systems.eraser.isOn() && !drag && !isPanning && pointers.size === 0) {
      const g = getTransformBoxGeometry();
      if (g && pointInTransformBoxScreen(tboxScreenFromEvent(e))) {
        canvas.style.cursor = 'move';
      } else if (canvas.style.cursor === 'move' && !(AppState.canvasBoundsEnabled && canvasBoundsEditMode)) {
        canvas.style.cursor = 'default';
      }
    }

    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const camViewObj = SKFE.systems.camera.getCameraViewObject();

      if (camViewObj && twoFingerMode === 'camera') {
        /* 双指缩放摄像机（取景框内）：以双指中点为锚点 */
        if (lastDist > 0) {
          const zoomFactor = dist / lastDist;
          const oldScale = camViewObj.scale || 1;
          const newScale = Math.min(10, Math.max(0.1, oldScale * zoomFactor));
          if (Math.abs(newScale - oldScale) > 1e-6) {
            const rect = canvas.getBoundingClientRect();
            const midX = mid.x - rect.left;
            const midY = mid.y - rect.top;
            const ct = SKFE.systems.camera.getCameraViewTransform(camViewObj);
            const worldPt = SKFE.systems.camera.cameraScreenToWorld({ x: midX, y: midY }, camViewObj, ct);
            camViewObj.scale = newScale;
            const ctAfter = SKFE.systems.camera.getCameraViewTransform(camViewObj);
            const worldAfter = SKFE.systems.camera.cameraScreenToWorld({ x: midX, y: midY }, camViewObj, ctAfter);
            camViewObj.x += worldPt.x - worldAfter.x;
            camViewObj.y += worldPt.y - worldAfter.y;
            /* v6.1.0：位置也要跟着全局写，不然缩放后逐帧位置会漂 */
            if (globalEditEnabled) {
              setGlobalProp(camViewObj, 'scale', newScale);
              setGlobalProp(camViewObj, 'x', camViewObj.x);
              setGlobalProp(camViewObj, 'y', camViewObj.y);
            }
          }
        }
        lastDist = dist; lastMid = mid;
        EventBus.emit('need:render'); return;
      }

      if (camViewObj && twoFingerMode === 'view') {
        /* 双指缩放摄像机页面视图（取景框外） */
        if (lastDist > 0) {
          const zoomFactor = dist / lastDist;
          const newZoom = Math.min(20, Math.max(0.05, camViewZoom * zoomFactor));
          const rect = canvas.getBoundingClientRect();
          const midX = mid.x - rect.left;
          const midY = mid.y - rect.top;
          const cx = (canvas.clientWidth / 2) + camViewOffset.x;
          const cy = (canvas.clientHeight / 2) + camViewOffset.y;
          const k = newZoom / camViewZoom;
          camViewOffset.x += (midX - cx) * (1 - k);
          camViewOffset.y += (midY - cy) * (1 - k);
          camViewZoom = newZoom;
        }
        lastDist = dist; lastMid = mid;
        EventBus.emit('need:render'); return;
      }

      /* 非摄像机视角：原有逻辑 */
      if (lastDist > 0) {
        const zoomFactor = dist / lastDist;
        let newScale = Math.min(VIEW_SCALE_MAX, Math.max(VIEW_SCALE_MIN, AppState.viewScale * zoomFactor));
        if (viewPinned && pinnedView) {
          newScale = Math.max(newScale, pinnedView.scale);
        }
        if (viewPinned && pinnedView && newScale <= pinnedView.scale + 0.0001) {
          AppState.viewScale = pinnedView.scale;
          AppState.viewOffset.x = pinnedView.offset.x;
          AppState.viewOffset.y = pinnedView.offset.y;
        } else {
          const actualZoom = newScale / AppState.viewScale;
          AppState.viewOffset.x = mid.x - (mid.x - AppState.viewOffset.x) * actualZoom;
          AppState.viewOffset.y = mid.y - (mid.y - AppState.viewOffset.y) * actualZoom;
          AppState.viewScale = newScale;
          AppState.viewOffset.x += mid.x - lastMid.x;
          AppState.viewOffset.y += mid.y - lastMid.y;
        }
      }
      lastDist = dist; lastMid = mid;
      EventBus.emit('need:render'); return;
    }
    if (isPanning) {
      if (viewPinned && pinnedView && AppState.viewScale <= pinnedView.scale + 0.0001) {
        AppState.viewOffset.x = pinnedView.offset.x;
        AppState.viewOffset.y = pinnedView.offset.y;
      } else {
        AppState.viewOffset.x = e.clientX - panStart.x;
        AppState.viewOffset.y = e.clientY - panStart.y;
      }
      EventBus.emit('need:render'); return;
    }
    if (!drag) return;
    const p = getPos(e);
    const o = drag.o;

    if (drag.part === 'rotate') {
      const curAngle = Math.atan2(p.y - drag.pivot.y, p.x - drag.pivot.x);
      const rawDelta = curAngle - drag.lastAngle;
      const deltaAngle = Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta));
      drag.lastAngle = curAngle;
      drag.accumRot += deltaAngle * 180 / Math.PI;
      o.rot = drag.accumRot;
      if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble') {
        setGlobalPropForBound(o, 'rot', o.rot);
      } else {
        setGlobalProp(o, 'rot', o.rot);
      }
      if (objRotationInput && document.activeElement !== objRotationInput) {
        objRotationInput.value = Math.round(drag.accumRot);
        objRotationVal.textContent = Math.round(drag.accumRot) + '°';
      }
      EventBus.emit('need:render');
      return;
    }

    // 不再处理直接拖动锚点，交由 DOM 手柄处理

    if (o.type === 'video') {
      if (drag.part === 'move') { o.x = p.x + drag.dx; o.y = p.y + drag.dy; }
    } else if (o.type === 'camera') {
      if (drag.part === 'camera-move') {
        o.x = drag.startCamX + (p.x - drag.startX);
        o.y = drag.startCamY + (p.y - drag.startY);
      }
    } else if (o.type === 'figure') {
      if (drag.part === 'shadow') {
        o.shadowOffX = drag.startShadowOffX + (p.x - drag.startX);
        o.shadowOffY = drag.startShadowOffY + (p.y - drag.startY);
        setGlobalProp(o, 'shadowOffX', o.shadowOffX);
        setGlobalProp(o, 'shadowOffY', o.shadowOffY);
        /* v7.2.1：地面阴影已经能打关键帧了，画布上拖阴影也要把这一帧升成关键帧 */
        markCurrentFrameModified();
        EventBus.emit('need:render'); return;
      }
      if (drag.part === 'pelvis') {
        let tx = p.x + drag.dx;
        let ty = p.y + drag.dy;
        const snap = calcSnap(tx, ty);
        o.x = tx + snap.dx;
        o.y = ty + snap.dy;
        snapLines.x = snap.lineX;
        snapLines.y = snap.lineY;
      } else {
        /* v5.5.0：关节类拖拽走逆映射，指针在变形后的图像上，关节按源态算。
           整体平移（pelvis）仍用原始 p，因为平移对象时变形结果也是平移，天然 1:1。 */
        const pSrc = distortInvWorld(o, p);
        const pLocal = (o.rot || o.mirror) ? worldToFigureLocal(o, pSrc) : pSrc;
        
        //完全由 stretchJoint 接管位置和角度
        if (jointStretchOn && drag.part !== 'pelvis' && drag.part !== 'head' && drag.part !== 'neck') {
          stretchJoint(o, drag.part, pLocal);
        } else {
          if (drag.part === 'waist') {
            const newTorso = norm(Math.atan2(pLocal.y - drag.startFixedJ.pelvis.y, pLocal.x - drag.startFixedJ.pelvis.x));
            const deltaTorso = norm(newTorso - o.a.torso);
            o.a.torso = newTorso;
            o.a.legL.u = norm(o.a.legL.u - deltaTorso);
            o.a.legR.u = norm(o.a.legR.u - deltaTorso);
          } else if (drag.part === 'neck') {
            const newJ = jointData(o);
            o.a.waist = norm(Math.atan2(pLocal.y - newJ.waistPoint.y, pLocal.x - newJ.waistPoint.x) - o.a.torso);
          } else if (drag.part === 'head') {
            const newJ = jointData(o);
            o.headAngle = Math.atan2(pLocal.y - newJ.neck.y, pLocal.x - newJ.neck.x);
          } else if (drag.part === 'elbowL') {
            const newJ = jointData(o);
            o.a.armL.u = norm(Math.atan2(pLocal.y - newJ.neck.y, pLocal.x - newJ.neck.x) - (o.a.torso + o.a.waist));
          } else if (drag.part === 'handL') {
            if (o.ikEnabled && o.pinned && o.pinned.handL) o.pinnedPos.handL = { x: pLocal.x, y: pLocal.y };
            const newJ = jointData(o);
            o.a.armL.f = norm(Math.atan2(pLocal.y - newJ.elbowL.y, pLocal.x - newJ.elbowL.x) - (o.a.torso + o.a.waist + o.a.armL.u));
          } else if (drag.part === 'elbowR') {
            const newJ = jointData(o);
            o.a.armR.u = norm(Math.atan2(pLocal.y - newJ.neck.y, pLocal.x - newJ.neck.x) - (o.a.torso + o.a.waist));
          } else if (drag.part === 'handR') {
            if (o.ikEnabled && o.pinned && o.pinned.handR) o.pinnedPos.handR = { x: pLocal.x, y: pLocal.y };
            const newJ = jointData(o);
            o.a.armR.f = norm(Math.atan2(pLocal.y - newJ.elbowR.y, pLocal.x - newJ.elbowR.x) - (o.a.torso + o.a.waist + o.a.armR.u));
          } else if (drag.part === 'kneeL') {
            const newJ = jointData(o);
            o.a.legL.u = norm(Math.atan2(pLocal.y - newJ.pelvis.y, pLocal.x - newJ.pelvis.x) - o.a.torso);
          } else if (drag.part === 'footL') {
            if (o.ikEnabled && o.pinned && o.pinned.footL) o.pinnedPos.footL = { x: pLocal.x, y: pLocal.y };
            const newJ = jointData(o);
            o.a.legL.f = norm(Math.atan2(pLocal.y - newJ.thighL.y, pLocal.x - newJ.thighL.x) - (o.a.torso + o.a.legL.u));
          } else if (drag.part === 'kneeR') {
            const newJ = jointData(o);
            o.a.legR.u = norm(Math.atan2(pLocal.y - newJ.pelvis.y, pLocal.x - newJ.pelvis.x) - o.a.torso);
          } else if (drag.part === 'footR') {
            if (o.ikEnabled && o.pinned && o.pinned.footR) o.pinnedPos.footR = { x: pLocal.x, y: pLocal.y };
            const newJ = jointData(o);
            o.a.legR.f = norm(Math.atan2(pLocal.y - newJ.thighR.y, pLocal.x - newJ.thighR.x) - (o.a.torso + o.a.legR.u));
          } else if (drag.part === 'wristL') {
            const newJ = jointData(o);
            o.extremity.armAngleL = norm(Math.atan2(pLocal.y - newJ.handL.y, pLocal.x - newJ.handL.x) - (o.a.torso + o.a.waist + o.a.armL.u + o.a.armL.f));
          } else if (drag.part === 'wristR') {
            const newJ = jointData(o);
            o.extremity.armAngleR = norm(Math.atan2(pLocal.y - newJ.handR.y, pLocal.x - newJ.handR.x) - (o.a.torso + o.a.waist + o.a.armR.u + o.a.armR.f));
          } else if (drag.part === 'toeL') {
            const newJ = jointData(o);
            o.extremity.legAngleL = norm(Math.atan2(pLocal.y - newJ.footL.y, pLocal.x - newJ.footL.x) - (o.a.torso + o.a.legL.u + o.a.legL.f));
          } else if (drag.part === 'toeR') {
            const newJ = jointData(o);
            o.extremity.legAngleR = norm(Math.atan2(pLocal.y - newJ.footR.y, pLocal.x - newJ.footR.x) - (o.a.torso + o.a.legR.u + o.a.legR.f));
          }
        }
      }
      enforcePins(o);
    } else if (o.type === 'image') {
      if (drag.part === 'move') { 
        let tx = p.x + drag.dx;
        let ty = p.y + drag.dy;
        const snap = calcSnap(tx, ty);
        o.x = tx + snap.dx; 
        o.y = ty + snap.dy;
        snapLines.x = snap.lineX;
        snapLines.y = snap.lineY;
      }
    } else if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') { // brush-v5.1.0: ink 走同一套绑定拖动
      if (drag.part === 'move') {
        if (o.bindTo === 'none' || !o.targetId) {
          let tx = p.x + drag.dx;
          let ty = p.y + drag.dy;
          const snap = calcSnap(tx, ty);
          o.x = tx + snap.dx;
          o.y = ty + snap.dy;
          snapLines.x = snap.lineX;
          snapLines.y = snap.lineY;
        } else {
          const fig = AppState.objects.find(f => f.id === o.targetId && f.type === 'figure');
          if (fig) {
            let baseAngle = 0;
            switch (o.bindTo) {
              case 'head': baseAngle = fig.headAngle; break;
              case 'neck': case 'torso_upper': baseAngle = fig.a.torso + fig.a.waist; break;
              case 'waist': case 'torso_lower': baseAngle = fig.a.torso; break;
              case 'pelvis': baseAngle = fig.a.torso; break;
              case 'elbowL': baseAngle = fig.a.torso + fig.a.waist + fig.a.armL.u; break;
              case 'elbowR': baseAngle = fig.a.torso + fig.a.waist + fig.a.armR.u; break;
              case 'handL': baseAngle = fig.a.torso + fig.a.waist + fig.a.armL.u + fig.a.armL.f; break;
              case 'handR': baseAngle = fig.a.torso + fig.a.waist + fig.a.armR.u + fig.a.armR.f; break;
              case 'kneeL': baseAngle = fig.a.torso + fig.a.legL.u; break;
              case 'kneeR': baseAngle = fig.a.torso + fig.a.legR.u; break;
              case 'footL': baseAngle = fig.a.torso + fig.a.legL.u + fig.a.legL.f; break;
              case 'footR': baseAngle = fig.a.torso + fig.a.legR.u + fig.a.legR.f; break;
            }
            const pLocal = (fig.rot || fig.mirror) ? worldToFigureLocal(fig, p) : p;
            const startLocal = (fig.rot || fig.mirror) ? worldToFigureLocal(fig, { x: drag.startX, y: drag.startY }) : { x: drag.startX, y: drag.startY };
            const dxLocal = pLocal.x - startLocal.x;
            const dyLocal = pLocal.y - startLocal.y;
            const cos = Math.cos(-baseAngle), sin = Math.sin(-baseAngle);
            o.offX = drag.startOffX + (dxLocal * cos - dyLocal * sin) / fig.scale;
            o.offY = drag.startOffY + (dxLocal * sin + dyLocal * cos) / fig.scale;
            setGlobalPropForBound(o, 'offX', o.offX);
            setGlobalPropForBound(o, 'offY', o.offY);
          }
        }
      }
    }
    EventBus.emit('need:render');
  }

  function onPointerUp(e) {
    /* v5.2.0 扭曲控制点的 pointerup 由控制点自己接管，画布不做收尾 */
    if (SKFE.systems.distort.isDragging()) return;
    if (SKFE.systems.eraser.isDragging()) {
      SKFE.systems.eraser.finishStroke();
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (drag && (drag.part === 'camera-view-pan' || drag.part === 'camera-view-move')) {
      const isPan = drag.part === 'camera-view-pan';
      drag = null;
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (isPan) {
        markCurrentFrameModified();
        EventBus.emit('history:save', '移动摄像机');
      }
      EventBus.emit('need:render');
      return;
    }
    if (draggingCanvasBounds) {
      draggingCanvasBounds = false;
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      EventBus.emit('history:save', '拖动画布边界');
      return;
    }
    if (draggingGroundLine) {
      draggingGroundLine = false;
      pointers.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      EventBus.emit('history:save', '拖动参考线');
      return;
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      lastDist = 0;
      /* 双指缩放摄像机结束 → 保存历史并刷新缩略图 */
      if (twoFingerMode === 'camera') {
        twoFingerMode = 'view';
        if (camWheelThumbTimer) { clearTimeout(camWheelThumbTimer); camWheelThumbTimer = null; }
        invalidateAllFrameThumbs();
        updateFrameBar();
        EventBus.emit('history:save', '缩放摄像机');
        EventBus.emit('need:render');
      }
    }

    if (isPanning) {
      isPanning = false;
    } else if (drag) {
      const part = drag.part;
      const movedFig = drag.o;
      const dragStartWorld = drag.startWorldPos;
      const startPelvis = (drag.startFixedJ && drag.startFixedJ.pelvis)
        ? { x: drag.startFixedJ.pelvis.x, y: drag.startFixedJ.pelvis.y }
        : null;
      drag = null;
      EventBus.emit('need:syncUI');
      markCurrentFrameModified();
      if (part === 'rotate') EventBus.emit('history:save', '旋转对象');
      else if (part === 'anchor') EventBus.emit('history:save', '设置锚点');
      else if (part === 'camera-move') EventBus.emit('history:save', '移动摄像机');
      else if (part === 'pelvis') {
        if (movedFig && startPelvis) applyGlobalPositionDelta(movedFig, startPelvis);
        EventBus.emit('history:save', '移动对象');
      }
      else if (part === 'move') {
        /* global-v5.1.1: 画布直接拖动图片/配饰时，位移同样要同步到该元件的其它帧
           （以前只有四角变换框拖动才同步，导致"某帧位置对不上"） */
        if (movedFig && dragStartWorld && movedFig.type !== 'figure') {
          applyGlobalPositionDeltaForObject(movedFig, dragStartWorld);
        }
        EventBus.emit('history:save', '移动对象');
      }
      else EventBus.emit('history:save', '调整姿势');
    }

    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    snapLines = { x: null, y: null }; /* 松手清空线 */
    EventBus.emit('need:render');
  }

  /* ==================== v4.7.1 相对滑条逻辑 ==================== */
  let sliderDragStartPos = { x: 0, y: 0 };
  let sliderDragStartScale = 1;
  let sliderDragStartRot = 0;

  function onPosSliderStart() {
    // 新增：按下滑动条时，立刻记录当前状态（相当于预存修改前的状态）
    if (AppState.canvasSelected || AppState.selected) {
      pushPreSnapshot(getSnapshot(), '滑动调整');
    }

    if (AppState.canvasSelected && AppState.canvasBoundsEnabled) {
      sliderDragStartPos = { x: AppState.canvasBounds.x + AppState.canvasBounds.w / 2, y: AppState.canvasBounds.y + AppState.canvasBounds.h / 2 };
      sliderDragStartScale = canvasBaseBounds ? (AppState.canvasBounds.w / canvasBaseBounds.w) : 1;
      sliderDragStartRot = (AppState.canvasBounds.rotation || 0) * 180 / Math.PI;
    } else if (AppState.selected) {
      sliderDragStartPos = getObjectWorldPos(AppState.selected);
      sliderDragStartScale = AppState.selected.scale || 1;
      sliderDragStartRot = AppState.selected.rot || 0;
    } else {
      sliderDragStartPos = { x: 0, y: 0 };
      sliderDragStartScale = 1;
      sliderDragStartRot = 0;
    }
  }

  function onPosSliderMove(axis) {
    if (!AppState.canvasSelected && !AppState.selected) return;
    
    if (axis === 'scale') {
      const val = parseFloat(posScaleSlider.value);
      if (val === 0) return;
      const factor = 1 + (val / 100);
      const newScale = Math.max(0.01, Math.min(100, sliderDragStartScale * factor));
      
      if (AppState.canvasSelected && AppState.canvasBoundsEnabled) {
        if (!canvasBaseBounds) canvasBaseBounds = { ...AppState.canvasBounds };
        const cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
        const cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
        AppState.canvasBounds.w = canvasBaseBounds.w * newScale;
        AppState.canvasBounds.h = canvasBaseBounds.h * newScale;
        AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
        AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
      } else if (AppState.selected) {
        AppState.selected.scale = newScale;
        if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
          setGlobalPropForBound(AppState.selected, 'scale', AppState.selected.scale);
        } else {
          setGlobalProp(AppState.selected, 'scale', AppState.selected.scale);
        }
      }
    } else if (axis === 'rotate') {
      const val = parseFloat(posRotSlider.value);
      if (val === 0) return;
      const newRot = sliderDragStartRot + val;
      if (AppState.canvasSelected && AppState.canvasBoundsEnabled) {
        AppState.canvasBounds.rotation = newRot * Math.PI / 180;
      } else if (AppState.selected) {
        AppState.selected.rot = newRot;
        if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
          setGlobalPropForBound(AppState.selected, 'rot', AppState.selected.rot);
        } else {
          setGlobalProp(AppState.selected, 'rot', AppState.selected.rot);
        }
      }
    } else {
      const val = axis === 'x' ? parseFloat(posXSlider.value) : parseFloat(posYSlider.value);
      const delta = val * 4; 
      if (AppState.canvasSelected && AppState.canvasBoundsEnabled) {
        const nx = sliderDragStartPos.x + (axis === 'x' ? delta : 0);
        const ny = sliderDragStartPos.y - (axis === 'y' ? delta : 0); 
        AppState.canvasBounds.x = nx - AppState.canvasBounds.w / 2;
        AppState.canvasBounds.y = ny - AppState.canvasBounds.h / 2;
        syncCanvasUI();
      } else if (AppState.selected) {
        const nx = sliderDragStartPos.x + (axis === 'x' ? delta : 0);
        const ny = sliderDragStartPos.y - (axis === 'y' ? delta : 0);
        setObjectWorldPos(AppState.selected, nx, ny);
      }
    }
    EventBus.emit('need:render');
    updatePosInputs();
  }

  function onPosSliderEnd() {
    if (posXSlider) posXSlider.value = 0;
    if (posYSlider) posYSlider.value = 0;
    if (posScaleSlider) posScaleSlider.value = 0;
    if (posRotSlider) posRotSlider.value = 0;
    if (AppState.canvasSelected || AppState.selected) {
      /* global-v5.1.1: 位移滑条同样把位移同步到该元件的其它帧 */
      if (AppState.selected && !AppState.canvasSelected && sliderDragStartPos) {
        if (isBoundObj(AppState.selected)) {
          setGlobalPropForBound(AppState.selected, 'offX', AppState.selected.offX);
          setGlobalPropForBound(AppState.selected, 'offY', AppState.selected.offY);
        } else {
          applyGlobalPositionDeltaForObject(AppState.selected, sliderDragStartPos);
        }
      }
      markCurrentFrameModified();
      // saveHistory('滑动调整');  // 删除这行，因为已经在 onPosSliderStart 记录了
    }
    EventBus.emit('need:syncUI');
  }

  const _pX = document.getElementById('posXSlider');
  const _pY = document.getElementById('posYSlider');
  const _pS = document.getElementById('posScaleSlider');
  const _pR = document.getElementById('posRotSlider');
  
  if (_pX) {
    _pX.addEventListener('pointerdown', onPosSliderStart);
    _pX.addEventListener('input', () => onPosSliderMove('x'));
    _pX.addEventListener('change', onPosSliderEnd);
    _pX.addEventListener('pointerup', onPosSliderEnd);
  }
  if (_pY) {
    _pY.addEventListener('pointerdown', onPosSliderStart);
    _pY.addEventListener('input', () => onPosSliderMove('y'));
    _pY.addEventListener('change', onPosSliderEnd);
    _pY.addEventListener('pointerup', onPosSliderEnd);
  }
  if (_pS) {
    _pS.addEventListener('pointerdown', onPosSliderStart);
    _pS.addEventListener('input', () => onPosSliderMove('scale'));
    _pS.addEventListener('change', onPosSliderEnd);
    _pS.addEventListener('pointerup', onPosSliderEnd);
  }
  if (_pR) {
    _pR.addEventListener('pointerdown', onPosSliderStart);
    _pR.addEventListener('input', () => onPosSliderMove('rotate'));
    _pR.addEventListener('change', onPosSliderEnd);
    _pR.addEventListener('pointerup', onPosSliderEnd);
  }
  /* ====================================================================== */

  /* ==================== 坐标输入 / 锚点 ==================== */
  function commitCoordInput() {
    if (AppState.canvasSelected && AppState.canvasBoundsEnabled) {
      const nx = parseFloat(objXInput.value);
      const nyDisp = parseFloat(objYInput.value);
      if (!isFinite(nx) || !isFinite(nyDisp)) { updatePosInputs(); return; }
      const pre = getSnapshot();
      const cx = nx;
      const cy = -nyDisp;
      AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
      AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
      pushPreSnapshot(pre, '移动画布边界');
      syncCanvasUI(); EventBus.emit('need:render');
      return;
    }
    if (!AppState.selected) return;
    if (globalEditEnabled && AppState.selected.type === 'figure' && hasAnyPinInAllFrames(AppState.selected)) {
      alert(tr2('alert.ikMove', '当前元件存在关节固定，请先在「关节」面板中解除所有帧的固定，才能整体位移。'));
      updatePosInputs();
      return;
    }
    const nx = parseFloat(objXInput.value);
    const nyDisp = parseFloat(objYInput.value);
    if (!isFinite(nx) || !isFinite(nyDisp)) { updatePosInputs(); return; }
    const pre = getSnapshot();
    const prevPos = (AppState.selected.type === 'figure') ? { x: AppState.selected.x, y: AppState.selected.y } : null;
    /* global-v5.1.1: 非火柴人元件（图片 / 配饰 / 形状 / 对话框 / 画笔）也要把位移同步到其它帧，
       否则手填坐标只改当前帧，看起来就是"某一帧位置不对" */
    const prevWorld = prevPos ? null : getObjectWorldPos(AppState.selected);
    setObjectWorldPos(AppState.selected, nx, -nyDisp);
    if (prevPos) applyGlobalPositionDelta(AppState.selected, prevPos);
    else if (prevWorld) applyGlobalPositionDeltaForObject(AppState.selected, prevWorld);
    if (isBoundObj(AppState.selected)) {
      setGlobalPropForBound(AppState.selected, 'offX', AppState.selected.offX);
      setGlobalPropForBound(AppState.selected, 'offY', AppState.selected.offY);
    }
    pushPreSnapshot(pre, '移动对象');
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
  }
  if (objXInput && objYInput) {
    objXInput.addEventListener('change', commitCoordInput);
    objYInput.addEventListener('change', commitCoordInput);
    [objXInput, objYInput].forEach(inp => inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commitCoordInput(); inp.blur(); }
    }));
  }
  
  if (objSizeInput) {
    objSizeInput.addEventListener('change', () => {
      const val = parseFloat(objSizeInput.value);
      if (!isFinite(val) || val <= 0) { updatePosInputs(); return; }
      if (AppState.canvasSelected && AppState.canvasBoundsEnabled && canvasBaseBounds) {
        const pre = getSnapshot();
        const k = Math.max(0.05, Math.min(10, val));
        const cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
        const cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
        AppState.canvasBounds.w = canvasBaseBounds.w * k;
        AppState.canvasBounds.h = canvasBaseBounds.h * k;
        AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
        AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
        syncCanvasUI();
        EventBus.emit('need:render');
        pushPreSnapshot(pre, '缩放画布');
      } else if (AppState.selected) {
        const pre = getSnapshot();
        AppState.selected.scale = Math.max(0.01, Math.min(100, val));
        if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
          setGlobalPropForBound(AppState.selected, 'scale', AppState.selected.scale);
        } else {
          setGlobalProp(AppState.selected, 'scale', AppState.selected.scale);
        }
        EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
        pushPreSnapshot(pre, '调整大小');
      }
    });
  }

  /* 吸附开关按钮 */
  const btnSnapToggle = document.getElementById('btnSnapToggle');
  function syncSnapBtn() {
    if (!btnSnapToggle) return;
    btnSnapToggle.classList.toggle('on', snapEnabled);
    btnSnapToggle.style.color = snapEnabled ? 'var(--color-primary)' : '';
    btnSnapToggle.style.background = snapEnabled ? 'var(--color-primary-soft)' : '';
    btnSnapToggle.style.borderRadius = '8px';
    btnSnapToggle.title = snapEnabled ? tr2('snap.off', '关闭吸附') : tr2('snap.on', '开启吸附');
  }
  if (btnSnapToggle) {
    syncSnapBtn();
    btnSnapToggle.onclick = (e) => {
      e.preventDefault();
      snapEnabled = !snapEnabled;
      localStorage.setItem('skfe_snap_enabled', snapEnabled ? '1' : '0');
      syncSnapBtn();
      if (!snapEnabled) {
        snapLines = { x: null, y: null };
        EventBus.emit('need:render');
      }
    };
  }

  /* 关节拉伸开关绑定 */
  if (jointStretchToggle) {
    jointStretchToggle.addEventListener('change', (e) => {
      jointStretchOn = e.target.checked;
    });
  }

  /* 锚点模式开关 */
  btnAnchorToggle.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!AppState.selected) return;
    anchorModeOn = !anchorModeOn;
    EventBus.emit('need:syncUI');
    EventBus.emit('need:render');
  });

  if (objAnchorX && objAnchorY) {
    const applyAnchorInput = () => {
      if (!AppState.selected) return;
      const vx = parseFloat(objAnchorX.value);
      const vy = parseFloat(objAnchorY.value);
      if (!isFinite(vx) || !isFinite(vy)) return;
      AppState.selected.ax = vx;
      AppState.selected.ay = vy;
      if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
        setGlobalPropForBound(AppState.selected, 'ax', vx);
        setGlobalPropForBound(AppState.selected, 'ay', vy);
      } else {
        setGlobalProp(AppState.selected, 'ax', vx);
        setGlobalProp(AppState.selected, 'ay', vy);
      }
      markCurrentFrameModified();
      EventBus.emit('need:render');
    };
    objAnchorX.addEventListener('input', applyAnchorInput);
    objAnchorY.addEventListener('input', applyAnchorInput);
    objAnchorX.addEventListener('change', () => EventBus.emit('history:save', '设置锚点'));
    objAnchorY.addEventListener('change', () => EventBus.emit('history:save', '设置锚点'));
  }
  if (btnAnchorCenter) {
    btnAnchorCenter.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!AppState.selected) return;
      AppState.selected.ax = 0; AppState.selected.ay = 0;
      if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
        setGlobalPropForBound(AppState.selected, 'ax', 0);
        setGlobalPropForBound(AppState.selected, 'ay', 0);
      } else {
        setGlobalProp(AppState.selected, 'ax', 0);
        setGlobalProp(AppState.selected, 'ay', 0);
      }
      EventBus.emit('need:syncUI'); markCurrentFrameModified(); EventBus.emit('need:render'); EventBus.emit('history:save', '锚点复位');
    });
  }

  if (anchorHandleEl) {
    anchorHandleEl.addEventListener('pointerdown', (e) => {
      if (!AppState.selected) return;
      e.preventDefault(); e.stopPropagation();
      anchorHandleDrag = {
        id: e.pointerId,
        sx: e.clientX,
        sy: e.clientY,
        ax: AppState.selected.ax || 0,
        ay: AppState.selected.ay || 0,
        moved: false,
        pre: getSnapshot(),
        target: AppState.selected
      };
      try { anchorHandleEl.setPointerCapture(e.pointerId); } catch (_) {}
    });

    anchorHandleEl.addEventListener('pointermove', (e) => {
      if (!anchorHandleDrag || e.pointerId !== anchorHandleDrag.id) return;
      e.preventDefault(); e.stopPropagation();
      
      const o = anchorHandleDrag.target;
      if (!o) return;
      
      const dx = (e.clientX - anchorHandleDrag.sx) / AppState.viewScale;
      const dy = (e.clientY - anchorHandleDrag.sy) / AppState.viewScale;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) anchorHandleDrag.moved = true;
      
      // 转换到局部坐标系
      const rot = (o.rot || 0) * Math.PI / 180;
      const c = Math.cos(-rot), s = Math.sin(-rot);
      const dxLoc = dx * c - dy * s;
      const dyLoc = dx * s + dy * c;
      
      const sc = o.scale || 1;
      if (sc !== 0) {
        o.ax = anchorHandleDrag.ax + dxLoc / sc;
        o.ay = anchorHandleDrag.ay + dyLoc / sc;
        if (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') {
          setGlobalPropForBound(o, 'ax', o.ax);
          setGlobalPropForBound(o, 'ay', o.ay);
        } else {
          setGlobalProp(o, 'ax', o.ax);
          setGlobalProp(o, 'ay', o.ay);
        }
      }
      
      if (objAnchorX && document.activeElement !== objAnchorX) objAnchorX.value = Math.round(o.ax || 0);
      if (objAnchorY && document.activeElement !== objAnchorY) objAnchorY.value = Math.round(o.ay || 0);
      
      EventBus.emit('need:render');
    });

    const endAnchorDrag = (e) => {
      if (!anchorHandleDrag || e.pointerId !== anchorHandleDrag.id) return;
      const didMove = anchorHandleDrag.moved;
      const pre = anchorHandleDrag.pre;
      anchorHandleDrag = null;
      try { anchorHandleEl.releasePointerCapture(e.pointerId); } catch (_) {}
      
      if (didMove) {
        if (pre) pushPreSnapshot(pre, '设置锚点');
        markCurrentFrameModified();
      }
    };
    anchorHandleEl.addEventListener('pointerup', endAnchorDrag);
    anchorHandleEl.addEventListener('pointercancel', endAnchorDrag);
  }

  /* ==================== 旋转 / 镜像 ==================== */
  if (objRotationInput) {
    objRotationInput.addEventListener('input', (e) => {
      const deg = parseFloat(e.target.value);
      if (!isFinite(deg)) return;
      if (objRotationVal) objRotationVal.textContent = deg + '°';
      if (AppState.canvasSelected && AppState.canvasBoundsEnabled) {
        AppState.canvasBounds.rotation = deg * Math.PI / 180;
        EventBus.emit('need:render');
        return;
      }
      if (!AppState.selected) return;
      AppState.selected.rot = deg;
      if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
        setGlobalPropForBound(AppState.selected, 'rot', deg);
      } else {
        setGlobalProp(AppState.selected, 'rot', deg);
      }
      EventBus.emit('need:render');
      markCurrentFrameModified();
    });
    objRotationInput.addEventListener('change', () => {
      EventBus.emit('history:save', AppState.canvasSelected ? '旋转画布' : '旋转对象');
    });
  }

  /* ==================== 颜色增强：画面吸色 + 预设色块（js/features/color-tools.js） ==================== */
  SKFE.features.colorTools.init({
    getCtx: () => ctx,
    getCanvas: () => canvas,
    getPageBgColor: () => pageBgColor,
  });
  SKFE.features.colorTools.boot();

  /* ==================== 添加 / 复制 / 删除 ==================== */
  function addFigure() {
    const sp = getSpawnPoint();
    const f = makeFigure(sp.x, sp.y, currentColor, currentLW);
    f.layer = { body: 1, head: 2, armL: 1, armR: 1, legL: 1, legR: 1 };
    generateName(f); addObjectToFrames(f); select(f); EventBus.emit('need:render');
    EventBus.emit('history:save', '添加火柴人');
  }
  function addShape(type) {
    const sp = getSpawnPoint();
    const s = makeShape(type, sp.x, sp.y);
    s.layer = 1;
    generateName(s); addObjectToFrames(s); select(s); EventBus.emit('need:render');
    EventBus.emit('history:save', '添加图形');
  }
  function addBubble() {
    const sp = getSpawnPoint();
    let cy = sp.y;
    const existingBubbles = AppState.objects.filter(o => o.type === 'bubble');
    if (existingBubbles.length > 0) {
      const last = existingBubbles[existingBubbles.length - 1];
      cy = last.y + (last.h * last.scale) / 2 + 60;
    }
    const b = makeBubble(sp.x, cy);
    b.layer = 10;
    generateName(b); addObjectToFrames(b); select(b); EventBus.emit('need:render');
    EventBus.emit('history:save', '添加对话框');
  }

  function cloneSelected() {
    if (!AppState.selected || AppState.selected.type === 'video') return;
    if (AppState.selected.type === 'camera') { alert(tr2('alert.cameraSingle', '摄像机只能存在一个。')); return; }
    const copy = JSON.parse(JSON.stringify(AppState.selected, (k, v) => (k === 'img' ? undefined : v)));
    copy.id = ++uid; generateName(copy);
    if (AppState.selected.img) copy.img = AppState.selected.img;
    if (copy.type === 'figure') Object.keys(copy.layer).forEach(k => copy.layer[k] += 1);
    else copy.layer += 1;
    if (copy.type === 'figure' || copy.type === 'image') { copy.x += 46; copy.y += 34; }
    if (copy.ax === undefined) copy.ax = 0;
    if (copy.ay === undefined) copy.ay = 0;
    addObjectToFrames(copy); select(copy); EventBus.emit('need:render');
    EventBus.emit('history:save', '复制对象');
  }

  function deleteSelected() {
    if (!AppState.selected) return;
    if (AppState.selected.type === 'video') {
      /* v6.1.0：选中参考视频时删除 = 移除参考视频（以前是直接 return，删不掉） */
      removeReferenceVideo();
      return;
    }
    const id = AppState.selected.id;
    const isFigure = AppState.selected.type === 'figure';
    const shouldRemove = (o) => {
      if (!o) return false;
      if (o.id === id) return true;
      if (isFigure && (o.type === 'acc' || o.type === 'shape' || o.type === 'bubble' || o.type === 'ink') && o.targetId === id) return true; // brush-v5.1.0: 删除火柴人时一并删除挂载的画笔
      return false;
    };
    if (isSubTrackMode()) {
      /* 子轨道删除：只清空当前轨道当前帧，绝不触碰其他 track */
      const t = AppState.tracks[AppState.activeTrackId];
      if (t && t.frames) {
        if (shouldRemove(getTrackFrame(AppState.activeTrackId, AppState.currentFrameIndex))) t.frames[AppState.currentFrameIndex] = null;
      }
    } else if (globalEditEnabled) {
      /* 全局删除：从所有 track 的所有帧中移除该元件及其挂件 */
      for (const tid in AppState.tracks) {
        const t = AppState.tracks[tid];
        if (!t || !t.frames) continue;
        for (let i = 0; i < t.frames.length; i++) {
          if (shouldRemove(t.frames[i])) t.frames[i] = null;
        }
      }
    } else {
      /* 全局模式但未开启全局编辑：只清当前帧合并视图 */
      for (const tid in AppState.tracks) {
        if (shouldRemove(getTrackFrame(tid, AppState.currentFrameIndex))) setTrackFrame(tid, AppState.currentFrameIndex, null);
      }
    }
    /* 清空后移除整条轨道，避免残留空轨道 */
    pruneEmptyTracks();
    AppState.selected = null;
    AppState.canvasSelected = false;
    syncMainLengthFromTracks();
    trimTrailingEmptyFrames();
    AppState.objects = getCombinedObjectsForRender();
    if (isSubTrackMode()) AppState.selected = getActiveTrackObject();
    refreshSubTrackOptions();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('app:update', '删除对象');
  }

  /* brush-v5.1.0: 删除当前帧的所有画笔元件（面板「清除本帧画笔元件」） */
  function deleteInkOnCurrentFrame() {
    const inkIds = AppState.objects.filter(o => o && o.type === 'ink').map(o => String(o.id));
    if (!inkIds.length) return 0;
    for (const tid of inkIds) {
      const t = AppState.tracks[tid];
      if (!t || !t.frames) continue;
      t.frames[AppState.currentFrameIndex] = null;
      if (t.frames.every(d => d == null)) {
        delete AppState.tracks[tid];
        if (AppState.activeTrackId === tid) AppState.activeTrackId = TRACK_ALL_ID;
      }
    }
    pruneEmptyTracks();
    if (AppState.selected && AppState.selected.type === 'ink' && inkIds.indexOf(String(AppState.selected.id)) !== -1) {
      AppState.selected = null;
    }
    AppState.canvasSelected = false;
    AppState.objects = getCombinedObjectsForRender();
    if (isSubTrackMode()) AppState.selected = getActiveTrackObject();
    refreshSubTrackOptions();
    invalidateAllFrameThumbs();
    updateFrameBar();
    markCurrentFrameModified();
    EventBus.emit('history:save', '清除本帧画笔元件');
    EventBus.emit('need:render');
    EventBus.emit('need:syncUI');
    return inkIds.length;
  }

  function resetPose() {
    if (!AppState.selected) return;
    if (AppState.selected.type === 'video') {
      AppState.selected.x = 0; AppState.selected.y = 0; AppState.selected.scale = 1; AppState.selected.alpha = 1;
    } else if (AppState.selected.type === 'figure') {
      /* v6.3.0：复位统一以 makeFigure 的初始预设为准，避免两处硬编码走散 */
      const tpl = makeFigure(0, 0);
      AppState.selected.a = tpl.a;
      AppState.selected.bodyScale = tpl.bodyScale;
      AppState.selected.scale = 1.67;
      AppState.selected.rot = 0;
      AppState.selected.mirror = false;
      AppState.selected.headFilled = false;
      AppState.selected.headFillCustom = false;
      AppState.selected.headFillColor = '#111111';
      AppState.selected.headAngle = tpl.headAngle;
      AppState.selected.headOffset = { x: 0, y: 0 };
      AppState.selected.shadowOffX = 0; AppState.selected.shadowOffY = 0;
      AppState.selected.shadowScaleX = 1; AppState.selected.shadowScaleY = 1;
      AppState.selected.shadowColor = '#000000'; AppState.selected.shadowAlpha = 0.3;
      AppState.selected.light = { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 };
      AppState.selected.glow = { enabled: false, color: '#000000', alpha: 0.45, blur: 14, offsetX: 3, offsetY: -4, spread: 0, includeAcc: false };
      AppState.selected.joint = { enabled: false, color: '#ff0000', len: 0.5 };
      AppState.selected.extremity = {
        enabled: false,
        armAngleL: 30 * Math.PI / 180, armAngleR: 30 * Math.PI / 180,
        legAngleL: 30 * Math.PI / 180, legAngleR: 30 * Math.PI / 180,
        armRatio: 0.23, legRatio: 0.23
      };
      AppState.selected.pinned = { footL: false, footR: false, handL: false, handR: false, pelvis: false };
      AppState.selected.pinnedPos = { footL: null, footR: null, handL: null, handR: null, pelvis: null };
      AppState.selected.layer = { body: 1, head: 2, armL: 1, armR: 1, legL: 1, legR: 1 };
      AppState.selected.depth = { enabled: false, useCustom: false, customColor: '#555555' };
      AppState.selected.ikEnabled = false;
    } else if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble' || AppState.selected.type === 'ink') {
      AppState.selected.scale = 1; AppState.selected.rot = 0; AppState.selected.offX = 0; AppState.selected.offY = 0;
      AppState.selected.ax = 0; AppState.selected.ay = 0;
      AppState.selected.mirror = false; // brush-v5.1.0: ink 复位时一并清除镜像
      if (AppState.selected.type === 'shape') { AppState.selected.w = 60; AppState.selected.h = 60; }
      if (AppState.selected.type === 'bubble') {
        AppState.selected.w = 180; AppState.selected.h = 90;
        AppState.selected.customSize = false; AppState.selected.customW = 180; AppState.selected.customH = 90;
      }
    } else if (AppState.selected.type === 'image') {
      AppState.selected.scale = 1; AppState.selected.rot = 0; AppState.selected.ax = 0; AppState.selected.ay = 0;
    } else {
      AppState.selected.scale = 1;
    }
    EventBus.emit('need:syncUI'); EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', '重置对象');
  }

  function moveLayer(dir) {
    if (!AppState.selected) return;
    if (AppState.selected.type === 'video') {
      /* v6.3.0：置顶/置底改成「当前最高层 +1 / 最低层 -1」，不再写 9999 这种极限值 */
      const others = AppState.objects.filter(o => o && o !== AppState.selected && o.type !== 'video');
      const vals = others.map(o => (o.type === 'figure' ? (o.layer.body || 0) : (o.layer || 0)));
      const hi = vals.length ? Math.max.apply(null, vals) : 0;
      const lo = vals.length ? Math.min.apply(null, vals) : 0;
      if (dir === 'up') AppState.selected.layer += 1;
      else if (dir === 'down') AppState.selected.layer -= 1;
      else if (dir === 'top') AppState.selected.layer = hi + 1;
      else if (dir === 'bottom') AppState.selected.layer = lo - 1;
      EventBus.emit('need:render'); markCurrentFrameModified(); EventBus.emit('history:save', '调整图层'); return;
    }
    const isFig = AppState.selected.type === 'figure';
    /* v6.3.0：置顶/置底按「其余对象里的最高层 +1 / 最低层 -1」算，不再写 999 这类极限值。
       必须排除自身，否则反复点置顶会让层值一路膨胀。已经在最顶/最底时保持不动。 */
    let otherLayers = [];
    AppState.objects.forEach(o => {
      if (!o || o === AppState.selected) return;
      if (o.type === 'figure') Object.values(o.layer).forEach(v => otherLayers.push(v));
      else otherLayers.push(o.layer);
    });
    const minLayer = otherLayers.length ? Math.min(...otherLayers) : 0;
    const maxLayer = otherLayers.length ? Math.max(...otherLayers) : 0;
    if (dir === 'up') {
      if (isFig) Object.keys(AppState.selected.layer).forEach(k => { AppState.selected.layer[k] += 1; setGlobalProp(AppState.selected, `layer.${k}`, AppState.selected.layer[k]); });
      else { AppState.selected.layer += 1; setGlobalProp(AppState.selected, 'layer', AppState.selected.layer); }
    } else if (dir === 'down') {
      if (isFig) Object.keys(AppState.selected.layer).forEach(k => { AppState.selected.layer[k] -= 1; setGlobalProp(AppState.selected, `layer.${k}`, AppState.selected.layer[k]); });
      else { AppState.selected.layer -= 1; setGlobalProp(AppState.selected, 'layer', AppState.selected.layer); }
    } else if (dir === 'top') {
      if (isFig) Object.keys(AppState.selected.layer).forEach(k => { AppState.selected.layer[k] = maxLayer + 1; setGlobalProp(AppState.selected, `layer.${k}`, AppState.selected.layer[k]); });
      else { AppState.selected.layer = maxLayer + 1; setGlobalProp(AppState.selected, 'layer', AppState.selected.layer); }
    } else if (dir === 'bottom') {
      /* v6.3.0：非火柴人以前写死 -99999，改成「当前最低层 -1」 */
      if (isFig) Object.keys(AppState.selected.layer).forEach(k => { AppState.selected.layer[k] = minLayer - 1; setGlobalProp(AppState.selected, `layer.${k}`, AppState.selected.layer[k]); });
      else { AppState.selected.layer = minLayer - 1; setGlobalProp(AppState.selected, 'layer', AppState.selected.layer); }
    }
    EventBus.emit('need:syncUI'); EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', '调整图层');
  }

  /* ==================== 事件绑定 ==================== */
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    /* 摄像机视角：
       - 取景框内滚轮 → 缩放摄像机本身（改 cam.scale），相当于在主时间轴改变取景框大小
       - 取景框外滚轮 → 缩放页面视图（改 camViewZoom） */
       const camViewObj = SKFE.systems.camera.getCameraViewObject();
    if (camViewObj) {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const ct = SKFE.systems.camera.getCameraViewTransform(camViewObj);
      const inside = (
        mouseX >= ct.left && mouseX <= ct.left + ct.viewW &&
        mouseY >= ct.top && mouseY <= ct.top + ct.viewH
      );
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;

      if (inside) {
        /* 缩放摄像机：以鼠标位置对应的世界坐标为锚点，保证鼠标下的世界点不动 */
        const oldScale = camViewObj.scale || 1;
        const newScale = Math.min(10, Math.max(0.1, oldScale * zoomFactor));
        if (Math.abs(newScale - oldScale) < 1e-6) return;
        const worldPt = SKFE.systems.camera.cameraScreenToWorld({ x: mouseX, y: mouseY }, camViewObj, ct);
        camViewObj.scale = newScale;
        const ctAfter = SKFE.systems.camera.getCameraViewTransform(camViewObj);
        const worldAfter = SKFE.systems.camera.cameraScreenToWorld({ x: mouseX, y: mouseY }, camViewObj, ctAfter);
        camViewObj.x += worldPt.x - worldAfter.x;
        camViewObj.y += worldPt.y - worldAfter.y;
        if (globalEditEnabled) {
          /* v6.1.0：缩放 + 锚点位移一起走全局，逐帧都是同一份取景框 */
          setGlobalProp(camViewObj, 'scale', newScale);
          setGlobalProp(camViewObj, 'x', camViewObj.x);
          setGlobalProp(camViewObj, 'y', camViewObj.y);
        }
        markCurrentFrameModified();
        EventBus.emit('need:render');
        /* 连续滚轮停止 300ms 后再刷新缩略图与历史，避免过程卡顿 */
        if (camWheelThumbTimer) clearTimeout(camWheelThumbTimer);
        camWheelThumbTimer = setTimeout(() => {
          camWheelThumbTimer = null;
          invalidateAllFrameThumbs();
          updateFrameBar();
          EventBus.emit('history:save', '缩放摄像机');
        }, 300);
      } else {
        /* 缩放页面视图 */
        const newZoom = Math.min(20, Math.max(0.05, camViewZoom * zoomFactor));
        const cx = (canvas.clientWidth / 2) + camViewOffset.x;
        const cy = (canvas.clientHeight / 2) + camViewOffset.y;
        const k = newZoom / camViewZoom;
        camViewOffset.x += (mouseX - cx) * (1 - k);
        camViewOffset.y += (mouseY - cy) * (1 - k);
        camViewZoom = newZoom;
        EventBus.emit('need:render');
      }
      return;
    }

    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    /* v6.2.0：这段与画笔 overlay 共用同一个实现 */
    if (!zoomViewAt(e.clientX, e.clientY, zoomFactor)) return;
  }, { passive: false });

  /* v6.2.0：以视口坐标 (clientX, clientY) 为锚缩放画布视图。
     抽出来是为了给画笔的 overlay 复用 —— 画笔模式下 overlay 会吃掉滚轮/双指，
     不转进来的话，画到一半就没法缩放画布了。返回是否真的缩放了。 */
  function zoomViewAt(clientX, clientY, factor) {
    if (!(factor > 0) || !isFinite(factor)) return false;
    if (SKFE.systems.camera.getCameraViewObject()) return false; /* 摄像机视角另有自己的缩放 */
    let newScale = Math.min(VIEW_SCALE_MAX, Math.max(VIEW_SCALE_MIN, AppState.viewScale * factor));
    if (viewPinned && pinnedView) newScale = Math.max(newScale, pinnedView.scale);
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    if (viewPinned && pinnedView && newScale <= pinnedView.scale + 0.0001) {
      AppState.viewScale = pinnedView.scale;
      AppState.viewOffset.x = pinnedView.offset.x;
      AppState.viewOffset.y = pinnedView.offset.y;
    } else {
      const actualZoom = newScale / AppState.viewScale;
      AppState.viewOffset.x = mx - (mx - AppState.viewOffset.x) * actualZoom;
      AppState.viewOffset.y = my - (my - AppState.viewOffset.y) * actualZoom;
      AppState.viewScale = newScale;
    }
    EventBus.emit('need:render');
    return true;
  }

  /* v7.0.2：按屏幕像素平移视图。
     画布的双指拖动走的是自己的 pointer 逻辑，画笔 overlay 把画布盖住了，
     双指平移得由它转交到这里，两边手感才一致。 */
  function panViewBy(dx, dy) {
    if (!isFinite(dx) || !isFinite(dy)) return false;
    if (!dx && !dy) return false;
    if (SKFE.systems.camera.getCameraViewObject()) return false;  /* 摄像机视角另有自己的平移 */
    if (viewPinned && pinnedView && AppState.viewScale <= pinnedView.scale + 0.0001) {
      AppState.viewOffset.x = pinnedView.offset.x;
      AppState.viewOffset.y = pinnedView.offset.y;
      EventBus.emit('need:render');
      return false;
    }
    AppState.viewOffset.x += dx;
    AppState.viewOffset.y += dy;
    EventBus.emit('need:render');
    return true;
  }

  document.getElementById('btnNew').onclick = addFigure;
  document.getElementById('btnBubble').onclick = addBubble;
  document.getElementById('btnShapeCircle').onclick = () => addShape('circle');
  document.getElementById('btnShapeRect').onclick = () => addShape('rect');
  document.getElementById('btnShapeTri').onclick = () => addShape('tri');
  document.getElementById('btnClone').onclick = cloneSelected;
  /* v7.1.0：顶部那排的「删除」已拿掉 —— 删除改到元件列表每行一个（见 renderLayerPop） */
  document.getElementById('btnReset').onclick = resetPose;

  document.getElementById('btnSaveAction').onclick = saveActionPreset;
  document.getElementById('btnExportActions').onclick = exportActionPresets;
  document.getElementById('btnImportActions').onclick = importActionPresets;

  const fileInputEl = document.createElement('input');
  fileInputEl.type = 'file'; fileInputEl.accept = 'image/*';
  fileInputEl.style.display = 'none';
  document.body.appendChild(fileInputEl);

  document.getElementById('btnImg').onclick = () => { fileInputEl.accept = 'image/*'; fileInputEl.dataset.mode = 'img'; fileInputEl.click(); };
  document.getElementById('btnAcc').onclick = () => { fileInputEl.accept = 'image/*'; fileInputEl.dataset.mode = 'acc'; fileInputEl.click(); };

  fileInputEl.addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const mode = fileInputEl.dataset.mode;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        if (mode === 'replace') {
          // ==================== 替换图片逻辑 ====================
          if (!AppState.selected) return;
          const targetId = String(AppState.selected.id);
          const pre = getSnapshot();
          
          // 1. 替换所有轨道中的图片引用
          for (const id in AppState.tracks) {
            const t = AppState.tracks[id];
            if (!t || !t.frames) continue;
            for (let i = 0; i < t.frames.length; i++) {
              const data = t.frames[i];
              if (data && String(data.id) === targetId) {
                // 如果开启了全局编辑，或者当前帧匹配，则替换
                if (globalEditEnabled || i === AppState.currentFrameIndex) {
                  data.img = img;
                }
              }
            }
          }
          
          // 2. 重新获取渲染列表并恢复选中状态
          AppState.objects = getCombinedObjectsForRender();
          AppState.selected = AppState.objects.find(o => String(o.id) === targetId) || null;
          
          if (AppState.selected) {
            AppState.selected.img = img; // 确保当前选中对象被更新
            // 如果新图片的宽高比与旧图片不同，可以考虑按原宽高中心缩放
            // 但为了“保留原本所有属性”，此处不改变 w/h，让用户自行拉伸调整
          }

          invalidateAllFrameThumbs();
          EventBus.emit('app:update');
          pushPreSnapshot(pre, '替换图片');
          // ======================================================
        } else {
          // ==================== 添加新图片/配饰 ====================
          let obj;
          const sp = getSpawnPoint();
          if (mode === 'acc') obj = makeAccessory(img, sp.x, sp.y);
          else obj = makeImage(img, sp.x, sp.y);
          obj.layer = 1;
          generateName(obj); addObjectToFrames(obj); select(obj); EventBus.emit('need:render');
          EventBus.emit('history:save', mode === 'acc' ? '添加配饰' : '添加图片');
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    fileInputEl.value = '';
  });

  const btnReplace = document.getElementById('btnReplace');
  if (btnReplace) {
    btnReplace.onclick = () => {
      if (!AppState.selected || (AppState.selected.type !== 'image' && AppState.selected.type !== 'acc')) {
        alert(tr2('alert.replaceNeedImage', '请先在画布中选中一个图片或配饰，再进行替换。'));
        return;
      }
      fileInputEl.dataset.mode = 'replace';
      fileInputEl.accept = 'image/*';
      fileInputEl.click();
    };
  }

  targetFigureSelect.addEventListener('change', e => {
    if (AppState.selected && (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'ink')) {
      const val = e.target.value;
      const o = AppState.selected;
      /* bind-keep-v5.1.2: 换绑定目标也不改元件的大小/位置/旋转 —— 只反算相对量 */
      rebindKeepPlacement(o, () => {
        o.targetId = val ? Number(val) : null;
        if (o.targetId && o.bindTo === 'none') o.bindTo = 'head';
      });
      if (accBind) accBind.value = o.bindTo;
      setGlobalPropForBound(o, 'targetId', o.targetId);
      setGlobalPropForBound(o, 'bindTo', o.bindTo);
      syncBindingPlacement(o);
      EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
      EventBus.emit('history:save', '设置绑定目标');
    }
  });

  accBind.addEventListener('change', e => {
    if (AppState.selected && (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'ink')) {
      const o = AppState.selected;
      /* bind-keep-v5.1.2: 切换挂载点只重算 offX/offY/rot，让元件"原地不动、原角度不歪"，
         不再把 offX/offY/rot 归零（归零会让元件跳到关节上，且丢掉用户调好的旋转） */
      rebindKeepPlacement(o, () => {
        o.bindTo = e.target.value;
        if (o.bindTo !== 'none' && !o.targetId) {
          const firstFig = AppState.objects.find(x => x.type === 'figure');
          if (firstFig) { o.targetId = firstFig.id; if (targetFigureSelect) targetFigureSelect.value = firstFig.id; }
        }
      });
      setGlobalPropForBound(o, 'bindTo', o.bindTo);
      setGlobalPropForBound(o, 'targetId', o.targetId);
      syncBindingPlacement(o);
      EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
      EventBus.emit('history:save', '设置挂载点');
    }
  });

  /* 图形 */
  shapeWInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'shape') { AppState.selected.w = +e.target.value; shapeWVal.textContent = AppState.selected.w; setGlobalProp(AppState.selected, 'w', AppState.selected.w); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  shapeHInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'shape') { AppState.selected.h = +e.target.value; shapeHVal.textContent = AppState.selected.h; setGlobalProp(AppState.selected, 'h', AppState.selected.h); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  shapeFill.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'shape') { AppState.selected.fillColor = e.target.value; setGlobalProp(AppState.selected, 'fillColor', AppState.selected.fillColor); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  shapeStroke.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'shape') { AppState.selected.strokeColor = e.target.value; setGlobalProp(AppState.selected, 'strokeColor', AppState.selected.strokeColor); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  shapeLW.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'shape') { AppState.selected.strokeWidth = +e.target.value; shapeLWVal.textContent = AppState.selected.strokeWidth; setGlobalProp(AppState.selected, 'strokeWidth', AppState.selected.strokeWidth); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  [shapeWInput, shapeHInput, shapeFill, shapeStroke, shapeLW].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '修改图形')));

  /* 对话框 */
  bubbleText.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.text = e.target.value; setGlobalProp(AppState.selected, 'text', AppState.selected.text); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleMirrorCheckbox.addEventListener('change', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.isMirrored = e.target.checked; setGlobalProp(AppState.selected, 'isMirrored', AppState.selected.isMirrored); EventBus.emit('need:render'); markCurrentFrameModified(); EventBus.emit('history:save', '修改对话框'); } });
  bubbleFontSizeInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.fontSize = +e.target.value; bubbleFontSizeVal.textContent = AppState.selected.fontSize; setGlobalProp(AppState.selected, 'fontSize', AppState.selected.fontSize); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleTextColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.textColor = e.target.value; setGlobalProp(AppState.selected, 'textColor', AppState.selected.textColor); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleGradientCheckbox.addEventListener('change', e => {
    if (AppState.selected && AppState.selected.type === 'bubble') {
      AppState.selected.isGradient = e.target.checked;
      bubbleGradientRow.style.display = AppState.selected.isGradient ? 'flex' : 'none';
      setGlobalProp(AppState.selected, 'isGradient', AppState.selected.isGradient);
      EventBus.emit('need:render'); markCurrentFrameModified(); EventBus.emit('history:save', '修改对话框');
    }
  });
  bubbleGradientColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.gradientColor = e.target.value; setGlobalProp(AppState.selected, 'gradientColor', AppState.selected.gradientColor); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleBgColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.fillColor = e.target.value; setGlobalProp(AppState.selected, 'fillColor', AppState.selected.fillColor); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleStrokeColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.strokeColor = e.target.value; setGlobalProp(AppState.selected, 'strokeColor', AppState.selected.strokeColor); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleStrokeWidthInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.strokeWidth = +e.target.value; bubbleStrokeWidthVal.textContent = AppState.selected.strokeWidth; setGlobalProp(AppState.selected, 'strokeWidth', AppState.selected.strokeWidth); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleCustomSizeCheckbox.addEventListener('change', e => {
    if (AppState.selected && AppState.selected.type === 'bubble') {
      AppState.selected.customSize = e.target.checked;
      bubbleSizeRow.style.display = AppState.selected.customSize ? 'block' : 'none';
      setGlobalProp(AppState.selected, 'customSize', AppState.selected.customSize);
      EventBus.emit('need:render'); markCurrentFrameModified(); EventBus.emit('history:save', '修改对话框');
    }
  });
  bubbleWInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.customW = +e.target.value; bubbleWVal.textContent = AppState.selected.customW; setGlobalProp(AppState.selected, 'customW', AppState.selected.customW); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  bubbleHInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'bubble') { AppState.selected.customH = +e.target.value; bubbleHVal.textContent = AppState.selected.customH; setGlobalProp(AppState.selected, 'customH', AppState.selected.customH); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  [bubbleText, bubbleFontSizeInput, bubbleTextColor, bubbleGradientColor, bubbleBgColor, bubbleStrokeColor, bubbleStrokeWidthInput, bubbleWInput, bubbleHInput].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '修改对话框')));

  /* 颜色 / 线宽 */
  colorInput.addEventListener('input', e => {
    currentColor = e.target.value;
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.color = currentColor;
      setGlobalProp(AppState.selected, 'color', currentColor);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  colorInput.addEventListener('change', () => EventBus.emit('history:save', '修改颜色'));

  lwInput.addEventListener('input', e => {
    /* v7.0.4：线宽支持一位小数，显示统一补到 .1（四舍五入到 0.1 避免浮点尾数） */
    currentLW = Math.round(+e.target.value * 10) / 10;
    lwVal.textContent = currentLW.toFixed(1);
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.lw = currentLW;
      setGlobalProp(AppState.selected, 'lw', currentLW);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  lwInput.addEventListener('change', () => EventBus.emit('history:save', '修改线宽'));

  btnHeadFill.onclick = () => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    AppState.selected.headFilled = !AppState.selected.headFilled;
    setGlobalProp(AppState.selected, 'headFilled', AppState.selected.headFilled);
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '切换头部填充');
  };

  /* v6.4.0：切换头型（圆 / Vic / TCO / TDL / TSC）。
     头型只受「头部」比例滑块影响大小，不吃线宽；朝向跟随 headAngle，和圆头一致。 */
  headShapeBtns.forEach(b => {
    b.addEventListener('click', () => {
      const f = AppState.selected;
      if (!f || f.type !== 'figure') return;
      const id = b.dataset.shape || 'circle';
      if (id !== 'circle') {
        const HS = SKFE.systems.headShapes;
        if (!HS || !HS.has(id)) return;
      }
      if ((f.headShape || 'circle') === id) return;
      f.headShape = id;
      setGlobalProp(f, 'headShape', id);
      EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
      EventBus.emit('history:save', '切换头型');
    });
  });

  if (headFillCustomCheckbox) {
    headFillCustomCheckbox.addEventListener('change', e => {
      if (!AppState.selected || AppState.selected.type !== 'figure') return;
      AppState.selected.headFillCustom = e.target.checked;
      setGlobalProp(AppState.selected, 'headFillCustom', AppState.selected.headFillCustom);
      EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
      EventBus.emit('history:save', '切换自定义填充色');
    });
  }
  if (headFillColorInput) {
    headFillColorInput.addEventListener('input', e => {
      if (!AppState.selected || AppState.selected.type !== 'figure') return;
      AppState.selected.headFillColor = e.target.value;
      setGlobalProp(AppState.selected, 'headFillColor', AppState.selected.headFillColor);
      EventBus.emit('need:render'); markCurrentFrameModified();
    });
    headFillColorInput.addEventListener('change', () => EventBus.emit('history:save', '修改头部填充色'));
  }

  /* 高光 */
  btnLight.onclick = () => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    if (!AppState.selected.light) AppState.selected.light = { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 };
    AppState.selected.light.enabled = !AppState.selected.light.enabled;
    setGlobalProp(AppState.selected, 'light.enabled', AppState.selected.light.enabled);
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '切换侧面高光');
  };
  lightColorInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      if (!AppState.selected.light) AppState.selected.light = { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 };
      AppState.selected.light.color = e.target.value;
      setGlobalProp(AppState.selected, 'light.color', AppState.selected.light.color);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  lightSizeInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.light.size = +e.target.value;
      lightSizeVal.textContent = AppState.selected.light.size.toFixed(1);
      setGlobalProp(AppState.selected, 'light.size', AppState.selected.light.size);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  lightAngleInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.light.angle = +e.target.value;
      lightAngleVal.textContent = AppState.selected.light.angle + '°';
      setGlobalProp(AppState.selected, 'light.angle', AppState.selected.light.angle);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  [lightColorInput, lightSizeInput, lightAngleInput].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '修改高光')));

  /* 手脚 */
  btnExtremity.onclick = () => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    const ex = ensureExtremity(AppState.selected);
    ex.enabled = !ex.enabled;
    setGlobalProp(AppState.selected, 'extremity.enabled', ex.enabled);
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '切换小手小脚');
  };
  armExtRatio.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      const ex = ensureExtremity(AppState.selected);
      ex.armRatio = +e.target.value;
      armExtRatioVal.textContent = ex.armRatio.toFixed(2);
      setGlobalProp(AppState.selected, 'extremity.armRatio', ex.armRatio);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  legExtRatio.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      const ex = ensureExtremity(AppState.selected);
      ex.legRatio = +e.target.value;
      legExtRatioVal.textContent = ex.legRatio.toFixed(2);
      setGlobalProp(AppState.selected, 'extremity.legRatio', ex.legRatio);
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  armExtRatio.addEventListener('change', () => EventBus.emit('history:save', '调整手脚比例'));
  legExtRatio.addEventListener('change', () => EventBus.emit('history:save', '调整手脚比例'));

  /* 比例 */
  headInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.bodyScale.head = +e.target.value; headVal.textContent = AppState.selected.bodyScale.head.toFixed(2); setGlobalProp(AppState.selected, 'bodyScale.head', AppState.selected.bodyScale.head); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  armInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.bodyScale.arm = +e.target.value; armVal.textContent = AppState.selected.bodyScale.arm.toFixed(2); setGlobalProp(AppState.selected, 'bodyScale.arm', AppState.selected.bodyScale.arm); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  legInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.bodyScale.leg = +e.target.value; legVal.textContent = AppState.selected.bodyScale.leg.toFixed(2); setGlobalProp(AppState.selected, 'bodyScale.leg', AppState.selected.bodyScale.leg); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  torsoInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.bodyScale.torso = +e.target.value; torsoVal.textContent = AppState.selected.bodyScale.torso.toFixed(2); setGlobalProp(AppState.selected, 'bodyScale.torso', AppState.selected.bodyScale.torso); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  foreArmRatioInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.bodyScale.foreArm = +e.target.value; foreArmRatioVal.textContent = AppState.selected.bodyScale.foreArm.toFixed(2); setGlobalProp(AppState.selected, 'bodyScale.foreArm', AppState.selected.bodyScale.foreArm); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  shinRatioInput.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.bodyScale.shin = +e.target.value; shinRatioVal.textContent = AppState.selected.bodyScale.shin.toFixed(2); setGlobalProp(AppState.selected, 'bodyScale.shin', AppState.selected.bodyScale.shin); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  [headInput, armInput, legInput, torsoInput, foreArmRatioInput, shinRatioInput].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '调整身体比例')));

  limbIndepCheckbox.addEventListener('change', e => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    const bs = AppState.selected.bodyScale;
    if (e.target.checked) {
      bs.armL = bs.arm; bs.armR = bs.arm;
      bs.foreArmL = (bs.foreArm !== undefined) ? bs.foreArm : 0.37;
      bs.foreArmR = (bs.foreArm !== undefined) ? bs.foreArm : 0.37;
      bs.legL = bs.leg; bs.legR = bs.leg;
      bs.shinL = (bs.shin !== undefined) ? bs.shin : 0.49;
      bs.shinR = (bs.shin !== undefined) ? bs.shin : 0.49;
    } else {
      delete bs.armL; delete bs.armR;
      delete bs.foreArmL; delete bs.foreArmR;
      delete bs.legL; delete bs.legR;
      delete bs.shinL; delete bs.shinR;
    }
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '四肢独立');
  });

  function bindIndepLimb(inputEl, valEl, key) {
    inputEl.addEventListener('input', e => {
      if (AppState.selected && AppState.selected.type === 'figure' && AppState.selected.bodyScale[key] !== undefined) {
        AppState.selected.bodyScale[key] = +e.target.value;
        valEl.textContent = AppState.selected.bodyScale[key].toFixed(2);
        setGlobalProp(AppState.selected, 'bodyScale.' + key, AppState.selected.bodyScale[key]);
        EventBus.emit('need:render'); markCurrentFrameModified();
      }
    });
    inputEl.addEventListener('change', () => EventBus.emit('history:save', '调整肢体比例'));
  }
  bindIndepLimb(armLenLInput, armLenLVal, 'armL');
  bindIndepLimb(armLenRInput, armLenRVal, 'armR');
  bindIndepLimb(foreArmRatioLInput, foreArmRatioLVal, 'foreArmL');
  bindIndepLimb(foreArmRatioRInput, foreArmRatioRVal, 'foreArmR');
  bindIndepLimb(legLenLInput, legLenLVal, 'legL');
  bindIndepLimb(legLenRInput, legLenRVal, 'legR');
  bindIndepLimb(shinRatioLInput, shinRatioLVal, 'shinL');
  bindIndepLimb(shinRatioRInput, shinRatioRVal, 'shinR');

  /* 发光 */
  btnGlow.onclick = () => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    glowFill(AppState.selected.glow);
    AppState.selected.glow.enabled = !AppState.selected.glow.enabled;
    setGlobalProp(AppState.selected, 'glow.enabled', AppState.selected.glow.enabled);
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '切换描边阴影');
  };
  /* v7.2.0：X 偏移 / Y 偏移 / 扩展 —— 改一项就同步到全帧（走 setGlobalProp） */
  const bindGlowNum = (el, valEl, key, label) => {
    if (!el) return;
    el.addEventListener('input', e => {
      if (!AppState.selected || AppState.selected.type !== 'figure') return;
      glowFill(AppState.selected.glow);
      const v = +e.target.value;
      AppState.selected.glow[key] = v;
      if (valEl) valEl.textContent = Math.round(v);
      setGlobalProp(AppState.selected, 'glow.' + key, v);
      EventBus.emit('need:render');
      markCurrentFrameModified();
    });
    el.addEventListener('change', () => EventBus.emit('history:save', label));
  };
  bindGlowNum(glowOffsetX, glowOffsetXVal, 'offsetX', '修改描边阴影');
  bindGlowNum(glowOffsetY, glowOffsetYVal, 'offsetY', '修改描边阴影');
  bindGlowNum(glowSpread, glowSpreadVal, 'spread', '修改描边阴影');
  if (glowIncludeAcc) glowIncludeAcc.addEventListener('change', e => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    glowFill(AppState.selected.glow);
    const on = !!e.target.checked;
    AppState.selected.glow.includeAcc = on;
    setGlobalProp(AppState.selected, 'glow.includeAcc', on);
    EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', on ? '阴影包含配饰' : '阴影不含配饰');
  });

  glowColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.glow.color = e.target.value; setGlobalProp(AppState.selected, 'glow.color', AppState.selected.glow.color); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  glowAlpha.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.glow.alpha = +e.target.value; glowAlphaVal.textContent = AppState.selected.glow.alpha.toFixed(2); setGlobalProp(AppState.selected, 'glow.alpha', AppState.selected.glow.alpha); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  glowBlur.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.glow.blur = +e.target.value; glowBlurVal.textContent = AppState.selected.glow.blur; setGlobalProp(AppState.selected, 'glow.blur', AppState.selected.glow.blur); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  [glowColor, glowAlpha, glowBlur].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '修改描边阴影')));

  /* 手部渐变 */
  btnJoint.onclick = () => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    AppState.selected.joint.enabled = !AppState.selected.joint.enabled;
    setGlobalProp(AppState.selected, 'joint.enabled', AppState.selected.joint.enabled);
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '切换手部渐变');
  };
  jointColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.joint.color = e.target.value; setGlobalProp(AppState.selected, 'joint.color', AppState.selected.joint.color); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  jointLen.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.joint.len = +e.target.value; jointLenVal.textContent = AppState.selected.joint.len.toFixed(2); setGlobalProp(AppState.selected, 'joint.len', AppState.selected.joint.len); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  [jointColor, jointLen].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '修改渐变')));

  /* 肢体层级 */
  const adjustLimb = (limb, delta) => {
    if (!AppState.selected || AppState.selected.type !== 'figure') return;
    AppState.selected.layer[limb] += delta;
    setGlobalProp(AppState.selected, `layer.${limb}`, AppState.selected.layer[limb]);
    updateLimbStatus(); EventBus.emit('need:render');
    markCurrentFrameModified();
    EventBus.emit('history:save', '调整肢体层级');
  };
  document.getElementById('btnHeadFront').onclick = () => adjustLimb('head', 1);
  document.getElementById('btnHeadBack').onclick = () => adjustLimb('head', -1);
  document.getElementById('btnBodyFront').onclick = () => adjustLimb('body', 1);
  document.getElementById('btnBodyBack').onclick = () => adjustLimb('body', -1);
  document.getElementById('btnArmLFront').onclick = () => adjustLimb('armL', 1);
  document.getElementById('btnArmLBack').onclick = () => adjustLimb('armL', -1);
  document.getElementById('btnArmRFront').onclick = () => adjustLimb('armR', 1);
  document.getElementById('btnArmRBack').onclick = () => adjustLimb('armR', -1);
  document.getElementById('btnLegLFront').onclick = () => adjustLimb('legL', 1);
  document.getElementById('btnLegLBack').onclick = () => adjustLimb('legL', -1);
  document.getElementById('btnLegRFront').onclick = () => adjustLimb('legR', 1);
  document.getElementById('btnLegRBack').onclick = () => adjustLimb('legR', -1);

  /* ==================== 头部独立平移逻辑 ==================== */
  const headIndepCb = document.getElementById('headIndep');
  const btnHeadOffsetReset = document.getElementById('btnHeadOffsetReset');
  const headMoveHandleEl = document.getElementById('headMoveHandle');

  if (headIndepCb) {
    headIndepCb.addEventListener('change', (e) => {
      headHandleOn = e.target.checked;
      if (!headHandleOn) headHandleDrag = null;
      updateHeadMoveHandle();
      EventBus.emit('need:render');
    });
  }

  if (btnHeadOffsetReset) {
    btnHeadOffsetReset.addEventListener('click', () => {
      if (!AppState.selected || AppState.selected.type !== 'figure') return;
      if (!AppState.selected.headOffset) AppState.selected.headOffset = { x: 0, y: 0 };
      if (AppState.selected.headOffset.x === 0 && AppState.selected.headOffset.y === 0) return;
      
      const pre = getSnapshot();
      AppState.selected.headOffset = { x: 0, y: 0 };
      setGlobalProp(AppState.selected, 'headOffset.x', 0);
      setGlobalProp(AppState.selected, 'headOffset.y', 0);
      
      markCurrentFrameModified();
      EventBus.emit('need:syncUI');
      EventBus.emit('need:render');
      pushPreSnapshot(pre, '复位头部位置');
    });
  }

  if (headMoveHandleEl) {
    headMoveHandleEl.addEventListener('pointerdown', (e) => {
      if (!AppState.selected || AppState.selected.type !== 'figure') return;
      e.preventDefault(); e.stopPropagation();
      const p = getPos(e);
      headHandleDrag = {
        id: e.pointerId,
        startX: p.x,
        startY: p.y,
        startOffX: AppState.selected.headOffset ? AppState.selected.headOffset.x : 0,
        startOffY: AppState.selected.headOffset ? AppState.selected.headOffset.y : 0,
        moved: false,
        pre: getSnapshot()
      };
      try { headMoveHandleEl.setPointerCapture(e.pointerId); } catch (_) {}
    });

    headMoveHandleEl.addEventListener('pointermove', (e) => {
      if (!headHandleDrag || e.pointerId !== headHandleDrag.id || !AppState.selected) return;
      e.preventDefault(); e.stopPropagation();
      const p = getPos(e);
      const dx = p.x - headHandleDrag.startX;
      const dy = p.y - headHandleDrag.startY;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) headHandleDrag.moved = true;
      
      if (!AppState.selected.headOffset) AppState.selected.headOffset = { x: 0, y: 0 };
      AppState.selected.headOffset.x = headHandleDrag.startOffX + dx;
      AppState.selected.headOffset.y = headHandleDrag.startOffY + dy;
      
      EventBus.emit('need:render');
      updateHeadMoveHandle();
    });

    const endHeadMove = (e) => {
      if (!headHandleDrag || e.pointerId !== headHandleDrag.id) return;
      const didMove = headHandleDrag.moved;
      const pre = headHandleDrag.pre;
      headHandleDrag = null;
      try { headMoveHandleEl.releasePointerCapture(e.pointerId); } catch (_) {}
      
      if (didMove) {
        setGlobalProp(AppState.selected, 'headOffset.x', AppState.selected.headOffset.x);
        setGlobalProp(AppState.selected, 'headOffset.y', AppState.selected.headOffset.y);
        markCurrentFrameModified();
        pushPreSnapshot(pre, '移动头部');
      }
      EventBus.emit('need:syncUI');
      EventBus.emit('need:render');
    };
    headMoveHandleEl.addEventListener('pointerup', endHeadMove);
    headMoveHandleEl.addEventListener('pointercancel', endHeadMove);
  }

  /* ==================== 缩放 / 透明度 ==================== */
  objScale.addEventListener('input', e => {
    if (AppState.canvasSelected && AppState.canvasBoundsEnabled && canvasBaseBounds) {
      const k = Math.max(0.05, Math.min(4, +e.target.value));
      const cx = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
      const cy = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
      AppState.canvasBounds.w = canvasBaseBounds.w * k;
      AppState.canvasBounds.h = canvasBaseBounds.h * k;
      AppState.canvasBounds.x = cx - AppState.canvasBounds.w / 2;
      AppState.canvasBounds.y = cy - AppState.canvasBounds.h / 2;
      objScaleVal.textContent = k.toFixed(2);
      syncCanvasUI();
      EventBus.emit('need:render');
      return;
    }
    if (AppState.selected) {
      AppState.selected.scale = +e.target.value;
      objScaleVal.textContent = AppState.selected.scale.toFixed(2);
      if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
        setGlobalPropForBound(AppState.selected, 'scale', AppState.selected.scale);
      } else {
        setGlobalProp(AppState.selected, 'scale', AppState.selected.scale);
      }
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  objScale.addEventListener('change', () => EventBus.emit('history:save', AppState.canvasSelected ? '缩放画布' : '调整大小'));
  objAlpha.addEventListener('input', e => {
    if (AppState.selected) {
      AppState.selected.alpha = +e.target.value;
      objAlphaVal.textContent = AppState.selected.alpha.toFixed(2);
      if (AppState.selected.type === 'acc' || AppState.selected.type === 'shape' || AppState.selected.type === 'bubble') {
        setGlobalPropForBound(AppState.selected, 'alpha', AppState.selected.alpha);
      } else {
        setGlobalProp(AppState.selected, 'alpha', AppState.selected.alpha);
      }
      EventBus.emit('need:render'); markCurrentFrameModified();
    }
  });
  objAlpha.addEventListener('change', () => EventBus.emit('history:save', '调整透明度'));

  btnUp.onclick = () => moveLayer('up');
  btnDown.onclick = () => moveLayer('down');
  btnTop.onclick = () => moveLayer('top');
  btnBottom.onclick = () => moveLayer('bottom');

  document.getElementById('btnSavePreset').onclick = savePreset;

  document.getElementById('btnClearCanvas').onclick = () => {
    if (confirm('确定清空当前画布的所有元素吗？')) {
      if (isSubTrackMode()) {
        setTrackFrame(AppState.activeTrackId, AppState.currentFrameIndex, null);
      } else {
        for (const tid in AppState.tracks) setTrackFrame(tid, AppState.currentFrameIndex, null);
      }
      AppState.selected = null;
      AppState.canvasSelected = false;
      syncMainLengthFromTracks();
      trimTrailingEmptyFrames();
      AppState.objects = getCombinedObjectsForRender();
      invalidateAllFrameThumbs();
      updateFrameBar();
      EventBus.emit('app:update');
      markCurrentFrameModified();
      EventBus.emit('history:save', '清空画布');
    }
  };

  /* 时间轴按钮 */
  document.getElementById('btnPrevFrame').onclick = () => goToFrame(AppState.currentFrameIndex - 1);
  document.getElementById('btnNextFrame').onclick = () => goToFrame(AppState.currentFrameIndex + 1);
  document.getElementById('btnPlay').onclick = (e) => { if (e) e.preventDefault(); togglePlay(); };
  document.getElementById('btnAddFrame').onclick = () => addFrame();
  const btnDelFrame = document.getElementById('btnDelFrame');
  if (btnDelFrame) {
    btnDelFrame.onclick = () => {
      if (multiSelectMode) deleteSelectedFrames();
      else deleteFrame();
    };
  }

  document.getElementById('btnClearAllFrames').onclick = () => {
    if (isPlaying) pause();
    if (!confirm('确定要清空所有动画帧吗？')) return;
    AppState.frames = [{ id: 1, duration: Math.round(1000 / defaultFPS), isTween: false }];
    AppState.tracks = {};
    AppState.currentFrameIndex = 0;
    AppState.activeTrackId = TRACK_ALL_ID;
    AppState.objects = [];
    AppState.selected = null; AppState.canvasSelected = false;
    drag = null;
    isPanning = false;
    trackThumbCache.clear();
    refreshSubTrackOptions();
    updateFrameBar();
    EventBus.emit('app:update', '清空所有帧');
    if (refVideo) seekVideoToFrame(0);
  };

  document.getElementById('btnClearOtherFrames').onclick = () => {
    if (AppState.frames.length <= 1) {
      alert(tr2('alert.onlyOneFrame', '当前只有一帧，无需清空。'));
      return;
    }
    if (isPlaying) pause();
    if (!confirm('确定要保留当前帧，并清空其他所有帧吗？')) return;

    syncFrameRef(); // 确保当前画布上的临时修改已存进当前帧
    const targetIdx = AppState.currentFrameIndex;

    // 1. 提取当前帧的所有轨道数据
    const newTracks = {};
    for (const id in AppState.tracks) {
      const data = getTrackFrame(id, targetIdx);
      if (data) {
        newTracks[id] = {
          name: AppState.tracks[id].name,
          frames: [cloneObjectKeepImg(data)] // 只留这一帧的数据
        };
      }
    }

    // 2. 重置为单帧，用新提取的轨道数据覆盖
    const oldDuration = AppState.frames[targetIdx] ? AppState.frames[targetIdx].duration : Math.round(1000 / defaultFPS);
    AppState.frames = [{ id: 1, duration: oldDuration, isTween: false }];
    AppState.tracks = newTracks;
    AppState.currentFrameIndex = 0;
    
    // 如果当前选中的子轨道有保留，就留在那个子轨道；否则退回主轨道
    if (isSubTrackMode() && !AppState.tracks[AppState.activeTrackId]) {
      AppState.activeTrackId = TRACK_ALL_ID;
    }

    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = null; 
    AppState.canvasSelected = false;
    drag = null;
    isPanning = false;
    trackThumbCache.clear();
    
    refreshSubTrackOptions();
    updateFrameBar();
    EventBus.emit('app:update', '清空非当前帧');
    if (refVideo) seekVideoToFrame(0);
  };

  /* v7.0.1：连点水印 5 次 → 导出诊断报告（主要给安卓真机排查「导出没反应」用） */
  (function bindExportDiag() {
    const wm = document.getElementById('watermark');
    if (!wm) return;
    let taps = 0, timer = null;
    wm.style.cursor = 'default';
    wm.addEventListener('click', () => {
      taps++;
      clearTimeout(timer);
      timer = setTimeout(() => { taps = 0; }, 3000);
      if (taps < 5) return;
      taps = 0;
      if (!SKFE.platform || typeof SKFE.platform.diag !== 'function') {
        alert(tr2('diag.unavailable', '诊断不可用：platform.diag 缺失（platform.js 版本过旧）'));
        return;
      }
      SKFE.platform.diag().then(txt => {
        /* 手机上一串 alert 文本没法复制，顺手给个「存成 txt 再分享」的出口 */
        if (confirm(txt + '\n\n把这份报告存成 txt 分享出去？')) {
          try {
            SKFE.platform.save(new Blob([txt], { type: 'text/plain' }), 'skfe_diag_' + Date.now() + '.txt');
          } catch (_) {}
        }
      }).catch(e => alert(tr2('diag.fail', '诊断失败：') + (e && e.message)));
    });
  })();

  document.getElementById('timelineScrubber').addEventListener('input', (e) => { goToFrame(+e.target.value); });
  document.getElementById('fpsSlider').addEventListener('input', e => { applyFPS(+e.target.value); EventBus.emit('need:render'); });
  document.getElementById('fpsSlider').addEventListener('change', () => EventBus.emit('history:save', '修改帧率'));
  document.getElementById('onionCheck').addEventListener('change', e => { onionEnabled = e.target.checked; EventBus.emit('need:render'); });
  const MAX_ONION_TOTAL = 12;
  document.getElementById('onionBefore').addEventListener('input', e => {
    onionBefore = +e.target.value;
    if (onionBefore + onionAfter > MAX_ONION_TOTAL) {
      onionAfter = MAX_ONION_TOTAL - onionBefore;
      const afterEl = document.getElementById('onionAfter');
      const afterValEl = document.getElementById('onionAfterVal');
      if (afterEl) afterEl.value = onionAfter;
      if (afterValEl) afterValEl.textContent = onionAfter;
    }
    document.getElementById('onionBeforeVal').textContent = onionBefore;
    EventBus.emit('need:render');
  });
  document.getElementById('onionAfter').addEventListener('input', e => {
    onionAfter = +e.target.value;
    if (onionBefore + onionAfter > MAX_ONION_TOTAL) {
      onionBefore = MAX_ONION_TOTAL - onionAfter;
      const beforeEl = document.getElementById('onionBefore');
      const beforeValEl = document.getElementById('onionBeforeVal');
      if (beforeEl) beforeEl.value = onionBefore;
      if (beforeValEl) beforeValEl.textContent = onionBefore;
    }
    document.getElementById('onionAfterVal').textContent = onionAfter;
    EventBus.emit('need:render');
  });
  document.getElementById('frameThumbMode').addEventListener('change', e => { frameThumbMode = e.target.checked; updateFrameBar(); EventBus.emit('need:render'); });

  /* 导出按钮 */
  const btnExportPNG = document.getElementById('btnExportPNG');
  if (btnExportPNG) {
    btnExportPNG.onclick = () => {
      if (multiSelectMode) exportSelectedPNGs();
      else exportImage('png');
    };
  }
  
  const btnExportJPG = document.getElementById('btnExportJPG');
  if (btnExportJPG) {
    btnExportJPG.onclick = () => {
      if (multiSelectMode) exportSelectedJPGs();
      else exportImage('jpg');
    };
  }
  
  const btnExportGIF = document.getElementById('btnExportGIF');
  if (btnExportGIF) {
    btnExportGIF.onclick = () => {
      if (multiSelectMode) exportSelectedGIF();
      else SKFE.features.export.exportGIF();
    };
  }
  
  const btnExportPNGSeq = document.getElementById('btnExportPNGSeq');
  if (btnExportPNGSeq) {
    btnExportPNGSeq.onclick = () => {
      if (multiSelectMode) exportSelectedPNGs();
      else SKFE.features.export.exportPNGSeq();
    };
  }
  
  const btnExportMP4 = document.getElementById('btnExportMP4');
  if (btnExportMP4) {
    btnExportMP4.onclick = () => SKFE.features.export.exportMP4();
  }

  /* 导出图片 */
  function exportImage(format) {
    const hd = exportHDCheckbox.checked;
    const dpr = window.devicePixelRatio || 1;
    const exportScale = hd ? Math.max(4, dpr) : dpr;
    let cssW, cssH, cropCX, cropCY, cropRot = 0;
    const camShot = shouldSkipCameraForExport() ? null : (getCurrentCameraObject() || getCameraAtFrame(0));
    if (camShot) {
      cropCX = camShot.x;
      cropCY = camShot.y;
      cssW = camShot.w * (camShot.scale || 1);
      cssH = camShot.h * (camShot.scale || 1);
      cropRot = (camShot.rot || 0) * Math.PI / 180;
    } else if (AppState.canvasBoundsEnabled) {
      cropCX = AppState.canvasBounds.x + AppState.canvasBounds.w / 2;
      cropCY = AppState.canvasBounds.y + AppState.canvasBounds.h / 2;
      cssW = AppState.canvasBounds.w;
      cssH = AppState.canvasBounds.h;
      cropRot = AppState.canvasBounds.rotation || 0;
    } else {
      const bbox = computeContentBounds(AppState.objects);
      if (bbox) {
        cropCX = (bbox.minX + bbox.maxX) / 2;
        cropCY = (bbox.minY + bbox.maxY) / 2;
        const s = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) * 1.15;
        cssW = cssH = Math.max(10, Math.round(s));
      } else {
        cssW = canvas.clientWidth; cssH = canvas.clientHeight;
        cropCX = (cssW / 2 - AppState.viewOffset.x) / AppState.viewScale;
        cropCY = (cssH / 2 - AppState.viewOffset.y) / AppState.viewScale;
      }
    }
    const origW = canvas.width, origH = canvas.height;
    const origStyleW = canvas.style.width, origStyleH = canvas.style.height;
    let dataURL = null;
    try {
      canvas.width = Math.round(cssW * exportScale);
      canvas.height = Math.round(cssH * exportScale);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(exportScale, exportScale);
      ctx.translate(cssW / 2, cssH / 2);
      if (cropRot) ctx.rotate(-cropRot);
      ctx.translate(-cropCX, -cropCY);
      window.exportFormat = format;
      renderCanvas(true);
      dataURL = format === 'png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      alert(tr2('export.fail', '导出失败：') + err.message);
    } finally {
      canvas.width = origW; canvas.height = origH;
      canvas.style.width = origStyleW; canvas.style.height = origStyleH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (dataURL) {
      const filename = 'stickman_' + Date.now() + (format === 'png' ? '.png' : '.jpg');
      /* v6.0：手机原生壳（Capacitor）里 <a download> 无效，走 Filesystem + 系统分享 */
      if (SKFE.platform && SKFE.platform.isNative && SKFE.platform.isNative()) {
        SKFE.platform.saveDataURL(dataURL, filename);
        EventBus.emit('need:render');
        return;
      }
      const isIOS = /iP(ad|hone|od)/i.test(navigator.userAgent);
      if (isIOS && navigator.canShare) {
        try {
          const blobBin = atob(dataURL.split(',')[1]);
          const mime = format === 'png' ? 'image/png' : 'image/jpeg';
          const u8 = new Uint8Array(blobBin.length);
          for (let i = 0; i < blobBin.length; i++) u8[i] = blobBin.charCodeAt(i);
          const file = new File([u8], filename, { type: mime });
          if (navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: filename }).catch(() => {});
            EventBus.emit('need:render'); return;
          }
        } catch (_) {}
      }
      const link = document.createElement('a');
      link.download = filename; link.href = dataURL;
      document.body.appendChild(link); link.click(); link.remove();
      if (isIOS) {
        setTimeout(() => {
          window.open(dataURL, '_blank');
          alert(tr2('export.iosSave', 'iOS 已在新标签页打开图片，\n长按图片即可"存储到照片"。'));
        }, 300);
      }
    }
    EventBus.emit('need:render');
  }

  /* ==================================================================
     v4.0.0 新增功能：时间轴置顶 / 摄像机系统 / 矢量圆形橡皮擦
     ================================================================== */

  /* ---------------- 时间轴置顶 / 置底 ---------------- */
  const TIMELINE_DOCK_KEY = 'skfe_timeline_dock_v1';
  let timelineDock = 'top';

  /* ==================== v7.0.5：控制面板分区（底部固定入口栏） ====================
     设计：面板 = 拖动条 + 可滚动区(#uiScroll) + 固定底部栏(#uiBottomBar)。
     v7.3.0：8 个入口一视同仁 —— 属性(#uiMain) / 元件 / 画笔 / 画布 / 高级 / 项目 / 导出 / 主题。
     点某个入口展开它；再点同一个入口 → 全关，此时 #ui 只剩底部那条入口栏（.collapsed）。
     搬迁用 appendChild 把原 DOM 节点移进分区容器 —— 事件监听绑在元素自身上，搬家不会丢。 */
  const uiSheetEls = {};        /* key -> 容器 */
  let activeUiSheet = null;     /* 当前分区 key；null = 全关（只剩底部栏） */

  function uiSheetTitle(key) {
    return ({ props: '属性', objects: '元件', brush: '画笔', canvas: '画布', advanced: '高级', project: '项目', export: '导出', theme: '主题' })[key] || '';
  }

  function mountUiSheets() {
    const keys = ['objects', 'brush', 'canvas', 'advanced', 'project', 'export', 'theme'];
    keys.forEach(k => {
      uiSheetEls[k] = document.getElementById('sheet' + k.charAt(0).toUpperCase() + k.slice(1));
    });
    if (!uiSheetEls.objects) return;   /* 旧 HTML 没更新时安全退出 */

    /* v7.3.0：属性区（#uiMain）也是分区之一，key 直接叫 props，跟底部栏 data-sheet="props" 对上 */
    const propsBox = document.getElementById('uiMain');
    if (propsBox) uiSheetEls.props = propsBox;

    const move = (el, box) => { if (el && box) box.appendChild(el); };
    const rowOf = (el) => (el ? el.closest('.row') : null);
    /* 分区内的小标题：带 data-i18n，切语言时能被 applyTranslations 一起刷 */
    const sub = (i18nKey) => {
      const d = document.createElement('div');
      d.className = 'section-title';
      d.style.marginTop = '10px';
      d.dataset.i18n = i18nKey;
      d.textContent = (window.t ? window.t(i18nKey) : i18nKey);
      return d;
    };

    /* 每个分区顶部的标题条。
       v7.3.0：右上角那颗「返回属性」删掉了 —— 属性自己也有底部入口，想回去点它就行，
       留着两个入口反而多一个要维护的状态。 */
    const addHead = (box, k, placeAtTop) => {
      if (!box) return;
      const head = document.createElement('div');
      head.className = 'ui-sheet-head';
      const tEl = document.createElement('span');
      tEl.dataset.i18n = 'tab.' + k;        /* 标题跟着语言切换 */
      tEl.textContent = uiSheetTitle(k);
      head.appendChild(tEl);
      if (placeAtTop) box.insertBefore(head, box.firstChild);
      else box.appendChild(head);
    };
    keys.forEach(k => addHead(uiSheetEls[k], k, false));
    /* 属性区的标题必须插到最前面（水印、面板标题行都在它后面），否则会跑到属性列表末尾 */
    addHead(propsBox, 'props', true);

    /* ---- 元件：添加物体 / 编辑操作 / 元件列表（纵向，v7.0.6 起不再是浮窗） ---- */
    const addSummary = document.querySelector('[data-i18n="add.summary"]');
    move(addSummary ? addSummary.closest('.add-details') : null, uiSheetEls.objects);
    move(rowOf(document.getElementById('btnClone')), uiSheetEls.objects);
    /* 原来的横向缩略图条 + ▾ 浮窗按钮已从 HTML 删除，锁定改成每行一个（见 renderLayerPop） */

    /* ---- 画笔 / 画布 / 主题：整块搬 tool-panel ----
       这三块原来是 chips 手风琴（靠 .active 显示），搬进固定分区后要**常驻显示**，
       所以从 toolPanels 数组里剔除，否则 setActiveTool 一调用就把它们关掉，分区里会一片空白。 */
    const canvasPanel = document.getElementById('canvasSettingsPanel');
    const themePanel = document.querySelector('#uiMain .tool-panel[data-tool="theme"]');
    const brushPanel = document.querySelector('#uiMain .tool-panel[data-tool="eraser"]');
    [brushPanel, canvasPanel, themePanel].forEach(p => {
      if (!p) return;
      p.classList.add('active');
      p.style.display = 'block';
    });
    for (let i = toolPanels.length - 1; i >= 0; i--) {
      const t = toolPanels[i].dataset.tool;
      if (t === 'brush' || t === 'eraser' || t === 'canvas' || t === 'theme') toolPanels.splice(i, 1);
    }
    move(brushPanel, uiSheetEls.brush);
    move(canvasPanel, uiSheetEls.canvas);
    move(themePanel, uiSheetEls.theme);

    /* ---- 拆原「高级设置」弹窗：开关归高级、导出归导出、项目/动作归项目 ---- */
    const adv = document.getElementById('timelineAdvancedPanel');
    if (adv) {
      const rows = Array.prototype.slice.call(adv.querySelectorAll(':scope > .adv-row'));
      move(rows[0], uiSheetEls.advanced);                       /* 其他画面可见性 */
      move(rows[1], uiSheetEls.advanced);                       /* 各种开关 + 清空帧 + 置顶 */
      /* v7.1.0：全局属性修改 + 它的说明面板搬到控制面板顶部（全屏旁边），不再进「高级」分区 */

      /* v7.0.6：把「透明底 / 3x高清 / 1080p」这三个**导出参数**从这排通用开关里挑出来，
         单独成行放进「导出」分区（它们只影响导出结果，留在高级里容易找不到） */
      const expToggles = document.createElement('div');
      expToggles.className = 'adv-row';
      expToggles.style.marginTop = '4px';
      ['gifTransparent', 'gifHD3x', 'hd1080p'].forEach(cbId => {
        const b = rows[1] && rows[1].querySelector('.adv-toggle[data-toggle="' + cbId + '"]');
        if (b) expToggles.appendChild(b);
      });
      if (expToggles.children.length) uiSheetEls.export.appendChild(expToggles);

      if (rows[2]) {                                            /* 视频行：导出按钮抽给「导出」 */
        const exportRow = document.createElement('div');
        exportRow.className = 'row';
        exportRow.style.flexWrap = 'wrap';
        ['btnExportGIF', 'btnExportPNGSeq', 'btnExportMP4'].forEach(id => {
          move(document.getElementById(id), exportRow);
        });
        move(rows[2].querySelector('.adv-color-label'), exportRow);
        uiSheetEls.export.appendChild(exportRow);
        move(rows[2], uiSheetEls.advanced);                     /* 剩下的导入视频 / 显隐 / 播放 */
      }

      if (rows[3]) {                                            /* 工程存档 */
        uiSheetEls.project.appendChild(sub('tab.sub.archive'));
        move(rows[3], uiSheetEls.project);
      }
      if (rows[4]) {                                            /* 动作库 */
        uiSheetEls.project.appendChild(sub('tab.sub.actions'));
        move(rows[4], uiSheetEls.project);
      }
      move(document.getElementById('actionList'), uiSheetEls.project);

      /* 弹窗的标题栏（⚙️ 高级设置 + ✕）在一行行搬空后就成了死 UI：
         触发它的按钮已删，这个壳永远打不开。趁早摘掉，只留那些隐藏 checkbox 当状态存储。 */
      const advHead = adv.querySelector('.adv-panel-head');
      if (advHead) advHead.remove();
    }

    /* ---- 导出：面板顶部的 PNG/JPG + 高清勾选（全屏**留在原位**） ---- */
    const pngRow = rowOf(document.getElementById('btnExportPNG'));
    const topExportRow = document.createElement('div');
    topExportRow.className = 'row';
    move(document.getElementById('btnExportPNG'), topExportRow);
    move(document.getElementById('btnExportJPG'), topExportRow);
    const hdRow = rowOf(document.getElementById('exportHD'));
    /* 顺序：PNG/JPG → 高清勾选 → 视频导出（更常用的放前面） */
    const exportHead = uiSheetEls.export.querySelector('.ui-sheet-head');
    if (exportHead) {
      exportHead.after(topExportRow);
      if (hdRow) topExportRow.after(hdRow);
    } else {
      uiSheetEls.export.appendChild(topExportRow);
      move(hdRow, uiSheetEls.export);
    }
    const fsBtn = document.getElementById('btnFullscreen');
    if (fsBtn) fsBtn.style.flex = '0 0 auto';                 /* 只剩全屏时别再拉满整行 */

    /* v7.1.0：「导出时画布优先」从「画布」分区搬到「导出」—— 它只影响导出结果，
       和透明底/3x高清那排是同一类设置，放在导出里才找得到。 */
    const expFirstBtn = document.getElementById('btnExportCanvasFirst');
    if (expFirstBtn) {
      const canvasFirstRow = document.createElement('div');
      canvasFirstRow.className = 'row';
      canvasFirstRow.style.marginTop = '8px';
      canvasFirstRow.appendChild(expFirstBtn);
      uiSheetEls.export.appendChild(canvasFirstRow);
    }
    if (pngRow) pngRow.style.justifyContent = 'flex-start';    /* 靠左 */

    /* ---- 项目：本地预设 + 清空画布 ---- */
    const presetTitle = document.querySelector('#uiMain .section-title[data-i18n="preset.title"]');
    if (presetTitle) uiSheetEls.project.appendChild(sub('tab.sub.presets'));
    move(rowOf(document.getElementById('presetNameInput')), uiSheetEls.project);
    move(document.getElementById('presetList'), uiSheetEls.project);
    move(rowOf(document.getElementById('btnClearCanvas')), uiSheetEls.project);
    /* 原「本地预设」标题已被上面的 sub() 取代，把空壳去掉 */
    if (presetTitle && presetTitle.parentElement) presetTitle.remove();

    /* ---- 元件列表：从画布上的浮窗改成「元件」分区里的常驻纵向列表 ----
       加 .lp-inline 后 #layerPop 不再是 fixed 浮层，而是普通块级元素，跟着面板一起滚。
       同时 setLayerPopOpen 会被钉成"永远打开"，positionLayerPop 不再算坐标。 */
    const lp = document.getElementById('layerPop');
    if (lp) {
      lp.classList.add('lp-inline');
      move(lp, uiSheetEls.objects);
      setLayerPopOpen(true);
    }

    /* ---- v7.2.0：配饰的「绑定设置」放在**元件列表上方**（选中配饰时自动出现）。
       元件列表就是吸顶的横向缩略图条 #objStrip，所以这里插到它前面，
       而不是塞进「元件」分区 —— 分区是另一层，看不到「上/下」的关系。 ---- */
    const bindBox = document.getElementById('bindPanel');
    const stripEl = document.getElementById('objStrip');
    if (bindBox) {
      bindBox.style.marginTop = '0';
      bindBox.style.marginBottom = '8px';
      if (stripEl && stripEl.parentElement) stripEl.parentElement.insertBefore(bindBox, stripEl);
      else move(bindBox, uiSheetEls.objects);
    }

    /* ---- chips 里画笔/画布/主题已经有独立入口，删掉重复的三个 ---- */
    document.querySelectorAll('#toolChips .tool-chip[data-tool="canvas"], #toolChips .tool-chip[data-tool="theme"], #toolChips .tool-chip[data-tool="eraser"]')
      .forEach(el => el.remove());

    /* 属性区顶部恢复了横向元件条（吸顶），把它的高度告诉 chips，避免两层吸顶叠在一起 */
    updateStickyHeaderHeight();

    /* ---- 底部栏绑定 ---- */
    const bar = document.getElementById('uiBottomBar');
    if (bar) {
      bar.querySelectorAll('.ui-tab').forEach(btn => {
        btn.addEventListener('click', () => switchUiSheet(btn.dataset.sheet));
      });
    }

    /* ---- 首屏默认值 ----
       桌面：展开「属性」（打开就能改参数，和以前常显属性区的手感一致）；
       手机：全关，只留底部栏（面板在底部占半屏，一上来就盖住画布不合适，用户点了才展开）。 */
    switchUiSheet(isMobile ? null : 'props');
  }

  function switchUiSheet(key) {
    const scroll = document.getElementById('uiScroll');
    const bar = document.getElementById('uiBottomBar');
    const panel = document.getElementById('ui');
    if (!panel) return;

    /* v7.3.0：点当前打开的入口 = 全关 —— 面板只剩底部那排入口栏。
       原来「再点一次回属性区」的语义已经不需要了：属性自己就是最左边那个入口。 */
    if (key && key === activeUiSheet) key = null;
    if (key && !uiSheetEls[key]) key = null;

    const wasCollapsed = panel.classList.contains('collapsed');
    activeUiSheet = key;

    Object.keys(uiSheetEls).forEach(k => {
      const box = uiSheetEls[k];
      if (box) box.hidden = (k !== key);
    });

    panel.classList.toggle('collapsed', !key);

    if (bar) {
      bar.querySelectorAll('.ui-tab').forEach(b => {
        const on = b.dataset.sheet === key;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (scroll) scroll.scrollTop = 0;               /* 切分区回到顶部 */

    /* v7.0.5：画布分区要同时打开「画布边界 / 地面线」编辑态，否则在画布上拖不动边界（原来靠点 chip 触发）。
       离开画布分区时把编辑态关掉，避免误拖。 */
    if (key === 'canvas') setActiveTool('canvas');
    else if (activeTool === 'canvas') setActiveTool(null);

    /* 展开 ↔ 全关会改变面板占位，画布可用区、右下浮钮、缩放手柄都要重算；
       分区与分区之间面板尺寸不变，不用白跑一遍 resize。 */
    if (wasCollapsed !== !key) {
      refreshTimelineDockOffsets();
      resize();
      updateResizeHandlePos();   /* 全关时藏起右下角 ◢ 手柄，展开时贴回面板角上 */
      if (!wasCollapsed && key === 'objects') scheduleRenderLayerPop();  /* 元件列表平时不渲染，展开时补一次 */
    }

    EventBus.emit('need:render');
  }

  function refreshTimelineDockOffsets() {
    const tl = document.getElementById('timeline');
    if (!tl) return;
    const visible = getComputedStyle(tl).display !== 'none';
    const h = visible ? tl.offsetHeight : 0;
    const coord = document.getElementById('coordDisplay');
    const hist = document.getElementById('historyControls');
    const ui = document.getElementById('ui');

    // 处理右上角浮窗
    if (timelineDock === 'top') {
      if (coord) coord.style.top = (64 + h) + 'px';
      if (hist) hist.style.top = (16 + h) + 'px';
    } else {
      if (coord) coord.style.top = '';
      if (hist) hist.style.top = '';
    }

    /* v7.0.4/7.0.5：「🎬 帧动画面板」浮钮固定在屏幕右下角，不被抽屉顶上去。
       v7.0.5 面板底部多了固定入口栏，所以移动端要把它抬到**底部栏上方**（barH + 8），
       免得压住「属性/元件/画布/高级…」那排入口。
       v7.3.0：面板不会再整块隐藏了（全关也留着底部栏），所以 barH 直接取，不用再判 hidden。 */
    const btnShowTl = document.getElementById('btnShowTimeline');
    if (btnShowTl) {
      if (isMobile) {
        const bar = document.getElementById('uiBottomBar');
        const barH = bar ? bar.offsetHeight : 0;
        btnShowTl.style.bottom = barH ? (barH + 8) + 'px' : '';
      } else {
        btnShowTl.style.bottom = '';
      }
    }

    // 【修复】不论是否开启了自由缩放，桌面端顶部停靠时先把 UI 面板往下推，否则会被时间轴压住
    if (!isMobile && ui) {
      const baseTop = 14;
      const dockTop = timelineDock === 'top' ? h : 0;
      /* v7.3.0：用户手动拖动过面板位置就别再把它拽回左上角 —— 现在展开/全关都要走这一趟，
         每点一次底部入口面板就跳回原点会很难受。被时间轴压住这条仍然优先。
         高度也跟着「实际 top」算，拖下去多少就少多少，面板不会撑出屏幕底。 */
      const draggedTop = uiPanelDragged ? parseFloat(ui.style.top) : NaN;
      const top = Number.isFinite(draggedTop) ? Math.max(draggedTop, baseTop + dockTop) : (baseTop + dockTop);
      const reserved = top + 100;   /* 顶部偏移（含时间轴）+ 底部留白 */
      ui.style.top = top + 'px';
      ui.style.maxHeight = 'calc(100vh - ' + reserved + 'px)';
      /* v7.0.5：桌面端也把高度**写死**成可用高度。原来只有 max-height、高度随内容自适应，
         切分区时内容一短面板就缩，底部入口栏跟着上下乱跳（每次点入口都要重新找位置）。
         写死之后滚动交给 #uiScroll，栏稳稳待在面板底部。
         例外：开了自由缩放且用户拖过尺寸时，高度归 applyCustomSize()，这里别抢。
         另：全关时 CSS 的 #ui.collapsed 会用 !important 把高度压回内容高，这里照写无妨。 */
      if (!(uiResizable && uiCustomSize)) ui.style.height = 'calc(100vh - ' + reserved + 'px)';
    }

    if (uiResizable) return; // 防冲突：自由缩放的其余逻辑不需要重复执行

    // 移动端底部抽屉
    if (isMobile && ui) {
      /* v7.3.0：面板只有「全关（只剩底部栏）」和「打开某个分区」两种形态，不再整块隐藏 */
      const isCollapsed = ui.classList.contains('collapsed');

      let bottomOffset = 0;
      if (timelineDock === 'bottom' && visible) {
        bottomOffset = h;
      }

      ui.style.bottom = (isCollapsed ? 0 : bottomOffset) + 'px';
      if (!isCollapsed) {
        if (!uiPanelDragged) {
          ui.style.top = 'auto';
          /* v7.0.5：高度交给 CSS 的 height:50vh（写死高度，切分区不塌缩），这里只保证清掉拖拽残留 */
          ui.style.height = '';
          ui.style.maxHeight = '50vh';
        } else {
          const topPx = parseFloat(ui.style.top) || 60;
          const hh = Math.max(120, window.innerHeight - topPx - bottomOffset);
          ui.style.height = hh + 'px';     /* 手动拖高时用内联高度覆盖 CSS */
          ui.style.maxHeight = hh + 'px';
        }
      } else {
        ui.style.height = '';              /* 全关状态清掉内联高度，回到 CSS 的「内容高」 */
        ui.style.maxHeight = '';
      }
    }
  }

  function applyTimelineDock(mode, opts) {
    opts = opts || {};
    timelineDock = (mode === 'top') ? 'top' : 'bottom';
    const tl = document.getElementById('timeline');
    if (!tl) return;
    tl.classList.toggle('timeline-top', timelineDock === 'top');
    tl.classList.toggle('timeline-bottom', timelineDock === 'bottom');
    // ⬇⬇⬇ 新增：同步更新内联样式，否则会覆盖 CSS 类的效果
    if (timelineDock === 'top') {
      tl.style.top = '0';
      tl.style.bottom = 'auto';
    } else {
      tl.style.top = 'auto';
      tl.style.bottom = '0';
    }
    tl.style.position = 'fixed';
    tl.style.left = '0';
    tl.style.right = '0';
    const hideBtn = document.getElementById('btnHideTimeline');
    if (hideBtn) hideBtn.innerHTML = ic(timelineDock === 'top' ? 'up' : 'down') + '<span data-i18n="timeline.hide">' + tr2('timeline.hide', '收起') + '</span>';
    const dockBtn = document.getElementById('btnTimelineDock');
    if (dockBtn) { const dockKey = timelineDock === 'top' ? 'timeline.dockBottom' : 'timeline.dockTop'; const dockTxt = timelineDock === 'top' ? tr2('timeline.dockBottom', '置底') : tr2('timeline.dockTop', '置顶'); dockBtn.innerHTML = ic(timelineDock === 'top' ? 'align-bottom' : 'to-top') + '<span data-i18n="' + dockKey + '">' + dockTxt + '</span>'; }
    refreshTimelineDockOffsets();
    if (!opts.skipResize) resize();
}

  function initTimelineDock() {
    const tl = document.getElementById('timeline');
    if (!tl) return;

    // 【修复】如果时间轴被错误地包在了其他元素（比如 #ui）里，强制把它移出来挂载到 body 下
    if (tl.parentElement !== document.body) {
      document.body.appendChild(tl);
    }

    // 【修复】强制重置基础定位属性，防止被外部容器干扰导致拉伸/错位
    tl.style.position = 'fixed';
    tl.style.left = '0';
    tl.style.right = '0';
    if (timelineDock === 'top') {
      tl.style.top = '0';
      tl.style.bottom = 'auto';
    } else {
      tl.style.top = 'auto';
      tl.style.bottom = '0';
    }

    const controls = tl.querySelector('.timeline-controls');
    const bar = document.getElementById('frameBar');
    if (controls && bar && controls.parentElement === tl) {
      tl.insertBefore(controls, bar);
    }
    try {
      const saved = localStorage.getItem(TIMELINE_DOCK_KEY);
      if (saved === 'top' || saved === 'bottom') timelineDock = saved;
    } catch (_) {}
    applyTimelineDock(timelineDock, { skipResize: true });
    const dockBtn = document.getElementById('btnTimelineDock');
    if (dockBtn) {
      dockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = timelineDock === 'top' ? 'bottom' : 'top';
        try { localStorage.setItem(TIMELINE_DOCK_KEY, next); } catch (_) {}
        applyTimelineDock(next);
      });
    }
  }

  /* ---------------- 摄像机：状态与几何 ---------------- */

  /* 摄像机视角的视图缩放与偏移（仅影响编辑时的取景框显示，不影响导出） */
  let camViewZoom = 1;
  let camViewOffset = { x: 0, y: 0 };
  /* 双指缩放模式：'camera' = 缩放摄像机本身；'view' = 缩放页面视图 */
  let twoFingerMode = 'view';
  /* 滚轮缩放摄像机时，延迟刷新缩略图与历史（避免滚动过程卡顿） */
  let camWheelThumbTimer = null;

  /* ---------------- 摄像机功能（已迁移至 js/systems/camera.js） ---------------- */
  SKFE.systems.camera.init({
    AppState,
    EventBus,
    TRACK_ALL_ID,
    getCtx: () => ctx,
    setCtx: (c) => { ctx = c; },
    getCanvas: () => canvas,
    pushRenderQueue: (item) => renderQueue.push(item),
    renderScene,
    getCombinedObjectsForRender,
    getTrackObjectsAt,
    getTrackFrame,
    getSpawnPoint, addObjectToFrames, generateName,
    syncMainLengthFromTracks, refreshSubTrackOptions, setGlobalProp,
    isSubTrackMode,
    nextUid: () => ++uid,
    invalidateAllFrameThumbs, updateFrameBar, syncAdvToggles,
    drawGroundLine,
    getObjectsForFrameAt,
    isCameraTrackId,
    getCurrentCameraObject,
    getActiveViewScale: () => SKFE.systems.eraser.getActiveViewScale(),
    // 环境
    isMobile,
    getUiPanel: () => uiPanel,
    getTimelineEl: () => timelineEl,
    getTimelineDock: () => timelineDock,
    getIsPlaying: () => isPlaying,
    isGlobalEdit: () => globalEditEnabled,
    getOnionEnabled: () => onionEnabled,
    getOnionBefore: () => onionBefore,
    getOnionAfter: () => onionAfter,
    isGroundLineEnabled: () => groundLineEnabled,
    ONION_ALPHA, ONION_COLOR_BEFORE, ONION_COLOR_AFTER,
    // 摄像机视图状态 getter/setter（状态仍留在 app.js，供指针交互直接读写）
    getCamViewZoom: () => camViewZoom,
    setCamViewZoom: (v) => { camViewZoom = v; },
    getCamViewOffset: () => camViewOffset,
    setCamViewOffset: (v) => { camViewOffset = v; },
    isCameraPreviewVisible: () => cameraPreviewVisible,
    setCameraPreviewVisible: (v) => { cameraPreviewVisible = v; },
    resetView: () => { camViewZoom = 1; camViewOffset = { x: 0, y: 0 }; },
    getPageBgColor: () => pageBgColor,
    getPageBgAlpha: () => pageBgAlpha,
    requestRender: () => EventBus.emit('need:render'),
    requestSyncUI: () => EventBus.emit('need:syncUI'),
  });



  function isCameraTrackId(id) {
    if (id == null) return false;
    const t = AppState.tracks[String(id)];
    return !!(t && t.frames && t.frames.some(d => d && d.type === 'camera'));
  }

  function getCameraAtFrame(idx) {
    for (const id in AppState.tracks) {
      const d = getTrackFrame(id, idx);
      if (d && d.type === 'camera') return d;
    }
    return null;
  }

  function getCurrentCameraObject() {
    return getCameraAtFrame(AppState.currentFrameIndex) || SKFE.systems.camera.findCameraObject();
  }




  function cameraToCrop(cam, outW, outH) {
    const rad = (cam.rot || 0) * Math.PI / 180;
    const cw = Math.max(1, cam.w * (cam.scale || 1));
    const ch = Math.max(1, cam.h * (cam.scale || 1));
    return { cx: cam.x, cy: cam.y, scale: Math.min(outW / cw, outH / ch), rotation: rad };
  }




  /* 摄像机参考框：编辑时显示，导出时完全不绘制 */


  /* 摄像机预览浮窗 */


  /* 让当前摄像机取景框自动居中到"UI 面板 / 时间轴"之外的可用区域 */

  /* ---------------- 圆形笔刷矢量橡皮擦（已迁移至 js/systems/eraser.js） ---------------- */
  SKFE.systems.eraser.init({
    AppState,
    EventBus,
    getCanvas: () => canvas,
    getSnapshot, pushPreSnapshot, markCurrentFrameModified,
    invalidateAllFrameThumbs, setGlobalProp, hideHandles,
    isGlobalEdit: () => globalEditEnabled,
    getBindTransform, getBoundFigureTransform, getAnchorOffset,
    jointData, segments, imageBounds, hitObj,
    distToSeg, worldToFigureLocal,
    getInkLocalMatrix, // brush-v5.1.1: 画笔遮罩裁剪需要 ink 的局部→世界矩阵
    getCameraViewObject: () => SKFE.systems.camera.getCameraViewObject(),
    getCameraViewTransform: (cam) => SKFE.systems.camera.getCameraViewTransform(cam),
  });

  /* ---------------- 画笔元件系统（brush-v5.1.0 · js/systems/brush.js） ---------------- */
  SKFE.systems.brush.init({
    AppState,
    EventBus,
    TRACK_ALL_ID,
    getCanvas: () => canvas,
    getSelected: () => AppState.selected,
    getObjects: () => AppState.objects,
    findFigureById: (id) => AppState.objects.find(o => o && o.id === id && o.type === 'figure'),
    getViewScale: () => AppState.viewScale,
    getViewOffset: () => AppState.viewOffset,
    /* 屏幕 ↔ 世界：与指针交互共用 getPos 的换算（含摄像机子轨道视角） */
    screenToWorld: (sx, sy) => getPos({ clientX: sx, clientY: sy }),
    worldToScreen: (p) => worldToScreenPoint(p),
    /* v6.2.0：画笔 overlay 会挡住滚轮/双指，缩放要转交给这个实现 */
    zoomViewAt: (clientX, clientY, factor) => zoomViewAt(clientX, clientY, factor),
    /* v7.0.2：双指拖动平移也一起转交 */
    panView: (dx, dy) => panViewBy(dx, dy),
    getInkLocalMatrix,
    getBindTransform, getBoundFigureTransform, getBindBase, getAnchorOffset,
    jointData,
    nextUid: () => ++uid,
    generateName: (type) => { const tmp = { type }; generateName(tmp); return tmp.name; },
    addObjectToFrames,
    select: (o) => select(o),
    getSnapshot, pushPreSnapshot,
    markCurrentFrameModified, invalidateAllFrameThumbs, setGlobalProp,
    refreshUI: () => EventBus.emit('need:syncUI'),
    showToast: (msg, type, ms) => showHistoryToast(msg, type, ms),
    getUndoDepth: () => undoStack.length,
    isPlaying: () => isPlaying,
    pause: () => pause(),
    isGlobalEdit: () => globalEditEnabled,
    deleteInkOnCurrentFrame,
    /* 橡皮擦（画笔模式下可临时切换到擦除笔迹） */
    eraserSetOn: (on) => SKFE.systems.eraser.setOn(on),
    eraserIsOn: () => SKFE.systems.eraser.isOn(),
    eraserGetSize: () => SKFE.systems.eraser.size(),
    eraserSetSize: (n) => SKFE.systems.eraser.setSize(n),
    eraserSetLineMode: (b) => SKFE.systems.eraser.setLineMode(b),
    eraserClearFrame: () => SKFE.systems.eraser.clearFrame(),
    eraserClearAll: () => SKFE.systems.eraser.clearAll()
  });

  function drawErasedObjectGroup(o, items) {
    const mainCtx = ctx;
    
    // 1. 计算这个对象在世界坐标下的包围盒
    let bbox = null;
    try {
      bbox = getObjectBounds(o);
    } catch (e) {
      bbox = { left: -500, right: 500, top: -500, bottom: 500 };
    }
    const pad = 40; // 给线宽和擦除留点余量
    const bw = Math.max(1, Math.ceil(bbox.right - bbox.left + pad * 2));
    const bh = Math.max(1, Math.ceil(bbox.bottom - bbox.top + pad * 2));
    
    // 2. 获取当前上下文的缩放系数，用于决定局部画布的分辨率
    let tr = { a: 1, d: 1 };
    try { tr = mainCtx.getTransform(); } catch(_) {}
    const scaleX = Math.abs(tr.a) || 1;
    const scaleY = Math.abs(tr.d) || 1;
    
    // 3. 创建局部画布
    const scratch = document.createElement('canvas');
    scratch.width = Math.ceil(bw * scaleX);
    scratch.height = Math.ceil(bh * scaleY);
    const sctx = scratch.getContext('2d');
    
    // 4. 设置坐标系（平移到包围盒左上角）
    sctx.scale(scaleX, scaleY);
    sctx.translate(-bbox.left + pad, -bbox.top + pad);
    
    // 5. 在局部画布上绘制内容
    const savedCtx = ctx;
    ctx = sctx;
    try {
      items.sort((a,b) => a.level - b.level);
      for (const item of items) {
        try { item.draw(); } catch (_) {}
      }
      /* brush-v5.1.2: ink 的遮罩已经在自己内部按落笔顺序画过了，这里不能再叠一次，
         否则"擦除之后画上去"的笔迹会被整体擦掉。 */
      if (o.type !== 'ink') SKFE.systems.eraser.drawMask(sctx, o);
    } finally {
      ctx = savedCtx;
    }
    
    // 6. 将局部画布原样贴回主画布
    mainCtx.save();
    try {
      mainCtx.drawImage(scratch, bbox.left - pad, bbox.top - pad, bw, bh);
    } catch (_) {}
    mainCtx.restore();
  }

  function queueObjectByType(o, isSel, isExporting, opts) {
    if (o.type === 'figure') queueFigure(o, isSel, isExporting, opts);
    else if (o.type === 'image') queueImageObj(o, isSel, isExporting, opts);
    else if (o.type === 'acc') queueAcc(o, isSel, isExporting, opts);
    else if (o.type === 'shape') queueShape(o, isSel, isExporting, opts);
    else if (o.type === 'bubble') queueBubble(o, isSel, isExporting, opts);
    else if (o.type === 'video') queueVideo(o, isSel, isExporting, opts);
    else if (o.type === 'ink') queueInk(o, isSel, isExporting, opts); // brush-v5.1.0: §6.3.1
  }


  initTimelineDock();
  SKFE.systems.camera.initPreviewFloat();
  SKFE.systems.eraser.initUI();
  SKFE.systems.brush.boot(); // brush-v5.1.0: 必须在 eraser.initUI 之后（复用圆形光标并接管其显示）
  SKFE.systems.camera.initUI();

  /* ==================== 键盘快捷键 ==================== */
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); undo(); return; }
      if (k === 'y') { e.preventDefault(); redo(); return; }
    }
    if (k === 'c') { e.preventDefault(); cloneSelected(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
    else if (k === 'r') { e.preventDefault(); resetPose(); }
    else if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'arrowleft') { e.preventDefault(); goToFrame(AppState.currentFrameIndex - 1); }
    else if (k === 'arrowright') { e.preventDefault(); goToFrame(AppState.currentFrameIndex + 1); }
  });

  window.addEventListener('resize', () => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return;
    resize();
  });

  /* ==================== 语言按钮（保留基础功能） ==================== */
  document.getElementById('btnLang').onclick = () => {
    setLang(getLang() === 'zh-CN' ? 'en' : 'zh-CN');
  };

  /* ==================== 语言切换后刷新界面 ==================== */
  window.SKFE_REFRESH_I18N = function () {
    updateFrameBar(); updatePresetListUI(); updateActionListUI();
    SKFE.features.theme.updateThemePresetUI(); EventBus.emit('need:syncUI'); syncAdvToggles();
    updateVideoUI(); updateMultiActions();
    /* v7.2.2：这几处文字是 JS 拼出来的，不挂在 data-i18n 上，切语言必须手动重刷，
       否则会留着一整排上一门语言的按钮（「开启自由缩放」「锁定面板位置」之类）。 */
    syncResizeUI();
    updateLockPanelUI();
    updateTweenEaseLabel();
    renderTweenEaseMenu();
    syncPinViewBtn();
    SKFE.features.colorTools.updateColorToolLabels();
    if (typeof syncSnapBtn === 'function') syncSnapBtn();
    /* v7.1.0：元件列表每行的眼睛/锁/删除按钮 title 是渲染时用 t() 取词的，换语言要重画一次 */
    scheduleRenderLayerPop();
  };

  /* ==================== 初始化 ==================== */
  loadPresetsFromStorage();
  loadActionPresets();
  loadCustomEasePresets();
  updatePresetListUI();
  updateActionListUI();

  resize();

  (function init() {
    // ==================== 注册 EventBus 监听 ====================
    // 必须在 init 最前面注册，否则下面的首次渲染/预设加载 emit 出去会没人接（静默丢失）
    EventBus.on('need:render', () => {
      render(); // render() 内部已包含 renderCanvas(false) + SKFE.systems.camera.updateCameraPreview() 等全部子更新
    });

    EventBus.on('need:syncUI', () => {
      syncUI();
    });

    EventBus.on('history:save', (label, coalesceMs) => {
      saveHistory(label, coalesceMs);
    });

    // 低频综合更新：同时重绘、同步UI、记历史
    EventBus.on('app:update', (label) => {
      render();
      syncUI();
      if (label) saveHistory(label);
    });

    AppState.viewOffset.x = canvas.clientWidth / 2;
    AppState.viewOffset.y = canvas.clientHeight / 2;
    AppState.frames = [{ id: 1, duration: Math.round(1000 / defaultFPS), isTween: false }];
    AppState.tracks = {};
    AppState.currentFrameIndex = 0;
    AppState.activeTrackId = TRACK_ALL_ID;
    AppState.objects = [];
    if (presets.length > 0) {
      loadPreset(presets[0]);
    } else {
      const f = makeFigure(0, 0, '#111111');
      f.extremity.enabled = false;
      generateName(f); addObjectToFrames(f); select(f);
    }
    syncMainLengthFromTracks();
    applyFPS(defaultFPS);
    updateFrameBar();
    syncGroundLineUI();
    syncPageAppearanceUI();
    syncCanvasMaskUI();
    syncAdvToggles();
    SKFE.features.colorTools.loadSwatches();
    SKFE.features.colorTools.enhanceColorInputs();
    SKFE.features.theme.loadThemeConfig();
    SKFE.features.theme.syncThemeUI();
    SKFE.features.theme.applyThemeConfig();
    updateStickyHeaderHeight();
    bindSpatialEvents();
    EventBus.emit('need:render');
    updateUndoRedoButtons();
    syncPinViewBtn();
    syncResizeUI(); // 页面加载时，根据保存的状态刷新一下按钮文字和手柄
    /* v7.0.5：把控件搬进 6 个分区、绑定底部入口栏。必须在所有控件初始化之后做，
       否则负责量尺寸的代码（吸顶高度等）会算到搬迁前的布局。 */
    mountUiSheets();
    applyTranslations();
    if (typeof window.SKFE_REFRESH_I18N === 'function') window.SKFE_REFRESH_I18N();
    saveHistory('初始化');
  })();

  /* ==================== v7.4.0：轨道模式（新增功能，独立模块） ====================
     ★ 这一段是**纯追加**：只把内部接口注入给 js/features/track-strip.js，
       不改动上面任何一行现有逻辑。模块自己订阅事件总线被动更新（need:syncUI / app:update），
       所以不点「轨道」按钮时，程序行为与 v7.3.0 完全一致。 */
  (function initTrackStrip() {
    const TS = SKFE.features.trackStrip;
    if (!TS) return;

    /* 找元件对象：优先当前帧的真实对象，找不到就回落到该轨在当前帧的求值结果 */
    const findObj = (id) => {
      const n = String(id);
      const live = (AppState.objects || []).find(o => o && String(o.id) === n);
      if (live) return live;
      return getTrackFrame(n, AppState.currentFrameIndex) || null;
    };

    TS.init({
      tracks: () => AppState.tracks,
      totalFrames: () => AppState.frames.length,
      currentFrame: () => AppState.currentFrameIndex,
      isMobile: () => isMobile,
      fps: () => defaultFPS,     /* v7.4.1：刻度缩到很小时要按帧率换算分:秒 */
      getDock: () => timelineDock,
      setDock: (mode) => applyTimelineDock(mode),   /* 不改用户存的停靠偏好，只临时挪一下 */

      /* v7.4.2：轨道数据被改过之后，把「当前帧的渲染对象」按轨道重新取一遍。
         必须做：getTrackFrame 对关键帧 / 普通帧返回的就是槽位对象本身，而 AppState.objects
         里还是改动之前那一份 —— 少了这一步，下一次 goToFrame 的 syncFrameRef 会因为
         「不是同一个对象」把关键帧槽位覆写成普通帧，关键帧和分割标记一起丢，
         表现就是「点一下别处，段落就散架」。 */
      refreshObjects() {
        refreshObjectsNow();
        if (!AppState.selected) AppState.selected = isSubTrackMode() ? getActiveTrackObject() : null;
      },

      /* v7.4.3：空白帧打关键帧要有个姿势可用 —— 借最近的可用帧（已剥掉帧身份） */
      nearestPose: (id, i) => nearestPose(String(id), i),

      /* 挂在某个元件上的配饰（画笔 / 贴件…）的轨道 id —— 主体长条伸缩时它们要跟着伸缩。
         逐个轨道取当前帧的求值对象，不依赖 AppState.objects，配饰不在本帧也不会漏。 */
      boundIds(id) {
        const out = [];
        const n = AppState.currentFrameIndex;
        for (const tid in AppState.tracks) {
          if (String(tid) === String(id)) continue;
          const o = getTrackFrame(tid, n);
          if (!o) continue;
          if (o.type === "camera" || o.type === "figure" || o.type === "video") continue;
          if (!o.bindTo || o.bindTo === "none" || o.targetId == null) continue;
          if (String(o.targetId) !== String(id)) continue;
          out.push(String(tid));
        }
        return out;
      },

      /* 高级设置里的「帧缩略图」开关：开着时轨道长条也铺小图（像 AM 那样） */
      thumbMode: () => !!frameThumbMode,
      thumbRev: () => thumbVersion,
      renderThumb(id, i) {
        const n = String(id);
        const key = n + "|" + i;
        const hit = trackThumbCache.get(key);
        if (hit && hit.v === thumbVersion) return hit.url;
        const fr = AppState.frames[i];
        if (!fr) return null;
        let url = null;
        try {
          const off = renderFrameToDataURL(fr, 96, 96, { transparent: true, ignoreCamera: !isCameraTrackId(n) }, n);
          url = off ? off.toDataURL("image/png") : null;
        } catch (_) { url = null; }
        if (url) trackThumbCache.set(key, { v: thumbVersion, url });
        else trackThumbCache.delete(key);
        return url;
      },
      goToFrame: (i) => goToFrame(i),
      getTrackFrame: (id, i) => getTrackFrame(String(id), i),
      clone: (o) => cloneObjectKeepImg(o),
      snapshot: () => getSnapshot(),
      pushPre: (snap, label) => pushPreSnapshot(snap, label),
      txBegin: (label) => txBegin(label),
      txEnd: () => txEnd(),
      isTxOpen: () => isTxOpen(),

      /* 点长条 / 点关键帧 / 点行内空白 = 选中这一行的元件（v7.4.7：子轨模式下也生效）。
         以前这里有一句「子轨模式且不是当前轨就 return」——
         结果在子轨里点别的行完全没反应，用户报的就是这个「点轨道没选中元件」。
         现在点谁就是谁：select() 内部会把隔离轨一起切过去。 */
      selectTrack(id) {
        if (id == null) return;
        const sid = String(id);
        if (!AppState.tracks[sid]) return;
        const o = findObj(sid);
        if (o) { select(o); return; }
        /* 这一帧这个元件不出场（空白帧）：至少把「当前轨道」切过去，属性面板留空 */
        if (isSubTrackMode()) setActiveTrack(sid);
      },

      /* 眼睛：直接复用元件列表现成的「全帧隐藏」，不新写一套 */
      toggleHidden(id) {
        const o = findObj(id);
        if (o) setObjectHiddenGlobal(o, !o.hidden);
      },

      /* 切割目标：子轨模式下就是当前轨，否则取当前选中的元件 */
      targetTrackId() {
        if (isSubTrackMode()) return String(AppState.activeTrackId);
        if (AppState.selected) return String(AppState.selected.id);
        return null;
      },

      /* 轨道数据被改过之后的统一收尾 —— 全是现有函数，不新增语义 */
      afterChange() {
        bumpKfEval();
        syncMainLengthFromTracks();
        updateFrameBar();
        EventBus.emit('need:render');
        EventBus.emit('need:syncUI');
      },

      /* v7.4.6：轨道改短之后，把时间轴尾巴上「所有元件都不出场」的空白帧收掉。
         以前改动只同步「变长」，不会变短 —— 裁短长条后时间轴末尾留着一串空帧，
         导出视频时就成了末尾的空白画面。 */
      trimTail() { trimTrailingEmptyFrames(); },

      /* v7.4.7：这条轨一个元件都不剩了（全空白帧）就把这一行删掉，
         别在轨道面板里留一行空壳。轨道视图每次提交后调一次。 */
      pruneTracks() { return pruneEmptyTracks(); },

      relayout() {
        refreshTimelineDockOffsets();
        resize();
        /* v7.4.0：置底停靠时面板被拉高会钻到左边属性面板下面，
           按「多出来的高度」把它收一收。正常高度时写回去的和原来完全一样，
           自由缩放（用户亲手拖过尺寸）时一律不碰。 */
        const tl = document.getElementById('timeline');
        const ui = document.getElementById('ui');
        if (tl && ui && !isMobile && !(uiResizable && uiCustomSize) && tl.classList.contains('timeline-bottom')) {
          const extra = Math.max(0, tl.offsetHeight - 100);
          const reserved = 114 + extra;
          ui.style.maxHeight = 'calc(100vh - ' + reserved + 'px)';
          ui.style.height = 'calc(100vh - ' + reserved + 'px)';
        }
      },
      toast(msg) { showHistoryToast(msg, 'tips', 1800); }
    });
  })();

  /* v7.0.0：调试入口（只在 ?debug=1 时挂到 window，方便无头测试与排障）。
     不参与任何功能逻辑，正式使用时不会存在。 */
  if (/[?&]debug=1/.test(location.search)) {
    window.__skfe = {
      AppState, KF, EventBus, TRACK_ALL_ID,
      getTrackFrame, getTrackSlot, getObjectsForFrameAt, getCombinedObjectsForRender,
      goToFrame, updateFrameBar, syncFrameRef, bumpKfEval, reconcileAllTracks,
      renderFrameToDataURL, renderScene, markCurrentFrameModified,
      toggleKeyframe: () => toggleKeyframeAtCurrent(),
      insertFrames: (n) => insertFramesInSegment(n),
      trimTrailingEmptyFrames, addFrame, deleteFrame,
      pruneEmptyTracks,
      deleteSelectedFrames, deleteSelected,
      applyEase: (k) => applyEaseToCurrentSegments(k),
      applyChannelEase: (objId, part, k) => pushChannelEaseToSegments(objId, part, k),
      exportProjectJSON, importProjectJSON, deserializeProject, applyLoadedProject,
      projectVersion: PROJECT_VERSION,
      historySize: () => undoStack.length,
      txBegin: (l) => txBegin(l), txEnd: () => txEnd(), txRun: (l, f) => txRun(l, f), isTxOpen: () => isTxOpen(),
      historyTop: () => (undoStack[undoStack.length - 1] || {}).label || null,
      /* v7.4.2：排查「撤销一次退两步」这类问题时，把历史栈摊开看 */
      historyDump: () => undoStack.map((x, i) => i + ":" + (x.label || "?") + ":" +
        Object.keys((x.snap && x.snap.tracks) || {}).map(k => k + "(" + ((x.snap.tracks[k] || {}).frames || []).length + ")").join("/")),
      addObjectToFrames, makeFigure, mainKeyStateAt, kfPartialNames,
      /* v7.2.1：无头回归要能直接选中某个元件（不用模拟画布点击） */
      select: (o) => select(o),
      kfChipKind: (i) => kfChipKind(i),
      segmentAhead: (trackId, idx) => {
        const t = AppState.tracks[String(trackId)];
        return t && t.frames ? segmentAhead(t.frames, typeof idx === 'number' ? idx : AppState.currentFrameIndex) : null;
      },
      goto: (i) => { goToFrame(i); EventBus.emit('need:render'); },
      /* v7.2.0：拖动落点与尾部复制，供无头回归直接构造场景 */
      applyFrameMove: (from, to, opts) => applyFrameMove(from, to, opts),
      repairTailAfterLastKey: (id) => repairTailAfterLastKey(id),
      markKey: (trackId, idx, origin) => {
        const t = AppState.tracks[String(trackId)];
        if (!t) return false;
        while (t.frames.length <= idx) t.frames.push(null);
        if (!KF.isReal(t.frames[idx])) return false;
        KF.markKey(t.frames[idx], origin || 'sub');
        reconcileAllTracks();
        bumpKfEval();
        return true;
      }
    };
    /* 兼容早前的调试钩子名（无头回归脚本仍在用） */
    window.__SKFE_DBG = window.__skfe;
  }
})();
