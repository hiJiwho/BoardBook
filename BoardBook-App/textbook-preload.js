const { ipcRenderer } = require('electron');

// --- Event-Driven pHash Trigger ---
let pHashDebounce = null;

function triggerCapture() {
    clearTimeout(pHashDebounce);
    pHashDebounce = setTimeout(() => {
        const payload = {
            url: window.location.href,
            scrollTop: window.scrollY,
            scrollLeft: window.scrollX
        };
        ipcRenderer.send('bb:trigger-phash', payload);
        
        // Secondary capture after 2.0s (total 3.0s) to catch slow animations
        setTimeout(() => {
            ipcRenderer.send('bb:trigger-phash', payload);
        }, 2000);

        // Tertiary capture after 5.0s (total 6.0s) for heavy pages
        setTimeout(() => {
            ipcRenderer.send('bb:trigger-phash', payload);
        }, 5000);
    }, 1000);
}

// --- Recursive Listener Attachment (pHash only) ---
function attachRecursiveListeners(win) {
    try {
        if (win.__bb_attached) return;
        win.__bb_attached = true;

        // pHash triggers
        win.addEventListener('mouseup', triggerCapture, { capture: true });
        win.addEventListener('touchend', triggerCapture, { capture: true });
        win.addEventListener('keydown', (e) => {
            const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
            if (keys.includes(e.key)) triggerCapture();
        }, { capture: true });
        win.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) > 10) triggerCapture();
        }, { passive: true, capture: true });

        triggerCapture();

        // Monitor iframes
        const iframes = win.document.querySelectorAll('iframe');
        iframes.forEach(iframe => {
            try {
                if (iframe.contentWindow && iframe.contentDocument) {
                    attachRecursiveListeners(iframe.contentWindow);
                }
            } catch (e) { /* cross-origin */ }
        });
    } catch (e) {}
}

// --- Top-level global listeners (SPA / keyboard) ---
window.addEventListener('mouseup', triggerCapture);
window.addEventListener('touchend', triggerCapture);
window.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > 10) triggerCapture();
}, { passive: true });
window.addEventListener('hashchange', triggerCapture);
window.addEventListener('popstate', triggerCapture);
window.addEventListener('keydown', (e) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
    if (keys.includes(e.key)) triggerCapture();
});

function startBoardBook() {
    console.log('[BoardBook] Starting...');
    attachRecursiveListeners(window);

    setInterval(() => {
        attachRecursiveListeners(window);
        if (document.hasFocus()) triggerCapture();
    }, 5000);
}

// --- Minimalist UI Injection ---
function injectSiteControls() {
    if (document.getElementById('bb-sidebar-marker') || document.querySelector('.bb-header-left')) return;
    const handle = document.createElement('div');
    handle.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 8px;
        background: rgba(0,0,0,0.1); z-index: 2147483646;
        -webkit-app-region: drag;
    `;
    document.body.appendChild(handle);
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => { startBoardBook(); injectSiteControls(); });
} else {
    startBoardBook();
    injectSiteControls();
}
