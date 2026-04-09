const { ipcRenderer } = require('electron');

// --- State & Singletons ---
const singletonCanvas = document.createElement('canvas');
const singletonCtx = singletonCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
const dialog = document.getElementById('bbplus-dialog');
const hotspotContainer = document.getElementById('hotspot-container');

let lastFullHash = "";
let lastMetadata = { url: "", scrollTop: 0, scrollLeft: 0 };
let currentTextbookId = "";
let bbplusData = { mappings: [], assets: {} };
let pendingPosition = { x: 0, y: 0 };
let lastCheckDist = -1; 
let currentlyVisibleMatch = null; 
let lastResizeTime = 0; 
let pendingAssetId = null; 

async function init() {
    const appData = await ipcRenderer.invoke('bb:get-app-data');
    if (appData && appData.id) {
        currentTextbookId = appData.id;
        const raw = await ipcRenderer.invoke('bbplus:get-data', currentTextbookId);
        bbplusData = migrateData(raw);
        
        if (raw && (!raw.assets || Array.isArray(raw.assets))) {
            await ipcRenderer.invoke('bbplus:save-data', { textbookId: currentTextbookId, data: bbplusData });
        }
    }
}

function migrateData(raw) {
    if (!raw) return { mappings: [], assets: {} };
    if (raw.assets && !Array.isArray(raw.assets)) return raw;
    
    const newData = { mappings: [], assets: {} };
    const oldMappings = raw.mappings || (Array.isArray(raw) ? raw : []);
    
    oldMappings.forEach(m => {
        const newM = {
            hash: m.hash,
            hashes: m.hashes || [m.hash],
            url: m.url || "",
            assets: [] 
        };
        
        (m.assets || []).forEach(oldAsset => {
            const assetId = oldAsset.id || 'A' + Math.random().toString(36).substr(2, 9);
            newData.assets[assetId] = {
                type: oldAsset.type,
                value: oldAsset.value,
                color: oldAsset.color,
                icon: oldAsset.icon
            };
            newM.assets.push({
                assetId: assetId,
                x: oldAsset.x,
                y: oldAsset.y
            });
        });
        newData.mappings.push(newM);
    });
    return newData;
}
init();

// --- Module B: dHash & Matching ---
ipcRenderer.on('bb:trigger-phash', (event, dataUrl, metadata) => processDHash(dataUrl, metadata));

setTimeout(() => {
    ipcRenderer.send('bb:trigger-phash');
}, 2000);

