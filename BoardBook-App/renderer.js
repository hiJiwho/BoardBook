const appGrid = document.getElementById('app-grid');
const btnAdd = document.getElementById('btn-add');
const addModal = document.getElementById('add-modal');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalSave = document.getElementById('btn-modal-save');

const inputName = document.getElementById('app-name');
const inputUrl = document.getElementById('app-url');

let apps = [];
let masterMode = false;

async function loadApps() {
    try {
        masterMode = await window.electronAPI.isNotUsb();
    } catch(e) { masterMode = false; }

    try {
        const isComport = await window.electronAPI.isComport();
        if (isComport) {
            const serialSection = document.getElementById('serial-section');
            if (serialSection) serialSection.style.display = 'block';
            
            const header = document.getElementById('textbook-header');
            if (header) header.innerText = '디바이스 연결 후 프로그램을 선택하세요';
            
            refreshSerialPorts();
        }
    } catch(e) { console.warn('[Renderer] ComPort check failed:', e); }

    try {
        apps = await window.electronAPI.getApps();
        renderGrid();
    } catch(e) { console.error('[Renderer] loadApps failed:', e); }
}

async function refreshSerialPorts() {
    const list = document.getElementById('serial-port-list');
    if (!list) return;
    
    list.innerHTML = '<option value="">포트를 검색 중...</option>';
    const ports = await window.electronAPI.getSerialPorts();
    list.innerHTML = '<option value="">포트를 선택하세요...</option>';
    
    ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.innerText = `${p.path} (${p.friendlyName || p.manufacturer || 'Unknown'})`;
        list.appendChild(opt);
    });
}

document.getElementById('btn-serial-refresh').onclick = refreshSerialPorts;
document.getElementById('btn-serial-connect').onclick = async () => {
    const path = document.getElementById('serial-port-list').value;
    const statusText = document.getElementById('serial-status-text');
    if (!path) {
        alert('포트를 선택해주세요.');
        return;
    }
    
    statusText.innerText = '연결 중...';
    statusText.style.color = 'var(--accent)';
    
    const result = await window.electronAPI.connectSerial(path);
    if (result.success) {
        statusText.innerText = `연결됨: ${path}`;
        statusText.style.color = '#10b981';
    } else {
        statusText.innerText = `연결 실패: ${result.error}`;
        statusText.style.color = '#ef4444';
    }
};

const getSubjectIcon = (subjectStr) => {
    const firstSubject = (subjectStr || '기타').split(',')[0].trim();
    const icons = {
        '국어': '📖',
        '수학': '📐',
        '사회': '🌍',
        '과학': '🧪',
        '영어': '🔤',
        '예술': '🎨',
        '체육': '🏃',
        '도덕': '⚖️',
        '정보': '💻',
        '기술가정': '🏠',
        '기타': '📚'
    };
    return icons[firstSubject] || '📚';
};

