'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen } = require('electron');
const { createSettingsStore } = require('./settings-store');
const { createBrokerStockProvider } = require('./stock-provider');

let widgetWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;
let settingsStore = null;
let stockProvider = null;
let realtimeQuoteSubscription = null;
let realtimeSubscriptionKey = '';
let realtimeSyncVersion = 0;

const rendererPath = path.join(__dirname, '../renderer/index.html');
const preloadPath = path.join(__dirname, '../preload/preload.js');

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWidgetWindow();
  });

  app.whenReady().then(() => {
    settingsStore = createSettingsStore(app.getPath('userData'));
    stockProvider = createBrokerStockProvider({
      getSettings: () => settingsStore.get()
    });

    Menu.setApplicationMenu(null);
    registerIpcHandlers();
    createWidgetWindow();
    createTray();
    showWidgetWindow();
    syncRealtimeQuotes();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  stopRealtimeQuotes();
});

app.on('window-all-closed', () => {});

app.on('activate', () => {
  showWidgetWindow();
});

function createWidgetWindow() {
  const bounds = getInitialWidgetBounds();

  widgetWindow = new BrowserWindow({
    ...bounds,
    minWidth: 280,
    minHeight: 180,
    frame: false,
    resizable: true,
    transparent: false,
    show: false,
    skipTaskbar: true,
    title: '스탁 위젯',
    alwaysOnTop: true,
    backgroundColor: '#111827',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  applyWidgetOpacity(settingsStore.get().displayOptions.widgetOpacity);
  widgetWindow.setAlwaysOnTop(true, 'screen-saver');
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWindow.loadFile(rendererPath, { query: { window: 'widget' } });

  widgetWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      widgetWindow.hide();
    }
  });

  const persistBounds = debounce(() => {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      return;
    }

    settingsStore.update({
      windowBounds: widgetWindow.getBounds()
    });
  }, 300);

  widgetWindow.on('moved', persistBounds);
  widgetWindow.on('resized', persistBounds);
}

function createSettingsWindow(requestedTab = 'stocks') {
  const settingsTab = sanitizeSettingsTab(requestedTab);

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.webContents.send('settings:tab-requested', settingsTab);
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 680,
    height: 720,
    minWidth: 560,
    minHeight: 560,
    title: '스탁 위젯 - 환경설정',
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  settingsWindow.setMenu(null);
  settingsWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    settingsWindow?.setTitle('스탁 위젯 - 환경설정');
  });
  settingsWindow.loadFile(rendererPath, { query: { window: 'settings', tab: settingsTab } });
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('스탁 위젯');
  tray.on('click', () => {
    if (widgetWindow?.isVisible()) {
      widgetWindow.hide();
    } else {
      showWidgetWindow();
    }
  });
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '위젯 보이기',
      click: () => showWidgetWindow()
    },
    {
      label: '위젯 숨기기',
      click: () => widgetWindow?.hide()
    },
    { type: 'separator' },
    {
      label: '환경설정',
      click: () => createSettingsWindow()
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function registerIpcHandlers() {
  ipcMain.handle('settings:get', () => sanitizeSettingsForRenderer(settingsStore.get()));
  ipcMain.handle('settings:update', (_event, patch) => {
    const settings = settingsStore.update(patch);
    applyWidgetOpacity(settings.displayOptions.widgetOpacity);
    const rendererSettings = sanitizeSettingsForRenderer(settings);
    broadcastSettings(rendererSettings);
    syncRealtimeQuotes();
    return rendererSettings;
  });
  ipcMain.handle('stocks:search', (_event, query) => stockProvider.search(query));
  ipcMain.handle('stocks:quotes', async () => {
    const settings = settingsStore.get();
    return stockProvider.getQuotes(settings.symbols);
  });
  ipcMain.handle('window:open-settings', (_event, tab) => {
    createSettingsWindow(tab);
    return true;
  });
  ipcMain.handle('window:show-widget', () => {
    showWidgetWindow();
    return true;
  });
  ipcMain.handle('window:hide-widget', () => {
    widgetWindow?.hide();
    return true;
  });
}

function broadcastSettings(settings) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('settings:changed', settings);
    }
  }
}

function broadcastQuoteUpdates(quotes) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('stocks:quotes-updated', quotes);
    }
  }
}