async function processDHash(providedData, metadata) {
    let img = null;
    let objectUrl = null;
    try {
        const data = providedData || await ipcRenderer.invoke('bb:capture-target');
        if (!data) return;

        if (metadata) lastMetadata = metadata;

        img = new Image();
        img.onload = () => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width; tempCanvas.height = img.height;
            const tCtx = tempCanvas.width > 0 ? tempCanvas.getContext('2d') : null;
            if (!tCtx) return;
            tCtx.drawImage(img, 0, 0);
            
            const fullData = tCtx.getImageData(0, 0, img.width, img.height).data;
            let minX = img.width, maxX = 0, minY = img.height, maxY = 0;
            
            // Sample corners for background color (often #FAFAFA, #EEEEEE or #FFFFFF)
            const bgR = (fullData[0] + fullData[(img.width-1)*4]) / 2;
            const bgG = (fullData[1] + fullData[(img.width-1)*4+1]) / 2;
            const bgB = (fullData[2] + fullData[(img.width-1)*4+2]) / 2;
            
            // Scan for content bounds (coarse scan for performance)
            const step = Math.max(1, Math.floor(img.width / 100));
            for (let y = 0; y < img.height; y += step) {
                for (let x = 0; x < img.width; x += step) {
                    const idx = (y * img.width + x) * 4;
                    const dr = Math.abs(fullData[idx] - bgR);
                    const dg = Math.abs(fullData[idx+1] - bgG);
                    const db = Math.abs(fullData[idx+2] - bgB);
                    if (dr + dg + db > 25) { // Threshold for content
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            
            // Fallback if no content found or crop is too small
            if (maxX <= minX || maxY <= minY || (maxX - minX) < img.width * 0.1) {
                minX = 0; minY = 0; maxX = img.width; maxY = img.height;
            } else {
                // Add minor padding
                minX = Math.max(0, minX - 10); minY = Math.max(0, minY - 10);
                maxX = Math.min(img.width, maxX + 10); maxY = Math.min(img.height, maxY + 10);
            }

            singletonCanvas.width = 17; singletonCanvas.height = 16;
            singletonCtx.drawImage(img, minX, minY, maxX - minX, maxY - minY, 0, 0, 17, 16);
            
            const imageData = singletonCtx.getImageData(0, 0, 17, 16);
            const px = imageData.data;
            const grays = [];
            for (let y = 0; y < 16; y++) {
                const row = [];
                for (let x = 0; x < 17; x++) {
                    const idx = (y * 17 + x) * 4;
                    row.push(px[idx] * 0.299 + px[idx+1] * 0.587 + px[idx+2] * 0.114);
                }
                grays.push(row);
            }
            let bits = "";
            for (let y = 0; y < 16; y++) {
                for (let x = 0; x < 16; x++) {
                    bits += (grays[y][x] > grays[y][x+1] ? "1" : "0");
                }
            }
            
            const diffFromLast = lastFullHash ? getHammingDistance(lastFullHash, bits) : 999;
            lastFullHash = bits; 
            
            if (diffFromLast >= 3 || (metadata && metadata.isResize)) {
                checkMatches(lastFullHash, lastMetadata);
            }

            if (objectUrl) URL.revokeObjectURL(objectUrl);
            img.src = ""; img = null;
        };

        if (typeof data === 'string') {
            img.src = data;
        } else {
            const blob = new Blob([data], { type: 'image/jpeg' });
            objectUrl = URL.createObjectURL(blob);
            img.src = objectUrl;
        }
    } catch (e) { console.error('[Proxy] dHash error:', e); }
}

function checkMatches(currentHash, metadata) {
    if (!hotspotContainer) return null;
    hotspotContainer.innerHTML = '';
    const currentUrl = metadata ? (metadata.url || "").split('?')[0] : "";

    if (!bbplusData.mappings || bbplusData.mappings.length === 0) return null;

    let minOffset = 999;
    let bestMatch = null;
    
    bbplusData.mappings.forEach(m => {
        const hashes = m.hashes || [m.hash];
        hashes.forEach(h => {
            const hashDist = getHammingDistance(h, currentHash);
            if (hashDist < minOffset) {
                minOffset = hashDist;
                bestMatch = m;
            }
        });
    });

    const threshold = 64; 
    const adaptiveLimit = 90;

    if (bestMatch && minOffset <= threshold) {
        bestMatch.assets.forEach(ref => {
            const asset = bbplusData.assets[ref.assetId];
            if (asset) {
                renderHotspot({ ...asset, ...ref, id: ref.assetId });
            }
        });
        currentlyVisibleMatch = bestMatch;

        if (minOffset > 0 && minOffset <= adaptiveLimit) {
            const hashes = bestMatch.hashes || [bestMatch.hash];
            const alreadyStored = hashes.some(h => getHammingDistance(h, currentHash) < 8);
            if (!alreadyStored) {
                hashes.push(currentHash);
                if (hashes.length > 50) hashes.shift();
                bestMatch.hashes = hashes;
                ipcRenderer.invoke('bbplus:save-data', { textbookId: currentTextbookId, data: bbplusData });
            }
        }
    } else {
        currentlyVisibleMatch = null;
    }
    
    lastCheckDist = minOffset;
    return (minOffset <= threshold) ? bestMatch : null;
}

function getHammingDistance(h1, h2) {
    if (!h1 || !h2 || h1.length !== h2.length) return 999;
    let dist = 0;
    for (let i = 0; i < h1.length; i++) {
        if (h1[i] !== h2[i]) dist++;
    }
    return dist;
}

function renderHotspot(asset) {
    const el = document.createElement('div');
    el.className = 'bbplus-hotspot';
    el.style.left = asset.x + '%';
    el.style.top = asset.y + '%';
    el.style.background = asset.color || 'var(--m3-primary-container)';
    el.style.color = 'var(--m3-on-primary-container)'; 
    el.innerHTML = `<span class="emoji">${asset.icon || '🔗'}</span>`;
    el.style.pointerEvents = 'auto'; 
    el.title = asset.value;

    el.onmouseenter = () => ipcRenderer.send('bb:set-mouse-through', false);
    el.onmouseleave = () => {
        const menu = document.getElementById('hotspot-ctx-menu');
        if ((dialog.style.display === 'none' || dialog.style.display === '') && !menu) {
            ipcRenderer.send('bb:set-mouse-through', true);
        }
    };

    el.onclick = (e) => {
        e.stopPropagation();
        handleAssetAction(asset);
    };

    el.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showHotspotMenu({ px: e.clientX, py: e.clientY }, asset);
    };

    hotspotContainer.appendChild(el);
}

async function handleAssetAction(asset) {
    const type = asset.type;
    const val = asset.value;

    // Relay hotspot action to BoardSend if connected
    ipcRenderer.send('bbplus:relay-resource', { type, value: val, icon: asset.icon });

    if (type === 'url') {
        ipcRenderer.invoke('apps:openUrl', val);
    } else if (type === 'vid' || type === 'pdf' || type === 'img') {
        const fullPath = await ipcRenderer.invoke('bbplus:get-asset-path', { textbookId: currentTextbookId, filename: val });
        if (fullPath) {
            if (type === 'vid') ipcRenderer.invoke('apps:openVideo', fullPath);
            else if (type === 'pdf') ipcRenderer.invoke('apps:openPdf', fullPath);
            else if (type === 'img') ipcRenderer.invoke('apps:openImg', fullPath);
        } else {
            alert('파일을 찾을 수 없습니다: ' + val);
        }
    }
}

// --- Module D: Mapping UI ---
const BBP_COLORS = ['#0061a4', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6', '#f97316', '#64748b'];
const BBP_ICONS = ['🔗', '📁', '🎬', '📄', '🖼️', '💬', '⭐', '💡', '📌'];

let selectedColor = BBP_COLORS[0];
let selectedIcon = BBP_ICONS[0];
let activeTab = 'url';

function initPalettes() {
    const colorRoot = document.getElementById('color-palette');
    const iconRoot = document.getElementById('icon-palette');
    if (!colorRoot || !iconRoot) return;

    colorRoot.innerHTML = '';
    iconRoot.innerHTML = '';
    
    BBP_COLORS.forEach(c => {
        const dot = document.createElement('div');
        dot.className = 'color-dot' + (c === selectedColor ? ' active' : '');
        dot.style.background = c;
        dot.onclick = () => {
            selectedColor = c;
            Array.from(colorRoot.children).forEach(el => el.classList.remove('active'));
            dot.classList.add('active');
        };
        colorRoot.appendChild(dot);
    });

    BBP_ICONS.forEach(i => {
        const box = document.createElement('div');
        box.className = 'icon-box' + (i === selectedIcon ? ' active' : '');
        box.textContent = i;
        box.onclick = () => {
            selectedIcon = i;
            Array.from(iconRoot.children).forEach(el => el.classList.remove('active'));
            box.classList.add('active');
        };
        iconRoot.appendChild(box);
    });

    document.querySelectorAll('.bbp-tab').forEach(tab => {
        tab.onclick = () => {
            activeTab = tab.dataset.tab;
            document.querySelectorAll('.bbp-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById('tab-' + activeTab).classList.add('active');
        };
    });
}

function openMappingDialog(pos) {
    pendingPosition = { x: pos.px * 100 / window.innerWidth, y: pos.py * 100 / window.innerHeight };
    if (pos.xRel && pos.yRel) pendingPosition = { x: pos.xRel, y: pos.yRel };

    document.body.style.pointerEvents = 'auto';
    
    if (pos.px < window.innerWidth / 2) {
        dialog.style.left = 'auto';
        dialog.style.right = '24px';
    } else {
        dialog.style.right = 'auto';
        dialog.style.left = '24px';
    }
    
    dialog.style.top = '56px'; 
    dialog.style.display = 'flex';
    ipcRenderer.send('bb:set-mouse-through', false);

    const hashEl = document.getElementById('bbp-hash');
    if (hashEl) hashEl.innerText = `Hash: ${lastFullHash.substring(0, 16)}...`;
}

ipcRenderer.on('bbplus:open-dialog', (event, pos) => {
    openMappingDialog({ px: pos.px, py: pos.py, xRel: pos.x, yRel: pos.y });
});

window.closeMapping = () => {
    if (dialog) dialog.style.display = 'none';
    pendingAssetId = null; 
    document.body.style.pointerEvents = 'none'; 
    ipcRenderer.send('bb:set-mouse-through', true); 
};

window.pickFileMapping = async (targetType = 'vid') => {
    let filters = [];
    if (targetType === 'vid') filters = [{ name: 'Videos', extensions: ['mp4', 'mkv', 'avi', 'mov'] }];
    else if (targetType === 'pdf') filters = [{ name: 'Documents', extensions: ['pdf'] }];
    else if (targetType === 'img') filters = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }];

    const sourcePath = await ipcRenderer.invoke('dialog:openFile', filters);
    if (!sourcePath) return;
    
    const localName = await ipcRenderer.invoke('bbplus:copy-file', {
        textbookId: currentTextbookId,
        sourcePath: sourcePath
    });
    
    if (localName) {
        const input = document.getElementById('val-' + targetType);
        if (input) input.value = localName;
    }
};

window.saveMapping = async (type) => {
    const existingAssetId = pendingAssetId; 
    let value = '';
    if (type === 'url') {
        value = document.getElementById('val-url').value;
        if (value && !value.includes('://')) value = 'https://' + value;
    } else {
        const input = document.getElementById('val-' + type);
        value = input ? input.value : '';
    }

    if (!value) {
        alert('내용을 입력해주세요!');
        return;
    }

    const hashToSave = lastFullHash;
    const currentUrl = lastMetadata.url ? lastMetadata.url.split('?')[0] : "";
    
    let mapping = bbplusData.mappings.find(m => {
        return (m.url === currentUrl || (!m.url && !currentUrl)) && getHammingDistance(m.hash, hashToSave) < 3;
    });

    if (existingAssetId) {
        if (bbplusData.assets[existingAssetId]) {
            bbplusData.assets[existingAssetId] = { type, value, color: selectedColor, icon: selectedIcon };
        }
    } else {
        if (!mapping) {
            mapping = { hash: hashToSave, hashes: [hashToSave], assets: [], url: currentUrl };
            bbplusData.mappings.push(mapping);
        }
        
        const isDuplicate = mapping.assets.some(ref => {
            const asset = bbplusData.assets[ref.assetId];
            return asset && asset.type === type && asset.value === value && asset.icon === selectedIcon && 
                   Math.abs(ref.x - pendingPosition.x) < 2 && Math.abs(ref.y - pendingPosition.y) < 2;
        });

        if (isDuplicate) {
            alert('이미 같은 위치에 동일한 정보가 있습니다.');
            return;
        }

        const assetId = 'A' + Math.random().toString(36).substr(2, 9);
        bbplusData.assets[assetId] = { type, value, color: selectedColor, icon: selectedIcon };
        mapping.assets.push({ assetId, x: pendingPosition.x, y: pendingPosition.y });
    }

    await ipcRenderer.invoke('bbplus:save-data', { textbookId: currentTextbookId, data: bbplusData });
    checkMatches(lastFullHash, lastMetadata);
    closeMapping();
};

function showHotspotMenu(pos, asset) {
    const existing = document.getElementById('hotspot-ctx-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'hotspot-ctx-menu';
    menu.style.display = 'block';
    menu.style.left = pos.px + 'px';
    menu.style.top = pos.py + 'px';

    const items = [
        { icon: '📝', text: '정보 수정' },
        { icon: '🗑️', text: '삭제' }
    ].map(data => {
        const item = document.createElement('div');
        item.className = 'ctx-item';
        item.innerHTML = `<span>${data.icon}</span> ${data.text}`;
        menu.appendChild(item);
        return item;
    });

    document.body.appendChild(menu);
    ipcRenderer.send('bb:set-mouse-through', false);
    document.body.style.pointerEvents = 'auto';
    
    // Explicitly tell shield to ignore while we handle the menu
    ipcRenderer.send('bb:set-mouse-through-shield', true);

    items[0].onclick = (e) => {
        e.stopPropagation();
        menu.remove();
        pendingPosition = { x: asset.x, y: asset.y };
        pendingAssetId = asset.id;
        
        const input = document.getElementById('val-' + asset.type);
        if (input) input.value = asset.value;
        
        openMappingDialog({ px: asset.x * window.innerWidth / 100, py: asset.y * window.innerHeight / 100 });
        const tab = document.querySelector(`.bbp-tab[data-tab="${asset.type}"]`);
        if (tab) tab.click();
    };

    items[1].onclick = (e) => {
        e.stopPropagation();
        if (confirm('삭제하시겠습니까?')) {
            deleteHotspot(asset.id);
        }
        menu.remove();
        ipcRenderer.send('bb:set-mouse-through', true);
        document.body.style.pointerEvents = 'none';
    };

    const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('mousedown', closeHandler);
            if (dialog.style.display !== 'flex') {
                ipcRenderer.send('bb:set-mouse-through', true);
                document.body.style.pointerEvents = 'none';
            }
        }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 100);
}

async function deleteHotspot(assetId) {
    delete bbplusData.assets[assetId];
    bbplusData.mappings.forEach(m => {
        m.assets = m.assets.filter(ref => ref.assetId !== assetId);
    });
    bbplusData.mappings = bbplusData.mappings.filter(m => m.assets.length > 0);
    await ipcRenderer.invoke('bbplus:save-data', { textbookId: currentTextbookId, data: bbplusData });
    checkMatches(lastFullHash, lastMetadata);
}

function generateId(length) {
    return 'A' + Math.random().toString(36).substr(2, length);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPalettes);
} else {
    initPalettes();
}

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') ipcRenderer.send('bb:open-devtools');
});
