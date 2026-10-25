// SPDX-License-Identifier: GPL-2.0-only
// The page's only bridge to the shell: it asks for the session token (never in a URL or on a command
// line). Runs sandboxed with context isolation.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wsdr', {
  session: () => ipcRenderer.invoke('wsdr:session'),
});
