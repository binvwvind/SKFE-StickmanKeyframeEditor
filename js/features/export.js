// js/features/export.js
window.SKFE = window.SKFE || {};
SKFE.features = SKFE.features || {};

SKFE.features.export = (function () {
  'use strict';

  let D = null;
  function init(deps) { D = deps; }

  let jszipLoading = null;
  function getJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    if (jszipLoading) return jszipLoading;
    jszipLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => { jszipLoading = null; reject(new Error('JSZip load failed')); };
      document.head.appendChild(script);
    });
    return jszipLoading;
  }

  async function exportPNGsAsZip(frameList, trackId, options) {
    if (!frameList || !frameList.length) return;
    const btn = document.getElementById('btnExportPNGSeq');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '准备打包...'; }
    
    try {
      const JSZip = await getJSZip();
      const zip = new JSZip();
      const outW = options.outW;
      const outH = options.outH;
      const crop = options.crop;
      const transparent = options.transparent;

      for (let i = 0; i < frameList.length; i++) {
        if (btn) btn.textContent = `打包中 ${i + 1}/${frameList.length}`;
        const fr = frameList[i];
        const idx = D.AppState.frames.indexOf(fr);
        const safeIdx = idx >= 0 ? idx : 0;
        
        const off = D.renderFrameToDataURL(fr, outW, outH, { transparent, crop }, trackId);
        const dataUrl = off.toDataURL('image/png');
        const base64Data = dataUrl.split(',')[1];
        
        const fileName = `frame_${String(safeIdx + 1).padStart(3, '0')}.png`;
        zip.file(fileName, base64Data, { base64: true });
        
        if (i % 5 === 4) await new Promise(r => setTimeout(r, 0)); // 防卡顿
      }

      if (btn) btn.textContent = '生成 ZIP...';
      const blob = await zip.generateAsync({ type: 'blob' });
      SKFE.platform.save(blob, 'stickman_frames_' + Date.now() + '.zip');
      
    } catch (err) {
      console.warn('ZIP打包失败，降级为逐个下载', err);
      alert('ZIP 库加载失败，将自动降级为逐个下载（若浏览器拦截请在地址栏允许）。');
      // 降级逻辑
      const urls = frameList.map(fr => {
        const idx = D.AppState.frames.indexOf(fr);
        const safeIdx = idx >= 0 ? idx : 0;
        const off = D.renderFrameToDataURL(fr, options.outW, options.outH, { transparent: options.transparent, crop: options.crop }, trackId);
        return { url: off.toDataURL('image/png'), label: safeIdx + 1 };
      });
      urls.forEach((u, i) => {
        setTimeout(() => {
          SKFE.platform.save(u.url, `frame_${String(u.label).padStart(3, '0')}.png`);
        }, i * 150);
      });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
      D.EventBus.emit('need:render');
    }
  }

  let gifencLib = null;
  async function getGifenc() {
    if (gifencLib) return gifencLib;
    const mod = await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js');
    gifencLib = mod;
    return mod;
  }

  async function exportGIF(frameList, trackId) {
    let tid = (trackId != null && trackId !== D.TRACK_ALL_ID) ? String(trackId) : null;
    if (trackId === undefined && D.isSubTrackMode()) tid = String(D.AppState.activeTrackId);
    const list = (frameList && frameList.length) ? frameList : D.AppState.frames;
    if (list.length === 0) return;
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const transparent = document.getElementById('gifTransparent').checked;
    const _sz = D.getExportSize();
    const outW = _sz.w, outH = _sz.h;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let gifenc;
    try { gifenc = await getGifenc(); }
    catch (e) {
      if (confirm('GIF 编码库加载失败（可能没有网络）。\n是否改为导出 PNG 序列？')) exportPNGSeq();
      return;
    }
    const { GIFEncoder, quantize, applyPalette } = gifenc;
    const gif = GIFEncoder();
    const btn = document.getElementById('btnExportGIF');
    const oldText = btn.textContent;
    btn.disabled = true;
    
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const crop = cam ? null : D.getCropForFrames(list, outW, outH, tid);
    try {
      /* ---------- 步骤 1：渲染并二值化 alpha ---------- */
      const renderedFrames = [];
      for (let i = 0; i < list.length; i++) {
        btn.textContent = `GIF ${i + 1}/${list.length}`;
        const off = D.renderFrameToDataURL(list[i], outW, outH, { transparent, crop }, tid);
        const imgData = off.getContext('2d').getImageData(0, 0, outW, outH);
        if (transparent) {
          const data = imgData.data;
          for (let p = 3; p < data.length; p += 4) data[p] = data[p] >= 128 ? 255 : 0;
        }
        renderedFrames.push(imgData);
        if (i % 2 === 1) await new Promise(r => setTimeout(r, 0));
      }

      /* ---------- 步骤 2：采样不透明像素 ----------
         - 采样密度：每 2 像素（之前 16 像素太稀疏 → 调色板缺色 → 闪烁）
         - 跳过透明像素（避免透明色占不透明色槽位） */
      btn.textContent = '量化...';
      const samplePixels = [];
      for (let i = 0; i < renderedFrames.length; i++) {
        const data = renderedFrames[i].data;
        for (let j = 0; j < data.length; j += 4 * 2) {
          if (transparent && data[j + 3] < 128) continue;
          samplePixels.push(data[j], data[j + 1], data[j + 2], 255);
        }
      }
      if (samplePixels.length === 0) {
        alert('当前所有帧都是空白，无法导出 GIF');
        return;
      }
      const sampleArr = new Uint8ClampedArray(samplePixels);

      /* ---------- 步骤 3：构建稳定调色板 ----------
         透明模式用 rgb565（5/6/5 bit 精度，比 rgba4444 高 4 倍）
         索引 0 手动占位给透明，其余 255 槽给不透明色
         相同颜色每帧都映射到同一索引 → 不会闪烁 */
      let globalPalette;
      let opaquePalette = null;
      let useFormat = 'rgb565';

      if (transparent) {
        try {
          opaquePalette = quantize(sampleArr, 255, { format: 'rgb565' });
          useFormat = 'rgb565';
        } catch (err) {
          /* 兜底：极老版本 gifenc 可能不认 rgb565 */
          opaquePalette = quantize(sampleArr, 255, { format: 'rgba4444' });
          useFormat = 'rgba4444';
        }
        /* 统一为 4 分量，索引 0 = 纯透明 */
        globalPalette = [[0, 0, 0, 0]].concat(
          opaquePalette.map(c => [c[0], c[1], c[2], 255])
        );
      } else {
        globalPalette = quantize(sampleArr, 256, { format: 'rgb565' });
      }

      /* ---------- 步骤 4：逐帧写 GIF ---------- */
      for (let i = 0; i < renderedFrames.length; i++) {
        btn.textContent = `GIF ${i + 1}/${renderedFrames.length}`;
        const imgData = renderedFrames[i];
        const data = imgData.data;
        const delay = Math.max(10, list[i].duration | 0);

        let index;
        if (transparent) {
          /* rgb565 格式忽略 alpha 做最近邻匹配，再手工覆盖透明像素 */
          index = applyPalette(data, opaquePalette, useFormat);
          for (let k = 0; k < data.length; k += 4) {
            if (data[k + 3] < 128) {
              index[k >> 2] = 0;                                /* 透明 → 索引 0 */
            } else {
              index[k >> 2] = Math.min(255, index[k >> 2] + 1); /* 不透明 → 偏移 +1 */
            }
          }
        } else {
          index = applyPalette(data, globalPalette, 'rgb565');
        }

        gif.writeFrame(index, outW, outH, {
          palette: globalPalette,
          delay,
          transparent,
          transparentIndex: transparent ? 0 : undefined
        });
        await new Promise(r => setTimeout(r, 0));
      }

      gif.finish();
      const bytes = gif.bytes();
      const blob = new Blob([bytes], { type: 'image/gif' });
      if (isIOS) {
        const reader = new FileReader();
        reader.onload = function (e) {
          const dataUrl = e.target.result;
          const overlay = document.createElement('div');
          overlay.className = 'ios-save-overlay';
          overlay.innerHTML = `
            <div class="ios-save-title">请长按下方图片，选择“存储到照片”</div>
            <img src="${dataUrl}" class="ios-save-img">
            <button class="btn-primary ios-save-btn" onclick="this.parentElement.remove()">完成 / 关闭</button>
          `;
          document.body.appendChild(overlay);
        };
        reader.readAsDataURL(blob);
      } else {
        SKFE.platform.save(blob, 'stickman_anim_' + Date.now() + (transparent ? '_transparent' : '') + '.gif');
      }
    } catch (e) {
      alert('GIF 导出失败：' + e.message);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
      D.EventBus.emit('need:render');
    }
  }

  /* ==================== WebM 视频 ==================== */
  async function exportVideo() {
    if (D.AppState.frames.length === 0) return;
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const tid = D.isSubTrackMode() ? String(D.AppState.activeTrackId) : null;
    const outW = 800, outH = 800;
    const crop = D.getExportCrop(outW, outH, tid);
    const recCanvas = document.createElement('canvas');
    recCanvas.width = outW; recCanvas.height = outH;
    const recCtx = recCanvas.getContext('2d', { alpha: true });
    const stream = recCanvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    let mimeType = 'video/webm';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mimeType = 'video/webm;codecs=vp9';
    else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) mimeType = 'video/webm;codecs=vp8';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const blobPromise = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    const savedCtx = D.getCtx();
    D.setCtx(recCtx);
    /* v7.4.6：只录到「最后一个有内容的帧」，时间轴尾巴上的空白帧不要 */
    const vN = contentFrameCount(tid);
    try {
      for (let i = 0; i < vN; i++) {
        recCtx.save();
        recCtx.setTransform(1, 0, 0, 1, 0, 0);
        recCtx.clearRect(0, 0, outW, outH);
        recCtx.fillStyle = D.getPageBgColor();
        recCtx.fillRect(0, 0, outW, outH);
        recCtx.translate(outW / 2, outH / 2);
        if (crop.rotation) recCtx.rotate(-crop.rotation);
        recCtx.scale(crop.scale, crop.scale);
        recCtx.translate(-crop.cx, -crop.cy);
        if (D.AppState.canvasBoundsEnabled) {
          recCtx.save();
          recCtx.translate(D.AppState.canvasBounds.x + D.AppState.canvasBounds.w / 2, D.AppState.canvasBounds.y + D.AppState.canvasBounds.h / 2);
          recCtx.rotate(D.AppState.canvasBounds.rotation || 0);
          recCtx.beginPath();
          recCtx.rect(-D.AppState.canvasBounds.w / 2, -D.AppState.canvasBounds.h / 2, D.AppState.canvasBounds.w, D.AppState.canvasBounds.h);
          recCtx.clip();
          recCtx.restore();
        }
        D.renderScene(D.getObjectsForFrameAt(i, tid), { isExporting: true });
        recCtx.restore();
        if (track.requestFrame) track.requestFrame();
        await new Promise(r => setTimeout(r, D.AppState.frames[i].duration));
      }
    } catch (e) {
      alert('导出失败：' + e.message);
    } finally {
      D.setCtx(savedCtx);
      recorder.stop();
      D.EventBus.emit('need:render');
    }
    const blob = await blobPromise;
    SKFE.platform.save(blob, 'stickman_video_' + Date.now() + '.webm');
  }

  /* ==================== MP4 ====================
     v7.4.6：两条路。
     ① 浏览器自带 MP4 录制（桌面 Chrome / Edge 有）—— 直接用 MediaRecorder，实时录。
     ② 移动端（Android Chrome / WebView）没有 MediaRecorder('video/mp4')，
        以前直接弹「不支持」就没了。现在改走 WebCodecs 的 VideoEncoder(H.264)
        + 内置的 mp4-muxer 封装成真正的 MP4 —— 不依赖实时录制，画多快编多快。 */
  function getMP4MimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4;codecs=h264', 'video/mp4'];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return null;
  }

  /* 有没有「WebCodecs 编码 + mp4 封装」这一套 */
  function canEncodeMp4() {
    return typeof window.VideoEncoder !== 'undefined' &&
      typeof window.VideoFrame !== 'undefined' &&
      !!(window.Mp4Muxer && window.Mp4Muxer.Muxer && window.Mp4Muxer.ArrayBufferTarget);
  }

  async function pickAvcConfig(w, h, fps, bitrate) {
    /* 基线 / 主档 / 高档都试一遍：不同机器的硬编码器支持的不一样。
       42001f = Baseline 3.1，420028 = Baseline 4.0，4d0028 = Main 4.0，640028 = High 4.0 */
    const cands = ['avc1.42001f', 'avc1.420028', 'avc1.4d0028', 'avc1.640028', 'avc1.42E01E'];
    for (const codec of cands) {
      try {
        const cfg = { codec: codec, width: w, height: h, bitrate: bitrate, framerate: fps, avc: { format: 'avc' } };
        const r = await window.VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return cfg;
      } catch (_) {}
    }
    return null;
  }

  /* 导出到「最后一个有内容的帧」为止 —— 时间轴尾巴上那些谁都没出场的空白帧不要录进去 */
  function contentFrameCount(tid) {
    const total = D.AppState.frames.length;
    const ids = tid ? [String(tid)] : Object.keys(D.AppState.tracks || {});
    let last = -1;
    ids.forEach((id) => {
      const t = D.AppState.tracks[id];
      if (!t || !t.frames) return;
      for (let i = 0; i < t.frames.length; i++) {
        const f = t.frames[i];
        if (f && !(f.__d)) last = Math.max(last, i);
      }
    });
    if (last < 0) return total;
    return Math.min(total, last + 1);
  }

  /* 画布尺寸 / 取景 / 背景 —— 两条路共用 */
  function mp4Setup(tid) {
    const isHD = document.getElementById('gifHD3x').checked;
    const is1080 = !!(document.getElementById('hd1080p') && document.getElementById('hd1080p').checked);
    const bgColor = (document.getElementById('mp4BgColor') && document.getElementById('mp4BgColor').value) || D.getPageBgColor();
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const baseSize = is1080 ? 1920 : (isHD ? 1200 : 800);
    let outW, outH, baseCrop = null;
    if (cam && cam.w > 0 && cam.h > 0) {
      const a = cam.w / cam.h;
      if (a >= 1) { outW = baseSize; outH = Math.round(baseSize / a); }
      else { outH = baseSize; outW = Math.round(baseSize * a); }
    } else if (D.AppState.canvasBoundsEnabled) {
      const sz = D.getExportSize();
      outW = sz.w; outH = sz.h;
      baseCrop = {
        cx: D.AppState.canvasBounds.x + D.AppState.canvasBounds.w / 2,
        cy: D.AppState.canvasBounds.y + D.AppState.canvasBounds.h / 2,
        scale: Math.min(outW / D.AppState.canvasBounds.w, outH / D.AppState.canvasBounds.h),
        rotation: D.AppState.canvasBounds.rotation || 0
      };
    } else {
      outW = baseSize; outH = baseSize;
      const ec = D.getExportCrop(outW, outH, tid || null);
      baseCrop = { cx: ec.cx, cy: ec.cy, scale: ec.scale, rotation: ec.rotation || 0 };
    }
    outW = Math.max(2, outW - (outW % 2));
    outH = Math.max(2, outH - (outH % 2));
    return { outW: outW, outH: outH, baseCrop: baseCrop, cam: cam, bgColor: bgColor };
  }

  /* 把第 i 帧画到导出画布上（两条路共用，免得改一处漏一处） */
  function paintFrame(recCtx, i, plan, tid) {
    let curCrop = plan.baseCrop;
    if (plan.cam) {
      const frameCam = D.getCameraAtFrame(i) || plan.cam;
      const cc = D.cameraToCrop(frameCam, plan.outW, plan.outH);
      curCrop = { cx: cc.cx, cy: cc.cy, scale: cc.scale, rotation: cc.rotation || 0 };
    }
    recCtx.save();
    recCtx.setTransform(1, 0, 0, 1, 0, 0);
    recCtx.fillStyle = plan.bgColor;
    recCtx.fillRect(0, 0, plan.outW, plan.outH);
    recCtx.translate(plan.outW / 2, plan.outH / 2);
    if (curCrop) {
      if (curCrop.rotation) recCtx.rotate(-curCrop.rotation);
      recCtx.scale(curCrop.scale, curCrop.scale);
      recCtx.translate(-curCrop.cx, -curCrop.cy);
    }
    if (D.AppState.canvasBoundsEnabled) {
      recCtx.save();
      recCtx.translate(D.AppState.canvasBounds.x + D.AppState.canvasBounds.w / 2, D.AppState.canvasBounds.y + D.AppState.canvasBounds.h / 2);
      recCtx.rotate(D.AppState.canvasBounds.rotation || 0);
      recCtx.beginPath();
      recCtx.rect(-D.AppState.canvasBounds.w / 2, -D.AppState.canvasBounds.h / 2, D.AppState.canvasBounds.w, D.AppState.canvasBounds.h);
      recCtx.clip();
      recCtx.restore();
    }
    D.renderScene(D.getObjectsForFrameAt(i, tid), { isExporting: true });
    recCtx.restore();
  }

  /* ② WebCodecs 编码 → mp4-muxer 封装（移动端主用） */
  async function exportMP4WithEncoder(plan, tid) {
    const mux = window.Mp4Muxer;
    const n = contentFrameCount(tid);
    if (!n) throw new Error('没有可导出的帧');
    const fps = Math.max(1, Math.min(60, Math.round(1000 / ((D.AppState.frames[0] && D.AppState.frames[0].duration) || 83))));
    const bitrate = Math.max(800000, Math.round(plan.outW * plan.outH * fps * 0.12));
    const cfg = await pickAvcConfig(plan.outW, plan.outH, fps, bitrate);
    if (!cfg) throw new Error('这台设备的浏览器没有可用的 H.264 编码器');

    const recCanvas = document.createElement('canvas');
    recCanvas.width = plan.outW; recCanvas.height = plan.outH;
    const recCtx = recCanvas.getContext('2d', { alpha: false });

    const muxer = new mux.Muxer({
      target: new mux.ArrayBufferTarget(),
      video: { codec: 'avc', width: plan.outW, height: plan.outH, frameRate: fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset'
    });

    let encError = null;
    const encoder = new window.VideoEncoder({
      output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (_) {} },
      error: (e) => { encError = e; }
    });
    encoder.configure(cfg);

    const btn = document.getElementById('btnExportMP4');
    const oldText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; }
    const savedCtx = D.getCtx();
    D.setCtx(recCtx);
    let tUs = 0;
    try {
      for (let i = 0; i < n; i++) {
        if (encError) throw encError;
        if (btn) btn.textContent = `MP4 ${i + 1}/${n}`;
        paintFrame(recCtx, i, plan, tid);
        const frameObj = D.AppState.frames[i] || {};
        const durUs = Math.max(1000, Math.round((frameObj.duration || Math.round(1000 / fps)) * 1000));
        const vf = new window.VideoFrame(recCanvas, { timestamp: tUs, duration: durUs });
        encoder.encode(vf, { keyFrame: (i % Math.max(1, fps)) === 0 });
        vf.close();
        tUs += durUs;
        /* 编码是异步的：队列堆太多就喘一口气，顺便让进度文字刷出来 */
        if (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 8));
        else if (i % 6 === 0) await new Promise(r => setTimeout(r, 0));
      }
      await encoder.flush();
      muxer.finalize();
    } finally {
      try { encoder.close(); } catch (_) {}
      D.setCtx(savedCtx);
      if (btn) { btn.textContent = oldText; btn.disabled = false; }
      D.EventBus.emit('need:render');
    }
    if (encError) throw encError;
    const buf = muxer.target.buffer;
    if (!buf || !buf.byteLength) throw new Error('没有生成视频数据');
    SKFE.platform.save(new Blob([buf], { type: 'video/mp4' }), 'stickman_video_' + Date.now() + '.mp4');
  }

  /* ① 浏览器自带 MP4 录制（桌面） */
  async function exportMP4WithRecorder(plan, mimeType, tid) {
    const n = contentFrameCount(tid);
    const recCanvas = document.createElement('canvas');
    recCanvas.width = plan.outW; recCanvas.height = plan.outH;
    const recCtx = recCanvas.getContext('2d', { alpha: false });
    const stream = recCanvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    let recorder;
    try { recorder = new MediaRecorder(stream, { mimeType: mimeType }); }
    catch (e) { throw new Error('创建 MP4 录制器失败：' + e.message); }
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const blobPromise = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/mp4' })); });
    const btn = document.getElementById('btnExportMP4');
    const oldText = btn ? btn.textContent : '';
    if (btn) btn.disabled = true;
    recorder.start();
    const savedCtx = D.getCtx();
    D.setCtx(recCtx);
    try {
      for (let i = 0; i < n; i++) {
        if (btn) btn.textContent = `MP4 ${i + 1}/${n}`;
        paintFrame(recCtx, i, plan, tid);
        if (track.requestFrame) track.requestFrame();
        await new Promise(r => setTimeout(r, (D.AppState.frames[i] && D.AppState.frames[i].duration) || 83));
      }
    } finally {
      D.setCtx(savedCtx);
      recorder.stop();
      if (btn) { btn.textContent = oldText; btn.disabled = false; }
      D.EventBus.emit('need:render');
    }
    const blob = await blobPromise;
    if (!blob || blob.size === 0) throw new Error('未生成视频数据');
    SKFE.platform.save(blob, 'stickman_video_' + Date.now() + '.mp4');
  }

  /* 触屏移动端判定（v7.4.6）：手机上的 MediaRecorder 对 mp4 常常「嘴上说支持、录出来不是那么回事」，
     所以移动端有 WebCodecs 就优先走编码路，别再赌 MediaRecorder。 */
  function looksMobile() {
    try {
      const ua = navigator.userAgent || '';
      if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OpenHarmony/i.test(ua)) return true;
      /* iPadOS 13+ 的 UA 伪装成 Macintosh，靠触摸点数 + 没有精确指针补一刀 */
      if (navigator.maxTouchPoints > 1) {
        let fine = false;
        try { fine = window.matchMedia('(pointer: fine)').matches; } catch (_) {}
        if (!fine) return true;
      }
    } catch (_) {}
    return false;
  }

  async function exportMP4() {
    if (D.AppState.frames.length === 0) return;
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const tid = D.isSubTrackMode() ? String(D.AppState.activeTrackId) : null;
    const mimeType = getMP4MimeType();
    const encOk = canEncodeMp4();
    if (!mimeType && !encOk) {
      alert('这台设备的浏览器不支持 MP4 导出。\n可以先用「导出 GIF」或「导出 PNG 序列」，或换 Chrome / Edge 桌面版。');
      return;
    }
    const plan = mp4Setup(tid);
    /* 选路（v7.4.6）：
       移动端 / 根本没有 mp4 录制能力 → 先走 WebCodecs 编码；
       桌面且能录 mp4 → 先走 MediaRecorder（老路径，行为不变）。
       两条路都留着，前一条抛错就自动换另一条再试一次，最后才报错。 */
    const preferEncoder = encOk && (!mimeType || looksMobile());
    const steps = [];
    if (preferEncoder) {
      steps.push(() => exportMP4WithEncoder(plan, tid));
      if (mimeType) steps.push(() => exportMP4WithRecorder(plan, mimeType, tid));
    } else {
      if (mimeType) steps.push(() => exportMP4WithRecorder(plan, mimeType, tid));
      if (encOk) steps.push(() => exportMP4WithEncoder(plan, tid));
    }
    let lastErr = null;
    for (let k = 0; k < steps.length; k++) {
      try { await steps[k](); return; }
      catch (e) { lastErr = e; }
    }
    alert('MP4 导出失败：' + (lastErr && lastErr.message ? lastErr.message : lastErr));
  }

  function exportPNGSeq() {
    if (D.getIsPlaying()) D.pause();
    D.syncFrameRef();
    const _sz = D.getExportSize();
    const outW = _sz.w;
    const outH = _sz.h;
    const transparent = document.getElementById('gifTransparent').checked;
    const tid = D.isSubTrackMode() ? String(D.AppState.activeTrackId) : null;
    
    // 如果存在摄像机且未开启画布优先，则传 null，让 renderFrameToDataURL 逐帧计算
    const cam = D.shouldSkipCameraForExport() ? null : (D.getCurrentCameraObject() || D.getCameraAtFrame(0));
    const crop = cam ? null : D.getExportCrop(outW, outH, tid);
    
    exportPNGsAsZip(D.AppState.frames, tid, {
      outW,
      outH,
      crop,
      transparent
    });
  }

  return {
    init,
    getJSZip,
    exportPNGsAsZip,
    getGifenc,
    exportGIF,
    getMP4MimeType,
    exportMP4,
    exportVideo,
    exportPNGSeq
  };
})();
