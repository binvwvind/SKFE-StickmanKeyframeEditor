/* ============================================================================
   track-strip.js — 轨道视图（v7.4.x，类 AM / 剪映的多轨时间轴）
   ----------------------------------------------------------------------------
   三条硬约束（改这个文件前先看这三条，否则很容易把工程数据写坏）：

   1. 轨道数据只认 AppState.tracks —— 读用 getTrackFrame / KF.segments，
      写只通过本文件的 takeRange / putRange / vacate，最后必须走 reconcileTrack。
   2. 段规则：任意相邻两个关键帧之间叫一个「段」，段内所有空槽都会被
      reconcileTrack 填成派生帧（= 那一帧元件在场）。所以
        · 让元件「不出场」只有一条合法路子：在某帧落一个 hidden 关键帧，
          它到下一个关键帧之间的派生帧就全部算「不在场」；
        · 拉长/补帧只能用**普通帧**（不带 __k），否则会平白多出关键帧。
   3. 一次拖拽 = 一步撤销：pointerdown 时取快照，pointerup 时 pushPre + saveHistory。

   本文件不修改 updateFrameBar / 帧块 DOM / 拖帧 / 多选 / 补间，只订阅事件总线
   被动刷新（rAF 去抖 + 数据指纹比对），所以不点「轨道」按钮时行为与旧版一致。
   ============================================================================ */
