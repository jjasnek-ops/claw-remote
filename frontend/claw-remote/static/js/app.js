const refreshIntervalSeconds = Number(document.body.dataset.refreshInterval || '5');
let refreshInterval = refreshIntervalSeconds * 1000;
let refreshTimer = null;
let refreshInFlight = false;
let sidebarWidth = Number(localStorage.getItem('clawSidebarWidth') || 320);
let sidebarDragging = false;
let activeSession = null;
let activeWindow = null;
let activePane = null;
// Every pane fetch gets a monotonically increasing request id. Session/window/pane
// switches invalidate older in-flight requests so a late response from the previous
// target can never overwrite the terminal after the user has switched.
let paneRequestSequence = 0;
let latestPaneRequestId = 0;
let sessionsData = [];
let lastSessionsHash = '';  // track whether session list actually changed
let expandedSessionDetails = new Set();
let terminalRawContent = '';
let forceTerminalScrollToBottom = false;
let touchStartY = 0;
let isPulling = false;
let customPrompts = [];
let serverHistoryItems = [];
let editingPromptId = null;
let draftSaveTimer = null;
let terminalCaptureExpandInFlight = false;
let pendingImages = [];
let imageUploadInFlight = false;
let sessionPromptImages = [];
let sessionPromptImageUploadInFlight = false;
let sessionPromptOpen = false;
let sessionPromptSession = null;
let sessionPromptSaveTimer = null;
let sessionPromptLastSavedText = '';
let sessionPromptLastSavedImagesKey = '';
let sessionPromptLoadStartedAt = 0;
let sessionPromptEditedAt = 0;
let sessionPromptDirty = false;
let terminalCollapsed = true;
let promptTemplateOpen = false;
let promptPlanTemplateOpen = false;
let sessionPromptDraftBeforeTemplateEdit = '';
let sessionPromptPlanTemplate = localStorage.getItem('clawSessionPromptPlanTemplate:v1') || '';
let promptWidth = Number(localStorage.getItem('clawPromptWidth') || 720);
let terminalWidth = Number(localStorage.getItem('clawTerminalWidth') || 520);
let promptTerminalDragging = false;

const DRAFTS_STORAGE_KEY = 'clawComposerDrafts:v1';
const HISTORY_STORAGE_KEY = 'clawComposerHistory:v1';
const READ_STATUS_STORAGE_KEY = 'clawSessionReadStatus:v1';
const TERMINAL_CAPTURE_LINES_STORAGE_KEY = 'clawTerminalCaptureLines:v1';
const ACTIVE_TARGET_STORAGE_KEY = 'clawActiveTarget:v1';
const DEFAULT_TERMINAL_CAPTURE_LINES = 200;
const MAX_TERMINAL_CAPTURE_LINES = 1600;
const SWIPE_MAX_TERMINAL_CAPTURE_LINES = 200;
const TERMINAL_CAPTURE_LINE_OPTIONS = [200, 400, 800, 1600];
const MAX_HISTORY_ITEMS = 20;
const MAX_PENDING_IMAGES = 10;
const KIND_LABELS = { glm: 'GLM', claude: 'Claude', codex: 'Codex' };
const LONG_PROMPT_FILE_THRESHOLD = 7000;
const SESSION_PROMPT_STORAGE_KEY = 'clawSessionPrompts:v1';
const PINNED_SESSIONS_KEY = 'clawPinnedSessions:v1';
const SESSION_PROMPT_PLAN_TEMPLATE_STORAGE_KEY = 'clawSessionPromptPlanTemplate:v1';
const DEFAULT_SESSION_PROMPT_PLAN_TEMPLATE = `1、修改文件：

功能描述：

验收效果：

2、

3、

4、

5、`;
const DEFAULT_PROMPT_OPTIMIZE_TEMPLATE = `请结合当前会话上下文，帮我优化下面这段后续 prompt 想法：
- 补全必要背景
- 拆成清晰步骤
- 指出可能遗漏的约束和风险
- 最后给出一版可以直接发送执行的 prompt

草稿：
{draft}`;

// Toast notification
function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast visible' + (isError ? ' error' : '');
    setTimeout(() => toast.classList.remove('visible'), 2000);
}

function getTargetSession() {
    return activeSession;
}

function getTargetWindow() {
    return activeWindow;
}

function getTargetPane() {
    return activePane;
}

function apiUrl(path) {
    return new URL(path, window.location.href).toString();
}

function loadStorageObject(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (e) {
        return {};
    }
}

function saveStorageObject(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function getPinnedSessions() {
    try { return JSON.parse(localStorage.getItem(PINNED_SESSIONS_KEY) || '[]'); } catch { return []; }
}
function togglePinSession(name) {
    const pins = getPinnedSessions();
    const idx = pins.indexOf(name);
    if (idx >= 0) pins.splice(idx, 1); else pins.unshift(name);
    localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(pins));
}

function getComposerTargetKey() {
    if (!activeSession) return null;
    return [getCurrentMode(), activeSession, activeWindow ?? '_', activePane ?? '_'].join('|');
}

function beginPaneRequest() {
    const requestId = ++paneRequestSequence;
    latestPaneRequestId = requestId;
    return { requestId, targetKey: getComposerTargetKey() };
}

function isCurrentPaneRequest(request) {
    return request.requestId === latestPaneRequestId
        && request.targetKey === getComposerTargetKey();
}

function showTerminalLoading() {
    terminalRawContent = '';
    const terminal = document.getElementById('terminalContent');
    if (terminal) {
        terminal.textContent = 'Loading session…';
        terminal.scrollTop = 0;
    }
}

function saveActiveTarget() {
    if (!activeSession) return;
    const mode = getCurrentMode();
    const targets = loadStorageObject(ACTIVE_TARGET_STORAGE_KEY);
    targets[mode] = {
        session: activeSession,
        window: activeWindow,
        pane: activePane
    };
    saveStorageObject(ACTIVE_TARGET_STORAGE_KEY, targets);
}

function loadActiveTarget() {
    const mode = getCurrentMode();
    const targets = loadStorageObject(ACTIVE_TARGET_STORAGE_KEY);
    const target = targets[mode];
    if (target && target.session) return target;
    if (targets.mode === mode && targets.session) return targets;
    return null;
}

function getComposerSessionKey(sessionName = activeSession) {
    if (!sessionName) return null;
    return [getCurrentMode(), sessionName].join('|');
}

function normalizeTerminalCaptureLines(lines) {
    const value = Number(lines);
    return TERMINAL_CAPTURE_LINE_OPTIONS.includes(value) ? value : DEFAULT_TERMINAL_CAPTURE_LINES;
}

function getTerminalCaptureLines() {
    const targetKey = getComposerTargetKey();
    if (!targetKey) return DEFAULT_TERMINAL_CAPTURE_LINES;
    const stored = loadStorageObject(TERMINAL_CAPTURE_LINES_STORAGE_KEY);
    return normalizeTerminalCaptureLines(stored[targetKey] || DEFAULT_TERMINAL_CAPTURE_LINES);
}

function setTerminalCaptureLines(lines) {
    const targetKey = getComposerTargetKey();
    if (!targetKey) return false;
    const stored = loadStorageObject(TERMINAL_CAPTURE_LINES_STORAGE_KEY);
    stored[targetKey] = normalizeTerminalCaptureLines(lines);
    saveStorageObject(TERMINAL_CAPTURE_LINES_STORAGE_KEY, stored);
    return true;
}

function syncTerminalCaptureLinesSelect() {
    const select = document.getElementById('terminalCaptureLinesSelect');
    if (!select) return;
    select.value = String(getTerminalCaptureLines());
}

function setupTerminalCaptureLinesSelect() {
    const select = document.getElementById('terminalCaptureLinesSelect');
    if (!select) return;
    select.addEventListener('pointerdown', (event) => event.stopPropagation());
    select.addEventListener('mousedown', (event) => event.stopPropagation());
    select.addEventListener('click', (event) => event.stopPropagation());
    select.addEventListener('change', async (event) => {
        event.stopPropagation();
        if (!setTerminalCaptureLines(select.value)) {
            syncTerminalCaptureLinesSelect();
            return;
        }
        syncTerminalCaptureLinesSelect();
        terminalRawContent = '';
        try {
            await refreshActivePane();
        } catch (e) {
            showToast('Failed to refresh terminal', true);
            console.error('Failed to refresh pane:', e);
        }
    });
    syncTerminalCaptureLinesSelect();
}

function expandTerminalCaptureLines() {
    const targetKey = getComposerTargetKey();
    if (!targetKey) return false;
    const current = getTerminalCaptureLines();
    if (current >= SWIPE_MAX_TERMINAL_CAPTURE_LINES) return false;
    const next = TERMINAL_CAPTURE_LINE_OPTIONS.find(lines => lines > current && lines <= SWIPE_MAX_TERMINAL_CAPTURE_LINES);
    if (!next || next === current) return false;
    const stored = loadStorageObject(TERMINAL_CAPTURE_LINES_STORAGE_KEY);
    stored[targetKey] = next;
    saveStorageObject(TERMINAL_CAPTURE_LINES_STORAGE_KEY, stored);
    syncTerminalCaptureLinesSelect();
    return true;
}

function getSessionReadKey(sessionName) {
    return getComposerSessionKey(sessionName);
}

function getStatusTimestamp(status) {
    return Number(status && status.updated_at_ts || 0);
}

function markSessionStatusRead(sessionName) {
    const key = getSessionReadKey(sessionName);
    const session = sessionsData.find(item => item.name === sessionName);
    const ts = getStatusTimestamp(session && session.hook_status);
    if (!key || !ts) return;
    const read = loadStorageObject(READ_STATUS_STORAGE_KEY);
    read[key] = Math.max(Number(read[key] || 0), ts);
    saveStorageObject(READ_STATUS_STORAGE_KEY, read);
}

function hasUnreadCompletedStatus(sessionName, status) {
    if (!status || status.state !== 'completed') return false;
    const ts = getStatusTimestamp(status);
    if (!ts) return false;
    const read = loadStorageObject(READ_STATUS_STORAGE_KEY);
    return Number(read[getSessionReadKey(sessionName)] || 0) < ts;
}

function getInputTextElement() {
    return document.getElementById('inputText');
}

function saveCurrentDraft() {
    const input = getInputTextElement();
    const targetKey = getComposerTargetKey();
    if (!input || !targetKey) return;
    const drafts = loadStorageObject(DRAFTS_STORAGE_KEY);
    const text = input.value;
    if (text) {
        drafts[targetKey] = { text, updatedAt: Date.now() };
    } else {
        delete drafts[targetKey];
    }
    saveStorageObject(DRAFTS_STORAGE_KEY, drafts);
}

function scheduleDraftSave() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveCurrentDraft, 250);
}

function clearCurrentDraft() {
    const targetKey = getComposerTargetKey();
    if (!targetKey) return;
    const drafts = loadStorageObject(DRAFTS_STORAGE_KEY);
    delete drafts[targetKey];
    saveStorageObject(DRAFTS_STORAGE_KEY, drafts);
}

function restoreDraftForActiveTarget() {
    const input = getInputTextElement();
    const targetKey = getComposerTargetKey();
    if (!input || !targetKey) return;
    const drafts = loadStorageObject(DRAFTS_STORAGE_KEY);
    input.value = drafts[targetKey] && drafts[targetKey].text ? drafts[targetKey].text : '';
}

function addInputHistory(text) {
    const sessionKey = getComposerSessionKey();
    const targetKey = getComposerTargetKey();
    if (!sessionKey || !text.trim()) return;
    const history = loadStorageObject(HISTORY_STORAGE_KEY);
    const current = Array.isArray(history[sessionKey]) ? history[sessionKey] : [];
    const next = current.filter(item => item && item.text !== text);
    next.unshift({ text, sentAt: Date.now(), targetKey });
    history[sessionKey] = next.slice(0, MAX_HISTORY_ITEMS);
    saveStorageObject(HISTORY_STORAGE_KEY, history);
}

function getCurrentLocalHistoryItems() {
    const sessionKey = getComposerSessionKey();
    if (!sessionKey) return [];
    const history = loadStorageObject(HISTORY_STORAGE_KEY);
    return Array.isArray(history[sessionKey]) ? history[sessionKey] : [];
}

function getHistoryKey(item) {
    const text = item && item.text ? item.text : '';
    const images = Array.isArray(item && item.images) ? item.images : [];
    const imageKey = images.map(image => image && (image.id || image.path || image.name)).filter(Boolean).join('|');
    return `${text}|${imageKey}`;
}

