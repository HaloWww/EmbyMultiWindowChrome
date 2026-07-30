'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sessionData = {};
const syncData = {};
const windows = new Map();
const listeners = {};
let nextWindowId = 100;
let injectedScripts = 0;

function storageArea(data) {
    return {
        async get(query) {
            if (query === null) {
                return Object.assign({}, data);
            }
            if (typeof query === 'string') {
                return {[query]: data[query]};
            }
            const result = {};
            Object.keys(query || {}).forEach(key => {
                result[key] = Object.prototype.hasOwnProperty.call(data, key) ?
                    data[key] : query[key];
            });
            return result;
        },
        async set(values) {
            Object.assign(data, values);
        },
        async remove(keys) {
            (Array.isArray(keys) ? keys : [keys]).forEach(key => delete data[key]);
        }
    };
}

const chrome = {
    runtime: {
        getURL(file) {
            return `chrome-extension://test/${file}`;
        },
        sendMessage() {
            return Promise.resolve();
        },
        onMessage: {
            addListener(listener) {
                listeners.message = listener;
            }
        }
    },
    storage: {
        session: storageArea(sessionData),
        sync: storageArea(syncData)
    },
    scripting: {
        async insertCSS() {},
        async executeScript() {
            injectedScripts += 1;
        }
    },
    windows: {
        WINDOW_ID_NONE: -1,
        async create(options) {
            const result = Object.assign({id: nextWindowId++}, options);
            windows.set(result.id, result);
            return result;
        },
        async get(id) {
            if (!windows.has(id)) {
                throw new Error('window not found');
            }
            return windows.get(id);
        },
        async update(id, changes) {
            Object.assign(windows.get(id), changes);
            return windows.get(id);
        },
        onFocusChanged: {
            addListener(listener) {
                listeners.focus = listener;
            }
        },
        onBoundsChanged: {
            addListener(listener) {
                listeners.bounds = listener;
            }
        },
        onRemoved: {
            addListener(listener) {
                listeners.removed = listener;
            }
        }
    }
};

const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
vm.runInNewContext(source, {
    chrome,
    fetch: async () => ({ok: true}),
    Promise,
    Number,
    Array,
    Object,
    Set,
    URL,
    console
});

function send(message, sender) {
    return new Promise((resolve, reject) => {
        const keepChannel = listeners.message(message, sender || {}, response => {
            if (response && response.ok) {
                resolve(response);
            } else {
                reject(new Error(response && response.error || 'message failed'));
            }
        });
        if (!keepChannel) {
            reject(new Error('message channel was not kept open'));
        }
    });
}

(async function () {
    const localInit = await send({
        type: 'EMBY_MULTIWINDOW_INIT',
        url: 'http://localhost:8096/web/index.html'
    }, {tab: {id: 9}});
    if (!localInit.enabled || injectedScripts !== 1) {
        throw new Error('default localhost site was not injected');
    }
    const blockedInit = await send({
        type: 'EMBY_MULTIWINDOW_INIT',
        url: 'http://192.168.8.8:8096/web/index.html'
    }, {tab: {id: 10}});
    if (blockedInit.enabled || injectedScripts !== 1) {
        throw new Error('unconfigured site was injected');
    }
    syncData.allowedSites = ['http://192.168.8.8:8096'];
    const customInit = await send({
        type: 'EMBY_MULTIWINDOW_INIT',
        url: 'http://192.168.8.8:8096/web/index.html'
    }, {tab: {id: 10}});
    if (!customInit.enabled || injectedScripts !== 2) {
        throw new Error('custom site was not injected');
    }
    await send({
        type: 'EMBY_MULTIWINDOW_ADD',
        payload: {requestId: 'first'}
    });
    const firstEnvelope = sessionData['embyMultiWindow.pending.first'];
    if (!firstEnvelope || firstEnvelope.targetWindowId !== 100) {
        throw new Error('first video was not routed to the first window');
    }

    const second = await send({type: 'EMBY_MULTIWINDOW_NEW_PLAYER'});
    if (second.windowId !== 101) {
        throw new Error('second player window was not created');
    }
    await send({
        type: 'EMBY_MULTIWINDOW_ADD',
        payload: {requestId: 'second'}
    });
    const secondEnvelope = sessionData['embyMultiWindow.pending.second'];
    if (!secondEnvelope || secondEnvelope.targetWindowId !== 101) {
        throw new Error('video was not routed to the newest window');
    }

    await listeners.focus(100);
    await send({
        type: 'EMBY_MULTIWINDOW_ADD',
        payload: {requestId: 'refocused'}
    });
    const refocused = sessionData['embyMultiWindow.pending.refocused'];
    if (!refocused || refocused.targetWindowId !== 100) {
        throw new Error('video was not routed to the last focused player window');
    }
    await send({
        type: 'EMBY_MULTIWINDOW_ADD',
        payload: {requestId: 'forced-new', openInNewWindow: true}
    });
    const forcedNew = sessionData['embyMultiWindow.pending.forced-new'];
    if (!forcedNew || forcedNew.targetWindowId !== 102) {
        throw new Error('Shift-add did not create and target a new player window');
    }
    console.log('Multi-window background smoke test: OK');
})();
