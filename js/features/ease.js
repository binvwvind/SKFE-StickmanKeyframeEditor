// js/features/ease.js
window.SKFE = window.SKFE || {};
SKFE.features = SKFE.features || {};

SKFE.features.ease = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  const TWEEN_EASE_PRESETS = {
    linear: { label: '匀速', bezier: [0, 0, 1, 1] },
    easeIn: { label: '缓入', bezier: [0.42, 0, 1, 1] },
    easeOut: { label: '缓出', bezier: [0, 0, 0.58, 1] },
    easeInOut: { label: '缓入缓出', bezier: [0.42, 0, 0.58, 1] }
  };

  function bezierAxis(t, p1, p2) {
    const mt = 1 - t;
    return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
  }
  function cubicBezierEase(x, x1, y1, x2, y2) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) {
      const cx = bezierAxis(t, x1, x2);
      if (Math.abs(cx - x) < 1e-6) break;
      if (cx < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return bezierAxis(t, y1, y2);
  }

  /**
   * 贝塞尔曲线查找：params 由调用方提供
   * params = { customEasePresets, tweenCustomBezier }
   */
  function getEaseBezier(key, params) {
    const customEasePresets = (params && params.customEasePresets) || [];
    const tweenCustomBezier = (params && params.tweenCustomBezier) || TWEEN_EASE_PRESETS.linear.bezier;
    if (key && key.startsWith('preset:')) {
      const id = key.slice(7);
      const p = customEasePresets.find(x => x.id === id);
      if (p) return p.bezier;
      return TWEEN_EASE_PRESETS.linear.bezier;
    }
    if (key === 'custom') return tweenCustomBezier;
    return (TWEEN_EASE_PRESETS[key] || TWEEN_EASE_PRESETS.linear).bezier;
  }

  function easeElastic1(t, damping, period) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const d = Math.max(0.1, damping);
    const p = Math.max(0.1, period);
    return 1 - Math.pow(2, -10 * d * t) * Math.cos(t * Math.PI * 2 / p);
  }

  function easeElastic2(t, period, skew) {
    if (t <= 0) return 0;
    const p = Math.max(0.05, period);
    const s = Math.max(-0.4, Math.min(0.4, skew)); 
    const peakPos = 0.5 + s; // 波峰在这个周期内的位置 (0到1之间)
    
    const phase = t / p; 
    const frac = phase - Math.floor(phase); // 获取当前是在单个波内的进度 (0~1)
    
    // 核心：将单周期内的进度扭曲，实现前陡后缓/前缓后陡，且每个波绝对一致
    let warpedFrac;
    if (frac < peakPos) {
        warpedFrac = (frac / peakPos) * 0.5;
    } else {
        warpedFrac = 0.5 + ((frac - peakPos) / (1 - peakPos)) * 0.5;
    }
    
    return (1 - Math.cos(warpedFrac * Math.PI * 2)) * 0.5;
  }

  /**
   * 缓动函数工厂：params 由调用方提供
   * params = { customEasePresets, elastic1Params, elastic2Params, tweenCustomBezier }
   */
  function getEaseFunction(key, params) {
    params = params || {};
    const customEasePresets = params.customEasePresets || [];
    const elastic1Params = params.elastic1Params || { damping: 0.6, period: 0.8 };
    const elastic2Params = params.elastic2Params || { period: 0.5, skew: 0 };
    const bezierParams = { customEasePresets, tweenCustomBezier: params.tweenCustomBezier };

    if (key && key.startsWith('preset:')) {
      const id = key.slice(7);
      const p = customEasePresets.find(x => x.id === id);
      if (p) {
        if (p.type === 'elastic1') return u => easeElastic1(u, p.params.damping, p.params.period);
        if (p.type === 'elastic2') return u => easeElastic2(u, p.params.period, p.params.skew);
        const b = p.bezier || TWEEN_EASE_PRESETS.linear.bezier;
        return u => cubicBezierEase(u, b[0], b[1], b[2], b[3]);
      }
      return u => u;
    }
    if (key === 'elastic1') return u => easeElastic1(u, elastic1Params.damping, elastic1Params.period);
    if (key === 'elastic2') return u => easeElastic2(u, elastic2Params.period, elastic2Params.skew);
    const b = getEaseBezier(key, bezierParams);
    return u => cubicBezierEase(u, b[0], b[1], b[2], b[3]);
  }

  function easeThumbPath(input) {
    let fn;
    if (typeof input === 'function') {
      fn = input;
    } else if (Array.isArray(input)) {
      fn = u => cubicBezierEase(u, input[0], input[1], input[2], input[3]);
    } else {
      fn = u => u;
    }
    const N = 32;
    let minY = 0, maxY = 1;
    const ys = [];
    for (let i = 0; i <= N; i++) {
      const y = fn(i / N);
      ys.push(y);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const range = Math.max(0.0001, maxY - minY);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const nx = 2 + u * 36;
      const ny = 26 - ((ys[i] - minY) / range) * 24;
      pts.push(nx.toFixed(1) + ',' + ny.toFixed(1));
    }
    return 'M' + pts.join(' L');
  }

  return {
    init,
    TWEEN_EASE_PRESETS,
    bezierAxis,
    cubicBezierEase,
    getEaseBezier,
    getEaseFunction,
    easeElastic1,
    easeElastic2,
    easeThumbPath
  };
})();
