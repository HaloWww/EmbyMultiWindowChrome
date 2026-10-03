// Bundled by tools/build-userscript.cjs inside a private userscript scope.
const VERSION = '0.7.28';
const namespace = 'embyMultiWindow.userscript.';
const listeners = [];
const runtimeListeners = [];
function newId() {
    if (typeof crypto.randomUUID === 'function') { return crypto.randomUUID(); }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
const playerId = new URL(location.href).searchParams.get('embyMultiWindowId') || newId();
const mode = new URL(location.href).searchParams.get('embyMultiWindow');
const localWindows = new Map();
let workerUrl = null;
let entryActivated = false;

function getStored(key, fallback) { return GM_getValue(namespace + key, fallback); }
function setStored(key, value) { GM_setValue(namespace + key, value); }
function readSettings() { return getStored('settings', {}); }
function siteAllowed(url) {
    const defaults = ['http://localhost', 'https://localhost', 'http://127.0.0.1', 'https://127.0.0.1', 'http://192.168.8.10:8096'];
    return (readSettings().allowedSites || defaults).some(site => {
        try {
            const configured = new URL(site), page = new URL(url);
            return configured.protocol === page.protocol && (!configured.port || configured.port === page.port) &&
                (configured.hostname === page.hostname || configured.hostname.startsWith('*.') &&
                    (page.hostname === configured.hostname.slice(2) || page.hostname.endsWith(configured.hostname.slice(1))));
        } catch (_) { return false; }
    });
}

function popupUrl(kind, id) {
    const url = new URL(location.href);
    url.searchParams.set('embyMultiWindow', kind);
    url.searchParams.set('embyMultiWindowId', id);
    url.hash = '';
    return url.href;
}
function prepareWindow(newWindow, kind = 'player') {
    const active = getStored('activePlayer', null);
    const existing = active && getStored('window.' + active, null);
    const reusable = kind === 'player' && !newWindow && existing &&
        Date.now() - existing.seen < 15000;
    if (reusable) {
        const popup = localWindows.get(active);
        if (popup && !popup.closed) { popup.focus(); }
        else { setStored('focusSignal', {id: active, nonce: newId()}); }
        return active;
    }
    const id = reusable ? active : newId();
    const settings = readSettings();
    // Called synchronously by the click handler, before PlaybackInfo awaits.
    const popup = window.open(popupUrl(kind, id), 'emby-multiwindow-' + id,
        'popup=yes,width=' + (settings.windowWidth || 1100) + ',height=' + (settings.windowHeight || 720));
    if (!popup) { throw new Error('弹窗被拦截，请允许此 Emby 网站打开弹窗。'); }
    localWindows.set(id, popup);
    if (kind === 'player') { setStored('activePlayer', id); }
    popup.focus();
    return id;
}

function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        let request;
        const signal = options.signal;
        const abort = () => { if (request) { request.abort(); } reject(new DOMException('Aborted', 'AbortError')); };
        if (signal && signal.aborted) { abort(); return; }
        const cleanup = () => { if (signal) { signal.removeEventListener('abort', abort); } };
        request = GM_xmlhttpRequest({
            method: options.method || 'GET', url: String(url),
            headers: Object.fromEntries(new Headers(options.headers || {}).entries()),
            data: options.body, responseType: 'arraybuffer', anonymous: options.credentials === 'omit',
            timeout: 30000,
            onload(response) {
                cleanup();
                const body = response.response || new ArrayBuffer(0);
                const result = new Response(body.byteLength ? body : null, {status: response.status || 502});
                Object.defineProperty(result, 'url', {value: response.finalUrl || String(url)});
                resolve(result);
            },
            onerror() { cleanup(); reject(new TypeError('网络请求失败')); },
            ontimeout() { cleanup(); reject(new TypeError('网络请求超时')); },
            onabort() { cleanup(); reject(new DOMException('Aborted', 'AbortError')); }
        });
        if (signal) { signal.addEventListener('abort', abort, {once: true}); }
    });
}

