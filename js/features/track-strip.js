/*! SKFE 轨道模式 v7.4.0
 *  ---------------------------------------------------------------------------
 *  在动画面板左侧点「轨道」切换：每个元件一条长条，条 = 该元件从出场到退场的连续帧。
 *  拖两端 = 伸缩；拖中间 = 整体平移；点眼睛 = 全帧隐藏；点刻度/空白 = 跳帧。
 *
 *  三条硬约束（改这个文件前先读）：
 *   1. 本模块只读 AppState.tracks，不改 #frameBar / updateFrameBar 的任何行为。
 *   2. 关键帧模型里「任意相邻两个关键帧自动成段，段内空槽一律被派生帧填满」——
 *      所以直接往段内写 null 是无效的，会被 reconcileTrack 重新填满。
 *      「元件不出场」只有两种合法表达：段外的 null，或段起点关键帧的 hidden（D6 hold）。
 *      切割就是后者：在播放头处打一个 hidden 关键帧。
 *   3. 一次拖拽只在 pointerup 时写一次数据 + 一条撤销；拖动过程中只动 DOM。
 *  ------------------------------------------------------------------------- */
(function () {
  'use strict';
  const root = window;
  root.SKFE = root.SKFE || {};
  root.SKFE.features = root.SKFE.features || {};

  const COLW_KEY = 'skfe_track_colw_v1';
  const HEIGHT_KEY = 'skfe_track_h_v1';
  const MODE_KEY = 'skfe_track_mode_v1';

  const GUTTER = 108;      /* 左列宽（眼睛 + 元件名），sticky 不随横向滚动 */
  const ROW_H = 32;        /* 每条轨道高度（条 22 + 上留 2 + 下留 8 放关键帧点） */
  const RULER_H = 22;      /* 顶部刻度尺高度 */
  const HANDLE_W = 10;     /* 两端手柄的命中宽度 */
  const MIN_H = 160;       /* 面板最小高度 */
  const MAX_FRAMES = 600;  /* 拖拽时允许撑长的上限，防止误拖出几万帧 */

  let api = null;
  let enabled = false;
  let colW = 26;
  let panelH = 240;        /* 面板高度默认值：约 4~5 条轨道，能在屏幕上留出画布 */
  let drag = null;
  let lastPickedId = null;   /* 最近点过的轨道：切帧会把 AppState.selected 清空，切割要靠它兜底 */
  let lastSig = '';          /* 上次渲染时的数据指纹，用来跳过无变化的重画 */
  let refreshQueued = false;

  const $ = (id) => document.getElementById(id);

  function T(key, fallback) {
    if (typeof window.t !== 'function') return fallback;
    const v = window.t(key);
    return (v == null || v === key) ? fallback : v;
  }
  function KF() { return root.SKFE.systems.keyframes; }
  function tracksMap() { return api ? api.tracks() : {}; }
  function totalFrames() { return Math.max(1, api ? api.totalFrames() : 1); }

  /* ---------------- 出场判定 ---------------- */
  /* 某一帧这个元件在不在：键帧/普通帧看自身，派生帧和段内空槽都看「段起点那一帧」的 hidden。
     和 KF.locate 的分段规则严格对齐，不自己另发明一套。 */
  function presentAt(arr, segs, i) {
    const slot = arr[i];
    const inSeg = segContaining(segs, i);
    if (slot == null || KF().isDerived(slot)) {
      if (!inSeg) return false;
      const head = arr[inSeg.a];
      return !(head && head.hidden);
    }
    return !slot.hidden;
  }

  function segContaining(segs, i) {
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (i >= s.a && i <= s.b) return s;
    }
    return null;
  }

  /* 连续的「在场」帧合并成一条长条 */
  function computeSpans(arr) {
    const segs = KF().segments(arr);
    const n = Math.max(totalFrames(), arr.length);
    const out = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      if (presentAt(arr, segs, i)) {
        if (cur) cur.b = i; else cur = { a: i, b: i };
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------------- 渲染 ---------------- */
  /* 数据指纹：轨道数、帧数、每帧的槽位身份与显隐。
     比整块重画便宜得多，用来避免「滑条一动就重建上千个 DOM」。 */
  function signature() {
    const map = tracksMap();
    let s = totalFrames() + '#' + (colW + '') + '#';
    for (const id in map) {
      const arr = (map[id] && map[id].frames) || [];
      s += id + ':' + arr.length + ':' + (map[id].name || '') + ':';
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (slot == null) s += '.';
        else if (KF().isDerived(slot)) s += 'd';
        else s += (KF().isKey(slot) ? 'k' : 'p') + (slot.hidden ? 'h' : '');
      }
      s += ';';
    }
    return s;
  }

  function render() {
    const wrap = $('trackStrip');
    const cv = $('tsCanvas');
    if (!wrap || !cv) return;
    lastSig = signature();

    const map = tracksMap();
    const ids = Object.keys(map).filter(id => map[id] && map[id].frames);
    const total = Math.max(totalFrames(), 1);
    const width = total * colW;
    const rowsH = Math.max(ids.length, 1) * ROW_H;
    cv.style.width = (GUTTER + width) + 'px';
    cv.style.height = (RULER_H + rowsH) + 'px';
    cv.style.setProperty('--cw', colW + 'px');

    if (!ids.length) {
      cv.innerHTML = '<div class="ts-empty">' + T('track.empty', '还没有元件。先在画布上添加一个元件，它的轨道就会出现在这里。') + '</div>';
      return;
    }

    const cur = api.currentFrame();
    let html = '';

    /* 刻度尺 */
    html += '<div class="ts-row ts-ruler-row">';
    html += '<div class="ts-gutter ts-gutter-head"><span>' + T('track.gutterHead', '元件') + '</span></div>';
    html += '<div class="ts-lane ts-ruler" style="width:' + width + 'px">';
    const step = colW >= 22 ? 1 : (colW >= 12 ? 5 : 10);
    for (let i = 0; i < total; i += step) {
      html += '<span class="ts-tick" style="left:' + (i * colW) + 'px">' + (i + 1) + '</span>';
    }
    html += '</div></div>';

    /* 每个元件一行 */
    ids.forEach((id) => {
      const t = map[id];
      const arr = t.frames;
      const spans = computeSpans(arr);
      /* 眼睛状态看「这条轨上有没有 hidden 数据」，不能看第一段 —— 全隐藏时一段都没有 */
      const hidden = arr.some(x => x && x.hidden);
      const name = t.name || id;

      html += '<div class="ts-row' + (String(id) === String(lastPickedId) ? ' ts-row-sel' : '') + '" data-id="' + esc(id) + '">';
      html += '<div class="ts-gutter">';
      html += '<button class="ts-eye' + (hidden ? ' off' : '') + '" type="button" data-eye="' + esc(id) + '" title="' +
        (hidden ? T('track.show', '点击显示（全帧生效）') : T('track.hide', '点击隐藏（全帧生效）')) + '">' +
        '<i data-icon="' + (hidden ? 'forbid' : 'preview-open') + '"></i></button>';
      html += '<span class="ts-name" title="' + esc(name) + '">' + esc(name) + '</span>';
      html += '</div>';
      html += '<div class="ts-lane" style="width:' + width + 'px">';
      spans.forEach((s, si) => {
        const left = s.a * colW;
        const w = Math.max(colW, (s.b - s.a + 1) * colW);
        const label = (s.a + 1) + (s.b > s.a ? '–' + (s.b + 1) : '');
        html += '<div class="ts-clip" data-id="' + esc(id) + '" data-si="' + si + '" data-a="' + s.a + '" data-b="' + s.b + '"' +
          ' style="left:' + left + 'px;width:' + w + 'px">' +
          '<i class="ts-h ts-h-l"></i><span class="ts-lab">' + label + '</span><i class="ts-h ts-h-r"></i></div>';
      });
      /* 关键帧圆点 */
      for (let i = 0; i < arr.length; i++) {
        if (!KF().isKey(arr[i])) continue;
        html += '<i class="ts-key" style="left:' + (i * colW + colW / 2) + 'px"></i>';
      }
      html += '</div></div>';
    });

    /* 播放头（放在内容层里，跟着横向滚动走） */
    html += '<div class="ts-playhead" style="left:' + (GUTTER + cur * colW) + 'px;height:' + (RULER_H + rowsH) + 'px"></div>';

    cv.innerHTML = html;
    if (root.SKFEApplyIcons) root.SKFEApplyIcons(cv);
    scrollPlayheadIntoView();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* 高亮「最近点过的那一行」，不重画整块（拖拽/点选时用，避免抖动） */
  function markRow(id) {
    const cv = $('tsCanvas');
    if (!cv) return;
    const rows = cv.querySelectorAll('.ts-row[data-id]');
    rows.forEach((r) => {
      if (String(r.dataset.id) === String(id)) r.classList.add('ts-row-sel');
      else r.classList.remove('ts-row-sel');
    });
  }

  /* 播放头跑出可视区时把滚动带过去 */
  function scrollPlayheadIntoView() {
    const sc = $('tsScroll');
    if (!sc || !enabled) return;
    const x = api.currentFrame() * colW;
    const viewL = sc.scrollLeft;
    const viewR = viewL + sc.clientWidth - GUTTER;
    if (x < viewL) sc.scrollLeft = Math.max(0, x - colW * 2);
    else if (x > viewR - colW) sc.scrollLeft = x - (sc.clientWidth - GUTTER) + colW * 3;
  }

  function syncPlayhead() {
    const ph = document.querySelector('#tsCanvas .ts-playhead');
    if (!ph) return;
    ph.style.left = (GUTTER + api.currentFrame() * colW) + 'px';
  }

  /* ---------------- 拖拽写回 ---------------- */

  function ensureLen(arr, n) { while (arr.length < n) arr.push(null); }

  function cloneAt(trackId, i) {
    const o = api.getTrackFrame(trackId, i);
    return o ? api.clone(o) : null;
  }

  /* 把某一帧变成「带同姿态的关键帧」 */
  function keyFrom(arr, i, obj) {
    if (!obj) { arr[i] = null; return null; }
    const c = api.clone(obj);
    KF().markKey(c, 'sub');
    arr[i] = c;
    return c;
  }

  /* 保证某一帧是关键帧（原来只是普通帧就升格，空/派生就按求值结果补一个） */
  function ensureKey(trackId, arr, i) {
    if (i < 0) return;
    ensureLen(arr, i + 1);
    if (KF().isKey(arr[i])) return;
    keyFrom(arr, i, cloneAt(trackId, i));
  }

  function applyDrag(st, d) {
    const map = tracksMap();
    const t = map[st.id];
    if (!t) return;
    const arr = t.frames || (t.frames = []);
    ensureLen(arr, Math.max(totalFrames(), arr.length));

    if (st.mode === 'm') {
      /* 平移：把整段求值后的快照搬走，原区间清空 */
      const data = [];
      for (let i = st.a; i <= st.b; i++) data.push(cloneAt(st.id, i));
      const na = st.a + d, nb = st.b + d;
      for (let i = st.a; i <= st.b; i++) arr[i] = null;
      ensureLen(arr, nb + 1);
      for (let k = 0; k <= nb - na; k++) {
        const o = data[k];
        arr[na + k] = o ? api.clone(o) : null;
      }
      ensureKey(st.id, arr, na);
      ensureKey(st.id, arr, nb);
    } else if (st.mode === 'r') {
      const b = st.b, nb = b + d;
      ensureLen(arr, Math.max(b, nb) + 1);
      if (nb > b) {
        /* 拉长：末端补一个同姿态关键帧，中间交给段插值 → 静止保持 */
        const src = cloneAt(st.id, b);
        for (let i = b + 1; i <= nb; i++) arr[i] = null;
        keyFrom(arr, nb, src);
        ensureKey(st.id, arr, b);
      } else if (nb < b) {
        /* 缩短：新末端同姿态落一个关键帧，后面全部清空 */
        const src = cloneAt(st.id, nb);
        keyFrom(arr, nb, src);
        for (let i = nb + 1; i <= b; i++) arr[i] = null;
        ensureKey(st.id, arr, st.a);
      }
    } else {
      const a = st.a, na = a + d;
      ensureLen(arr, Math.max(a, na) + 1);
      if (na < a) {
        /* 拉起：头部补一个同姿态关键帧 */
        const src = cloneAt(st.id, a);
        for (let i = na; i < a; i++) arr[i] = null;
        keyFrom(arr, na, src);
        ensureKey(st.id, arr, a);
      } else if (na > a) {
        const src = cloneAt(st.id, na);
        keyFrom(arr, na, src);
        for (let i = a; i < na; i++) arr[i] = null;
        ensureKey(st.id, arr, st.b);
      }
    }

    /* 段内空槽归位、段外悬空派生退回空白 —— 让数据回到模型认可的状态 */
    KF().reconcileTrack(t);
    api.afterChange();
  }

  /* 切割：在播放头处打一个 hidden 关键帧，让条从该帧断开 */
  function cut() {
    /* 切帧会把 AppState.selected 清空，所以取不到目标时用「最近点过的轨道」兜底 */
    const id = api.targetTrackId() || lastPickedId;
    if (!id) { api.toast(T('track.needPick', '先在轨道上点一条长条，选中要切割的元件')); return; }
    const map = tracksMap();
    const t = map[id];
    if (!t || !t.frames) { api.toast(T('track.needPick', '先在轨道上点一条长条，选中要切割的元件')); return; }
    const arr = t.frames;
    const i = api.currentFrame();
    const on = computeSpans(arr).some(s => i >= s.a && i <= s.b);
    if (!on) { api.toast(T('track.cutEmpty', '播放头这一帧这个元件本来就不在场')); return; }

    const pre = api.snapshot();
    const src = cloneAt(id, i);
    if (!src) return;
    src.hidden = true;
    KF().markKey(src, 'sub');
    ensureLen(arr, i + 1);
    arr[i] = src;
    KF().reconcileTrack(t);
    api.pushPre(pre, T('track.cutLabel', '切割轨道'));
    api.afterChange();
    render();
    api.toast(T('track.cutDone', '已切开：后面那段可以单独拖走了'));
  }

  /* ---------------- 交互绑定 ---------------- */

  function bindDrag() {
    const cv = $('tsCanvas');
    const sc = $('tsScroll');
    if (!cv || cv.dataset.bound === '1') return;
    cv.dataset.bound = '1';

    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      /* 眼睛 */
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        e.preventDefault();
        lastPickedId = eye.dataset.eye;
        api.toggleHidden(eye.dataset.eye);
        render();   /* 隐藏态只发 need:render，这里自己跟一次，图标和长条才会立刻变 */
        return;
      }

      const clip = e.target.closest('.ts-clip');
      if (clip) {
        const rect = clip.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const mode = dx <= HANDLE_W ? 'l' : (rect.width - dx <= HANDLE_W ? 'r' : 'm');
        lastPickedId = clip.dataset.id;
        markRow(clip.dataset.id);
        drag = {
          id: clip.dataset.id,
          si: +clip.dataset.si,
          a: +clip.dataset.a,
          b: +clip.dataset.b,
          mode,
          startX: e.clientX,
          d: 0,
          el: clip,
          moved: false,
          pre: api.snapshot()
        };
        clip.classList.add('dragging', 'drag-' + mode);
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
        return;
      }

      /* 点空白 / 刻度尺：跳帧 */
      const lane = e.target.closest('.ts-lane');
      if (lane) {
        const lr = lane.getBoundingClientRect();
        const i = Math.floor((e.clientX - lr.left) / colW);
        if (i >= 0 && i < totalFrames()) api.goToFrame(i);
        return;
      }
    });

    cv.addEventListener('pointermove', (e) => {
      if (!drag) {
        /* 光标提示：手柄处显示左右箭头 */
        const clip = e.target.closest('.ts-clip');
        if (clip) {
          const rect = clip.getBoundingClientRect();
          const dx = e.clientX - rect.left;
          clip.style.cursor = (dx <= HANDLE_W || rect.width - dx <= HANDLE_W) ? 'ew-resize' : 'grab';
        }
        return;
      }
      const raw = Math.round((e.clientX - drag.startX) / colW);
      let d = raw;
      if (drag.mode === 'm') {
        d = Math.max(-drag.a, Math.min(MAX_FRAMES - drag.b - 1, d));
      } else if (drag.mode === 'r') {
        d = Math.max(-(drag.b - drag.a), Math.min(MAX_FRAMES - drag.b - 1, d));
      } else {
        d = Math.max(-drag.a, Math.min(drag.b - drag.a, d));
      }
      if (d === drag.d) return;
      drag.d = d;
      drag.moved = d !== 0;

      /* 只动 DOM，不碰数据 */
      const el = drag.el;
      if (drag.mode === 'm') {
        el.style.left = ((drag.a + d) * colW) + 'px';
        el.querySelector('.ts-lab').textContent = (drag.a + d + 1) + '–' + (drag.b + d + 1);
      } else if (drag.mode === 'r') {
        el.style.width = Math.max(colW, (drag.b - drag.a + 1 + d) * colW) + 'px';
        el.querySelector('.ts-lab').textContent = (drag.a + 1) + '–' + (drag.b + d + 1);
      } else {
        el.style.left = ((drag.a + d) * colW) + 'px';
        el.style.width = Math.max(colW, (drag.b - drag.a + 1 - d) * colW) + 'px';
        el.querySelector('.ts-lab').textContent = (drag.a + d + 1) + '–' + (drag.b + 1);
      }
    });

    const finish = (e) => {
      if (!drag) return;
      const st = drag;
      drag = null;
      st.el.classList.remove('dragging', 'drag-l', 'drag-r', 'drag-m');
      if (!st.moved) {
        /* 没拖动 = 点选：只选中这个元件，不切子轨、不动帧号 */
        api.selectTrack(st.id);
        return;
      }
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      applyDrag(st, st.d);
      api.pushPre(st.pre, T('track.dragLabel', '调整轨道'));
      render();
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', finish);

    /* 横向滚动时播放头要留在视野内（滚轮/触摸都由浏览器处理，这里只在滚动后校正） */
    if (sc) sc.addEventListener('scroll', () => { /* 播放头在内容层里，天然跟随 */ }, { passive: true });
  }

  /* 面板高度拖拽 */
  function bindGrip() {
    const grip = $('tlGrip');
    const tl = $('timeline');
    if (!grip || !tl || grip.dataset.bound === '1') return;
    grip.dataset.bound = '1';
    let st = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      st = { y: e.clientY, h: tl.offsetHeight };
      grip.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!st) return;
      const maxH = Math.round(window.innerHeight * 0.72);
      panelH = Math.max(MIN_H, Math.min(maxH, st.h - (e.clientY - st.y)));
      applyHeight();
      api.relayout();
    });
    const up = () => {
      if (!st) return;
      st = null;
      grip.classList.remove('dragging');
      try { localStorage.setItem(HEIGHT_KEY, String(Math.round(panelH))); } catch (_) {}
      api.relayout();
    };
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  function applyHeight() {
    const tl = $('timeline');
    if (!tl) return;
    if (enabled) tl.style.height = Math.round(panelH) + 'px';
    else tl.style.height = '';
  }

  /* ---------------- 模式开关 ---------------- */

  function setEnabled(on) {
    const tl = $('timeline');
    const strip = $('trackStrip');
    const btn = $('btnTrackMode');
    if (!tl || !strip) return;
    enabled = !!on;
    tl.classList.toggle('track-mode', enabled);
    strip.hidden = !enabled;
    if (btn) {
      btn.classList.toggle('active', enabled);
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
    applyHeight();
    if (enabled) render();
    try { localStorage.setItem(MODE_KEY, enabled ? '1' : '0'); } catch (_) {}
    if (api) api.relayout();
  }

  /* ---------------- 对外 ---------------- */

  const TrackStrip = {
    init(a) {
      api = a;
      try {
        const c = parseInt(localStorage.getItem(COLW_KEY) || '', 10);
        if (c >= 10 && c <= 60) colW = c;
        const h = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10);
        if (h >= MIN_H) panelH = h;
      } catch (_) {}

      bindGrip();
      bindDrag();

      /* 完全被动地跟随现有事件总线：不改 app.js 里任何一个函数，
         现有功能该发什么事件照发，这边只是「听到就顺手更新一下自己」。 */
      const bus = root.SKFE.core && root.SKFE.core.eventBus && root.SKFE.core.eventBus.EventBus;
      if (bus) {
        bus.on('need:syncUI', () => TrackStrip.scheduleRefresh());
        bus.on('app:update', () => TrackStrip.scheduleRefresh());
      }

      const btn = $('btnTrackMode');
      if (btn) btn.addEventListener('click', () => setEnabled(!enabled));

      const split = $('btnSplit');
      if (split) split.addEventListener('click', cut);

      /* 恢复上次的模式；手机屏幕矮，默认不给开 */
      let restore = false;
      try { restore = localStorage.getItem(MODE_KEY) === '1'; } catch (_) {}
      if (restore && !a.isMobile()) setEnabled(true);
      else { applyHeight(); }
    },

    render,
    syncPlayhead,

    /* 外部（撤销 / 导入工程 / 恢复快照）之后重画。
       need:syncUI 一类的广播很密（滑条拖动也会发），这里 rAF 去抖 + 数据指纹比对，
       没有真变化就什么都不做，保证「新增功能不拖慢原有功能」。 */
    scheduleRefresh() {
      if (!enabled || refreshQueued) return;
      refreshQueued = true;
      root.requestAnimationFrame(() => {
        refreshQueued = false;
        if (!enabled) return;
        syncPlayhead();
        if (signature() !== lastSig) render();
      });
    },
    /* 强制重画（自己的编辑操作结束后用） */
    refresh() { if (enabled) render(); },
    isEnabled() { return enabled; },
    setEnabled,
    getColW() { return colW; }
  };

  root.SKFE.features.trackStrip = TrackStrip;
})();
