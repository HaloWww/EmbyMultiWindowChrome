'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const {chromium} = require('playwright');

(async function () {
    const extensionPath = path.resolve(__dirname, '..');
    const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-multiwindow-'));
    const browserPath = process.env.EMBY_TEST_BROWSER ||
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const context = await chromium.launchPersistentContext(profilePath, {
        executablePath: browserPath,
        // Chrome does not load unpacked MV3 extensions in its headless shell.
        // This uses a disposable headed profile and closes it automatically.
        headless: false,
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`
        ]
    });
    const failures = [];
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
                        sync: makeArea({previewWidth: 280}),
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
                if (!await page.locator('#stage').isVisible()) {
                    failures.push('player.html: stage is not visible');
                }
                if (await page.locator('video[controls]').count()) {
                    failures.push('player.html: native video controls are enabled');
                }
                if (!await page.locator('#newWindow').isVisible()) {
                    failures.push('player.html: new-window control is not visible');
                }
                if ((await page.locator('#newWindow').textContent())
                    .replace(/\s+/g, ' ').trim() !== '＋ 新建窗口') {
                    failures.push('player.html: new-window control has no visible description');
                }
                if (await page.locator('#playbackStrategy').count()) {
                    failures.push('player.html: obsolete playback strategy button still exists');
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
                                        resolve(response.data.byteLength);
                                    },
                                    onError(error) {
                                        reject(new Error(error.text || 'load failed'));
                                    }
                                });
                            });
                        }
                        const firstSize = await loadOnce();
                        const secondSize = await loadOnce();
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
                            secondSize,
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
                        const video = {
                            currentTime: 0,
                            paused: true,
                            pause() {
                                this.paused = true;
                            },
                            play() {
                                this.paused = false;
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
                                startMs: 1000,
                                endMs: 7000
                            },
                            stopped: false,
                            stream: cacheStream,
                            cacheStream,
                            hls,
                            hlsMemoryLoaderEnabled: true,
                            video,
                            status: {hidden: false, textContent: ''},
                            endpoints: {stopEncoding: 'https://example.invalid/stop'},
                            mediaCache: new Map(),
                            mediaCacheBytes: 0,
                            mediaCacheLimitBytes: 1024,
                            mediaCacheEnabled: true,
                            clipCacheGeneration: 0
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
                        const result = {
                            forcedHlsJs,
                            canonicalKeysMatch,
                            ready: slot.clipCacheReady,
                            bytes: slot.clipCacheBytes,
                            entries: slot.mediaCache.size,
                            requests,
                            maxConcurrentFetches,
                            stopCalls,
                            hlsStopCalls: hls.stopCalls,
                            hlsStartCalls: hls.startCalls,
                            currentTime: video.currentTime,
                            playing: !video.paused
                        };
                        api.release(slot);
                        result.entriesAfterRelease = slot.mediaCache.size;
                        result.bytesAfterRelease = slot.mediaCacheBytes;
                        return result;
                    });
                    if (!clipCacheResult.forcedHlsJs ||
                        !clipCacheResult.canonicalKeysMatch ||
                        !clipCacheResult.ready ||
                        clipCacheResult.bytes !== 24 ||
                        clipCacheResult.entries !== 6 ||
                        clipCacheResult.requests.length !== 7 ||
                        clipCacheResult.maxConcurrentFetches !== 1 ||
                        clipCacheResult.requests.some(url =>
                            !url.includes('api_key=test-token')) ||
                        clipCacheResult.stopCalls !== 1 ||
                        clipCacheResult.hlsStopCalls !== 0 ||
                        clipCacheResult.hlsStartCalls !== 0 ||
                        clipCacheResult.currentTime !== 1 ||
                        !clipCacheResult.playing ||
                        clipCacheResult.entriesAfterRelease !== 0 ||
                        clipCacheResult.bytesAfterRelease !== 0) {
                        failures.push('player.html: selected clip was not fully cached before stopping encoding');
                    }
                    const titlesBefore = await page.locator('.tile .title').allTextContents();
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
                        const titlesAfter = await page.locator('.tile .title').allTextContents();
                        if (titlesAfter[0] === titlesBefore[0]) {
                            failures.push('player.html: two-video drag did not change order');
                        }
                    }
                }
                if (process.env.EMBY_SCREENSHOT) {
                    await page.evaluate(() => {
                        document.querySelector('#empty').hidden = true;
                        document.querySelector('#grid').innerHTML = `
                            <section class="tile">
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
                if (cacheRange.min !== '256' || cacheRange.max !== '16384' ||
                    cacheRange.step !== '256' || cacheRange.value !== '4096' ||
                    cacheLabel !== '4 GB') {
                    failures.push('options.html: high-memory cache defaults are incorrect');
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
                    const direct = api.buildDirectTrial(testClient,
                    {Id: 'item-1'}, hevcSource, {
                        playSessionId: 'session-1'
                    });
                    return {
                        hevcAcceptedAsSafe: api.canPlay(hevcSource),
                        high10AcceptedAsSafe: api.canPlay(high10Source),
                        forcedCodec: forced.searchParams.get('VideoCodec'),
                        forcedCopy: forced.searchParams.get('allowVideoStreamCopy'),
                        forcedProfile: forced.searchParams.get('h264-profile'),
                        directTrial: direct && direct.nativeTrial,
                        directUrl: direct && direct.url,
                        directSession: direct && direct.playSessionId,
                        cacheHls: cached && cached.isHls,
                        cacheCodec: cached &&
                            new URL(cached.url).searchParams.get('VideoCodec'),
                        cacheSession: cached && cached.playSessionId
                    };
                });
                if (codecResult.hevcAcceptedAsSafe ||
                    codecResult.high10AcceptedAsSafe ||
                    codecResult.forcedCodec !== 'h264' ||
                    codecResult.forcedCopy !== 'false' ||
                    codecResult.forcedProfile !== 'high,main,baseline' ||
                    !codecResult.directTrial ||
                    !codecResult.directUrl.includes('/Videos/item-1/original.mp4') ||
                    codecResult.directSession !== 'session-1' ||
                    !codecResult.cacheHls ||
                    codecResult.cacheCodec !== 'h264' ||
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
    console.log('Chrome extension smoke test: OK');
})();