function createGmLoaderClass() {
    return class GmLoader {
        constructor() {
            this.stats = {aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0,
                loading: {start: 0, first: 0, end: 0}, parsing: {start: 0, end: 0}, buffering: {start: 0, end: 0}};
        }
        load(context, config, callbacks) {
            this.context = context;
            this.callbacks = callbacks;
            this.controller = new AbortController();
            this.stats.loading.start = performance.now();
            const headers = {};
            if (context.rangeEnd > context.rangeStart) { headers.Range = 'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1); }
            gmFetch(context.url, {headers, signal: this.controller.signal, credentials: 'omit'})
                .then(async response => {
                    if (!response.ok) { throw {code: response.status, text: 'HTTP ' + response.status}; }
                    const data = context.responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
                    if (this.stats.aborted || !this.callbacks) { return; }
                    this.stats.loading.first = this.stats.loading.end = performance.now();
                    this.stats.loaded = this.stats.total = data.byteLength || data.length;
                    callbacks.onSuccess({url: response.url, data, code: response.status}, this.stats, context, null);
                }).catch(error => {
                    if (!this.stats.aborted && this.callbacks) {
                        callbacks.onError({code: error.code || 0, text: error.text || error.message}, context, null, this.stats);
                    }
                });
        }
        abort() {
            this.stats.aborted = true;
            if (this.controller) { this.controller.abort(); }
            if (this.callbacks && this.callbacks.onAbort) { this.callbacks.onAbort(this.stats, this.context, null); }
        }
        destroy() { this.abort(); this.callbacks = null; }
        getCacheAge() { return null; }
        getResponseHeader() { return null; }
    };
}

function storageArea(kind) {
    return {
        async get(defaults) {
            const values = kind === 'sync' ? readSettings() : getStored('queue.' + playerId, {});
            return defaults === null ? values : Object.assign({}, defaults, values);
        },
        async set(values) {
            if (kind !== 'sync') { throw new Error('会话队列只由窗口通信层写入'); }
            setStored('settings', Object.assign({}, readSettings(), values));
        },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                // Every queued request is a distinct GM key, avoiding read/modify/write races.
                GM_deleteValue(namespace + 'request.' + key);
            }
        }
    };
}
const chrome = {
    windows: {getCurrent: async () => ({id: playerId})},
    storage: {sync: storageArea('sync'), session: storageArea('session'),
        onChanged: {addListener: callback => listeners.push(callback)}},
    runtime: {
        getManifest: () => ({version: VERSION}),
        getURL(name) {
            if (name !== 'hls.worker.js') { throw new Error('未知内置资源'); }
            if (!workerUrl) { workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], {type: 'text/javascript'})); }
            return workerUrl;
        },
        onMessage: {addListener: callback => runtimeListeners.push(callback)},
        async sendMessage(message) {
            if (message.type === 'EMBY_MULTIWINDOW_NEW_PLAYER') {
                return {ok: true, windowId: prepareWindow(true)};
            }
            throw new Error('未知窗口消息');
        }
    }
};

// Queue snapshots are synthesized from independent keys for safe concurrent adds.
chrome.storage.session.get = async () => {
    const queue = {};
    for (const key of GM_listValues()) {
        if (!key.startsWith(namespace + 'request.')) { continue; }
        const envelope = GM_getValue(key);
        if (!envelope || Date.now() - envelope.created > 120000) {
            const stopUrl = envelope && envelope.payload && envelope.payload.endpoints && envelope.payload.endpoints.stopEncoding;
            if (stopUrl) { gmFetch(stopUrl, {method: 'POST'}).catch(() => {}); }
            GM_deleteValue(key); continue;
        }
        if (envelope.targetWindowId === playerId) { queue[key.slice((namespace + 'request.').length)] = envelope; }
    }
    return queue;
};
GM_addValueChangeListener(namespace + 'settings', (_, oldValue = {}, newValue = {}) => {
    const changes = {};
    for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
        if (JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key])) {
            changes[key] = {oldValue: oldValue[key], newValue: newValue[key]};
        }
    }
    listeners.forEach(callback => callback(changes, 'sync'));
    if (changes.allowedSites) { activateEntry(); }
});

function queuePayload(payload) {
    const id = payload.targetPlayerId || prepareWindow(!!payload.openInNewWindow);
    const key = 'embyMultiWindow.pending.' + payload.requestId;
    GM_setValue(namespace + 'request.' + key, {targetWindowId: id, payload, created: Date.now()});
    GM_setValue(namespace + 'queueSignal', {id, nonce: newId()});
}
GM_addValueChangeListener(namespace + 'queueSignal', (_, oldValue, signal) => {
    if (signal && signal.id === playerId) {
        runtimeListeners.forEach(callback => callback({type: 'EMBY_MULTIWINDOW_QUEUE_UPDATED', targetWindowId: playerId}));
    }
});

