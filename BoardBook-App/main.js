const { app, BrowserWindow, protocol, ipcMain, dialog, net, shell, session, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;
let textbookWindows = [];
let polyfillCache = '';

// --- Global Crash Handlers (Round 142) ---
process.on('uncaughtException', (err) => console.error('[Main] Uncaught Exception:', err));
process.on('unhandledRejection', (reason, p) => console.error('[Main] Unhandled Rejection at:', p, 'reason:', reason));

app.on('render-process-gone', (event, webContents, details) => {
    console.error(`[Main] Renderer gone: ${details.reason} (${details.exitCode})`);
});

app.on('child-process-gone', (event, details) => {
    console.error(`[Main] Child process gone: ${details.type} - ${details.reason}`);
});

// Track temporary files and session history per window
const isDev = !app.isPackaged;
const portableRoot = isDev ? __dirname : path.dirname(process.execPath);
const hasUsbMarker = fs.existsSync(path.join(portableRoot, 'Board-USB.json'));

// Smart Data Root (Round 181): Use AppData if forced (--NotUSB) OR if NO USB marker found.
const args = process.argv;
const isNotUsb = args.includes('--NotUSB') || !hasUsbMarker;
const isComportMode = args.includes('--Comport'); // Round 181: Enable external control via signal mapping
const APP_TITLE = isComportMode ? 'BoardBook By Auto Serial' : 'BoardBook Launcher'; // Round 182
const autoSubject = args.find(a => a.startsWith('--subject='))?.split('=')[1];
const autoGrade = args.find(a => a.startsWith('--grade='))?.split('=')[1];
const bsApiPort = args.find(a => a.startsWith('--bs-api='))?.split('=')[1]; // Round 187: BoardSend API Bridge Port

ipcMain.handle('flags:isNotUsb', () => isNotUsb);
ipcMain.handle('flags:isComport', () => isComportMode); // Round 181
ipcMain.handle('flags:getAutoArgs', () => ({ subject: autoSubject, grade: autoGrade, bsApiPort: bsApiPort }));

const baseDataDir = path.join(app.getPath('userData'), 'BoardBook');
const dataRoot = isNotUsb ? baseDataDir : portableRoot;

const textbookIndexPath = path.join(dataRoot, 'Textbook.json');
const bbPlusDir = path.join(dataRoot, 'BBplus');

// New BBPen Storage (Round 178)
const boardLogDir = isNotUsb 
    ? path.join(app.getPath('documents'), 'BBPen')
    : path.join(path.parse(portableRoot).root, 'BBPen');

if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot, { recursive: true });
if (!fs.existsSync(bbPlusDir)) fs.mkdirSync(bbPlusDir, { recursive: true });
if (!fs.existsSync(boardLogDir)) fs.mkdirSync(boardLogDir, { recursive: true });

// Migration: If Installed mode but no data in AppData, check Portable area for legacy data
if (isNotUsb) {
    const searchRoots = [portableRoot, path.join(portableRoot, '..'), app.getPath('userData')];
    console.log('[Main] Migration Search initiated via roots:', searchRoots);
    
    for (const root of searchRoots) {
        // Skip self-migration
        if (root === dataRoot) continue;

        const legacyTextbook = path.join(root, 'Textbook.json');
        if (fs.existsSync(legacyTextbook) && !fs.existsSync(textbookIndexPath)) {
            console.log(`[Main] Migrating legacy Textbook.json from ${root}...`);
            try { fs.copyFileSync(legacyTextbook, textbookIndexPath); } catch(e) { console.error('[Main] Textbook migration error:', e); }
        }
        
        const legacyBBplus = path.join(root, 'BBplus');
        if (fs.existsSync(legacyBBplus) && (!fs.existsSync(bbPlusDir) || fs.readdirSync(bbPlusDir).length === 0)) {
            console.log(`[Main] Migrating legacy BBplus from ${root}...`);
            const copyDir = (src, dest) => {
                if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                fs.readdirSync(src).forEach(i => {
                    const s = path.join(src, i), d = path.join(dest, i);
                    if (fs.statSync(s).isDirectory()) copyDir(s, d);
                    else fs.copyFileSync(s, d);
                });
            };
            try { copyDir(legacyBBplus, bbPlusDir); } catch(e) {}
        }
    }
}

// AppData Temp is always in AppData for performance/cleanup
const tempRootDir = path.join(baseDataDir, 'Temp');
if (!fs.existsSync(tempRootDir)) fs.mkdirSync(tempRootDir, { recursive: true });

// Smart USB Export Logic
ipcMain.handle('apps:export-usb', async (event) => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'USB 드라이브를 선택하세요 (Board-USB.json이 생성될 위치)'
    });

    if (canceled || filePaths.length === 0) return { success: false };
    const selectedPath = filePaths[0];
    const targetRoot = path.parse(selectedPath).root;
    console.log('[Main] USB Export target adjusted to drive root:', targetRoot);
    
    const appTargetDir = path.join(targetRoot, 'BoardBook-App');
    const usbJsonPath = path.join(targetRoot, 'Board-USB.json');
    const runBatPath = path.join(targetRoot, 'RunBB.bat');

    try {
        const sourceDir = isDev ? __dirname : path.dirname(process.execPath);
        const bbPlusSource = path.join(baseDataDir, 'BBplus');
        const textbookPath = path.join(baseDataDir, 'Textbook.json');

        // 1. Calculate total tasks
        let totalFiles = 0;
        let processedFiles = 0;

        const countFiles = (dir, exclude = []) => {
            if (!fs.existsSync(dir)) return;
            fs.readdirSync(dir).forEach(item => {
                const s = path.join(dir, item);
                if (fs.statSync(s).isDirectory()) {
                    if (!exclude.includes(item)) countFiles(s, exclude);
                } else {
                    totalFiles++;
                }
            });
        };

        const exeName = process.platform === 'win32' ? 'BoardBook.exe' : 'BoardBook';
        const targetExe = path.join(appTargetDir, exeName);
        const needsFullCopy = !fs.existsSync(targetExe);

        if (needsFullCopy) countFiles(sourceDir, ['BoardLog', 'BBplus', 'node_modules', '.git']);
        if (fs.existsSync(textbookPath)) totalFiles++;
        if (fs.existsSync(bbPlusSource)) countFiles(bbPlusSource);

        const sendProgress = (filename) => {
            processedFiles++;
            const progress = (processedFiles / totalFiles) * 100;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('bb:launcher-download-status', {
                    state: 'progressing',
                    progress,
                    filename: `USB 전송 중: ${filename}`,
                    type: 'usb'
                });
            }
        };

        // 2. Perform Copy
        if (needsFullCopy) {
            console.log('[Main] App missing on USB. Performing full copy...');
            if (!fs.existsSync(appTargetDir)) fs.mkdirSync(appTargetDir, { recursive: true });
            
            const copyRecursive = (src, dest, exclude = []) => {
                if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                fs.readdirSync(src).forEach(item => {
                    const s = path.join(src, item);
                    const d = path.join(dest, item);
                    if (fs.statSync(s).isDirectory()) {
                        if (!exclude.includes(item)) copyRecursive(s, d, exclude);
                    } else {
                        fs.copyFileSync(s, d);
                        sendProgress(item);
                    }
                });
            };
            copyRecursive(sourceDir, appTargetDir, ['BoardLog', 'BBplus', 'node_modules', '.git', 'dist']);
        }

        // 3. Create/Update Metadata
        fs.writeFileSync(usbJsonPath, JSON.stringify({ BoardBook: true, ExportDate: new Date().toISOString() }, null, 2));
        const batContent = `@echo off\nstart "" "%~dp0BoardBook-App\\${exeName}"\nexit`;
        fs.writeFileSync(runBatPath, batContent);

        // 4. Sync Data
        if (fs.existsSync(textbookPath)) {
            fs.copyFileSync(textbookPath, path.join(appTargetDir, 'Textbook.json'));
            sendProgress('Textbook.json');
        }

        if (fs.existsSync(bbPlusSource)) {
            const copyDir = (src, dest) => {
                if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                fs.readdirSync(src).forEach(item => {
                    const s = path.join(src, item);
                    const d = path.join(dest, item);
                    if (fs.statSync(s).isDirectory()) copyDir(s, d);
                    else {
                        fs.copyFileSync(s, d);
                        sendProgress(item);
                    }
                });
            };
            copyDir(bbPlusSource, path.join(appTargetDir, 'BBplus'));
        }

        // 5. Finalize
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bb:launcher-download-status', { state: 'completed' });
        }
        return { success: true, path: targetRoot };
    } catch (e) {
        console.error('[Main] Export failed:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('apps:import-usb', async (event) => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'BoardBook 데이터가 있는 USB 폴더를 선택하세요'
    });

    if (canceled || filePaths.length === 0) return { success: false };
    const usbRoot = filePaths[0];
    const usbLogDir = path.join(usbRoot, 'BoardLog');
    
    // Check inside BoardBook-App if not in root
    const altLogDir = path.join(usbRoot, 'BoardBook-App', 'BoardLog');
    const finalUsbLogDir = fs.existsSync(usbLogDir) ? usbLogDir : (fs.existsSync(altLogDir) ? altLogDir : null);

    if (!finalUsbLogDir) return { success: false, error: 'USB에서 BoardLog 폴더를 찾을 수 없습니다.' };

    try {
        const files = fs.readdirSync(finalUsbLogDir).filter(f => f.endsWith('.png'));
        let importedCount = 0;
        
        files.forEach(f => {
            const src = path.join(finalUsbLogDir, f);
            const dest = path.join(boardLogDir, f);
            if (!fs.existsSync(dest)) {
                fs.copyFileSync(src, dest);
                importedCount++;
            }
        });

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bb:boardlogs-updated');
        }
        return { success: true, count: importedCount };
    } catch (e) {
        return { success: false, error: e.message };
    }
});


