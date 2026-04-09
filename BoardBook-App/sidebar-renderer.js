const { ipcRenderer } = require('electron');
const q = s => document.getElementById(s);

const btnClose = document.getElementById('btnClose');
const btnMax = document.getElementById('btnMax');
const btnPen = document.getElementById('btnPen');
const btnMouse = document.getElementById('btnMouse');
const btnEraser = document.getElementById('btnEraser');
const btnWhiteboard = document.getElementById('btnWhiteboard');

// Dual-mode Mode Elements
const panelUrl = document.getElementById('panel-url');
const panelDraw = document.getElementById('panel-draw');
const btnSwitchToDraw = document.getElementById('btnSwitchToDraw');
const btnUrlBack = document.getElementById('btnUrlBack');
const btnUrlForward = document.getElementById('btnUrlForward');
const btnUrlReload = document.getElementById('btnUrlReload');
const btnUrlInput = document.getElementById('btnUrlInput');

// Mode detection
const urlParams = new URLSearchParams(window.location.search);
const currentMode = urlParams.get('mode') || 'textbook';

let isDrawMode = (currentMode === 'textbook' || currentMode === 'img' || currentMode === 'whiteboard');

const activeMediaPanel = document.getElementById('panel-' + currentMode);
const pdfNavInDraw = document.getElementById('draw-pdf-nav');

function updateSidebarVisibility() {
    // Hide all panels initially
    document.querySelectorAll('.section[id^="panel-"]').forEach(p => p.style.display = 'none');
    
    if (isDrawMode) {
        panelDraw.style.display = 'flex';
        if (currentMode === 'pdf') {
            if (pdfNavInDraw) pdfNavInDraw.style.display = 'flex';
            // Custom BBPdf Rules: Toggle Pen/Eraser
            if (currentTool === 'pencil') {
                if (btnPen) btnPen.style.display = 'none';
                if (btnEraser) btnEraser.style.display = 'flex';
            } else {
                if (btnPen) btnPen.style.display = 'flex';
                if (btnEraser) btnEraser.style.display = 'none';
            }
            if (document.getElementById('btnDrawPdfPrev')) document.getElementById('btnDrawPdfPrev').style.display = 'none';
            if (btnMouse) btnMouse.style.display = 'flex';
        } else if (currentMode === 'whiteboard') {
            // Whiteboard rules: No Mouse, No Board buttons
            if (btnMouse) btnMouse.style.display = 'none';
            if (btnWhiteboard) btnWhiteboard.style.display = 'none';
            if (btnPen) btnPen.style.display = 'flex'; 
        } else {
            if (btnPen) btnPen.style.display = 'flex';
            if (btnMouse) btnMouse.style.display = 'flex';
            if (btnWhiteboard) btnWhiteboard.style.display = 'flex';
            if (document.getElementById('btnDrawPdfPrev')) document.getElementById('btnDrawPdfPrev').style.display = 'flex';
        }
    } else {
        if (activeMediaPanel) activeMediaPanel.style.display = 'flex';
        if (pdfNavInDraw) pdfNavInDraw.style.display = 'none';
    }
}

// Initial Call
updateSidebarVisibility();
// Auto-activate Pen for Whiteboard after a brief delay to ensure drawing layer is ready
if (currentMode === 'whiteboard') setTimeout(() => {
    if (typeof handlePenClick === 'function') handlePenClick();
}, 500);

if (q('btnClearAll')) q('btnClearAll').onclick = () => {
    if (confirm('모든 판서를 지우시겠습니까?')) {
        ipcRenderer.send('bb:clear-drawing');
    }
};

btnClose.onclick = () => ipcRenderer.send('bb:close-window');
btnMax.onclick = () => ipcRenderer.send('bb:maximize-window');

function updateDrawingTool() {
    if (currentTool === 'mouse') {
        ipcRenderer.send('bb:toggle-drawing', false);
    } else {
        ipcRenderer.send('bb:toggle-drawing', true);
        ipcRenderer.send('bb:set-drawing-tool', { 
            tool: currentTool, 
            color: currentColor, 
            thickness: currentSize 
        });
    }
}

