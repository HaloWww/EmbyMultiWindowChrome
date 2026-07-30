'use strict';

var PLAYER_WINDOWS_KEY = 'embyMultiWindow.playerWindowIds';
var ACTIVE_WINDOW_KEY = 'embyMultiWindow.activePlayerWindowId';
var PENDING_PREFIX = 'embyMultiWindow.pending.';
var DEFAULT_ALLOWED_SITES = [
    'http://localhost',
    'https://localhost',
    'http://127.0.0.1',
    'https://127.0.0.1'
];
var creatingPlayerWindow = null;

function pendingKey(requestId) {
    return PENDING_PREFIX + requestId;
}

async function getWindowState() {
    var data = await chrome.storage.session.get({
        [PLAYER_WINDOWS_KEY]: [],
        [ACTIVE_WINDOW_KEY]: null
    });
    return {
        ids: (Array.isArray(data[PLAYER_WINDOWS_KEY]) ?
            data[PLAYER_WINDOWS_KEY] : []).map(Number).filter(Boolean),
        activeId: Number(data[ACTIVE_WINDOW_KEY]) || null
    };
}

async function saveWindowState(ids, activeId) {
    await chrome.storage.session.set({
        [PLAYER_WINDOWS_KEY]: Array.from(new Set(ids)),
        [ACTIVE_WINDOW_KEY]: activeId || null
    });
}

async function getExistingPlayerWindow() {
    var state = await getWindowState();
    var orderedIds = state.activeId ?
        [state.activeId].concat(state.ids.filter(function (id) {
            return id !== state.activeId;
        })) :
        state.ids.slice().reverse();
    var validIds = [];
    var selected = null;
    for (var i = 0; i < orderedIds.length; i += 1) {
        try {
            var playerWindow = await chrome.windows.get(orderedIds[i]);
            validIds.push(playerWindow.id);
            if (!selected) {
                selected = playerWindow;
            }
        } catch (error) {}
    }
    // Preserve creation order while removing windows Chrome no longer knows.
    validIds = state.ids.filter(function (id) {
        return validIds.includes(id);
    });
    await saveWindowState(validIds, selected && selected.id);
    return selected;
}

async function createPlayerWindow() {
    var settings = await chrome.storage.sync.get({
        windowWidth: 1100,
        windowHeight: 720
    });
    var playerWindow = await chrome.windows.create({
        url: chrome.runtime.getURL('player.html'),
        type: 'popup',
        focused: true,
        width: Math.max(360, Number(settings.windowWidth) || 1100),
        height: Math.max(240, Number(settings.windowHeight) || 720)
    });
    if (!playerWindow || playerWindow.id == null) {
        throw new Error('Chrome 没有创建多画面窗口。');
    }
    var state = await getWindowState();
    state.ids.push(playerWindow.id);
    await saveWindowState(state.ids, playerWindow.id);
    return playerWindow;
}

async function ensurePlayerWindow() {
    var existing = await getExistingPlayerWindow();
    if (existing) {
        await chrome.windows.update(existing.id, {focused: true});
        return existing;
    }
    if (!creatingPlayerWindow) {
        creatingPlayerWindow = createPlayerWindow().finally(function () {
            creatingPlayerWindow = null;
        });
    }
    return creatingPlayerWindow;
}

async function queueVideo(payload) {
    var targetWindow = payload.openInNewWindow ?
        await createPlayerWindow() :
        await ensurePlayerWindow();
    var requestId = payload.requestId;
    await chrome.storage.session.set({
        [pendingKey(requestId)]: {
            targetWindowId: targetWindow.id,
            payload: payload
        }
    });
    chrome.runtime.sendMessage({
        type: 'EMBY_MULTIWINDOW_QUEUE_UPDATED',
        requestId: requestId,
        targetWindowId: targetWindow.id
    }).catch(function () {});
}

