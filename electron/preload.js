// SafeView EPI Desktop — electron/preload.js — V2
// Gabriel Madureira — github.com/gabrielbarbosa04060208-ship-it
'use strict';

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: (url) => {
    if (typeof url === 'string' && url.startsWith('https://'))
      shell.openExternal(url);
  },

  windowControls: {
    minimize:       () => ipcRenderer.send('window-minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
    close:          () => ipcRenderer.send('window-close'),
  },

  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
});