function getCurrentHistoryItems() {
    const combined = [...serverHistoryItems, ...getCurrentLocalHistoryItems()];
    const seen = new Set();
    const result = [];
    for (const item of combined) {
        if (!item || (!item.text && !(Array.isArray(item.images) && item.images.length))) continue;
        const key = getHistoryKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function getImagePreviewUrl(image) {
    if (!image) return '';
    if (image.previewUrl) return image.previewUrl;
    if (image.id) return apiUrl(`api/uploaded-image?id=${encodeURIComponent(image.id)}`);
    return '';
}

function getImagesForSend(images) {
    return (Array.isArray(images) ? images : []).filter(image => image.status === 'ready').map(image => ({
        id: image.id,
        path: image.path,
        name: image.name,
        mime: image.mime,
        size: image.size
    }));
}

function getPendingImagesForSend() {
    return getImagesForSend(pendingImages);
}

function getSessionPromptImagesForSend() {
    return getImagesForSend(sessionPromptImages);
}

function hasPendingImages() {
    return getPendingImagesForSend().length > 0;
}

function hasSessionPromptImages() {
    return getSessionPromptImagesForSend().length > 0;
}

function hasUploadingImages() {
    return imageUploadInFlight || pendingImages.some(image => image.status === 'uploading');
}

function hasUploadingSessionPromptImages() {
    return sessionPromptImageUploadInFlight || sessionPromptImages.some(image => image.status === 'uploading');
}

function renderImageAttachments(container, images, removeAttribute) {
    if (!container) return;
    if (!images.length) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }
    container.hidden = false;
    container.innerHTML = images.map(image => {
        const previewUrl = getImagePreviewUrl(image);
        const meta = [image.name || 'image', formatBytes(image.size), image.status === 'uploading' ? 'uploading' : '', image.status === 'error' ? image.error || 'failed' : '']
            .filter(Boolean).join(' · ');
        const img = previewUrl
            ? `<img src="${escapeAttr(previewUrl)}" alt="${escapeAttr(image.name || 'image')}">`
            : '<div class="image-attachment-placeholder">IMG</div>';
        return `
            <div class="image-attachment ${escapeAttr(image.status || 'ready')}" data-image-local-id="${escapeAttr(image.localId)}">
                <button class="image-attachment-remove" type="button" ${removeAttribute}="${escapeAttr(image.localId)}" aria-label="Remove image">×</button>
                ${img}
                <div class="image-attachment-meta" title="${escapeAttr(meta)}">${escapeHtml(meta)}</div>
            </div>
        `;
    }).join('');
}

function renderPendingImages() {
    renderImageAttachments(document.getElementById('imageAttachments'), pendingImages, 'data-remove-image');
}

function renderSessionPromptImages() {
    renderImageAttachments(document.getElementById('sessionPromptImageAttachments'), sessionPromptImages, 'data-remove-session-prompt-image');
}

function revokeImagePreview(image) {
    if (image && image.previewUrl && image.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(image.previewUrl);
    }
}

function clearPendingImages() {
    pendingImages.forEach(revokeImagePreview);
    pendingImages = [];
    renderPendingImages();
}

function clearSessionPromptImages() {
    sessionPromptImages.forEach(revokeImagePreview);
    sessionPromptImages = [];
    renderSessionPromptImages();
}

function removePendingImage(localId) {
    const removed = pendingImages.find(image => image.localId === localId);
    revokeImagePreview(removed);
    pendingImages = pendingImages.filter(image => image.localId !== localId);
    renderPendingImages();
}

function removeSessionPromptImage(localId) {
    const removed = sessionPromptImages.find(image => image.localId === localId);
    revokeImagePreview(removed);
    sessionPromptImages = sessionPromptImages.filter(image => image.localId !== localId);
    sessionPromptDirty = true;
    renderSessionPromptImages();
    scheduleSessionPromptSave();
}

function restoreImagesFromHistory(images) {
    clearPendingImages();
    const restored = Array.isArray(images) ? images.filter(Boolean).slice(0, MAX_PENDING_IMAGES) : [];
    pendingImages = restored.map((image, index) => ({
        localId: `history-${Date.now()}-${index}`,
        id: image.id || '',
        path: image.path || '',
        name: image.name || 'image',
        mime: image.mime || '',
        size: Number(image.size || 0),
        status: image.exists === false ? 'error' : 'ready',
        error: image.exists === false ? 'expired' : '',
        previewUrl: getImagePreviewUrl(image)
    }));
    renderPendingImages();
    if (pendingImages.some(image => image.status === 'error')) {
        showToast('Some history images expired; please upload again', true);
    }
}

function renderHistoryImageNames(images) {
    if (!Array.isArray(images) || !images.length) return '';
    const names = images.map(image => image && image.name).filter(Boolean);
    if (!names.length) return '';
    return `<span class="history-images">${escapeHtml(names.join(', '))}</span>`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
        reader.readAsDataURL(file);
    });
}

function readFileHeader(file, length = 16) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result || new ArrayBuffer(0)));
        reader.onerror = () => reject(reader.error || new Error('Failed to read image header'));
        reader.readAsArrayBuffer(file.slice(0, length));
    });
}

function detectImageMimeFromHeader(bytes) {
    if (!bytes || bytes.length < 4) return '';
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return 'image/png';
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes.length >= 6) {
        const gif = String.fromCharCode(...bytes.slice(0, 6));
        if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
    }
    if (bytes.length >= 12) {
        const riff = String.fromCharCode(...bytes.slice(0, 4));
        const webp = String.fromCharCode(...bytes.slice(8, 12));
        if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
    }
    return '';
}

function replaceDataUrlMime(dataUrl, mime) {
    if (!mime || !String(dataUrl || '').startsWith('data:')) return dataUrl;
    return String(dataUrl).replace(/^data:[^;,]+(;base64,)/, `data:${mime}$1`);
}

async function getUploadImagePayload(file) {
    const header = await readFileHeader(file);
    const detectedMime = detectImageMimeFromHeader(header);
    const dataUrl = await readFileAsDataUrl(file);
    return {
        name: file.name,
        type: detectedMime || file.type,
        data: replaceDataUrlMime(dataUrl, detectedMime || file.type)
    };
}

async function uploadImageFiles(files, placeholders, imageList = pendingImages) {
    const payloadImages = [];
    for (const file of files) {
        payloadImages.push(await getUploadImagePayload(file));
    }
    const response = await fetch(apiUrl('api/upload-images'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: payloadImages })
    });
    const result = await parseJsonResponse(response);
    if (!result.success) {
        const detail = result.failure_id ? `${result.error || 'Upload failed'} (${result.reason || 'upload_error'}, ${result.failure_id})` : (result.error || 'Upload failed');
        throw new Error(detail);
    }
    const uploaded = Array.isArray(result.images) ? result.images : [];
    placeholders.forEach((placeholder, index) => {
        const image = imageList.find(item => item.localId === placeholder.localId);
        const uploadedImage = uploaded[index];
        if (!image || !uploadedImage) return;
        image.id = uploadedImage.id;
        image.path = uploadedImage.path;
        image.name = uploadedImage.name || image.name;
        image.mime = uploadedImage.mime || image.mime;
        image.size = uploadedImage.size || image.size;
        image.status = 'ready';
        image.error = '';
    });
}

