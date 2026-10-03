'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const {chromium} = require('playwright');

(async function () {
    const extensionPath = path.resolve(
        process.env.EMBY_EXTENSION_PATH || path.resolve(__dirname, '..')
    );
    const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-multiwindow-'));
    const browserPath = process.env.EMBY_TEST_BROWSER ||
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const context = await chromium.launchPersistentContext(profilePath, {
        executablePath: browserPath,
        // Chrome does not load unpacked MV3 extensions in its headless shell.
        // This uses a disposable headed profile and closes it automatically.
        headless: process.env.EMBY_TEST_HEADLESS === '1',
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`
        ]
    });
    const failures = [];
    await context.route('http://127.0.0.1:47831/**', route =>
        route.fulfill({status: 200, contentType: 'application/json', body: '{"ok":true}'}));
    let extensionRuntimeDetected = false;
    try {
        const extensionsPage = await context.newPage();
        await extensionsPage.goto('chrome://extensions/');
        await extensionsPage.waitForTimeout(700);
        const extensionId = await extensionsPage.evaluate(() => {
            const manager = document.querySelector('extensions-manager');
            const list = manager && manager.shadowRoot &&
                manager.shadowRoot.querySelector('extensions-item-list');
            const items = list && list.shadowRoot ?
                Array.from(list.shadowRoot.querySelectorAll('extensions-item')) : [];
            const target = items.find(item => {
                if (item.data && item.data.name === 'Emby Multi Window') {
                    return true;
                }
                const name = item.shadowRoot && item.shadowRoot.querySelector('#name');
                return name && name.textContent.trim() === 'Emby Multi Window';
            });
            return target && ((target.data && target.data.id) ||
                target.getAttribute('id') ||
                target.getAttribute('extension-id') ||
                target.dataset.extensionId);
        });
        extensionRuntimeDetected = !!extensionId;
        await extensionsPage.close();
        if (!extensionId) {
            // Current branded Chrome/Edge releases may ignore --load-extension
            // in automated profiles. Keep a UI/runtime smoke path available
            // without installing anything into the user's normal browser.
            await context.addInitScript(() => {
                const changed = {addListener() {}};
                const makePayload = (id, name) => ({
                    requestId: id,
                    item: {
                        Id: id,
                        Name: name,
                        Type: 'Movie',
                        MediaType: 'Video',
                        RunTimeTicks: 24000000000,
                        Chapters: []
                    },
                    mediaSource: {Id: `source-${id}`, RunTimeTicks: 24000000000},
                    stream: {
                        url: 'data:video/mp4;base64,Q0FDSEU=',
                        playMethod: 'Transcode',
                        playSessionId: `session-${id}`,
                        isHls: false
                    },
                    directStream: {
                        url: 'data:video/mp4;base64,RElSRUNU',
                        playMethod: 'DirectPlay',
                        playSessionId: `session-${id}`,
                        isHls: false
                    },
                    cacheStream: {
                        url: 'data:video/mp4;base64,Q0FDSEU=',
                        playMethod: 'Transcode',
                        playSessionId: `session-${id}`,
                        isHls: false
                    },
                    fallbackStream: null,
                    startPositionTicks: 0,
                    localSegments: [{
                        id: 'segment-1',
                        name: '精彩片段',
                        startMs: 1000,
                        endMs: 5000,
                        order: 1
                    }],
                    endpoints: {
                        reportStart: 'data:text/plain,',
                        reportProgress: 'data:text/plain,',
                        reportStopped: 'data:text/plain,',
                        stopEncoding: 'data:text/plain,',
                        segments: 'data:application/json,%7B',
                        thumbnailSet: 'data:application/json,%7B%22Thumbnails%22%3A%5B%5D%7D',
                        thumbnailImage: 'data:image/png;base64,'
                    }
                });
                const sessionSeed = {
                    'embyMultiWindow.pending.smoke-1': {
                        targetWindowId: 1,
                        payload: makePayload('smoke-1', '第一画面')
                    },
                    'embyMultiWindow.pending.smoke-2': {
                        targetWindowId: 1,
                        payload: makePayload('smoke-2', '第二画面')
                    }
                };
                const makeArea = initial => {
                    const data = Object.assign({}, initial);
                    return {
                    get(values) {
                        if (values === null) {
                            return Promise.resolve(Object.assign({}, data));
                        }
                        return Promise.resolve(Object.assign({}, values, data));
                    },
                    set(values) {
                        Object.assign(data, values);
                        return Promise.resolve();
                    },
                    remove(keys) {
                        (Array.isArray(keys) ? keys : [keys]).forEach(key => delete data[key]);
                        return Promise.resolve();
                    }
                    };
                };
                HTMLMediaElement.prototype.play = function () {
                    return Promise.resolve();
                };
                HTMLMediaElement.prototype.pause = function () {};
                HTMLMediaElement.prototype.load = function () {};
                window.chrome = {
                    runtime: {
                        onMessage: changed,
                        getURL(relativePath) {
                            return new URL(relativePath, location.href).href;
                        },
                        sendMessage() {
                            return Promise.resolve({ok: true, windowId: 2});
                        }
                    },
                    windows: {
                        getCurrent() {
                            return Promise.resolve({id: 1});
                        }
                    },
                    storage: {
                        sync: makeArea({
                            previewWidth: 280,
                            controlsIdleSeconds: 2.5
                        }),
                        session: makeArea(sessionSeed),
                        onChanged: changed
                    }
                };
            });
        }
        for (const pageName of ['player.html', 'options.html', 'tests/mock-emby.html']) {
            const page = await context.newPage();
            page.on('pageerror', error => failures.push(`${pageName}: ${error.message}`));
            page.on('console', message => {
                if (message.type() === 'error') {
                    failures.push(`${pageName}: ${message.text()}`);
                }
            });
            const targetUrl = extensionId ?
                `chrome-extension://${extensionId}/${pageName}` :
                pathToFileURL(path.join(extensionPath, pageName)).href;
            await page.goto(pageName === 'player.html' ?
                targetUrl + '?cacheTest=1' : targetUrl);
            await page.waitForTimeout(500);
            if (pageName === 'player.html') {
                await page.setViewportSize({width: 520, height: 360});
                const hlsVersion = await page.evaluate(() => Hls.version);
                if (hlsVersion !== '1.7.0-beta.2') {
                    failures.push(
                        `player.html: unexpected HLS.js version ${hlsVersion}`
                    );
                }
                if (extensionId) {
                    const workerResult = await page.evaluate(async () => {
                        const url = chrome.runtime.getURL('hls.worker.js');
                        const response = await fetch(url);
                        if (!response.ok) {
                            return `HTTP ${response.status}`;
                        }
                        return new Promise(resolve => {
                            const worker = new Worker(url);
                            let settled = false;
                            worker.onerror = event => {
                                if (!settled) {
                                    settled = true;
                                    worker.terminate();
                                    resolve(event.message || 'worker error');
                                }
                            };
                            setTimeout(() => {
                                if (!settled) {
                                    settled = true;
                                    worker.terminate();
                                    resolve('OK');
                                }
                            }, 250);
                        });
                    });
                    if (workerResult !== 'OK') {
                        failures.push(
                            `player.html: packaged HLS worker failed: ${workerResult}`
                        );
                    }
                }
                if (!await page.locator('#stage').isVisible()) {
                    failures.push('player.html: stage is not visible');
                }
                if (await page.locator('video[controls]').count()) {
                    failures.push('player.html: native video controls are enabled');
                }
                if (!await page.locator('#newWindow').isVisible()) {
                    failures.push('player.html: new-window control is not visible');
                }
                if ((await page.locator('#newWindow').textContent()).trim() !== '＋' ||
                    await page.locator('#newWindow').getAttribute('aria-label') !== '新建窗口') {
                    failures.push('player.html: compact new-window control has no accessible description');
                }
                const visibleTitles = await page.locator('.tile .title').allTextContents();
                const tileNames = await page.locator('.tile').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label')));
                if (JSON.stringify(visibleTitles) !== JSON.stringify(tileNames)) {
                    failures.push('player.html: per-video titles do not match the loaded movies');
                }
                if (await page.locator('#fullscreen').isVisible()) {
                    await page.locator('#fullscreen').click();
                    await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
                    await page.waitForFunction(() => document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'true');
                    if (await page.locator('#fullscreen').getAttribute('aria-pressed') !== 'true') {
                        failures.push('player.html: fullscreen control does not reflect fullscreen state');
                    }
                    await page.keyboard.press('f');
                    await page.waitForFunction(() => !document.fullscreenElement);
                    await page.waitForFunction(() => document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'false');
                    await page.waitForTimeout(250);
                }
                if (await page.locator('#playbackStrategy').count()) {
                    failures.push('player.html: obsolete playback strategy button still exists');
                }
                const cacheOverlayFollowsControls = await page.evaluate(async () => {
                    const stage = document.querySelector('#stage');
                    const status = document.createElement('div');
                    status.className = 'status';
                    status.dataset.phase = 'clip-cache';
                    status.textContent = '缓存进度';
                    stage.appendChild(status);
                    stage.classList.add('controls-hidden');
                    await new Promise(resolve => setTimeout(resolve, 220));
                    const style = getComputedStyle(status);
                    const result = style.opacity === '0' &&
                        style.pointerEvents === 'none';
                    status.remove();
                    stage.classList.remove('controls-hidden');
                    return result;
                });
                if (!cacheOverlayFollowsControls) {
                    failures.push(
                        'player.html: cache progress does not follow control visibility'
                    );
                }
                if (!extensionId) {
                    await page.waitForTimeout(250);
                    const cacheResult = await page.evaluate(async () => {
                        const api = window.__embyMultiWindowCacheTest;
                        const originalLoader = Hls.DefaultConfig.loader;
                        let networkLoads = 0;
                        function FakeLoader() {
                            this.stats = {
                                aborted: false,
                                loaded: 0,
                                total: 0,
                                loading: {start: 0, first: 0, end: 0}
                            };
                        }
                        FakeLoader.prototype.load = function (context, config, callbacks) {
                            networkLoads += 1;
                            const data = new Uint8Array([1, 2, 3, 4]).buffer;
                            callbacks.onSuccess({
                                url: context.url,
                                data,
                                code: 200
                            }, this.stats, context, null);
                        };
                        FakeLoader.prototype.abort = function () {};
                        FakeLoader.prototype.destroy = function () {};
                        Hls.DefaultConfig.loader = FakeLoader;
                        const slot = {
                            mediaCacheEnabled: true,
                            mediaCache: new Map(),
                            mediaCacheBytes: 0,
                            mediaCacheLimitBytes: 1024
                        };
                        const Loader = api.createLoaderClass(slot);
                        const context = {
                            url: 'https://example.invalid/segment-1.ts',
                            responseType: 'arraybuffer',
                            rangeStart: 0,
                            rangeEnd: 0,
                            frag: {}
                        };
                        function loadOnce() {
                            return new Promise((resolve, reject) => {
                                const loader = new Loader({});
                                loader.load(context, {}, {
                                    onSuccess(response) {
                                        loader.destroy();
                                        resolve(response.data);
                                    },
                                    onError(error) {
                                        reject(new Error(error.text || 'load failed'));
                                    }
                                });
                            });
                        }
                        const firstData = await loadOnce();
                        const firstSize = firstData.byteLength;
                        structuredClone(firstData, {transfer: [firstData]});
                        const secondData = await loadOnce();
                        const cachedData = slot.mediaCache.get(api.cacheKey(context)).data;
                        const bytesBeforeRelease = slot.mediaCacheBytes;
                        api.release(slot);
                        const pinnedSlot = {
                            mediaCache: new Map(),
                            mediaCacheBytes: 0,
                            mediaCacheLimitBytes: 6
                        };
                        api.put(
                            pinnedSlot,
                            'old',
                            new Uint8Array([1, 2, 3, 4]).buffer
                        );
                        const protectedKeys = new Set(['clip-1', 'clip-2']);
                        const firstPinned = api.put(
                            pinnedSlot,
                            'clip-1',
                            new Uint8Array([1, 2, 3, 4]).buffer,
                            null,
                            protectedKeys
                        );
                        const secondPinned = api.put(
                            pinnedSlot,
                            'clip-2',
                            new Uint8Array([1, 2, 3, 4]).buffer,
                            null,
                            protectedKeys
                        );
                        Hls.DefaultConfig.loader = originalLoader;
                        return {
                            firstSize,
                            secondSize: secondData.byteLength,
                            cacheMasterPreserved: firstData.byteLength === 0 &&
                                secondData !== cachedData &&
                                cachedData.byteLength === 4 &&
                                Array.from(new Uint8Array(secondData)).join(',') ===
                                    Array.from(new Uint8Array(cachedData)).join(','),
                            networkLoads,
                            bytesBeforeRelease,
                            bytesAfterRelease: slot.mediaCacheBytes,
                            entriesAfterRelease: slot.mediaCache.size,
                            firstPinned,
                            secondPinned,
                            pinnedEntries: Array.from(pinnedSlot.mediaCache.keys()),
                            pinnedBytes: pinnedSlot.mediaCacheBytes
                        };
                    });
                    if (cacheResult.networkLoads !== 1 ||
                        cacheResult.firstSize !== 4 ||
                        cacheResult.secondSize !== 4 ||
                        !cacheResult.cacheMasterPreserved ||
                        cacheResult.bytesBeforeRelease !== 4 ||
                        cacheResult.bytesAfterRelease !== 0 ||
                        cacheResult.entriesAfterRelease !== 0 ||
                        !cacheResult.firstPinned ||
                        cacheResult.secondPinned ||
                        cacheResult.pinnedEntries.join(',') !== 'clip-1' ||
                        cacheResult.pinnedBytes !== 4) {
                        failures.push('player.html: HLS memory cache lifecycle failed');
                    }
                    const clipCacheResult = await page.evaluate(async () => {
                        const api = window.__embyMultiWindowCacheTest;
                        const forcedHlsJs = api.shouldUseHlsJs({
                            mediaCacheEnabled: true,
                            video: {
                                canPlayType() {
                                    return 'maybe';
                                }
                            }
                        }, {
                            isHls: true,
                            url: 'https://example.invalid/main.m3u8'
                        });
                        const canonicalKeysMatch = api.cacheKey({
                            url: 'https://example.invalid/hls/202.ts?' +
                                'PlaySessionId=session-1&api_key=secret&DeviceId=device',
                            rangeStart: 0,
                            rangeEnd: 0
                        }) === api.cacheKey({
                            url: 'https://example.invalid/hls/202.ts?' +
                                'PlaySessionId=session-1',
                            rangeStart: 0,
                            rangeEnd: 0
                        });
                        const plannerPlaylist = [
                            '#EXTM3U',
                            '#EXT-X-VERSION:3',
                            '#EXT-X-TARGETDURATION:2',
                            '#EXT-X-MEDIA-SEQUENCE:0',
                            ...[0, 1, 2, 3, 4, 5].flatMap(index => [
                                '#EXTINF:2.000,',
                                `https://example.invalid/planner/${index}.ts?` +
                                    'PlaySessionId=planner-session'
                            ]),
                            '#EXT-X-ENDLIST'
                        ].join('\n');
                        const plannerSegment = {
                            id: 'planner-clip',
                            name: '清单测试',
                            startMs: 5000,
                            endMs: 7000
                        };
                        const plannerSlot = {
                            activeSegment: plannerSegment,
                            item: {RunTimeTicks: 120000000},
                            mediaSource: {},
                            mediaCacheEnabled: false,
                            forceClipCache: false,
                            status: {hidden: true, textContent: ''},
                            mediaCache: new Map()
                        };
                        const plannerWindow = api.planWindow(
                            plannerSlot,
                            plannerSegment,
                            null
                        );
                        const plannerResult = await api.planStream(
                            plannerSlot,
                            plannerSegment,
                            {
                                url: 'data:application/vnd.apple.mpegurl;base64,' +
                                    btoa(plannerPlaylist),
                                isHls: true,
                                playSessionId: 'planner-session'
                            },
                            plannerWindow,
                            new AbortController().signal
                        );
                        const originalFetch = window.fetch;
                        const requests = [];
                        const fragmentAttempts = new Map();
                        let activeFetches = 0;
                        let maxConcurrentFetches = 0;
                        let stopCalls = 0;
                        const cacheStream = {
                            url: 'https://example.invalid/main.m3u8?' +
                                'api_key=test-token&DeviceId=test-device&' +
                                'MediaSourceId=source-1&PlaySessionId=session-1',
                            isHls: true,
                            playMethod: 'Transcode',
                            playSessionId: 'session-1'
                        };
                        const nonzeroCacheStream = api.createCacheStream({
                            cacheStreamTemplate: cacheStream
                        }, {
                            start: 50,
                            end: 150
                        });
                        const fragments = [0, 2, 4, 6, 8, 10].map((start, index) => ({
                            start,
                            duration: 2,
                            url: `https://example.invalid/hls/${index}.ts?` +
                                'PlaySessionId=session-1'
                        }));
                        const hls = {
                            latestLevelDetails: {fragments},
                            stopCalls: 0,
                            startCalls: 0,
                            stopLoad() {
                                this.stopCalls += 1;
                            },
                            startLoad() {
                                this.startCalls += 1;
                            }
                        };
                        let cachePlayCalls = 0;
                        const video = {
                            currentTime: 0,
                            paused: true,
                            pause() {
                                this.paused = true;
                            },
                            play() {
                                this.paused = false;
                                cachePlayCalls += 1;
                                return Promise.resolve();
                            },
                            fastSeek(seconds) {
                                this.currentTime = seconds;
                            }
                        };
                        const slot = {
                            activeSegment: {
                                id: 'clip-1',
                                name: '测试片段',
                                startMs: 5000,
                                endMs: 7000
                            },
                            item: {RunTimeTicks: 120000000},
                            stopped: false,
                            stream: cacheStream,
                            cacheStream,
                            cacheStreamTemplate: cacheStream,
                            hls,
                            hlsMemoryLoaderEnabled: true,
                            video,
                            status: {hidden: false, textContent: ''},
                            endpoints: {stopEncoding: 'https://example.invalid/stop'},
                            mediaCache: new Map(),
                            mediaCacheBytes: 0,
                            mediaCacheLimitBytes: 1024,
                            mediaCacheEnabled: true,
                            clipCacheGeneration: 0,
                            clipCachePlanProvider(cacheSession) {
                                return {
                                    fragments: fragments.map(fragment => ({
                                        start: fragment.start,
                                        duration: fragment.duration,
                                        url: `https://example.invalid/hls/` +
                                            `${fragment.start / 2}.ts?PlaySessionId=` +
                                            cacheSession.playSessionId
                                    }))
                                };
                            },
                            clipCacheActivationProvider(cacheSession, segment) {
                                this.stream = cacheSession;
                                this.cacheStream = cacheSession;
                                this.video.fastSeek(segment.startMs / 1000);
                                return Promise.resolve();
                            }
                        };
                        window.fetch = async (url, options = {}) => {
                            if (options.method === 'POST') {
                                stopCalls += 1;
                                // A cleanup-control failure must not invalidate
                                // media bytes that are already complete.
                                return new Response(null, {status: 500});
                            }
                            requests.push(String(url));
                            activeFetches += 1;
                            maxConcurrentFetches = Math.max(
                                maxConcurrentFetches,
                                activeFetches
                            );
                            await new Promise(resolve => setTimeout(resolve, 10));
                            activeFetches -= 1;
                            const attempt = (fragmentAttempts.get(String(url)) || 0) + 1;
                            fragmentAttempts.set(String(url), attempt);
                            if (String(url).includes('/hls/4.ts') && attempt === 1) {
                                return new Response(null, {status: 404});
                            }
                            return new Response(new Uint8Array([1, 2, 3, 4]), {
                                status: 200
                            });
                        };
                        try {
                            await api.cacheSegment(slot);
                        } finally {
                            window.fetch = originalFetch;
                        }
                        const shortBufferSettings = api.bufferSettings({
                            activeSegment: {startMs: 5000, endMs: 7000}
                        });
                        const longBufferSettings = api.bufferSettings({
                            activeSegment: {startMs: 0, endMs: 120000}
                        });
                        const highBitrateSlot = {
                            activeSegment: {startMs: 0, endMs: 120000},
                            mediaSource: {Bitrate: 40000000},
                            mediaCacheEnabled: false,
                            forceClipCache: true
                        };
                        const highBitrateBufferSettings =
                            api.bufferSettings(highBitrateSlot);
                        const workerHlsConfig = api.hlsConfig(highBitrateSlot);
                        const targetHlsConfig =
                            api.hlsConfig(highBitrateSlot, 1878.161);
                        const plannedWindow = api.planWindow(
                            slot,
                            slot.activeSegment,
                            hls.latestLevelDetails
                        );
                        const plannedFragments = api.plan(
                            slot,
                            slot.activeSegment
                        );
                        const realStartPlaybackFragment = api.playbackFragment(
                            [
                                {start: 1848, end: 1854},
                                {start: 1854, end: 1860},
                                {start: 1872, end: 1878},
                                {start: 1878, end: 1884},
                                {start: 1884, end: 1890}
                            ],
                            {startMs: 1878161, endMs: 1983485}
                        );
                        const plannedWindowCovered = api.planCoversWindow(
                            plannedFragments,
                            plannedWindow
                        );
                        const dynamicGuardWindow = api.planWindow(
                            {item: {RunTimeTicks: 2000000000}},
                            {startMs: 80000, endMs: 90000},
                            {fragments: [{duration: 12}]}
                        );
                        const cappedGuardWindow = api.planWindow(
                            {item: {RunTimeTicks: 2000000000}},
                            {startMs: 80000, endMs: 90000},
                            {fragments: [{duration: 20}]}
                        );
                        const segmentOnlyIsNotCovered = !api.planCoversWindow(
                            [{start: 80, end: 90}],
                            {start: 50, end: 120}
                        );
                        const gappedWindowIsNotCovered = !api.planCoversWindow(
                            [
                                {start: 50, end: 75},
                                {start: 76, end: 120}
                            ],
                            {start: 50, end: 120}
                        );
                        const missingBufferHls = {
                            stopCalls: 0,
                            startCalls: 0,
                            stopLoad() {
                                this.stopCalls += 1;
                            },
                            startLoad() {
                                this.startCalls += 1;
                            }
                        };
                        const missingBufferVideo = {
                            currentTime: 6.9,
                            buffered: {length: 0},
                            play() {
                                return Promise.resolve();
                            }
                        };
                        const missingBufferSlot = {
                            activeSegment: slot.activeSegment,
                            clipCacheReady: true,
                            hls: missingBufferHls,
                            video: missingBufferVideo,
                            loopSeeking: false
                        };
                        api.restartLoop(missingBufferSlot);
                        const bufferedLoopHls = {
                            stopCalls: 0,
                            startCalls: 0,
                            stopLoad() {
                                this.stopCalls += 1;
                            },
                            startLoad() {
                                this.startCalls += 1;
                            }
                        };
                        const bufferedLoopVideo = {
                            currentTime: 5,
                            buffered: {
                                length: 1,
                                start() {
                                    return 1;
                                },
                                end() {
                                    return 7;
                                }
                            },
                            play() {
                                return Promise.resolve();
                            }
                        };
                        const bufferedLoopSlot = {
                            activeSegment: slot.activeSegment,
                            clipCacheReady: true,
                            hls: bufferedLoopHls,
                            video: bufferedLoopVideo,
                            loopSeeking: false
                        };
                        api.restartLoop(bufferedLoopSlot);
                        const transientSlot = {
                            status: {
                                hidden: true,
                                textContent: '',
                                dataset: {}
                            }
                        };
                        api.transientStatus(
                            transientSlot,
                            'memory-ready',
                            '内存片段已就绪',
                            5
                        );
                        const transientVisibleInitially =
                            !transientSlot.status.hidden;
                        await new Promise(resolve => setTimeout(resolve, 20));
                        const orderedCallbacks = new Map();
                        let orderedBufferReady = false;
                        let orderedPlayCalls = 0;
                        const orderedVideo = {
                            currentTime: 0,
                            paused: true,
                            seeking: false,
                            readyState: 0,
                            videoWidth: 0,
                            videoHeight: 0,
                            buffered: {
                                get length() {
                                    return orderedBufferReady ? 1 : 0;
                                },
                                start() {
                                    return 1878.012;
                                },
                                end() {
                                    return 1888.429;
                                }
                            },
                            seekable: {length: 0},
                            addEventListener(name, callback) {
                                const callbacks =
                                    orderedCallbacks.get(name) || new Set();
                                callbacks.add(callback);
                                orderedCallbacks.set(name, callbacks);
                            },
                            removeEventListener(name, callback) {
                                const callbacks = orderedCallbacks.get(name);
                                if (callbacks) {
                                    callbacks.delete(callback);
                                }
                            },
                            play() {
                                orderedPlayCalls += 1;
                                this.paused = false;
                                // Reproduce Chrome keeping play() pending even
                                // after the target range reaches readyState 4.
                                return new Promise(() => {});
                            },
                            fastSeek(seconds) {
                                this.currentTime = seconds;
                                this.seeking = true;
                            }
                        };
                        const orderedHls = {
                            stopCalls: 0,
                            startCalls: 0,
                            stopLoad() {
                                this.stopCalls += 1;
                            },
                            startLoad() {
                                this.startCalls += 1;
                            }
                        };
                        const orderedSlot = {
                            id: 'ordered-hls-start',
                            item: {Id: 'ordered-item', Name: 'Ordered HLS'},
                            video: orderedVideo,
                            hls: orderedHls,
                            status: {
                                hidden: true,
                                textContent: '',
                                dataset: {}
                            }
                        };
                        const orderedReadyPromise = api.waitPlaybackReady(
                            orderedSlot,
                            {startMs: 1878161, endMs: 1983485}
                        );
                        const orderedPlayedBeforeBuffer =
                            orderedPlayCalls > 0;
                        orderedBufferReady = true;
                        orderedVideo.seeking = false;
                        orderedVideo.readyState =
                            HTMLMediaElement.HAVE_ENOUGH_DATA;
                        orderedVideo.videoWidth = 1920;
                        orderedVideo.videoHeight = 1080;
                        (orderedCallbacks.get('seeked') || []).forEach(
                            callback => callback({type: 'seeked'})
                        );
                        (orderedCallbacks.get('playing') || []).forEach(
                            callback => callback({type: 'playing'})
                        );
                        await orderedReadyPromise;
                        const nativeEvents = {};
                        let nativePlayCalls = 0;
                        const nativeVideo = {
                            readyState: 0,
                            currentTime: 0,
                            paused: true,
                            seeking: false,
                            buffered: {length: 0},
                            seekable: {length: 0},
                            addEventListener(name, callback) {
                                nativeEvents[name] = callback;
                            },
                            play() {
                                nativePlayCalls += 1;
                                this.paused = false;
                                return Promise.resolve();
                            },
                            fastSeek(seconds) {
                                this.currentTime = seconds;
                            }
                        };
                        const nativeSlot = {
                            id: 'native-startup',
                            item: {Id: 'native-item', Name: 'Native startup'},
                            video: nativeVideo,
                            status: {
                                hidden: true,
                                textContent: '',
                                dataset: {}
                            },
                            mediaCacheEnabled: false
                        };
                        await api.attachStream(nativeSlot, {
                            url: 'data:video/mp4;base64,U1lOQw==',
                            isHls: false
                        }, 1937.45);
                        const nativePlayedBeforeMetadata = nativePlayCalls > 0;
                        nativeVideo.readyState =
                            HTMLMediaElement.HAVE_METADATA;
                        nativeEvents.loadedmetadata();
                        const result = {
                            forcedHlsJs,
                            canonicalKeysMatch,
                            backgroundPlannerStarts:
                                plannerResult.plan.map(entry => entry.start),
                            backgroundPlannerCleaned:
                                !plannerSlot.clipCachePlannerHls &&
                                !plannerSlot.clipCachePlannerVideo,
                            ready: slot.clipCacheReady,
                            bytes: slot.clipCacheBytes,
                            entries: slot.mediaCache.size,
                            requests,
                            firstRequestedFragment: requests[0],
                            independentCacheSession:
                                slot.cacheStream.playSessionId !== 'session-1',
                            nonzeroCacheStartTimeTicks:
                                new URL(nonzeroCacheStream.url)
                                    .searchParams.get('StartTimeTicks'),
                            nonzeroCacheSessionIndependent:
                                nonzeroCacheStream.playSessionId !==
                                cacheStream.playSessionId,
                            cacheStartTimeTicks: new URL(slot.cacheStream.url)
                                .searchParams.get('StartTimeTicks'),
                            requestSessionMatches: requests.every(url =>
                                new URL(url).searchParams.get('PlaySessionId') ===
                                slot.cacheStream.playSessionId
                            ),
                            maxConcurrentFetches,
                            stopCalls,
                            hlsStopCalls: hls.stopCalls,
                            hlsStartCalls: hls.startCalls,
                            currentTime: video.currentTime,
                            playing: !video.paused,
                            shortBufferSettings,
                            longBufferSettings,
                            highBitrateBufferSettings,
                            workerHlsConfig: {
                                enableWorker: workerHlsConfig.enableWorker,
                                workerPath: workerHlsConfig.workerPath,
                                maxBufferLength:
                                    workerHlsConfig.maxBufferLength,
                                backBufferLength:
                                    workerHlsConfig.backBufferLength,
                                maxBufferSize:
                                    workerHlsConfig.maxBufferSize
                            },
                            targetStartPosition:
                                targetHlsConfig.startPosition,
                            realStartPlaybackFragment:
                                realStartPlaybackFragment &&
                                realStartPlaybackFragment.start,
                            cachePlayCalls,
                            plannedWindow,
                            plannedWindowCovered,
                            dynamicGuardWindow,
                            cappedGuardWindow,
                            segmentOnlyIsNotCovered,
                            gappedWindowIsNotCovered,
                            missingBufferStopCalls:
                                missingBufferHls.stopCalls,
                            missingBufferStartCalls:
                                missingBufferHls.startCalls,
                            missingBufferCurrentTime:
                                missingBufferVideo.currentTime,
                            missingBufferLoopSeeking:
                                missingBufferSlot.loopSeeking,
                            bufferedLoopStopCalls:
                                bufferedLoopHls.stopCalls,
                            bufferedLoopStartCalls:
                                bufferedLoopHls.startCalls,
                            bufferedLoopCurrentTime:
                                bufferedLoopVideo.currentTime,
                            bufferedLoopSeeking:
                                bufferedLoopSlot.loopSeeking,
                            transientVisibleInitially,
                            transientHiddenAfterDelay:
                                transientSlot.status.hidden &&
                                transientSlot.playbackPhase === '',
                            orderedPlayedBeforeBuffer,
                            orderedPlayCalls,
                            orderedStopCalls: orderedHls.stopCalls,
                            orderedStartCalls: orderedHls.startCalls,
                            orderedStartTime: orderedVideo.currentTime,
                            nativePlayedBeforeMetadata,
                            nativePlayCalls,
                            nativeStartTime: nativeVideo.currentTime
                        };
                        api.release(slot);
                        result.entriesAfterRelease = slot.mediaCache.size;
                        result.bytesAfterRelease = slot.mediaCacheBytes;
                        return result;
                    });
                    if (!clipCacheResult.forcedHlsJs ||
                        !clipCacheResult.canonicalKeysMatch ||
                        clipCacheResult.backgroundPlannerStarts.join(',') !==
                            '0,2,4,6,8,10' ||
                        !clipCacheResult.backgroundPlannerCleaned ||
                        !clipCacheResult.ready ||
                        clipCacheResult.bytes !== 24 ||
                        clipCacheResult.entries !== 6 ||
                        clipCacheResult.requests.length !== 7 ||
                        !clipCacheResult.firstRequestedFragment
                            .includes('/hls/0.ts') ||
                        !clipCacheResult.independentCacheSession ||
                        !clipCacheResult.nonzeroCacheSessionIndependent ||
                        clipCacheResult.nonzeroCacheStartTimeTicks !==
                            '500000000' ||
                        clipCacheResult.cacheStartTimeTicks !== '0' ||
                        !clipCacheResult.requestSessionMatches ||
                        clipCacheResult.maxConcurrentFetches !== 1 ||
                        clipCacheResult.requests.some(url =>
                            !url.includes('api_key=test-token')) ||
                        clipCacheResult.stopCalls !== 1 ||
                        clipCacheResult.hlsStopCalls !== 0 ||
                        clipCacheResult.hlsStartCalls !== 0 ||
                        clipCacheResult.currentTime !== 5 ||
                        !clipCacheResult.playing ||
                        clipCacheResult.shortBufferSettings.maxBufferLength !== 12 ||
                        clipCacheResult.shortBufferSettings.backBufferLength !== 6 ||
                        clipCacheResult.longBufferSettings.maxBufferLength !== 20 ||
                        clipCacheResult.longBufferSettings.backBufferLength !== 8 ||
                        Math.abs(
                            clipCacheResult.highBitrateBufferSettings
                                .maxBufferLength - 10.0663296
                        ) > 0.001 ||
                        Math.abs(
                            clipCacheResult.highBitrateBufferSettings
                                .backBufferLength - 5.0331648
                        ) > 0.001 ||
                        clipCacheResult.highBitrateBufferSettings
                            .maxBufferSize !== 50331648 ||
                        !clipCacheResult.workerHlsConfig.enableWorker ||
                        !clipCacheResult.workerHlsConfig.workerPath
                            .endsWith('/hls.worker.js') ||
                        clipCacheResult.workerHlsConfig.maxBufferSize !==
                            50331648 ||
                        clipCacheResult.targetStartPosition !== 1878.161 ||
                        clipCacheResult.realStartPlaybackFragment !== 1878 ||
                        clipCacheResult.cachePlayCalls !== 1 ||
                        clipCacheResult.plannedWindow.start !== 0 ||
                        clipCacheResult.plannedWindow.end !== 12 ||
                        clipCacheResult.plannedWindow.guardSeconds !== 30 ||
                        !clipCacheResult.plannedWindowCovered ||
                        clipCacheResult.dynamicGuardWindow.start !== 32 ||
                        clipCacheResult.dynamicGuardWindow.end !== 138 ||
                        clipCacheResult.dynamicGuardWindow.guardSeconds !== 48 ||
                        clipCacheResult.cappedGuardWindow.start !== 20 ||
                        clipCacheResult.cappedGuardWindow.end !== 150 ||
                        clipCacheResult.cappedGuardWindow.guardSeconds !== 60 ||
                        !clipCacheResult.segmentOnlyIsNotCovered ||
                        !clipCacheResult.gappedWindowIsNotCovered ||
                        clipCacheResult.missingBufferStopCalls !== 0 ||
                        clipCacheResult.missingBufferStartCalls !== 0 ||
                        clipCacheResult.missingBufferCurrentTime !== 5 ||
                        !clipCacheResult.missingBufferLoopSeeking ||
                        clipCacheResult.bufferedLoopStopCalls !== 0 ||
                        clipCacheResult.bufferedLoopStartCalls !== 0 ||
                        clipCacheResult.bufferedLoopCurrentTime !== 5 ||
                        !clipCacheResult.bufferedLoopSeeking ||
                        !clipCacheResult.transientVisibleInitially ||
                        !clipCacheResult.transientHiddenAfterDelay ||
                        clipCacheResult.orderedPlayedBeforeBuffer ||
                        clipCacheResult.orderedPlayCalls !== 1 ||
                        clipCacheResult.orderedStopCalls !== 0 ||
                        clipCacheResult.orderedStartCalls !== 0 ||
                        clipCacheResult.orderedStartTime !== 1878.161 ||
                        clipCacheResult.nativePlayedBeforeMetadata ||
                        clipCacheResult.nativePlayCalls !== 1 ||
                        clipCacheResult.nativeStartTime !== 1937.45 ||
                        clipCacheResult.entriesAfterRelease !== 0 ||
                        clipCacheResult.bytesAfterRelease !== 0) {
                        failures.push('player.html: selected clip was not fully cached before stopping encoding');
                    }
                    const titlesBefore = await page.locator('.tile').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label')));
                    if (titlesBefore.length !== 2) {
                        failures.push('player.html: two-video fixture was not created');
                    } else {
                        const controlOverlap = await page.evaluate(() => {
                            const tools = document.querySelector('#windowTools')
                                .getBoundingClientRect();
                            const tile = document.querySelectorAll('.tile')[1];
                            return ['.drag-handle', '.close'].some(selector => {
                                const control = tile.querySelector(selector)
                                    .getBoundingClientRect();
                                return tools.left < control.right &&
                                    tools.right > control.left &&
                                    tools.top < control.bottom &&
                                    tools.bottom > control.top;
                            });
                        });
                        if (controlOverlap) {
                            failures.push('player.html: window controls overlap second-video controls');
                        }
                        const firstVideoSrc = await page.locator('.tile video').first()
                            .getAttribute('src');
                        if (!firstVideoSrc || !firstVideoSrc.includes('RElSRUNU')) {
                            failures.push('player.html: opening a pane did not select direct stream');
                        }
                        const optionColors = await page.locator('.segments option').nth(1)
                            .evaluate(option => {
                                const style = getComputedStyle(option);
                                return {
                                    color: style.color,
                                    background: style.backgroundColor
                                };
                            });
                        if (optionColors.color !== 'rgb(23, 23, 23)' ||
                            optionColors.background !== 'rgb(244, 244, 244)') {
                            failures.push('player.html: segment options have unreadable colors');
                        }
                        await page.locator('.drag-handle').first()
                            .dragTo(page.locator('.tile').nth(1));
                        const titlesAfter = await page.locator('.tile').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label')));
                        if (titlesAfter[0] === titlesBefore[0]) {
                            failures.push('player.html: two-video drag did not change order');
                        }
                    }
                }
                if (process.env.EMBY_SCREENSHOT) {
                    await page.evaluate(() => {
                        document.querySelector('#empty').hidden = true;
                        document.querySelector('#grid').innerHTML = `
                            <section class="tile" aria-label="示例影片 · 第一画面">
                                <div class="title">示例影片 · 第一画面</div>
                                <button class="drag-handle">⠿</button>
                                <button class="close">×</button>
                                <div class="controls">
                                    <div class="segments"><select>
                                        <option>精彩片段  12:30–18:45</option>
                                    </select></div>
                                    <div class="seek">
                                        <input type="range" value="460" min="0" max="1000">
                                        <div class="preview no-image" style="left:46%;width:92px">
                                            <div class="preview-text">12:34</div>
                                        </div>
                                    </div>
                                    <div class="transport">
                                        <button class="play">▶</button>
                                        <label class="volume"><span>🔊</span>
                                            <input type="range" value="0.8" min="0" max="1">
                                        </label>
                                        <div class="time">12:34 / 42:18</div>
                                    </div>
                                </div>
                            </section>`;
                        const sampleGrid = document.querySelector('#grid');
                        const secondTile = sampleGrid.firstElementChild.cloneNode(true);
                        secondTile.setAttribute('aria-label', '示例影片 · 第二画面');
                        secondTile.querySelector('.title').textContent = '示例影片 · 第二画面';
                        sampleGrid.appendChild(secondTile);
                        sampleGrid.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
                        sampleGrid.style.gridTemplateRows = '1fr';
                    });
                    await page.setViewportSize({width: 900, height: 560});
                    await page.screenshot({
                        path: process.env.EMBY_SCREENSHOT,
                        fullPage: true
                    });
                }
            } else if (pageName === 'options.html' &&
                !await page.locator('#previewWidth').isVisible()) {
                failures.push('options.html: preview setting is not visible');
            } else if (pageName === 'options.html' &&
                !await page.locator('#siteInput').isVisible()) {
                failures.push('options.html: custom site editor is not visible');
            } else if (pageName === 'options.html' &&
                !await page.locator('#controlsIdleSeconds').isVisible()) {
                failures.push('options.html: control hide delay setting is not visible');
            } else if (pageName === 'options.html' &&
                (!await page.locator('#mediaCacheMode').isVisible() ||
                    !await page.locator('#mediaCacheLimitMb').isVisible())) {
                failures.push('options.html: media cache settings are not visible');
            } else if (pageName === 'options.html') {
                const cacheRange = await page.locator('#mediaCacheLimitMb')
                    .evaluate(element => ({
                        min: element.min,
                        max: element.max,
                        step: element.step,
                        value: element.value
                    }));
                const cacheLabel = await page.locator('#mediaCacheLimitValue')
                    .evaluate(element => element.value);
                const controlsIdleRange =
                    await page.locator('#controlsIdleSeconds')
                        .evaluate(element => ({
                            min: element.min,
                            max: element.max,
                            step: element.step,
                            value: element.value
                        }));
                const controlsIdleLabel =
                    await page.locator('#controlsIdleSecondsValue')
                        .evaluate(element => element.value);
                if (cacheRange.min !== '256' || cacheRange.max !== '16384' ||
                    cacheRange.step !== '256' || cacheRange.value !== '4096' ||
                    cacheLabel !== '4 GB') {
                    failures.push('options.html: high-memory cache defaults are incorrect');
                }
                if (controlsIdleRange.min !== '0.5' ||
                    controlsIdleRange.max !== '30' ||
                    controlsIdleRange.step !== '0.5' ||
                    controlsIdleRange.value !== '2.5' ||
                    controlsIdleLabel !== '2.5 秒') {
                    failures.push(
                        'options.html: control hide delay defaults are incorrect'
                    );
                }
                await page.locator('#siteInput').fill('192.168.8.8:8096');
                await page.locator('#addSite').click();
                if (!await page.locator('#siteList code', {
                    hasText: 'http://192.168.8.8:8096'
                }).isVisible()) {
                    failures.push('options.html: custom site could not be added');
                }
            } else if (pageName === 'tests/mock-emby.html') {
                if (!await page.locator('.emby-multiwindow-detail-button').isVisible()) {
                    failures.push('mock-emby.html: detail entry button is not visible');
                }
                if (!await page.locator('#emby-multiwindow-launcher').isVisible()) {
                    failures.push('mock-emby.html: playback launcher is not visible');
                }
                const codecResult = await page.evaluate(() => {
                    const api = window.__embyMultiWindowCodecTest;
                    const hevcSource = {
                        Id: 'source-1',
                        Container: 'mp4',
                        TranscodingUrl: '/Videos/item-1/master.m3u8?VideoCodec=hevc,h264',
                        TranscodingSubProtocol: 'hls',
                        MediaStreams: [{
                            Type: 'Video',
                            Codec: 'hevc',
                            Profile: 'Main',
                            BitDepth: 8,
                            PixelFormat: 'yuv420p'
                        }]
                    };
                    const high10Source = {
                        Container: 'mp4',
                        MediaStreams: [{
                            Type: 'Video',
                            Codec: 'h264',
                            Profile: 'High 10',
                            BitDepth: 10,
                            PixelFormat: 'yuv420p10le'
                        }]
                    };
                    const highLevelSource = {
                        Container: 'mp4',
                        MediaStreams: [{
                            Type: 'Video',
                            Codec: 'h264',
                            Profile: 'High',
                            Level: 62,
                            BitDepth: 8,
                            PixelFormat: 'yuv420p',
                            Width: 3840,
                            Height: 2160,
                            RealFrameRate: 60
                        }]
                    };
                    const browserSafeH264Source = {
                        Id: 'source-2',
                        Container: 'mp4',
                        TranscodingUrl:
                            '/Videos/item-2/master.m3u8?' +
                            'VideoCodec=hevc,h264,av1&AllowVideoStreamCopy=true',
                        TranscodingSubProtocol: 'hls',
                        MediaStreams: [{
                            Type: 'Video',
                            Codec: 'h264',
                            Profile: 'Main',
                            Level: 42,
                            BitDepth: 8,
                            PixelFormat: 'yuv420p',
                            Width: 1920,
                            Height: 1080,
                            RealFrameRate: 24
                        }]
                    };
                    const forced = new URL(api.forceTranscodeUrl(
                        'http://emby.test/master.m3u8?VideoCodec=hevc,h264,av1&allowVideoStreamCopy=true'
                    ));
                    const testClient = {
                        getUrl(path) {
                            return 'http://emby.test/emby/' + path;
                        },
                        accessToken() {
                            return 'token';
                        },
                        deviceId() {
                            return 'device';
                        }
                    };
                    const cached = api.buildCacheStream(testClient, hevcSource, {
                        PlaySessionId: 'session-1'
                    });
                    const h264Cached = api.buildCacheStream(
                        testClient,
                        browserSafeH264Source,
                        {PlaySessionId: 'session-2'}
                    );
                    const direct = api.buildDirectTrial(testClient,
                    {Id: 'item-1'}, hevcSource, {
                        playSessionId: 'session-1'
                    });
                    return {
                        hevcAcceptedAsSafe: api.canPlay(hevcSource),
                        high10AcceptedAsSafe: api.canPlay(high10Source),
                        highLevelAcceptedAsSafe: api.canPlay(highLevelSource),
                        forcedCodec: forced.searchParams.get('VideoCodec'),
                        forcedCopy: forced.searchParams.get('AllowVideoStreamCopy'),
                        forcedProfile: forced.searchParams.get('h264-profile'),
                        directTrial: direct && direct.nativeTrial,
                        directUrl: direct && direct.url,
                        directSession: direct && direct.playSessionId,
                        cacheHls: cached && cached.isHls,
                        cacheCodec: cached &&
                            new URL(cached.url).searchParams.get('VideoCodec'),
                        h264CacheCodec: h264Cached &&
                            new URL(h264Cached.url).searchParams.get('VideoCodec'),
                        h264CacheCopy: h264Cached &&
                            new URL(h264Cached.url).searchParams.get(
                                'AllowVideoStreamCopy'
                            ),
                        cacheSession: cached && cached.playSessionId
                    };
                });
                if (codecResult.hevcAcceptedAsSafe ||
                    codecResult.high10AcceptedAsSafe ||
                    codecResult.highLevelAcceptedAsSafe ||
                    codecResult.forcedCodec !== 'h264' ||
                    codecResult.forcedCopy !== 'false' ||
                    codecResult.forcedProfile !== 'high,main,baseline' ||
                    !codecResult.directTrial ||
                    !codecResult.directUrl.includes('/Videos/item-1/original.mp4') ||
                    codecResult.directSession !== 'session-1' ||
                    !codecResult.cacheHls ||
                    codecResult.cacheCodec !== 'h264' ||
                    codecResult.h264CacheCodec !== 'h264' ||
                    codecResult.h264CacheCopy !== 'false' ||
                    codecResult.cacheSession !== 'session-1') {
                    failures.push('mock-emby.html: adaptive direct/fallback codec policy failed');
                }
            }
            await page.close();
        }
    } finally {
        await context.close();
        fs.rmSync(profilePath, {recursive: true, force: true});
    }
    if (failures.length) {
        console.error(failures.join('\n'));
        process.exit(1);
    }
    console.log(
        'Chrome extension smoke test: OK (' +
        (extensionRuntimeDetected ? 'extension runtime + worker' : 'file fallback') +
        ')'
    );
})();
