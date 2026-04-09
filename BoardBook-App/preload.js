const { ipcRenderer, contextBridge } = require('electron');

const api = {
    // Discovery & Data
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openFile: (filters) => ipcRenderer.invoke('dialog:openFile', filters),
    discoverIndex: (folderPath) => ipcRenderer.invoke('apps:discover', folderPath),
    getApps: () => ipcRenderer.invoke('apps:get'),
    saveApps: (apps) => ipcRenderer.invoke('apps:save', apps),
    
    // Execution
    openApp: (appData) => ipcRenderer.invoke('apps:open', appData),
    openStandaloneVid: (url) => ipcRenderer.invoke('apps:openVideo', url),
    openStandaloneImg: (url) => ipcRenderer.invoke('apps:openImg', url),
    openStandalonePdf: (url) => ipcRenderer.invoke('apps:openPdf', url),
    openStandaloneYtb: (url) => ipcRenderer.invoke('apps:openYtb', url),
    openStandaloneYtbPicker: () => ipcRenderer.invoke('apps:openYtbPicker'),
    openStandaloneUrl: (url) => ipcRenderer.invoke('apps:openUrl', url),
    openWhiteboard: () => ipcRenderer.invoke('apps:openWhiteboard'),
    detectType: (indexPath) => ipcRenderer.invoke('apps:detectType', indexPath),
    closeLauncher: () => ipcRenderer.send('bb:close-launcher'),
    
    // Listeners
    onDiscoverStatus: (callback) => ipcRenderer.on('apps:discover-status', (event, msg) => callback(msg)),
    onDownloadStatus: (callback) => ipcRenderer.on('bb:launcher-download-status', (event, status) => callback(status)),

    // USB & Flag Helpers (Round 150)
    isNotUsb: () => ipcRenderer.invoke('flags:isNotUsb'),
    isComport: () => ipcRenderer.invoke('flags:isComport'),
    getSerialPorts: () => ipcRenderer.invoke('serial:get-ports'),
    connectSerial: (path) => ipcRenderer.invoke('serial:connect', path),
    exportToUsb: () => ipcRenderer.invoke('apps:export-usb'),
    importFromUsb: () => ipcRenderer.invoke('apps:import-usb'),

    // BoardLog Management (Round 160)
    getBoardLogs: () => ipcRenderer.invoke('bb:get-boardlogs'),
    openBoardLog: (path) => ipcRenderer.invoke('bb:open-log', path),
    copyBoardLog: (path) => ipcRenderer.invoke('bb:copy-log', path),
    deleteBoardLog: (path) => ipcRenderer.invoke('bb:delete-log', path),
    onBoardLogsUpdated: (callback) => ipcRenderer.on('bb:boardlogs-updated', () => callback()),
    onStandaloneVidTrigger: (callback) => ipcRenderer.on('bb:trigger-standalone-vid', () => callback())
};

try {
    if (contextBridge) {
        contextBridge.exposeInMainWorld('electronAPI', api);
    } else {
        window.electronAPI = api;
    }
} catch (e) {
    window.electronAPI = api;
}