async function attachImagesToList(fileList, options) {
    const files = Array.from(fileList || []).filter(file => file && file.type && file.type.startsWith('image/'));
    if (!files.length) return;
    const imageList = options.imageList();
    const availableSlots = MAX_PENDING_IMAGES - imageList.length;
    if (availableSlots <= 0) {
        showToast(`最多支持 ${MAX_PENDING_IMAGES} 张图片`, true);
        return;
    }
    const selected = files.slice(0, availableSlots);
    if (files.length > availableSlots) {
        showToast(`最多支持 ${MAX_PENDING_IMAGES} 张图片，已忽略多余图片`, true);
    }
    const placeholders = selected.map((file, index) => ({
        localId: `${options.localPrefix}-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
        name: file.name || 'image',
        mime: file.type,
        size: file.size,
        status: 'uploading',
        previewUrl: URL.createObjectURL(file)
    }));
    imageList.push(...placeholders);
    options.render();
    options.setUploading(true);
    try {
        await uploadImageFiles(selected, placeholders, imageList);
        if (options.afterUpload) options.afterUpload();
        showToast(selected.length === 1 ? 'Image added' : `${selected.length} images added`);
    } catch (e) {
        placeholders.forEach(placeholder => {
            const image = imageList.find(item => item.localId === placeholder.localId);
            if (image) {
                image.status = 'error';
                image.error = e.message;
            }
        });
        showToast('Image upload failed: ' + e.message, true);
    } finally {
        options.setUploading(false);
        options.render();
    }
}

async function attachImageFiles(fileList) {
    await attachImagesToList(fileList, {
        imageList: () => pendingImages,
        localPrefix: 'upload',
        render: renderPendingImages,
        setUploading: value => { imageUploadInFlight = value; }
    });
}

async function attachSessionPromptImageFiles(fileList) {
    await attachImagesToList(fileList, {
        imageList: () => sessionPromptImages,
        localPrefix: 'session-prompt-upload',
        render: renderSessionPromptImages,
        setUploading: value => { sessionPromptImageUploadInFlight = value; },
        afterUpload: () => {
            sessionPromptDirty = true;
            scheduleSessionPromptSave();
        }
    });
}

function getImageFilesFromClipboard(event) {
    return Array.from(event.clipboardData && event.clipboardData.files || []).filter(file => file.type.startsWith('image/'));
}

function getImageFilesFromDrop(event) {
    return Array.from(event.dataTransfer && event.dataTransfer.files || []).filter(file => file.type.startsWith('image/'));
}

function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer && event.dataTransfer.items || []).some(item => item.kind === 'file');
}

function setupImageAttachmentHandlers() {
    const input = document.getElementById('inputText');
    const panel = document.getElementById('inputPanel');
    const fileInput = document.getElementById('imageFileInput');
    const attachBtn = document.getElementById('imageAttachBtn');
    const attachments = document.getElementById('imageAttachments');
    if (attachBtn && fileInput) attachBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            attachImageFiles(fileInput.files);
            fileInput.value = '';
        });
    }
    if (attachments) {
        attachments.addEventListener('click', (event) => {
            const button = event.target.closest('[data-remove-image]');
            if (button) removePendingImage(button.dataset.removeImage);
        });
    }
    if (input) {
        input.addEventListener('paste', (event) => {
            const files = getImageFilesFromClipboard(event);
            if (!files.length) return;
            event.preventDefault();
            attachImageFiles(files);
        });
    }
    if (panel) {
        panel.addEventListener('dragover', (event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            panel.classList.add('drag-over');
        });
        panel.addEventListener('dragleave', (event) => {
            if (!panel.contains(event.relatedTarget)) panel.classList.remove('drag-over');
        });
        panel.addEventListener('drop', (event) => {
            const files = getImageFilesFromDrop(event);
            if (!files.length) return;
            event.preventDefault();
            panel.classList.remove('drag-over');
            attachImageFiles(files);
        });
    }
}

function setupSessionPromptImageHandlers() {
    const panel = document.getElementById('sessionPromptPanel');
    const textarea = getSessionPromptTextElement();
    const fileInput = document.getElementById('sessionPromptImageFileInput');
    const attachBtn = document.getElementById('sessionPromptImageAttachBtn');
    const attachments = document.getElementById('sessionPromptImageAttachments');
    if (attachBtn && fileInput) attachBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) {
        fileInput.addEventListener('change', () => {
            attachSessionPromptImageFiles(fileInput.files);
            fileInput.value = '';
        });
    }
    if (attachments) {
        attachments.addEventListener('click', (event) => {
            const button = event.target.closest('[data-remove-session-prompt-image]');
            if (button) removeSessionPromptImage(button.dataset.removeSessionPromptImage);
        });
    }
    if (textarea) {
        textarea.addEventListener('paste', (event) => {
            const files = getImageFilesFromClipboard(event);
            if (!files.length) return;
            event.preventDefault();
            attachSessionPromptImageFiles(files);
        });
    }
    if (panel) {
        panel.addEventListener('dragover', (event) => {
            if (!hasDraggedFiles(event)) return;
            event.preventDefault();
            panel.classList.add('drag-over');
        });
        panel.addEventListener('dragleave', (event) => {
            if (!panel.contains(event.relatedTarget)) panel.classList.remove('drag-over');
        });
        panel.addEventListener('drop', (event) => {
            const files = getImageFilesFromDrop(event);
            if (!files.length) return;
            event.preventDefault();
            panel.classList.remove('drag-over');
            attachSessionPromptImageFiles(files);
        });
    }
}

async function loadSentPromptHistory() {
    if (!activeSession) {
        serverHistoryItems = [];
        renderInputHistory();
        return;
    }
    try {
        const data = await fetchJson(`api/sent-prompts?session=${encodeURIComponent(activeSession)}&limit=20`, 1);
        serverHistoryItems = Array.isArray(data.prompts) ? data.prompts : [];
    } catch (e) {
        console.error('Failed to load sent prompt history:', e);
        serverHistoryItems = [];
    }
    renderInputHistory();
}

function closeComposerPopovers() {
    for (const id of ['historyPopover', 'promptsPopover']) {
        const popover = document.getElementById(id);
        const button = document.getElementById(id === 'historyPopover' ? 'historyPopoverBtn' : 'promptsPopoverBtn');
        if (popover) popover.hidden = true;
        if (button) button.setAttribute('aria-expanded', 'false');
    }
}

function toggleComposerPopover(popoverId) {
    const popover = document.getElementById(popoverId);
    const button = document.getElementById(popoverId === 'historyPopover' ? 'historyPopoverBtn' : 'promptsPopoverBtn');
    if (!popover) return;
    const shouldOpen = popover.hidden;
    closeComposerPopovers();
    popover.hidden = !shouldOpen;
    if (button) button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function fillComposerText(text, shouldConfirm = true) {
    const input = getInputTextElement();
    if (!input) return false;
    if (shouldConfirm && input.value.trim() && input.value !== text && !confirm('Replace current draft?')) {
        return false;
    }
    input.value = text;
    input.focus();
    saveCurrentDraft();
    return true;
}

function insertTextAtCursor(input, text) {
    if (!input) return false;
    const value = input.value;
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : value.length;
    input.value = value.slice(0, start) + text + value.slice(end);
    const nextCursor = start + text.length;
    input.focus();
    input.setSelectionRange(nextCursor, nextCursor);
    return true;
}

function insertComposerTextAtCursor(text) {
    const input = getInputTextElement();
    if (!insertTextAtCursor(input, text)) return;
    saveCurrentDraft();
}

function previewText(text, maxLength = 120) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > maxLength ? value.slice(0, maxLength - 1) + '…' : value;
}

function renderInputHistory() {
    const container = document.getElementById('inputHistory');
    if (!container) return;
    const items = getCurrentHistoryItems().slice(0, 5);
    if (!items.length) {
        container.innerHTML = '<span class="composer-empty">No history yet</span>';
        return;
    }
    container.innerHTML = items.map((item, index) => {
        const images = Array.isArray(item.images) ? item.images : [];
        const isFilePrompt = item.prompt_file || item.text_truncated;
        const label = item.text ? previewText(item.text || '') : `${images.length} image${images.length > 1 ? 's' : ''}`;
        const fileTitle = item.prompt_file && item.prompt_file.path ? `File: ${item.prompt_file.path}` : '';
        const title = [item.text || '', fileTitle, images.map(image => image && image.name).filter(Boolean).join(', ')].filter(Boolean).join('\n');
        return `
            <button class="history-chip" type="button" data-history-index="${index}" title="${escapeAttr(title)}">
                <span class="history-text">${escapeHtml(label)}</span>
                ${isFilePrompt ? '<span class="history-images">file</span>' : ''}
                ${renderHistoryImageNames(images)}
            </button>
        `;
    }).join('');
}

function getHookStatusBadge(status, sessionName) {
    const rawState = status && status.state ? String(status.state) : 'idle';
    const state = rawState === 'completed' && !hasUnreadCompletedStatus(sessionName, status) ? 'idle' : rawState;
    const labels = {
        idle: 'No status',
        running: 'Running',
        completed: 'Ready',
        waiting_input: 'Waiting for input',
        uncertain: 'Needs check',
        ended: 'Ended'
    };
    return `<span class="session-hook-dot ${escapeAttr(state)}" title="${escapeAttr(labels[state] || labels.idle)}" aria-label="${escapeAttr(labels[state] || labels.idle)}"></span>`;
}

function renderCustomPromptList(container, options = {}) {
    if (!container) return;
    if (!customPrompts.length) {
        container.innerHTML = '<span class="composer-empty">No custom prompts</span>';
        return;
    }
    const includeEdit = options.includeEdit !== false;
    container.innerHTML = customPrompts.map(prompt => `
        <div class="custom-prompt-chip" data-prompt-id="${escapeAttr(prompt.id)}">
            <button class="custom-prompt-fill" type="button" data-action="fill" title="${escapeAttr(prompt.text)}">${escapeHtml(prompt.title)}</button>
            ${includeEdit ? `<button class="custom-prompt-icon" type="button" data-action="edit" aria-label="Edit ${escapeAttr(prompt.title)}">Edit</button>` : ''}
        </div>
    `).join('');
}

function renderCustomPrompts() {
    renderCustomPromptList(document.getElementById('customPromptList'));
    renderCustomPromptList(document.getElementById('sessionPromptCustomPromptList'), { includeEdit: false });
}

function findCustomPrompt(promptId) {
    return customPrompts.find(prompt => prompt.id === promptId);
}

async function loadCustomPrompts() {
    try {
        const data = await fetchJson('api/prompts', 1);
        customPrompts = Array.isArray(data.prompts) ? data.prompts : [];
        renderCustomPrompts();
    } catch (e) {
        console.error('Failed to load custom prompts:', e);
        renderCustomPrompts();
    }
}

function showCustomPromptEditor(prompt = null) {
    editingPromptId = prompt ? prompt.id : null;
    const editor = document.getElementById('customPromptEditor');
    const title = document.getElementById('customPromptTitle');
    const text = document.getElementById('customPromptText');
    const deleteBtn = document.getElementById('customPromptDeleteBtn');
    if (!editor || !title || !text) return;
    title.value = prompt ? prompt.title : '';
    text.value = prompt ? prompt.text : '';
    if (deleteBtn) deleteBtn.hidden = !prompt;
    editor.hidden = false;
    title.focus();
}

function hideCustomPromptEditor() {
    editingPromptId = null;
    const editor = document.getElementById('customPromptEditor');
    const deleteBtn = document.getElementById('customPromptDeleteBtn');
    if (editor) editor.hidden = true;
    if (deleteBtn) deleteBtn.hidden = true;
}

async function saveCustomPromptFromEditor() {
    const title = document.getElementById('customPromptTitle');
    const text = document.getElementById('customPromptText');
    if (!title || !text) return;
    try {
        const response = await fetch(apiUrl('api/prompt/save'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: editingPromptId, title: title.value, text: text.value })
        });
        const result = await parseJsonResponse(response);
        if (!result.success) {
            showToast('Prompt save failed: ' + (result.error || 'Unknown error'), true);
            return;
        }
        hideCustomPromptEditor();
        await loadCustomPrompts();
        showToast('Prompt saved');
    } catch (e) {
        showToast('Prompt save error: ' + e.message, true);
    }
}

async function deleteCustomPrompt(promptId) {
    const prompt = findCustomPrompt(promptId);
    if (!prompt || !confirm(`Delete prompt ${prompt.title}?`)) return;
    try {
        const response = await fetch(apiUrl('api/prompt/delete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: promptId })
        });
        const result = await parseJsonResponse(response);
        if (!result.success) {
            showToast('Prompt delete failed: ' + (result.error || 'Unknown error'), true);
            return;
        }
        await loadCustomPrompts();
        showToast('Prompt deleted');
    } catch (e) {
        showToast('Prompt delete error: ' + e.message, true);
    }
}

function setupCustomPromptEvents() {
    const addBtn = document.getElementById('customPromptAddBtn');
    const saveBtn = document.getElementById('customPromptSaveBtn');
    const deleteBtn = document.getElementById('customPromptDeleteBtn');
    const cancelBtn = document.getElementById('customPromptCancelBtn');
    const list = document.getElementById('customPromptList');
    if (addBtn) addBtn.addEventListener('click', () => showCustomPromptEditor());
    if (saveBtn) saveBtn.addEventListener('click', saveCustomPromptFromEditor);
    if (deleteBtn) deleteBtn.addEventListener('click', () => editingPromptId && deleteCustomPrompt(editingPromptId));
    if (cancelBtn) cancelBtn.addEventListener('click', hideCustomPromptEditor);
    if (list) {
        list.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-prompt-id]');
            const action = e.target.closest('[data-action]');
            if (!chip || !action) return;
            const prompt = findCustomPrompt(chip.dataset.promptId);
            if (!prompt) return;
            if (action.dataset.action === 'fill') {
                insertComposerTextAtCursor(prompt.text);
                closeComposerPopovers();
            }
            if (action.dataset.action === 'edit') showCustomPromptEditor(prompt);
        });
    }
}

async function parseJsonResponse(response) {
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.trim()) {
        throw new Error('Empty response');
    }
    return JSON.parse(text);
}

async function fetchJson(path, retries = 1) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch(apiUrl(path), {
                cache: 'no-store',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal
            });
            return await parseJsonResponse(response);
        } catch (e) {
            lastError = e;
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }
    throw lastError;
}

async function postJson(path, payload) {
    const response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
    });
    return parseJsonResponse(response);
}

function getSessionPromptKey(sessionName = sessionPromptSession || activeSession) {
    return getComposerSessionKey(sessionName);
}

function getSessionPromptTextElement() {
    return document.getElementById('sessionPromptText');
}

function getPromptOptimizeTemplateElement() {
    return document.getElementById('promptOptimizeTemplate');
}

function shouldPauseAutoRefresh() {
    if (!sessionPromptOpen) return false;
    const activeElement = document.activeElement;
    return promptPlanTemplateOpen || activeElement === getSessionPromptTextElement() || activeElement === getPromptOptimizeTemplateElement();
}

function getSelectedSessionPromptTextOrAll() {
    const textarea = getSessionPromptTextElement();
    if (!textarea) return '';
    const value = textarea.value || '';
    const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : 0;
    const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : 0;
    const selected = end > start ? value.slice(start, end).trim() : '';
    return selected || value.trim();
}

function closeSessionPromptPromptsPopover() {
    const popover = document.getElementById('sessionPromptPromptsPopover');
    const button = document.getElementById('sessionPromptPromptsBtn');
    if (popover) popover.hidden = true;
    if (button) button.setAttribute('aria-expanded', 'false');
}

function toggleSessionPromptPromptsPopover() {
    const popover = document.getElementById('sessionPromptPromptsPopover');
    const button = document.getElementById('sessionPromptPromptsBtn');
    if (!popover) return;
    const shouldOpen = popover.hidden;
    popover.hidden = !shouldOpen;
    if (button) button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
}

function insertSessionPromptTextAtCursor(text) {
    const textarea = getSessionPromptTextElement();
    if (!insertTextAtCursor(textarea, text)) return;
    sessionPromptEditedAt = Date.now();
    scheduleSessionPromptSave();
}

function normalizeSessionPromptImagesForLocal(images) {
    return (Array.isArray(images) ? images : []).filter(Boolean).slice(0, MAX_PENDING_IMAGES).map((image, index) => ({
        localId: image.localId || `session-prompt-saved-${Date.now()}-${index}`,
        id: image.id || '',
        path: image.path || '',
        name: image.name || 'image',
        mime: image.mime || image.type || '',
        size: Number(image.size || 0),
        status: image.exists === false ? 'error' : (image.status || 'ready'),
        error: image.exists === false ? 'expired' : (image.error || ''),
        previewUrl: image.previewUrl || getImagePreviewUrl(image)
    }));
}

function getSessionPromptReadyImagesForSave() {
    return getSessionPromptImagesForSend();
}

function getSessionPromptImagesKey(images = sessionPromptImages) {
    return getImagesForSend(images).map(image => image.id || image.path || image.name).join('|');
}

function setSessionPromptStatus(text, isError = false) {
    const status = document.getElementById('sessionPromptSaveStatus');
    if (!status) return;
    const message = String(text || '');
    status.textContent = isError ? message : '';
    status.hidden = !isError || !message;
    status.classList.toggle('error', isError);
}

function clampPromptWidth(width) {
    return Math.max(420, Math.min(1200, Number(width) || 720));
}

function clampTerminalWidth(width) {
    return Math.max(360, Math.min(900, Number(width) || 520));
}

function applyPromptTerminalWidths() {
    promptWidth = clampPromptWidth(promptWidth);
    terminalWidth = clampTerminalWidth(terminalWidth);
    document.documentElement.style.setProperty('--prompt-width', `${promptWidth}px`);
    document.documentElement.style.setProperty('--terminal-width', `${terminalWidth}px`);
}

function setTerminalCollapsed(isCollapsed) {
    terminalCollapsed = Boolean(isCollapsed);
    document.body.classList.toggle('terminal-collapsed', terminalCollapsed);
    const button = document.getElementById('terminalDockToggleBtn');
    if (button) {
        button.setAttribute('aria-expanded', terminalCollapsed ? 'false' : 'true');
        button.setAttribute('aria-label', terminalCollapsed ? '展开实时终端' : '收起实时终端');
    }
}

function setPromptTemplateOpen(isOpen) {
    promptTemplateOpen = Boolean(isOpen);
    document.body.classList.toggle('prompt-template-open', promptTemplateOpen);
    document.body.classList.toggle('prompt-template-collapsed', !promptTemplateOpen);
    const button = document.getElementById('promptOptimizeTemplateToggleBtn');
    if (button) {
        button.textContent = promptTemplateOpen ? '收起优化指令' : '优化指令';
        button.setAttribute('aria-expanded', promptTemplateOpen ? 'true' : 'false');
    }
}

function togglePromptOptimizeTemplate() {
    setPromptTemplateOpen(!promptTemplateOpen);
}

function getSessionPromptPlanTemplate() {
    return sessionPromptPlanTemplate || localStorage.getItem(SESSION_PROMPT_PLAN_TEMPLATE_STORAGE_KEY) || DEFAULT_SESSION_PROMPT_PLAN_TEMPLATE;
}

async function loadSessionPromptPlanTemplate() {
    const localTemplate = localStorage.getItem(SESSION_PROMPT_PLAN_TEMPLATE_STORAGE_KEY) || '';
    try {
        const result = await fetchJson('api/session-prompt-plan-template', 0);
        if (result.success && result.template) {
            if (!result.updated_at && localTemplate && localTemplate !== result.template) {
                sessionPromptPlanTemplate = localTemplate;
                await postJson('api/session-prompt-plan-template/save', { template: localTemplate });
                return;
            }
            sessionPromptPlanTemplate = result.template;
            localStorage.setItem(SESSION_PROMPT_PLAN_TEMPLATE_STORAGE_KEY, result.template);
        }
    } catch (e) {
        sessionPromptPlanTemplate = localTemplate || DEFAULT_SESSION_PROMPT_PLAN_TEMPLATE;
    }
}

function setPromptPlanTemplateOpen(isOpen) {
    const textarea = getSessionPromptTextElement();
    promptPlanTemplateOpen = Boolean(isOpen);
    document.body.classList.toggle('prompt-plan-template-open', promptPlanTemplateOpen);
    const button = document.getElementById('sessionPromptPlanTemplateToggleBtn');
    const label = document.getElementById('sessionPromptTextLabel');
    if (promptPlanTemplateOpen && textarea) {
        clearTimeout(sessionPromptSaveTimer);
        sessionPromptDraftBeforeTemplateEdit = textarea.value;
        textarea.value = getSessionPromptPlanTemplate();
        setSessionPromptStatus('正在编辑计划模板');
    } else if (textarea) {
        textarea.value = sessionPromptDraftBeforeTemplateEdit;
        setSessionPromptStatus(sessionPromptLastSavedText ? '已保存' : '模板已就绪');
    }
    if (button) {
        button.textContent = promptPlanTemplateOpen ? '保存计划模板' : '编辑计划模板';
        button.setAttribute('aria-expanded', promptPlanTemplateOpen ? 'true' : 'false');
    }
    if (label) label.textContent = promptPlanTemplateOpen ? '计划模板' : '后续提示词想法';
}

async function toggleSessionPromptPlanTemplate() {
    if (promptPlanTemplateOpen) {
        await saveSessionPromptPlanTemplate();
        setPromptPlanTemplateOpen(false);
        return;
    }
    await loadSessionPromptPlanTemplate();
    setPromptPlanTemplateOpen(true);
}

async function saveSessionPromptPlanTemplate() {
    const textarea = getSessionPromptTextElement();
    if (!textarea) return false;
    const template = textarea.value;
    localStorage.setItem(SESSION_PROMPT_PLAN_TEMPLATE_STORAGE_KEY, template);
    try {
        const result = await postJson('api/session-prompt-plan-template/save', { template });
        if (!result.success) {
            showToast('计划模板保存失败：' + (result.error || '未知错误'), true);
            return false;
        }
        sessionPromptPlanTemplate = result.template || template;
        localStorage.setItem(SESSION_PROMPT_PLAN_TEMPLATE_STORAGE_KEY, sessionPromptPlanTemplate);
        showToast('计划模板已保存');
        return true;
    } catch (e) {
        showToast('计划模板已暂存本地：' + e.message, true);
        return false;
    }
}

function toggleTerminalDock(event) {
    if (event) event.stopPropagation();
    setTerminalCollapsed(!terminalCollapsed);
    if (!terminalCollapsed) refreshActivePane().catch(e => console.error('Failed to refresh pane:', e));
}

function setSessionPromptPanelOpen(isOpen) {
    sessionPromptOpen = isOpen;
    document.body.classList.toggle('session-prompt-open', isOpen);
    if (isOpen) {
        setTerminalCollapsed(true);
        setPromptTemplateOpen(false);
        setPromptPlanTemplateOpen(false);
        applyPromptTerminalWidths();
    } else {
        setTerminalCollapsed(false);
    }
    const panel = document.getElementById('sessionPromptPanel');
    if (!panel) return;
    panel.classList.toggle('open', isOpen);
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
}

function updateSessionPromptSessionName() {
    const label = document.getElementById('sessionPromptSessionName');
    if (label) label.textContent = getSessionDisplayName(sessionPromptSession) || sessionPromptSession || '-';
}

function saveSessionPromptLocal(sessionName, text, images = sessionPromptImages) {
    const key = getSessionPromptKey(sessionName);
    if (!key) return;
    const prompts = loadStorageObject(SESSION_PROMPT_STORAGE_KEY);
    prompts[key] = { text, images: getImagesForSend(images), updatedAt: Date.now() };
    saveStorageObject(SESSION_PROMPT_STORAGE_KEY, prompts);
}

function loadSessionPromptLocal(sessionName) {
    const key = getSessionPromptKey(sessionName);
    if (!key) return { text: '', images: [] };
    const prompts = loadStorageObject(SESSION_PROMPT_STORAGE_KEY);
    const note = prompts[key] || {};
    if (typeof note === 'string') return { text: note, images: [] };
    return {
        text: note && note.text ? note.text : '',
        images: normalizeSessionPromptImagesForLocal(note && note.images)
    };
}

async function loadSessionPromptNote(sessionName = sessionPromptSession) {
    const textarea = getSessionPromptTextElement();
    if (!textarea || !sessionName) return;
    await loadSessionPromptPlanTemplate();
    const loadStartedAt = Date.now();
    sessionPromptLoadStartedAt = loadStartedAt;
    const localNote = loadSessionPromptLocal(sessionName);
    const localText = localNote.text || '';
    textarea.value = localText;
    clearSessionPromptImages();
    sessionPromptImages = normalizeSessionPromptImagesForLocal(localNote.images);
    renderSessionPromptImages();
    sessionPromptLastSavedText = localText;
    sessionPromptLastSavedImagesKey = getSessionPromptImagesKey();
    setSessionPromptStatus(localText || sessionPromptImages.length ? '本地草稿' : '加载中...');

    const params = new URLSearchParams({ mode: getCurrentMode(), session: sessionName });
    try {
        const result = await fetchJson(`api/session-prompt?${params.toString()}`, 0);
        if (sessionPromptSession !== sessionName) return;
        if (!result.success) {
            setSessionPromptStatus(result.error || '加载失败', true);
            return;
        }
        const serverText = result.note && result.note.text ? result.note.text : '';
        const serverImages = normalizeSessionPromptImagesForLocal(result.note && result.note.images);
        const text = serverText || localText || getSessionPromptPlanTemplate();
        if (sessionPromptEditedAt > loadStartedAt) {
            setSessionPromptStatus('编辑中...');
            return;
        }
        textarea.value = text;
        clearSessionPromptImages();
        sessionPromptImages = serverImages.length ? serverImages : normalizeSessionPromptImagesForLocal(localNote.images);
        renderSessionPromptImages();
        sessionPromptLastSavedText = serverText || localText;
        sessionPromptLastSavedImagesKey = getSessionPromptImagesKey();
        sessionPromptDirty = false;
        saveSessionPromptLocal(sessionName, text, sessionPromptImages);
        setSessionPromptStatus(serverText || serverImages.length ? '已保存' : localText || sessionPromptImages.length ? '本地草稿' : '模板已就绪');
    } catch (e) {
        if (sessionPromptSession === sessionName) setSessionPromptStatus('离线，使用本地草稿', true);
    }
}

async function saveSessionPromptNote(options = {}) {
    if (promptPlanTemplateOpen) return true;
    const sessionName = sessionPromptSession;
    const textarea = getSessionPromptTextElement();
    if (!sessionName || !textarea) return false;
    clearTimeout(sessionPromptSaveTimer);
    const text = textarea.value;
    const imagesForSave = getSessionPromptReadyImagesForSave();
    const imagesKey = getSessionPromptImagesKey();
    if (!sessionPromptDirty && text !== sessionPromptLastSavedText) {
        saveSessionPromptLocal(sessionName, text, sessionPromptImages);
        return true;
    }
    saveSessionPromptLocal(sessionName, text, sessionPromptImages);
    if (!options.force && text === sessionPromptLastSavedText && imagesKey === sessionPromptLastSavedImagesKey && !sessionPromptDirty) return true;
    setSessionPromptStatus('保存中...');
    try {
        const result = await postJson('api/session-prompt/save', {
            mode: getCurrentMode(),
            session: sessionName,
            text,
            images: imagesForSave
        });
        if (!result.success) {
            setSessionPromptStatus(result.error || '保存失败', true);
            return false;
        }
        if (sessionPromptSession === sessionName) {
            sessionPromptLastSavedText = text;
            sessionPromptLastSavedImagesKey = imagesKey;
            sessionPromptDirty = false;
            setSessionPromptStatus('已保存');
        }
        return true;
    } catch (e) {
        setSessionPromptStatus('保存失败，已保留在本地', true);
        return false;
    }
}

function scheduleSessionPromptSave() {
    clearTimeout(sessionPromptSaveTimer);
    if (promptPlanTemplateOpen) {
        setSessionPromptStatus('正在编辑计划模板');
        return;
    }
    sessionPromptEditedAt = Date.now();
    sessionPromptDirty = true;
    setSessionPromptStatus('编辑中...');
    sessionPromptSaveTimer = setTimeout(() => saveSessionPromptNote(), 800);
}

function setPromptOptimizeTemplateFromScope(data) {
    const template = getPromptOptimizeTemplateElement();
    const scope = document.getElementById('promptOptimizeTemplateScope');
    if (!template || !scope) return;
    template.dataset.globalTemplate = data.global_template || DEFAULT_PROMPT_OPTIMIZE_TEMPLATE;
    template.dataset.sessionTemplate = data.session_template || '';
    template.value = scope.value === 'global'
        ? template.dataset.globalTemplate
        : (template.dataset.sessionTemplate || template.dataset.globalTemplate);
}

async function loadPromptOptimizeTemplate(sessionName = sessionPromptSession) {
    const template = getPromptOptimizeTemplateElement();
    if (!template || !sessionName) return;
    setPromptOptimizeTemplateFromScope({ global_template: DEFAULT_PROMPT_OPTIMIZE_TEMPLATE, session_template: '' });
    const params = new URLSearchParams({ mode: getCurrentMode(), session: sessionName });
    try {
        const result = await fetchJson(`api/prompt-optimize-template?${params.toString()}`, 0);
        if (sessionPromptSession !== sessionName) return;
        if (result.success) setPromptOptimizeTemplateFromScope(result);
    } catch (e) {
        console.error('Failed to load prompt optimize template:', e);
    }
}

async function savePromptOptimizeTemplate() {
    const template = getPromptOptimizeTemplateElement();
    const scope = document.getElementById('promptOptimizeTemplateScope');
    if (!template || !scope || !sessionPromptSession) return;
    try {
        const result = await postJson('api/prompt-optimize-template/save', {
            mode: getCurrentMode(),
            session: sessionPromptSession,
            scope: scope.value,
            template: template.value
        });
        if (!result.success) {
            showToast('Template save failed: ' + (result.error || 'Unknown error'), true);
            return;
        }
        setPromptOptimizeTemplateFromScope(result);
        showToast('Template saved');
    } catch (e) {
        showToast('Template save error: ' + e.message, true);
    }
}

function buildPromptOptimizeMessage(draft, template) {
    const draftText = String(draft || '').trim();
    const templateText = String(template || DEFAULT_PROMPT_OPTIMIZE_TEMPLATE).trim() || DEFAULT_PROMPT_OPTIMIZE_TEMPLATE;
    if (templateText.includes('{draft}')) {
        return templateText.replaceAll('{draft}', draftText);
    }
    return `${templateText}\n\n${draftText}`;
}

async function openSessionPromptPanel(event, sessionName) {
    if (event) event.stopPropagation();
    if (!sessionName) return;
    if (sessionPromptOpen) await saveSessionPromptNote({ force: true });
    saveCurrentDraft();
    clearPendingImages();
    activeSession = sessionName;
    markSessionStatusRead(sessionName);
    const session = sessionsData.find(item => item.name === sessionName);
    const selectedWindow = session && session.windows && (session.windows.find(windowItem => windowItem.active) || session.windows[0]);
    const selectedPane = selectedWindow && selectedWindow.panes && (selectedWindow.panes.find(paneItem => paneItem.active) || selectedWindow.panes[0]);
    activeWindow = selectedWindow ? selectedWindow.index : null;
    activePane = selectedPane ? selectedPane.index : null;
    saveActiveTarget();
    updateTerminalBadge();
    syncTerminalCaptureLinesSelect();
    restoreDraftForActiveTarget();
    renderInputHistory();
    loadSentPromptHistory();
    sessionPromptSession = sessionName;
    updateSessionPromptSessionName();
    setSessionPromptPanelOpen(true);
    updateSessionListActiveState();
    scrollActiveSessionIntoView();
    await Promise.all([loadSessionPromptNote(sessionName), loadPromptOptimizeTemplate(sessionName)]);
    const textarea = getSessionPromptTextElement();
    if (textarea) textarea.focus();
}

async function closeSessionPromptPanel() {
    await saveSessionPromptNote({ force: true });
    setSessionPromptPanelOpen(false);
}

async function syncSessionPromptPanelToSession(sessionName) {
    if (!sessionPromptOpen || !sessionName || sessionPromptSession === sessionName) return;
    await saveSessionPromptNote({ force: true });
    sessionPromptSession = sessionName;
    updateSessionPromptSessionName();
    await Promise.all([loadSessionPromptNote(sessionName), loadPromptOptimizeTemplate(sessionName)]);
}

async function closeSessionPromptPanelForSelection() {
    if (!sessionPromptOpen) return;
    await saveSessionPromptNote({ force: true });
    closeSessionPromptPromptsPopover();
    setSessionPromptPanelOpen(false);
}

async function sendSessionPromptToPlanMode() {
    const text = getSelectedSessionPromptTextOrAll();
    const images = getSessionPromptImagesForSend();
    if (!sessionPromptSession) {
        showToast('未选择 session', true);
        return;
    }
    if (hasUploadingSessionPromptImages()) {
        showToast('图片仍在上传，请稍后发送', true);
        return;
    }
    if (!text && !images.length) {
        showToast('提示词计划为空', true);
        return;
    }
    await saveSessionPromptNote({ force: true });
    const button = document.getElementById('sessionPromptCopyBtn');
    if (button) button.disabled = true;
    try {
        const sameActiveSession = sessionPromptSession === activeSession;
        const target = {
            session: sessionPromptSession,
            window: sameActiveSession ? getTargetWindow() : null,
            pane: sameActiveSession ? getTargetPane() : null,
            enter: true,
            append_universal_prompt: false
        };
        const messages = [
            { text: '/compact' },
            { text: '/plan' },
            { text, images }
        ];
        for (const message of messages) {
            const result = await postJson('api/send', { ...target, ...message });
            if (!result.success) {
                showToast('发送到计划模式失败：' + (result.error || '未知错误'), true);
                return;
            }
        }
        showToast('已发送到计划模式');
        loadSentPromptHistory();
        setTimeout(() => refreshData({ force: true }), 500);
    } catch (e) {
        showToast('发送到计划模式错误：' + e.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

async function sendSelectedSessionPromptToSession() {
    const text = getSelectedSessionPromptTextOrAll();
    const images = getSessionPromptImagesForSend();
    if (!sessionPromptSession) {
        showToast('未选择 session', true);
        return;
    }
    if (hasUploadingSessionPromptImages()) {
        showToast('图片仍在上传，请稍后发送', true);
        return;
    }
    if (!text && !images.length) {
        showToast('提示词计划为空', true);
        return;
    }
    await saveSessionPromptNote({ force: true });
    const button = document.getElementById('sessionPromptQuickSendBtn');
    if (button) button.disabled = true;
    try {
        const sameActiveSession = sessionPromptSession === activeSession;
        const result = await postJson('api/send', {
            session: sessionPromptSession,
            window: sameActiveSession ? getTargetWindow() : null,
            pane: sameActiveSession ? getTargetPane() : null,
            text,
            images,
            enter: true,
            append_universal_prompt: false
        });
        if (!result.success) {
            showToast('发送 prompt 失败：' + (result.error || '未知错误'), true);
            return;
        }
        showToast('prompt 已发送');
        setSessionPromptPanelOpen(false);
        loadSentPromptHistory();
        setTimeout(() => refreshData({ force: true }), 500);
    } catch (e) {
        showToast('发送 prompt 错误：' + e.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

async function sendPromptOptimizeToSession() {
    const textarea = getSessionPromptTextElement();
    const template = getPromptOptimizeTemplateElement();
    const text = textarea ? textarea.value.trim() : '';
    if (!sessionPromptSession) {
        showToast('未选择 session', true);
        return;
    }
    if (!text) {
        showToast('请先填写提示词计划', true);
        return;
    }
    await saveSessionPromptNote({ force: true });
    setTerminalCollapsed(false);
    const message = buildPromptOptimizeMessage(text, template ? template.value : '');
    const button = document.getElementById('promptOptimizeSendBtn');
    if (button) button.disabled = true;
    try {
        const sameActiveSession = sessionPromptSession === activeSession;
        const result = await postJson('api/send', {
            session: sessionPromptSession,
            window: sameActiveSession ? getTargetWindow() : null,
            pane: sameActiveSession ? getTargetPane() : null,
            text: message,
            enter: true,
            append_universal_prompt: false
        });
        if (!result.success) {
            showToast('优化请求发送失败：' + (result.error || '未知错误'), true);
            return;
        }
        showToast('优化请求已发送');
        loadSentPromptHistory();
        setTimeout(refreshData, 500);
    } catch (e) {
        showToast('优化请求发送错误：' + e.message, true);
    } finally {
        if (button) button.disabled = false;
    }
}

function setupSessionPromptEvents() {
    const closeBtn = document.getElementById('sessionPromptCloseBtn');
    const textarea = getSessionPromptTextElement();
    const template = getPromptOptimizeTemplateElement();
    const scope = document.getElementById('promptOptimizeTemplateScope');
    const togglePlanTemplateBtn = document.getElementById('sessionPromptPlanTemplateToggleBtn');
    const toggleTemplateBtn = document.getElementById('promptOptimizeTemplateToggleBtn');
    const saveTemplateBtn = document.getElementById('promptOptimizeTemplateSaveBtn');
    const promptsBtn = document.getElementById('sessionPromptPromptsBtn');
    const promptList = document.getElementById('sessionPromptCustomPromptList');
    const quickSendBtn = document.getElementById('sessionPromptQuickSendBtn');
    const copyBtn = document.getElementById('sessionPromptCopyBtn');
    const optimizeBtn = document.getElementById('promptOptimizeSendBtn');
    const terminalToggleBtn = document.getElementById('terminalDockToggleBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeSessionPromptPanel);
    if (textarea) {
        textarea.addEventListener('input', scheduleSessionPromptSave);
        textarea.addEventListener('blur', () => saveSessionPromptNote({ force: true }));
    }
    if (scope) {
        scope.addEventListener('change', () => setPromptOptimizeTemplateFromScope({
            global_template: template ? template.dataset.globalTemplate : DEFAULT_PROMPT_OPTIMIZE_TEMPLATE,
            session_template: template ? template.dataset.sessionTemplate : ''
        }));
    }
    if (togglePlanTemplateBtn) togglePlanTemplateBtn.addEventListener('click', toggleSessionPromptPlanTemplate);
    if (promptsBtn) promptsBtn.addEventListener('click', toggleSessionPromptPromptsPopover);
    if (promptList) {
        promptList.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-prompt-id]');
            const action = e.target.closest('[data-action]');
            if (!chip || !action || action.dataset.action !== 'fill') return;
            const prompt = findCustomPrompt(chip.dataset.promptId);
            if (!prompt) return;
            insertSessionPromptTextAtCursor(prompt.text);
            closeSessionPromptPromptsPopover();
        });
    }
    if (toggleTemplateBtn) toggleTemplateBtn.addEventListener('click', togglePromptOptimizeTemplate);
    if (saveTemplateBtn) saveTemplateBtn.addEventListener('click', savePromptOptimizeTemplate);
    if (quickSendBtn) quickSendBtn.addEventListener('click', sendSelectedSessionPromptToSession);
    if (copyBtn) copyBtn.addEventListener('click', sendSessionPromptToPlanMode);
    if (optimizeBtn) optimizeBtn.addEventListener('click', sendPromptOptimizeToSession);
    if (terminalToggleBtn) terminalToggleBtn.addEventListener('click', toggleTerminalDock);
    loadSessionPromptPlanTemplate();
    setPromptPlanTemplateOpen(false);
    setPromptTemplateOpen(false);
    setTerminalCollapsed(false);
}

function getCurrentMode() {
    const path = window.location.pathname;
    if (path.startsWith('/codex/')) return 'codex';
    if (path.startsWith('/default/')) return 'default';
    return 'claude';
}

function allowedNewSessionCommands() {
    const mode = getCurrentMode();
    if (mode === 'claude') return ['claude'];
    if (mode === 'codex') return ['codex'];
    return ['glm', 'claude', 'codex'];
}

function defaultSessionName(command) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(now.getMonth() + 1)}${pad(now.getDate())}-`;
}

function renderSessionToolbar() {
    const toolbar = document.getElementById('sessionToolbar');
    const displayNames = { glm: 'GLM', claude: 'Claude', codex: 'Codex' };
    toolbar.innerHTML = allowedNewSessionCommands().map(command =>
        `<button class="quick-btn" onclick="createSession('${command}')">+ ${displayNames[command] || command}</button>`
    ).join('');
}

function isDesktopLayout() {
    return window.matchMedia('(min-width: 960px)').matches;
}

function clampSidebarWidth(width) {
    return Math.max(260, Math.min(520, Number(width) || 320));
}

function applySidebarWidth(width = sidebarWidth) {
    sidebarWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
}

function setSidebarCollapsed(isCollapsed) {
    document.body.classList.toggle('sidebar-collapsed', isCollapsed);
    const button = document.getElementById('sidebarCollapseBtn');
    if (button) button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    closeDropdowns();
}

function toggleSidebar(event) {
    if (event) event.stopPropagation();
    if (!isDesktopLayout()) return;
    setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
}

function setupSidebarResize() {
    const resizer = document.getElementById('sidebarResizer');
    if (!resizer) return;

    resizer.addEventListener('pointerdown', (event) => {
        if (!isDesktopLayout() || document.body.classList.contains('sidebar-collapsed')) return;
        sidebarDragging = true;
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add('sidebar-resizing');
        event.preventDefault();
    });

    resizer.addEventListener('pointermove', (event) => {
        if (!sidebarDragging) return;
        applySidebarWidth(event.clientX);
    });

    resizer.addEventListener('pointerup', (event) => {
        if (!sidebarDragging) return;
        sidebarDragging = false;
        document.body.classList.remove('sidebar-resizing');
        localStorage.setItem('clawSidebarWidth', String(sidebarWidth));
        try { resizer.releasePointerCapture(event.pointerId); } catch (e) {}
    });
}

function setupPromptTerminalResize() {
    const resizer = document.getElementById('promptTerminalResizer');
    if (!resizer) return;

    resizer.addEventListener('pointerdown', (event) => {
        if (!isDesktopLayout() || !sessionPromptOpen || terminalCollapsed) return;
        promptTerminalDragging = true;
        resizer.setPointerCapture(event.pointerId);
        document.body.classList.add('prompt-terminal-resizing');
        event.preventDefault();
    });

    resizer.addEventListener('pointermove', (event) => {
        if (!promptTerminalDragging) return;
        const sidebarColumnWidth = document.body.classList.contains('sidebar-collapsed') ? 48 : sidebarWidth;
        const available = Math.max(820, window.innerWidth - sidebarColumnWidth);
        promptWidth = clampPromptWidth(event.clientX - sidebarColumnWidth);
        terminalWidth = clampTerminalWidth(available - promptWidth);
        if (terminalWidth === 360 && available - promptWidth < 360) {
            promptWidth = clampPromptWidth(available - terminalWidth);
        }
        applyPromptTerminalWidths();
    });

    resizer.addEventListener('pointerup', (event) => {
        if (!promptTerminalDragging) return;
        promptTerminalDragging = false;
        document.body.classList.remove('prompt-terminal-resizing');
        localStorage.setItem('clawPromptWidth', String(promptWidth));
        localStorage.setItem('clawTerminalWidth', String(terminalWidth));
        try { resizer.releasePointerCapture(event.pointerId); } catch (e) {}
    });
}

function getDropdownButton(cardId) {
    if (cardId === 'gitCard') return document.getElementById('gitMenuBtn');
    if (cardId === 'processCard') return document.getElementById('processMenuBtn');
    return null;
}

function setDropdownState(cardId, isOpen) {
    const card = document.getElementById(cardId);
    const button = getDropdownButton(cardId);
    if (card) card.classList.toggle('dropdown-open', isOpen);
    if (button) {
        button.classList.toggle('active', isOpen);
        button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }
}

function closeDropdowns() {
    setDropdownState('gitCard', false);
    setDropdownState('processCard', false);
}

function toggleDropdown(cardId) {
    if (!isDesktopLayout()) return;
    const card = document.getElementById(cardId);
    const shouldOpen = card && !card.classList.contains('dropdown-open');
    closeDropdowns();
    if (shouldOpen) {
        setDropdownState(cardId, true);
    }
}

// Send message to Claude
async function sendMessage() {
    const input = document.getElementById('inputText');
    const btn = document.getElementById('sendBtn');
    const text = input.value.trim();
    const images = getPendingImagesForSend();

    if (hasUploadingImages()) {
        showToast('Please wait for image upload', true);
        return;
    }
    if (!text && images.length === 0) {
        showToast('Please enter a message or add images', true);
        return;
    }
    if (pendingImages.some(image => image.status === 'error')) {
        showToast('Remove expired or failed images before sending', true);
        return;
    }

    const pendingImagesSnapshot = pendingImages.map(image => ({ ...image }));
    input.value = '';
    clearCurrentDraft();
    clearPendingImages();
    renderInputHistory();
    scrollTerminalToBottom();
    forceTerminalScrollToBottom = true;

    btn.disabled = true;
    btn.classList.add('sending');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Sending...';

    try {
        // Plan mode: 先发 /plan 进入计划模式
        if (window._planModeActive && text) {
            await fetch(apiUrl('api/send'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session: getTargetSession(),
                    window: getTargetWindow(),
                    pane: getTargetPane(),
                    text: '/plan',
                    enter: true
                })
            });
            await new Promise(r => setTimeout(r, 300));
            window._planModeActive = false;
            const badge = document.getElementById('planModeBadge');
            if (badge) badge.style.display = 'none';
        }

        const response = await fetch(apiUrl('api/send'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session: getTargetSession(),
                window: getTargetWindow(),
                pane: getTargetPane(),
                text: text,
                images: images,
                enter: true
            })
        });

        const result = await parseJsonResponse(response);

        if (result.success) {
            showToast(result.mode === 'file' ? 'Message sent via file' : 'Message sent!');
            if (images.length === 0 && text.length <= LONG_PROMPT_FILE_THRESHOLD) addInputHistory(text);
            loadSentPromptHistory();
            // Refresh terminal view after short delay
            setTimeout(refreshData, 500);
        } else {
            input.value = text;
            pendingImages = pendingImagesSnapshot;
            renderPendingImages();
            saveCurrentDraft();
            showToast('Failed: ' + (result.error || 'Unknown error'), true);
        }
    } catch (e) {
        input.value = text;
        pendingImages = pendingImagesSnapshot;
        renderPendingImages();
        saveCurrentDraft();
        showToast('Error: ' + e.message, true);
    } finally {
        btn.disabled = false;
        btn.classList.remove('sending');
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send';
    }
}