const win11UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// --- Stabilization Switches (Round 150) ---
app.commandLine.appendSwitch('disable-features', 'HardwareVideoDecoder,HardwareAudioDecoder,CalculateNativeWinOcclusion,AudioServiceOutOfProcess'); 
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-accelerated-video-encode');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Audio-Send-Side-Bwe/Enabled/'); 
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Track session paths and history per window
const winSessionMap = new Map(); // winId -> { root, Vid, PDF, Other }
const winAppDataMap = new Map(); // winId -> appData (Round 132 fix)
const sessionHistory = new Map(); // winId -> { videos: [], pdfs: [], others: [] }
const activeDownloads = new Set();
const videoCache = new Map(); // url -> timestamp (Round 136)
let lastActiveWinId = null; // Track most recent app window

const SIDEBAR_WIDTH = 80;

function attachSidebar(win, contentUrl, options = {}) {
    const { isUrl = false, preload = null, nodeIntegration = true, contextIsolation } = options;
    const resolvedCtxIsolation = contextIsolation !== undefined ? contextIsolation : !nodeIntegration;
    
    // 1. Content View
    const contentView = new WebContentsView({
        webPreferences: {
            preload: preload,
            nodeIntegration: nodeIntegration,
            contextIsolation: resolvedCtxIsolation,
            sandbox: false,
            webSecurity: false,
            userAgent: win11UA
        }
    });
    win.contentView.addChildView(contentView);
    if (isUrl) contentView.webContents.loadURL(contentUrl);
    else contentView.webContents.loadFile(contentUrl, options.query ? { query: options.query } : {});

    // 2. Sidebar View
    const sidebarView = new WebContentsView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            userAgent: win11UA
        }
    });
    win.contentView.addChildView(sidebarView);
    sidebarView.webContents.loadFile('BBSidebar.html', options.sidebarMode ? { query: { mode: options.sidebarMode } } : {});

    const updateLayout = () => {
        if (win.isDestroyed()) return;
        const bounds = win.getContentBounds();
        const targetWidth = Math.max(1, bounds.width - SIDEBAR_WIDTH);
        const targetHeight = Math.max(1, bounds.height);
        
        contentView.setBounds({ x: 0, y: 0, width: targetWidth, height: targetHeight });
        sidebarView.setBounds({ x: targetWidth, y: 0, width: SIDEBAR_WIDTH, height: targetHeight });
    };

    // Fail-safe tagging for window discovery
    contentView.webContents.ownerWindowId = win.id;
    sidebarView.webContents.ownerWindowId = win.id;
    win.sidebarView = sidebarView; // Explicit reference for fast routing
    lastActiveWinId = win.id; // Mark as active

    win.on('resize', updateLayout);
    win.on('maximize', updateLayout);
    win.on('unmaximize', updateLayout);
    
    // Initial layout
    setTimeout(updateLayout, 100);
    return { contentView, sidebarView, updateLayout };
}

function addUniversalDrawingLayer(win) {
    const winBounds = win.getContentBounds();
    const drawingWin = new BrowserWindow({
        width: winBounds.width - SIDEBAR_WIDTH,
        height: winBounds.height,
        parent: win,
        modal: false, frame: false, transparent: true, resizable: false, hasShadow: false,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    drawingWin.setMenu(null);
    drawingWin.loadFile(path.join(__dirname, 'BBDrawing.html'));
    drawingWin.setIgnoreMouseEvents(true, { forward: true });
    drawingWin.webContents.ownerWindowId = win.id; // Tag for discovery
    win.drawingWin = drawingWin;

    const syncBounds = () => {
        if (win.isDestroyed() || drawingWin.isDestroyed()) return;
        const bounds = win.getContentBounds();
        if (bounds.width <= SIDEBAR_WIDTH || bounds.height === 0) return;
        drawingWin.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width - SIDEBAR_WIDTH, height: bounds.height });
    };

    win.on('resize', syncBounds);
    win.on('move', syncBounds);
    win.on('maximize', syncBounds);
    win.on('unmaximize', syncBounds);
    
    // Show after a brief delay to prevent flashing
    setTimeout(() => {
        if (!drawingWin.isDestroyed()) {
            syncBounds();
            drawingWin.show();
        }
    }, 200);

    lastActiveWinId = win.id;
    return drawingWin;
}

// --- Helper: Robust Window/View Discovery (Round 185) ---
const winFrom = (wc) => {
    if (!wc || wc.isDestroyed()) return null;
    
    if (wc.ownerWindowId) {
        const win = BrowserWindow.fromId(wc.ownerWindowId);
        if (win && !win.isDestroyed()) return win;
    }

    let win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) return win;
    
    try {
        win = wc.getOwnerBrowserWindow(); 
        if (win && !win.isDestroyed()) return win;
    } catch(e) {}
    
    const allWins = BrowserWindow.getAllWindows();
    for (const w of allWins) {
        if (w.contentView && w.contentView.children) {
            if (w.contentView.children.some(v => v.webContents === wc)) return w;
        }
        if (w.getChildWindows().some(c => c.webContents === wc)) return w;
        if (w.webContents === wc) return w;
    }
    
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === wc) return mainWindow;
    return null;
};

const sendToContent = (win, channel, arg) => {
    if (!win || win.isDestroyed()) return;
    console.log(`[Main] sendToContent: Target window [${win.getTitle()}] (ID: ${win.id}) Command: [${channel}]`);
    if (win.contentView && win.contentView.children && win.contentView.children[0]) {
        const target = win.contentView.children[0].webContents;
        if (target && !target.isDestroyed()) {
            console.log(`[Main] sendToContent: Routing [${channel}] to ContentView[0] (URL: ${target.getURL().substring(0, 30)})`);
            target.send(channel, arg);
            return;
        }
    }
    if (win.webContents && !win.webContents.isDestroyed()) {
        console.log(`[Main] sendToContent: Routing [${channel}] to Main WebContents`);
        win.webContents.send(channel, arg);
    } else {
        console.warn(`[Main] sendToContent: FAILED to find target webContents for [${channel}]`);
    }
};

async function openWhiteboard() {
    console.log('[Main] Opening Whiteboard...');
    const win = new BrowserWindow({
        width: 1280, height: 720,
        show: false,
        title: 'BoardBook Whiteboard',
        backgroundColor: '#ffffff',
        frame: false,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    
    win.webContents.ownerWindowId = win.id; // Tag for discovery
    attachSidebar(win, 'BBWhiteboard.html', { sidebarMode: 'whiteboard' });
    addUniversalDrawingLayer(win);
    win.show();
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: APP_TITLE,
        backgroundColor: '#0f172a',
        frame: false, // Frameless for home
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
            userAgent: win11UA
        }
    });

    mainWindow.webContents.ownerWindowId = mainWindow.id; // Tag Launcher
    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        textbookWindows.forEach(win => {
            if (!win.isDestroyed()) win.close();
        });
        textbookWindows = [];
    });

    mainWindow.on('close', (e) => {
        if (activeDownloads.size > 0) {
            e.preventDefault();
            const choice = dialog.showMessageBoxSync(mainWindow, {
                type: 'warning',
                buttons: ['怨꾩냽 湲곕떎由ш린', '媛뺤젣 醫낅즺'],
                title: '?ㅼ슫濡쒕뱶 以?',
                message: '?꾩옱 ?뚯씪 ?ㅼ슫濡쒕뱶媛 吏꾪뻾 以묒엯?덈떎. 醫낅즺?섏떆寃?뒿?덇퉴?',
                detail: '媛뺤젣 醫낅즺 ???뚯씪???먯긽?????덉뒿?덈떎.',
                defaultId: 0,
                cancelId: 0
            });
            if (choice === 1) {
                activeDownloads.clear();
                mainWindow.destroy();
            }
        }
    });
}

function openVideoWindow(videoUrlOrPath) {
    // Round 138: De-duplicate existing video windows
    const existing = BrowserWindow.getAllWindows().find(w => {
        const title = w.getTitle();
        return title === 'BoardBook Video Player' && w.webContents.getURL().includes(encodeURIComponent(videoUrlOrPath));
    });
    if (existing) {
        existing.focus();
        return;
    }

    const videoWin = new BrowserWindow({
        width: 1280,
        height: 720,
        title: 'BoardBook Video Player',
        backgroundColor: '#000',
        frame: false,
        icon: path.join(__dirname, 'icon.png'),
        
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            webSecurity: false
        }
    });

    videoWin.webContents.ownerWindowId = videoWin.id; // Tag for discovery

    const url = videoUrlOrPath.startsWith('http') ? videoUrlOrPath : pathToFileURL(videoUrlOrPath).href;
    console.log('[Main] Opening Video:', url);
    
    const { contentView } = attachSidebar(videoWin, path.join(__dirname, 'BBVid.html'), { query: { v: url }, sidebarMode: 'vid' });
    addUniversalDrawingLayer(videoWin);
    
    videoWin.on('close', () => {
        try {
            // Force terminate media to prevent ghost audio
            contentView.webContents.audioMuted = true;
            contentView.webContents.loadURL('about:blank');
        } catch(e) {}
    });

    videoWin.show();
}

