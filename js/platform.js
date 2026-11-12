/* js/platform.js —— 运行环境适配层
 *
 * 唯一职责：把「保存一个文件」这件事在不同运行环境下做对。
 *  - 浏览器 / 桌面 Electron：<a download>（Electron 会落到系统下载目录）
 *  - Capacitor 原生壳（Android/iOS）：a.download 是无效的（WebView 不处理），
 *    必须写成真实文件再调系统分享面板。
 *
 * v7.0.1 针对「安卓安装包导出全部失效」的修复：
 *  1. 原生判定不再只依赖 Capacitor.isNativePlatform（有些壳里它是 undefined，
 *     一失效就掉进 <a download> 分支 → WebView 里什么都不发生，而且毫无提示）；
 *  2. 写文件失败不再静默回退到下载（在安卓上等于什么都没做），改为明确报错；
 *  3. 写入目录按 CACHE → DOCUMENTS → DATA 依次尝试，分享失败也能拿到文件路径；
 *  4. 新增 diag()：手机上连点 5 次版本水印即可导出诊断报告，用来定位真机问题。
 *  5. 新增 healSW()：老安装包会在 WebView 里留下一个仍在生效的 Service Worker，
 *     它会一直把旧版 index.html / js 从缓存里发出来 —— 新包换了代码也白换。
 *     这里在原生壳里启动时把 SW 注册和缓存清掉并重载一次，属于「治旧账」。
 *
 * 关于写入目录（APK 内 res/xml/file_paths.xml 的真实覆盖范围）：
 *     <cache-path  name="my_cache_images" path="."/>   → covers CACHE
 *     <external-path name="my_images"      path="."/>   → covers DOCUMENTS
 *     没有 <files-path>                                → DATA 分享必然失败
 *   所以 CACHE 是唯一「写完能被分享出去」的可靠目录，其余只当兜底。
 */
window.SKFE = window.SKFE || {};