async function createSession(command) {
    const suggested = defaultSessionName(command);
    const name = prompt(`New ${command} session name`, suggested);
    if (!name) return;

    try {
        const response = await fetch(apiUrl('api/session/create'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name.trim(),
                command: command,
                cwd: '/root'
            })
        });
        const result = await parseJsonResponse(response);
        if (result.success) {
            const createdName = result.name || name.trim();
            showToast(`Created: ${createdName}`);
            setTimeout(async () => {
                await selectSession(createdName);
                refreshData({force: true});
            }, 500);
        } else {
            showToast('Create failed: ' + (result.error || 'Unknown error'), true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

async function renameSession(event, sessionName, currentDisplayName) {
    event.stopPropagation();
    const nextName = prompt('Display name (leave empty to reset)', currentDisplayName || sessionName);
    if (nextName === null) return;

    try {
        const response = await fetch(apiUrl('api/session/label'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: sessionName, display_name: nextName.trim() })
        });
        const result = await parseJsonResponse(response);
        if (result.success) {
            showToast('Renamed');
            setTimeout(refreshData, 300);
        } else {
            showToast('Rename failed: ' + (result.error || 'Unknown error'), true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

function togglePinAndRefresh(event, name) {
    event.stopPropagation();
    togglePinSession(name);
    const list = document.getElementById('sessionList');
    if (list) list.innerHTML = renderSessions(sessionsData);
}

async function deleteSession(event, sessionName) {
    event.stopPropagation();
    if (!confirm(`Delete tmux session ${sessionName}? This will kill running processes.`)) return;

    try {
        const response = await fetch(apiUrl('api/session/delete'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: sessionName })
        });
        const result = await parseJsonResponse(response);
        if (result.success) {
            showToast(`Deleted: ${sessionName}`);
            if (activeSession === sessionName) {
                clearPendingImages();
                activeSession = null;
                activeWindow = null;
                activePane = null;
            }
            setTimeout(refreshData, 500);
        } else {
            showToast('Delete failed: ' + (result.error || 'Unknown error'), true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

async function deleteAllHistorySessions(event, sessionNames) {
    event.stopPropagation();
    if (!confirm(`Delete ${sessionNames.length} history sessions? This will kill all running processes in those sessions.`)) return;

    try {
        const response = await fetch(apiUrl('api/session/delete-all'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names: sessionNames })
        });
        const result = await parseJsonResponse(response);
        if (result.success) {
            const deleted = result.deleted || [];
            showToast(`Deleted ${deleted.length} history session${deleted.length !== 1 ? 's' : ''}`);
            if (deleted.includes(activeSession)) {
                clearPendingImages();
                activeSession = null;
                activeWindow = null;
                activePane = null;
            }
            setTimeout(refreshData, 500);
        } else {
            const failed = result.failed || [];
            const deleted = result.deleted || [];
            if (deleted.length > 0) {
                showToast(`Deleted ${deleted.length}, failed ${failed.length}`, true);
                setTimeout(refreshData, 500);
            } else {
                showToast('Delete failed: ' + (result.error || 'Unknown error'), true);
            }
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

async function sendAcceptEdit() {
    try {
        const response = await fetch(apiUrl('api/accept-edit'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session: getTargetSession(),
                window: getTargetWindow(),
                pane: getTargetPane()
            })
        });

        const result = await parseJsonResponse(response);
        if (result.success) {
            showToast(result.mode === 'codex' ? 'Sent Shift+Tab to Codex' : 'Sent Shift+Tab');
            setTimeout(refreshData, 500);
        } else {
            showToast('Failed: ' + (result.error || 'Unknown error'), true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

// Send quick message
async function sendQuick(text) {
    try {
        const response = await fetch(apiUrl('api/send'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session: getTargetSession(),
                window: getTargetWindow(),
                pane: getTargetPane(),
                text: text,
                enter: true
            })
        });

        const result = await parseJsonResponse(response);
        if (result.success) {
            showToast('Sent: ' + text);
            setTimeout(refreshData, 500);
        } else {
            showToast('Failed: ' + (result.error || 'Unknown error'), true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

// Send control key (like Ctrl+C)
async function sendControl(key) {
    try {
        const response = await fetch(apiUrl('api/control'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session: getTargetSession(),
                window: getTargetWindow(),
                pane: getTargetPane(),
                key: key
            })
        });

        const result = await parseJsonResponse(response);
        if (result.success) {
            showToast('Sent: ' + key);
            setTimeout(refreshData, 500);
        } else {
            showToast('Failed to send', true);
        }
    } catch (e) {
        showToast('Error: ' + e.message, true);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const path = window.location.pathname;
    const activeMode = path.startsWith('/codex/') ? 'modeCodex' : path.startsWith('/default/') ? 'modeDefault' : 'modeClaude';
    document.getElementById(activeMode).classList.add('active');
    renderSessionToolbar();
    setupTerminalCaptureLinesSelect();
    setupSessionPromptEvents();

    const input = document.getElementById('inputText');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener('input', scheduleDraftSave);
    input.addEventListener('blur', saveCurrentDraft);
    setupImageAttachmentHandlers();
    setupSessionPromptImageHandlers();
    renderPendingImages();
    renderSessionPromptImages();

    const historyContainer = document.getElementById('inputHistory');
    if (historyContainer) {
        historyContainer.addEventListener('click', (e) => {
            const button = e.target.closest('[data-history-index]');
            if (!button) return;
            const item = getCurrentHistoryItems()[Number(button.dataset.historyIndex)];
            if (item) {
                insertComposerTextAtCursor(item.text || '');
                restoreImagesFromHistory(item.images || []);
                closeComposerPopovers();
            }
        });
    }

    const historyBtn = document.getElementById('historyPopoverBtn');
    const promptsBtn = document.getElementById('promptsPopoverBtn');
    if (historyBtn) historyBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleComposerPopover('historyPopover'); });
    if (promptsBtn) promptsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleComposerPopover('promptsPopover'); });

    setupCustomPromptEvents();
    loadCustomPrompts();

    applySidebarWidth();
    applyPromptTerminalWidths();
    setupSidebarResize();
    setupPromptTerminalResize();

    document.addEventListener('click', (e) => {
        if (e.target.closest('#sessionPromptPromptsPopover') || e.target.closest('#sessionPromptPromptsBtn')) return;
        closeSessionPromptPromptsPopover();
        if (e.target.closest('.composer-popover') || e.target.closest('.composer-popover-trigger')) return;
        closeComposerPopovers();
        if (!isDesktopLayout()) return;
        if (e.target.closest('.nav-popover-card') || e.target.closest('.nav-menu-btn')) return;
        closeDropdowns();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDropdowns();
            closeComposerPopovers();
            closeSessionPromptPromptsPopover();
            if (sessionPromptOpen) closeSessionPromptPanel();
        }
        // Shift+Tab: toggle plan mode
        if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            window._planModeActive = !window._planModeActive;
            const badge = document.getElementById('planModeBadge');
            if (badge) badge.style.display = window._planModeActive ? 'inline-block' : 'none';
        }
    });

    window.addEventListener('resize', () => {
        if (!isDesktopLayout()) {
            closeDropdowns();
            setSidebarCollapsed(false);
        } else {
            applySidebarWidth();
            applyPromptTerminalWidths();
        }
    });
});

// Toggle card collapse
function toggleCard(cardId) {
    if (isDesktopLayout()) {
        if (cardId === 'gitCard' || cardId === 'processCard') {
            toggleDropdown(cardId);
            return;
        }
        if (cardId === 'sessionsCard' || cardId === 'terminalCard') {
            return;
        }
    }
    document.getElementById(cardId).classList.toggle('collapsed');
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Format terminal content with ANSI handling
function formatTerminal(content) {
    if (!content) return '<span class="empty-state">No output</span>';
    // Parse OSC 8 hyperlinks (ESC]8;params;URI ST  TEXT  ESC]8;;ST) into real <a> links.
    // The URI is percent-encoded (e.g. file:///root/Documents/%E8%AF%BE%E7%A8%8B/...) and TEXT
    // is the human-readable label. We percent-decode the URI so the full path is readable, keep
    // TEXT as the visible label, and stash the link behind a sentinel placeholder so the SGR
    // escaper below doesn't mangle the generated HTML. The link is re-inserted after SGR pass.
    const hyperlinks = [];
    content = content.replace(
        /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g,
        (_, uri, label) => {
            let decoded = uri;
            try { decoded = decodeURIComponent(uri); } catch (e) { /* keep raw on bad %-encoding */ }
            const idx = hyperlinks.length;
            hyperlinks.push({ uri: decoded, label });
            return `HL${idx}`;
        }
    );
    // Strip any leftover/unpaired OSC sequences (window titles ESC]0;..., stray OSC 8 halves).
    content = content.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    const ansiPattern = /\x1b\[([0-9;:]*)m/g;
    const fgColors = {
        30: '#8b949e', 31: '#ff7b72', 32: '#3fb950', 33: '#d29922',
        34: '#58a6ff', 35: '#bc8cff', 36: '#39c5cf', 37: '#e6edf3',
        90: '#6e7681', 91: '#ffa198', 92: '#56d364', 93: '#e3b341',
        94: '#79c0ff', 95: '#d2a8ff', 96: '#56d4dd', 97: '#f0f6fc'
    };
    const bgColors = {
        40: '#0d1117', 41: '#5a1e1e', 42: '#1f4d2e', 43: '#4d3b1f',
        44: '#1f3a5f', 45: '#3d2a5f', 46: '#1f4d55', 47: '#6e7681',
        100: '#30363d', 101: '#7d2a2a', 102: '#2f6d3f', 103: '#6d552f',
        104: '#2f5180', 105: '#563d80', 106: '#2f6d76', 107: '#e6edf3'
    };
    let html = '';
    let lastIndex = 0;
    let state = { bold: false, fg: null, bg: null };
    let match;

    function renderChunk(chunk) {
        if (!chunk) return '';
        const styles = [];
        if (state.bold) styles.push('font-weight:700', 'color:var(--text-primary)');
        if (state.fg) styles.push(`color:${state.fg}`);
        if (state.bg) styles.push(`background-color:${state.bg}`);
        const escaped = escapeHtml(chunk);
        return styles.length ? `<span style="${styles.join(';')}">${escaped}</span>` : escaped;
    }

    function applyCodes(codes) {
        for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            if (code === 0) {
                state = { bold: false, fg: null, bg: null };
            } else if (code === 1) {
                state.bold = true;
            } else if (code === 22) {
                state.bold = false;
            } else if (code === 39) {
                state.fg = null;
            } else if (code === 49) {
                state.bg = null;
            } else if (fgColors[code]) {
                state.fg = fgColors[code];
            } else if (bgColors[code]) {
                state.bg = bgColors[code];
            }
        }
    }

    while ((match = ansiPattern.exec(content)) !== null) {
        html += renderChunk(content.slice(lastIndex, match.index));
        const rawCodes = match[1] ? match[1].split(/[;:]/).filter(Boolean).map(Number) : [0];
        applyCodes(rawCodes.length ? rawCodes : [0]);
        lastIndex = ansiPattern.lastIndex;
    }

    html += renderChunk(content.slice(lastIndex));
    // Re-insert OSC 8 hyperlinks. The sentinel placeholders survived HTML-escaping as plain
    // text; each becomes a real <a> whose visible label is the link TEXT and whose href/title
    // is the percent-decoded full path, so e.g. the URL renders as a readable, hoverable
    // file:///root/Documents/课程/自动化系统课/...md instead of being dropped or shown garbled.
    if (hyperlinks.length) {
        html = html.replace(/HL(\d+)/g, (_, n) => {
            const link = hyperlinks[Number(n)];
            if (!link) return '';
            const href = escapeAttr(link.uri);
            return `<a class="terminal-link" href="${href}" title="${href}" target="_blank" rel="noopener noreferrer" style="color:#58a6ff;text-decoration:underline">${escapeHtml(link.label)}</a>`;
        });
    }
    return html;
}

function scrollActiveSessionIntoView() {
    if (!isDesktopLayout()) return;
    const list = document.getElementById('sessionList');
    const active = list ? list.querySelector('.session-group.active') : null;
    if (!list || !active || list.scrollHeight <= list.clientHeight) return;
    const activeTop = active.offsetTop;
    const activeBottom = activeTop + active.offsetHeight;
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    if (activeTop < viewTop) {
        list.scrollTop = activeTop;
    } else if (activeBottom > viewBottom) {
        list.scrollTop = activeBottom - list.clientHeight;
    }
}

function sortSessionsForDisplay(sessions) {
    const pinned = getPinnedSessions();
    return [...sessions].sort((a, b) => {
        const aPin = pinned.includes(a.name) ? 1 : 0;
        const bPin = pinned.includes(b.name) ? 1 : 0;
        if (aPin !== bPin) return bPin - aPin;
        const aPlan = a.has_prompt_plan ? 1 : 0;
        const bPlan = b.has_prompt_plan ? 1 : 0;
        if (aPlan !== bPlan) return bPlan - aPlan;
        const aPending = a.prompt_plan_pending ? 1 : 0;
        const bPending = b.prompt_plan_pending ? 1 : 0;
        if (aPending !== bPending) return bPending - aPending;
        return Number(b.display_activity_ts || b.last_activity_ts || 0) - Number(a.display_activity_ts || a.last_activity_ts || 0);
    });
}

// Update active state in sidebar without rebuilding DOM
function updateSessionListActiveState() {
    document.querySelectorAll('#sessionList .session-group').forEach(el => {
        const item = el.querySelector('.session-item');
        if (!item) return;
        // Extract session name from onclick handler
        const onclick = item.getAttribute('onclick') || '';
        const match = onclick.match(/select(?:Session|Pane)\('([^']+)'/);
        if (match) {
            el.classList.toggle('active', match[1] === activeSession);
        }
    });
}

// Render sessions with windows and panes
function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
        return '<div class="empty-state">No tmux sessions</div>';
    }

    const nowTs = Math.floor(Date.now() / 1000);
    const pinned = getPinnedSessions();
    const sorted = sortSessionsForDisplay(sessions);
    const todaySessions = [];
    const historySessions = [];

    for (const s of sorted) {
        const ts = s.created_at_ts || 0;
        if (pinned.includes(s.name) || s.has_prompt_plan || (ts > 0 && nowTs - ts < 43200)) {
            todaySessions.push(s);
        } else {
            historySessions.push(s);
        }
    }

    const renderOne = (s) => {
        const isActiveSession = s.name === activeSession;
        const activeWindow = s.windows && s.windows.find(w => w.active) || (s.windows && s.windows[0]);
        const activePane = activeWindow && activeWindow.panes && (activeWindow.panes.find(p => p.active) || activeWindow.panes[0]);
        const selectHandler = activeWindow && activePane
            ? `selectPane('${s.name}', '${activeWindow.index}', '${activePane.index}')`
            : `selectSession('${s.name}')`;
        const sessionDisplayName = s.display_name || s.name;
        const hookBadge = getHookStatusBadge(s.hook_status, s.name);
        const planBadge = s.has_prompt_plan
            ? `<span class="session-plan-badge ${s.prompt_plan_pending ? 'pending' : ''}">${s.prompt_plan_pending ? '待办' : '计划'}</span>`
            : '';
        const groupClasses = [
            'session-group',
            isActiveSession ? 'active' : '',
            s.has_prompt_plan ? 'has-prompt-plan' : '',
            s.prompt_plan_pending ? 'prompt-plan-pending' : ''
        ].filter(Boolean).join(' ');
        const isPinned = pinned.includes(s.name);
        return `
            <div class="${groupClasses}">
                <div class="session-item" onclick="${selectHandler}">
                    <div class="session-title-row">
                        <span class="session-name">
                            ${hookBadge} ${escapeHtml(sessionDisplayName)} ${sessionDisplayName !== s.name ? `<span class="session-meta">(${escapeHtml(s.name)})</span>` : ''} <span class="card-badge">${escapeHtml(KIND_LABELS[s.kind] || s.kind || 'unknown')}</span>${planBadge}
                        </span>
                    </div>
                    <div class="session-actions">
                        <button class="copy-session-btn pin-btn ${isPinned ? 'pinned' : ''}" data-session="${escapeHtml(s.name)}" onclick="togglePinAndRefresh(event, this.dataset.session)">${isPinned ? '★' : '☆'}</button>
                        <button class="copy-session-btn" data-session="${escapeHtml(s.name)}" onclick="openSessionPromptPanel(event, this.dataset.session)">Prompt</button>
                        <button class="copy-session-btn" data-session="${escapeHtml(s.name)}" onclick="copyAttachCommand(event, this.dataset.session)">Attach</button>
                        <button class="copy-session-btn" data-session="${escapeHtml(s.name)}" data-display-name="${escapeHtml(sessionDisplayName)}" onclick="renameSession(event, this.dataset.session, this.dataset.displayName)">Rename</button>
                        <button class="copy-session-btn danger" data-session="${escapeHtml(s.name)}" onclick="deleteSession(event, this.dataset.session)">Delete</button>
                        <span class="session-meta">${s.display_activity || s.last_activity || s.created}</span>
                    </div>
                </div>
            </div>
        `;
    };

    // If active session is in history, auto-expand
    const activeInHistory = activeSession && historySessions.some(s => s.name === activeSession);
    const historyClass = activeInHistory ? 'session-history-list' : 'session-history-list collapsed';

    let html = todaySessions.map(renderOne).join('');

    if (historySessions.length > 0) {
        html += `
        <div class="session-history-section">
            <div class="session-history-toggle" onclick="toggleHistorySessions()">
                <span class="session-history-chevron">${activeInHistory ? '▼' : '▶'}</span> 历史会话 <span class="session-history-count">(${historySessions.length})</span>
                <button class="session-history-delete-all" onclick="deleteAllHistorySessions(event, ${JSON.stringify(historySessions.filter(s => !getPinnedSessions().includes(s.name)).map(s => s.name)).replace(/"/g, '&quot;')})">Delete All</button>
            </div>
            <div class="${historyClass}">
                ${historySessions.map(renderOne).join('')}
            </div>
        </div>`;
    }

    return html;
}

function toggleHistorySessions() {
    const list = document.querySelector('.session-history-list');
    const chevron = document.querySelector('.session-history-chevron');
    if (!list) return;
    list.classList.toggle('collapsed');
    if (chevron) chevron.textContent = list.classList.contains('collapsed') ? '▶' : '▼';
}

// Render git changes
function renderGitChanges(status) {
    if (!status || status === 'Clean' || status.startsWith('[')) {
        return '';
    }
    const files = status.split('\n').filter(l => l.trim()).slice(0, 10);
    return files.map(f => {
        const type = f.startsWith('M') ? 'modified' : f.startsWith('A') ? 'added' : f.startsWith('D') ? 'deleted' : 'modified';
        const name = f.substring(2).trim().split('/').pop();
        return `<span class="git-file ${type}">${escapeHtml(name)}</span>`;
    }).join('');
}

// Render commits
function renderCommits(logs) {
    if (!logs || logs.length === 0) {
        return '<div class="empty-state">No commits</div>';
    }
    return logs.map(c => `
        <div class="commit-item">
            <span class="commit-hash">${escapeHtml(c.hash)}</span>
            <span class="commit-msg">${escapeHtml(c.message)}</span>
        </div>
    `).join('');
}

// Render processes
function renderProcesses(processes) {
    if (!processes || processes.length === 0) {
        return '<div class="empty-state">No Claude processes</div>';
    }
    return processes.map(p => {
        const cpu = Math.max(0, Math.min(100, Number.parseFloat(p.cpu) || 0));
        const mem = Math.max(0, Math.min(100, Number.parseFloat(p.mem) || 0));
        return `
            <div class="process-item">
                <div class="process-cmd">${escapeHtml(p.cmd)}</div>
                <div class="process-stats">
                    <span>PID: ${p.pid}</span>
                    <span>CPU: ${p.cpu}%</span>
                    <span>MEM: ${p.mem}%</span>
                </div>
                <div class="process-meters">
                    <div>
                        <div class="process-meter-label"><span>CPU</span><span>${p.cpu}%</span></div>
                        <div class="process-meter-track"><div class="process-meter-fill" style="width:${cpu}%"></div></div>
                    </div>
                    <div>
                        <div class="process-meter-label"><span>MEM</span><span>${p.mem}%</span></div>
                        <div class="process-meter-track"><div class="process-meter-fill memory" style="width:${mem}%"></div></div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Update UI with data
function updateUI(data) {
    const prevActiveSession = activeSession;

    // Stats
    const claudeCount = data.claude ? data.claude.length : 0;
    const sessionCount = data.tmux && data.tmux.sessions ? data.tmux.sessions.length : 0;

    document.getElementById('statSessions').textContent = sessionCount;
    document.getElementById('statSessions').className = 'stat-value ' + (sessionCount > 0 ? 'green' : '');

    if (data.system && data.system.cpu) {
        document.getElementById('statCpu').textContent = data.system.cpu;
    }

    if (data.system && data.system.memory) {
        document.getElementById('statMemory').textContent = data.system.memory;
    }

    if (data.system && data.system.disk) {
        const diskEl = document.getElementById('statDisk');
        if (diskEl) diskEl.textContent = data.system.disk;
    }

    // Status dot
    const statusDot = document.getElementById('statusDot');
    statusDot.className = 'status-dot' + (claudeCount > 0 ? '' : sessionCount > 0 ? ' warning' : ' error');

    // Store sessions data for later use
    sessionsData = data.tmux ? data.tmux.sessions : [];

    if (!activeSession && sessionsData.length > 0) {
        const savedTarget = loadActiveTarget();
        const savedSessionExists = savedTarget && sessionsData.some(s => s.name === savedTarget.session);
        if (savedSessionExists) {
            activeSession = savedTarget.session;
            activeWindow = savedTarget.window ?? null;
            activePane = savedTarget.pane ?? null;
        } else {
            activeSession = sortSessionsForDisplay(sessionsData)[0].name;
        }
    }

    const activeStillExists = activeSession && sessionsData.some(s => s.name === activeSession);
    const previousTargetKey = getComposerTargetKey();
    if (!activeStillExists) {
        activeSession = sessionsData.length > 0 ? sortSessionsForDisplay(sessionsData)[0].name : null;
        activeWindow = null;
        activePane = null;
    }

    updateTerminalBadge();
    syncTerminalCaptureLinesSelect();
    if (sessionPromptOpen && activeSession && sessionPromptSession !== activeSession) {
        syncSessionPromptPanelToSession(activeSession);
    }
    if (previousTargetKey !== getComposerTargetKey()) {
        restoreDraftForActiveTarget();
    }
    renderInputHistory();
    if (previousTargetKey !== getComposerTargetKey()) {
        loadSentPromptHistory();
    }

    // Sessions list — only rebuild DOM if data actually changed
    const sessionsHash = sessionsData.map(s => `${s.name}:${s.kind}:${s.attached}:${s.display_activity || s.last_activity}:${s.has_prompt_plan}:${s.prompt_plan_pending}:${s.hook_status}`).join('|');
    if (sessionsHash !== lastSessionsHash || activeSession !== prevActiveSession) {
        lastSessionsHash = sessionsHash;
        document.getElementById('sessionList').innerHTML = renderSessions(sessionsData);
        scrollActiveSessionIntoView();
    }

    // Git
    if (data.git) {
        const branch = data.git.branch || '-';
        const changes = data.git.changes || 0;
        document.getElementById('gitBranch').textContent = branch;
        document.getElementById('gitChanges').innerHTML = renderGitChanges(data.git.status);
        document.getElementById('commitList').innerHTML = renderCommits(data.git.log);
        const navGitSummary = document.getElementById('navGitSummary');
        const gitMenuBtn = document.getElementById('gitMenuBtn');
        if (navGitSummary) navGitSummary.textContent = `${branch} · ${changes}`;
        if (gitMenuBtn) gitMenuBtn.classList.toggle('dirty', changes > 0);
    }

    // Processes
    document.getElementById('processList').innerHTML = renderProcesses(data.claude);
    const navProcessSummary = document.getElementById('navProcessSummary');
    if (navProcessSummary) navProcessSummary.textContent = `${claudeCount}`;

    // Update time
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
}

// Select a different session (uses active window/pane of that session)
async function selectSession(name) {
    saveCurrentDraft();
    clearPendingImages();
    activeSession = name;
    markSessionStatusRead(name);
    activeWindow = null;
    activePane = null;
    const paneRequest = beginPaneRequest();
    showTerminalLoading();
    updateSessionListActiveState();
    scrollActiveSessionIntoView();
    saveActiveTarget();
    updateTerminalBadge();
    syncTerminalCaptureLinesSelect();
    restoreDraftForActiveTarget();
    renderInputHistory();
    loadSentPromptHistory();
    await closeSessionPromptPanelForSelection();

    try {
        const params = new URLSearchParams({ session: name, lines: String(getTerminalCaptureLines()) });
        const data = await fetchJson(`api/pane?${params.toString()}`);
        if (isCurrentPaneRequest(paneRequest)) {
            renderTerminalContent(data.content);
        }
    } catch (e) {
        console.error('Failed to fetch pane:', e);
        if (isCurrentPaneRequest(paneRequest)) {
            document.getElementById('terminalContent').textContent = 'Failed to load session.';
        }
    }
}

// Select a specific window within a session
async function selectWindow(sessionName, windowIndex) {
    saveCurrentDraft();
    clearPendingImages();
    activeSession = sessionName;
    markSessionStatusRead(sessionName);
    activeWindow = windowIndex;
    activePane = null;
    const paneRequest = beginPaneRequest();
    showTerminalLoading();
    updateSessionListActiveState();
    scrollActiveSessionIntoView();
    saveActiveTarget();
    updateTerminalBadge();
    syncTerminalCaptureLinesSelect();
    restoreDraftForActiveTarget();
    renderInputHistory();
    loadSentPromptHistory();
    await closeSessionPromptPanelForSelection();

    try {
        const params = new URLSearchParams({ session: sessionName, window: windowIndex, lines: String(getTerminalCaptureLines()) });
        const data = await fetchJson(`api/pane?${params.toString()}`);
        if (isCurrentPaneRequest(paneRequest)) {
            renderTerminalContent(data.content);
        }
    } catch (e) {
        console.error('Failed to fetch pane:', e);
        if (isCurrentPaneRequest(paneRequest)) {
            document.getElementById('terminalContent').textContent = 'Failed to load session.';
        }
    }
}

// Select a specific pane within a window
async function selectPane(sessionName, windowIndex, paneIndex) {
    saveCurrentDraft();
    clearPendingImages();
    activeSession = sessionName;
    markSessionStatusRead(sessionName);
    activeWindow = windowIndex;
    activePane = paneIndex;
    const paneRequest = beginPaneRequest();
    showTerminalLoading();
    updateSessionListActiveState();
    scrollActiveSessionIntoView();
    saveActiveTarget();
    updateTerminalBadge();
    syncTerminalCaptureLinesSelect();
    restoreDraftForActiveTarget();
    renderInputHistory();
    loadSentPromptHistory();
    await closeSessionPromptPanelForSelection();

    try {
        const params = new URLSearchParams({ session: sessionName, window: windowIndex, pane: paneIndex, lines: String(getTerminalCaptureLines()) });
        const data = await fetchJson(`api/pane?${params.toString()}`);
        if (isCurrentPaneRequest(paneRequest)) {
            renderTerminalContent(data.content);
        }
    } catch (e) {
        console.error('Failed to fetch pane:', e);
        if (isCurrentPaneRequest(paneRequest)) {
            document.getElementById('terminalContent').textContent = 'Failed to load session.';
        }
    }
}

function getSessionDisplayName(sessionName) {
    const session = sessionsData.find(item => item.name === sessionName);
    return (session && session.display_name) || sessionName;
}

function getTargetLabel() {
    const displayName = getSessionDisplayName(activeSession);
    if (activePane !== null) {
        return `${displayName}:${activeWindow}.${activePane}`;
    }
    if (activeWindow !== null) {
        return `${displayName}:${activeWindow}`;
    }
    return displayName || '-';
}

function setSessionDetailsOpen(sessionName, isOpen) {
    if (isOpen) {
        expandedSessionDetails.add(sessionName);
    } else {
        expandedSessionDetails.delete(sessionName);
    }
}

function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function getAttachSocket(s) {
    const socket = s && s.dispatch && s.dispatch.tmux_socket ? s.dispatch.tmux_socket : '';
    if (socket) return socket;
    const mode = getCurrentMode();
    if (mode === 'claude') return '/tmp/clawdbot-tmux-sockets/claude-code.sock';
    if (mode === 'codex') return '/tmp/clawdbot-tmux-sockets/codex-code.sock';
    if (mode === 'default') return '/tmp/clawdbot-tmux-sockets/default-code.sock';
    return '';
}

function buildAttachCommand(sessionName) {
    const s = sessionsData.find(item => item.name === sessionName) || { name: sessionName, dispatch: {} };
    const socket = getAttachSocket(s);
    const socketArg = socket ? `-S ${shellQuote(socket)} ` : '';
    return `tmux ${socketArg}attach -t ${shellQuote(s.name || sessionName)}`;
}

async function copyAttachCommand(event, sessionName) {
    event.stopPropagation();
    const text = buildAttachCommand(sessionName);
    try {
        await navigator.clipboard.writeText(text);
        showToast('Attach command copied');
    } catch (e) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        showToast('Attach command copied');
    }
}

// Update terminal badge to show session:window.pane
function updateTerminalBadge() {
    const label = getTargetLabel();
    const terminalSession = document.getElementById('terminalSession');
    const inputTarget = document.getElementById('inputTarget');
    if (terminalSession) terminalSession.textContent = label;
    if (inputTarget) inputTarget.textContent = label;
}

function terminalHasSelection(terminal) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
    return terminal.contains(selection.anchorNode) || terminal.contains(selection.focusNode);
}

function scrollTerminalToBottom() {
    const terminal = document.getElementById('terminalContent');
    if (!terminal) return;
    terminal.scrollTop = terminal.scrollHeight;
}

async function expandTerminalCaptureFromScroll() {
    if (terminalCaptureExpandInFlight || !activeSession) return;
    const terminal = document.getElementById('terminalContent');
    if (!terminal) return;
    if (!expandTerminalCaptureLines()) return;
    terminalCaptureExpandInFlight = true;
    const previousHeight = terminal.scrollHeight;
    const previousTop = terminal.scrollTop;
    const previousForceScroll = forceTerminalScrollToBottom;
    forceTerminalScrollToBottom = false;
    try {
        await refreshActivePane();
        requestAnimationFrame(() => {
            terminal.scrollTop = Math.max(0, terminal.scrollHeight - previousHeight + previousTop);
        });
    } finally {
        forceTerminalScrollToBottom = previousForceScroll;
        terminalCaptureExpandInFlight = false;
    }
}

function renderTerminalContent(content, followIfAtBottom = false) {
    const terminal = document.getElementById('terminalContent');
    if (!terminal) return;
    if (terminalHasSelection(terminal) && !forceTerminalScrollToBottom) {
        return;
    }
    const distanceFromBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
    const wasNearBottom = distanceFromBottom < 40;

    if (followIfAtBottom && terminalRawContent && content.startsWith(terminalRawContent)) {
        const appended = content.slice(terminalRawContent.length);
        if (appended) {
            terminal.insertAdjacentHTML('beforeend', formatTerminal(appended));
        }
    } else {
        terminal.innerHTML = formatTerminal(content);
    }
    terminalRawContent = content;

    if (forceTerminalScrollToBottom) {
        scrollTerminalToBottom();
        forceTerminalScrollToBottom = false;
    } else if (followIfAtBottom && wasNearBottom) {
        scrollTerminalToBottom();
    } else if (!followIfAtBottom) {
        scrollTerminalToBottom();
    } else {
        terminal.scrollTop = Math.max(0, terminal.scrollHeight - terminal.clientHeight - distanceFromBottom);
    }
}

async function refreshActivePane() {
    if (!activeSession) {
        return;
    }

    const requestedSession = activeSession;
    const requestedWindow = activeWindow;
    const requestedPane = activePane;
    const paneRequest = beginPaneRequest();
    const params = new URLSearchParams({ session: requestedSession, lines: String(getTerminalCaptureLines()) });
    if (requestedWindow !== null) {
        params.set('window', requestedWindow);
    }
    if (requestedPane !== null) {
        params.set('pane', requestedPane);
    }

    const data = await fetchJson(`api/pane?${params.toString()}`, 0);
    if (isCurrentPaneRequest(paneRequest) && data.content !== undefined) {
        renderTerminalContent(data.content, true);
    }
}

// Refresh data
async function refreshData(options = {}) {
    const showLoading = options.showLoading === true;
    if (!options.force && !showLoading && shouldPauseAutoRefresh()) return;
    if (refreshInFlight) return;
    refreshInFlight = true;
    const inflightSafetyTimeout = setTimeout(() => { refreshInFlight = false; }, 10000);

    const btn = document.getElementById('refreshBtn');
    const text = document.getElementById('refreshText');

    if (showLoading) {
        btn.classList.add('loading');
    } else if (btn) {
        btn.classList.add('pulse');
    }

    try {
        const [data] = await Promise.all([
            fetchJson('api/data', 2),
            refreshActivePane()
        ]);
        updateUI(data);
    } catch (e) {
        console.error('Failed to refresh:', e);
        document.getElementById('statusDot').className = 'status-dot error';
    } finally {
        clearTimeout(inflightSafetyTimeout);
        refreshInFlight = false;
        if (showLoading) {
            btn.classList.remove('loading');
        } else if (btn) {
            btn.classList.remove('pulse');
        }
    }
}

const terminalElement = document.getElementById('terminalContent');
if (terminalElement) {
    terminalElement.addEventListener('scroll', () => {
        if (terminalElement.scrollTop < 80 && activeSession) {
            expandTerminalCaptureFromScroll();
        }
    });
}

// Pull to refresh
document.addEventListener('touchstart', (e) => {
    if (window.scrollY === 0) {
        touchStartY = e.touches[0].clientY;
    }
});

document.addEventListener('touchmove', (e) => {
    if (touchStartY > 0 && window.scrollY === 0) {
        const diff = e.touches[0].clientY - touchStartY;
        if (diff > 50) {
            isPulling = true;
            document.getElementById('pullIndicator').classList.add('visible');
        }
    }
});

document.addEventListener('touchend', () => {
    if (isPulling) {
        refreshData();
    }
    touchStartY = 0;
    isPulling = false;
    document.getElementById('pullIndicator').classList.remove('visible');
});

// Initial load and auto-refresh
refreshData();
refreshTimer = setInterval(refreshData, refreshInterval);

// Visibility change handling
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        saveCurrentDraft();
        clearInterval(refreshTimer);
    } else {
        refreshData({ force: true });
        refreshTimer = setInterval(refreshData, refreshInterval);
    }
});

window.addEventListener('beforeunload', saveCurrentDraft);