function registerIpcHandlers() {
    // --- Media Controls IPC Forwarding ---
    const mediaCommands = [
        'bb:vid-play-pause', 'bb:vid-rewind', 'bb:vid-forward', 'bb:vid-volume', 'bb:vid-timeline', 'bb:vid-speed',
        'bb:pdf-prev', 'bb:pdf-next', 'bb:pdf-zoom-in', 'bb:pdf-zoom-out', 'bb:pdf-fit-h', 'bb:pdf-fit-v',
        'bb:img-zoom-in', 'bb:img-zoom-out', 'bb:img-fit'
    ];
    mediaCommands.forEach(cmd => {
        ipcMain.on(cmd, (event, arg) => {
            const win = winFrom(event.sender);
            if (win && win.contentView && win.contentView.children[0]) {
                const targetWebContents = win.contentView.children[0].webContents;
                targetWebContents.send(cmd, arg);
            }
        });
    });

    ipcMain.handle('apps:open', (event, appData) => {
        if (!appData.id) {
            appData.id = Math.floor(100000 + Math.random() * 900000).toString();
            console.log('[Main] Hot-fixing missing app ID:', appData.id);
        }
        openTextbookWindow(appData);
    });
    
    ipcMain.handle('apps:get', async () => {
        try {
            if (!fs.existsSync(textbookIndexPath)) return [];
            const data = await fs.promises.readFile(textbookIndexPath, 'utf-8');
            let apps = JSON.parse(data);
            // Auto-heal missing IDs
            let changed = false;
            apps.forEach(app => {
                if (!app.id) {
                    app.id = Math.floor(100000 + Math.random() * 900000).toString();
                    changed = true;
                }
            });
            if (changed) await fs.promises.writeFile(textbookIndexPath, JSON.stringify(apps, null, 2));
            return apps;
        } catch(e) { return []; }
    });

    ipcMain.handle('apps:save', async (event, apps) => {
        try {
            apps.forEach(app => {
                if (!app.id || app.id.length !== 4) {
                    app.id = Math.floor(1000 + Math.random() * 9000).toString();
                }
                const specificDir = path.join(bbPlusDir, app.id);
                if (!fs.existsSync(specificDir)) fs.mkdirSync(specificDir, { recursive: true });
            });
            await fs.promises.writeFile(textbookIndexPath, JSON.stringify(apps, null, 2));
            return apps;
        } catch(e) { console.error('[Main] Save failed:', e); return apps; }
    });

    // --- BBPlus Multi-Frame Sync Bridge ---
    ipcMain.on('bbplus:trigger-request', (event, data) => {
        // Send back to the same WebContents; the top-frame listener in textbook-preload.js will catch it
        event.sender.send('bbplus:trigger-exec', data);
    });

    ipcMain.on('app:getPolyfillContentSync', (event) => {
        try {
            const content = fs.readFileSync(path.join(__dirname, 'polyfill.js'), 'utf8');
            event.returnValue = content;
        } catch(e) { event.returnValue = ''; }
    });

    ipcMain.handle('shell:open', async (event, filePath) => {
        if (filePath.startsWith('file:///')) {
            shell.openPath(path.normalize(filePath.replace('file:///', '')));
        } else {
            shell.openExternal(filePath);
        }
    });

    // IPC Handlers for Standalone Viewers
    ipcMain.handle('apps:openVid', (e, url) => openVideoWindow(url));
    ipcMain.handle('apps:openVideo', (e, url) => openVideoWindow(url)); // Legacy support
    ipcMain.handle('apps:openPdf', (e, url) => openPdfWindow(url));
    ipcMain.handle('apps:openImg', (e, url) => openImgWindow(url));
    ipcMain.handle('apps:openUrl', (e, url) => openUrlWindow(url)); // Assuming openUrlWindow is defined elsewhere
    ipcMain.handle('apps:openWhiteboard', () => openWhiteboard());
    ipcMain.on('bb:open-whiteboard', () => openWhiteboard()); 
    ipcMain.handle('apps:openYtb', (e, url) => openUrlWindow(url));
    
    // --- Drawing Tool Handlers (Restored) ---
    ipcMain.on('bb:set-drawing-tool', (event, arg) => {
        const win = winFrom(event.sender);
        if (win) {
            const drawingWin = win.drawingWin || win.getChildWindows().find(c => (c.getURL() || '').includes('BBDrawing.html'));
            if (drawingWin) {
                drawingWin.webContents.send('bb:apply-drawing-tool', arg);
            }
        }
    });

    ipcMain.on('bb:clear-drawing', (event) => {
        const win = winFrom(event.sender);
        if (win) {
            const drawingWin = win.drawingWin || win.getChildWindows().find(c => (c.getURL() || '').includes('BBDrawing.html'));
            if (drawingWin) {
                drawingWin.webContents.send('bb:apply-drawing-tool', { action: 'clear' });
            }
        }
    });

    ipcMain.on('bb:toggle-drawing', (event, active) => {
        const win = winFrom(event.sender);
        if (win) {
            const drawingWin = win.drawingWin || win.getChildWindows().find(c => (c.getURL() || '').includes('BBDrawing.html'));
            if (drawingWin) {
                if (active) {
                    drawingWin.show();
                    drawingWin.setIgnoreMouseEvents(false);
                } else {
                    drawingWin.hide();
                    drawingWin.setIgnoreMouseEvents(true, { forward: true });
                }
            }
        }
    });

    ipcMain.on('bb:log', (e, msg) => {
        console.log(`[RendererLog] ${msg}`);
    });

    ipcMain.on('bb:ytb-pause', (event) => {
        const win = winFrom(event.sender);
        if (win && win.contentView) {
            win.contentView.children.forEach(view => {
                view.webContents.executeJavaScript(`
                    (function() {
                        const v = document.querySelector('video');
                        if (v) v.pause();
                        const iframe = document.querySelector('iframe');
                        if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
                    })();
                `).catch(() => {});
            });
        }
    });

    ipcMain.on('bbvid:play', (event, url) => {
        openVideoWindow(url);
    });

    ipcMain.handle('dialog:openFile', async (event, filters) => {
        const { filePaths } = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: filters || []
        });
        return filePaths[0];
    });

    ipcMain.handle('apps:saveAndOpen', async (event, { filename }) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        const session = winSessionMap.get(win.id);
        if (!session) return;

        // Find file in categories
        let source = '';
        for (const cat of ['Vid', 'PDF', 'Other']) {
            const p = path.join(session[cat], filename);
            if (fs.existsSync(p)) { source = p; break; }
        }
        
        if (!source) return;

        const dest = path.join(app.getPath('downloads'), filename);
        try {
            await fs.promises.copyFile(source, dest);
            shell.openPath(dest);
        } catch (e) { console.error('[Main] Save error:', e); }
    });

    ipcMain.handle('apps:scanSessionFolders', async (event) => {
        const win = event.sender.getOwnerBrowserWindow();
        if (!win) return { videos: [], pdfs: [], others: [] };
        const session = winSessionMap.get(win.id);
        if (!session) return { videos: [], pdfs: [], others: [] };

        const scan = async (dir) => {
            try {
                const files = await fs.promises.readdir(dir);
                return files.map(f => ({ name: f, path: path.join(dir, f) }));
            } catch(e) { return []; }
        };

        return {
            videos: await scan(session.Vid),
            pdfs: await scan(session.PDF),
            others: await scan(session.Other)
        };
    });

    ipcMain.handle('win:toggle-fullscreen', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
            const isFullScreen = win.isFullScreen();
            win.setFullScreen(!isFullScreen);
            return !isFullScreen;
        }
        return false;
    });

    // --- Round 122/123: Smart Link (BBplus) Handlers ---
    ipcMain.handle('bbplus:get', async (event, textbookId) => {
        if (!textbookId) return [];
        const filePath = path.join(bbPlusDir, textbookId, 'BBplus.json');
        try {
            if (!fs.existsSync(filePath)) return [];
            const data = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch(e) { return []; }
    });

    ipcMain.handle('bbplus:save', async (event, { textbookId, links }) => {
        if (!textbookId) return;
        const textbookDir = path.join(bbPlusDir, textbookId);
        if (!fs.existsSync(textbookDir)) fs.mkdirSync(textbookDir, { recursive: true });
        const filePath = path.join(textbookDir, 'BBplus.json');
        try {
            await fs.promises.writeFile(filePath, JSON.stringify(links, null, 2));
            
            // Broadcast to all frames in the same window (Round 136 fix)
            const win = BrowserWindow.fromWebContents(event.sender);
            if (win) {
                win.webContents.send('bbplus:updated', links);
            }
        } catch(e) { console.error('[Main] BBplus Save failed:', e); }
    });

    ipcMain.handle('bb:download-status', (event, status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('bb:launcher-download-status', status);
        }
    });

    ipcMain.handle('bb:get-app-data', (event) => {
        let win = event.sender.getOwnerBrowserWindow();
        if (!win) return null;
        if (win.getParentWindow()) win = win.getParentWindow();
        return winAppDataMap.get(win.id);
    });

    ipcMain.on('bb:set-mouse-through', (event, ignore) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
            win.setIgnoreMouseEvents(ignore, { forward: true });
        }
    });


    // --- BBPlus Data Handlers (Enhanced) ---
    // --- BBPlus Data Handlers (Distributed - Round 171) ---
    ipcMain.handle('bbplus:get-data', async (event, textbookId) => {
        if (!textbookId) return { mappings: [], assets: {} };
        const mappingPath = path.join(bbPlusDir, `${textbookId}.json`);
        const buttonsDir = path.join(bbPlusDir, textbookId, 'Buttons');
        
        const result = { mappings: [], assets: {} };
        
        try {
            // 1. Load Mappings
            if (fs.existsSync(mappingPath)) {
                const mapData = await fs.promises.readFile(mappingPath, 'utf-8');
                result.mappings = JSON.parse(mapData).mappings || [];
            }
            
            // 2. Load Buttons
            if (fs.existsSync(buttonsDir)) {
                const files = await fs.promises.readdir(buttonsDir);
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const btnId = file.replace('.json', '');
                        const btnData = await fs.promises.readFile(path.join(buttonsDir, file), 'utf-8');
                        result.assets[btnId] = JSON.parse(btnData);
                    }
                }
            }
            return result;
        } catch(e) { 
            console.error('[Main] BBplus load error:', e); 
            return { mappings: [], assets: {} }; 
        }
    });

    ipcMain.handle('bbplus:save-data', async (event, { textbookId, data }) => {
        if (!textbookId) return false;
        const mappingPath = path.join(bbPlusDir, `${textbookId}.json`);
        const textbookDir = path.join(bbPlusDir, textbookId);
        const buttonsDir = path.join(textbookDir, 'Buttons');
        
        try {
            // 1. Save Mappings
            await fs.promises.writeFile(mappingPath, JSON.stringify({ mappings: data.mappings }, null, 2));
            
            // 2. Save Buttons
            if (!fs.existsSync(buttonsDir)) fs.mkdirSync(buttonsDir, { recursive: true });
            
            // Collect existing button IDs to handle deletions
            const existingFiles = fs.existsSync(buttonsDir) ? await fs.promises.readdir(buttonsDir) : [];
            const newButtonIds = Object.keys(data.assets);
            
            for (const btnId of newButtonIds) {
                const btnPath = path.join(buttonsDir, `${btnId}.json`);
                await fs.promises.writeFile(btnPath, JSON.stringify(data.assets[btnId], null, 2));
            }
            
            // Cleanup orphaned buttons
            for (const file of existingFiles) {
                const btnId = file.replace('.json', '');
                if (!data.assets[btnId]) {
                    await fs.promises.unlink(path.join(buttonsDir, file)).catch(() => {});
                }
            }
            
            return true;
        } catch(e) { console.error('[Main] BBplus save error:', e); return false; }
    });

    ipcMain.handle('bbplus:copy-file', async (event, { textbookId, sourcePath }) => {
        if (!textbookId) return null;
        const filesDir = path.join(bbPlusDir, textbookId, 'Files');
        if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
        
        const fileName = path.basename(sourcePath);
        const destPath = path.join(filesDir, fileName);
        try {
            await fs.promises.copyFile(sourcePath, destPath);
            return fileName; 
        } catch(e) { console.error('[Main] File copy failed:', e); return null; }
    });

    ipcMain.handle('bbplus:open-asset', async (event, { textbookId, filename }) => {
        const fullPath = path.join(bbPlusDir, textbookId, 'Files', filename);
        try {
            if (fs.existsSync(fullPath)) {
                shell.openPath(fullPath);
                return true;
            }
        } catch(e) { console.error('[Main] Open error:', e); }
        return false;
    });

    ipcMain.handle('bbplus:get-asset-path', (event, { textbookId, filename }) => {
        if (!textbookId || !filename) return null;
        const fullPath = path.join(bbPlusDir, textbookId, 'Files', filename);
        if (fs.existsSync(fullPath)) return fullPath;
        return null;
    });

    // --- Layer 4/5: BBClickShield IPC Bridge ---
    ipcMain.on('bb:shield-forward', (event, data) => {
        const win = event.sender.getOwnerBrowserWindow();
        if (!win || win.isDestroyed()) return;
        
        // Find the textbook content view (first child view)
        const targetView = win.contentView.children[0];
        if (targetView && !targetView.webContents.isDestroyed()) {
            // Forward event to textbook
            targetView.webContents.sendInputEvent(data);
            
            // Trigger 0, 3, 6, 9s capture sequence on non-annotation interaction
            if (data.type === 'mouseUp' || data.type === 'mouseWheel') {
                if (win.triggerCaptureSequence) win.triggerCaptureSequence();
            }
        }
    });

    ipcMain.on('bbplus:shield-right-click', (event, pos) => {
        const win = event.sender.getOwnerBrowserWindow();
        if (!win || win.isDestroyed()) return;

        const proxyWin = win.getChildWindows().find(c => c.getURL().includes('BBProxy.html'));
        if (proxyWin) {
            proxyWin.setIgnoreMouseEvents(false);
            proxyWin.show();
            proxyWin.webContents.send('bbplus:open-dialog', pos);
        }
    });

    // --- BBUrl (Browser) Navigation Handlers ---
    ipcMain.on('bb:url-back', (event) => {
        const win = winFrom(event.sender);
        if (!win) return;
        const browserView = win.contentView.children.find(v => v.webContents !== event.sender && v.webContents.getURL().startsWith('http'));
        if (browserView && browserView.webContents.navigationHistory.canGoBack()) {
            browserView.webContents.navigationHistory.goBack();
        }
    });

    ipcMain.on('bb:url-forward', (event) => {
        const win = winFrom(event.sender);
        if (!win) return;
        const browserView = win.contentView.children.find(v => v.webContents !== event.sender && v.webContents.getURL().startsWith('http'));
        if (browserView && browserView.webContents.navigationHistory.canGoForward()) {
            browserView.webContents.navigationHistory.goForward();
        }
    });

    ipcMain.on('bb:url-reload', (event) => {
        const win = winFrom(event.sender);
        if (!win) return;
        const browserView = win.contentView.children.find(v => v.webContents !== event.sender && v.webContents.getURL().startsWith('http'));
        if (browserView) browserView.webContents.reload();
    });

    ipcMain.on('bb:url-go', (event, targetUrl) => {
        const win = event.sender.getOwnerBrowserWindow();
        if (!win) return;
        const browserView = win.contentView.children.find(v => v.webContents.getURL().startsWith('http') || v.webContents.getURL() === '');
        if (browserView) browserView.webContents.loadURL(targetUrl);
    });

    ipcMain.on('bb:show-url-bar', (event) => {
        const win = event.sender.getOwnerBrowserWindow();
        if (!win) return;
        const navView = win.contentView.children.find(v => v.webContents.getURL().includes('BBUrl.html'));
        if (navView) {
            navView.wantsExpanded = true;
            win.emit('resize'); // Trigger syncAll bounds update
            navView.webContents.send('bb:show-search-bar');
        }
    });

    ipcMain.on('bb:hide-url-bar', (event) => {
        const win = winFrom(event.sender);
        if (!win) return;
        const navView = win.contentView.children.find(v => v.webContents.getURL().includes('BBUrl.html'));
        if (navView) {
            navView.wantsExpanded = false;
            win.emit('resize'); // Trigger syncAll bounds update
        }
    });

    // --- Helper winFrom and sendToContent moved to top level ---

    // --- ComPort Signal Mapping (Round 184 - Expert Feature) ---
    ipcMain.on('bb:comport-signal', (event, signalRaw) => {
        let signal = signalRaw.trim().toLowerCase(); // Case-insensitive
        const raw = signalRaw.trim(); // Original case for logging
        
        // --- Command Aliases (Comprehensive Support) ---
        if (signal === 'mp' || signal === 'mode:mp') signal = 'mode:toggle-mouse-pen';
        else if (signal === 'pe' || signal === 'mode:pe') signal = 'mode:toggle-pen-eraser';
        else if (signal === 'clr' || signal === 'board:clr' || signal === 'clear') signal = 'board:clear'; 
        else if (signal === 'wb' || signal === 'app:wb') signal = 'app:whiteboard';
        else if (signal === 'vid' || signal === 'app:vid') signal = 'app:video';
        else if (signal === 'vpp' || signal === 'app:vpp') signal = 'app:vid-play-pause';
        // Robust window identification (Resolve Parents for child windows)
        let targetWin = null;
        let focused = BrowserWindow.getFocusedWindow();
        
        if (focused && !focused.isDestroyed()) {
            // Resolve to TOP-LEVEL parent
            while (focused.getParentWindow()) {
                focused = focused.getParentWindow();
            }
            targetWin = focused;
            // Only update lastActiveWinId if it's NOT the launcher
            if (targetWin.id !== (mainWindow ? mainWindow.id : null)) lastActiveWinId = targetWin.id;
        } else if (lastActiveWinId) {
            // Fallback to most recent app window if none focused
            const lastWin = BrowserWindow.fromId(lastActiveWinId);
            if (lastWin && !lastWin.isDestroyed()) targetWin = lastWin;
        }

        if (!targetWin || targetWin.isDestroyed()) {
            targetWin = mainWindow;
        }
        
        if (!targetWin || targetWin.isDestroyed()) {
            console.warn('[Main] Serial Signal DROP: No valid window for', raw);
            return;
        }

        console.log(`[Main] Serial Action: [${signal}] (Raw: ${raw}) -> Win: ${targetWin.getTitle()} (ID: ${targetWin.id})`);
        
        if (signal.startsWith('pen:color:')) {
            const color = signal.split(':')[2];
            ipcMain.emit('bb:set-drawing-tool', { sender: targetWin.webContents }, { tool: 'pen', color: color });
        } else if (signal === 'mode:mouse') {
            ipcMain.emit('bb:set-drawing-tool', { sender: targetWin.webContents }, { tool: 'mouse' });
        } else if (signal === 'mode:pen') {
            ipcMain.emit('bb:set-drawing-tool', { sender: targetWin.webContents }, { tool: 'pen' });
        } else if (signal === 'mode:eraser') {
            ipcMain.emit('bb:set-drawing-tool', { sender: targetWin.webContents }, { tool: 'eraser' });
        } else if (signal.startsWith('pen:width:')) {
            const width = parseInt(signal.split(':')[2]);
            ipcMain.emit('bb:set-drawing-tool', { sender: targetWin.webContents }, { thickness: width, width: width });
        } else if (signal === 'page:prev' || signal === 'page:next') {
            const isNext = (signal === 'page:next');
            const title = targetWin.getTitle();
            
            if (title.includes('Video Player')) {
                sendToContent(targetWin, isNext ? 'bb:vid-forward' : 'bb:vid-rewind');
            } else if (title.includes('PDF') || title.includes('Image Viewer')) {
                sendToContent(targetWin, isNext ? 'bb:pdf-next' : 'bb:pdf-prev');
            } else {
                // Textbook, Web, Launcher etc. - Use Virtual Key Events on the Content View
                const wc = (targetWin.contentView && targetWin.contentView.children[0]) ? 
                           targetWin.contentView.children[0].webContents : targetWin.webContents;
                
                if (wc && !wc.isDestroyed()) {
                    const keyCode = isNext ? 'PageDown' : 'PageUp';
                    wc.sendInputEvent({ type: 'keyDown', keyCode });
                    wc.sendInputEvent({ type: 'keyUp', keyCode });
                }
            }
        } else if (signal.toLowerCase().startsWith('control:')) {
            const action = signal.split(':')[1].toLowerCase();
            const title = targetWin.getTitle();
            if (title.includes('Video Player')) {
                sendToContent(targetWin, 'bb:vid-control-signal', action);
            } else {
                const current = targetWin.webContents.getZoomLevel();
                if (action === 'up') targetWin.webContents.setZoomLevel(current + 0.5);
                else if (action === 'down') targetWin.webContents.setZoomLevel(current - 0.5);
                else if (action === 'reset' || action === 'mute') targetWin.webContents.setZoomLevel(0);
            }
        } else if (signal.toLowerCase().startsWith('option:')) {
            const action = signal.split(':')[1].toLowerCase();
            const title = targetWin.getTitle();
            if (title.includes('Video Player')) {
                sendToContent(targetWin, 'bb:vid-option-signal', action);
            } else if (title.includes('PDF')) {
                sendToContent(targetWin, action === 'up' ? 'bb:pdf-fit-h' : 'bb:pdf-fit-v');
            }
        } else if (signal === 'mode:toggle-mouse-pen') {
            if (targetWin.getTitle().includes('Whiteboard')) return; // Ignore MP Toggle in WB
            const sidebarView = targetWin.sidebarView || targetWin.contentView.children.find(v => v.webContents && v.webContents.getURL().includes('BBSidebar.html'));
            if (sidebarView) sidebarView.webContents.send('bb:serial-toggle-mouse-pen');
            else console.warn('[Main] MP Toggle FAILED: No sidebarView found in Win', targetWin.id);
        } else if (signal === 'mode:toggle-pen-eraser') {
            const sidebarView = targetWin.sidebarView || targetWin.contentView.children.find(v => v.webContents && v.webContents.getURL().includes('BBSidebar.html'));
            if (sidebarView) sidebarView.webContents.send('bb:serial-toggle-pen-eraser');
        } else if (signal === 'zoom:in') {
            targetWin.webContents.setZoomLevel(targetWin.webContents.getZoomLevel() + 0.5);
        } else if (signal === 'zoom:out') {
            targetWin.webContents.setZoomLevel(targetWin.webContents.getZoomLevel() - 0.5);
        } else if (signal === 'zoom:reset') {
            targetWin.webContents.setZoomLevel(0);
        } else if (signal === 'board:clear') {
            const drawingWin = targetWin.drawingWin || targetWin.getChildWindows().find(c => (c.getURL() || '').includes('BBDrawing.html'));
            if (drawingWin) {
                console.log(`[Main] board:clear routing to drawingWin (ID: ${drawingWin.id})`);
                drawingWin.webContents.send('bb:apply-drawing-tool', { action: 'clear' });
            } else {
                // Fallback to IPC emit for standard windows
                ipcMain.emit('bb:clear-drawing', { sender: targetWin.webContents });
            }
        }
 else if (signal === 'app:whiteboard') {
            openWhiteboard();
        } else if (signal === 'app:video') {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bb:trigger-standalone-vid');
        } else if (signal === 'app:vid-play-pause') {
            const videoWins = BrowserWindow.getAllWindows().filter(w => w.getTitle().includes('Video Player'));
            videoWins.forEach(vw => sendToContent(vw, 'bb:vid-play-pause', 'toggle'));
        } else if (signal === 'win:close') {
            targetWin.close();
        } else if (signal === 'win:maximize') {
            if (targetWin.isMaximized()) targetWin.unmaximize();
            else targetWin.maximize();
        } else if (signal === 'win:minimize') {
            targetWin.minimize();
        }
    });

    // --- Serial Port Management (Round 182) ---
    let activeSerialPort = null;
    ipcMain.handle('serial:get-ports', async () => {
        try {
            const { SerialPort } = require('serialport');
            return await SerialPort.list();
        } catch (e) {
            console.error('[Main] SerialPort list error:', e.message);
            return [];
        }
    });

    ipcMain.handle('serial:connect', async (event, path) => {
        try {
            const { SerialPort } = require('serialport');
            // Using a simple data listener to avoid extra package dependency for now
            // But if user wants Readline, they can install @serialport/parser-readline
            
            if (activeSerialPort && activeSerialPort.isOpen) {
                try { activeSerialPort.close(); } catch(e) {}
            }

            console.log(`[Main] Attempting to connect to Serial Port: ${path}`);
            activeSerialPort = new SerialPort({ path, baudRate: 115200 });
            
            let buffer = '';
            activeSerialPort.on('data', (data) => {
                const raw = data.toString();
                console.log(`[Main] Serial Raw Data received: "${raw}"`);
                buffer += raw;
                
                // Flexible line splitting (handles \n, \r\n, \r)
                if (buffer.includes('\n') || buffer.includes('\r')) {
                    const parts = buffer.split(/[\r\n]+/);
                    // Keep the last part in buffer if it doesn't end with a newline
                    if (!buffer.endsWith('\n') && !buffer.endsWith('\r')) {
                        buffer = parts.pop();
                    } else {
                        buffer = '';
                    }
                    
                    parts.forEach(line => {
                        const signal = line.trim();
                        if (signal) {
                            console.log(`[Main] Parsed Serial Signal: [${signal}]`);
                            // Find the target window (Focused or Launcher)
                            let targetWin = BrowserWindow.getFocusedWindow();
                            if (!targetWin) {
                                console.log('[Main] No focused window, targeting Launcher');
                                targetWin = mainWindow;
                            }
                            
                            if (targetWin) {
                                console.log(`[Main] Forwarding signal [${signal}] to window ID: ${targetWin.id}`);
                                ipcMain.emit('bb:comport-signal', { sender: targetWin.webContents }, signal);
                            } else {
                                console.warn('[Main] No target window available for signal');
                            }
                        }
                    });
                }
            });

            return new Promise((resolve) => {
                activeSerialPort.on('open', () => {
                    console.log(`[Main] Serial Port OPENED successfully: ${path}`);
                    resolve({ success: true });
                });
                activeSerialPort.on('error', (err) => {
                    console.error(`[Main] Serial Port ERROR: ${err.message}`);
                    resolve({ success: false, error: err.message });
                });
                // Timeout if it takes too long to open
                setTimeout(() => resolve({ success: false, error: 'Connection Timeout' }), 5000);
            });
        } catch (e) {
            console.error(`[Main] Serial Port EXCEPTION: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
}

function updateHistory(winId, category, item) {
    if (!sessionHistory.has(winId)) sessionHistory.set(winId, { videos: [], pdfs: [], images: [], others: [] });
    const history = sessionHistory.get(winId);
    let target = 'others';
    if (category === 'Vid') target = 'videos';
    else if (category === 'PDF') target = 'pdfs';
    else if (category === 'Img') target = 'images';

    if (!history[target].find(i => i.path === item.path)) {
        history[target].push(item);
    }
}

function openImgWindow(imgPath) {
    const imgWin = new BrowserWindow({
        width: 1000,
        height: 800,
        title: 'BoardBook Image Viewer',
        backgroundColor: '#0f172a',
        frame: false,
        icon: path.join(__dirname, 'icon.png'),
        
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });

    imgWin.webContents.ownerWindowId = imgWin.id; // Tag for discovery

    const url = imgPath.startsWith('http') ? imgPath : pathToFileURL(imgPath).href;
    const { contentView: targetView } = attachSidebar(imgWin, path.join(__dirname, 'BBImg.html'), { query: { i: url }, sidebarMode: 'img' });
    addUniversalDrawingLayer(imgWin);
    imgWin.show();
}

function openPdfWindow(pdfPath) {
    const pdfWin = new BrowserWindow({
        width: 1000, height: 1200,
        title: 'BoardBook PDF Viewer',
        backgroundColor: '#0f172a',
        frame: false, show: false,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { 
            contextIsolation: false, 
            nodeIntegration: true
        }
    });

    pdfWin.webContents.ownerWindowId = pdfWin.id; // Tag for discovery

    const url = pdfPath.startsWith('http') ? pdfPath : pathToFileURL(pdfPath).href;
    attachSidebar(pdfWin, path.join(__dirname, 'BBPdf.html'), { query: { v: url }, sidebarMode: 'pdf' });
    addUniversalDrawingLayer(pdfWin);
    pdfWin.show();
}



function openUrlWindow(url, options = {}) {
    const isYtbPicker = options.isYtbPicker || false;

    const win = new BrowserWindow({
        width: 1200, height: 800,
        backgroundColor: '#0f172a',
        frame: false, show: false,
        icon: path.join(__dirname, 'icon.png')
    });

    win.webContents.ownerWindowId = win.id; // Tag for discovery

    // 1. Browser View (Layer 0 - Bottom)
    const browserView = new WebContentsView({
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    win.contentView.addChildView(browserView);
    browserView.webContents.loadURL(url);

    // 2. Nav UI (Layer 1 - Middle, Transparent)
    const navView = new WebContentsView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    navView.setBackgroundColor('#00000000');
    win.contentView.addChildView(navView);
    navView.webContents.loadFile(path.join(__dirname, 'BBUrl.html'), { query: { u: url } });

    // 3. Sidebar (Layer 2 - Top/Side)
    const sidebarView = new WebContentsView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    win.contentView.addChildView(sidebarView);
    sidebarView.webContents.loadFile(path.join(__dirname, 'BBSidebar.html'), { query: { mode: 'url' } });

    // 4. Drawing Layer (Child Window)
    // Create it synchronously so it's ready when syncAll fires
    const drawingWin = new BrowserWindow({
        width: 1200, // will be corrected by syncAll anyway
        height: 800,
        parent: win,
        modal: false, frame: false, transparent: true, resizable: false, hasShadow: false,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    drawingWin.setMenu(null);
    drawingWin.loadFile(path.join(__dirname, 'BBDrawing.html'));
    drawingWin.setIgnoreMouseEvents(true, { forward: true });

    // Bind drawingWin to the global syncAll
    win.drawingWin = drawingWin;

    const syncAll = () => {
        if (win.isDestroyed()) return;
        const bounds = win.getContentBounds();
        const contentWidth = Math.max(1, bounds.width - SIDEBAR_WIDTH);
        const contentHeight = Math.max(1, bounds.height);
        
        browserView.setBounds({ x: 0, y: 0, width: contentWidth, height: contentHeight });
        
        if (navView.wantsExpanded) {
            navView.setBounds({ x: 0, y: 0, width: contentWidth, height: contentHeight });
        } else {
            // Move off-screen instead of 0x0 to prevent engine suspension/blanking issues
            navView.setBounds({ x: -2000, y: -2000, width: 100, height: 100 });
        }
        
        sidebarView.setBounds({ x: contentWidth, y: 0, width: SIDEBAR_WIDTH, height: contentHeight });

        if (win.drawingWin && !win.drawingWin.isDestroyed()) {
            win.drawingWin.setBounds({ x: bounds.x, y: bounds.y, width: contentWidth, height: contentHeight });
        }
    };

    win.on('resize', syncAll);
    win.on('move', syncAll);
    win.on('maximize', syncAll);
    win.on('unmaximize', syncAll);
    
    browserView.webContents.on('did-navigate', (e, url) => {
        if (!navView.webContents.isDestroyed()) navView.webContents.send('bb:url-changed', url);
    });
    browserView.webContents.on('did-navigate-in-page', (e, url) => {
        if (!navView.webContents.isDestroyed()) navView.webContents.send('bb:url-changed', url);
    });

    navView.webContents.once('did-finish-load', () => {
        win.show();
        syncAll();
        // Give focus to the browser area
        setTimeout(() => browserView.webContents.focus(), 200);
    });

    win.on('close', () => {
        try {
            if (!browserView.webContents.isDestroyed()) {
                browserView.webContents.setAudioMuted(true);
                browserView.webContents.loadURL('about:blank');
            }
        } catch(e) {}
    });
}

async function openTextbookWindow(appData) {
    const textbookWin = new BrowserWindow({
        width: 1400,
        height: 900,
        title: `BoardBook - ${appData.name}`,
        frame: false,
        backgroundColor: '#0f172a',
        show: false 
    });

    textbookWin.webContents.ownerWindowId = textbookWin.id; // Tag for discovery

    const winId = textbookWin.id;
    
    // Convert to file URL if it's a local path
    let resolvedUrl = appData.url;
    try {
        if (!resolvedUrl.startsWith('http') && !resolvedUrl.startsWith('file:') && fs.existsSync(resolvedUrl)) {
            resolvedUrl = pathToFileURL(resolvedUrl).href;
        }
    } catch(e) {}

    const { contentView: targetView, sidebarView, updateLayout } = attachSidebar(textbookWin, resolvedUrl, {
        isUrl: true,
        preload: path.join(__dirname, 'textbook-preload.js'),
        nodeIntegration: false,
        contextIsolation: false
    });
    
    // Ensure textbook view has a clean background
    targetView.setBackgroundColor('#ffffff');

    winAppDataMap.set(winId, appData);

    console.log(`[Main] Opening Textbook: ${appData.name} -> ${appData.url}`);
    
    const winBounds = textbookWin.getContentBounds();

    // --- Layer 3: Drawing (Child Window) ---
    const drawingWin = new BrowserWindow({
        width: winBounds.width - SIDEBAR_WIDTH,
        height: winBounds.height,
        parent: textbookWin,
        modal: false, frame: false, transparent: true, resizable: false, hasShadow: false,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    drawingWin.setMenu(null);
    drawingWin.loadFile('BBDrawing.html');
    drawingWin.setIgnoreMouseEvents(true, { forward: true });

    // --- Layer 4: BBClickShield (WebContentsView Shield) ---
    const shieldView = new WebContentsView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    shieldView.setBackgroundColor('#00000000');
    textbookWin.contentView.addChildView(shieldView);
    shieldView.webContents.loadFile('BBClickShield.html');

    // Ensure Sidebar and content layering
    textbookWin.contentView.addChildView(sidebarView);

    // --- Layer 5: BBPlus Proxy (Hotspots/Dialogs) ---
    const proxyWin = new BrowserWindow({
        width: winBounds.width - SIDEBAR_WIDTH,
        height: winBounds.height,
        parent: textbookWin,
        modal: false, frame: false, transparent: true, resizable: false, hasShadow: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: false,
            nodeIntegration: true,
            webSecurity: false
        }
    });
    proxyWin.setMenu(null);
    proxyWin.loadFile('BBProxy.html');
    proxyWin.setIgnoreMouseEvents(true, { forward: true });

    // --- Sync Logic (Extended for ShieldView) ---
    function syncOverlays() {
        if (textbookWin.isDestroyed()) return;
        updateLayout(); // Content & Sidebar
        
        const cb = textbookWin.getContentBounds();
        const contentWidth = Math.max(1, cb.width - SIDEBAR_WIDTH);
        const contentHeight = Math.max(1, cb.height);

        if (!shieldView.webContents.isDestroyed()) {
            shieldView.setBounds({ x: 0, y: 0, width: contentWidth, height: contentHeight });
        }
        
        const globalOverlayBounds = { x: cb.x, y: cb.y, width: contentWidth, height: contentHeight };
        if (!proxyWin.isDestroyed()) proxyWin.setBounds(globalOverlayBounds);
        if (!drawingWin.isDestroyed()) drawingWin.setBounds(globalOverlayBounds);
    }

    // Bind overlays to window movement/resize
    textbookWin.on('resize', syncOverlays);
    textbookWin.on('move', syncOverlays);
    textbookWin.on('maximize', syncOverlays);
    textbookWin.on('unmaximize', syncOverlays);
    
    // --- Resize-triggered dHash recapture (debounced) ---
    let resizeHashTimer = null;
    const triggerResizeCapture = (delay = 800) => {
        clearTimeout(resizeHashTimer);
        resizeHashTimer = setTimeout(() => {
            if (!textbookWin.isDestroyed() && !proxyWin.isDestroyed() && !targetView.webContents.isDestroyed()) {
                const cb = textbookWin.getContentBounds();
                const contentWidth = Math.max(1, cb.width - SIDEBAR_WIDTH);
                const contentHeight = Math.max(1, cb.height);
                
                const targetAspect = 1.4;
                let cropWidth, cropHeight;
                if (contentWidth / contentHeight > targetAspect) {
                    cropHeight = contentHeight * 0.85;
                    cropWidth = cropHeight * targetAspect;
                    if (cropWidth > contentWidth * 0.95) {
                        cropWidth = contentWidth * 0.95;
                        cropHeight = cropWidth / targetAspect;
                    }
                } else {
                    cropWidth = contentWidth * 0.95;
                    cropHeight = cropWidth / targetAspect;
                    if (cropHeight > contentHeight * 0.85) {
                        cropHeight = contentHeight * 0.85;
                        cropWidth = cropHeight * targetAspect;
                    }
                }
                
                const cropRect = {
                    x: Math.floor((contentWidth - cropWidth) / 2),
                    y: Math.floor((contentHeight - cropHeight) / 2),
                    width: Math.floor(cropWidth),
                    height: Math.floor(cropHeight)
                };
                
                targetView.webContents.capturePage(cropRect).then(img => {
                    if (!proxyWin.isDestroyed()) {
                        proxyWin.webContents.send('bb:trigger-phash', img.toJPEG(30), { isResize: true });
                    }
                }).catch(() => {
                    targetView.webContents.capturePage().then(img => {
                        if (!proxyWin.isDestroyed()) {
                            proxyWin.webContents.send('bb:trigger-phash', img.toJPEG(30), { isResize: true });
                        }
                    });
                });
            }
        }, delay);
    };

    textbookWin.on('resize', () => triggerResizeCapture(1200)); // Dragging: 1200ms
    textbookWin.on('maximize', () => triggerResizeCapture(1000)); // Maximize: 1000ms
    textbookWin.on('unmaximize', () => triggerResizeCapture(1000)); // Restore: 1000ms

    proxyWin.webContents.on('did-finish-load', syncOverlays);
    
    // BBClickShield will handle right-clicks and event forwarding.
    // No more direct context-menu or before-input-event interception on targetView.


    setTimeout(() => {
        if (!textbookWin.isDestroyed()) {
            textbookWin.show();
            syncOverlays();
        }
    }, 1000);

    targetView.webContents.on('did-finish-load', () => {
        console.log(`[Main] Textbook loaded: ${appData.name}`);
    });

    targetView.webContents.on('did-fail-load', (e, code, desc, url) => {
        console.error(`[Main] Textbook LOAD FAILED: ${appData.name} - ${desc} (${code}) at ${url}`);
    });

    targetView.webContents.on('dom-ready', () => {
        targetView.webContents.send('bb:init-textbook', appData);
        setTimeout(() => doTriggerPhash(targetView.webContents), 2000);
    });

    // --- Advanced Capture Sequence (User Requested) ---
    // Trigger on: click, keyboard, or 12 seconds. Captures at 0s, 3s, 6s, 9s.
    let captureTimeouts = [];
    const triggerCaptureSequence = () => {
        if (textbookWin.isDestroyed() || targetView.webContents.isDestroyed()) return;
        
        // Clear pending sequence
        captureTimeouts.forEach(clearTimeout);
        
        // 0s capture (often captures the click state before transition)
        doTriggerPhash(targetView.webContents);
        
        // Exponential sequence: 2.15^n * 100ms
        // 0.21s, 0.46s, 0.99s, 2.14s, 4.59s, 9.88s
        captureTimeouts = [
            setTimeout(() => { if (!textbookWin.isDestroyed()) doTriggerPhash(targetView.webContents); }, 215),
            setTimeout(() => { if (!textbookWin.isDestroyed()) doTriggerPhash(targetView.webContents); }, 462),
            setTimeout(() => { if (!textbookWin.isDestroyed()) doTriggerPhash(targetView.webContents); }, 994),
            setTimeout(() => { if (!textbookWin.isDestroyed()) doTriggerPhash(targetView.webContents); }, 2137),
            setTimeout(() => { if (!textbookWin.isDestroyed()) doTriggerPhash(targetView.webContents); }, 4594),
            setTimeout(() => { if (!textbookWin.isDestroyed()) doTriggerPhash(targetView.webContents); }, 9877)
        ];
    };

    // Attach to textbookWin so bb:shield-forward can reach it
    textbookWin.triggerCaptureSequence = triggerCaptureSequence;

    // Trigger on keyboard input (global catch-all for textbook window)
    const handleKeyCapture = (event, input) => {
        if (input.type === 'keyDown' || input.type === 'keyUp') {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
            if (keys.includes(input.key)) triggerCaptureSequence();
        }
    };
    targetView.webContents.on('before-input-event', handleKeyCapture);
    textbookWin.webContents.on('before-input-event', handleKeyCapture);

    // 12-second interval fallback trigger (single capture, no burst)
    let captureSequenceTimer = setInterval(() => {
        if (textbookWin.isDestroyed() || targetView.webContents.isDestroyed()) {
            clearInterval(captureSequenceTimer);
            return;
        }
        // Only run if textbook is currently focused (including its overlays)
        if (BrowserWindow.getFocusedWindow() === textbookWin || textbookWin.getChildWindows().some(w => BrowserWindow.getFocusedWindow() === w)) {
            doTriggerPhash(targetView.webContents);
        }
    }, 12000);

    const sessionId = `Session-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const sessionDir = path.join(tempRootDir, sessionId);
    const subDirs = {
        root: sessionDir,
        Vid: path.join(sessionDir, 'Vid'),
        PDF: path.join(sessionDir, 'PDF'),
        Other: path.join(sessionDir, 'Other')
    };

    Object.values(subDirs).forEach(d => fs.mkdirSync(d, { recursive: true }));
    winSessionMap.set(winId, subDirs);
    sessionHistory.set(winId, { videos: [], pdfs: [], others: [] });
    
    textbookWindows.push(textbookWin);

    textbookWin.on('close', (e) => {
        if (activeDownloads.size > 0) {
            e.preventDefault();
            const choice = dialog.showMessageBoxSync(textbookWin, {
                type: 'warning',
                buttons: ['怨꾩냽 湲곕떎由ш린', '媛뺤젣 醫낅즺'],
                title: '?ㅼ슫濡쒕뱶 以?',
                message: '?꾩옱 ?뚯씪 ?ㅼ슫濡쒕뱶媛 吏꾪뻾 以묒엯?덈떎. 醫낅즺?섏떆寃좎뒿?덇퉴?',
                detail: '媛뺤젣 醫낅즺 ???뚯씪???먯긽?????덉뒿?덈떎.',
                defaultId: 0,
                cancelId: 0
            });
            if (choice === 1) {
                textbookWin.destroy();
            }
        }
    });

    textbookWin.on('closed', async () => {
        textbookWindows = textbookWindows.filter(w => w !== textbookWin);
        const sessionInfo = winSessionMap.get(winId);
        if (sessionInfo) {
            try {
                if (fs.existsSync(sessionInfo.root)) {
                    fs.rmSync(sessionInfo.root, { recursive: true, force: true });
                }
            } catch(e) { console.error('[Main] Cleanup failed:', e); }
            winSessionMap.delete(winId);
        }
        sessionHistory.delete(winId);
    });

    targetView.webContents.setWindowOpenHandler(({ url }) => {
        openUrlWindow(url);
        return { action: 'deny' };
    });
}

// --- Global IPC Handlers (Registered ONLY ONCE) ---
let lastDialogOpenTime = 0;
ipcMain.on('bbplus:open-dialog', (event, pos) => {
    handleOpenDialog(event, pos);
});

ipcMain.on('bbplus:shield-right-click', (event, pos) => {
    handleOpenDialog(event, pos);
});

function handleOpenDialog(event, pos) {
    // 디바운스: 여러 경로가 동시에 트리거되는 것 방지 (500ms)
    const now = Date.now();
    if (now - lastDialogOpenTime < 500) {
        console.log('[Main] bbplus:open-dialog debounced (duplicate)');
        return;
    }
    lastDialogOpenTime = now;

    const win = winFrom(event.sender);
    if (!win) {
        console.error('[Main] No owner window found for bbplus:open-dialog/shield-right-click');
        return;
    }

    // Try child windows first
    const children = win.getChildWindows();
    let proxyWin = children.find(c => {
        const url = c.getURL();
        return url.includes('BBProxy') || url.includes('bbproxy') || url.endsWith('BBProxy.html');
    });

    // Fallback: search ALL windows
    if (!proxyWin) {
        proxyWin = BrowserWindow.getAllWindows().find(c => {
            const url = c.getURL();
            return url.includes('BBProxy') || url.includes('bbproxy');
        });
    }

    if (proxyWin) {
        proxyWin.setIgnoreMouseEvents(false);
        proxyWin.webContents.send('bbplus:open-dialog', pos);
    } else {
        console.error('[Main] CRITICAL: ProxyWin NOT FOUND!');
    }
}

ipcMain.on('bbplus:close-dialog', (event) => {
    const win = winFrom(event.sender);
    if (win) {
        const proxyWin = win.getChildWindows().find(c => c.getURL().includes('BBProxy.html'));
        if (proxyWin) proxyWin.setIgnoreMouseEvents(true, { forward: true });
    }
});

ipcMain.on('bb:close-launcher', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

ipcMain.on('bb:close-window', (event) => {
    const win = winFrom(event.sender);
    if (win) win.close();
});

ipcMain.on('bb:open-devtools', (event) => {
    if (event.sender && !event.sender.isDestroyed()) {
        event.sender.openDevTools({ mode: 'detach' });
    }
});

ipcMain.on('bb:maximize-window', (event) => {
    const win = winFrom(event.sender);
    if (win) {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
    }
});

/* Redundant bb:open-whiteboard removed - see openWhiteboard function */

function doTriggerPhash(webContents, metadata) {
    if (!webContents || webContents.isDestroyed()) return;
    const win = webContents.getOwnerBrowserWindow();
    if (!win || win.isDestroyed()) return;

    const proxyWin = win.getChildWindows().find(c => c.getURL().includes('BBProxy.html')) 
                   || BrowserWindow.getAllWindows().find(c => c.getURL().includes('BBProxy.html'));
    
    // Find the textbook view (first child view usually)
    const targetView = win.contentView.children[0];
    if (proxyWin && targetView && !targetView.webContents.isDestroyed()) {
        const cb = win.getContentBounds();
        const contentWidth = cb.width - SIDEBAR_WIDTH;
        const contentHeight = cb.height;
        const targetAspect = 1.4;
        let cropWidth, cropHeight;
        if (contentWidth / contentHeight > targetAspect) {
            cropHeight = contentHeight * 0.85;
            cropWidth = cropHeight * targetAspect;
            if (cropWidth > contentWidth * 0.95) {
                cropWidth = contentWidth * 0.95;
                cropHeight = cropWidth / targetAspect;
            }
        } else {
            cropWidth = contentWidth * 0.95;
            cropHeight = cropWidth / targetAspect;
            if (cropHeight > contentHeight * 0.85) {
                cropHeight = contentHeight * 0.85;
                cropWidth = cropHeight * targetAspect;
            }
        }
        
        const cropRect = {
            x: Math.floor((contentWidth - cropWidth) / 2),
            y: Math.floor((contentHeight - cropHeight) / 2),
            width: Math.floor(cropWidth),
            height: Math.floor(cropHeight)
        };
        
        targetView.webContents.capturePage(cropRect).then(img => {
            if (!proxyWin.isDestroyed()) {
                proxyWin.webContents.send('bb:trigger-phash', img.toJPEG(30), metadata);
                
                // Scenario A: Auto-Mission (Page Sync) - Only if flag present
                if (bsApiPort) relayToBoardSend('/api/broadcast/capture', { 
                    data: img.toDataURL(), 
                    studentMission: true,
                    metadata: metadata 
                });
            }
        }).catch(err => {
            console.error('[Main] capturePage failed:', err.message);
        });
    }
}

ipcMain.on('bb:trigger-phash', (event, metadata) => {
    doTriggerPhash(event.sender, metadata);
});

ipcMain.handle('bb:capture-target', async (event) => {
    const win = winFrom(event.sender);
    if (!win || win.isDestroyed()) return null;
    const targetView = win.contentView.children[0];
    if (!targetView || targetView.webContents.isDestroyed()) return null;

    try {
        const size = win.getContentBounds();
        const cropRect = {
            x: Math.floor(size.width * 0.05), y: Math.floor(size.height * 0.05),
            width: Math.floor(size.width * 0.9), height: Math.floor(size.height * 0.9)
        };
        const img = await targetView.webContents.capturePage(cropRect);
        return img.toJPEG(30);
    } catch (e) {
        console.error('[Main] capture-target error:', e.message);
        return null;
    }
});

// --- BoardSend Bridge Logic (Conditional) ---
const relayToBoardSend = (endpoint, payload) => {
    if (!bsApiPort) return;
    const request = net.request({
        method: 'POST',
        protocol: 'http:',
        hostname: 'localhost',
        port: parseInt(bsApiPort),
        path: endpoint,
    });
    request.setHeader('Content-Type', 'application/json');
    request.on('error', () => {}); // Silent fail
    request.write(JSON.stringify(payload));
    request.end();
};

ipcMain.handle('bb:get-boardsend-status', async () => {
    if (!bsApiPort) return { online: false };
    return new Promise((resolve) => {
        const req = net.request({
            method: 'GET',
            protocol: 'http:',
            hostname: 'localhost',
            port: parseInt(bsApiPort),
            path: '/api/status',
        });
        req.on('response', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const status = JSON.parse(data);
                    resolve({ online: true, studentCount: status.students || 0 });
                } catch (e) { resolve({ online: false }); }
            });
        });
        req.on('error', () => resolve({ online: false }));
        req.end();
    });
});

