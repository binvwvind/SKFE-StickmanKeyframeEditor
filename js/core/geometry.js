// js/core/geometry.js
window.SKFE = window.SKFE || {};
SKFE.core = SKFE.core || {};

SKFE.core.geometry = (function () {
  'use strict';

  const along = (p, ang, len) => ({ x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len });
  const norm = a => Math.atan2(Math.sin(a), Math.cos(a));

  function distToSeg(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const c1 = vx * wx + vy * wy;
    if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
    const c2 = vx * vx + vy * vy;
    if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
    const t = c1 / c2;
    return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
  }

  function worldToFigureLocal(fig, p) {
    let dx = p.x - fig.x, dy = p.y - fig.y;
    const rot = (fig.rot || 0) * Math.PI / 180;
    if (rot) {
      const c = Math.cos(-rot), s = Math.sin(-rot);
      const nx = dx * c - dy * s;
      const ny = dx * s + dy * c;
      dx = nx; dy = ny;
    }
    if (fig.mirror) dx = -dx;
    return { x: fig.x + dx, y: fig.y + dy };
  }

  return { along, norm, distToSeg, worldToFigureLocal };
})();
