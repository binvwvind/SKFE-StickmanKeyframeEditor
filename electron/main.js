/**
 * Electron 主进程：把 www/ 里的纯前端页面装进原生窗口。
 * 安全基线：contextIsolation 开、nodeIntegration 关、sandbox 开；
 * 外链一律走系统浏览器，窗口内不允许导航到站外。
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

const APP_TITLE = 'SKFE | 火柴人帧动画编辑器';
let mainWin = null;

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '导出说明',
          click: () => {
            dialog.showMessageBox(mainWin, {
              type: 'info',
              title: '导出位置',
              message: '导出的图片 / 工程 JSON 会保存到系统的「下载」文件夹。',
              buttons: ['知道了']
            });
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 SKFE',
          click: () => dialog.showMessageBox(mainWin, {
            type: 'info',
            title: '关于 SKFE',
            message: `SKFE | Stickman Keyframe Editor\n版本 ${app.getVersion()}\n\n纯本地运行的离线编辑器，数据保存在本机。`,
            buttons: ['好']
          })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: '#f3f7ef',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWin.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  mainWin.once('ready-to-show', () => mainWin.show());

  // 外链走系统浏览器；禁止窗口内跳转到站外
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // 顶栏标题跟随页面（页面里没有 document.title 变化就保持默认）
  mainWin.on('page-title-updated', (e) => e.preventDefault());

  mainWin.on('closed', () => { mainWin = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