function renderGrid() {
    const appGrid = document.getElementById('app-grid');
    const _btnAdd = document.getElementById('btn-add');
    appGrid.innerHTML = '';
    
    apps.forEach((app, index) => {
        const div = document.createElement('div');
        div.className = 'app-card';
        
        let iconHtml = `<div class="icon-wrapper">${getSubjectIcon(app.subject || '기타')}</div>`;
        try {
            if (!app.subject || app.subject === '기타') {
                const url = new URL(app.url);
                const favicon = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=128`;
                iconHtml = `<div class="icon-wrapper" style="background: white;"><img src="${favicon}" style="width:32px; height:32px;"></div>`;
            }
        } catch(e) {}

        const controlHtml = masterMode ? `
            <div class="card-controls">
                <button class="control-btn edit" title="수정">📝</button>
                <button class="control-btn delete" title="삭제">×</button>
            </div>
        ` : '';

        div.innerHTML = `
            ${controlHtml}
            ${iconHtml}
            <div class="name" style="margin-top: 8px;">${app.name}</div>
            <div style="font-size: 0.7rem; color: var(--m3-outline); font-weight: 500; margin-top: 4px; opacity: 0.8;">${app.grade || ''} ${app.subject || ''}</div>
        `;
        
        if (masterMode) {
            div.querySelector('.delete').onclick = (e) => { e.stopPropagation(); deleteApp(index); };
            div.querySelector('.edit').onclick = (e) => { e.stopPropagation(); editApp(index); };
        }

        div.onclick = () => window.electronAPI.openApp(app);
        appGrid.appendChild(div);
    });
    
    if (masterMode) {
        appGrid.appendChild(btnAdd);
    }
}

let editingIndex = -1;

function editApp(index) {
    editingIndex = index;
    const app = apps[index];
    document.getElementById('app-name').value = app.name;
    document.getElementById('app-url').value = app.url;
    document.getElementById('app-subject').value = app.subject || '기타';
    document.getElementById('app-grade').value = app.grade || '공통';
    
    document.getElementById('btn-modal-save').innerText = '정보 수정';
    addModal.style.display = 'flex';
}


const deleteApp = async (index) => {
    if (confirm(`'${apps[index].name}' 교과서를 삭제하시겠습니까?`)) {
        apps.splice(index, 1);
        await window.electronAPI.saveApps(apps);
        renderGrid();
        document.getElementById('status').innerText = '삭제되었습니다.';
    }
};

btnAdd.onclick = () => {
    editingIndex = -1;
    inputName.value = '';
    inputUrl.value = '';
    document.getElementById('btn-modal-save').innerText = '링크 저장';
    addModal.style.display = 'flex';
};

btnModalCancel.onclick = () => {
    addModal.style.display = 'none';
};

btnModalSave.onclick = async () => {
    const name = inputName.value.trim();
    const url = inputUrl.value.trim();
    const subject = document.getElementById('app-subject').value;
    const grade = document.getElementById('app-grade').value;

    if (!name || !url) {
        alert('이름과 URL을 모두 입력해주세요.');
        return;
    }

    const appData = {
        id: editingIndex >= 0 ? apps[editingIndex].id : Math.floor(100000 + Math.random() * 900000).toString(),
        name, url, subject, grade,
        type: 'Web'
    };
    
    if (editingIndex >= 0) {
        apps[editingIndex] = appData;
        editingIndex = -1;
    } else {
        apps.push(appData);
    }
    
    await window.electronAPI.saveApps(apps);
    renderGrid();
    addModal.style.display = 'none';
    document.getElementById('status').innerText = '변경사항 저장 완료';
};

// --- USB Export UI (Round 150) ---
const btnUsbExport = document.getElementById('btn-usb-export');
if (btnUsbExport) {
    // Check if --NotUSB flag was passed
    window.electronAPI.isNotUsb().then(isNotUsb => {
        if (isNotUsb) btnUsbExport.style.display = 'block';
    });

    btnUsbExport.onclick = async () => {
        const result = await window.electronAPI.exportToUsb();
        if (result.success) alert(`USB 동기화 완료: ${result.path}`);
        else if (result.error) alert(`실패: ${result.error}`);
    };
}

const btnUsbImport = document.getElementById('btn-usb-import');
if (btnUsbImport) {
    window.electronAPI.isNotUsb().then(isNotUsb => {
        if (isNotUsb) btnUsbImport.style.display = 'block';
    });
    btnUsbImport.onclick = async () => {
        const result = await window.electronAPI.importFromUsb();
        if (result.success) alert(`${result.count}개의 판서 파일을 불러왔습니다.`);
        else if (result.error) alert(`실패: ${result.error}`);
    };
}

// Mouse Tracking for Background Glow (Round 135)
document.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth) * 100;
    const y = (e.clientY / window.innerHeight) * 100;
    document.body.style.setProperty('--x', `${x}%`);
    document.body.style.setProperty('--y', `${y}%`);
});

// Download Status Handler (Round 137)
const dlBar = document.getElementById('download-bar');
const dlFill = document.getElementById('dl-progress-fill');
const dlPercent = document.getElementById('dl-percent');
const dlFilename = document.getElementById('dl-filename');
const dlIcon = document.getElementById('dl-icon');

window.electronAPI.onDownloadStatus((status) => {
    if (status.state === 'progressing') {
        dlBar.style.display = 'flex';
        dlFill.style.width = `${status.progress}%`;
        dlPercent.innerText = `${Math.round(status.progress)}%`;
        dlFilename.innerText = status.filename;
        dlIcon.innerText = status.type === 'usb' ? '📲' : (status.type === 'vid' ? '🎬' : (status.type === 'pdf' ? '📖' : '📥'));
    } else if (status.state === 'completed') {
        dlPercent.innerText = '100%';
        dlFill.style.width = '100%';
        dlFilename.innerText = '완료됨';
        setTimeout(() => { dlBar.style.display = 'none'; }, 5000);
    } else if (status.state === 'failed') {
        dlFilename.innerText = '실패함';
        dlIcon.innerText = '⚠️';
        setTimeout(() => { dlBar.style.display = 'none'; }, 10000);
    }
});

window.electronAPI.onStandaloneVidTrigger(() => {
    const btn = document.getElementById('btn-stand-vid');
    if (btn) btn.click();
});

document.getElementById('close-launcher').onclick = () => {
    window.electronAPI.closeLauncher();
};

// --- Standalone Viewers ---
document.getElementById('btn-stand-vid').onclick = async () => {
    const filters = [{ name: 'Videos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm3u8'] }];
    const path = await window.electronAPI.openFile(filters);
    if (path) window.electronAPI.openStandaloneVid(path);
};

document.getElementById('btn-stand-img').onclick = async () => {
    const filters = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }];
    const path = await window.electronAPI.openFile(filters);
    if (path) window.electronAPI.openStandaloneImg(path);
};

document.getElementById('btn-stand-pdf').onclick = async () => {
    const filters = [{ name: 'Documents', extensions: ['pdf'] }];
    const path = await window.electronAPI.openFile(filters);
    if (path) window.electronAPI.openStandalonePdf(path);
};

/* btn-stand-ytb removed */

document.getElementById('btn-stand-url').onclick = () => {
    window.electronAPI.openStandaloneUrl('https://google.com');
};

document.getElementById('btn-stand-board').onclick = () => {
    window.electronAPI.openWhiteboard();
};
loadApps();
