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
  let selClip = null;      /* 最近点选的那一条长条 { id, a, b } —— 分割认它 */
  let selClips = [];       /* v7.4.4：多选长条（框选 / Ctrl 点选）。整体移动、整体删除认它 */
  let lastPickedId = null; /* 最近点过的轨道：切帧会把 AppState.selected 清空，靠它兜底 */
  let lastSig = '';        /* 上次渲染时的数据指纹，用来跳过无变化的重画 */
  let refreshQueued = false;

  /* ---- v7.4.3：关键帧多选 / 剪切板 ----
     token 就是 '轨道id|帧号'，跨轨道共用一套 —— 和 AM 的 layerId|channel|frame 同一个思路，
     这样「框选一片、整体平移、复制到另一条轨」都不需要额外的数据结构。 */
  let selKeys = new Set();   /* 选中的关键帧 token 集合 */
  let keyClip = null;        /* 剪切板：{ base: 最小帧号, items: [{ id, off, obj }] } */

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

  /* ---------------- 关键帧 token ----------------
     '轨道id|帧号'。轨道 id 里不会有 '|'（都是数字或 UUID），所以从后往前找分隔符最稳。 */
  function ktok(id, i) { return String(id) + '|' + i; }
  function untok(tok) {
    const s = String(tok);
    const p = s.lastIndexOf('|');
    if (p < 0) return null;
    const i = parseInt(s.slice(p + 1), 10);
    if (!isFinite(i) || i < 0) return null;
    return { id: s.slice(0, p), i };
  }
  /* 只留「这一帧真的是关键帧」的 token —— 撤销 / 切帧之后集合里会留垃圾 */
  function liveSelKeys() {
    const map = tracksMap();
    const out = [];
    selKeys.forEach((tok) => {
      const p = untok(tok);
      if (!p) { selKeys.delete(tok); return; }
      const t = map[p.id];
      if (!t || !t.frames || !KF().isKey(t.frames[p.i])) { selKeys.delete(tok); return; }
      out.push(p);
    });
    return out;
  }
  function clearKeySel() {
    if (!selKeys.size) return;
    selKeys.clear();
    const cv = $('tsCanvas');
    if (cv) cv.querySelectorAll('.ts-key.sel').forEach(el => el.classList.remove('sel'));
  }

  /* ---------------- 长条多选 ----------------
     单选时 selClips 就是一条，selClip 指同一条（分割 / 关键帧按钮只认单条）。
     框选、批量移动、批量删除都读 selClips。 */
  function isClipSelected(id, a, b) {
    for (let i = 0; i < selClips.length; i++) {
      const c = selClips[i];
      if (String(c.id) === String(id) && c.a === a && c.b === b) return true;
    }
    return false;
  }
  function setClipSel(list, primary) {
    const seen = Object.create(null);
    const out = [];
    (list || []).forEach((c) => {
      if (!c) return;
      const k = c.id + '|' + c.a + '|' + c.b;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ id: String(c.id), a: +c.a, b: +c.b });
    });
    selClips = out;
    selClip = primary || out[0] || null;
    if (selClip) { lastPickedId = selClip.id; }
  }
  function clearClipSel() {
    selClips = [];
    selClip = null;
  }

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
    /* v7.4.7：全空白帧的轨道不画行 —— 元件已经彻底删掉了，这一行不该留在面板里。
       （数据层由 pruneEmptyTracks 清，这里再兜一层，避免别的入口漏扫。） */
    const ids = Object.keys(map).filter(id => map[id] && map[id].frames && map[id].frames.some(d => d != null));
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
        const sel = isClipSelected(id, s.a, s.b);
        /* 缩略图：只取这一段的头一帧，横向平铺成胶片条 —— 每段只渲染一次，不拖慢大工程 */
        let cls = '', style = 'left:' + left + 'px;width:' + w + 'px';
        if (thumbOn && api.renderThumb) {
          let url = null;
          try { url = api.renderThumb(id, s.a); } catch (_) { url = null; }
          if (url) { cls = ' has-thumb'; style += ';background-image:url(' + url + ')'; }
        }
        /* 选中的长条两端冒出 ‹ › 两个把手（对应两条 10px 的命中区），一眼能看出可以拖 */
        html += '<div class="ts-clip' + cls + (sel ? ' sel' : '') + '" data-id="' + esc(id) + '" data-si="' + si + '" data-a="' + s.a + '" data-b="' + s.b + '"' +
          ' style="' + style + '">' +
          '<i class="ts-h ts-h-l">‹</i><span class="ts-lab">' + label + '</span><i class="ts-h ts-h-r">›</i></div>';
      });
      /* 关键帧菱形：压在长条正中间，可以单拖（改这一帧的时间）／Ctrl 点选多颗 */
      for (let i = 0; i < arr.length; i++) {
        const slot = arr[i];
        if (!KF().isKey(slot)) continue;
        html += '<i class="ts-key' + (slot.hidden ? ' off' : '') + (isCut(slot) ? ' cut' : '') +
          (selKeys.has(ktok(id, i)) ? ' sel' : '') +
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
     段内（前面已经有关键帧、且后面也还有关键帧）必须落一个 hidden 关键帧当「不见段的头」，
     否则前一个关键帧的段会一路盖过来，把这里又填成可见。
     v7.4.4：后面**没有**关键帧时不再插这颗 —— 那时候清空就够，
     否则缩短长条会在空白处留下一个谁也点不掉的隐藏菱形（就是「轨道缩短后空白处还有帧」那个 bug）。 */
  /* 干净清空一段：不留「隐藏头」，裁短专用 */
  function clearFrames(arr, from, to) {
    for (let i = Math.max(0, from); i <= to && i < arr.length; i++) arr[i] = null;
  }

  function vacate(id, arr, from, to) {
    if (to < from || from < 0) return;
    ensureLen(arr, to + 1);
    let keyBefore = false;
    for (let i = 0; i < from; i++) { if (KF().isKey(arr[i])) { keyBefore = true; break; } }
    let keyAfter = false;
    for (let i = to + 1; i < arr.length; i++) { if (KF().isKey(arr[i])) { keyAfter = true; break; } }
    if (keyBefore && keyAfter) {
      const head = keyFrom(cloneAt(id, from), true, false);
      arr[from] = head || null;
    } else {
      arr[from] = null;
    }
    for (let i = from + 1; i <= to; i++) arr[i] = null;
  }

  /* 每一步操作的最后一步：段内空槽归位 + 记一步历史。
     ⚠️ 历史里存的是**操作之后**的状态 —— app.js 的 undo() 是「弹掉栈顶、恢复到新栈顶」，
        所以每条记录都必须等于它那一刻的当前状态，否则一次撤销会退两步。
     v7.4.3：外层若已经开了事务（一次拖拽 / 一次粘贴 / 一次批量删），这一步只改数据不记历史，
        由 txEnd 统一压一条 —— 一个手势 = 一步撤销。 */
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
    /* v7.4.6：裁短 / 删掉尾部之后把时间轴尾巴收干净，别留一串谁都不出场的空白帧 */
    if (api.trimTail) { try { api.trimTail(); } catch (_) {} }
    /* v7.4.7：整条轨被清空（元件已经不出场）→ 这一行直接消失，别留空壳 */
    if (api.pruneTracks) { try { api.pruneTracks(); } catch (_) {} }
    api.afterChange();
    if (api.isTxOpen && api.isTxOpen()) return;
    api.pushPre(api.snapshot(), label);
  }

  /* 把一整段操作包进一个事务。没有 isTxOpen 的旧内核也不会炸：begin/end 缺席时退化成原来的 commit 记法。
     ⚠️ 必须在**改数据之前** begin，否则 begin 取到的那份「操作前快照」已经包含改动，
        txEnd 会认为「啥都没变」而不记历史 —— 表现就是「改了、撤销却没反应」。
        单步操作（分割 / 删除 / 开关键帧）不需要事务：commit 里已经按操作后状态记了一步。 */
  function withTx(label, fn) {
    const can = !!(api && api.txBegin && api.txEnd);
    if (can) api.txBegin(label);
    try {
      return fn();
    } finally {
      if (can) api.txEnd();
    }
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
      /* 裁短（v7.4.5）：拖到 14 就把 15 之后全裁掉，落在里面的关键帧（比如 17）一起取消；
         剩下的尾巴（最后一个保留关键帧 +1 … 14）定格成那颗关键帧的姿势 ——
         不然 17 一没，6 后面就成了「段外」，补间撤掉后这几帧会直接消失。 */
      const anchor = lastKeyAtOrBefore(id, nb);
      const hold = anchor >= 0 ? plainFrom(cloneAt(id, anchor)) : null;
      /* 用干净清空：vacate 会在两侧都有关键帧时落一颗「隐藏头」，
         裁短的场合那颗头正好落在新区间外面（15 帧），又会变成看不见的残留。 */
      clearFrames(arr, nb + 1, b);
      if (hold) {
        for (let i = anchor + 1; i <= nb; i++) arr[i] = api.clone(hold);
      }
    }
  }

  /* 轨道上 <= idx 的最后一颗关键帧；没有就 -1 */
  function lastKeyAtOrBefore(id, idx) {
    const t = trackOf(id);
    const arr = t ? t.frames : [];
    for (let i = Math.min(idx, arr.length - 1); i >= 0; i--) {
      if (arr[i] && KF().isKey(arr[i])) return i;
    }
    return -1;
  }

  /* 轨道上 >= idx 的第一颗关键帧；没有就 -1 */
  function firstKeyAtOrAfter(id, idx) {
    const t = trackOf(id);
    const arr = t ? t.frames : [];
    for (let i = Math.max(0, idx); i < arr.length; i++) {
      if (arr[i] && KF().isKey(arr[i])) return i;
    }
    return -1;
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
      /* 裁短左端（v7.4.5）：拖到 9 就把 9 之前全裁掉，落在里面的关键帧（比如 1、6）一起取消；
         剩下的头（9 … 后面第一颗保留关键帧 -1）定格成那颗关键帧的姿势，
         和右端裁短是同一套语义（只是取的是右边的锚点）。 */
      const anchor = firstKeyAtOrAfter(id, na);
      const hold = anchor >= 0 ? plainFrom(cloneAt(id, anchor)) : null;
      clearFrames(arr, a, na - 1);
      if (hold) {
        for (let i = na; i < anchor; i++) arr[i] = api.clone(hold);
      }
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

  /* ---------------- 多条长条整体平移（框选后用） ----------------
     每条各自按自己的邻居夹紧，再取交集 —— 这样一起拖的时候不会有一条撞进隔壁。 */
  function multiMoveBounds(items) {
    let lo = -MAX_FRAMES, hi = MAX_FRAMES;
    items.forEach((c) => {
      const bd = moveBounds(c.id, c.a, c.b);
      lo = Math.max(lo, bd.lo);
      hi = Math.min(hi, bd.hi);
    });
    if (!isFinite(lo)) lo = -MAX_FRAMES;
    if (!isFinite(hi)) hi = MAX_FRAMES;
    if (lo > hi) return { lo: 0, hi: 0 };     /* 互相顶死：不许动，免得写坏数据 */
    return { lo: lo, hi: hi };
  }

  function applyClipsMove(items, d) {
    if (!d) return;
    const ids = [];
    /* 从右往左处理：右边先腾空，左边再落位，同一轨道上两条也不会互相吃格子 */
    items.slice().sort((x, y) => (x.id === y.id ? y.a - x.a : (x.id < y.id ? -1 : 1))).forEach((c) => {
      const t = trackOf(c.id);
      if (!t) return;
      const arr = t.frames;
      ensureLen(arr, Math.max(totalFrames(), arr.length));
      const srcs = takeRange(c.id, c.a, c.b);
      const na = c.a + d, nb = c.b + d;
      vacate(c.id, arr, c.a, c.b);
      putRange(arr, na, srcs);
      if (nb < c.b) vacate(c.id, arr, nb + 1, c.b);
      if (ids.indexOf(c.id) < 0) ids.push(c.id);
    });
    commit(ids, T('track.moveClipLabel', '整体移动长条'));
    /* 落位之后按新的位置重选，接着还能再拖 */
    setClipSel(items.map(c => ({ id: c.id, a: c.a + d, b: c.b + d })));
  }

  /* ---------------- 关键帧平移 / 复制 / 粘贴 ----------------
     v7.4.3 语义调整：拖关键帧 = 改它落在第几帧（用户最初要的就是这个），
     想保留原来那颗就按住 Alt（= 复制到落点）。单颗和整组用同一套键位。 */
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
    if (!st.alt) arr[st.i] = null;     /* 默认挪位；Alt = 复制（原帧留着） */
    commit(st.id, st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'));
  }

  /* 整组平移的横向夹紧：任一颗都不能跑到第 0 帧之前 / 600 帧之后 */
  function clampKeyDelta(items, raw) {
    let lo = -MAX_FRAMES, hi = MAX_FRAMES;
    items.forEach((it) => {
      lo = Math.max(lo, -it.i);
      hi = Math.min(hi, MAX_FRAMES - 1 - it.i);
    });
    return Math.max(lo, Math.min(hi, raw));
  }

  /* 整组平移：先抓出所有源（带曲线 / 分割 / 隐藏态），把原位置统一腾空，再统一写到落点。
     先腾后写是关键 —— 否则往右挪时前一颗会把自己后一颗的源覆盖掉。 */
  function applyKeysDrag(st) {
    const d = st.d;
    if (!d) return;
    const plan = [];
    const ids = [];
    st.items.forEach((it) => {
      const t = trackOf(it.id);
      if (!t || !t.frames) return;
      const raw = t.frames[it.i];
      if (!KF().isKey(raw)) return;
      const o = cloneAt(it.id, it.i);
      if (!o) return;
      markKeyKeep(o, 'sub', KF().curveOf(raw));
      o.hidden = !!raw.hidden;
      setCut(o, isCut(raw));
      plan.push({ id: it.id, from: it.i, to: it.i + d, obj: o });
      if (ids.indexOf(it.id) < 0) ids.push(it.id);
    });
    if (!plan.length) return;
    plan.forEach((p) => {                       /* 1. 先腾空 */
      const t = trackOf(p.id);
      if (t) { ensureLen(t.frames, p.from + 1); t.frames[p.from] = null; }
    });
    plan.forEach((p) => {                       /* 2. 再落到新位置 */
      const t = trackOf(p.id);
      if (!t) return;
      ensureLen(t.frames, p.to + 1);
      t.frames[p.to] = api.clone(p.obj);
    });
    commit(ids, st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'));
  }

  /* 复制选中的关键帧：以最小帧号归一成 off，粘贴时落在播放头 */
  function copyKeys() {
    const items = liveSelKeys();
    if (!items.length) { api.toast(T('track.copyNone', '先点选关键帧（Ctrl / ⌘ 点可以多选），再复制')); return false; }
    let base = Infinity;
    items.forEach((it) => { base = Math.min(base, it.i); });
    const list = [];
    items.forEach((it) => {
      const t = tracksMap()[it.id];
      const raw = t && t.frames ? t.frames[it.i] : null;
      if (!raw) return;
      const o = cloneAt(it.id, it.i);
      if (!o) return;
      markKeyKeep(o, 'sub', KF().curveOf(raw));
      o.hidden = !!raw.hidden;
      setCut(o, isCut(raw));
      list.push({ id: it.id, off: it.i - base, obj: o });
    });
    if (!list.length) return false;
    keyClip = { items: list };
    api.toast(T('track.copyDone', '已复制 %n 颗关键帧，到目标帧按粘贴').replace('%n', list.length));
    return true;
  }

  function pasteKeys() {
    if (!keyClip || !keyClip.items.length) { api.toast(T('track.pasteEmpty', '剪切板里还没有关键帧')); return false; }
    const at = api.currentFrame();
    const ids = [];
    const picked = [];
    withTx(T('track.pasteLabel', '粘贴关键帧'), () => {
      keyClip.items.forEach((it) => {
        const to = at + it.off;
        if (to < 0 || to >= MAX_FRAMES) return;
        const t = trackOf(it.id);
        if (!t) return;
        ensureLen(t.frames, to + 1);
        t.frames[to] = api.clone(it.obj);
        picked.push(ktok(it.id, to));
        if (ids.indexOf(it.id) < 0) ids.push(it.id);
      });
      if (ids.length) commit(ids, T('track.pasteLabel', '粘贴关键帧'));
    });
    if (!ids.length) { api.toast(T('track.pasteEmpty', '剪切板里还没有关键帧')); return false; }
    selKeys = new Set(picked);        /* 粘完直接选中，方便接着整组拖 */
    lastPickedId = ids[0];
    render();
    api.toast(T('track.pasteDone', '已粘贴 %n 颗关键帧').replace('%n', picked.length));
    return true;
  }

  /* 删掉一颗关键帧：先把这一段前后「靠补间撑着的派生帧」定格成普通帧，再摘掉关键帧身份。
     不这么做的话，段一消失，那些派生帧会被 reconcileTrack 清成空槽 ——
     画面会在段中间突然断掉几帧（用户看到的就是「删个关键帧怎么没了半段」）。 */
  function dropKey(id, i) {
    const t = trackOf(id);
    if (!t || !t.frames) return false;
    const arr = t.frames;
    const cur = arr[i];
    if (!cur || !KF().isKey(cur)) return false;
    const hidden = !!cur.hidden;
    let prevKey = -1, nextKey = -1;
    for (let k = i - 1; k >= 0; k--) { if (KF().isKey(arr[k])) { prevKey = k; break; } }
    for (let k = i + 1; k < arr.length; k++) { if (KF().isKey(arr[k])) { nextKey = k; break; } }
    const bake = (from, to) => {
      for (let k = from; k <= to; k++) {
        const slot = arr[k];
        if (slot && !KF().isDerived(slot)) continue;   /* 本身就有画面：不动它 */
        const c = plainFrom(cloneAt(id, k));
        if (c) { c.hidden = false; arr[k] = c; }
      }
    };
    /* 顺序要紧：先按「关键帧还在」时的求值结果烘焙，再来动这一帧本身 */
    if (prevKey >= 0) bake(prevKey + 1, i - 1);
    if (nextKey >= 0) bake(i + 1, nextKey - 1);
    const keep = plainFrom(cloneAt(id, i));
    if (keep) { keep.hidden = hidden; arr[i] = keep; } else arr[i] = null;
    return true;
  }

  /* 删掉选中的关键帧：画面留着，只摘掉「关键帧」这个身份（和「取消关键帧」同一套语义） */
  function deleteSelKeys() {
    const items = liveSelKeys();
    if (!items.length) return false;
    const ids = [];
    withTx(T('track.keyDelLabel', '删除关键帧'), () => {
      /* 同一轨道从右往左删，避免「先删右边把左边的段撑长」影响后面的烘焙 */
      items.slice().sort((a, b) => (a.id === b.id ? b.i - a.i : (a.id < b.id ? -1 : 1)))
        .forEach((it) => {
          const t = trackOf(it.id);
          if (!t || !t.frames) return;
          dropKey(it.id, it.i);
          if (ids.indexOf(it.id) < 0) ids.push(it.id);
        });
      if (ids.length) commit(ids, T('track.keyDelLabel', '删除关键帧'));
    });
    selKeys.clear();
    render();
    api.toast(T('track.keyDelDone', '已删除 %n 颗关键帧').replace('%n', items.length));
    return true;
  }

  /* 双击某颗关键帧 = 选中这一整条轨上的全部关键帧（整轨平移/复制用） */
  function selectTrackKeys(id) {
    const t = tracksMap()[id];
    if (!t || !t.frames) return;
    selKeys.clear();
    for (let i = 0; i < t.frames.length; i++) {
      if (KF().isKey(t.frames[i])) selKeys.add(ktok(id, i));
    }
    render();
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
    setClipSel([{ id: clip.id, a: i, b: clip.b }]);   /* 分割后选中右半段 */
    render();
    api.toast(T('track.splitDone', '已从这一帧分成左右两段，可以各自拖了'));
  }

  /* 删除选中的长条（可以是框选出来的好几条；范围变空白，前后两段自动接上） */
  function deleteClip() {
    const list = selClips.slice();
    if (!list.length && selClip) list.push(selClip);
    if (!list.length) return needClip();
    const ids = [];
    const n = list.length;
    withTx(T('track.delLabel', '删除这一段的帧'), () => {
      /* 从右往左：右边先腾空，左边的 vacate 才不会把右边刚写进去的撑长 */
      list.slice().sort((x, y) => (x.id === y.id ? y.a - x.a : (x.id < y.id ? -1 : 1))).forEach((clip) => {
        const t = trackOf(clip.id);
        if (!t) return;
        ensureLen(t.frames, Math.max(totalFrames(), t.frames.length));
        vacate(clip.id, t.frames, clip.a, clip.b);
        if (ids.indexOf(clip.id) < 0) ids.push(clip.id);
      });
      if (ids.length) commit(ids, T('track.delLabel', '删除这一段的帧'));
    });
    clearClipSel();
    lastPickedId = null;
    render();
    api.toast(n > 1
      ? T('track.delDoneMulti', '已删除 %n 段').replace('%n', n)
      : T('track.delDone', '这一段已经删掉'));
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
      /* 取消关键帧：画面留着，周围靠补间撑着的帧先定格，免得段一没就断档 */
      dropKey(id, i);
    } else {
      /* v7.4.3：这一帧本来是空白（段外没画面）时，借最近的姿势补一张 —— 否则「打了关键帧却没有画面」。
         先取本帧的求值结果，取不到再找最近的一帧（nearestPose 已剥掉帧身份）。 */
      const pose = cloneAt(id, i) || (api.nearestPose ? api.nearestPose(id, i) : null);
      const src = keyFrom(pose, false);
      if (!src) { api.toast(T('track.keyNoPose', '这一帧和前后都没有画面，先画点东西再打关键帧')); return; }
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

  /* ---------------- 框选（空白处按住拖） ---------------- */
  let marqEl = null;

  function marqueeEl() {
    const cv = $('tsCanvas');
    if (marqEl && marqEl.parentNode === cv) return marqEl;
    if (!cv) return null;
    marqEl = document.createElement('div');
    marqEl.className = 'ts-marquee';
    marqEl.hidden = true;
    cv.appendChild(marqEl);
    return marqEl;
  }
  function hideMarquee() {
    if (marqEl) { marqEl.hidden = true; marqEl.style.width = '0px'; marqEl.style.height = '0px'; }
  }
  /* 选框配色跟着主题高亮走（v7.4.6）：读 --color-primary，再压暗 42% 保证在
     浅色面板和缩略图上都看得清 —— 以前写死深绿，换主题还是绿的。 */
  function paintMarquee() {
    const el = marqueeEl();
    if (!el) return;
    let base = '#7d9bc4';
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim();
      if (v) base = v;
    } catch (_) {}
    const cu = (window.SKFE && SKFE.core && SKFE.core.colorUtils) || null;
    const strong = cu ? cu.themeMixHex(base, '#000000', 0.42) : base;
    el.style.borderColor = strong;
    el.style.background = cu ? cu.themeHexToRgba(strong, 0.10) : 'rgba(0,0,0,.08)';
  }
  /* 这一行里覆盖第 i 帧的长条（没有就取第一条） */
  function clipAt(id, i) {
    const cv = $('tsCanvas');
    if (!cv) return null;
    const list = Array.prototype.slice.call(cv.querySelectorAll('.ts-clip[data-id="' + id + '"]'));
    if (!list.length) return null;
    return list.filter(c => i >= +c.dataset.a && i <= +c.dataset.b)[0] || list[0];
  }
  /* 视口坐标的矩形 ∩ 每条长条的包围盒 —— 全用视口坐标，滚动/缩放都不用自己算 */
  function clipsInRect(rect) {
    const cv = $('tsCanvas');
    if (!cv || !rect) return [];
    const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
    const out = [];
    cv.querySelectorAll('.ts-clip').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right < rect.x || r.left > x2 || r.bottom < rect.y || r.top > y2) return;
      out.push({ id: el.dataset.id, a: +el.dataset.a, b: +el.dataset.b, top: r.top });
    });
    out.sort((p, q2) => p.top - q2.top);
    return out;
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

      /* 关键帧菱形：单拖改这一帧的时间；Ctrl / ⌘ / Shift 点 = 加选或减选 */
      const kEl = e.target.closest('.ts-key');
      if (kEl) {
        const kid = kEl.dataset.id;
        const ki = +kEl.dataset.i;
        const tok = ktok(kid, ki);
        const additive = !!(e.ctrlKey || e.metaKey || e.shiftKey);

        if (additive) {
          /* 只调选择，不起拖拽 —— 否则 Ctrl 点一下总会跟上一次 pointermove 的手势 */
          if (selKeys.has(tok)) selKeys.delete(tok); else selKeys.add(tok);
          kEl.classList.toggle('sel', selKeys.has(tok));
          selClip = null;
          lastPickedId = kid;
          markRow(kid);
          e.preventDefault();
          return;
        }

        /* 点在没被选中的那颗上 = 改单选这一颗；点在已选中的里面 = 保留整组，一起拖 */
        if (!selKeys.has(tok)) {
          selKeys.clear();
          selKeys.add(tok);
        } else {
          liveSelKeys();   /* 顺手把撤销之后残留的脏 token 清掉 */
        }
        cv.querySelectorAll('.ts-key').forEach((el) => {
          el.classList.toggle('sel', selKeys.has(ktok(el.dataset.id, el.dataset.i)));
        });

        const items = liveSelKeys();
        const byTok = Object.create(null);
        cv.querySelectorAll('.ts-key').forEach((el) => { byTok[ktok(el.dataset.id, el.dataset.i)] = el; });
        const els = [];
        items.forEach((it) => {
          const el = byTok[ktok(it.id, it.i)];
          if (el) els.push({ i: it.i, el });
        });

        drag = {
          kind: 'keys',
          items,
          els,
          startX: e.clientX,
          d: 0,
          alt: !!e.altKey,
          moved: false
        };
        selClip = null;
        lastPickedId = kid;
        markRow(kid);
        els.forEach(x => x.el.classList.add('dragging'));
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
        return;
      }

      const clip = e.target.closest('.ts-clip');
      if (clip) {
        const rect = clip.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const mode = dx <= HANDLE_W ? 'l' : (rect.width - dx <= HANDLE_W ? 'r' : 'm');
        const cid = clip.dataset.id;
        const ca = +clip.dataset.a, cb = +clip.dataset.b;
        const additive = !!(e.ctrlKey || e.metaKey || e.shiftKey);

        /* 点一条没被选中的 = 单选它；点在「已经多选」的其中一条上 = 保留整组 */
        if (!isClipSelected(cid, ca, cb)) {
          if (additive && selClips.length) setClipSel(selClips.concat([{ id: cid, a: ca, b: cb }]), { id: cid, a: ca, b: cb });
          else setClipSel([{ id: cid, a: ca, b: cb }]);
        } else {
          setClipSel(selClips, { id: cid, a: ca, b: cb });   /* 只换「主选」 */
        }
        lastPickedId = cid;
        clearKeySel();              /* 选中长条就不再认关键帧多选，两套选择互斥 */
        markRow(cid);
        cv.querySelectorAll('.ts-clip').forEach((el) => {
          el.classList.toggle('sel', isClipSelected(el.dataset.id, +el.dataset.a, +el.dataset.b));
        });

        /* 多选 + 抓中间 = 整组平移；抓两端只动这一条 */
        const group = (mode === 'm' && selClips.length > 1) ? selClips.slice() : null;
        const els = [];
        if (group) {
          group.forEach((c) => {
            const el = cv.querySelector('.ts-clip[data-id="' + c.id + '"][data-a="' + c.a + '"][data-b="' + c.b + '"]');
            if (el) els.push({ c: c, el: el });
          });
        }

        drag = {
          kind: 'clip',
          id: cid,
          si: +clip.dataset.si,
          a: ca,
          b: cb,
          mode,
          startX: e.clientX,
          d: 0,
          el: clip,
          group: group,
          els: els,
          moved: false
        };
        (group ? els.map(x => x.el) : [clip]).forEach(el => el.classList.add('dragging', 'drag-' + mode));
        try { cv.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
        return;
      }

      /* v7.4.5：面板任意空白处都能起框选 —— 轨道行、左侧标签列、刻度尺、行间空隙都算。
         短按 = 跳帧 + 选中这一行的元件；按住拖 = 框选多条长条。
         （长条、关键帧、把手、缩放/眼睛按钮在上面已经各自 return，摸不到这里。） */
      const rowEl = e.target.closest('.ts-row[data-id]');
      /* 列的起点以任意一条 lane 为准：它们左端对齐，横向滚动时也跟着一起动；
         canvas 本身是视口，拿它算会在滚动后错位。 */
      const refEl = e.target.closest('.ts-lane') || cv.querySelector('.ts-lane') || cv;
      const lr = refEl.getBoundingClientRect();
      paintMarquee();   /* v7.4.6：每次起手重新按当前主题上色 */
      drag = {
        kind: 'marquee',
        i: Math.floor((e.clientX - lr.left) / colW),
        rowId: rowEl ? rowEl.dataset.id : null,
        sx: e.clientX,
        sy: e.clientY,
        rect: null,
        moved: false
      };
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      return;
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

    /* 双击某颗关键帧 = 选中这一整条轨上的所有关键帧（整轨平移 / 复制的最短路径） */
    cv.addEventListener('dblclick', (e) => {
      const kEl = e.target.closest('.ts-key');
      if (!kEl) return;
      selectTrackKeys(kEl.dataset.id);
      e.preventDefault();
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

      if (drag.kind === 'keys') {
        const raw = Math.round((e.clientX - drag.startX) / colW);
        const d = clampKeyDelta(drag.items, raw);
        if (d === drag.d) return;
        drag.d = d;
        drag.moved = d !== 0;
        /* 只挪 DOM，不碰数据 —— 整组一起走同一格数 */
        drag.els.forEach((x) => { x.el.style.left = ((x.i + d) * colW + colW / 2) + 'px'; });
        return;
      }

      /* 框选：空白处按住拖出一个选框，压到哪几条长条就选哪几条 */
      if (drag.kind === 'marquee') {
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;   /* 抖动阈值：短按还是当点击 */
        drag.moved = true;
        drag.rect = {
          x: Math.min(drag.sx, e.clientX), y: Math.min(drag.sy, e.clientY),
          w: Math.abs(dx), h: Math.abs(dy)
        };
        const el = marqueeEl();
        const cr = cv.getBoundingClientRect();
        el.hidden = false;
        el.style.left = (drag.rect.x - cr.left) + 'px';
        el.style.top = (drag.rect.y - cr.top) + 'px';
        el.style.width = drag.rect.w + 'px';
        el.style.height = drag.rect.h + 'px';
        const hits = clipsInRect(drag.rect);
        cv.querySelectorAll('.ts-clip').forEach((c) => {
          const on = hits.some(h => String(h.id) === c.dataset.id && h.a === +c.dataset.a && h.b === +c.dataset.b);
          c.classList.toggle('sel', on);
        });
        return;
      }

      const raw = Math.round((e.clientX - drag.startX) / colW);
      let d = raw;
      if (drag.group) {
        /* 整组平移：所有选中长条共用一套夹紧区间 */
        const bd = multiMoveBounds(drag.group);
        d = Math.max(bd.lo, Math.min(bd.hi, d));
      } else if (drag.mode === 'm') {
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
      if (drag.group) {
        drag.els.forEach((x) => {
          x.el.style.left = ((x.c.a + d) * colW) + 'px';
          const lab = x.el.querySelector('.ts-lab');
          if (lab) lab.textContent = (x.c.a + d + 1) + (x.c.b > x.c.a ? '–' + (x.c.b + d + 1) : '');
        });
        return;
      }
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
      if (st.kind === 'marquee') hideMarquee();
      if (st.els) st.els.forEach(x => x.el.classList.remove('dragging'));
      else if (st.el) st.el.classList.remove('dragging', 'drag-l', 'drag-r', 'drag-m');

      if (st.kind === 'marquee') {
        if (!st.moved) {
          /* 短按 = 跳帧；点在哪一行就把「这一行的长条」设为选中（已经选中的不会被清掉）。
             v7.4.6：以前这里会 clearClipSel + clearKeySel —— 点一下旁边空白，
             正在编辑的那条轨就掉了选中，很别扭。现在只有 Esc 才清选择。
             先跳帧再选：goToFrame 会重建 AppState.objects，反过来的话选中的是旧对象。 */
          if (st.i >= 0 && st.i < totalFrames()) api.goToFrame(st.i);
          if (st.rowId) {
            lastPickedId = st.rowId;
            const segEl = clipAt(st.rowId, st.i);
            if (segEl) {
              setClipSel([{ id: st.rowId, a: +segEl.dataset.a, b: +segEl.dataset.b }]);
            }
            api.selectTrack(st.rowId);
            markRow(st.rowId);
          }
          render();
          return;
        }
        const hits = clipsInRect(st.rect || { x: 0, y: 0, w: 0, h: 0 });
        clearKeySel();
        if (!hits.length) {
          clearClipSel();
          render();
          api.toast(T('track.marqueeNone', '框选范围内没有长条 —— 要把框拖到长条上'));
          return;
        }
        /* 主选 = 最上面那条；用户框完直接按 Delete 就能整段删 */
        setClipSel(hits, hits[0]);
        render();
        api.toast(T('track.marqueeDone', '已选中 %n 段长条：可以整组拖动，或按删除').replace('%n', hits.length));
        return;
      }

      if (st.kind === 'keys') {
        if (!st.moved) {
          /* v7.4.4：点轨道上的关键帧也算「点了这一行」，顺手把这行的元件选上，
             用户点完就能直接去左上属性面板改它。
             v7.4.7：单颗点时先把播放头挪到这颗关键帧上 —— 不然点在一条
             「这一帧本来空白」的轨上，selectTrack 找不到元件，属性面板是空的。 */
          if (st.items.length) {
            if (st.items.length === 1 && st.items[0].i !== api.currentFrame()) {
              api.goToFrame(st.items[0].i);
            }
            api.selectTrack(st.items[0].id);
          }
          return;
        }
        if (st.items.length === 1) {
          const one = st.items[0];
          withTx(st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'),
            () => applyKeyDrag({ id: one.id, i: one.i, alt: st.alt }, one.i + st.d));
        } else {
          withTx(st.alt ? T('track.keyCopyLabel', '复制关键帧到落点') : T('track.keyMoveLabel', '移动关键帧'),
            () => applyKeysDrag(st));
        }
        render();
        return;
      }

      if (!st.moved) {
        /* 没拖动 = 点选：只选中这个元件和这条长条，不切子轨、不动帧号 */
        api.selectTrack(st.id);
        render();
        return;
      }
      if (st.group) {
        withTx(T('track.moveClipLabel', '整体移动长条'), () => applyClipsMove(st.group, st.d));
      } else {
        withTx(T('track.dragLabel', '调整轨道'), () => applyDrag(st, st.d));
      }
      render();
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', finish);
  }

  /* 键盘：Ctrl/⌘+C 复制、Ctrl/⌘+V 粘贴、Delete 删除选中的关键帧、Esc 取消选择。
     用捕获阶段 + stopPropagation：只有在「真的选了关键帧」时才拦，
     其余情况一律放行给 app.js 原来的快捷键（删元件、复制元件…）。 */
  function bindKeys() {
    if (document.body.dataset.tsKeys === '1') return;
    document.body.dataset.tsKeys = '1';
    document.addEventListener('keydown', (e) => {
      if (!enabled) return;
      const el = e.target;
      const tag = (el && el.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      const mod = !!(e.ctrlKey || e.metaKey);
      const has = selKeys.size > 0;

      if (mod && (e.key === 'c' || e.key === 'C')) {
        if (!has) return;
        e.preventDefault(); e.stopPropagation();
        copyKeys();
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        if (!keyClip) return;
        e.preventDefault(); e.stopPropagation();
        pasteKeys();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (has) {
          e.preventDefault(); e.stopPropagation();
          deleteSelKeys();
          return;
        }
        /* 没选关键帧但要删「框选出来的一整组」→ 删这几段。
           只选了一条时不抢 Delete：那时候 Delete 还是删元件（和以前一样）。 */
        if (selClips.length > 1) {
          e.preventDefault(); e.stopPropagation();
          deleteClip();
        }
        return;
      }
      if (e.key === 'Escape' && (has || selClips.length)) {
        clearKeySel();
        clearClipSel();
        render();
        return;
      }
    }, true);
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

  /* 轨道模式下，「关键帧 / 复制 / 粘贴」按钮要认轨道里的选中状态，而不是子轨选择器。
     用捕获阶段先拦下来，再 stopPropagation —— 这样不必改动 app.js 里原来的监听。 */
  function bindToolbar() {
    const tl = $('timeline');
    if (!tl || tl.dataset.tsTools === '1') return;
    tl.dataset.tsTools = '1';
    tl.addEventListener('click', (e) => {
      if (!enabled) return;
      if (e.target.closest('#btnKeyframe')) {
        e.stopPropagation();
        e.preventDefault();
        toggleKey();
        return;
      }
      if (e.target.closest('#btnTrackKeyCopy')) {
        e.stopPropagation();
        e.preventDefault();
        copyKeys();
        return;
      }
      if (e.target.closest('#btnTrackKeyPaste')) {
        e.stopPropagation();
        e.preventDefault();
        pasteKeys();
      }
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
    if (!enabled) { clearClipSel(); selKeys.clear(); }

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
      bindKeys();

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
    getColW() { return colW; },

    /* 调试 / 测试入口（也方便以后接右键菜单） */
    copyKeys,
    pasteKeys,
    deleteSelKeys,
    /* 长条选择（框选 / 多选）的调试入口 */
    selectedClips() { return selClips.slice(); },
    clearClipSel() { clearClipSel(); if (enabled) render(); },
    deleteClips() { deleteClip(); },
    selectAllKeys(id) { selectTrackKeys(id); },
    selectedKeys() { return liveSelKeys(); },
    hasClip() { return !!(keyClip && keyClip.items.length); },
    clearKeySel() { clearKeySel(); if (enabled) render(); }
  };

  root.SKFE.features.trackStrip = TrackStrip;
})();
