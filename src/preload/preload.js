'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  searchStocks: (query) => ipcRenderer.invoke('stocks:search', query),
  getQuotes: () => ipcRenderer.invoke('stocks:quotes'),
  openSettings: (tab) => ipcRenderer.invoke('window:open-settings', tab),
  showWidget: () => ipcRenderer.invoke('window:show-widget'),
  hideWidget: () => ipcRenderer.invoke('window:hide-widget'),
  onQuotesUpdated: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, quotes) => callback(quotes);
    ipcRenderer.on('stocks:quotes-updated', listener);
    return () => ipcRenderer.removeListener('stocks:quotes-updated', listener);
  },
  onSettingsChanged: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
  onSettingsTabRequested: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, tab) => callback(tab);
    ipcRenderer.on('settings:tab-requested', listener);
    return () => ipcRenderer.removeListener('settings:tab-requested', listener);
  }
};

contextBridge.exposeInMainWorld('stockWidget', api);