SKFE.platform = (function () {
  'use strict';

  /* 顺序有讲究：CACHE 一定在 file_paths.xml 覆盖内，优先用它。
     DOCUMENTS 落 external-path 覆盖内，可用但需要存储权限。
     DATA 落 /data/data/<pkg>/files，file_paths.xml 里没有 files-path，
     FileProvider 会直接抛 "Failed to find configured root"，只能最后兜底。 */
  const SAVE_DIRS = ['CACHE', 'DOCUMENTS', 'DATA'];
  const SHARE_SAFE = { CACHE: true, DOCUMENTS: true, DATA: false };

  function cap() { return window.Capacitor || null; }

  function native() {
    const C = cap();
    if (!C) return false;
    try {
      if (typeof C.isNativePlatform === 'function') return !!C.isNativePlatform();
    } catch (_) { /* 忽略，继续看其它信号 */ }
    if (typeof C.isNative === 'boolean') return C.isNative;
    /* 兜底：插件在就说明是原生壳，别因为缺个判定函数就掉进浏览器分支 */
    return !!(C.Plugins && (C.Plugins.Filesystem || C.Plugins.Share));
  }

  function plugin(name) {
    const C = cap();
    return (C && C.Plugins && C.Plugins[name]) || null;
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

  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return e.message || e.errorMessage || JSON.stringify(e);
  }

  /* 原生壳：写文件（多个目录依次尝试）+ 系统分享 */
  async function saveNative(base64, filename) {
    const Fs = plugin('Filesystem');
    if (!Fs || typeof Fs.writeFile !== 'function') {
      throw new Error('Filesystem 插件不可用（Capacitor.Plugins 里没有 Filesystem）');
    }
    let uri = null;
    let usedDir = null;
    let raw = null;
    const errs = [];
    for (const dir of SAVE_DIRS) {
      try {
        const r = await Fs.writeFile({
          path: filename,
          data: base64,
          directory: dir,
          encoding: 'base64',
          recursive: true
        });
        const u = (r && (r.uri || r.path)) || null;
        if (u) { uri = u; usedDir = dir; raw = r; break; }
        errs.push(dir + ': 无返回 uri');
      } catch (e) {
        errs.push(dir + ': ' + errText(e));
      }
    }
    if (!uri) throw new Error('写入失败 —— ' + errs.join(' / '));

    const Sh = plugin('Share');
    let shared = false;
    let shareErr = '';
    if (Sh && typeof Sh.share === 'function') {
      /* 先试 url，再试 files：不同 Capacitor / ROM 上两者支持度不一样 */
      try {
        await Sh.share({ title: filename, url: uri });
        shared = true;
      } catch (e1) {
        shareErr = errText(e1);
        try {
          await Sh.share({ title: filename, files: [uri] });
          shared = true;
          shareErr = '';
        } catch (e2) {
          shareErr += ' / ' + errText(e2);
        }
      }
    } else {
      shareErr = 'Share 插件不可用';
    }
    return { ok: true, uri: uri, dir: usedDir, shared: shared, shareErr: shareErr, raw: raw };
  }

  /* 原生保存完成后的统一收尾：没分享成功就把路径告诉用户，绝不静默 */
  function finishNative(info, filename) {
    if (info && info.shared) return true;
    const dir = (info && info.dir) || '';
    const msg = '已保存：' + filename +
      '\n路径：' + ((info && info.uri) || '（未知）') +
      ((info && info.shareErr) ? ('\n\n系统分享没有成功：' + info.shareErr) : '') +
      ((info && dir && !SHARE_SAFE[dir])
        ? ('\n\n注意：本次落在 ' + dir + ' 目录，这个位置不在 FileProvider 的授权范围内，' +
           '其它 App 大概率读不到它，请在应用内用「分享 / 导出」再试一次。')
        : '');
    try { alert(msg); } catch (_) {}
    return true;
  }

  /** 保存 Blob。返回 Promise<boolean>，调用方可忽略。 */
  async function saveBlob(blob, filename) {
    if (native()) {
      const b64 = await blobToBase64(blob);
      return finishNative(await saveNative(b64, filename), filename);
    }
    const url = URL.createObjectURL(blob);
    downloadViaAnchor(url, filename, true);
    return true;
  }

  /** 保存 dataURL（部分导出走 toDataURL）。 */
  async function saveDataURL(dataUrl, filename) {
    if (native()) {
      return finishNative(await saveNative(dataUrlToBase64(dataUrl), filename), filename);
    }
    downloadViaAnchor(dataUrl, filename, false);
    return true;
  }

  /** 统一入口：自动识别 Blob / dataURL。 */
  async function save(data, filename) {
    try {
      if (typeof data === 'string') return await saveDataURL(data, filename);
      return await saveBlob(data, filename);
    } catch (err) {
      /* 原生环境绝不静默回退（<a download> 在 WebView 里等于什么都没发生） */
      console.error('[platform] 保存失败:', err);
      const tail = native() ? '' : '\n\n（当前不在原生壳里，浏览器可能拦截了下载）';
      try { alert('导出失败：' + errText(err) + tail); } catch (_) {}
      return false;
    }
  }

  /* 老安装包遗留的 Service Worker 会一直发旧版 index.html / js，
     新包即使换了代码也跑不到。这里在原生壳里清一次，只清一次。 */
  const HEAL_KEY = 'skfe_sw_heal_v701';

  function inShellWebView() {
    if (native()) return true;
    /* Capacitor 安卓壳的 UA 一定带 "; wv)"（系统 WebView 标记）。
       普通 Chrome for Android 不带，所以不会误伤。 */
    return /;\s*wv\)/i.test(navigator.userAgent);
  }

  async function healSW() {
    if (!('serviceWorker' in navigator) && !(window.caches && caches.keys)) return false;
    if (!inShellWebView()) return false;
    let done = false;
    try { done = sessionStorage.getItem(HEAL_KEY) === '1'; } catch (_) {}
    if (done) return false;
    try { sessionStorage.setItem(HEAL_KEY, '1'); } catch (_) {}

    let killed = 0;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        try { if (await r.unregister()) killed++; } catch (_) {}
      }
    } catch (_) {}
    let wiped = 0;
    try {
      if (window.caches && caches.keys) {
        const ks = await caches.keys();
        for (const k of ks) {
          try { if (await caches.delete(k)) wiped++; } catch (_) {}
        }
      }
    } catch (_) {}
    /* 真的清到东西才重载；没清到就保持安静，免得白闪一下 */
    if (killed || wiped) {
      try { location.reload(); } catch (_) {}
      return true;
    }
    return false;
  }

  /* 真机自检：返回多行报告文本，供「连点 5 次水印」时显示 */
  async function diag() {
    const C = cap();
    const lines = [];
    lines.push('SKFE 导出诊断');
    lines.push('isNative: ' + native());
    lines.push('hasCapacitor: ' + !!C);
    if (C) {
      try { lines.push('Capacitor keys: ' + Object.keys(C).join(',')); } catch (_) {}
      lines.push('Plugins: ' + (C.Plugins ? Object.keys(C.Plugins).join(',') : '(无)'));
      lines.push('Filesystem: ' + !!plugin('Filesystem') + ' / Share: ' + !!plugin('Share'));
      try { lines.push('getPlatform: ' + (typeof C.getPlatform === 'function' ? C.getPlatform() : 'n/a')); } catch (_) {}
    }
    lines.push('secureContext: ' + window.isSecureContext);
    lines.push('UA: ' + navigator.userAgent);
    try {
      const regs = ('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistrations() : [];
      lines.push('SW 注册数: ' + regs.length);
      lines.push('SW 接管当前页: ' + !!navigator.serviceWorker.controller);
    } catch (e) {
      lines.push('SW 状态: 读取失败 ' + errText(e));
    }
    try {
      const ks = (window.caches && caches.keys) ? await caches.keys() : [];
      lines.push('Cache Storage: ' + (ks.length ? ks.join(',') : '(空)'));
    } catch (_) {}
    lines.push('目录可用性: CACHE(可分享) / DOCUMENTS(需权限) / DATA(FileProvider 未授权，分享会失败)');
    if (native()) {
      try {
        const r = await saveNative(btoa('skfe-diag'), 'skfe_diag_' + Date.now() + '.txt');
        lines.push('测试写入: OK → ' + r.uri + ' [' + r.dir + ']');
        lines.push('系统分享: ' + (r.shared ? 'OK' : ('失败 ' + r.shareErr)));
      } catch (e) {
        lines.push('测试写入: 失败 → ' + errText(e));
      }
    }
    return lines.join('\n');
  }

  /* 启动即自愈：异步跑，不阻塞主流程 */
  try { setTimeout(function () { healSW(); }, 0); } catch (_) {}

  return {
    isNative: native,
    save,
    saveBlob,
    saveDataURL,
    dataUrlToBlob,
    blobToBase64,
    healSW,
    diag
  };
})();
