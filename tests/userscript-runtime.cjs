'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const runtime = fs.readFileSync(path.join(__dirname, '..', 'userscript', 'runtime.js'), 'utf8');
const values = new Map(), watchers = new Map();
function createContext(href) {
    const opened = [], messages = [], pageListeners = new Map();
    const document = {readyState: 'complete', documentElement: {replaceWith() {}}, importNode: node => node};
    const window = {document, stop() {}, addEventListener: (name, callback) => {
        pageListeners.set(name, [...(pageListeners.get(name) || []), callback]);
    }, postMessage: data => messages.push(data), outerWidth: 1100, outerHeight: 720,
        open(url) { const popup = {url, closed: false, focus() {}}; opened.push(popup); return popup; }, focus() {}};
    const location = new URL(href);
    location.reload = () => {};
    const sandbox = {window, document, location, URL, Map, Set, Date, JSON, Object, Promise,
        Headers, Response, ArrayBuffer, AbortController, DOMException, performance, Blob,
        // HTTP LAN pages expose getRandomValues but have no native randomUUID at document-start.
        crypto: {getRandomValues: webcrypto.getRandomValues.bind(webcrypto)}, WORKER_SOURCE: '', PLAYER_HTML: '', PLAYER_CSS: '', OPTIONS_HTML: '',
        OPTIONS_CSS: '', ENTRY_CSS: '', Hls: {DefaultConfig: {}},
        DOMParser: class { parseFromString() { return {documentElement: {}}; } },
        MutationObserver: class { observe() {} disconnect() {} },
        setInterval: () => 1, clearInterval() {},
        GM_getValue: (key, fallback) => values.has(key) ? structuredClone(values.get(key)) : fallback,
        GM_setValue: (key, value) => {
            const old = values.get(key); values.set(key, structuredClone(value));
            for (const callback of watchers.get(key) || []) { callback(key, old, value, true); }
        },
        GM_deleteValue: key => values.delete(key), GM_listValues: () => [...values.keys()],
        GM_addValueChangeListener: (key, callback) => watchers.set(key, [...(watchers.get(key) || []), callback]),
        GM_addStyle() {}, GM_registerMenuCommand() {}, GM_xmlhttpRequest() { throw new Error('Unexpected network'); },
        runPlayer() {}, runOptions() {}, entryStarts: 0, runEntry() { sandbox.entryStarts++; }};
    vm.createContext(sandbox);
    vm.runInContext(runtime, sandbox);
    return {sandbox, opened, messages, pageListeners};
}
(async () => {
    const entry = createContext('http://127.0.0.1/web/index.html');
    const target = entry.sandbox.window.__embyMultiWindowPrepareWindow(false);
    assert.equal(entry.opened.length, 1);
    const player = createContext(entry.opened[0].url);
    assert.equal(await vm.runInContext('chrome.windows.getCurrent()', player.sandbox).then(value => value.id), target);
    const notifications = [];
    player.sandbox.notifications = notifications;
    vm.runInContext('chrome.runtime.onMessage.addListener(message => notifications.push(message))', player.sandbox);
    const reused = entry.sandbox.window.__embyMultiWindowPrepareWindow(false);
    assert.equal(reused, target);
    assert.equal(entry.opened.length, 1, 'Adding to active window must not reopen or navigate it');
    for (const requestId of ['one', 'two']) {
        const payload = {requestId, targetPlayerId: target, item: {Id: requestId}};
        const event = {source: entry.sandbox.window, origin: 'http://127.0.0.1',
            data: {source: 'emby-multiwindow-page', type: 'ADD_VIDEO', payload}};
        entry.pageListeners.get('message').forEach(callback => callback(event));
    }
    assert.equal(notifications.length, 2);
    const queue = await vm.runInContext('chrome.storage.session.get(null)', player.sandbox);
    assert.equal(Object.keys(queue).length, 2);
    assert.ok(Object.values(queue).every(envelope => envelope.targetWindowId === target));
    await vm.runInContext('chrome.storage.session.remove("embyMultiWindow.pending.one")', player.sandbox);
    assert.equal(Object.keys(await vm.runInContext('chrome.storage.session.get(null)', player.sandbox)).length, 1);
    assert.ok(!values.has('embyMultiWindow.userscript.request.embyMultiWindow.pending.one'));
    const anotherTab = createContext('http://127.0.0.1/web/index.html');
    assert.equal(anotherTab.sandbox.window.__embyMultiWindowPrepareWindow(false), target);
    assert.equal(anotherTab.opened.length, 0, 'Another tab should signal existing player rather than duplicate its ID');
    values.set('embyMultiWindow.userscript.settings', {allowedSites: ['http://127.0.0.1', 'https://other-emby.example']});
    const anotherServer = createContext('https://other-emby.example/web/index.html');
    assert.equal(anotherServer.sandbox.window.__embyMultiWindowPrepareWindow(false), target);
    assert.equal(anotherServer.opened.length, 0, 'GM routing should reuse the player across configured Emby servers');
    const newTarget = anotherTab.sandbox.window.__embyMultiWindowPrepareWindow(true);
    assert.notEqual(newTarget, target);
    assert.equal(anotherTab.opened.length, 1);
    assert.equal(vm.runInContext('siteAllowed("https://unconfigured.example")', entry.sandbox), false);
    const blocked = createContext('http://192.168.8.10:8096/web/index.html');
    assert.equal(blocked.sandbox.entryStarts, 0);
    await vm.runInContext('chrome.storage.sync.set({allowedSites: ["http://127.0.0.1", "http://192.168.8.10:8096"]})', anotherTab.sandbox);
    assert.equal(blocked.sandbox.entryStarts, 1, 'Saving the site should activate already open tabs');
    await vm.runInContext('chrome.storage.sync.set({allowedSites: ["http://192.168.8.10:8096"]})', anotherTab.sandbox);
    assert.equal(blocked.sandbox.entryStarts, 1, 'Settings updates must not duplicate the bridge');
    values.delete('embyMultiWindow.userscript.settings');
    const lan = createContext('http://192.168.8.10:8096/web/index.html');
    assert.equal(lan.sandbox.entryStarts, 1, 'The requested LAN server should be enabled by default');
    assert.equal(vm.runInContext('siteAllowed("http://192.168.8.10:8097")', lan.sandbox), false);
    console.log('Userscript popup reuse, concurrent queue, consume and cross-tab routing tests: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
