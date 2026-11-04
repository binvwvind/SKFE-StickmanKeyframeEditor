// js/systems/autosave.js
window.SKFE = window.SKFE || {};
SKFE.systems = SKFE.systems || {};

SKFE.systems.autosave = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  const AUTO_ARCHIVE_DB_NAME = 'skfe_auto_archive_v1';
  const AUTO_ARCHIVE_STORE = 'projects';
  const AUTO_ARCHIVE_KEY = 'current';
  let autoArchiveDB = null;
  let autoArchiveEnabled = true;
  let autoArchiveTimer = null;
  let autoArchivePeriodicTimer = null;
  let autoArchiveSavePending = false;

  function openAutoArchiveDB() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(AUTO_ARCHIVE_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(AUTO_ARCHIVE_STORE)) db.createObjectStore(AUTO_ARCHIVE_STORE);
        };
        req.onsuccess = (e) => { autoArchiveDB = e.target.result; resolve(autoArchiveDB); };
        req.onerror = (e) => reject(e.target.error);
      } catch (err) { reject(err); }
    });
  }

  function saveToAutoArchive() {
    if (!autoArchiveEnabled || !autoArchiveDB || autoArchiveSavePending) return;
    autoArchiveSavePending = true;
    try {
      const data = D.collectData();
      const tx = autoArchiveDB.transaction(AUTO_ARCHIVE_STORE, 'readwrite');
      const store = tx.objectStore(AUTO_ARCHIVE_STORE);
      const req = store.put(data, AUTO_ARCHIVE_KEY);
      req.onsuccess = () => { autoArchiveSavePending = false; };
      req.onerror = (e) => { autoArchiveSavePending = false; };
      tx.onerror = () => { autoArchiveSavePending = false; };
    } catch (err) {
      autoArchiveSavePending = false;
      if (err.name === 'QuotaExceededError' || /quota/i.test(err.message)) {
        autoArchiveEnabled = false;
      }
    }
  }

  function scheduleAutoArchiveSave() {
    if (!autoArchiveEnabled) return;
    if (autoArchiveTimer) clearTimeout(autoArchiveTimer);
    autoArchiveTimer = setTimeout(saveToAutoArchive, 1200);
  }

  function loadFromAutoArchive() {
    return new Promise((resolve, reject) => {
      if (!autoArchiveDB) { reject('DB not open'); return; }
      try {
        const tx = autoArchiveDB.transaction(AUTO_ARCHIVE_STORE, 'readonly');
        const store = tx.objectStore(AUTO_ARCHIVE_STORE);
        const req = store.get(AUTO_ARCHIVE_KEY);
        req.onsuccess = (e) => resolve(e.target.result || null);
        req.onerror = (e) => reject(e.target.error);
      } catch (err) { reject(err); }
    });
  }

  function clearAutoArchive() {
    if (!autoArchiveDB) return;
    try {
      const tx = autoArchiveDB.transaction(AUTO_ARCHIVE_STORE, 'readwrite');
      const store = tx.objectStore(AUTO_ARCHIVE_STORE);
      store.delete(AUTO_ARCHIVE_KEY);
      tx.oncomplete = () => alert('自动存档已清除');
      tx.onerror = (e) => alert('清除失败: ' + e.target.error);
    } catch (err) {
      alert('清除失败: ' + err.message);
    }
  }

  function isEnabled() { return autoArchiveEnabled; }

  /** 启动：恢复链 + 事件监听 + 周期保存 + 清除按钮（与原 app.js 中的时机一致） */
  function boot() {
    openAutoArchiveDB()
      .then(() => loadFromAutoArchive())
      .then(data => { if (data) D.applyData(data); })
      .catch(err => { autoArchiveEnabled = false; });

    const btnClearAutoArchive = document.getElementById('btnClearAutoArchive');
    if (btnClearAutoArchive) {
      btnClearAutoArchive.onclick = () => {
        if (confirm('确定清除自动存档？此操作不可恢复。')) clearAutoArchive();
      };
    }

    window.addEventListener('beforeunload', () => saveToAutoArchive());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveToAutoArchive();
    });
    window.addEventListener('pagehide', () => saveToAutoArchive());
    autoArchivePeriodicTimer = setInterval(() => { if (autoArchiveEnabled) saveToAutoArchive(); }, 20000);
  }

  return {
    init,
    boot,
    isEnabled,
    openAutoArchiveDB,
    saveToAutoArchive,
    scheduleAutoArchiveSave,
    loadFromAutoArchive,
    clearAutoArchive
  };
})();
