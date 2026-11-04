// js/features/color-tools.js
window.SKFE = window.SKFE || {};
SKFE.features = SKFE.features || {};

SKFE.features.colorTools = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  const SWATCH_KEY = 'skfe_color_swatches_v1';
  const DEFAULT_SWATCHES = ['#111111', '#ffffff', '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b', '#f4f6f9'];
  const swatchPopover = document.getElementById('swatchPopover');
  const swatchGrid = document.getElementById('swatchGrid');
  const btnCloseSwatches = document.getElementById('btnCloseSwatches');
  const btnSaveSwatch = document.getElementById('btnSaveSwatch');
  const colorPickHint = document.getElementById('colorPickHint');
  const colorPickHintText = document.getElementById('colorPickHintText');
  const btnCancelPick = document.getElementById('btnCancelPick');

  let savedSwatches = [];
  let swatchTargetInput = null;
  let swatchPopoverOpen = false;
  let pickState = null;
  let pickDown = false;
  let colorToastEl = null;

  function loadSwatches() {
    try {
      const raw = localStorage.getItem(SWATCH_KEY);
      if (raw === null) { savedSwatches = DEFAULT_SWATCHES.slice(); persistSwatches(); return; }
      const arr = JSON.parse(raw);
      savedSwatches = Array.isArray(arr)
        ? arr.filter(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 60)
        : [];
    } catch (_) { savedSwatches = DEFAULT_SWATCHES.slice(); }
  }
  function persistSwatches() {
    try { localStorage.setItem(SWATCH_KEY, JSON.stringify(savedSwatches)); } catch (_) {}
  }

  function showColorToast(msg) {
    if (!colorToastEl) {
      colorToastEl = document.createElement('div');
      colorToastEl.className = 'ui-toast color-toast';
      document.body.appendChild(colorToastEl);
    }
    colorToastEl.textContent = msg;
    colorToastEl.style.display = 'block';
    colorToastEl.style.opacity = '1';
    clearTimeout(colorToastEl._timer);
    colorToastEl._timer = setTimeout(() => {
      colorToastEl.style.opacity = '0';
      setTimeout(() => { colorToastEl.style.display = 'none'; }, 260);
    }, 1400);
  }

  function applyColorToInput(input, color) {
    if (!input) return;
    input.value = color;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderSwatches() {
    if (!swatchGrid) return;
    swatchGrid.innerHTML = '';
    if (!savedSwatches.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-empty';
      empty.textContent = '还没有保存的颜色';
      swatchGrid.appendChild(empty);
      return;
    }
    savedSwatches.forEach(color => {
      const item = document.createElement('div');
      item.className = 'sp-item';
      item.style.background = color;
      item.title = color;
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      if (swatchTargetInput && swatchTargetInput.value.toLowerCase() === color.toLowerCase()) item.classList.add('active');
      item.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        applyColorToInput(swatchTargetInput, color);
        renderSwatches();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sp-del';
      del.textContent = '×';
      del.title = '删除该颜色';
      del.setAttribute('aria-label', '删除该颜色');
      del.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        savedSwatches = savedSwatches.filter(c => c.toLowerCase() !== color.toLowerCase());
        persistSwatches();
        renderSwatches();
      });
      item.appendChild(del);
      swatchGrid.appendChild(item);
    });
  }

  function openSwatches(input, anchor) {
    swatchTargetInput = input;
    swatchPopoverOpen = true;
    renderSwatches();
    swatchPopover.style.display = 'block';
    const r = anchor.getBoundingClientRect();
    const pw = swatchPopover.offsetWidth || 236;
    const ph = swatchPopover.offsetHeight || 220;
    let left = r.right - pw;
    let top = r.bottom + 8;
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    swatchPopover.style.left = Math.max(8, left) + 'px';
    swatchPopover.style.top = Math.max(8, top) + 'px';
  }

  function closeSwatches() {
    swatchPopoverOpen = false;
    swatchTargetInput = null;
    if (swatchPopover) swatchPopover.style.display = 'none';
  }

  function sampleCanvasColor(clientX, clientY) {
    const canvas = D.getCanvas();
    const ctx = D.getCtx();
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, r.width);
    const sy = canvas.height / Math.max(1, r.height);
    const px = Math.floor((clientX - r.left) * sx);
    const py = Math.floor((clientY - r.top) * sy);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      if (d[3] < 8) return D.getPageBgColor();
      return SKFE.core.colorUtils.rgbToHex(d[0], d[1], d[2]);
    } catch (_) { return null; }
  }

  function onPickPointerDown(e) {
    if (!pickState) return;
    e.preventDefault(); e.stopPropagation();
    pickDown = true;
    const c = sampleCanvasColor(e.clientX, e.clientY);
    if (c) { pickState.input.value = c; pickState.input.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function onPickPointerMove(e) {
    if (!pickState || !pickDown) return;
    e.preventDefault(); e.stopPropagation();
    const c = sampleCanvasColor(e.clientX, e.clientY);
    if (c) { pickState.input.value = c; pickState.input.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function onPickPointerUp(e) {
    if (!pickState) return;
    const wasDown = pickDown;
    pickDown = false;
    if (wasDown) {
      const color = pickState.input.value;
      pickState.input.dispatchEvent(new Event('change', { bubbles: true }));
      showColorToast('已取色 ' + color);
    }
    stopColorPick();
  }

  function stopColorPick() {
    if (!pickState) return;
    if (pickState.btn) pickState.btn.classList.remove('active');
    pickState = null;
    pickDown = false;
    document.body.classList.remove('color-picking');
    if (colorPickHint) colorPickHint.style.display = 'none';
    const canvas = D.getCanvas();
    canvas.removeEventListener('pointerdown', onPickPointerDown, true);
    canvas.removeEventListener('pointermove', onPickPointerMove, true);
    window.removeEventListener('pointerup', onPickPointerUp, true);
    window.removeEventListener('pointercancel', onPickPointerUp, true);
  }

  function startColorPick(input, btn) {
    if (!input) return;
    if (pickState) stopColorPick();
    closeSwatches();
    pickState = { input, btn, original: input.value };
    pickDown = false;
    document.body.classList.add('color-picking');
    if (colorPickHintText) colorPickHintText.textContent = '点击画布任意位置取色';
    if (colorPickHint) colorPickHint.style.display = 'flex';
    if (btn) btn.classList.add('active');
    const canvas = D.getCanvas();
    canvas.addEventListener('pointerdown', onPickPointerDown, true);
    canvas.addEventListener('pointermove', onPickPointerMove, true);
    window.addEventListener('pointerup', onPickPointerUp, true);
    window.addEventListener('pointercancel', onPickPointerUp, true);
  }

  function cancelColorPick() {
    if (!pickState) return;
    const inp = pickState.input;
    const orig = pickState.original;
    stopColorPick();
    if (inp && orig != null) {
      inp.value = orig;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function enhanceColorInputs() {
    document.querySelectorAll('input[type="color"]').forEach(inp => {
      if (inp.dataset.colorEnhanced) return;
      if (inp.closest('.tool-panel[data-tool="theme"]')) return;
      inp.dataset.colorEnhanced = '1';
      const wrap = document.createElement('span');
      wrap.className = 'color-enhance';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'color-tool-btn eyedropper';
      eye.textContent = '💧';
      eye.title = '画面吸色';
      eye.setAttribute('aria-label', '画面吸色');
      eye.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); startColorPick(inp, eye); });

      const pal = document.createElement('button');
      pal.type = 'button';
      pal.className = 'color-tool-btn palette';
      pal.innerHTML = '<span class="dot"></span>';
      pal.title = '预设颜色';
      pal.setAttribute('aria-label', '预设颜色');
      pal.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (swatchPopoverOpen && swatchTargetInput === inp) closeSwatches();
        else openSwatches(inp, pal);
      });

      wrap.appendChild(eye);
      wrap.appendChild(pal);
    });
  }

  function updateColorToolLabels() {
    document.querySelectorAll('.color-tool-btn.eyedropper').forEach(b => { b.title = '画面吸色'; });
    document.querySelectorAll('.color-tool-btn.palette').forEach(b => { b.title = '预设颜色'; });
    if (swatchPopoverOpen) renderSwatches();
  }

  /** 启动：绑定所有色板/吸色相关的按钮与全局监听（与原 app.js 中模块级绑定的时机一致） */
  function boot() {
    if (btnCloseSwatches) btnCloseSwatches.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closeSwatches(); });
    if (btnSaveSwatch) btnSaveSwatch.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!swatchTargetInput) return;
      const color = swatchTargetInput.value;
      if (!savedSwatches.some(c => c.toLowerCase() === color.toLowerCase())) {
        savedSwatches.unshift(color);
        savedSwatches = savedSwatches.slice(0, 60);
        persistSwatches();
      }
      renderSwatches();
      showColorToast('已取色 ' + color);
    });
    if (btnCancelPick) {
      const doCancelPick = (e) => { e.preventDefault(); e.stopPropagation(); cancelColorPick(); };
      btnCancelPick.addEventListener('pointerdown', doCancelPick);
      btnCancelPick.addEventListener('click', doCancelPick);
    }

    document.addEventListener('pointerdown', (e) => {
      if (!swatchPopoverOpen) return;
      if (swatchPopover && swatchPopover.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.color-tool-btn.palette')) return;
      closeSwatches();
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (pickState) { cancelColorPick(); return; }
      if (swatchPopoverOpen) closeSwatches();
    }, true);
  }

  return {
    init,
    boot,
    loadSwatches,
    persistSwatches,
    showColorToast,
    applyColorToInput,
    renderSwatches,
    openSwatches,
    closeSwatches,
    sampleCanvasColor,
    startColorPick,
    stopColorPick,
    cancelColorPick,
    enhanceColorInputs,
    updateColorToolLabels
  };
})();