ipcMain.on('bb:open-boardsend-dashboard', () => {
    if (!bsApiPort) return;
    shell.openExternal(`http://localhost/teacher_embedded.html`);
});

ipcMain.on('bbplus:relay-resource', (event, asset) => {
    relayToBoardSend('/api/broadcast/push-resource', asset);
});

ipcMain.on('bb:set-mouse-through', (event, ignore) => {
    let win = winFrom(event.sender);
    if (win) {
        win.setIgnoreMouseEvents(ignore, { forward: true });
        
        // If this is a child window (like proxyWin), the shield is likely in the parent
        let targetWin = win;
        if (win.getParentWindow()) targetWin = win.getParentWindow();

        const shieldView = targetWin.contentView.children.find(c => c.webContents && c.webContents.getURL().includes('BBClickShield.html'));
        if (shieldView) {
            shieldView.webContents.setIgnoreMouseEvents(ignore, { forward: true });
        }
    }
});
ipcMain.on('bb:set-mouse-through-shield', (event, ignore) => {
    let win = winFrom(event.sender);
    if (win) {
        let targetWin = win;
        if (win.getParentWindow()) targetWin = win.getParentWindow();

        const shieldView = targetWin.contentView.children.find(c => c.webContents && c.webContents.getURL().includes('BBClickShield.html'));
        if (shieldView) {
            shieldView.webContents.setIgnoreMouseEvents(ignore, { forward: true });
        }
    }
});