let currentColor = '#000';
let currentSize = 8;
let currentTool = 'mouse'; // Sync with initial active state

const handlePenClick = () => {
    currentTool = 'pen';
    isDrawMode = true;
    if (btnPen) btnPen.classList.add('active');
    if (btnMouse) btnMouse.classList.remove('active');
    if (btnEraser) btnEraser.classList.remove('active');
    updateDrawingTool();
    updateSidebarVisibility();
};
if (btnPen) btnPen.onclick = handlePenClick;
btnMouse.onclick = () => {
    if (currentMode === 'pdf' && isDrawMode) {
        isDrawMode = false;
        currentTool = 'mouse';
        ipcRenderer.send('bb:toggle-drawing', false);
        updateSidebarVisibility();
        return;
    }
    
    if (!['textbook', 'img'].includes(currentMode) && isDrawMode) {
        isDrawMode = false;
        currentTool = 'mouse'; // Update state!
        updateSidebarVisibility();
        if (currentMode === 'vid') ipcRenderer.send('bb:vid-play-pause', 'play');
        ipcRenderer.send('bb:toggle-drawing', false);
        ipcRenderer.send('bb:clear-drawing');
        return;
    }

    currentTool = 'mouse';
    btnMouse.classList.add('active');
    btnPen.classList.remove('active');
    btnEraser.classList.remove('active');
    updateDrawingTool();
};

const handleToggleMousePen = () => {
    ipcRenderer.send('bb:log', `[Sidebar] handleToggleMousePen: currentMode=${currentMode}, currentTool=${currentTool}`);
    if (currentMode === 'whiteboard') return; // Ignore MP Toggle in WB
    if (currentTool === 'pencil' || currentTool === 'eraser') {
        if (btnMouse) btnMouse.click();
    } else {
        if (btnPen) btnPen.click();
    }
};

const handleTogglePenEraser = () => {
    if (currentTool === 'eraser') {
        if (btnPen) btnPen.click();
    } else {
        if (btnEraser) btnEraser.click();
    }
};

ipcRenderer.on('bb:serial-toggle-mouse-pen', handleToggleMousePen);
ipcRenderer.on('bb:serial-toggle-pen-eraser', handleTogglePenEraser);

document.querySelectorAll('.action-switch-draw').forEach(btn => {
    btn.onclick = () => {
        isDrawMode = true;
        updateSidebarVisibility();
        if (currentMode === 'vid') ipcRenderer.send('bb:vid-play-pause', 'pause');
        
        // Auto-select Pen
        currentTool = 'pen';
        btnPen.classList.add('active');
        btnMouse.classList.remove('active');
        btnEraser.classList.remove('active');
        updateDrawingTool();
    };
});

if (btnUrlBack) btnUrlBack.onclick = () => ipcRenderer.send('bb:url-back');
if (btnUrlForward) btnUrlForward.onclick = () => ipcRenderer.send('bb:url-forward');
if (btnUrlReload) btnUrlReload.onclick = () => ipcRenderer.send('bb:url-reload');
if (btnUrlInput) btnUrlInput.onclick = () => ipcRenderer.send('bb:show-url-bar');

/* q helper moved to top */
// PDF Handlers
const handlePdfPrev = () => ipcRenderer.send('bb:pdf-prev');
const handlePdfNext = () => ipcRenderer.send('bb:pdf-next');

if (q('btnPdfPrev')) q('btnPdfPrev').onclick = handlePdfPrev;
if (q('btnPdfNext')) q('btnPdfNext').onclick = handlePdfNext;
if (q('btnDrawPdfPrev')) q('btnDrawPdfPrev').onclick = handlePdfPrev;
if (q('btnDrawPdfNext')) q('btnDrawPdfNext').onclick = handlePdfNext;

if (q('btnPdfZoomIn')) q('btnPdfZoomIn').onclick = () => ipcRenderer.send('bb:pdf-zoom-in');
if (q('btnPdfZoomOut')) q('btnPdfZoomOut').onclick = () => ipcRenderer.send('bb:pdf-zoom-out');
if (q('btnPdfFitV')) q('btnPdfFitV').onclick = () => ipcRenderer.send('bb:pdf-fit-v');
if (q('btnPdfFitH')) q('btnPdfFitH').onclick = () => ipcRenderer.send('bb:pdf-fit-h');

