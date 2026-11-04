// js/features/theme.js
window.SKFE = window.SKFE || {};
SKFE.features = SKFE.features || {};

SKFE.features.theme = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  const THEME_STORAGE_KEY = 'skfe_theme_v2';
  const DEFAULT_THEME = {
    canvasBg: '#faf7eb', canvasAlpha: 1,
    panelBg: '#b8db8e', panelAlpha: 0.62,
    btnBg: '#f3a787', btnHover: '#f5f9f0',
    primary: '#86c451',
    textMain: '#274f10', textSub: '#dc701d',
    borderColor: '#ffffff'
  };
  let themeConfig = { ...DEFAULT_THEME };

  const THEME_COLOR_FIELDS = {
    themeCanvasBg: 'canvasBg', themePanelBg: 'panelBg',
    themeBtnBg: 'btnBg', themeBtnHover: 'btnHover',
    themePrimary: 'primary', themeTextMain: 'textMain',
    themeTextSub: 'textSub', themeBorderColor: 'borderColor'
  };
  const THEME_ALPHA_FIELDS = { themeCanvasAlpha: 'canvasAlpha', themePanelAlpha: 'panelAlpha' };

  function getConfig() { return themeConfig; }

  function loadThemeConfig() {
    try {
      const raw = localStorage.getItem(THEME_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') themeConfig = { ...DEFAULT_THEME, ...saved };
    } catch (err) {}
  }
  function saveThemeConfig() {
    try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(themeConfig)); } catch (err) {}
  }

  function applyThemeConfig(cfg) {
    if (!cfg) cfg = themeConfig;
    const style = document.documentElement.style;
    style.setProperty('--bg-page', SKFE.core.colorUtils.themeHexToRgba(cfg.canvasBg, cfg.canvasAlpha));
    style.setProperty('--bg-panel', SKFE.core.colorUtils.themeHexToRgba(cfg.panelBg, cfg.panelAlpha));
    style.setProperty('--btn-bg', cfg.btnBg);
    style.setProperty('--btn-hover', cfg.btnHover);
    style.setProperty('--color-primary', cfg.primary);
    style.setProperty('--color-primary-hover', SKFE.core.colorUtils.themeMixHex(cfg.primary, '#000000', 0.12));
    style.setProperty('--color-primary-soft', SKFE.core.colorUtils.themeMixHex(cfg.primary, '#ffffff', 0.86));
    style.setProperty('--color-primary-soft-hover', SKFE.core.colorUtils.themeMixHex(cfg.primary, '#ffffff', 0.78));
    style.setProperty('--text-main', cfg.textMain);
    style.setProperty('--text-sub', cfg.textSub);
    style.setProperty('--border-color', cfg.borderColor);

    // 主题 → 画布背景同步，由 app.js 通过回调处理（theme.js 不直接碰 pageBgColor）
    D.onThemeApplied(cfg);
  }

  function syncThemeUI() {
    Object.keys(THEME_COLOR_FIELDS).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = themeConfig[THEME_COLOR_FIELDS[id]];
    });
    Object.keys(THEME_ALPHA_FIELDS).forEach(id => {
      const key = THEME_ALPHA_FIELDS[id];
      const el = document.getElementById(id);
      const val = Math.max(0, Math.min(1, Number(themeConfig[key])));
      if (el) el.value = val;
      const label = document.getElementById(id + 'Val');
      if (label) label.textContent = val.toFixed(2);
    });
  }

  function readThemeUI() {
    Object.keys(THEME_COLOR_FIELDS).forEach(id => {
      const el = document.getElementById(id);
      if (el && el.value) themeConfig[THEME_COLOR_FIELDS[id]] = el.value;
    });
    Object.keys(THEME_ALPHA_FIELDS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const key = THEME_ALPHA_FIELDS[id];
      const val = Math.max(0, Math.min(1, Number(el.value)));
      themeConfig[key] = val;
      const label = document.getElementById(id + 'Val');
      if (label) label.textContent = val.toFixed(2);
    });
  }

  function bindThemeInputs() {
    Object.keys(THEME_COLOR_FIELDS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => { readThemeUI(); applyThemeConfig(themeConfig); saveThemeConfig(); });
    });
    Object.keys(THEME_ALPHA_FIELDS).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => { readThemeUI(); applyThemeConfig(themeConfig); saveThemeConfig(); });
    });
    const resetBtn = document.getElementById('btnResetTheme');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        themeConfig = { ...DEFAULT_THEME };
        syncThemeUI();
        applyThemeConfig(themeConfig);
        saveThemeConfig();
      });
    }
  }

  /* ==================== 主题预设存储逻辑 ==================== */
  const THEME_PRESET_KEY = 'skfe_theme_presets_v1';
  let themePresets = [];

  function loadThemePresets() {
    try {
      const raw = localStorage.getItem(THEME_PRESET_KEY);
      
      // 如果本地没有任何记录（说明是第一次打开），就注入这4个默认预设
      if (raw === null) {
        const DEFAULT_THEME_PRESETS = [
          { 
            name: 'TSC', 
            config: { 
              canvasBg: '#faf7eb', canvasAlpha: 1,
              panelBg: '#b8db8e', panelAlpha: 0.62, 
              btnBg: '#f3a787', btnHover: '#f5f9f0', 
              primary: '#86c451', textMain: '#274f10', textSub: '#dc701d', borderColor: '#ffffff' 
            } 
          },
          { 
            name: 'Pink', 
            config: { 
              canvasBg: '#f9e8da', canvasAlpha: 1,
              panelBg: '#f9c3c5', panelAlpha: 0.36, 
              btnBg: '#f9e8da', btnHover: '#f0a29f', 
              primary: '#ed9e94', textMain: '#551029', textSub: '#b92d5d', borderColor: '#f9c3c5' 
            } 
          },
          { 
            name: 'Vic', 
            config: { 
              canvasBg: '#ffffff', canvasAlpha: 1,
              panelBg: '#1a1c1c', panelAlpha: 0.31, 
              btnBg: '#4b6665', btnHover: '#b2b2b2', 
              primary: '#29b9b4', textMain: '#00ccdf', textSub: '#b1e5ed', borderColor: '#0b0d0e' 
            } 
          },
          { 
            name: 'TDLTCO', 
            config: { 
              canvasBg: '#989898', canvasAlpha: 1,
              panelBg: '#823535', panelAlpha: 0.36, 
              btnBg: '#461010', btnHover: '#bf3b3b', 
              primary: '#212322', textMain: '#290606', textSub: '#b4b4b4', borderColor: '#bd6d6d' 
            } 
          }
        ];
        
        themePresets = DEFAULT_THEME_PRESETS.slice();
        localStorage.setItem(THEME_PRESET_KEY, JSON.stringify(themePresets));
      } else {
        themePresets = JSON.parse(raw);
      }
    } catch(e) { themePresets = []; }
  }

  function saveThemePresetsToStorage() {
    try {
      localStorage.setItem(THEME_PRESET_KEY, JSON.stringify(themePresets));
    } catch(e) {}
  }

  function updateThemePresetUI() {
    const listEl = document.getElementById('themePresetList');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (themePresets.length === 0) {
      listEl.innerHTML = '<div class="theme-preset-empty">暂无保存的主题</div>';
      return;
    }
    themePresets.forEach((p, index) => {
      const cfg = p.config;
      const item = document.createElement('div');
      item.className = 'theme-preset-item';
      
      // 利用 linear-gradient 从左到右拼合 8 个颜色
      item.style.background = `linear-gradient(to right, 
        ${cfg.canvasBg}, ${cfg.panelBg}, ${cfg.btnBg}, ${cfg.btnHover}, 
        ${cfg.primary}, ${cfg.textMain}, ${cfg.textSub}, ${cfg.borderColor}
      )`;
      
      const nameEl = document.createElement('span');
      nameEl.className = 'theme-preset-name';
      nameEl.textContent = p.name;
      
      const delBtn = document.createElement('div');
      delBtn.className = 'theme-preset-del';
      delBtn.textContent = '×';
      delBtn.title = '删除该预设';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        if (confirm('确定删除该主题预设吗？')) {
          themePresets.splice(index, 1);
          saveThemePresetsToStorage();
          updateThemePresetUI();
        }
      };
      
      item.onclick = () => {
        themeConfig = { ...DEFAULT_THEME, ...cfg };
        syncThemeUI();
        applyThemeConfig(themeConfig);
        saveThemeConfig();
      };
      
      item.appendChild(nameEl);
      item.appendChild(delBtn);
      listEl.appendChild(item);
    });
  }

  // 绑定保存预设按钮
  function bindPresetSaveButton() {
    const btnSaveThemePreset = document.getElementById('btnSaveThemePreset');
    const themePresetNameInput = document.getElementById('themePresetName');
    if (btnSaveThemePreset && themePresetNameInput) {
      btnSaveThemePreset.onclick = () => {
        const name = themePresetNameInput.value.trim() || ('主题 ' + (themePresets.length + 1));
        themePresets.push({ name, config: { ...themeConfig } });
        saveThemePresetsToStorage();
        updateThemePresetUI();
        themePresetNameInput.value = '';
      };
    }
  }

  /** 启动：与原 app.js 中主题区块的即时执行顺序保持一致 */
  function boot() {
    bindThemeInputs();
    bindPresetSaveButton();
    loadThemePresets();
    updateThemePresetUI();
  }

  return {
    init,
    boot,
    getConfig,
    loadThemeConfig,
    saveThemeConfig,
    applyThemeConfig,
    syncThemeUI,
    readThemeUI,
    bindThemeInputs,
    loadThemePresets,
    saveThemePresetsToStorage,
    updateThemePresetUI
  };
})();