ipcMain.on('bb:toggle-drawing', (event, active) => {
    let win = winFrom(event.sender);
    if (win) {
        let parentWin = win.getParentWindow() || win;
        const drawingWin = parentWin.drawingWin || parentWin.getChildWindows().find(c => c.getURL().includes('BBDrawing.html'));
        if (drawingWin) {
            if (active) {
                drawingWin.show();
                drawingWin.setIgnoreMouseEvents(false);
            } else {
                drawingWin.hide();
                drawingWin.setIgnoreMouseEvents(true, { forward: true });
            }
        }
    }
});

// --- BoardSend Integration (Scenario A, B, C) ---
// (REMOVED)

app.on('ready', () => {
    // --- YouTube 153 Embed Bypass ---
    const ytSession = session.fromPartition('persist:youtube');
    ytSession.webRequest.onBeforeSendHeaders(
        { urls: ['*://*.youtube.com/*', '*://*.youtu.be/*'] },
        (details, callback) => {
            details.requestHeaders['Referer'] = 'https://www.youtube.com/';
            details.requestHeaders['Origin'] = 'https://www.youtube.com';
            callback({ requestHeaders: details.requestHeaders });
        }
    );

    // --- BBVid Aggressive Hijacking (Round 3) ---

    // --- Unified Download System (Session-based) ---
    session.defaultSession.on('will-download', (event, item, webContents) => {
        const filename = item.getFilename();
        const ext = path.extname(filename).toLowerCase();
        
        const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m3u8'];
        const pdfExtensions = ['.pdf'];
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        
        let category = 'Other';
        if (videoExtensions.includes(ext)) category = 'Vid';
        else if (pdfExtensions.includes(ext)) category = 'PDF';
        else if (imageExtensions.includes(ext)) category = 'Img';

        const win = webContents.getOwnerBrowserWindow();
        const sessionInfo = win ? winSessionMap.get(win.id) : null;
        const url = item.getURL();

        if (sessionInfo) {
            // Round 137: High-speed Race Condition Prevention
            const now = Date.now();
            if (videoCache.has(url) && (now - videoCache.get(url)) < 3000) {
                console.log('[Main] Blocking duplicate download/hijack for:', url.substring(0, 50));
                item.cancel();
                return;
            }
            videoCache.set(url, now);

            const targetPath = path.join(sessionInfo[category], filename);

            // Duplicate Check
            if (fs.existsSync(targetPath)) {
                item.cancel();
                activeDownloads.delete(item); // Clean up
                if (!webContents.isDestroyed()) webContents.send('download:done', { filename, instant: true });
                updateHistory(win.id, category, { name: filename, path: targetPath });
                
                if (category === 'Vid') openVideoWindow(targetPath);
                else if (category === 'PDF') openPdfWindow(targetPath);
                else if (category === 'Img') openImgWindow(targetPath);
                else shell.openPath(targetPath);
                return;
            }

            item.setSavePath(targetPath);
            activeDownloads.add(item); // Track START
            
            item.on('updated', (event, state) => {
                if (state === 'progressing' && !item.isPaused()) {
                    const progress = item.getReceivedBytes() / item.getTotalBytes() * 100;
                    const statusData = { filename, progress, type: category.toLowerCase(), state: 'progressing' };
                    
                    // Send to original requester
                    if (!webContents.isDestroyed()) webContents.send('download:progress', statusData);
                    
                    // BROADCAST to Launcher (mainWindow) - Round 137
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('bb:launcher-download-status', statusData);
                    }
                }
            });
            
            item.once('done', (event, state) => {
                activeDownloads.delete(item); // Track END
                const statusData = { filename, type: category.toLowerCase(), state: state === 'completed' ? 'completed' : 'failed' };

                if (state === 'completed') {
                    if (!webContents.isDestroyed()) webContents.send('download:done', statusData);
                    
                    // Broadcast to Launcher
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('bb:launcher-download-status', statusData);
                    }

                    updateHistory(win.id, category, { name: filename, path: targetPath });
                    if (category === 'Vid') openVideoWindow(targetPath);
                    else if (category === 'PDF') openPdfWindow(targetPath);
                    else shell.openPath(targetPath);
                } else {
                    if (!webContents.isDestroyed()) webContents.send('download:failed', { filename });
                    
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('bb:launcher-download-status', statusData);
                    }
                }
            });
        }
    });

    registerIpcHandlers();

    // Universal DevTools Handler
    app.on('web-contents-created', (event, wc) => {
        wc.on('before-input-event', (ev, input) => {
            if (input.type === 'keyDown') {
                const key = input.key.toLowerCase();
                if ((input.control && input.shift && key === 'i') || key === 'f12') {
                    wc.openDevTools({ mode: 'detach' });
                }
            }
        });
    });
    
    // --- Auto-Launch Logic (Round 181) ---
    if (autoSubject && autoGrade) {
        console.log(`[Main] Auto-Launch detected: ${autoGrade} ${autoSubject}`);
        if (fs.existsSync(textbookIndexPath)) {
            try {
                const apps = JSON.parse(fs.readFileSync(textbookIndexPath, 'utf8'));
                const target = apps.find(a => {
                    const gradeMatch = a.grade === autoGrade;
                    const keywords = (a.subject || '').split(',').map(s => s.trim().toLowerCase());
                    const subjectMatch = keywords.includes(autoSubject.toLowerCase()) || (a.name || '').includes(autoSubject);
                    return gradeMatch && subjectMatch;
                });
                if (target) {
                    console.log('[Main] Auto-opening target:', target.name);
                    openTextbookWindow(target);
                    return; // Do not show launcher
                }
            } catch(e) { console.error('[Main] Auto-launch error:', e); }
        }
    }

    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- Round 123: AppData Cleanup ---
app.on('will-quit', () => {
    try {
        if (!isNotUsb && fs.existsSync(baseDataDir)) {
            console.log('[Main] USB Mode: Self-Destructing AppData Temp...');
            fs.rmSync(baseDataDir, { recursive: true, force: true });
        } else if (isNotUsb && fs.existsSync(tempRootDir)) {
            console.log('[Main] Installed Mode: Cleaning Temp Only...');
            fs.rmSync(tempRootDir, { recursive: true, force: true });
        }
    } catch(e) { console.error('[Main] Cleanup failed:', e); }
});



