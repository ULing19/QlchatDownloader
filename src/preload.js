'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qlchat', Object.freeze({
  getInitialState: () => ipcRenderer.invoke('qlchat:get-initial-state'),
  selectOutputDir: () => ipcRenderer.invoke('qlchat:select-output-dir'),
  openLogin: ({ url } = {}) => ipcRenderer.invoke('qlchat:open-login', { url }),
  parseCourse: ({ url } = {}) => ipcRenderer.invoke('qlchat:parse-course', { url }),
  startDownload: ({ tasks, outputDir, courseTitle } = {}) => ipcRenderer.invoke('qlchat:start-download', { tasks, outputDir, courseTitle }),
  cancelDownload: () => ipcRenderer.invoke('qlchat:cancel-download'),
  openOutput: ({ path } = {}) => ipcRenderer.invoke('qlchat:open-output', { path }),
  getLicenseState: () => ipcRenderer.invoke('qlchat:get-license-state'),
  activateLicense: ({ order } = {}) => ipcRenderer.invoke('qlchat:activate-license', { order }),
  clearLicense: () => ipcRenderer.invoke('qlchat:clear-license'),
  removeCourse: ({ url } = {}) => ipcRenderer.invoke('qlchat:remove-course', { url }),
  onStatus: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('状态回调必须为函数');
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('qlchat:status', listener);
    return () => ipcRenderer.removeListener('qlchat:status', listener);
  },
}));