function siteMatches(pageUrl, configuredSite) {
    try {
        var page = new URL(pageUrl);
        var site = new URL(configuredSite);
        var hostnameMatches = site.hostname.indexOf('*.') === 0 ?
            (page.hostname === site.hostname.slice(2) ||
                page.hostname.endsWith('.' + site.hostname.slice(2))) :
            page.hostname === site.hostname;
        return page.protocol === site.protocol &&
            hostnameMatches &&
            (!site.port || page.port === site.port);
    } catch (error) {
        return false;
    }
}

async function isAllowedEmbySite(pageUrl) {
    var settings = await chrome.storage.sync.get({
        allowedSites: DEFAULT_ALLOWED_SITES
    });
    var sites = Array.isArray(settings.allowedSites) ?
        settings.allowedSites : DEFAULT_ALLOWED_SITES;
    return sites.some(function (site) {
        return siteMatches(pageUrl, site);
    });
}

async function initializeEmbyPage(sender, pageUrl) {
    if (!sender.tab || sender.tab.id == null ||
        !await isAllowedEmbySite(pageUrl || sender.url)) {
        return false;
    }
    await chrome.scripting.insertCSS({
        target: {tabId: sender.tab.id},
        files: ['emby-entry.css']
    });
    await chrome.scripting.executeScript({
        target: {tabId: sender.tab.id},
        world: 'MAIN',
        files: ['emby-entry.js']
    });
    return true;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) {
        return false;
    }
    if (message.type === 'EMBY_MULTIWINDOW_INIT') {
        initializeEmbyPage(sender, message.url).then(function (enabled) {
            sendResponse({ok: true, enabled: enabled});
        }).catch(function (error) {
            sendResponse({
                ok: false,
                enabled: false,
                error: error && error.message ? error.message : '无法注入 Emby 页面功能。'
            });
        });
        return true;
    }
    if (message.type === 'EMBY_MULTIWINDOW_ADD' && message.payload) {
        queueVideo(message.payload).then(function () {
            sendResponse({ok: true});
        }).catch(function (error) {
            sendResponse({
                ok: false,
                error: error && error.message ? error.message : '无法打开多画面窗口。'
            });
        });
        return true;
    }
    if (message.type === 'EMBY_MULTIWINDOW_NEW_PLAYER') {
        createPlayerWindow().then(function (playerWindow) {
            sendResponse({ok: true, windowId: playerWindow.id});
        }).catch(function (error) {
            sendResponse({
                ok: false,
                error: error && error.message ? error.message : '无法创建新的播放窗口。'
            });
        });
        return true;
    }
    return false;
});

chrome.windows.onFocusChanged.addListener(async function (windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        return;
    }
    var state = await getWindowState();
    if (state.ids.includes(windowId)) {
        await saveWindowState(state.ids, windowId);
    }
});

chrome.windows.onBoundsChanged.addListener(async function (windowInfo) {
    var state = await getWindowState();
    if (state.ids.includes(windowInfo.id) && windowInfo.width && windowInfo.height) {
        await chrome.storage.sync.set({
            windowWidth: windowInfo.width,
            windowHeight: windowInfo.height
        });
    }
});

chrome.windows.onRemoved.addListener(async function (windowId) {
    var state = await getWindowState();
    if (!state.ids.includes(windowId)) {
        return;
    }
    var remaining = state.ids.filter(function (id) {
        return id !== windowId;
    });
    var nextActive = state.activeId === windowId ?
        (remaining[remaining.length - 1] || null) : state.activeId;
    await saveWindowState(remaining, nextActive);

    var pending = await chrome.storage.session.get(null);
    var pendingKeys = Object.keys(pending).filter(function (key) {
        var envelope = pending[key];
        return key.indexOf(PENDING_PREFIX) === 0 &&
            envelope && envelope.targetWindowId === windowId;
    });
    await Promise.allSettled(pendingKeys.map(function (key) {
        var envelope = pending[key];
        var payload = envelope && envelope.payload;
        var url = payload && payload.endpoints && payload.endpoints.stopEncoding;
        return url ? fetch(url, {method: 'POST'}).catch(function () {}) :
            Promise.resolve();
    }));
    if (pendingKeys.length) {
        await chrome.storage.session.remove(pendingKeys);
    }
});