// VID Handlers
if (q('btnVidPlayPause')) q('btnVidPlayPause').onclick = () => ipcRenderer.send('bb:vid-play-pause', 'toggle');
if (q('btnVidRewind')) q('btnVidRewind').onclick = () => ipcRenderer.send('bb:vid-rewind');
if (q('btnVidForward')) q('btnVidForward').onclick = () => ipcRenderer.send('bb:vid-forward');
if (q('btnVidVolume')) q('btnVidVolume').onclick = () => ipcRenderer.send('bb:vid-volume');
if (q('btnVidTimeline')) q('btnVidTimeline').onclick = () => ipcRenderer.send('bb:vid-timeline');

// Video Speed Control
let currentVidSpeedIdx = 1;
const vidSpeeds = [0.5, 1.0, 1.5, 2.0];
if (q('btnVidSpeed')) q('btnVidSpeed').onclick = () => {
    currentVidSpeedIdx = (currentVidSpeedIdx + 1) % vidSpeeds.length;
    const newSpeed = vidSpeeds[currentVidSpeedIdx];
    q('btnVidSpeed').innerText = newSpeed.toFixed(1) + 'x';
    ipcRenderer.send('bb:vid-speed', newSpeed);
};

btnEraser.onclick = () => {
    currentTool = 'eraser';
    isDrawMode = true; // Fix: Ensure we return to draw mode
    btnEraser.classList.add('active');
    btnPen.classList.remove('active');
    btnMouse.classList.remove('active');
    updateDrawingTool();
    updateSidebarVisibility();
};

// Colors
document.querySelectorAll('.color-dot').forEach(dot => {
    dot.onclick = () => {
        currentColor = dot.dataset.color;
        document.querySelectorAll('.color-dot').forEach(d => {
            d.classList.remove('active');
            d.style.borderColor = 'white';
        });
        dot.classList.add('active');
        
        // Auto-switch to pen if color is changed
        if (currentTool !== 'pencil' && currentTool !== 'eraser') {
            btnPen.click();
        } else {
            updateDrawingTool();
        }
    };
});

// Thickness
document.querySelectorAll('.thickness-dot').forEach(dot => {
    dot.onclick = () => {
        currentSize = parseInt(dot.dataset.size);
        document.querySelectorAll('.thickness-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
        
        // Auto-switch to pen if thickness is changed (Round 175)
        if (currentTool !== 'pencil' && currentTool !== 'eraser') {
            btnPen.click();
        } else {
            updateDrawingTool();
        }
    };
});

btnWhiteboard.onclick = () => {
    ipcRenderer.send('bb:open-whiteboard');
};


/* btnSync removed */

// Initial state
btnMouse.classList.add('active');

// BoardSend Inverse Integration Support
ipcRenderer.invoke('flags:getAutoArgs').then(args => {
    if (args.bsApiPort) {
        const widget = q('boardsend-sidebar-widget');
        if (widget) widget.style.display = 'flex';
        
        if (q('btnBoardSend')) q('btnBoardSend').onclick = () => {
            ipcRenderer.send('bb:open-boardsend-dashboard');
        };

        if (q('btnBoardSendCapture')) q('btnBoardSendCapture').onclick = () => {
            ipcRenderer.send('bb:trigger-phash'); // Explicitly trigger mission capture
        };

        const updateBSStatus = async () => {
            const status = await ipcRenderer.invoke('bb:get-boardsend-status');
            const dot = q('bsStatusDot');
            const label = q('bsCountLabel');
            if (!dot || !label) return;

            if (status && status.online) {
                dot.classList.add('online');
                label.innerText = (status.studentCount || 0) + '명';
            } else {
                dot.classList.remove('online');
                label.innerText = '0명';
            }
        };
        setInterval(updateBSStatus, 5000);
        updateBSStatus();
    }
});

if (currentMode === 'url') {
    panelUrl.style.display = 'flex';
    panelDraw.style.display = 'none';
}