function syncRealtimeQuotes() {
  const settings = settingsStore.get();
  const nextSubscriptionKey = getRealtimeSubscriptionKey(settings);

  if (nextSubscriptionKey === realtimeSubscriptionKey) {
    return;
  }

  realtimeSubscriptionKey = nextSubscriptionKey;
  realtimeSyncVersion += 1;
  stopRealtimeQuotes();

  if (!nextSubscriptionKey) {
    return;
  }

  const syncVersion = realtimeSyncVersion;

  try {
    const subscription = stockProvider.subscribeQuotes(settings.symbols, (quotes) => {
      if (syncVersion === realtimeSyncVersion) {
        broadcastQuoteUpdates(quotes);
      }
    });

    if (syncVersion !== realtimeSyncVersion) {
      subscription?.unsubscribe?.();
      return;
    }

    realtimeQuoteSubscription = subscription;
  } catch (error) {
    realtimeSubscriptionKey = '';
    console.warn(`Realtime quote subscription failed. ${error.message}`);
  }
}

function stopRealtimeQuotes() {
  realtimeQuoteSubscription?.unsubscribe?.();
  realtimeQuoteSubscription = null;
}

function getRealtimeSubscriptionKey(settings) {
  if (!stockProvider.supportsRealtime() || settings.symbols.length === 0) {
    return '';
  }

  return JSON.stringify({
    broker: settings.selectedBroker,
    symbols: settings.symbols.map((symbol) => symbol.ticker),
    kiwoom: settings.selectedBroker === 'kiwoom'
      ? {
          appKey: settings.kiwoom?.appKey || '',
          secretKey: settings.kiwoom?.secretKey || ''
        }
      : null
  });
}

function sanitizeSettingsForRenderer(settings) {
  return {
    ...settings,
    kiwoom: {
      appKey: settings.kiwoom?.appKey || '',
      secretKey: '',
      hasSecretKey: Boolean(settings.kiwoom?.secretKey)
    },
    toss: {
      clientId: settings.toss?.clientId || '',
      clientSecret: '',
      hasClientSecret: Boolean(settings.toss?.clientSecret)
    }
  };
}

function applyWidgetOpacity(opacity) {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    return;
  }

  widgetWindow.setOpacity(opacity);
}

function sanitizeSettingsTab(tab) {
  if (tab === 'general' || tab === 'auth') {
    return tab;
  }

  return 'stocks';
}

function showWidgetWindow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) {
    createWidgetWindow();
  }

  widgetWindow.show();
  widgetWindow.moveTop();
}

function getInitialWidgetBounds() {
  const savedBounds = settingsStore.get().windowBounds;
  const width = savedBounds.width;
  const height = savedBounds.height;
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const matchingDisplay = Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)
    ? screen.getDisplayMatching({ x: savedBounds.x, y: savedBounds.y, width, height }).workArea
    : primaryWorkArea;

  return {
    width,
    height,
    x: clampCoordinate(savedBounds.x, matchingDisplay.x, matchingDisplay.x + matchingDisplay.width - width, primaryWorkArea.x + primaryWorkArea.width - width - 24),
    y: clampCoordinate(savedBounds.y, matchingDisplay.y, matchingDisplay.y + matchingDisplay.height - height, primaryWorkArea.y + 24)
  };
}

function clampCoordinate(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return Math.round(fallback);
  }

  if (max < min) {
    return Math.round(min);
  }

  return Math.round(Math.min(max, Math.max(min, value)));
}

function createTrayIcon() {
  const iconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAl0lEQVR4nO3TsQ2AIBCFYVaws7ZxK6dyA5ZwAUcxFg6hoThjge845CQhV7xS/s+IruvHs+acAQxggKYB237c+x3wjCNEm4BhneoBQpymdgfC4Vycxp0lBqDD1QGxAEVy4iLAWxyhigG04ioA6Z1iASjyNc4CUt8wNw4Bsfjsl+yJAeGhUnGEgJ+AEFrx5L9AcwYwgAGqAy74uRWz49EGRwAAAABJRU5ErkJggg==';
  const dataUrl = `data:image/png;base64,${iconBase64}`;
  const image = nativeImage.createFromDataURL(dataUrl);
  return image.resize({ width: 16, height: 16 });
}

function debounce(callback, delayMs) {
  let timeoutId = null;

  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => callback(...args), delayMs);
  };
}
