(function() {
    // Round 117: God-Mode Fix & BBPdf Annotation (Coercion Safety)
    console.log('[BoardBook] God-Mode Active (Round 117)');

    // --- 0. Universal Resilient Proxy (God-Mode Refined) ---
    const mockCache = {};
    
    // Resource Shield: Mock 404s (Round 119 Extended Patch)
    const missingResources = ['JalnanOTF.otf', 'contents_update.json', 'config.xml', 'Jalnan.otf', 'Jalnan2.otf'];
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : "");
        if (missingResources.some(r => urlStr.includes(r))) {
            console.log(`[BoardBook] Resource Shield: Mocking ${urlStr}`);
            return Promise.resolve(new Response("{}", { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }));
        }
        return originalFetch.apply(this, arguments);
    };

    // FontFace API Shield
    if (window.FontFace) {
        const OriginalFontFace = window.FontFace;
        window.FontFace = function(name, source, descriptors) {
            if (typeof source === 'string' && missingResources.some(r => source.includes(r))) {
                console.log(`[BoardBook] FontFace Shield: Mocking ${source}`);
                // Return a dummy transparent dot or similar
                return new OriginalFontFace(name, 'url(data:font/woff2;base64,d09GMgABAAAAAALMAAA...dummy...)', descriptors);
            }
            return new OriginalFontFace(name, source, descriptors);
        };
    }

    const originalXHR = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalXHR.apply(this, arguments);
    };
    const originalSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.send = function() {
        if (typeof this._url === 'string' && missingResources.some(r => this._url.includes(r))) {
            console.log(`[BoardBook] XHR Shield: Mocking ${this._url}`);
            Object.defineProperty(this, 'status', { value: 200 });
            Object.defineProperty(this, 'responseText', { value: '{}' });
            Object.defineProperty(this, 'readyState', { value: 4 });
            this.dispatchEvent(new Event('load'));
            return;
        }
        return originalSend.apply(this, arguments);
    };
    const stringMethods = ['split', 'replace', 'trim', 'toLowerCase', 'toUpperCase', 'substring', 'substr', 'slice', 'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'match', 'matchAll', 'search', 'repeat', 'concat', 'charAt', 'charCodeAt', 'codePointAt'];
    const arrayMethods = ['filter', 'map', 'forEach', 'find', 'every', 'some', 'reduce', 'flat', 'includes', 'indexOf', 'join', 'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'sort', 'reverse'];
    const allCommonMethods = [...new Set([...stringMethods, ...arrayMethods])];

    function createGodProxy(name = "God") {
        if (mockCache[name]) return mockCache[name];
        
        const target = function() { return createGodProxy(`${name}()`); };

        const proxy = new Proxy(target, {
            get: (t, prop) => {
                if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor' || prop === 'prototype') return undefined;
                if (prop === '_isProxy') return true;
                if (prop === 'length') return 0;
                
                // CRITICAL FIX: To prevent "Cannot convert object to primitive value"
                if (prop === 'toString' || prop === 'valueOf' || prop === Symbol.toPrimitive) {
                    return () => "";
                }
                
                // Method call protection
                if (allCommonMethods.includes(prop)) {
                    return function() {
                        const isArrayReturn = ['filter', 'map', 'slice', 'splice', 'concat', 'match', 'matchAll', 'split'].includes(prop);
                        return isArrayReturn ? createGodProxy(`${name}.${String(prop)}[]`) : createGodProxy(`${name}.${String(prop)}()`);
                    };
                }

                return createGodProxy(`${name}.${String(prop)}`);
            },
            construct: () => createGodProxy(`new ${name}()`)
        });
        
        mockCache[name] = proxy;
        return proxy;
    }

    const essentialGlobals = ['uiInner', 'uiData', 'jj', 'TOV', 'app', 'config', 'viewer', 'params', 'data', 'book', 'page', 'content', 'resource', 'controller', 'layout'];
    essentialGlobals.forEach(g => { if (typeof window[g] === 'undefined') window[g] = createGodProxy(g); });
    if (!window.chrome) window.chrome = { runtime: { id: 'bb-extension', sendMessage: () => {} }, app: { isInstalled: true } };

    // --- 1. BBVid Precision Trigger ---
    let armedUrl = null;
    let armedTimer = null;

    function initBBVid() {
        const bridge = window.bb_bridge;
        if (!bridge) { setTimeout(initBBVid, 100); return; }

        console.log('[BBVid-Trace] Precision Trigger Ready (Round 117)');
        const isVideo = (url) => url && !url.includes('.ts') && /\.(mp4|mkv|avi|mov|wmv|flv|webm|m3u8)(\?|$)/i.test(url);

        bridge.on('bbvid:network-detect', (url) => {
            if (!isVideo(url)) return;
            console.log(`[BBVid-Trace] Signal Armed: ${url.substring(url.lastIndexOf('/')+1)}`);
            armedUrl = url;
            if (armedTimer) clearTimeout(armedTimer);
            armedTimer = setTimeout(() => { if (armedUrl === url) armedUrl = null; }, 30000);
            scanAndWatch();
        });

        setInterval(() => { if (armedUrl) scanAndWatch(); }, 200);
    }

    function scanAndWatch() {
        if (!armedUrl) return;
        function findVideos(root = document) {
            let found = [];
            root.querySelectorAll('video').forEach(v => found.push(v));
            root.querySelectorAll('iframe').forEach(frame => {
                try {
                    const innerDoc = frame.contentDocument || frame.contentWindow.document;
                    if (innerDoc) found = found.concat(findVideos(innerDoc));
                } catch(e) {}
            });
            return found;
        }

        findVideos().forEach(v => {
            if (v.dataset.bbvidInjected) return;
            const isVisible = v.offsetWidth > 10 && v.offsetHeight > 10;
            if (isVisible) {
                executeHijack(v);
            } else if (!v.dataset.bbvidWatched) {
                v.dataset.bbvidWatched = 'true';
                v.addEventListener('play', () => { if (armedUrl) executeHijack(v); }, { once: true });
            }
        });
    }

    function executeHijack(v) {
        if (!armedUrl || v.dataset.bbvidInjected) return;
        
        // Round 137: Cross-frame hijack prevention (Top-level sync)
        if (!window.top._bbvid_hijacks) window.top._bbvid_hijacks = new Set();
        if (window.top._bbvid_hijacks.has(armedUrl)) {
            v.dataset.bbvidInjected = 'true';
            armedUrl = null;
            return;
        }
        window.top._bbvid_hijacks.add(armedUrl);
        setTimeout(() => window.top._bbvid_hijacks.delete(armedUrl), 5000);

        v.dataset.bbvidInjected = 'true';
        const currentUrl = armedUrl; armedUrl = null;
        if (armedTimer) clearTimeout(armedTimer);

        console.log('[BBVid-Trace] Executing Hijack.');
        try { v.muted = true; v.volume = 0; v.pause(); } catch(e) {}
        
        // Filter out dummy/blank videos
        if (currentUrl.includes('blank.mp4') || currentUrl.includes('pixel.mp4')) {
            console.log('[BBVid-Trace] Skipping dummy video hijack.');
            return;
        }

        const overlay = document.createElement('div');
        overlay.style = `position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center; color: #38bdf8; z-index: 20000; font-family: sans-serif; font-weight: bold; font-size: 20px; text-align: center; pointer-events: none;`;
        overlay.innerHTML = `BBVid Deep Hijacking...`;
        
        if (v.parentElement) {
            if (getComputedStyle(v.parentElement).position === 'static') v.parentElement.style.position = 'relative';
            v.parentElement.appendChild(overlay);
        }

        // Direct play via bridge (Round 139)
        if (window.bb_bridge) {
            window.bb_bridge.send('bbvid:play', currentUrl);
        } else {
            const a = document.createElement('a');
            a.href = currentUrl;
            a.download = currentUrl.split('/').pop().split('?')[0] || 'video.mp4';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    }

    initBBVid();

    window.addEventListener('click', (e) => {
        const anchor = e.target.closest('a');
        if (anchor && anchor.href && /\.(pdf|hwp|pptx|docx|xlsx|zip|mp3|png|jpg)(\?|$)/i.test(anchor.href)) {
            console.log(`[BBVid-Trace] D2F Hijacked: ${anchor.href}`);
            e.preventDefault();
            e.stopPropagation();
            
            // Force download/open via BoardBook (Round 139)
            if (window.bb_bridge) {
                const url = anchor.href;
                const isPdf = url.toLowerCase().split('?')[0].endsWith('.pdf');
                const isVideo = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m3u8)(\?|$)/i.test(url);
                
                if (isPdf) {
                    window.bb_bridge.invoke('apps:openPdf', url);
                } else if (isVideo) {
                    window.bb_bridge.send('bbvid:play', url);
                } else {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = url.split('/').pop().split('?')[0] || 'file';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                }
            }
        }
    }, true);
})();
