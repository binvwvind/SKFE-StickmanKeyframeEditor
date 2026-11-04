// js/core/color-utils.js
window.SKFE = window.SKFE || {};
SKFE.core = SKFE.core || {};

SKFE.core.colorUtils = (function () {
  'use strict';

  function darkenColor(hex, factor = 0.55) {
    let c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    let r = parseInt(c.substring(0, 2), 16);
    let g = parseInt(c.substring(2, 4), 16);
    let b = parseInt(c.substring(4, 6), 16);
    r = Math.floor(r * factor);
    g = Math.floor(g * factor);
    b = Math.floor(b * factor);
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function hexToRgb(hex) {
    const c = hex.replace('#', '');
    if (c.length === 3) return [parseInt(c[0] + c[0], 16), parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16)];
    return [parseInt(c.substring(0, 2), 16), parseInt(c.substring(2, 4), 16), parseInt(c.substring(4, 6), 16)];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
      const hex = Math.round(x).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  function lerpColor(c1, c2, t) {
    if (!c1 || !c2) return c1 || c2;
    try {
      const a = hexToRgb(c1), b = hexToRgb(c2);
      return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    } catch (e) { return c1; }
  }

  function themeHexToRgba(hex, alpha) {
    let h = String(hex || '#000000').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) h = '000000';
    const n = parseInt(h, 16);
    const a = Math.max(0, Math.min(1, Number(alpha)));
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function themeMixHex(hex, target, ratio) {
    const parse = (value) => {
      let h = String(value || '#000000').replace('#', '');
      if (h.length === 3) h = h.split('').map(c => c + c).join('');
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const a = parse(hex), b = parse(target);
    const r = Math.max(0, Math.min(1, Number(ratio)));
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * r).toString(16).padStart(2, '0')).join('');
  }

  return { darkenColor, hexToRgb, rgbToHex, lerpColor, themeHexToRgba, themeMixHex };
})();
