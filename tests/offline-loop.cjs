'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const fixture = process.env.EMBY_TEST_FIXTURE || fs.mkdtempSync(path.join(os.tmpdir(), 'emby-real-media-'));
function ffmpeg(args) {
    const result = spawnSync(process.env.EMBY_TEST_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args],
        {windowsHide: true, encoding: 'utf8', cwd: path.dirname(args[args.length - 1])});
    if (result.error) { throw result.error; }
    assert.equal(result.status, 0, result.stderr);
}
if (!process.env.EMBY_TEST_FIXTURE) {
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '180', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-g', '72', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path.join(fixture, 'original.mp4')]);
for (const kind of ['ts', 'fmp4']) {
    fs.mkdirSync(path.join(fixture, kind));
    ffmpeg(['-i', path.join(fixture, 'original.mp4'), '-c', 'copy', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_segment_type', kind === 'ts' ? 'mpegts' : 'fmp4',
        '-hls_segment_filename', path.join(fixture, kind, '%03d.' + (kind === 'ts' ? 'ts' : 'm4s')),
        path.join(fixture, kind, 'main.m3u8')]);
}
}
if (!fs.existsSync(path.join(fixture, 'aes'))) {
    fs.mkdirSync(path.join(fixture, 'aes'));
    const keyFile = path.join(fixture, 'aes', 'key.bin');
    fs.writeFileSync(keyFile, require('node:crypto').randomBytes(16));
    const keyInfo = path.join(fixture, 'aes', 'key-info.txt');
    fs.writeFileSync(keyInfo, 'key.bin\n' + keyFile.replace(/\\/g, '/') + '\n');
    ffmpeg(['-i', path.join(fixture, 'original.mp4'), '-c', 'copy', '-hls_time', '6', '-hls_list_size', '0',
        '-hls_key_info_file', keyInfo, '-hls_segment_filename', path.join(fixture, 'aes', '%03d.ts'),
        path.join(fixture, 'aes', 'main.m3u8')]);
}
const requests = [];
const stopped = new Set();
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const session = url.searchParams.get('PlaySessionId');
    requests.push({path: url.pathname, method: req.method, session, stopped: stopped.has(session)});
    if (url.pathname === '/stop') {
        stopped.add(session); res.end(); return;
    }
    if (url.pathname === '/segments') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([{id: 'late', name: '晚起点长片段', startMs: 80000, endMs: 102000}])); return;
    }
    if (url.pathname === '/thumbnails') { res.end('{"Thumbnails":[]}'); return; }
    if (req.method === 'POST') { res.end('{"ok":true}'); return; }
    if (url.pathname.startsWith('/hls/') && stopped.has(session)) { res.writeHead(404); res.end('deleted'); return; }
    let file;
    if (url.pathname.startsWith('/hls/')) { file = path.join(fixture, url.pathname.slice(5)); }
    else if (url.pathname === '/original.mp4') { file = path.join(fixture, 'original.mp4'); }
    else if (url.pathname === '/userscript-host') {
        res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head></head><body>Host</body></html>'); return;
    } else { file = path.join(root, url.pathname.slice(1)); }
    if (!file.startsWith(root + path.sep) && !file.startsWith(fixture + path.sep)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const type = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.m3u8': 'application/vnd.apple.mpegurl',
        '.mp4': 'video/mp4', '.m4s': 'video/mp4', '.ts': 'video/mp2t'}[path.extname(file)] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    const length = fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), length - 1) : length - 1;
        res.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1});
        fs.createReadStream(file, {start, end}).pipe(res);
    } else { res.setHeader('Content-Length', length); fs.createReadStream(file).pipe(res); }
});

