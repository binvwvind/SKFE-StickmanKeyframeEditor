// js/core/event-bus.js
window.SKFE = window.SKFE || {};
SKFE.core = SKFE.core || {};

SKFE.core.eventBus = (function () {
  'use strict';

  const EventBus = {
    events: {},
    on(event, callback) {
      if (!this.events[event]) this.events[event] = [];
      this.events[event].push(callback);
    },
    emit(event, ...args) {
      if (!this.events[event]) return;
      this.events[event].forEach(callback => {
        try { callback(...args); } catch (err) { console.error(`[EventBus] 事件 "${event}" 执行出错:`, err); }
      });
    }
  };

  return { EventBus };
})();
