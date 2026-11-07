
(function () {
  'use strict';

  /* ==================== 外部模块解构（SKFE.core） ==================== */
  const { P, TAU, displayY, TRACK_ALL_ID } = SKFE.core.constants;
  const { EventBus } = SKFE.core.eventBus;
  const { darkenColor, hexToRgb, rgbToHex, lerpColor, themeHexToRgba, themeMixHex } = SKFE.core.colorUtils;
  const { along, norm, distToSeg, worldToFigureLocal } = SKFE.core.geometry;

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
  const btnToggleUI = document.getElementById('btnToggleUI');
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
  let currentLW = 11;

  let groundShadowEnabled = false;
  let shadowColor = '#000000';
  let shadowAlpha = 0.3;
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
  let globalEditEnabled = true;

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
        else alert('当前浏览器不支持网页全屏。\niPhone Safari 建议使用分享菜单「添加到主屏幕」。');
      } catch (e) {
        alert('进入全屏失败。');
      }
    }
  }
  btnFullscreen.addEventListener('click', toggleFullscreen);
  const updateFullscreenBtn = () => {
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    btnFullscreen.textContent = isFull ? '退出全屏' : '全屏';
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

  function showHistoryToast(msg, type) {
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
    }, 1700);
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

  function saveHistory(label) {
    if (isUndoRedoAction) return;
    if (typeof label !== 'string' || !label) label = '编辑';
    thumbVersion++;
    undoStack.push({ snap: getSnapshot(), label });
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
  function markCurrentFrameModified() {
    if (AppState.frames[AppState.currentFrameIndex] && AppState.frames[AppState.currentFrameIndex].isTween) {
      AppState.frames[AppState.currentFrameIndex].isTween = false;
      updateFrameBar();
    }
    if (AppState.frames[AppState.currentFrameIndex]) delete AppState.frames[AppState.currentFrameIndex]._thumb;
    if (isSubTrackMode()) trackThumbCache.delete(AppState.activeTrackId + '|' + AppState.currentFrameIndex);
    SKFE.systems.autosave.scheduleAutoArchiveSave();
  }

  /* ==================== 项目文件导出与导入 ==================== */
  const PROJECT_SAVE_KEY = 'skfe_project_v1';

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
        const arr = (t.frames || []).map(d => d || null);
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
      version: 2,
      frames: serializeFrames(),
      tracks: serializeTracks(),
      currentFrameIndex: AppState.currentFrameIndex, defaultFPS,
      groundShadowEnabled, shadowColor, shadowAlpha,
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
      syncMainLengthFromTracks();
      AppState.currentFrameIndex = data.currentFrameIndex || 0;
      if (AppState.currentFrameIndex >= AppState.frames.length) AppState.currentFrameIndex = 0;
      if (AppState.currentFrameIndex < 0) AppState.currentFrameIndex = 0;
      if (AppState.activeTrackId !== TRACK_ALL_ID && !AppState.tracks[AppState.activeTrackId]) AppState.activeTrackId = TRACK_ALL_ID;
      AppState.objects = getCombinedObjectsForRender();
      defaultFPS = data.defaultFPS || 12;
      groundShadowEnabled = data.groundShadowEnabled || false;
      shadowColor = data.shadowColor || '#000000';
      shadowAlpha = data.shadowAlpha !== undefined ? data.shadowAlpha : 0.3;
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
        applyLoadedProject(data).then(() => {
          EventBus.emit('history:save', '导入项目');
          alert('项目导入成功');
        });
      } catch (err) {
        alert('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  function saveProjectToLocal() {
    try {
      const projectData = {
        version: 2,
        frames: serializeFrames(),
        tracks: serializeTracks(),
        currentFrameIndex: AppState.currentFrameIndex, defaultFPS,
        groundShadowEnabled, shadowColor, shadowAlpha,
        groundLineEnabled, groundLineY,
        onionEnabled, onionBefore, onionAfter,
        canvasBounds: AppState.canvasBounds, canvasBoundsEnabled: AppState.canvasBoundsEnabled,
        pageBgColor, gridEnabled, gridSize,
        canvasMaskEnabled, canvasMaskAlpha,
        canvasMaskBgColor, canvasMaskGridColor, // 新增
      };
      localStorage.setItem(PROJECT_SAVE_KEY, JSON.stringify(projectData));
      alert('已保存到本地');
    } catch (err) {
      alert('保存失败，可能超出了本地存储限制: ' + err.message);
    }
  }

  function loadProjectFromLocal() {
    const raw = localStorage.getItem(PROJECT_SAVE_KEY);
    if (!raw) return alert('本地没有保存的项目');
    try {
      const data = JSON.parse(raw);
      applyLoadedProject(data).then(() => {
        EventBus.emit('history:save', '读取本地项目');
        alert('本地项目读取成功');
      });
    } catch (err) {
      alert('读取失败: ' + err.message);
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
      groundShadowEnabled, shadowColor, shadowAlpha,
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
        groundShadowEnabled = !!data.groundShadowEnabled;
        if (data.shadowColor) shadowColor = data.shadowColor;
        if (data.shadowAlpha !== undefined) shadowAlpha = data.shadowAlpha;
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
        if (data.globalEditEnabled !== undefined) {
          globalEditEnabled = !!data.globalEditEnabled;
          const geEl = document.getElementById('globalEdit');
          if (geEl) geEl.checked = globalEditEnabled;
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
    btnToggle.textContent = refVideoVisible ? '👁' : '🚫';
    btnPlay.textContent = (refVideoPlaying && refVideo && !refVideo.paused) ? '⏸' : '▶';
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
    reader.onerror = () => { if (token !== videoLoadToken) return; hideVideoProgress(); alert('视频加载失败'); };
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
        hideVideoProgress(); alert('视频加载失败');
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

  /* ==================== 颜色工具 ==================== */

  /* ==================== 预设 ==================== */
  function loadPresetsFromStorage() {
    try { const raw = localStorage.getItem(PRESET_KEY); presets = raw ? JSON.parse(raw) : []; }
    catch (e) { presets = []; }
  }
  function savePresetsToStorage() {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); }
    catch (e) { alert('保存预设失败，浏览器存储空间可能已满'); }
  }
  function updatePresetListUI() {
    const listEl = document.getElementById('presetList');
    listEl.innerHTML = '';
    if (presets.length === 0) {
      listEl.innerHTML = '<div class="empty-state">暂无预设，选中火柴人后保存吧</div>';
      return;
    }
    presets.forEach((p, index) => {
      const div = document.createElement('div');
      div.className = 'preset-item';
      const infoDiv = document.createElement('div');
      infoDiv.className = 'preset-info';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'preset-name';
      nameDiv.textContent = p.name || '未命名预设';
      if (p.data.color) nameDiv.style.color = p.data.color;
      const metaDiv = document.createElement('div');
      metaDiv.className = 'preset-meta';
      let metaHtml = `<span>LW:${p.data.lw}</span>`;
      if (p.data.glow.enabled) metaHtml += ' <span>✨发光</span>';
      if (p.data.light.enabled) metaHtml += ' <span>💡高光</span>';
      if (p.data.extremity.enabled) metaHtml += ' <span>🦵手脚</span>';
      if (p.data.depth && p.data.depth.enabled) metaHtml += ' <span>🌗深色</span>';
      if (p.accessories && p.accessories.length > 0) metaHtml += ` <span>🎀x${p.accessories.length}</span>`;
      metaDiv.innerHTML = metaHtml;
      infoDiv.appendChild(nameDiv);
      infoDiv.appendChild(metaDiv);

      const btns = document.createElement('div');
      btns.className = 'preset-actions';
      const renameBtn = document.createElement('div');
      renameBtn.className = 'preset-rename';
      renameBtn.textContent = '✎';
      renameBtn.title = '重命名预设';
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
      delBtn.textContent = '✕';
      delBtn.title = '删除';
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
      shadowScaleX: AppState.selected.shadowScaleX || 1, shadowScaleY: AppState.selected.shadowScaleY || 1
    };
    const boundAccs = AppState.objects.filter(o => o.type === 'acc' && o.targetId === AppState.selected.id);
    const accessories = boundAccs.map(acc => ({
      imgSrc: acc.img.src, w: acc.w, h: acc.h, alpha: acc.alpha, scale: acc.scale,
      layer: acc.layer, bindTo: acc.bindTo, offX: acc.offX, offY: acc.offY, rot: acc.rot
    }));
    presets.push({ name, data, accessories });
    savePresetsToStorage();
    updatePresetListUI();
    nameInput.value = '';
    const btn = document.getElementById('btnSavePreset');
    btn.textContent = '已保存 ✓';
    btn.classList.add('is-saved');
    setTimeout(() => { btn.textContent = '保存预设'; btn.classList.remove('is-saved'); }, 1000);
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
    f.bodyScale = JSON.parse(JSON.stringify(d.bodyScale));
    f.headAngle = d.headAngle;
    f.light = JSON.parse(JSON.stringify(d.light));
    f.glow = JSON.parse(JSON.stringify(d.glow));
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
              ax: 0, ay: 0, mirror: false
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
    catch (e) { alert('保存动作失败，浏览器存储空间可能已满'); }
  }

  function updateActionListUI() {
  const listEl = document.getElementById('actionList');
  listEl.innerHTML = '';
  if (actionPresets.length === 0) {
    listEl.innerHTML = '<div class="empty-state">暂无动作，选中火柴人保存吧</div>';
    selectedActionIndex = -1;
    return;
  }
  if (selectedActionIndex >= actionPresets.length) selectedActionIndex = -1;
  actionPresets.forEach((p, index) => {
    const isSelected = (index === selectedActionIndex);
    const div = document.createElement('div');
    div.className = 'preset-item';
    div.style.cursor = 'pointer';
    div.title = isSelected ? '已选中，点「导出动作」只导出此动作' : '点击选中该动作';
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
    const metaText = p.frames.length + ' 帧' + (isSelected ? ' · 已选中' : ' · 点击选中');
    infoDiv.innerHTML = `<div class="preset-name">${p.name || '未命名动作'}</div><div class="preset-meta">${metaText}</div>`;
    const btns = document.createElement('div');
    btns.className = 'preset-actions';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = '应用';
    applyBtn.className = 'btn-soft btn-xs';
    applyBtn.onclick = (e) => { e.stopPropagation(); applyActionPreset(p); };
    const delBtn = document.createElement('div');
    delBtn.className = 'preset-del';
    delBtn.textContent = '✕';
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
    name: preset.name || '未命名动作',
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
    if (!AppState.selected || AppState.selected.type !== 'figure') return alert('请先选中一个火柴人');
    const nameInput = document.getElementById('actionNameInput');
    const name = nameInput.value.trim() || ('动作 ' + (actionPresets.length + 1));

    const targetId = String(AppState.selected.id);

    /* 找到第一个非空帧作为基准（10A） */
    let baseFig = null;
    for (let i = 0; i < AppState.frames.length; i++) {
      const fig = getTrackFrame(targetId, i);
      if (fig) { baseFig = fig; break; }
    }
    if (!baseFig) return alert('当前元件的轨道上没有有效帧，无法保存动作');

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
    alert('动作已保存');
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
        while (tr.frames.length <= idx) tr.frames.push(null);
        if (!getTrackFrame(fid, idx)) {           /* 火柴人这一帧不在，配饰也不该在 */
          if (tr.frames[idx]) { tr.frames[idx] = null; changed = true; }
          continue;
        }
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
    if (!AppState.selected || AppState.selected.type !== 'figure') return alert('请先选中一个火柴人');
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

        /* 旋转累计差（1A） */
        if (data.rotTotal !== undefined && isFinite(data.rotTotal)) {
          fig.rot = targetBase.rot + data.rotTotal;
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
  if (actionPresets.length === 0) return alert('没有保存的动作');
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
          alert('成功导入 ' + valid.length + ' 个动作');
        } else {
          alert('导入失败，格式不正确');
        }
      } catch (err) { alert('导入失败，格式不正确'); }
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
  let uiStartLeft = 0, uiStartTop = 0, uiStartWidth = 0;
  let uiPanelDragged = false;
  const uiDragHandle = document.getElementById('uiDragHandle');

  let isPanelLocked = false;
  const btnLockPanel = document.getElementById('btnLockPanel');

  function updateLockPanelUI() {
    if (!btnLockPanel) return;
    btnLockPanel.textContent = isPanelLocked ? '🔓 解锁面板位置' : '🔒 锁定面板位置';
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
      const maxTop = window.innerHeight - bottomOffset - 50;
      const nt = Math.max(10, Math.min(maxTop, uiStartTop + dy));
      uiPanel.style.left = '0';
      uiPanel.style.right = '0';
      uiPanel.style.width = '100%';
      uiPanel.style.top = nt + 'px';
      uiPanel.style.bottom = bottomOffset + 'px'; // 精准贴底
      uiPanel.style.maxHeight = Math.max(120, window.innerHeight - nt - bottomOffset) + 'px';
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
    }
  };
  uiDragHandle.addEventListener('pointerup', endUiDrag);
  uiDragHandle.addEventListener('pointercancel', endUiDrag);

  /* ==================== 自由缩放面板长宽 ==================== */
  const btnToggleResize = document.getElementById('btnToggleResize');
  const uiResizeHandle = document.getElementById('uiResizeHandle');

  function syncResizeUI() {
    if (btnToggleResize) {
      btnToggleResize.textContent = uiResizable ? '📐 关闭自由缩放' : '📐 开启自由缩放';
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
      uiPanel.style.left = '0';
      uiPanel.style.right = 'auto';
      uiPanel.style.top = 'auto';
      uiPanel.style.bottom = '0';
      uiPanel.style.width = uiCustomSize.w + 'px';
      uiPanel.style.height = uiCustomSize.h + 'px';
      uiPanel.style.maxHeight = 'none';
    } else {
      uiPanel.style.width = uiCustomSize.w + 'px';
      uiPanel.style.height = uiCustomSize.h + 'px';
      uiPanel.style.maxHeight = 'none';
    }
    updateResizeHandlePos(); // 新增
  }

  // 实时更新右下角手柄的位置（让手柄紧贴面板右下角）
  function updateResizeHandlePos() {
    if (!uiResizable || isPanelLocked || !uiResizeHandle) {
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
        uiPanel.style.left = '0';
        uiPanel.style.right = 'auto';
        uiPanel.style.width = newW + 'px';
        uiPanel.style.bottom = '0';
        uiPanel.style.top = 'auto';
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
    };
    uiResizeHandle.addEventListener('pointerup', endResize);
    uiResizeHandle.addEventListener('pointercancel', endResize);

    uiResizeHandle.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      uiCustomSize = null;
      localStorage.removeItem('skfe_ui_size_v1');
      uiPanel.style.width = '';
      uiPanel.style.height = '';
      uiPanel.style.maxHeight = '';
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
  const btnMobileExpand = document.getElementById('btnMobileExpand');

  if (isMobile) {
    btnToggleUI.style.display = 'block';
    uiPanel.classList.add('hidden');
    /* v6.0：面板默认收起，必须同时给出「展开」入口，否则手机上找不到设置面板 */
    if (btnMobileExpand) btnMobileExpand.style.display = 'flex';
    uiPanel.addEventListener('click', (e) => {
      const collapsed = uiPanel.classList.contains('hidden');
      /* 收起状态下点拖动条/空白处都应展开；展开状态下这些区域交给拖动逻辑，不抢事件 */
      if (!collapsed && (e.target.closest('#uiDragHandle') || e.target.closest('button') || e.target.closest('input') ||
          e.target.closest('select') || e.target.closest('details') || e.target.closest('label'))) return;
      if (collapsed) {
        uiPanel.classList.remove('hidden');
        btnToggleUI.textContent = '收起';
        btnMobileExpand.style.display = 'none';
        document.body.classList.add('ui-open');   /* 展开时让底部浮动按钮让位 */
        setTimeout(resize, 0);                    /* 让 70vh 的面板高度规则立即生效 */
      }
    });
    btnToggleUI.addEventListener('click', (e) => {
      e.stopPropagation();
      uiPanel.classList.add('hidden');
      btnToggleUI.textContent = '展开';
      btnMobileExpand.style.display = 'flex';
      document.body.classList.remove('ui-open');
    });
    btnMobileExpand.addEventListener('click', (e) => {
      e.stopPropagation();
      uiPanel.classList.remove('hidden');
      btnToggleUI.textContent = '收起';
      btnMobileExpand.style.display = 'none';
      document.body.classList.add('ui-open');
      setTimeout(resize, 0);
    });
    setTimeout(resize, 100);
    const tip = document.createElement('div');
    tip.textContent = '💡 双指拖动平移，捏合缩放';
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
    
    if (isMobile) {
      btnMobileExpand.style.display = uiPanel.classList.contains('hidden') ? 'flex' : 'none';
    }
    // 所有的面板位置计算统一交给 refreshTimelineDockOffsets 处理
    refreshTimelineDockOffsets();
    resize();
    /* 摄像机视角下，时间轴开关会改变可用区域 → 重新适配，保证取景框不被遮挡 */
    if (isCameraTrackId(AppState.activeTrackId)) {
      SKFE.systems.camera.fitCameraViewToAvailableArea();
      EventBus.emit('need:render');
    }
  }
  document.getElementById('btnShowTimeline').onclick = () => toggleTimeline(true);
  document.getElementById('btnHideTimeline').onclick = () => toggleTimeline(false);

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
      x, y, color: color || '#111111', lw: lw || 11,
      alpha: 1, scale: 1.67, locked: false,
      rot: 0, mirror: false,
      shadowOffX: 0, shadowOffY: 0, shadowScaleX: 1, shadowScaleY: 1,
      headFilled: false, headFillCustom: false, headFillColor: '#111111',
      bodyScale: { head: 1.83, arm: 1.06, leg: 1.16, torso: 0.62, foreArm: 0.37, shin: 0.49 },
      headAngle: -Math.PI / 2,
      headOffset: { x: 0, y: 0 },
      light: { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 },
      glow: { enabled: false, color: '#ff9d3d', alpha: 0.8, blur: 18 },
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
      a: {
        torso: -Math.PI / 2, waist: 0,
        armL: { u: Math.PI + 0.18, f: 0.12 },
        armR: { u: Math.PI - 0.18, f: -0.12 },
        legL: { u: Math.PI + 0.10, f: -0.05 },
        legR: { u: Math.PI - 0.10, f: 0.05 }
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

  /* ==================== 轮廓外发光 ==================== */
  function drawFigureGlow(f, j, curLW, radius, alphaMul, armLpts, armRpts, legLpts, legRpts) {
    const allPts = [j.pelvis, j.waistPoint, j.neck, j.headC, ...armLpts, ...armRpts, ...legLpts, ...legRpts];
    let minX = j.headC.x - j.headR, maxX = j.headC.x + j.headR;
    let minY = j.headC.y - j.headR, maxY = j.headC.y + j.headR;
    for (const p of allPts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = curLW + (f.glow.blur || 0) * 2 + 24;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const w = maxX - minX, h = maxY - minY;
    if (w <= 1 || h <= 1 || w > 4000 || h > 4000) return;

    const off = document.createElement('canvas');
    off.width = Math.ceil(w);
    off.height = Math.ceil(h);
    const octx = off.getContext('2d');
    octx.translate(-minX, -minY);
    octx.strokeStyle = f.glow.color;
    octx.fillStyle = f.glow.color;
    octx.lineWidth = curLW;
    octx.lineCap = 'round';
    octx.lineJoin = 'round';

    const savedCtx = ctx;
    ctx = octx;
    try {
      const drawGlowLimb = (limbName, pts) => {
        const needsMask = f.layer[limbName] < f.layer.head && !(f.headFilled || f.headFillCustom);
        if (needsMask) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(-10000, -10000, 20000, 20000);
          ctx.arc(j.headC.x, j.headC.y, Math.max(0, j.headR - curLW / 2), 0, TAU, true);
          ctx.clip();
        }
        ctx.beginPath(); smoothPolyline(pts, radius); ctx.stroke();
        const startP = pts[0], endP = pts[pts.length - 1];
        ctx.beginPath(); ctx.arc(startP.x, startP.y, curLW / 2, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(endP.x, endP.y, curLW / 2, 0, TAU); ctx.fill();
        if (needsMask) ctx.restore();
      };

      const drawGlowHead = () => {
        ctx.beginPath(); ctx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU);
        if (f.headFilled || f.headFillCustom) ctx.fill(); else ctx.stroke();
      };

      const drawGlowBody = () => {
        const needsMask = f.layer.body < f.layer.head && !(f.headFilled || f.headFillCustom);
        if (needsMask) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(-10000, -10000, 20000, 20000);
          ctx.arc(j.headC.x, j.headC.y, Math.max(0, j.headR - curLW / 2), 0, TAU, true);
          ctx.clip();
        }
        ctx.beginPath(); smoothPolyline([j.pelvis, j.waistPoint, j.neck], radius); ctx.stroke();
        if (needsMask) ctx.restore();
      };

      let layerLegL = f.layer.legL;
      let layerArmL = f.layer.armL;
      if (f.depth && f.depth.enabled) {
        layerLegL = Math.min(layerLegL, f.layer.body - 1);
        layerArmL = Math.min(layerArmL, f.layer.body - 1);
      }

      const items = [
        { level: layerLegL, draw: () => drawGlowLimb('legL', legLpts) },
        { level: layerArmL, draw: () => drawGlowLimb('armL', armLpts) },
        { level: f.layer.legR, draw: () => drawGlowLimb('legR', legRpts) },
        { level: f.layer.armR, draw: () => drawGlowLimb('armR', armRpts) },
        { level: f.layer.head, draw: drawGlowHead },
        { level: f.layer.body, draw: drawGlowBody }
      ];
      items.sort((a, b) => a.level - b.level);
      for (const it of items) it.draw();
    } finally { ctx = savedCtx; }

    ctx.save();
    ctx.globalAlpha = f.alpha * f.glow.alpha * alphaMul;
    ctx.shadowColor = f.glow.color;
    ctx.shadowBlur = f.glow.blur;
    ctx.drawImage(off, minX, minY, w, h);
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
    if (f.glow && f.glow.enabled && f.glow.blur > 0) margin += f.glow.blur;
    if (f.light && f.light.enabled) margin += 2 * (f.light.size || 1) + 4;
    if (groundShadowEnabled) margin += 48;

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

    if (!isGhost && f.glow.enabled && f.glow.blur > 0) {
      renderQueue.push({
        level: minOwnLayer - 1,
        draw: wrapFig(() => drawFigureGlow(f, j, curLW, radius, alphaMul, armLpts, armRpts, legLpts, legRpts))
      });
    }

    if (!isGhost && groundShadowEnabled) {
      const drawGroundShadow = () => {
        ctx.save();
        ctx.globalAlpha = f.alpha * shadowAlpha * alphaMul;
        const lowestY = Math.max(j.footL.y, j.footR.y, j.toeL.y, j.toeR.y);
        const shadowX = f.x + (f.shadowOffX || 0);
        const shadowY = lowestY + 10 + (f.shadowOffY || 0);
        const rx = 30 * f.scale * (f.shadowScaleX || 1);
        const ry = 8 * f.scale * (f.shadowScaleY || 1);
        ctx.translate(shadowX, shadowY);
        ctx.scale(rx, ry);
        let r = 0, g = 0, b = 0;
        if (shadowColor.startsWith('#')) {
          r = parseInt(shadowColor.slice(1, 3), 16) || 0;
          g = parseInt(shadowColor.slice(3, 5), 16) || 0;
          b = parseInt(shadowColor.slice(5, 7), 16) || 0;
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
        ctx.beginPath();
        ctx.rect(-10000, -10000, 20000, 20000);
        ctx.arc(j.headC.x, j.headC.y, Math.max(0, j.headR - curLW / 2), 0, TAU, true);
        ctx.clip();
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
      if (drawLight) {
        ctx.save();
        ctx.strokeStyle = f.light.color;
        ctx.lineWidth = curLW * (f.light.size || 1.0);
        ctx.translate(ox, oy);
        ctx.beginPath(); ctx.arc(j.headC.x, j.headC.y, j.headR, 0, TAU); ctx.stroke();
        ctx.restore();
      }
      const customFill = f.headFillCustom && f.headFillColor;
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
        ctx.beginPath();
        ctx.rect(-10000, -10000, 20000, 20000);
        ctx.arc(j.headC.x, j.headC.y, Math.max(0, j.headR - curLW / 2), 0, TAU, true);
        ctx.clip();
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

    const inkErasers = ink.eraser || [];
    let ordered = ink.strokes;
    if (inkErasers.length) {
      ordered = [];
      for (const s of ink.strokes) ordered.push({ __inkMask: false, z: (typeof s.z === 'number' ? s.z : 0), s });
      for (const er of inkErasers) ordered.push({ __inkMask: true, z: (typeof er.z === 'number' ? er.z : 1e9), er });
      ordered.sort((a, b) => a.z - b.z);
    }

    for (const item of ordered) {
      /* ---- 擦除遮罩 ---- */
      if (item.__inkMask) {
        const pts = item.er && item.er.points;
        if (!pts || !pts.length) continue;
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
        continue;
      }

      const s = item.__inkMask === false ? item.s : item;
      const pts = s.points;
      if (!pts || !pts.length) continue;

      /* ---- 边 ---- */
      if (s.borderWidth > 0 && s.borderColor) {
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
      }

      /* ---- 芯 ---- */
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
    }
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

      for (const item of ordered) {
        if (item.__inkMask) { drawInkMaskLocal(ctx, item.er, finalScale); continue; }
        const s = item.__inkMask === false ? item.s : item;
        const pts = s.points;
        if (!pts || !pts.length) continue;

        /* ---- 边（同一笔先画边，再画笔芯，保证边被芯覆盖） ---- */
        if (s.borderWidth > 0 && s.borderColor) {
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
        }

        /* ---- 芯 ---- */
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
      }
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
    const prevList = _renderList;
    _renderList = list;
    const prevQueue = renderQueue;
    renderQueue = [];

    for (const o of list) {
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
        alert('当前元件存在关节固定，请先在「关节」面板中解除所有帧的固定，才能整体位移或旋转。');
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
      document.getElementById('coordType').textContent = '🖼 画布';
      document.getElementById('coordXY').textContent =
        `X: ${Math.round(AppState.canvasBounds.x + AppState.canvasBounds.w / 2)}  Y: ${Math.round(displayY(AppState.canvasBounds.y + AppState.canvasBounds.h / 2))}`;
    } else if (AppState.selected && !isPlaying) {
      let x, y, typeIcon, typeName;
      if (AppState.selected.type === 'figure' || AppState.selected.type === 'image' || AppState.selected.type === 'video') {
        x = AppState.selected.x; y = AppState.selected.y;
        typeIcon = AppState.selected.type === 'figure' ? '🖤' : AppState.selected.type === 'image' ? '🌇' : '🎥';
        typeName = AppState.selected.name;
      } else if (AppState.selected.type === 'camera') {
        x = AppState.selected.x; y = AppState.selected.y;
        typeIcon = '🎥';
        typeName = AppState.selected.name;
      } else {
        const tr = getBindTransform(AppState.selected);
        x = tr.x; y = tr.y;
        typeIcon = AppState.selected.type === 'acc' ? '👑' : AppState.selected.type === 'shape' ? '🔷' : '💬';
        typeName = AppState.selected.name;
      }
      document.getElementById('coordType').textContent = typeIcon + ' ' + typeName;
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
      if (data) list.push(data);
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

  function renderCanvas(isExporting) {
    isExporting = !!isExporting;
    const trackAlphaOpts = (!isExporting && isSubTrackMode()) ? { alphaFor: getTrackRenderAlpha } : {};
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!isExporting) {
      ctx.fillStyle = pageBgAlpha < 1 ? themeHexToRgba(pageBgColor, pageBgAlpha) : pageBgColor;
      ctx.fillRect(0, 0, w, h);
    } else if (window.exportFormat === 'jpg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
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
      if (o.locked === undefined) o.locked = false;
      const btn = document.createElement('div');
      btn.className = 'layer-btn' + (o === AppState.selected ? ' active' : '') + (o.locked ? ' locked' : '');
      let icon = '❓';
      if (o.type === 'figure') icon = '🖤';
      else if (o.type === 'image') icon = '🌇';
      else if (o.type === 'acc') icon = '👑';
      else if (o.type === 'shape') icon = '🔷';
      else if (o.type === 'bubble') icon = '💬';
      else if (o.type === 'ink') icon = '🖌'; // brush-v5.1.0: §6.3.9
      else if (o.type === 'camera') icon = '🎥';
      btn.innerHTML = `<span>${icon}</span><span class="idx">${idx++}</span>`;
      attachLayerName(btn, o);
      btn.onclick = () => { select(o); EventBus.emit('need:render'); };
      layerListEl.appendChild(btn);
    });

    if (AppState.selected) {
      btnToggleLock.style.display = 'block';
      if (AppState.selected.locked) {
        btnToggleLock.textContent = '🔒 解锁';
        btnToggleLock.classList.add('danger');
      } else {
        btnToggleLock.textContent = '🔓 锁定';
        btnToggleLock.classList.remove('danger');
      }
    } else {
      btnToggleLock.style.display = 'none';
    }
  }

  btnToggleLock.onclick = () => {
    if (AppState.selected) {
      AppState.selected.locked = !AppState.selected.locked;
      EventBus.emit('need:syncUI');
      EventBus.emit('need:render');
      EventBus.emit('history:save', '锁定/解锁对象');
    }
  };

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

  function getMainLength() {
    let max = 1;
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (t && t.frames && t.frames.length > max) max = t.frames.length;
    }
    return max;
  }

  function getTrackFrame(trackId, idx) {
    const t = AppState.tracks[trackId];
    if (!t || !t.frames) return null;
    if (idx < 0 || idx >= t.frames.length) return null;
    return t.frames[idx] || null;
  }

  function setTrackFrame(trackId, idx, data) {
    const t = AppState.tracks[trackId];
    if (!t) return;
    if (!t.frames) t.frames = [];
    while (t.frames.length <= idx) t.frames.push(null);
    t.frames[idx] = data || null;
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
    sel.title = enabled ? '设置非当前元件轨道的画布显示方式' : '仅在元件子轨道模式下可用';
    if (hint) hint.textContent = enabled ? '非当前元件轨道' : '选择元件子轨道后可调整';
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
      allOpt.textContent = '[全局主时间轴]';
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
      sel.innerHTML = '<option value="all">全部对象 (主时间线)</option>';
      sel.disabled = true;
    }
  }

  function updateTargetFigureOptions() {
    const figures = AppState.objects.filter(o => o.type === 'figure');
    targetFigureSelect.innerHTML = '<option value="">-- 请选择 --</option>';
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
      const mine = AppState.objects.find(o => o && o.type !== 'video' && String(o.id) === String(AppState.activeTrackId)) || null;
      while (t.frames.length <= idx) t.frames.push(null);
      t.frames[idx] = mine;
      syncMainLengthFromTracks();
      return;
    }
    /* 全局模式：把当前帧合并视图按 id 分发回各 track */
    const present = new Set();
    for (const o of AppState.objects) {
      if (!o || o.type === 'video') continue;
      const id = String(o.id);
      present.add(id);
      const t = ensureTrack(id, o.name);
      while (t.frames.length <= idx) t.frames.push(null);
      t.frames[idx] = o;
    }
    for (const id in AppState.tracks) {
      if (present.has(id)) continue;
      const arr = AppState.tracks[id].frames;
      if (arr && idx < arr.length) arr[idx] = null;
    }
    syncMainLengthFromTracks();
  }

  function goToFrame(i) {
    if (i < 0 || i >= AppState.frames.length) return;
    if (isPlaying) pause();
    syncFrameRef();
    AppState.currentFrameIndex = i;
    AppState.objects = getCombinedObjectsForRender();
    AppState.selected = isSubTrackMode() ? getActiveTrackObject() : null;
    drag = null; isPanning = false; AppState.canvasSelected = false;
    cancelTransformBoxDrag(); anchorModeOn = false;
    seekVideoToFrame(AppState.currentFrameIndex);
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
  }

  function updateFrameBar() {
    syncMainLengthFromTracks();
    refreshSubTrackOptions();
    const bar = document.getElementById('frameBar');
    const scrubber = document.getElementById('timelineScrubber');
    if (!bar) return;
    bar.classList.toggle('thumb-mode', frameThumbMode);

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

    AppState.frames.forEach((fr, i) => {
      const chip = document.createElement('div');
      chip.className = 'frame-chip';
      if (fr.isTween) chip.classList.add('tween-frame');
      const emptyTrackFrame = isSubTrackMode() && !getFrameTrackObject(fr, i);
      if (emptyTrackFrame) {
        chip.classList.add('empty-frame');
        chip.title = `第 ${i + 1} 帧 · 当前元件未出场`;
        chip.setAttribute('aria-label', `第 ${i + 1} 帧，当前元件未出场`);
      }
      chip.dataset.index = i;

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
        dragStartX = e.clientX; 
        dragStartY = e.clientY;
        const dragStartIndex = i;
        let hasMoved = false;
        let isDragging = false;
        let insertIndex = i;
        let startScrollLeft = bar.scrollLeft;

        const allChips = Array.from(bar.querySelectorAll('.frame-chip'));

        // 鼠标按下直接开始拖拽，触屏则需要按住 300ms（防止和横向滑动冲突）
        if (isMouse) {
          isDragging = true;
          chip.classList.add('dragging');
          dragIndicator.style.display = 'block';
          dragIndicator.style.left = (allChips[i].offsetLeft) + 'px';
        } else {
          pressTimer = setTimeout(() => {
            isDragging = true;
            chip.classList.add('dragging');
            dragIndicator.style.display = 'block';
            dragIndicator.style.left = (allChips[i].offsetLeft) + 'px';
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

          // 拖拽中：边缘自动滚动
          const barRect = bar.getBoundingClientRect();
          if (me.clientX > barRect.right - 40) bar.scrollLeft += 10;
          else if (me.clientX < barRect.left + 40) bar.scrollLeft -= 10;

          for (let j = 0; j < allChips.length; j++) {
            const rect = allChips[j].getBoundingClientRect();
            const mid = rect.left + rect.width / 2;
            if (me.clientX < mid) { insertIndex = j; break; }
            if (j === allChips.length - 1) insertIndex = allChips.length;
          }

          if (insertIndex === 0) dragIndicator.style.left = (allChips[0].offsetLeft) + 'px';
          else if (insertIndex === allChips.length) dragIndicator.style.left = (allChips[allChips.length - 1].offsetLeft + allChips[allChips.length - 1].offsetWidth) + 'px';
          else dragIndicator.style.left = (allChips[insertIndex].offsetLeft) + 'px';
        };

        const onPointerUp = () => {
          clearTimeout(pressTimer);
          chip.classList.remove('dragging');
          dragIndicator.style.display = 'none';
          document.removeEventListener('pointermove', onPointerMove);
          document.removeEventListener('pointerup', onPointerUp);
          document.removeEventListener('pointercancel', onPointerUp);

          if (isDragging) {
            let targetIndex = insertIndex;
            if (targetIndex > dragStartIndex) targetIndex--;
            
            if (targetIndex !== dragStartIndex) {
              if (isSubTrackMode()) {
                /* 子轨道：只在当前 track 内移动，覆盖目标帧，绝不碰其他 track */
                const t = AppState.tracks[AppState.activeTrackId];
                if (t && t.frames && t.frames.length) {
                  const arr = t.frames;
                  const from = Math.min(dragStartIndex, arr.length - 1);
                  if (from >= 0) {
                    const [moved] = arr.splice(from, 1);
                    const to = Math.max(0, Math.min(targetIndex, arr.length));
                    if (to >= arr.length) arr.push(moved);
                    else arr[to] = moved;
                    syncMainLengthFromTracks();
                    trimTrailingEmptyFrames();
                  }
                  AppState.currentFrameIndex = Math.max(0, Math.min(targetIndex, AppState.frames.length - 1));
                  invalidateAllFrameThumbs();
                  AppState.objects = getCombinedObjectsForRender();
                  AppState.selected = getActiveTrackObject();
                  EventBus.emit('history:save', '调整帧顺序');
                }
              } else {
                /* 全局模式：帧元信息与所有 track 同步重排 */
                const [moved] = AppState.frames.splice(dragStartIndex, 1);
                AppState.frames.splice(targetIndex, 0, moved);
                for (const id in AppState.tracks) {
                  const t = AppState.tracks[id];
                  if (!t) continue;
                  if (!t.frames) t.frames = [];
                  const arr = t.frames;
                  while (arr.length < dragStartIndex) arr.push(null);
                  const removed = arr.splice(dragStartIndex, 1);
                  const movedData = removed.length ? removed[0] : null;
                  const insertAt = Math.max(0, Math.min(targetIndex, arr.length));
                  arr.splice(insertAt, 0, movedData);
                }
                syncMainLengthFromTracks();
                AppState.currentFrameIndex = targetIndex;
                invalidateAllFrameThumbs();
                AppState.objects = getCombinedObjectsForRender();
                AppState.selected = null;
                EventBus.emit('history:save', '调整帧顺序');
              }
              EventBus.emit('need:render'); EventBus.emit('need:syncUI');
            } else {
              // 鼠标拖拽了但位置没有变化，当作点击处理
              if (isMouse && !hasMoved) goToFrame(dragStartIndex);
            }
          } else if (!hasMoved) {
            goToFrame(dragStartIndex);
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
    });

    const active = bar.querySelector('.frame-chip.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    updateMultiActions();
  }

  function addFrame() {
    if (isPlaying) pause();
    syncFrameRef();
    if (isSubTrackMode()) {
      const t = ensureTrack(AppState.activeTrackId, (AppState.selected && AppState.selected.name) || AppState.activeTrackId);
      const srcObj = getFrameTrackObject(null, AppState.currentFrameIndex);
      const clone = srcObj ? cloneObjectKeepImg(srcObj) : null;
      if (clone && srcObj) clone.id = srcObj.id;
      const nextIdx = AppState.currentFrameIndex + 1;
      if (nextIdx < t.frames.length && t.frames[nextIdx] == null) {
        /* 下一帧对当前轨道是空白帧：直接占用该槽位，不把后面的帧挤开 */
        t.frames[nextIdx] = clone;
      } else {
        while (t.frames.length < nextIdx) t.frames.push(null);
        t.frames.splice(nextIdx, 0, clone);
      }
      AppState.currentFrameIndex = nextIdx;
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
    /* 全局模式：所有 track 同步插入，并克隆各自在当前帧的内容 */
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t) continue;
      if (!t.frames) t.frames = [];
      while (t.frames.length < insertAt) t.frames.push(null);
      const src = t.frames[AppState.currentFrameIndex];
      const clone = src ? cloneObjectKeepImg(src) : null;
      if (clone && src) clone.id = src.id;
      t.frames.splice(insertAt, 0, clone);
    }
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

  function deleteFrame() {
    if (isPlaying) pause();
    if (isSubTrackMode()) {
      syncFrameRef();
      const t = AppState.tracks[AppState.activeTrackId];
      const target = getFrameTrackObject(null, AppState.currentFrameIndex);
      if (!t) return;
      if (AppState.currentFrameIndex < 0 || AppState.currentFrameIndex >= t.frames.length) return;
      t.frames.splice(AppState.currentFrameIndex, 1);
      if (t.frames.length === 0) t.frames.push(null);
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
    if (AppState.frames.length <= 1) { alert('至少保留一帧'); return; }
    AppState.frames.splice(AppState.currentFrameIndex, 1);
    for (const id in AppState.tracks) {
      const t = AppState.tracks[id];
      if (!t || !t.frames) continue;
      if (AppState.currentFrameIndex < t.frames.length) t.frames.splice(AppState.currentFrameIndex, 1);
    }
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
    EventBus.emit('history:save', '删除帧');
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
    document.getElementById('btnPlay').textContent = '⏸ 暂停';
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
    document.getElementById('btnPlay').textContent = '▶ 播放';
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
  let elastic1Params = { damping: 0.6, period: 0.8 };
  let elastic2Params = { period: 0.5, skew: 0 };



  function updateTweenEaseLabel() {
    let label;
    if (tweenEaseKey && tweenEaseKey.startsWith('preset:')) {
      const id = tweenEaseKey.slice(7);
      const p = customEasePresets.find(x => x.id === id);
      label = p ? p.name : '自定义';
    } else if (tweenEaseKey === 'custom') {
      label = '自定义';
    } else if (tweenEaseKey === 'elastic1') {
      label = '阻尼振荡';
    } else if (tweenEaseKey === 'elastic2') {
      label = '周期';
    } else {
      label = (TWEEN_EASE_PRESETS[tweenEaseKey] || TWEEN_EASE_PRESETS.linear).label;
    }
    tweenEaseName.textContent = label;
    tweenEaseBtn.title = '补间设置 · ' + label;
  }

  function renderTweenEaseMenu() {
    const builtins = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'custom'];
    let html = '';
    builtins.forEach(key => {
      const custom = key === 'custom';
      let label, thumbInput;
      
      if (key === 'elastic1') {
        label = '阻尼振荡';
        thumbInput = u => easeElastic1(u, elastic1Params.damping, elastic1Params.period);
      } else if (key === 'elastic2') {
        label = '周期';
        thumbInput = u => easeElastic2(u, elastic2Params.period, elastic2Params.skew);
      } else if (custom) {
        label = '自定义曲线…';
        thumbInput = tweenCustomBezier;
      } else {
        label = TWEEN_EASE_PRESETS[key].label;
        thumbInput = TWEEN_EASE_PRESETS[key].bezier;
      }
      
      const active = tweenEaseKey === key;
      html += (custom ? '<div class="ease-divider"></div>' : '') +
        '<button type="button" class="ease-item' + (active ? ' active' : '') + '" data-ease="' + key + '" role="menuitemradio" aria-checked="' + active + '">' +
          '<svg class="ease-thumb" viewBox="0 0 40 28" aria-hidden="true"><path d="' + easeThumbPath(thumbInput) + '"/></svg>' +
          '<span class="ease-label">' + label + '</span>' +
          '<span class="ease-check">' + (active ? '✓' : '') + '</span>' +
        '</button>';
    });
    if (customEasePresets.length) {
      html += '<div class="ease-divider"></div>';
      customEasePresets.forEach(p => {
        const key = 'preset:' + p.id;
        const active = tweenEaseKey === key;
        html += '<button type="button" class="ease-item' + (active ? ' active' : '') + '" data-ease="' + key + '" role="menuitemradio" aria-checked="' + active + '">' +
          '<svg class="ease-thumb" viewBox="0 0 40 28" aria-hidden="true"><path d="' + easeThumbPath(p.bezier) + '"/></svg>' +
          '<span class="ease-label">' + p.name + '</span>' +
          '<span class="ease-check">' + (active ? '✓' : '') + '</span>' +
        '</button>';
      });
    }
    html += '<div class="ease-divider"></div>' +
      '<button type="button" class="ease-item ease-preset-add" data-action="add-preset" role="menuitem">' +
        '<span class="ease-label">＋ 新建自定义预设…</span>' +
      '</button>';
    tweenEaseMenu.innerHTML = html;
  }
  function setAdvPanelOpen(open) {
    advPanel.hidden = !open;
    advSettingsBtn.classList.toggle('open', open);
    advSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) setEaseMenuOpen(false);
  }
  function setEaseMenuOpen(open) {
    if (open) { renderTweenEaseMenu(); setAdvPanelOpen(false); }
    tweenMoreMenu.hidden = !open;
    tweenEaseBtn.classList.toggle('open', open);
    tweenEaseBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

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
    tweenEaseKey = key;
    updateTweenEaseLabel();
    setEaseMenuOpen(false);
  });
  advSettingsBtn.addEventListener('click', (e) => {
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
      easePresetListInline.innerHTML = '<div class="empty-state">暂无自定义预设</div>';
      return;
    }
    
    easePresetListInline.innerHTML = customEasePresets.map(p => {
      let metaText = '';
      let typeName = '';
      if (p.type === 'elastic1') { 
        metaText = `阻:${p.params.damping.toFixed(2)} 周:${p.params.period.toFixed(2)}`; typeName = '[阻尼]'; 
      } else if (p.type === 'elastic2') { 
        metaText = `周:${p.params.period.toFixed(2)} 偏:${p.params.skew.toFixed(2)}`; typeName = '[周期]'; 
      } else { 
        metaText = p.bezier ? p.bezier.map(v => v.toFixed(2)).join(', ') : ''; typeName = '[贝塞尔]'; 
      }
      
      const isSelected = (p.id === easeEditorSelectedPresetId);
      const bgStyle = isSelected ? 'background: var(--color-primary-soft); outline: 1px solid var(--color-primary);' : '';
      
      return `<div class="ease-preset-item" data-id="${p.id}" style="${bgStyle}">
        <span class="name">${typeName} ${p.name}</span>
        <span class="preset-bezier">${metaText}</span>
        <span class="del" title="删除">✕</span>
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
      easeValueEl.textContent = `阻尼: ${elastic1Params.damping.toFixed(2)} | 周期: ${elastic1Params.period.toFixed(2)}`;
    } else {
      easeValueEl.textContent = `周期: ${elastic2Params.period.toFixed(2)} | 偏斜: ${elastic2Params.skew.toFixed(2)}`;
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
    document.getElementById('easeEditorTitle').textContent = '自定义曲线';
    document.getElementById('easeEditorHint').textContent = '拖动两个控制点调整曲线';
    
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
      hint.textContent = '拖动上方点调阻尼(衰减)，下方点调周期(快慢)';
    } else if (easeEditorMode === 'elastic2') {
      hint.textContent = '下方点控制周期，上方点左右拖动控制波形倾斜';
    } else {
      hint.textContent = '拖动两个控制点调整曲线';
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
    let html = '<option value="">跟随全局</option>';
    ['linear', 'easeIn', 'easeOut', 'easeInOut'].forEach(key => {
      html += '<option value="' + key + '">' + TWEEN_EASE_PRESETS[key].label + '</option>';
    });
    html += '<option value="custom">自定义</option>';
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
      jointEaseList.innerHTML = '<div class="empty-state">当前两帧之间没有检测到分部变化。<br>请先制作两个不同姿势/位置的关键帧。</div>';
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
        });
        row.appendChild(label);
        row.appendChild(select);
        jointEaseList.appendChild(row);
      });
    }
    jointEaseOverlay.hidden = false;
  }
  function closeJointEasePanel() { jointEaseOverlay.hidden = true; }
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
    if (cnt) cnt.textContent = has ? multiSelectedFrames.size + ' 帧' : '';
    
    const btnT = document.getElementById('btnMultiTween');
    if (btnT) btnT.disabled = multiSelectedFrames.size < 2;

    // ==== 联动修改其他面板的按钮文字 ====
    const isMulti = multiSelectMode;
    
    // 1. 动画面板的删除帧
    const delBtn = document.getElementById('btnDelFrame');
    if (delBtn) {
      delBtn.textContent = isMulti ? '🗑 删除多选帧' : '🗑 删除帧';
      delBtn.title = isMulti ? '删除所有勾选的帧' : '删除当前帧';
    }

    // 2. 控制面板的导出 PNG / JPG
    const pngBtn = document.getElementById('btnExportPNG');
    if (pngBtn) pngBtn.textContent = isMulti ? '导出多选帧PNG' : '导出PNG';
    const jpgBtn = document.getElementById('btnExportJPG');
    if (jpgBtn) jpgBtn.textContent = isMulti ? '导出多选帧JPG' : '导出JPG';

    // 3. 高级设置的 GIF / PNG序列
    const gifBtn = document.getElementById('btnExportGIF');
    if (gifBtn) gifBtn.textContent = isMulti ? '导出多选帧GIF' : '导出 GIF';
    const seqBtn = document.getElementById('btnExportPNGSeq');
    if (seqBtn) seqBtn.textContent = isMulti ? '导出多选帧PNG序列' : '导出 PNG序列';

    // 4. 全局属性修改标签
    const geBtn = document.querySelector('.adv-toggle[data-toggle="globalEdit"]');
    if (geBtn) geBtn.textContent = isMulti ? '多选帧全局属性修改' : '全局属性修改';
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
          if (o1.joint && o1.joint.color && o2.joint && o2.joint.color) obj.joint.color = lerpColor(o1.joint.color, o2.joint.color, tt);
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
      if (t.frames.length - multiSelectedFrames.size < 1) { alert('至少保留一帧'); return; }
      const indices = Array.from(multiSelectedFrames).sort((a, b) => b - a);
      indices.forEach(i => { if (i >= 0 && i < t.frames.length) t.frames.splice(i, 1); });
      if (t.frames.length === 0) t.frames.push(null);
      multiSelectedFrames.clear();
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
    if (AppState.frames.length - multiSelectedFrames.size < 1) { alert('至少保留一帧'); return; }
    const indices = Array.from(multiSelectedFrames).sort((a, b) => b - a);
    indices.forEach(i => {
      if (i < 0 || i >= AppState.frames.length) return;
      AppState.frames.splice(i, 1);
      for (const id in AppState.tracks) {
        const t = AppState.tracks[id];
        if (t && t.frames && i < t.frames.length) t.frames.splice(i, 1);
      }
    });
    multiSelectedFrames.clear();
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
    if (count < 1 || count > 60) { alert('补间帧数需在 1-60 之间'); return; }
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
      if (subMode) alert('所选相邻帧中，没有两端对该元件都非空白的帧对，无法补间。');
      else alert('请选择相邻的帧（例如 1、2、3），才能在这些相邻帧之间补间。');
      return;
    }
    syncMainLengthFromTracks();
    multiSelectedFrames.clear();
    invalidateAllFrameThumbs();
    AppState.objects = getCombinedObjectsForRender();
    if (subMode) AppState.selected = getActiveTrackObject();
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '批量补间');
    alert(`已在 ${pairs} 对相邻帧之间生成补间帧。`);
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
  if (btnMultiTween) btnMultiTween.onclick = tweenSelectedFrames;

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
    return { ok: true };
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

  /* ==================== 单对补间执行 ==================== */
  document.getElementById('btnTween').onclick = () => {
    if (AppState.frames.length < 2) { alert('至少需要两帧才能补间'); return; }
    const subMode = isSubTrackMode();
    if (!subMode && AppState.currentFrameIndex >= AppState.frames.length - 1) { alert('当前是最后一帧，无法向后补间'); return; }
    const count = parseInt(document.getElementById('tweenCount').value) || 5;
    if (count < 1 || count > 60) { alert('补间帧数需在 1-60 之间'); return; }
    if (isPlaying) pause();
    syncFrameRef();
    const res = insertTweenFrames(AppState.currentFrameIndex, count);
    if (!res.ok) {
      if (res.reason === 'no-current') { alert('当前帧对当前轨道是空白帧，无法补间'); return; }
      if (res.reason === 'no-target') { alert('当前帧之后没有该元件的下一个关键帧，无法补间'); return; }
      alert('当前是最后一帧，无法向后补间');
      return;
    }
    if (subMode) AppState.selected = getActiveTrackObject();
    AppState.objects = getCombinedObjectsForRender();
    invalidateAllFrameThumbs();
    updateFrameBar();
    EventBus.emit('need:render'); EventBus.emit('need:syncUI');
    EventBus.emit('history:save', '生成补间帧');
    alert(subMode ? `已在当前帧和下一个关键帧之间生成 ${count} 个补间帧` : `已在当前帧和下一帧之间生成 ${count} 个补间帧`);
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
          const src = getFrameTrackObject(null, idx);
          const c = src ? cloneObjectKeepImg(src) : null;
          if (c && src) c.id = src.id;
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
      invalidateAllFrameThumbs();
      updateFrameBar();
      EventBus.emit('need:render'); EventBus.emit('need:syncUI');
      EventBus.emit('history:save', '复制帧');
      return;
    }
    if (subMode) {
      const t = ensureTrack(AppState.activeTrackId, (AppState.selected && AppState.selected.name) || AppState.activeTrackId);
      const srcObj = getFrameTrackObject(null, AppState.currentFrameIndex);
      const clone = srcObj ? cloneObjectKeepImg(srcObj) : null;
      if (clone && srcObj) clone.id = srcObj.id;
      const nextIdx = AppState.currentFrameIndex + 1;
      if (nextIdx < t.frames.length && t.frames[nextIdx] == null) {
        /* 下一帧对当前轨道是空白帧：直接占用该槽位，不把后面的帧挤开 */
        t.frames[nextIdx] = clone;
      } else {
        while (t.frames.length < nextIdx) t.frames.push(null);
        t.frames.splice(nextIdx, 0, clone);
      }
      AppState.currentFrameIndex = nextIdx;
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
      const clone = src ? cloneObjectKeepImg(src) : null;
      if (clone && src) clone.id = src.id;
      t.frames.splice(insertAt, 0, clone);
    }
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

  function computeContentBounds(list) {
    list = list || AppState.objects;
    const prevList = _renderList;
    _renderList = list;
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
    const objList = getObjectsForFrameAt(safeIdx, safeTid);
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
      const c = bboxToCrop(computeContentBounds(objList), outW, outH, 1.15);
      scale = c.scale; cx = c.cx; cy = c.cy;
    }
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
      renderScene(objList, { isExporting: true });
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
    if (sh && uiPanel) uiPanel.style.setProperty('--sticky-header-h', sh.offsetHeight + 'px');
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

  /* 点击更多设置按钮后：仅当 chips 已处于悬浮状态时，
     才把 #ui 平滑滚动到让该信息栏刚好出现在 chips 悬浮层下方；
     chips 仍按文档流显示（未悬浮）时不动，由用户自行滚动。 */
     function maybeScrollToActiveToolPanel() {
    if (!activeTool || !uiPanel) return;
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
    const isStuck = chipsRect.top <= stickyViewportTop + 2;
    if (!isStuck) return; /* 按钮还在文档流里 → 不滚动 */

    /* 目标：让 panel 顶部刚好落在 chips 悬浮层底部下方 8px */
    const panelRect = panel.getBoundingClientRect();
    const desiredTop = uiRect.top + headerH + chipsH - 1 + 8;
    const delta = panelRect.top - desiredTop;
    uiPanel.scrollTo({ top: Math.max(0, uiPanel.scrollTop + delta), behavior: 'smooth' });
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

  btnGroundShadow.onclick = () => {
    groundShadowEnabled = !groundShadowEnabled;
    btnGroundShadow.classList.toggle('on', groundShadowEnabled);
    btnGroundShadow.textContent = groundShadowEnabled ? '关闭地面阴影' : '开启地面阴影';
    shadowEditMode = activeTool === 'glow';
    EventBus.emit('need:render');
    EventBus.emit('history:save', '切换地面阴影');
  };

  shadowColorInput.addEventListener('input', e => { shadowColor = e.target.value; EventBus.emit('need:render'); });
  shadowAlphaInput.addEventListener('input', e => { shadowAlpha = +e.target.value; shadowAlphaVal.textContent = shadowAlpha.toFixed(2); EventBus.emit('need:render'); });
  shadowColorInput.addEventListener('change', () => EventBus.emit('history:save', '修改阴影颜色'));
  shadowAlphaInput.addEventListener('change', () => EventBus.emit('history:save', '修改阴影透明度'));

  shadowScaleXInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.shadowScaleX = +e.target.value;
      shadowScaleXVal.textContent = AppState.selected.shadowScaleX.toFixed(2);
      setGlobalProp(AppState.selected, 'shadowScaleX', AppState.selected.shadowScaleX);
      EventBus.emit('need:render');
    }
  });
  shadowScaleXInput.addEventListener('change', () => EventBus.emit('history:save', '调整阴影宽度'));

  shadowScaleYInput.addEventListener('input', e => {
    if (AppState.selected && AppState.selected.type === 'figure') {
      AppState.selected.shadowScaleY = +e.target.value;
      shadowScaleYVal.textContent = AppState.selected.shadowScaleY.toFixed(2);
      setGlobalProp(AppState.selected, 'shadowScaleY', AppState.selected.shadowScaleY);
      EventBus.emit('need:render');
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
    btnGroundLine.textContent = groundLineEnabled ? '关闭地面参考线' : '开启地面参考线';
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
      btnToggleCanvasBounds.textContent = AppState.canvasBoundsEnabled ? '关闭画布边界' : '开启画布边界';
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
      : '请先开启画布边界';
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
    btnToggleCanvasBounds.textContent = AppState.canvasBoundsEnabled ? '关闭画布边界' : '开启画布边界';
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
      if (!AppState.canvasBoundsEnabled) { alert('请先开启画布边界'); return; }

      // ① 用 getComputedStyle 判断可见性（能识别 CSS display:none 的初始状态）
      const timelineVisible = getComputedStyle(timelineEl).display !== 'none';
      const uiRect = uiPanel.getBoundingClientRect();
      const timelineRect = timelineEl.getBoundingClientRect();

      let availLeft = 0, availRight = window.innerWidth;
      let availTop = 0, availBottom = window.innerHeight;

      // ② 左侧 / 底部 UI 面板占位
      if (isMobile) {
        if (!uiPanel.classList.contains('hidden')) {
          availBottom = Math.min(availBottom, uiRect.top);
        }
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
      AppState.viewScale = Math.max(0.1, Math.min(5, newScale));

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
    btnPinView.textContent = viewPinned ? '📌 已固定' : '📌 固定';
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
      lwInput.value = AppState.selected.lw; lwVal.textContent = AppState.selected.lw;
      lightColorInput.value = AppState.selected.light.color;
      lightSizeInput.value = AppState.selected.light.size; lightSizeVal.textContent = AppState.selected.light.size.toFixed(1);
      lightAngleInput.value = AppState.selected.light.angle; lightAngleVal.textContent = AppState.selected.light.angle + '°';
      btnLight.textContent = AppState.selected.light.enabled ? '关闭侧面高光' : '开启侧面高光';
      btnLight.classList.toggle('on', AppState.selected.light.enabled);
      btnExtremity.textContent = AppState.selected.extremity.enabled ? '关闭小手小脚' : '开启小手小脚';
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
      btnHeadFill.textContent = AppState.selected.headFilled ? '头部实心' : '头部空心';
      btnHeadFill.classList.toggle('on', AppState.selected.headFilled);
      if (headFillCustomCheckbox) headFillCustomCheckbox.checked = !!AppState.selected.headFillCustom;
      if (headFillColorInput) headFillColorInput.value = AppState.selected.headFillColor || '#111111';
      
      const headIndepCb = document.getElementById('headIndep');
      if (headIndepCb) headIndepCb.checked = headHandleOn;
      updateHeadMoveHandle();
      glowColor.value = AppState.selected.glow.color;
      glowAlpha.value = AppState.selected.glow.alpha; glowAlphaVal.textContent = AppState.selected.glow.alpha.toFixed(2);
      glowBlur.value = AppState.selected.glow.blur; glowBlurVal.textContent = AppState.selected.glow.blur;
      btnGlow.textContent = AppState.selected.glow.enabled ? '关闭发光' : '开启发光';
      btnGlow.classList.toggle('on', AppState.selected.glow.enabled);
      jointColor.value = AppState.selected.joint.color;
      jointLen.value = AppState.selected.joint.len; jointLenVal.textContent = AppState.selected.joint.len.toFixed(2);
      btnJoint.textContent = AppState.selected.joint.enabled ? '关闭渐变' : '开启渐变';
      btnJoint.classList.toggle('on', AppState.selected.joint.enabled);
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
        e.target.closest('#btnShowTimeline') || e.target.closest('#historyControls')) return;

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

    const hitObjects = subTrackMode ? [subTrackObj] : AppState.objects;
    for (let i = hitObjects.length - 1; i >= 0; i--) {
      const o = hitObjects[i];
      if (!o || o.locked) continue;

      if (o.type === 'figure') {
        /* v5.5.0：变形状态下，指针要先逆映射回源态，才能和「源态关节坐标」比较。
           未变形时 distortInvWorld 原样返回，等于没有这段。 */
        const pSrc = distortInvWorld(o, p);
        const pLocal = (o.rot || o.mirror) ? worldToFigureLocal(o, pSrc) : pSrc;
        if (groundShadowEnabled && shadowEditMode && o === AppState.selected) {
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
                alert('该肢体正在被 IK（关节固定）保护，无法拉伸。\n请先在「关节」面板中解除固定。');
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
      drag.o.x = drag.camX + wx;
      drag.o.y = drag.camY + wy;
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
            if (globalEditEnabled) {
              setGlobalProp(camViewObj, 'scale', newScale);
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
        let newScale = Math.min(5, Math.max(0.2, AppState.viewScale * zoomFactor));
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
      alert('当前元件存在关节固定，请先在「关节」面板中解除所有帧的固定，才能整体位移。');
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
    btnSnapToggle.title = snapEnabled ? '关闭吸附' : '开启吸附';
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
    if (AppState.selected.type === 'camera') { alert('摄像机只能存在一个。'); return; }
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
    if (AppState.selected.type === 'video') return;
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
    for (const tid in AppState.tracks) {
      const t = AppState.tracks[tid];
      if (!t || !t.frames) { delete AppState.tracks[tid]; continue; }
      if (t.frames.every(d => d == null)) {
        delete AppState.tracks[tid];
        if (AppState.activeTrackId === tid) AppState.activeTrackId = TRACK_ALL_ID;
      }
    }
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
      AppState.selected.a = makeFigure(0, 0).a;
      AppState.selected.bodyScale = { head: 1.83, arm: 1.06, leg: 1.16, torso: 0.62, foreArm: 0.37, shin: 0.49 };
      AppState.selected.scale = 1.67;
      AppState.selected.rot = 0;
      AppState.selected.mirror = false;
      AppState.selected.headFilled = false;
      AppState.selected.headFillCustom = false;
      AppState.selected.headFillColor = '#111111';
      AppState.selected.headAngle = -Math.PI / 2;
      AppState.selected.headOffset = { x: 0, y: 0 };
      AppState.selected.headOffset = { x: 0, y: 0 };
      AppState.selected.shadowOffX = 0; AppState.selected.shadowOffY = 0;
      AppState.selected.shadowScaleX = 1; AppState.selected.shadowScaleY = 1;
      AppState.selected.light = { enabled: false, color: '#ffbb66', size: 1.0, angle: 315 };
      AppState.selected.glow = { enabled: false, color: '#ff9d3d', alpha: 0.8, blur: 18 };
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
      if (dir === 'up') AppState.selected.layer += 1;
      else if (dir === 'down') AppState.selected.layer -= 1;
      else if (dir === 'top') AppState.selected.layer = 9999;
      else if (dir === 'bottom') AppState.selected.layer = -9999;
      EventBus.emit('need:render'); markCurrentFrameModified(); EventBus.emit('history:save', '调整图层'); return;
    }
    const isFig = AppState.selected.type === 'figure';
    let allLayers = [];
    AppState.objects.forEach(o => {
      if (o.type === 'figure') Object.values(o.layer).forEach(v => allLayers.push(v));
      else allLayers.push(o.layer);
    });
    const minLayer = Math.min(...allLayers);
    const maxLayer = Math.max(...allLayers);
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
      if (isFig) Object.keys(AppState.selected.layer).forEach(k => { AppState.selected.layer[k] = minLayer - 1; setGlobalProp(AppState.selected, `layer.${k}`, AppState.selected.layer[k]); });
      else { AppState.selected.layer = -99999; setGlobalProp(AppState.selected, 'layer', AppState.selected.layer); }
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
          setGlobalProp(camViewObj, 'scale', newScale);
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
    let newScale = Math.min(5, Math.max(0.2, AppState.viewScale * zoomFactor));
    if (viewPinned && pinnedView) {
      newScale = Math.max(newScale, pinnedView.scale);
    }
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    if (viewPinned && pinnedView && newScale <= pinnedView.scale + 0.0001) {
      AppState.viewScale = pinnedView.scale;
      AppState.viewOffset.x = pinnedView.offset.x;
      AppState.viewOffset.y = pinnedView.offset.y;
    } else {
      const actualZoom = newScale / AppState.viewScale;
      AppState.viewOffset.x = mouseX - (mouseX - AppState.viewOffset.x) * actualZoom;
      AppState.viewOffset.y = mouseY - (mouseY - AppState.viewOffset.y) * actualZoom;
      AppState.viewScale = newScale;
    }
    EventBus.emit('need:render');
  }, { passive: false });

  document.getElementById('btnNew').onclick = addFigure;
  document.getElementById('btnBubble').onclick = addBubble;
  document.getElementById('btnShapeCircle').onclick = () => addShape('circle');
  document.getElementById('btnShapeRect').onclick = () => addShape('rect');
  document.getElementById('btnShapeTri').onclick = () => addShape('tri');
  document.getElementById('btnClone').onclick = cloneSelected;
  document.getElementById('btnDelete').onclick = deleteSelected;
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
        alert('请先在画布中选中一个图片或配饰，再进行替换。');
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
    currentLW = +e.target.value; lwVal.textContent = currentLW;
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
    AppState.selected.glow.enabled = !AppState.selected.glow.enabled;
    setGlobalProp(AppState.selected, 'glow.enabled', AppState.selected.glow.enabled);
    EventBus.emit('need:syncUI'); EventBus.emit('need:render'); markCurrentFrameModified();
    EventBus.emit('history:save', '切换发光');
  };
  glowColor.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.glow.color = e.target.value; setGlobalProp(AppState.selected, 'glow.color', AppState.selected.glow.color); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  glowAlpha.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.glow.alpha = +e.target.value; glowAlphaVal.textContent = AppState.selected.glow.alpha.toFixed(2); setGlobalProp(AppState.selected, 'glow.alpha', AppState.selected.glow.alpha); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  glowBlur.addEventListener('input', e => { if (AppState.selected && AppState.selected.type === 'figure') { AppState.selected.glow.blur = +e.target.value; glowBlurVal.textContent = AppState.selected.glow.blur; setGlobalProp(AppState.selected, 'glow.blur', AppState.selected.glow.blur); EventBus.emit('need:render'); markCurrentFrameModified(); } });
  [glowColor, glowAlpha, glowBlur].forEach(el => el.addEventListener('change', () => EventBus.emit('history:save', '修改发光')));

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
      alert('当前只有一帧，无需清空。');
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
      alert('导出失败：' + err.message);
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
          alert('iOS 已在新标签页打开图片，\n长按图片即可"存储到照片"。');
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

    // 【修复】不论是否开启了自由缩放，桌面端顶部停靠时先把 UI 面板往下推，否则会被时间轴压住
    if (!isMobile && ui) {
      const baseTop = 14;
      ui.style.top = (baseTop + (timelineDock === 'top' ? h : 0)) + 'px';
      // 高度计算也加上时间轴的高度
      ui.style.maxHeight = 'calc(100vh - ' + (baseTop + (timelineDock === 'top' ? h : 0) + 100) + 'px)';
    }

    if (uiResizable) return; // 防冲突：自由缩放的其余逻辑不需要重复执行

    // 移动端底部抽屉
    if (isMobile) {
      const expand = document.getElementById('btnMobileExpand');
      const isUiHidden = ui && ui.classList.contains('hidden');
      
      let bottomOffset = 0;
      if (timelineDock === 'bottom' && visible) {
        bottomOffset = h;
      }

      if (ui) {
        ui.style.bottom = (isUiHidden ? 0 : bottomOffset) + 'px';
        if (!isUiHidden) {
          if (!uiPanelDragged) {
            ui.style.top = 'auto';
            ui.style.maxHeight = '70vh';
          } else {
            const topPx = parseFloat(ui.style.top) || 60;
            ui.style.maxHeight = Math.max(120, window.innerHeight - topPx - bottomOffset) + 'px';
          }
        }
      }
      
      if (expand) {
        expand.style.bottom = (isUiHidden ? 0 : bottomOffset + 64 + 8) + 'px';
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
    if (hideBtn) hideBtn.textContent = (timelineDock === 'top') ? '收起 ▲' : '收起 ▼';
    const dockBtn = document.getElementById('btnTimelineDock');
    if (dockBtn) dockBtn.textContent = (timelineDock === 'top') ? '⇩ 置底' : '⇧ 置顶';
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
    showToast: (msg) => showHistoryToast(msg),
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

    EventBus.on('history:save', (label) => {
      saveHistory(label);
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
      const f = makeFigure(0, 0, '#111111', 11);
      f.lw = 11;
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
    applyTranslations();
    if (typeof window.SKFE_REFRESH_I18N === 'function') window.SKFE_REFRESH_I18N();
    saveHistory('初始化');
  })();
})();