function extensionShim() {
    const callbacks = [];
    window.chrome = {windows: {getCurrent: async () => ({id: 1})}, runtime: {
        getURL: value => new URL(value, location.href).href, getManifest: () => ({version: 'test'}),
        onMessage: {addListener() {}}, sendMessage: async () => ({ok: true})
    }, storage: {sync: {get: async defaults => defaults, set: async () => {}},
        session: {get: async () => ({}), remove: async () => {}},
        onChanged: {addListener: callback => callbacks.push(callback)}}};
    window.__settingsChanged = value => callbacks.forEach(callback => callback({mediaCacheMode: {newValue: value}}, 'sync'));
}
function gmShim() {
    const store = new Map(), watchers = new Map();
    window.unsafeWindow = window;
    window.GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
    window.GM_setValue = (key, value) => {
        const old = store.get(key); store.set(key, value);
        (watchers.get(key) || []).forEach(callback => callback(key, old, value, false));
    };
    window.GM_deleteValue = key => store.delete(key);
    window.GM_listValues = () => [...store.keys()];
    window.GM_addValueChangeListener = (key, callback) => watchers.set(key, [...(watchers.get(key) || []), callback]);
    window.GM_registerMenuCommand = () => {};
    window.GM_addStyle = css => { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); };
    const nativeFetch = window.fetch.bind(window);
    window.GM_xmlhttpRequest = options => {
        const controller = new AbortController();
        nativeFetch(options.url, {method: options.method, headers: options.headers, body: options.data, signal: controller.signal})
            .then(async response => options.onload({status: response.status, finalUrl: response.url, response: await response.arrayBuffer()}))
            .catch(error => error.name === 'AbortError' ? options.onabort?.() : options.onerror?.());
        return {abort: () => controller.abort()};
    };
}

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({executablePath: process.env.EMBY_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    const results = [];
    try {
        const cases = [['ts', false, 4], ['fmp4', false, 1], ['aes', false, 1], ['ts', true, 1]];
        for (const [kind, userscript, count] of cases.filter(entry => !process.env.EMBY_TEST_CASE ||
            process.env.EMBY_TEST_CASE === (entry[1] ? 'userscript' : entry[0]))) {
            console.log('Testing ' + kind + ', userscript=' + userscript + ', slots=' + count);
            const context = await browser.newContext();
            const diagnostics = [];
            await context.route('http://127.0.0.1:47831/**', route => {
                try { diagnostics.push(...JSON.parse(route.request().postData()).events); } catch (_) {}
                return route.fulfill({status: 200, body: '{"ok":true}'});
            });
            await context.addInitScript(userscript ? gmShim : extensionShim);
            if (userscript) { await context.addInitScript({path: path.join(root, 'dist', 'EmbyMultiWindow.user.js')}); }
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(base + (userscript ? '/userscript-host?embyMultiWindow=player&embyMultiWindowId=test&cacheTest=1' : '/player.html?cacheTest=1'), {waitUntil: 'commit'});
            try { await page.waitForFunction(() => window.__embyMultiWindowCacheTest, null, {timeout: 5000}); }
            catch (error) {
                console.log(JSON.stringify({errors, url: page.url(), content: (await page.content()).slice(0, 2000)}, null, 2));
                throw error;
            }
            await page.evaluate(async ({base, kind, count}) => {
                const api = window.__embyMultiWindowCacheTest;
                window.loopCounts = Array(count).fill(0);
                window.initialHits = [];
                for (let i = 0; i < count; i++) {
                    const cache = {url: base + `/hls/${kind}/main.m3u8?PlaySessionId=original-${i}`, isHls: true,
                        playSessionId: `original-${i}`, playMethod: 'Transcode'};
                    const direct = {url: base + '/original.mp4', isHls: false, playMethod: 'DirectPlay', playSessionId: `direct-${i}`};
                    await api.addPayload({requestId: `test-${i}`, item: {Id: `item-${i}`, Name: `真实媒体 ${i}`, RunTimeTicks: 1800000000},
                        mediaSource: {Id: `source-${i}`, RunTimeTicks: 1800000000}, stream: cache, cacheStream: cache, directStream: direct,
                        endpoints: {stopEncoding: base + `/stop?PlaySessionId=original-${i}`, segments: base + '/segments',
                            thumbnailSet: base + '/thumbnails', thumbnailImage: base + '/image', reportStart: base + '/start',
                            reportProgress: base + '/progress', reportStopped: base + '/stopped'}});
                    const slot = api.getSlots()[i];
                    slot.segmentSelect.value = 'late';
                    slot.segmentSelect.dispatchEvent(new Event('change'));
                }
            }, {base, kind, count});
            try {
                await page.waitForFunction(count => window.__embyMultiWindowCacheTest.getSlots().length === count &&
                    window.__embyMultiWindowCacheTest.getSlots().every(slot => slot.clipCacheReady && !slot.clipCacheLoading), count, {timeout: 30000});
            } catch (error) {
                console.log(JSON.stringify(await page.evaluate(() => window.__embyMultiWindowCacheTest.getSlots().map(slot => ({
                    status: slot.status.textContent, error: slot.lastHlsError, ready: slot.clipCacheReady,
                    loading: slot.clipCacheLoading, connected: slot.video.isConnected, documentState: document.readyState,
                    body: document.body && document.body.innerHTML.slice(0, 150),
                    currentTime: slot.video.currentTime, buffered: Array.from({length: slot.video.buffered.length}, (_, i) => [slot.video.buffered.start(i), slot.video.buffered.end(i)])
                }))), null, 2));
                console.log(JSON.stringify(diagnostics.filter(item => /error|failed|miss/.test(item.event)).slice(-8), null, 2));
                throw error;
            }
            const before = requests.length;
            await page.evaluate(() => window.__embyMultiWindowCacheTest.getSlots().forEach((slot, index) => {
                window.initialHits[index] = slot.cacheHits;
                slot.video.addEventListener('seeked', () => { if (Math.abs(slot.video.currentTime - 80) < 1) { window.loopCounts[index]++; } });
                slot.video.playbackRate = 8;
            }));
            await page.waitForFunction(() => window.loopCounts.every(count => count >= 6), null, {timeout: 60000});
            const state = await page.evaluate(() => window.__embyMultiWindowCacheTest.getSlots().map((slot, index) => ({
                loops: window.loopCounts[index], cacheHits: slot.cacheHits, initialHits: window.initialHits[index],
                ready: slot.clipCacheReady, error: slot.lastHlsError, mediaError: slot.video.error && slot.video.error.code,
                timelineStart: slot.clipOfflinePlaylist.start, dimensions: [slot.video.videoWidth, slot.video.videoHeight],
                manifestLive: slot.hls.latestLevelDetails.live,
                audioBuffer: !!(slot.hls.bufferController.tracks.audio || slot.hls.bufferController.tracks.audiovideo)
            })));
            assert.ok(state.every(slot => slot.ready && !slot.mediaError && !(slot.error && slot.error.fatal) && slot.cacheHits > slot.initialHits &&
                slot.timelineStart > 0 && slot.dimensions[0] === 320 && !slot.manifestLive && slot.audioBuffer), JSON.stringify(state));
            const afterStopMediaRequests = requests.slice(before).filter(request => request.path.startsWith('/hls/'));
            assert.equal(afterStopMediaRequests.length, 0, JSON.stringify(afterStopMediaRequests));
            assert.deepEqual(errors, []);
            const seekTargets = await page.evaluate(() => {
                const slot = window.__embyMultiWindowCacheTest.getSlots()[0];
                const slider = slot.tile.querySelector('input[aria-label="播放进度"]');
                slider.value = '500'; slider.dispatchEvent(new Event('input'));
                const middle = slot.video.currentTime;
                slider.value = '1000'; slider.dispatchEvent(new Event('input'));
                return {middle, end: slot.video.currentTime};
            });
            assert.ok(Math.abs(seekTargets.middle - 90) < 0.1 && seekTargets.end < 102 && seekTargets.end >= 80,
                JSON.stringify(seekTargets));
            let missingResourceRecovered = false;
            if (count === 4) {
                const previousSession = await page.evaluate(() => {
                    const slot = window.__embyMultiWindowCacheTest.getSlots()[0];
                    slot.directStream = null;
                    slot.directPlaybackFailed = true;
                    slot.mediaCache.clear();
                    return slot.stream.playSessionId;
                });
                await page.waitForFunction(() => {
                    const slot = window.__embyMultiWindowCacheTest.getSlots()[0];
                    return !slot.clipOfflinePlaylist && slot.stream.isHls && !slot.switchingStream && slot.video.readyState >= 2;
                }, null, {timeout: 15000});
                assert.notEqual(await page.evaluate(() => window.__embyMultiWindowCacheTest.getSlots()[0].stream.playSessionId), previousSession);
                assert.equal(requests.slice(before).filter(request => request.path.startsWith('/hls/') && request.stopped).length, 0);
                missingResourceRecovered = true;
            }
            // Disabling cache must leave the local manifest and start a viable online stream.
            await page.evaluate(userscript => {
                if (userscript) { GM_setValue('embyMultiWindow.userscript.settings', {mediaCacheMode: 'off'}); }
                else { window.__settingsChanged('off'); }
            }, userscript);
            await page.waitForFunction(() => window.__embyMultiWindowCacheTest.getSlots().every(slot =>
                !slot.clipCacheReady && !slot.clipOfflinePlaylist && !slot.forceClipCache && slot.video.readyState >= 2));
            results.push({kind, userscript, state, mediaRequestsAfterReady: afterStopMediaRequests.length,
                missingResourceRecovered, disableCacheRecovered: true});
            await context.close();
        }
        console.log(JSON.stringify(results, null, 2));
        fs.writeFileSync(path.join(root, 'analysis', 'offline-loop-results.json'), JSON.stringify(results, null, 2) + '\n');
    } finally {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        // The generated fixture is deliberately retained in TEMP for failure inspection.
        console.log('Fixture: ' + fixture);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