function announcePlayer() {
    for (const key of GM_listValues()) {
        if (key.startsWith(namespace + 'window.')) {
            const entry = GM_getValue(key);
            if (!entry || Date.now() - entry.seen > 60000) { GM_deleteValue(key); }
        }
    }
    setStored('window.' + playerId, {seen: Date.now(), origin: location.origin});
}
GM_addValueChangeListener(namespace + 'focusSignal', (_, oldValue, signal) => {
    if (mode === 'player' && signal && signal.id === playerId) { window.focus(); }
});

function showSettings() { prepareWindow(true, 'options'); }
GM_registerMenuCommand('Emby 多画面：设置', showSettings);
GM_registerMenuCommand('启用此 Emby 网站', () => {
    const settings = readSettings();
    setStored('settings', Object.assign({}, settings, {allowedSites: [...new Set([...(settings.allowedSites || []), location.origin])]}));
    location.reload();
});

function mountPage(html, css) {
    const parsed = new DOMParser().parseFromString(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<link\b[^>]*>/gi, ''), 'text/html');
    const element = document.importNode(parsed.documentElement, true);
    if (document.documentElement) { document.documentElement.replaceWith(element); }
    else { document.appendChild(element); }
    GM_addStyle(css);
}

function whenDocumentReady(callback) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, {once: true});
    } else { callback(); }
}

if (mode === 'player' || mode === 'options') {
    // Prevent the host application's deferred/module bootstrap from sharing the player DOM.
    const blocker = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
        if (node.nodeType !== 1) { return; }
        if (node.tagName === 'SCRIPT') { node.remove(); }
        else { node.querySelectorAll('script').forEach(script => script.remove()); }
    })));
    blocker.observe(document, {childList: true, subtree: true});
    whenDocumentReady(() => blocker.disconnect());
}

if (mode === 'player') { whenDocumentReady(() => {
    mountPage(PLAYER_HTML, PLAYER_CSS);
    announcePlayer();
    const heartbeat = setInterval(() => {
        announcePlayer();
        runtimeListeners.forEach(callback => callback({type: 'EMBY_MULTIWINDOW_QUEUE_UPDATED', targetWindowId: playerId}));
    }, 3000);
    window.addEventListener('focus', () => { setStored('activePlayer', playerId); announcePlayer(); });
    window.addEventListener('resize', () => {
        setStored('settings', Object.assign({}, readSettings(), {windowWidth: window.outerWidth, windowHeight: window.outerHeight}));
    });
    window.addEventListener('pagehide', () => {
        clearInterval(heartbeat);
        GM_deleteValue(namespace + 'window.' + playerId);
        if (workerUrl) { URL.revokeObjectURL(workerUrl); }
    });
    Hls.DefaultConfig.loader = createGmLoaderClass();
    runPlayer();
}); } else if (mode === 'options') { whenDocumentReady(() => {
    mountPage(OPTIONS_HTML, OPTIONS_CSS);
    runOptions();
}); } else { activateEntry(); }

function activateEntry() {
    if (mode === 'player' || mode === 'options' || !siteAllowed(location.href) || entryActivated) { return; }
    entryActivated = true;
    window.__embyMultiWindowPrepareWindow = newWindow => prepareWindow(newWindow);
    window.addEventListener('message', event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || !data ||
            data.source !== 'emby-multiwindow-page' || data.type !== 'ADD_VIDEO' || !data.payload) { return; }
        try {
            queuePayload(data.payload);
            window.postMessage({source: 'emby-multiwindow-extension', type: 'ADD_VIDEO_RESULT',
                requestId: data.payload.requestId, ok: true}, location.origin);
        } catch (error) {
            window.postMessage({source: 'emby-multiwindow-extension', type: 'ADD_VIDEO_RESULT',
                requestId: data.payload.requestId, ok: false, error: error.message}, location.origin);
        }
    });
    GM_addStyle(ENTRY_CSS);
    runEntry();
}