(function () {
  'use strict';

  const root = window;
  root.SKFE = root.SKFE || {};
  root.SKFE.features = root.SKFE.features || {};

  const COLW_KEY = 'skfe_track_colw_v1';
  const HEIGHT_KEY = 'skfe_track_h_v1';
  const MODE_KEY = 'skfe_track_mode_v1';

  const GUTTER = 108;      /* 左列宽（眼睛 + 元件名），sticky 不随横向滚动 */
  const ROW_H = 32;        /* 每条轨道高度 */
  const RULER_H = 22;      /* 顶部刻度尺高度 */
  const HANDLE_W = 10;     /* 两端手柄的命中宽度 */
  const KEY_HIT = 13;      /* 关键帧菱形的命中直径 */
  const MIN_H = 160;       /* 面板最小高度 */
  const MAX_FRAMES = 600;  /* 拖拽时允许撑长的上限，防止误拖出几万帧 */
  const TIME_MIN_CW = 14;  /* 列宽小于它就改用「分:秒」刻度 */
  const COLW_STEPS = [6, 8, 10, 13, 16, 20, 26, 33, 42, 54];

  let api = null;
  let enabled = false;
  let colW = 26;
  let panelH = 240;        /* 面板高度默认值：约 4~5 条轨道，屏幕上还留得出画布 */
  let drag = null;
  let selClip = null;      /* 当前选中的长条 { id, a, b } —— 分割 / 删除都认它 */
  let lastPickedId = null; /* 最近点过的轨道：切帧会把 AppState.selected 清空，靠它兜底 */
  let lastSig = '';        /* 上次渲染时的数据指纹，用来跳过无变化的重画 */
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
  function fps() { const f = api && api.fps ? api.fps() : 12; return (f > 0 ? f : 12); }

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

  /* 分割标记：关键帧的 __k.cut = 1 表示「这一帧起算新的一段长条」。
     ⚠️ 必须挂在 __k 里面，不能直接写成 slot.__cut ——
        keyframes.js 的 cloneForEval 只剥 __k/__d，其余属性会原样带进派生帧，
        段内每一帧都会跟着带上这个标记，于是满屏都是假的分割点。 */
  function isCut(slot) {
    return !!(slot && !KF().isDerived(slot) && slot.__k && slot.__k.cut);
  }
  function setCut(o, on) {
    if (!o || !o.__k) return o;
    if (on) o.__k.cut = 1; else delete o.__k.cut;
    return o;
  }

  /* 连续的「在场」帧合并成一条长条；__cut 处也要断开（分割出来的左右两段） */
  function computeSpans(arr) {
    const segs = KF().segments(arr);
    const n = Math.max(totalFrames(), arr.length);
    const out = [];
    let cur = null;
    for (let i = 0; i < n; i++) {
      const on = presentAt(arr, segs, i);
      const cut = i > 0 && on && isCut(arr[i]);
      if (on) {
        if (cur && !cut) cur.b = i;
        else { if (cur) out.push(cur); cur = { a: i, b: i }; }
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------------- 数据指纹 ---------------- */
  /* 轨道数、帧数、每帧的槽位身份 / 显隐 / 分割标记。
     比整块重画便宜得多，用来避免「滑条一动就重建上千个 DOM」。 */
  function signature() {
    const map = tracksMap();
    /* 缩略图开关 / 图案版本也算进指纹：不然改了动作、切了缩略图，长条上的小图不跟着换 */
    const thumbOn = (api && api.thumbMode && api.thumbMode()) ? 'T' : 't';
    const thumbRev = (api && api.thumbRev) ? api.thumbRev() : 0;
    let s = totalFrames() + '#' + colW + '#' + thumbOn + thumbRev + '#';
    for (const id in map) {
      const arr = (map[id] && map[id].frames) || [];
      s += id + ':' + arr.length + ':' + (map[id].name || '') + ':';
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (slot == null) s += '.';
        else if (KF().isDerived(slot)) s += 'd';
        else s += (KF().isKey(slot) ? 'k' : 'p') + (slot.hidden ? 'h' : '') + ((slot.__k && slot.__k.cut) ? 'c' : '');
      }
      s += ';';
    }
    return s;
  }

  /* ---------------- 刻度 ---------------- */
  function fmtClock(frame) {
    const sec = Math.floor(frame / fps());
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  /* 列宽太小就改成分:秒刻度（和剪映一样，缩到一定程度就不再数帧了） */
  function rulerStep() {
    if (colW < TIME_MIN_CW) {
      const secPx = fps() * colW;                    /* 1 秒占多少像素 */
      const stepSec = secPx >= 56 ? 1 : Math.ceil(56 / secPx);
      return { step: Math.max(1, Math.round(stepSec * fps())), time: true };
    }
    return { step: colW >= 22 ? 1 : (colW >= 12 ? 5 : 10), time: false };
  }

  /* ---------------- 渲染 ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* 高亮「最近点过的那一行」，不重画整块（拖拽/点选时用，避免抖动） */
  function markRow(id) {
    const cv = $('tsCanvas');
    if (!cv) return;
    cv.querySelectorAll('.ts-row[data-id]').forEach((r) => {
      r.classList.toggle('ts-row-sel', String(r.dataset.id) === String(id));
    });
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
    const rs = rulerStep();
    /* 高级设置里「帧缩略图」开着时，长条也铺一层小图（像 AM 那样） */
    const thumbOn = !!(api.thumbMode && api.thumbMode());
    let html = '';

    /* 刻度尺（左列顺带放放大/缩小） */
    html += '<div class="ts-row ts-ruler-row">';
    html += '<div class="ts-gutter ts-gutter-head">' +
      '<span>' + T('track.gutterHead', '元件') + '</span>' +
      '<button class="ts-zoom" type="button" data-zoom="-1" title="' + esc(T('track.zoomOut', '缩小（缩到很小改显示分:秒）')) + '">−</button>' +
      '<button class="ts-zoom" type="button" data-zoom="1" title="' + esc(T('track.zoomIn', '放大')) + '">＋</button>' +
      '</div>';
    html += '<div class="ts-lane ts-ruler" style="width:' + width + 'px">';
    for (let i = 0; i < total; i += rs.step) {
      html += '<span class="ts-tick" style="left:' + (i * colW) + 'px">' +
        (rs.time ? fmtClock(i) : (i + 1)) + '</span>';
    }
    html += '</div></div>';

    /* 每个元件一行 */
    ids.forEach((id) => {
      const t = map[id];
      const arr = t.frames;
      const spans = computeSpans(arr);
      /* 眼睛状态看「这条轨上有没有 hidden 数据」，不能看第一段 —— 全隐藏时一段都没有 */
      const hidden = arr.some(x => x && !KF().isDerived(x) && x.hidden);
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
        const sel = selClip && String(selClip.id) === String(id) && selClip.a === s.a && selClip.b === s.b;
        /* 缩略图：只取这一段的头一帧，横向平铺成胶片条 —— 每段只渲染一次，不拖慢大工程 */
        let cls = '', style = 'left:' + left + 'px;width:' + w + 'px';
        if (thumbOn && api.renderThumb) {
          let url = null;
          try { url = api.renderThumb(id, s.a); } catch (_) { url = null; }
          if (url) { cls = ' has-thumb'; style += ';background-image:url(' + url + ')'; }
        }
        html += '<div class="ts-clip' + cls + (sel ? ' sel' : '') + '" data-id="' + esc(id) + '" data-si="' + si + '" data-a="' + s.a + '" data-b="' + s.b + '"' +
          ' style="' + style + '">' +
          '<i class="ts-h ts-h-l"></i><span class="ts-lab">' + label + '</span><i class="ts-h ts-h-r"></i></div>';
      });
      /* 关键帧菱形：压在长条正中间，可以单拖（改这一帧的时间） */
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (!KF().isKey(slot)) continue;
        html += '<i class="ts-key' + (slot.hidden ? ' off' : '') + (isCut(slot) ? ' cut' : '') +
          '" data-id="' + esc(id) + '" data-i="' + i + '" style="left:' + (i * colW + colW / 2) + 'px"></i>';
      }
      html += '</div></div>';
    });

    /* 播放头放在所选帧的正中间 */
    html += '<div class="ts-playhead" style="left:' + (GUTTER + cur * colW + colW / 2) + 'px;height:' + (RULER_H + rowsH) + 'px"></div>';

    cv.innerHTML = html;
    if (root.SKFEApplyIcons) root.SKFEApplyIcons(cv);
    scrollPlayheadIntoView();
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
    ph.style.left = (GUTTER + api.currentFrame() * colW + colW / 2) + 'px';
  }

  /* ---------------- 写回工具 ---------------- */
  function ensureLen(arr, n) { while (arr.length < n) arr.push(null); }

  function trackOf(id) {
    const t = tracksMap()[id];
    if (!t) return null;
    if (!t.frames) t.frames = [];
    return t;
  }

  function cloneAt(id, i) {
    const o = api.getTrackFrame(id, i);
    return o ? api.clone(o) : null;
  }

  /* 普通帧：不挂关键帧标记（拉长时用 —— 要求「不要在末尾加关键帧」） */
  function plainFrom(o) {
    if (!o) return null;
    const c = api.clone(o);
    KF().clearKey(c);   /* 顺带把 __k（含分割标记）一起摘掉 */
    return c;
  }

  /* markKey 会把 __k 整个换掉（曲线和分割标记都住在里面），所以先记住分割标记再按回去 */
  function markKeyKeep(o, origin, curve) {
    if (!o) return o;
    const cut = isCut(o);
    KF().markKey(o, origin || 'sub', curve);
    if (cut) setCut(o, true);
    return o;
  }

  /* 关键帧：带上原来那段曲线的配置。keepCut=false 用于「腾空」时新造的隐藏段头 ——
     那是全新的一帧「此处不出场」，不该继承分割标记，否则会平白多切一刀。 */
  function keyFrom(o, hidden, keepCut) {
    if (!o) return null;
    const c = api.clone(o);
    if (keepCut === false) KF().markKey(c, 'sub', KF().curveOf(o));
    else markKeyKeep(c, 'sub', KF().curveOf(o));
    c.hidden = !!hidden;
    return c;
  }

  /* 把 [a..b] 求值后抓出来（原本是关键帧的那些保持关键帧身份和曲线） */
  function takeRange(id, a, b) {
    const t = trackOf(id);
    const arr = t ? t.frames : [];
    const out = [];
    for (let i = a; i <= b; i++) {
      const o = cloneAt(id, i);
      if (!o) { out.push(null); continue; }
      const raw = arr[i];
      if (KF().isKey(raw)) markKeyKeep(o, 'sub', KF().curveOf(raw));
      else KF().clearKey(o);
      o.hidden = !!raw.hidden;
      setCut(o, isCut(raw));
      out.push(o);
    }
    return out;
  }

  /* 把一串帧写到 [na..]：首帧一定是可见关键帧（新段的锚点），其余沿用原来的身份 */
  function putRange(arr, na, srcs) {
    ensureLen(arr, na + srcs.length);
    for (let k = 0; k < srcs.length; k++) {
      const o = srcs[k];
      if (!o) { arr[na + k] = null; continue; }
      const c = api.clone(o);
      if (k === 0) { markKeyKeep(c, 'sub'); c.hidden = false; }
      else if (!KF().isKey(o)) KF().clearKey(c);
      arr[na + k] = c;
    }
  }

  /* 让 [from..to] 不再出场。
     段内（前面已经有关键帧）必须落一个 hidden 关键帧当初不见段的头，
     否则前一个关键帧的段会一路盖过来，把这里又填成可见。
     前面一个关键帧都没有时（第一段之前 / 只有一段的尾巴）直接清空就够，
     免得平白多出一个用户没点过的隐藏关键帧菱形。 */
  function vacate(id, arr, from, to) {
    if (to < from || from < 0) return;
    ensureLen(arr, to + 1);
    let keyBefore = false;
    for (let i = 0; i < from; i++) { if (KF().isKey(arr[i])) { keyBefore = true; break; } }
    if (keyBefore) {
      const head = keyFrom(cloneAt(id, from), true, false);
      arr[from] = head || null;
    } else {
      arr[from] = null;
    }
    for (let i = from + 1; i <= to; i++) arr[i] = null;
  }

  /* 每一步操作的最后一步：段内空槽归位 + 记一步历史。
     ⚠️ 历史里存的是**操作之后**的状态 —— app.js 的 undo() 是「弹掉栈顶、恢复到新栈顶」，
        所以每条记录都必须等于它那一刻的当前状态，否则一次撤销会退两步。 */
  function commit(ids, label) {
    (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
      const t = trackOf(id);
      if (t) KF().reconcileTrack(t);
    });
    /* ⚠️ 必须重取当前帧的渲染对象（api.refreshObjects）：
       getTrackFrame 对关键帧 / 普通帧返回的就是槽位对象本身，而 AppState.objects
       里留着的还是改动之前那一份。少了这一步，下一次 goToFrame 的 syncFrameRef
       会因为「不是同一个对象」把关键帧槽位覆写成普通帧 —— 关键帧、分割标记全丢，
       表现就是「点一下别处，段落就散架」。 */
    if (api.refreshObjects) api.refreshObjects();
    api.afterChange();
    api.pushPre(api.snapshot(), label);
  }

  /* ---------------- 伸缩 / 平移 ---------------- */
  /* 拖拽的横向边界：平移和两端伸缩共用一套 —— 左端最多贴到前一条长条的右边，
     右端最多贴到后一条的左边，否则往外一拽就把隔壁那段吃掉（看着像段落散架）。 */
  function moveBounds(id, a, b) {
    const t = tracksMap()[id];
    const spans = t ? computeSpans(t.frames) : [];
    let lo = -a, hi = MAX_FRAMES - b;
    spans.forEach((s) => {
      if (s.a === a && s.b === b) return;
      if (s.b < a) lo = Math.max(lo, s.b + 1 - a);
      else if (s.a > b) hi = Math.min(hi, s.a - 1 - b);
    });
    return { lo: lo, hi: hi };
  }

  /* 右端拉到 nb：拉长只补普通帧（不产生关键帧），缩短把腾空的帧真正清掉 */
  function stretchRight(id, b, nb) {
    const t = trackOf(id);
    if (!t) return;
    const arr = t.frames;
    ensureLen(arr, Math.max(totalFrames(), arr.length));
    if (nb > b) {
      const base = plainFrom(cloneAt(id, b));
      if (!base) return;
      ensureLen(arr, nb + 1);
      for (let i = b + 1; i <= nb; i++) arr[i] = api.clone(base);
    } else if (nb < b) {
      vacate(id, arr, nb + 1, b);
    }
  }

  /* 左端拉到 na
     - 往左拉长：这一段的头如果是关键帧（段的头 / 分割点），就把它一起往左挪。
       否则左边那段「不出场段」或前一段会把这几个新长出来的帧吃回去，
       表现就是「怎么拖都拖不动」。
     - 新长出来的帧一律是普通帧（不在末尾加关键帧）。 */
  function stretchLeft(id, a, na) {
    const t = trackOf(id);
    if (!t) return;
    const arr = t.frames;
    ensureLen(arr, Math.max(totalFrames(), arr.length));
    if (na < a) {
      const base = plainFrom(cloneAt(id, a));
      if (!base) return;
      const head = arr[a];
      const headIsKey = !!(head && !KF().isDerived(head) && KF().isKey(head));
      if (headIsKey) {
        /* 关键帧当头的段：头跟着挪到新的左端，原位置退回普通帧（不然会多出一个菱形） */
        arr[na] = api.clone(head);
        arr[a] = api.clone(base);
        for (let i = na + 1; i < a; i++) arr[i] = api.clone(base);
      } else {
        for (let i = na; i < a; i++) {
          const s = arr[i];
          /* 让位给新长出来的帧：这里原有的隐藏关键帧（腾空留下的）先摘掉 */
          if (s && !KF().isDerived(s) && KF().isKey(s) && s.hidden) KF().clearKey(s);
          arr[i] = api.clone(base);
        }
      }
    } else if (na > a) {
      vacate(id, arr, a, na - 1);
    }
  }

  /* 挂在某个元件上的配饰（画笔 / 贴件…）的轨道 id —— 主体变了它们要跟着变 */
  function boundIdsOf(id) {
    if (!api || !api.boundIds) return [];
    try { return api.boundIds(id) || []; } catch (_) { return []; }
  }

  function applyDrag(st, d) {
    const t = trackOf(st.id);
    if (!t) return;
    const arr = t.frames;
    ensureLen(arr, Math.max(totalFrames(), arr.length));
    const ids = [st.id];

    if (st.mode === 'm') {
      /* 平移：抓出整段 → 原位腾空 → 写到新位置 */
      const srcs = takeRange(st.id, st.a, st.b);
      const na = st.a + d, nb = st.b + d;
      vacate(st.id, arr, st.a, st.b);
      putRange(arr, na, srcs);
      if (nb < st.b) vacate(st.id, arr, nb + 1, st.b);   /* 往左挪时右端要腾干净 */
    } else if (st.mode === 'r') {
      const b = st.b, nb = b + d;
      stretchRight(st.id, b, nb);
      /* 配饰跟着一起伸缩：只有「原来和主体同一端」的那些才跟，免得把别人拉长 */
      boundIdsOf(st.id).forEach((bid) => {
        const sp = computeSpans((tracksMap()[bid] || {}).frames || []).filter(x => x.b === b && x.a <= st.a);
        if (!sp.length) return;
        stretchRight(bid, b, nb);
        ids.push(bid);
      });
    } else {
      const a = st.a, na = a + d;
      stretchLeft(st.id, a, na);
      boundIdsOf(st.id).forEach((bid) => {
        const sp = computeSpans((tracksMap()[bid] || {}).frames || []).filter(x => x.a === a && x.b >= st.b);
        if (!sp.length) return;
        stretchLeft(bid, a, na);
        ids.push(bid);
      });
    }
    commit(ids, T('track.dragLabel', '调整轨道'));
  }

  /* 单拖关键帧：默认「覆盖落点」（原帧保留），按住 Alt 是「整帧挪位」 */
  function applyKeyDrag(st, to) {
    const t = trackOf(st.id);
    if (!t) return;
    const arr = t.frames;
    const src = cloneAt(st.id, st.i);
    if (!src) return;
    const raw = arr[st.i];
    KF().markKey(src, 'sub', raw ? KF().curveOf(raw) : null);
    src.hidden = !!(raw && raw.hidden);
    setCut(src, isCut(raw));
    ensureLen(arr, to + 1);
    arr[to] = src;
    if (st.alt) arr[st.i] = null;      /* Alt = 挪位，原位交还给 reconcile */
    commit(st.id, st.alt ? T('track.keyMoveLabel', '移动关键帧') : T('track.keyCopyLabel', '关键帧覆盖到落点'));
  }

  /* ---------------- 分割 / 删除 / 关键帧 ---------------- */
  function needClip() {
    api.toast(T('track.needPick', '先在轨道上点一条长条，选中要操作的段'));
    return null;
  }

  /* 分割：在播放头把当前段切成左右两段（剪映式），两边都还在，只是各自成段 */
  function split() {
    const clip = selClip;
    if (!clip) return needClip();
    const t = trackOf(clip.id);
    if (!t) return needClip();
    const arr = t.frames;
    const i = api.currentFrame();
    if (i <= clip.a || i > clip.b) {
      api.toast(T('track.splitOut', '播放头要落在选中长条的中间（不含左端）才能分割'));
      return;
    }
    const src = keyFrom(cloneAt(clip.id, i), false);
    if (!src) return;
    setCut(src, true);
    ensureLen(arr, Math.max(clip.b, i) + 1);
    arr[i] = src;
    commit(clip.id, T('track.splitLabel', '分割'));
    selClip = { id: clip.id, a: i, b: clip.b };   /* 分割后选中右半段 */
    render();
    api.toast(T('track.splitDone', '已从这一帧分成左右两段，可以各自拖了'));
  }

  /* 删除选中的那一段（范围变空白，前后两段自动接上） */
  function deleteClip() {
    const clip = selClip;
    if (!clip) return needClip();
    const t = trackOf(clip.id);
    if (!t) return needClip();
    ensureLen(t.frames, Math.max(totalFrames(), t.frames.length));
    vacate(clip.id, t.frames, clip.a, clip.b);
    commit(clip.id, T('track.delLabel', '删除这一段的帧'));
    selClip = null;
    lastPickedId = null;
    render();
    api.toast(T('track.delDone', '这一段已经删掉'));
  }

  /* 关键帧：给「选中的那条轨」在播放头处开/关关键帧（轨道模式下不认子轨选择器） */
  function toggleKey() {
    const id = (selClip && selClip.id) || lastPickedId;
    if (!id) { api.toast(T('track.needPick', '先在轨道上点一条长条，选中要操作的段')); return; }
    const t = trackOf(id);
    if (!t) return;
    const arr = t.frames;
    const i = api.currentFrame();
    ensureLen(arr, i + 1);
    if (KF().isKey(arr[i])) {
      KF().clearKey(arr[i]);
    } else {
      const src = keyFrom(cloneAt(id, i), false);
      if (!src) return;
      arr[i] = src;
    }
    commit(id, T('track.keyLabel', '关键帧'));
    render();
  }

  /* ---------------- 缩放 ---------------- */
  function zoom(dir) {
    const i = COLW_STEPS.indexOf(colW);
    let k = i < 0 ? COLW_STEPS.indexOf(26) : i;
    k = Math.max(0, Math.min(COLW_STEPS.length - 1, k + (dir > 0 ? 1 : -1)));
    if (COLW_STEPS[k] === colW) return;
    colW = COLW_STEPS[k];
    try { localStorage.setItem(COLW_KEY, String(colW)); } catch (_) {}
    render();
  }

  /* ---------------- 交互绑定 ---------------- */
  function bindDrag() {
    const cv = $('tsCanvas');
    if (!cv || cv.dataset.bound === '1') return;
    cv.dataset.bound = '1';

    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      /* 放大 / 缩小、眼睛都是「按一下」的动作，交给 click 处理（键盘也能用），这里只让路 */
      if (e.target.closest('[data-zoom]') || e.target.closest('[data-eye]')) return;

      /* 关键帧菱形：单拖改这一帧的时间 */
      const kEl = e.target.closest('.ts-key');
      if (kEl) {
        const kr = kEl.getBoundingClientRect();
        drag = {
          kind: 'key',
          id: kEl.dataset.id,
          i: +kEl.dataset.i,
          to: +kEl.dataset.i,
          startX: e.clientX,
          alt: !!e.altKey,
          el: kEl,
          moved: false
        };
        lastPickedId = kEl.dataset.id;
        markRow(kEl.dataset.id);
        kEl.classList.add('dragging');
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
        return;
      }

      const clip = e.target.closest('.ts-clip');
      if (clip) {
        const rect = clip.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const mode = dx <= HANDLE_W ? 'l' : (rect.width - dx <= HANDLE_W ? 'r' : 'm');
        lastPickedId = clip.dataset.id;
        selClip = { id: clip.dataset.id, a: +clip.dataset.a, b: +clip.dataset.b };
        markRow(clip.dataset.id);
        cv.querySelectorAll('.ts-clip.sel').forEach(c => c.classList.remove('sel'));
        clip.classList.add('sel');
        drag = {
          kind: 'clip',
          id: clip.dataset.id,
          si: +clip.dataset.si,
          a: +clip.dataset.a,
          b: +clip.dataset.b,
          mode,
          startX: e.clientX,
          d: 0,
          el: clip,
          moved: false
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

    /* 按一下的动作：缩放、眼睛 */
    cv.addEventListener('click', (e) => {
      const zm = e.target.closest('[data-zoom]');
      if (zm) { zoom(+zm.dataset.zoom); return; }
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        lastPickedId = eye.dataset.eye;
        api.toggleHidden(eye.dataset.eye);
        render();   /* 隐藏态只发 need:render，这里自己跟一次，图标和长条才会立刻变 */
      }
    });

    cv.addEventListener('pointermove', (e) => {
      if (!drag) {
        /* 光标提示：手柄处左右箭头，关键帧上抓手 */
        const clip = e.target.closest('.ts-clip');
        if (clip) {
          const rect = clip.getBoundingClientRect();
          const dx = e.clientX - rect.left;
          clip.style.cursor = (dx <= HANDLE_W || rect.width - dx <= HANDLE_W) ? 'ew-resize' : 'grab';
        }
        return;
      }

      if (drag.kind === 'key') {
        const to = Math.max(0, Math.min(MAX_FRAMES - 1,
          drag.i + Math.round((e.clientX - drag.startX) / colW)));
        if (to === drag.to) return;
        drag.to = to;
        drag.moved = to !== drag.i;
        drag.el.style.left = (to * colW + colW / 2) + 'px';
        return;
      }

      const raw = Math.round((e.clientX - drag.startX) / colW);
      let d = raw;
      if (drag.mode === 'm') {
        const bd = moveBounds(drag.id, drag.a, drag.b);
        d = Math.max(bd.lo, Math.min(bd.hi, d));
      } else if (drag.mode === 'r') {
        const bd = moveBounds(drag.id, drag.a, drag.b);
        d = Math.max(-(drag.b - drag.a), Math.min(bd.hi, d));
      } else {
        const bd = moveBounds(drag.id, drag.a, drag.b);
        d = Math.max(bd.lo, Math.min(drag.b - drag.a, d));
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
      try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
      st.el.classList.remove('dragging', 'drag-l', 'drag-r', 'drag-m');

      if (st.kind === 'key') {
        if (!st.moved) return;                       /* 没拖动 = 啥都不做 */
        applyKeyDrag(st, st.to);
        render();
        return;
      }

      if (!st.moved) {
        /* 没拖动 = 点选：只选中这个元件和这条长条，不切子轨、不动帧号 */
        api.selectTrack(st.id);
        return;
      }
      applyDrag(st, st.d);
      render();
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', finish);
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

  /* 轨道模式下，「关键帧」按钮要认选中的那条轨，而不是子轨选择器。
     用捕获阶段先拦下来，再 stopPropagation —— 这样不必改动 app.js 里原来的监听。 */
  function bindToolbar() {
    const tl = $('timeline');
    if (!tl || tl.dataset.tsTools === '1') return;
    tl.dataset.tsTools = '1';
    tl.addEventListener('click', (e) => {
      if (!enabled) return;
      if (!e.target.closest('#btnKeyframe')) return;
      e.stopPropagation();
      e.preventDefault();
      toggleKey();
    }, true);
  }

  function applyHeight() {
    const tl = $('timeline');
    if (!tl) return;
    if (enabled) tl.style.height = Math.round(panelH) + 'px';
    else tl.style.height = '';
  }

  /* ---------------- 模式开关 ---------------- */
  let dockBefore = null;   /* 进来之前是不是置顶的，退出时还原 */

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
    /* 控制面板与底部栏要压在轨道面板之上 */
    document.body.classList.toggle('track-mode-on', enabled);
    if (!enabled) { selClip = null; }

    /* 「轨道面板要在控制面板下方」—— 开着的时候就先临时落到屏幕底部 */
    if (enabled) {
      if (api && api.getDock && api.setDock && api.getDock() === 'top') {
        dockBefore = 'top';
        api.setDock('bottom');
      }
    } else if (dockBefore === 'top') {
      dockBefore = null;
      if (api && api.setDock) api.setDock('top');
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
        if (COLW_STEPS.indexOf(c) >= 0) colW = c;
        const h = parseInt(localStorage.getItem(HEIGHT_KEY) || '', 10);
        if (h >= MIN_H) panelH = h;
      } catch (_) {}

      bindGrip();
      bindDrag();
      bindToolbar();

      /* 完全被动地跟随现有事件总线：不改 app.js 里任何一个函数，
         现有功能该发什么事件照发，这边只是「听到就顺手更新一下自己」。 */
      const bus = root.SKFE.core && root.SKFE.core.eventBus && root.SKFE.core.eventBus.EventBus;
      if (bus) {
        bus.on('need:syncUI', () => TrackStrip.scheduleRefresh());
        bus.on('app:update', () => TrackStrip.scheduleRefresh());
        /* v7.4.2：高级设置里切「帧缩略图」只发 need:render，不跟一下长条上的小图不会变 */
        bus.on('need:render', () => TrackStrip.scheduleRefresh());
      }

      const btn = $('btnTrackMode');
      if (btn) btn.addEventListener('click', () => setEnabled(!enabled));

      const splitBtn = $('btnSplit');
      if (splitBtn) splitBtn.addEventListener('click', split);
      const delBtn = $('btnTrackDel');
      if (delBtn) delBtn.addEventListener('click', deleteClip);

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
    refresh() { if (enabled) render(); },
    isEnabled() { return enabled; },
    setEnabled,
    getColW() { return colW; }
  };

  root.SKFE.features.trackStrip = TrackStrip;
})();
