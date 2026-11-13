/* SKFE minimal i18n runtime
 * Load order: js/locales/zh-CN.js -> js/locales/en.js -> js/i18n.js -> js/app.js
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'skfe_lang_v1';
  var DEFAULT_LANG = 'zh-CN';
  var warned = Object.create(null);

  function normalizeLang(lang) {
    if (!lang) return '';
    var value = String(lang).toLowerCase();
    if (value === 'zh' || value.indexOf('zh-') === 0) return 'zh-CN';
    if (value === 'en' || value.indexOf('en-') === 0) return 'en';
    return '';
  }

  function getLang() {
    var stored = '';
    try { stored = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { stored = ''; }
    var lang = normalizeLang(stored);
    if (!lang) lang = normalizeLang(document.documentElement.getAttribute('lang')) || DEFAULT_LANG;
    return lang;
  }

  function dictFor(lang) {
    var all = window.SKFE_LOCALES || {};
    return all[lang] || null;
  }

  function t(key, vars) {
    var lang = getLang();
    var dict = dictFor(lang) || dictFor(DEFAULT_LANG) || {};
    var text = dict[key];
    if (text === undefined) {
      var fallback = dictFor(DEFAULT_LANG) || {};
      if (fallback[key] !== undefined) text = fallback[key];
    }
    if (text === undefined) {
      if (!warned[key]) {
        warned[key] = true;
        console.warn('[i18n] missing:', key, '(' + lang + ')');
      }
      return key;
    }
    if (vars && typeof text === 'string') {
      text = text.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
      });
    }
    return text;
  }

  function applyEach(root, selector, apply) {
    var nodes = root.querySelectorAll ? root.querySelectorAll(selector) : [];
    for (var i = 0; i < nodes.length; i++) apply(nodes[i]);
    if (root.nodeType === 1 && root.matches && root.matches(selector)) apply(root);
  }

  function applyTranslations(root) {
    root = root || document;
    applyEach(root, '[data-i18n]', function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    applyEach(root, '[data-i18n-html]', function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    applyEach(root, '[data-i18n-title]', function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    });
    applyEach(root, '[data-i18n-placeholder]', function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    applyEach(root, '[data-i18n-label]', function (el) {
      el.setAttribute('label', t(el.getAttribute('data-i18n-label')));
    });
  }

  function setLang(lang) {
    var next = normalizeLang(lang) || DEFAULT_LANG;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    document.documentElement.setAttribute('lang', next);
    applyTranslations(document);
    if (typeof window.SKFEApplyIcons === 'function') window.SKFEApplyIcons(document);
    if (typeof window.SKFE_REFRESH_I18N === 'function') window.SKFE_REFRESH_I18N();
    return next;
  }

  window.SKFE_I18N = {
    t: t,
    applyTranslations: applyTranslations,
    setLang: setLang,
    getLang: getLang
  };
  window.t = t;
  window.applyTranslations = applyTranslations;
  window.setLang = setLang;
  window.getLang = getLang;

  document.documentElement.setAttribute('lang', getLang());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      applyTranslations(document);
      if (typeof window.SKFEApplyIcons === 'function') window.SKFEApplyIcons(document);
    });
  }
})();
