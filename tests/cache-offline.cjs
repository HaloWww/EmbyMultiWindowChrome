'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'player.js'), 'utf8');
const markers = [...source.matchAll(/^    (?:async )?function (\w+)\(/gm)];
const names = ['canonicalMediaUrl', 'mediaCacheKey', 'shouldCacheLoaderContext', 'createMemoryLoaderClass',
    'failOfflineLoad', 'parseMediaPlaylist', 'rewritePlaylistUris', 'playlistResource', 'clipPlanDependencies',
    'createOfflinePlaylist', 'fragmentMetadata', 'clipFragmentPlan', 'clipBufferSettings', 'createHlsConfig'];
const code = names.map(name => {
    const index = markers.findIndex(match => match[1] === name);
    assert.ok(index >= 0, name);
    let text = source.slice(markers[index].index, markers[index + 1].index);
    if (name === 'failOfflineLoad') { text = text.slice(0, text.indexOf('    if (new URLSearchParams')); }
    return text;
}).join('\n');
let networkLoads = 0, recoveries = 0;
class NetworkLoader {
    constructor() { this.stats = {loading: {}, loaded: 0, total: 0}; }
    load() { networkLoads++; throw new Error('Offline path attempted network'); }
    abort() {}
    destroy() {}
}
const sandbox = {URL, ArrayBuffer, Map, Set, Number, Math, performance, queueMicrotask,
    location: {href: 'https://emby.example/web/index.html'}, console: {warn() {}},
    Hls: {DefaultConfig: {loader: NetworkLoader}}, chrome: {runtime: {getURL: name => name}},
    MSE_TARGET_BUFFER_BYTES: 48 * 1024 * 1024, diagnosticSafeUrl: value => value,
    diagnosticSlotState: () => ({}), diagnosticLog() {}, setPlaybackStatus() {},
    restoreOnlinePlayback: async () => { recoveries++; }};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
(async () => {
    const details = sandbox.parseMediaPlaylist([
        '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:10',
        '#EXT-X-DISCONTINUITY-SEQUENCE:2',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000001',
        '#EXT-X-MAP:URI="init.mp4",BYTERANGE="32@4"',
        '#EXTINF:6,', '#EXT-X-BYTERANGE:64@100', 'media.mp4', '#EXT-X-DISCONTINUITY',
        '#EXTINF:6,', '#EXT-X-BYTERANGE:64@164', 'media.mp4', '#EXT-X-ENDLIST'
    ].join('\n'), 'https://emby.example/hls/main.m3u8');
    const plan = sandbox.clipFragmentPlan({}, {startMs: 6000, endMs: 10000}, details, {start: 6, end: 12});
    const deps = sandbox.clipPlanDependencies(plan);
    assert.equal(deps.length, 2);
    assert.ok(deps.some(entry => entry.resourceType === 'key'));
    assert.ok(deps.some(entry => entry.rangeStart === 4 && entry.rangeEnd === 36));
    const offline = sandbox.createOfflinePlaylist(plan, details, 'https://emby.example/hls/master.m3u8');
    assert.equal(offline.start, 6);
    assert.match(offline.text, /#EXT-X-MEDIA-SEQUENCE:11/);
    assert.match(offline.text, /#EXT-X-DISCONTINUITY-SEQUENCE:3/);
    assert.match(offline.text, /#EXT-X-ENDLIST/);
    assert.match(offline.text, /#EXT-X-BYTERANGE:64@164/);
    assert.ok(!offline.text.includes('#EXT-X-BYTERANGE:64@100'));
    assert.match(offline.text, /URI="https:\/\/emby.example\/hls\/init.mp4"/);
    const slot = {mediaCacheEnabled: true, clipCacheReady: true, clipOfflinePlaylist: offline,
        mediaCache: new Map(), status: {}, stopped: false};
    const master = new Uint8Array([1, 2, 3, 4]).buffer;
    const segmentContext = {url: plan[0].url, responseType: 'arraybuffer', frag: {}, rangeStart: 164, rangeEnd: 228};
    slot.mediaCache.set(sandbox.mediaCacheKey(segmentContext), {data: master, size: 4});
    for (const dep of deps) {
        slot.mediaCache.set(dep.key, {data: new Uint8Array(dep.resourceType === 'key' ? 16 : 32).buffer, size: dep.resourceType === 'key' ? 16 : 32});
    }
    const Loader = sandbox.createMemoryLoaderClass(slot);
    const load = context => new Promise(resolve => new Loader({}).load(context, {}, {
        onSuccess: response => resolve({ok: true, response}), onError: error => resolve({ok: false, error})
    }));
    const manifest = await load({url: offline.url, responseType: 'text'});
    assert.equal(manifest.response.data, offline.text);
    const hit = await load(segmentContext);
    structuredClone(hit.response.data, {transfer: [hit.response.data]});
    assert.equal(master.byteLength, 4);
    assert.equal((await load(segmentContext)).response.data.byteLength, 4);
    const key = await load({url: deps.find(entry => entry.resourceType === 'key').url, responseType: 'arraybuffer', keyInfo: {}});
    assert.equal(key.response.data.byteLength, 16);
    const missing = await load({url: 'https://emby.example/absent.ts', responseType: 'arraybuffer', frag: {}});
    assert.equal(missing.ok, false);
    assert.equal(networkLoads, 0);
    assert.equal(recoveries, 1);
    const config = sandbox.createHlsConfig({forceClipCache: true, mediaCacheEnabled: true,
        clipOfflinePlaylist: offline, activeSegment: {startMs: 6000, endMs: 10000}}, 6);
    assert.equal(config.timelineOffset, 6);
    assert.throws(() => sandbox.parseMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:6,\nx.ts', 'https://emby.example/main.m3u8'));
    console.log('Offline cache resource/timeline/regression tests: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
