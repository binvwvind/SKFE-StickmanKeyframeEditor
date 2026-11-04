// js/core/constants.js
window.SKFE = window.SKFE || {};
SKFE.core = SKFE.core || {};

SKFE.core.constants = (function () {
  'use strict';

  const P = { torso: 82, headR: 17, upperArm: 40, foreArm: 38, thigh: 45, shin: 45, lw: 6 };
  const TAU = Math.PI * 2;
  const displayY = y => -y;
  const TRACK_ALL_ID = 'all';

  return { P, TAU, displayY, TRACK_ALL_ID };
})();
