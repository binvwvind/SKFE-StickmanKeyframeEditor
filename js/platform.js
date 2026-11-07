/* js/platform.js —— 运行环境适配层
 *
 * 唯一职责：把「保存一个文件」这件事在不同运行环境下做对。
 *  - 浏览器 / 桌面 Electron：<a download>（Electron 会落到系统下载目录）
 *  - Capacitor 原生壳（Android/iOS）：a.download 是无效的（WebView 不处理），
 *    必须写成真实文件再调系统分享面板。
 */
window.SKFE = window.SKFE || {};

SKFE.platform = (function () {
  'use strict';

  function native() {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }

  function plugin(name) {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.onerror = () => reject(fr.error || new Error('read blob failed'));
      fr.readAsDataURL(blob);
    });
  }

  function dataUrlToBase64(dataUrl) {
    const s = String(dataUrl || '');
    const i = s.indexOf(',');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function dataUrlToBlob(dataUrl) {
    const s = String(dataUrl || '');
    const m = /^data:([^;,]+)?(;base64)?,/i.exec(s);
    if (!m) return new Blob([]);
    const mime = m[1] || 'application/octet-stream';
    if (m[2]) {
      const bin = atob(s.slice(m[0].length));
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: mime });
    }
    return new Blob([decodeURIComponent(s.slice(m[0].length))], { type: mime });
  }

  /* Web / 桌面：走浏览器下载 */
  function downloadViaAnchor(href, filename, revoke) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 2000);
  }

  /* 原生壳：写文件 + 系统分享 */
  async function saveNative(base64, filename) {
    const Fs = plugin('Filesystem');
    const Sh = plugin('Share');
    if (!Fs) throw new Error('Filesystem 插件未安装');
    const res = await Fs.writeFile({
      path: filename,
      data: base64,
      directory: 'CACHE',
      encoding: 'base64',
      recursive: true
    });
    if (Sh) {
      try {
        await Sh.share({ title: filename, url: res.uri });
        return true;
      } catch (_) { /* 用户取消分享也算成功 */ return true; }
    }
    alert('已保存到应用缓存目录：\n' + res.uri);
    return true;
  }

  /** 保存 Blob。返回 Promise<boolean>，调用方可忽略。 */
  async function saveBlob(blob, filename) {
    if (native()) {
      try {
        const b64 = await blobToBase64(blob);
        return await saveNative(b64, filename);
      } catch (err) {
        console.error('[platform] 原生保存失败，回退下载:', err);
      }
    }
    const url = URL.createObjectURL(blob);
    downloadViaAnchor(url, filename, true);
    return true;
  }

  /** 保存 dataURL（部分导出走 toDataURL）。 */
  async function saveDataURL(dataUrl, filename) {
    if (native()) {
      try {
        return await saveNative(dataUrlToBase64(dataUrl), filename);
      } catch (err) {
        console.error('[platform] 原生保存失败，回退下载:', err);
      }
    }
    downloadViaAnchor(dataUrl, filename, false);
    return true;
  }

  /** 统一入口：自动识别 Blob / dataURL。 */
  async function save(data, filename) {
    if (typeof data === 'string') return saveDataURL(data, filename);
    return saveBlob(data, filename);
  }

  return {
    isNative: native,
    save,
    saveBlob,
    saveDataURL,
    dataUrlToBlob,
    blobToBase64
  };
})();
