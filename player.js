(function () {
    'use strict';

    var MAX_SLOTS = 4;
    var PROGRESS_INTERVAL_MS = 10000;
    var DEFAULT_CONTROLS_IDLE_MS = 2500;
    var MIN_CONTROLS_IDLE_MS = 500;
    var MAX_CONTROLS_IDLE_MS = 30000;
    var CLIP_CACHE_GUARD_SECONDS = 30;
    var CLIP_CACHE_MAX_GUARD_SECONDS = 60;
    var CLIP_READY_TIMEOUT_MS = 12000;
    var LOOP_SEEK_TIMEOUT_MS = 5000;
    var MSE_TARGET_BUFFER_BYTES = 48 * 1024 * 1024;
    var DIAGNOSTIC_ENDPOINT = 'http://127.0.0.1:47831/v1/logs';
    var DIAGNOSTIC_FLUSH_MS = 250;
    var DIAGNOSTIC_REQUEST_TIMEOUT_MS = 3000;
    var DIAGNOSTIC_RETRY_MS = 5000;
    var DIAGNOSTIC_MAX_QUEUE = 1000;
    var PENDING_PREFIX = 'embyMultiWindow.pending.';
    var DEFAULT_MEDIA_CACHE_LIMIT_MB = 4096;
    var MIN_MEDIA_CACHE_LIMIT_MB = 256;
    var MAX_MEDIA_CACHE_LIMIT_MB = 16384;
    var MEDIA_CACHE_LIMIT_VERSION = 2;
    var stage = document.getElementById('stage');
    var grid = document.getElementById('grid');
    var empty = document.getElementById('empty');
    var toast = document.getElementById('toast');
    var newWindowButton = document.getElementById('newWindow');
    var slots = new Map();
    var playerWindowIdPromise = chrome.windows.getCurrent().then(function (windowInfo) {
        return windowInfo.id;
    });
    var dragState = null;
    var diagnosticSessionId = (crypto.randomUUID ?
        crypto.randomUUID() : Date.now().toString(36) +
        Math.random().toString(36).slice(2));
    var diagnosticQueue = [];
    var diagnosticFlushTimer = null;
    var diagnosticRetryAt = 0;
    var diagnosticFlushInFlight = false;
    var diagnosticFetch = window.fetch.bind(window);

    function diagnosticSafeUrl(value) {
        if (!value) {
            return '';
        }
        try {
            var url = new URL(String(value), location.href);
            [
                'api_key',
                'X-Emby-Token',
                'token',
                'auth',
                'Authorization'
            ].forEach(function (name) {
                if (url.searchParams.has(name)) {
                    url.searchParams.set(name, '[redacted]');
                }
            });
            return url.href;
        } catch (error) {
            return String(value).replace(
                /((?:api_key|token|auth)=)[^&\s]+/ig,
                '$1[redacted]'
            );
        }
    }

    function diagnosticError(error) {
        if (!error) {
            return null;
        }
        return {
            name: error.name || '',
            message: error.message || String(error),
            stack: error.stack ? String(error.stack).slice(0, 4000) : ''
        };
    }

    function diagnosticFragment(fragment) {
        if (!fragment) {
            return null;
        }
        return {
            sn: fragment.sn,
            level: fragment.level,
            type: fragment.type || '',
            start: Number.isFinite(Number(fragment.start)) ?
                Number(Number(fragment.start).toFixed(3)) : null,
            duration: Number.isFinite(Number(fragment.duration)) ?
                Number(Number(fragment.duration).toFixed(3)) : null,
            url: diagnosticSafeUrl(fragment.url)
        };
    }

    function diagnosticRanges(ranges) {
        var result = [];
        if (!ranges) {
            return result;
        }
        for (var index = 0; index < ranges.length && index < 12; index += 1) {
            try {
                result.push([
                    Number(ranges.start(index).toFixed(3)),
                    Number(ranges.end(index).toFixed(3))
                ]);
            } catch (error) {
                break;
            }
        }
        return result;
    }

    function diagnosticSlotState(slot) {
        var video = slot && slot.video;
        var quality = null;
        try {
            quality = video && video.getVideoPlaybackQuality ?
                video.getVideoPlaybackQuality() : null;
        } catch (error) {}
        var hls = slot && slot.hls;
        var controller = hls && hls.streamController;
        var fragment = controller && controller.fragCurrent;
        return {
            slotId: slot && slot.id || '',
            itemId: slot && slot.item && slot.item.Id || '',
            itemName: slot && slot.item &&
                (slot.item.Name || slot.item.OriginalTitle) || '',
            currentTime: video ? Number((video.currentTime || 0).toFixed(3)) : 0,
            duration: video && Number.isFinite(video.duration) ?
                Number(video.duration.toFixed(3)) : null,
            paused: video ? !!video.paused : null,
            seeking: video ? !!video.seeking : null,
            readyState: video ? video.readyState : null,
            networkState: video ? video.networkState : null,
            buffered: diagnosticRanges(video && video.buffered),
            seekable: diagnosticRanges(video && video.seekable),
            videoWidth: video ? video.videoWidth : 0,
            videoHeight: video ? video.videoHeight : 0,
            totalFrames: quality ? quality.totalVideoFrames : null,
            droppedFrames: quality ? quality.droppedVideoFrames : null,
            hlsVersion: window.Hls && Hls.version || '',
            hlsState: controller && controller.state || '',
            hlsLoading: hls ? !!hls.loadingEnabled : null,
            hlsBuffering: hls ? !!hls.bufferingEnabled : null,
            fragment: diagnosticFragment(fragment),
            cacheReady: !!(slot && slot.clipCacheReady),
            cacheLoading: !!(slot && slot.clipCacheLoading),
            cacheBytes: slot && slot.mediaCacheBytes || 0,
            cacheEntries: slot && slot.mediaCache ?
                slot.mediaCache.size : 0,
            cacheHits: slot && slot.cacheHits || 0,
            cacheNetworkLoads: slot && slot.cacheNetworkLoads || 0,
            lastCacheHitAgeMs: slot && slot.lastCacheHitAt ?
                Math.round(performance.now() - slot.lastCacheHitAt) : null,
            activeSegment: slot && slot.activeSegment ? {
                id: slot.activeSegment.id,
                name: slot.activeSegment.name,
                startMs: slot.activeSegment.startMs,
                endMs: slot.activeSegment.endMs
            } : null,
            playbackPhase: slot && slot.playbackPhase || '',
            lastHlsError: slot && slot.lastHlsError || null
        };
    }

    function scheduleDiagnosticFlush(delay) {
        if (diagnosticFlushTimer) {
            return;
        }
        diagnosticFlushTimer = setTimeout(function () {
            diagnosticFlushTimer = null;
            flushDiagnosticLogs();
        }, delay == null ? DIAGNOSTIC_FLUSH_MS : delay);
    }

    function diagnosticLog(eventName, data, level) {
        diagnosticQueue.push({
            timestamp: new Date().toISOString(),
            sessionId: diagnosticSessionId,
            page: location.href,
            level: level || 'info',
            event: eventName,
            data: data || {}
        });
        if (diagnosticQueue.length > DIAGNOSTIC_MAX_QUEUE) {
            diagnosticQueue.splice(
                0,
                diagnosticQueue.length - DIAGNOSTIC_MAX_QUEUE
            );
        }
        scheduleDiagnosticFlush();
    }

    function diagnosticHlsEvent(slot, eventName, data, level) {
        var stats = data && data.stats;
        diagnosticLog(eventName, {
            fragment: diagnosticFragment(data && data.frag),
            part: data && data.part ? {
                index: data.part.index,
                start: data.part.start,
                duration: data.part.duration
            } : null,
            details: String(data && data.details || ''),
            type: String(data && data.type || ''),
            parent: String(data && data.parent || ''),
            fatal: !!(data && data.fatal),
            reason: String(data && data.reason || ''),
            bytes: data && data.payload && data.payload.byteLength ||
                data && data.data && data.data.byteLength ||
                stats && (stats.loaded || stats.total) || 0,
            stats: stats ? {
                loaded: stats.loaded || 0,
                total: stats.total || 0,
                loadingStart: stats.loading && stats.loading.start || 0,
                loadingFirst: stats.loading && stats.loading.first || 0,
                loadingEnd: stats.loading && stats.loading.end || 0,
                parsingStart: stats.parsing && stats.parsing.start || 0,
                parsingEnd: stats.parsing && stats.parsing.end || 0,
                bufferingStart: stats.buffering && stats.buffering.start || 0,
                bufferingEnd: stats.buffering && stats.buffering.end || 0
            } : null,
            error: diagnosticError(data && data.error),
            state: diagnosticSlotState(slot)
        }, level);
    }

    function flushDiagnosticLogs() {
        if (!diagnosticQueue.length || diagnosticFlushInFlight) {
            return;
        }
        if (Date.now() < diagnosticRetryAt) {
            scheduleDiagnosticFlush(diagnosticRetryAt - Date.now());
            return;
        }
        // Chrome limits keepalive request bodies. Keep each batch small enough
        // to survive a window close while still preserving detailed snapshots.
        var batch = diagnosticQueue.splice(0, 20);
        diagnosticFlushInFlight = true;
        var requestController = new AbortController();
        var requestTimer = setTimeout(function () {
            requestController.abort();
        }, DIAGNOSTIC_REQUEST_TIMEOUT_MS);
        diagnosticFetch(DIAGNOSTIC_ENDPOINT, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(batch),
            cache: 'no-store',
            credentials: 'omit',
            keepalive: true,
            signal: requestController.signal
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('diagnostic collector HTTP ' + response.status);
            }
            diagnosticRetryAt = 0;
        }).catch(function () {
            diagnosticQueue = batch.concat(diagnosticQueue).slice(
                -DIAGNOSTIC_MAX_QUEUE
            );
            diagnosticRetryAt = Date.now() + DIAGNOSTIC_RETRY_MS;
        }).finally(function () {
            clearTimeout(requestTimer);
            diagnosticFlushInFlight = false;
            if (diagnosticQueue.length) {
                scheduleDiagnosticFlush(
                    diagnosticRetryAt ?
                        Math.max(0, diagnosticRetryAt - Date.now()) :
                        DIAGNOSTIC_FLUSH_MS
                );
            }
        });
    }

    function flushDiagnosticLogsOnPageHide() {
        if (!diagnosticQueue.length || !navigator.sendBeacon) {
            flushDiagnosticLogs();
            return;
        }
        while (diagnosticQueue.length) {
            var batch = diagnosticQueue.splice(0, 20);
            var accepted = navigator.sendBeacon(
                DIAGNOSTIC_ENDPOINT,
                new Blob([JSON.stringify(batch)], {type: 'text/plain;charset=UTF-8'})
            );
            if (!accepted) {
                diagnosticQueue = batch.concat(diagnosticQueue).slice(
                    -DIAGNOSTIC_MAX_QUEUE
                );
                break;
            }
        }
    }
    diagnosticLog('player-start', {
        extensionVersion: chrome.runtime.getManifest ?
            chrome.runtime.getManifest().version : '',
        hlsVersion: window.Hls && Hls.version || '',
        userAgent: navigator.userAgent
    });
    var draining = false;
    var drainAgain = false;
    var controlsTimer = null;
    var toastTimer = null;
    var settingsReadyPromise = null;
    var settings = {
        previewWidth: 280,
        controlsIdleMs: DEFAULT_CONTROLS_IDLE_MS,
        mediaCacheMode: 'memory',
        mediaCacheLimitMb: DEFAULT_MEDIA_CACHE_LIMIT_MB
    };

    function clampMediaCacheLimit(value) {
        return Math.max(MIN_MEDIA_CACHE_LIMIT_MB,
            Math.min(MAX_MEDIA_CACHE_LIMIT_MB,
                Number(value) || DEFAULT_MEDIA_CACHE_LIMIT_MB));
    }

    function clampControlsIdleMs(seconds) {
        var milliseconds = Number(seconds) * 1000;
        if (!Number.isFinite(milliseconds)) {
            milliseconds = DEFAULT_CONTROLS_IDLE_MS;
        }
        return Math.max(
            MIN_CONTROLS_IDLE_MS,
            Math.min(
                MAX_CONTROLS_IDLE_MS,
                Math.round(milliseconds / 500) * 500
            )
        );
    }

    function showToast(message, duration) {
        toast.textContent = message;
        toast.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('visible');
        }, duration || 3600);
    }

    function formatTime(seconds) {
        seconds = Math.max(0, Math.floor(Number(seconds) || 0));
        var hours = Math.floor(seconds / 3600);
        var minutes = Math.floor(seconds % 3600 / 60);
        var secs = seconds % 60;
        return (hours ? hours + ':' + String(minutes).padStart(2, '0') : String(minutes)) +
            ':' + String(secs).padStart(2, '0');
    }

    function setPlaybackStatus(slot, phase, message) {
        if (!slot || !slot.status) {
            return;
        }
        clearTimeout(slot.statusHideTimer);
        slot.statusHideTimer = null;
        slot.playbackPhase = phase || '';
        slot.status.hidden = false;
        slot.status.textContent = message || '';
        if (slot.status.dataset) {
            slot.status.dataset.phase = slot.playbackPhase;
        }
    }

    function showTransientPlaybackStatus(slot, phase, message, duration) {
        setPlaybackStatus(slot, phase, message);
        slot.statusHideTimer = setTimeout(function () {
            if (slot.playbackPhase !== phase) {
                return;
            }
            slot.status.hidden = true;
            slot.playbackPhase = '';
            if (slot.status.dataset) {
                slot.status.dataset.phase = '';
            }
            slot.statusHideTimer = null;
        }, duration || 1800);
    }

    function bufferedRangeAt(video, seconds) {
        var ranges = video && video.buffered;
        if (!ranges || !Number.isFinite(seconds)) {
            return null;
        }
        for (var index = 0; index < ranges.length; index += 1) {
            var start = ranges.start(index);
            var end = ranges.end(index);
            if (seconds >= start - 0.05 && seconds < end - 0.05) {
                return {
                    start: start,
                    end: end,
                    ahead: Math.max(0, end - seconds)
                };
            }
        }
        return null;
    }

    function clipBufferSettings(slot) {
        var segment = slot && slot.activeSegment;
        var duration = segment ?
            Math.max(1, (segment.endMs - segment.startMs) / 1000) : 12;
        var source = slot && slot.mediaSource || {};
        var streamBitrate = (source.MediaStreams || []).reduce(function (
            total,
            stream
        ) {
            return total + (Number(stream.BitRate) || 0);
        }, 0);
        var bitrate = Number(source.Bitrate) || streamBitrate;
        var durationTarget = Math.min(20, Math.max(12, duration + 3));
        var byteTargetSeconds = bitrate > 0 ?
            MSE_TARGET_BUFFER_BYTES * 8 / bitrate : durationTarget;
        var forward = Math.max(6, Math.min(durationTarget, byteTargetSeconds));
        var back = Math.max(3, Math.min(8, forward / 2));
        return {
            maxBufferLength: forward,
            maxMaxBufferLength: Math.min(26, Math.max(12, forward + 6)),
            backBufferLength: back,
            maxBufferSize: MSE_TARGET_BUFFER_BYTES
        };
    }

    function createHlsConfig(slot, startPositionSeconds) {
        var hlsConfig = {
            manifestLoadingTimeOut: 20000,
            debug: false,
            testBandwidth: false,
            // Keep TS demuxing and MP4 remuxing off the playback/UI thread.
            // The worker is packaged with the extension, so it does not
            // depend on a blob URL or remote code.
            enableWorker: true,
            workerPath: chrome.runtime.getURL('hls.worker.js'),
            loader: slot.mediaCacheEnabled ?
                createMemoryLoaderClass(slot) : Hls.DefaultConfig.loader,
            emeEnabled: false
        };
        if (Number.isFinite(Number(startPositionSeconds)) &&
            Number(startPositionSeconds) >= 0) {
            // Start on the selected clip instead of downloading from the
            // beginning and then aborting that request with a second seek.
            hlsConfig.startPosition = Number(startPositionSeconds);
        }
        if (slot.forceClipCache) {
            // The raw HLS fragments stay in our ArrayBuffer cache. MSE has a
            // separate Chrome quota, so size the decoded window by bitrate
            // and let evicted fragments be re-appended from memory.
            var bufferSettings = clipBufferSettings(slot);
            hlsConfig.maxBufferLength = bufferSettings.maxBufferLength;
            hlsConfig.maxMaxBufferLength =
                bufferSettings.maxMaxBufferLength;
            hlsConfig.backBufferLength =
                bufferSettings.backBufferLength;
            hlsConfig.maxBufferSize = bufferSettings.maxBufferSize;
        }
        return hlsConfig;
    }

    function releaseMediaCache(slot) {
        slot.mediaCacheEnabled = false;
        if (slot.mediaCache) {
            slot.mediaCache.clear();
        }
        if (slot.mediaCacheInflight) {
            slot.mediaCacheInflight.clear();
        }
        slot.mediaCacheBytes = 0;
        slot.clipCacheBytes = 0;
        slot.clipCacheReady = false;
        slot.clipCacheProtectedKeys = null;
        slot.clipCacheWindow = null;
        slot.lastHlsError = null;
    }

    function cancelLoopSeek(slot) {
        clearTimeout(slot.loopSeekTimer);
        slot.loopSeekTimer = null;
        slot.loopSeeking = false;
    }

    function removeMediaCacheEntry(slot, key) {
        var entry = slot.mediaCache && slot.mediaCache.get(key);
        if (!entry) {
            return;
        }
        slot.mediaCache.delete(key);
        slot.mediaCacheBytes -= entry.size || 0;
    }

    function trimMediaCache(slot, protectedKeys) {
        if (!slot.mediaCache) {
            return false;
        }
        while (slot.mediaCacheBytes > slot.mediaCacheLimitBytes &&
            slot.mediaCache.size) {
            var removableKey = Array.from(slot.mediaCache.keys()).find(function (key) {
                return !protectedKeys || !protectedKeys.has(key);
            });
            if (!removableKey) {
                return false;
            }
            removeMediaCacheEntry(slot, removableKey);
        }
        return slot.mediaCacheBytes <= slot.mediaCacheLimitBytes;
    }

    function canonicalMediaUrl(value) {
        try {
            var parsed = new URL(String(value || ''), location.href);
            parsed.hash = '';
            Array.from(parsed.searchParams.keys()).forEach(function (name) {
                if (['api_key', 'deviceid', 'mediasourceid', 'x-emby-token']
                    .includes(name.toLowerCase())) {
                    parsed.searchParams.delete(name);
                }
            });
            var sorted = Array.from(parsed.searchParams.entries())
                .sort(function (first, second) {
                    return first[0].localeCompare(second[0]) ||
                        first[1].localeCompare(second[1]);
                });
            parsed.search = '';
            sorted.forEach(function (entry) {
                parsed.searchParams.append(entry[0], entry[1]);
            });
            return parsed.href;
        } catch (error) {
            return String(value || '');
        }
    }

    function mediaCacheKey(context) {
        return canonicalMediaUrl(context.url) + '|bytes=' +
            (Number(context.rangeStart) || 0) + '-' +
            (Number(context.rangeEnd) || 0);
    }

    function fragmentMetadata(fragment, url) {
        var start = Number(fragment && fragment.start);
        var duration = Number(fragment && fragment.duration);
        start = Number.isFinite(start) ? start : 0;
        duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
        return {
            url: url,
            start: start,
            duration: duration,
            end: start + duration
        };
    }

    function putMediaCache(slot, key, data, metadata, protectedKeys) {
        if (!slot.mediaCache || !(data instanceof ArrayBuffer)) {
            return false;
        }
        var previous = slot.mediaCache.get(key);
        if (previous) {
            removeMediaCacheEntry(slot, key);
        }
        var size = data.byteLength;
        if (!size || size > slot.mediaCacheLimitBytes) {
            if (previous) {
                slot.mediaCache.set(key, previous);
                slot.mediaCacheBytes += previous.size || 0;
            }
            return false;
        }
        // This is the immutable cache master. The HLS loader returns a copy
        // because the transmuxing worker transfers and detaches its input.
        slot.mediaCache.set(key, Object.assign({
            data: data,
            size: size
        }, metadata || {}));
        slot.mediaCacheBytes += size;
        if (!trimMediaCache(slot, protectedKeys)) {
            removeMediaCacheEntry(slot, key);
            if (previous) {
                slot.mediaCache.set(key, previous);
                slot.mediaCacheBytes += previous.size || 0;
            }
            return false;
        }
        return true;
    }

    function shouldCacheLoaderContext(slot, context) {
        return slot.mediaCacheEnabled &&
            context && context.frag && !context.keyInfo &&
            context.responseType === 'arraybuffer';
    }

    function createMemoryLoaderClass(slot) {
        var BaseLoader = Hls.DefaultConfig.loader;
        return function () {
            function MemoryLoader(config) {
                this.inner = new BaseLoader(config);
                this.stats = this.inner.stats;
                this.context = null;
                this.callbacks = null;
                this.cacheHit = false;
            }

            MemoryLoader.prototype.load = function (context, config, callbacks) {
                var loader = this;
                this.context = context;
                this.callbacks = callbacks;
                if (!shouldCacheLoaderContext(slot, context)) {
                    this.inner.load(context, config, callbacks);
                    return;
                }
                var key = mediaCacheKey(context);
                var cached = slot.mediaCache.get(key);
                if (cached) {
                    slot.mediaCache.delete(key);
                    slot.mediaCache.set(key, cached);
                    this.cacheHit = true;
                    slot.cacheHits = (slot.cacheHits || 0) + 1;
                    slot.lastCacheHitAt = performance.now();
                    slot.lastCacheHitKey = key;
                    slot.lastCacheHitBytes = cached.size;
                    var now = performance.now();
                    this.stats.loading.start = now;
                    this.stats.loading.first = now;
                    this.stats.loading.end = now;
                    this.stats.loaded = cached.size;
                    this.stats.total = cached.size;
                    diagnosticLog('cache-hit', {
                        state: diagnosticSlotState(slot),
                        url: diagnosticSafeUrl(context.url),
                        rangeStart: Number(context.rangeStart) || 0,
                        rangeEnd: Number(context.rangeEnd) || 0,
                        bytes: cached.size
                    });
                    queueMicrotask(function () {
                        if (!loader.callbacks || loader.stats.aborted) {
                            return;
                        }
                        callbacks.onSuccess({
                            url: context.url,
                            // Give every HLS.js load its own buffer. Some
                            // demux/decode paths may retain or transfer the
                            // supplied ArrayBuffer; reusing the cache's master
                            // instance can leave later loops undecodable.
                            data: cached.data.slice(0),
                            code: 200
                        }, loader.stats, context, null);
                    });
                    return;
                }
                if (slot.clipCacheReady) {
                    var missedUrl = canonicalMediaUrl(context.url);
                    slot.status.hidden = false;
                    slot.status.textContent = '内存缓存未命中：' +
                        missedUrl.replace(/^https?:\/\/[^/]+/i, '');
                    console.warn(
                        '[Emby Multi Window] clip cache miss after encoding stop:',
                        key
                    );
                    diagnosticLog('cache-miss-after-encoding-stop', {
                        state: diagnosticSlotState(slot),
                        url: diagnosticSafeUrl(context.url),
                        rangeStart: Number(context.rangeStart) || 0,
                        rangeEnd: Number(context.rangeEnd) || 0
                    }, 'error');
                }
                var wrappedCallbacks = Object.assign({}, callbacks, {
                    onSuccess: function (response, stats, loadedContext, networkDetails) {
                        var data = response && response.data;
                        if (slot.mediaCacheEnabled &&
                            data instanceof ArrayBuffer && data.byteLength &&
                            data.byteLength <= slot.mediaCacheLimitBytes) {
                            putMediaCache(
                                slot,
                                key,
                                // HLS.js transfers response.data to its Worker.
                                // Keep a separate, non-detached cache master.
                                data.slice(0),
                                fragmentMetadata(context.frag, context.url),
                                slot.clipCacheProtectedKeys
                            );
                        }
                        slot.cacheNetworkLoads = (slot.cacheNetworkLoads || 0) + 1;
                        diagnosticLog('cache-network-load', {
                            state: diagnosticSlotState(slot),
                            url: diagnosticSafeUrl(context.url),
                            rangeStart: Number(context.rangeStart) || 0,
                            rangeEnd: Number(context.rangeEnd) || 0,
                            bytes: data instanceof ArrayBuffer ?
                                data.byteLength : 0
                        });
                        callbacks.onSuccess(response, stats, loadedContext, networkDetails);
                    }
                });
                this.inner.load(context, config, wrappedCallbacks);
            };
            MemoryLoader.prototype.abort = function () {
                if (this.cacheHit) {
                    this.stats.aborted = true;
                    if (this.callbacks && this.callbacks.onAbort) {
                        this.callbacks.onAbort(this.stats, this.context, null);
                    }
                } else {
                    this.inner.abort();
                }
            };
            MemoryLoader.prototype.destroy = function () {
                this.callbacks = null;
                this.context = null;
                if (this.inner) {
                    this.inner.destroy();
                }
                this.inner = null;
            };
            MemoryLoader.prototype.getCacheAge = function () {
                return this.cacheHit ? 0 :
                    (this.inner.getCacheAge ? this.inner.getCacheAge() : null);
            };
            MemoryLoader.prototype.getResponseHeader = function (name) {
                return this.inner.getResponseHeader ?
                    this.inner.getResponseHeader(name) : null;
            };
            return MemoryLoader;
        }();
    }

    if (new URLSearchParams(location.search).has('cacheTest')) {
        window.__embyMultiWindowCacheTest = {
            createLoaderClass: createMemoryLoaderClass,
            release: releaseMediaCache,
            put: putMediaCache,
            plan: clipFragmentPlan,
            playbackFragment: clipPlaybackFragment,
            planWindow: clipCacheWindow,
            planCoversWindow: planCoversWindow,
            createCacheStream: createClipCacheStream,
            planStream: waitForClipFragmentPlan,
            fetchFragment: fetchClipFragment,
            cacheSegment: cacheActiveSegment,
            shouldUseHlsJs: shouldUseHlsJs,
            cacheKey: mediaCacheKey,
            bufferedRangeAt: bufferedRangeAt,
            bufferSettings: clipBufferSettings,
            hlsConfig: createHlsConfig,
            attachStream: attachStream,
            waitPlaybackReady: waitForClipPlaybackReady,
            restartLoop: restartSegmentLoop,
            finishLoopSeek: finishSegmentLoopSeek,
            transientStatus: showTransientPlaybackStatus,
            diagnosticState: diagnosticSlotState,
            diagnosticUrl: diagnosticSafeUrl
        };
    }

    function displayName(item) {
        var parts = [];
        if (item.SeriesName) {
            parts.push(item.SeriesName);
        }
        if (item.ParentIndexNumber != null && item.IndexNumber != null) {
            parts.push('S' + String(item.ParentIndexNumber).padStart(2, '0') +
                'E' + String(item.IndexNumber).padStart(2, '0'));
        }
        if (item.Name && !parts.includes(item.Name)) {
            parts.push(item.Name);
        }
        return parts.join(' · ') || item.Name || item.Id || '未知视频';
    }

    function normalizeSegment(segment, index) {
        return {
            id: String(segment.id || segment.Id || index + 1),
            name: segment.name || segment.Name || ('片段 ' + (index + 1)),
            startMs: Math.max(0, Number(segment.startMs != null ? segment.startMs : segment.StartMs) || 0),
            endMs: Math.max(0, Number(segment.endMs != null ? segment.endMs : segment.EndMs) || 0),
            order: Number(segment.order != null ? segment.order : segment.Order) || index + 1
        };
    }

    function postJson(url, body, keepalive) {
        return fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
            keepalive: !!keepalive
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
        });
    }

    function playbackReport(slot, eventName) {
        var video = slot.video;
        return {
            ItemId: slot.item.Id,
            MediaSourceId: slot.mediaSource.Id,
            PlaySessionId: slot.stream.playSessionId,
            PositionTicks: Math.max(0, Math.round((video.currentTime || 0) * 10000000)),
            IsPaused: video.paused,
            IsMuted: video.muted,
            VolumeLevel: Math.round((video.volume == null ? 1 : video.volume) * 100),
            CanSeek: Number.isFinite(video.duration) && video.duration > 0,
            PlayMethod: slot.stream.playMethod,
            AudioStreamIndex: slot.mediaSource.DefaultAudioStreamIndex,
            SubtitleStreamIndex: slot.mediaSource.DefaultSubtitleStreamIndex == null ?
                -1 : slot.mediaSource.DefaultSubtitleStreamIndex,
            EventName: eventName || undefined
        };
    }

    function reportStart(slot) {
        if (slot.startReported || slot.stopped) {
            return;
        }
        slot.startReported = true;
        postJson(slot.endpoints.reportStart, playbackReport(slot)).catch(function (error) {
            console.warn('[Emby Multi Window] start report failed', error);
        });
    }

    function reportProgress(slot, eventName) {
        if (!slot.startReported || slot.stopped) {
            return;
        }
        postJson(slot.endpoints.reportProgress, playbackReport(slot, eventName || 'timeupdate'))
            .catch(function (error) {
                console.warn('[Emby Multi Window] progress report failed', error);
            });
    }

    function reportStopped(slot, keepalive) {
        if (slot.stopped) {
            return Promise.resolve();
        }
        slot.stopped = true;
        clearInterval(slot.progressTimer);
        var requests = [];
        if (slot.startReported) {
            requests.push(postJson(
                slot.endpoints.reportStopped,
                playbackReport(slot),
                keepalive
            ).catch(function () {}));
        }
        requests.push(fetch(slot.endpoints.stopEncoding, {
            method: 'POST',
            keepalive: !!keepalive
        }).catch(function () {}));
        return Promise.allSettled(requests);
    }

    function seek(video, milliseconds) {
        var seconds = Math.max(0, Number(milliseconds) / 1000 || 0);
        try {
            if (typeof video.fastSeek === 'function') {
                video.fastSeek(seconds);
            } else {
                video.currentTime = seconds;
            }
        } catch (error) {
            video.currentTime = seconds;
        }
    }

    function seekExact(video, milliseconds) {
        video.currentTime = Math.max(0, Number(milliseconds) / 1000 || 0);
    }

    function updateGrid() {
        var count = slots.size;
        empty.hidden = count > 0;
        var columns = count <= 1 ? 1 : 2;
        var rows = Math.max(1, Math.ceil(count / columns));
        grid.style.gridTemplateColumns = 'repeat(' + columns + ', minmax(0, 1fr))';
        grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
        document.title = count ? 'Emby 多画面 · ' + count : 'Emby 多画面';
    }

    function clearDragState() {
        grid.querySelectorAll('.dragging,.drop-before,.drop-after').forEach(function (element) {
            element.classList.remove('dragging', 'drop-before', 'drop-after');
        });
        dragState = null;
    }

    function commitDragState() {
        if (!dragState || !dragState.target || dragState.tile === dragState.target) {
            clearDragState();
            return false;
        }
        grid.insertBefore(
            dragState.tile,
            dragState.after ? dragState.target.nextSibling : dragState.target
        );
        clearDragState();
        showToast('已调整画面顺序');
        return true;
    }

    function moveTileByKeyboard(tile, direction) {
        var tiles = Array.from(grid.querySelectorAll('.tile'));
        var index = tiles.indexOf(tile);
        var nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= tiles.length) {
            return;
        }
        if (direction < 0) {
            grid.insertBefore(tile, tiles[nextIndex]);
        } else {
            grid.insertBefore(tile, tiles[nextIndex].nextSibling);
        }
        showToast('已调整画面顺序');
    }

    function destroyMedia(slot) {
        clearInterval(slot.progressTimer);
        clearInterval(slot.diagnosticTimer);
        clearTimeout(slot.videoDecodeTimer);
        clearTimeout(slot.waitingTimer);
        clearTimeout(slot.statusHideTimer);
        cancelSegmentBoundaryMonitor(slot);
        cancelLoopSeek(slot);
        cancelClipCache(slot, false);
        if (slot.hls) {
            try {
                slot.hls.destroy();
            } catch (error) {}
            slot.hls = null;
            slot.hlsMemoryLoaderEnabled = false;
        }
        releaseMediaCache(slot);
        try {
            slot.video.pause();
            slot.video.removeAttribute('src');
            slot.video.load();
        } catch (error) {}
    }

    function streamMatches(first, second) {
        return !!first && !!second &&
            (first === second || first.url === second.url);
    }

    function isHlsStream(stream) {
        return !!stream && (!!stream.isHls ||
            /\.m3u8(?:$|[?#])/i.test(String(stream.url || '')));
    }

    function shouldUseHlsJs(slot, stream) {
        return isHlsStream(stream) &&
            (slot.mediaCacheEnabled ||
                !slot.video.canPlayType('application/vnd.apple.mpegurl'));
    }

    function detachStream(slot, releaseCache, preserveClipCache) {
        if (!preserveClipCache) {
            cancelClipCache(slot, false);
        }
        clearTimeout(slot.videoDecodeTimer);
        clearTimeout(slot.waitingTimer);
        clearTimeout(slot.statusHideTimer);
        cancelLoopSeek(slot);
        if (slot.hls) {
            try {
                slot.hls.destroy();
            } catch (error) {}
            slot.hls = null;
            slot.hlsMemoryLoaderEnabled = false;
        }
        if (releaseCache) {
            releaseMediaCache(slot);
        }
        try {
            slot.video.pause();
            slot.video.removeAttribute('src');
            slot.video.load();
        } catch (error) {}
    }

    function switchSlotStream(
        slot,
        targetStream,
        reason,
        automaticFallback,
        startPositionMs,
        preserveClipCache
    ) {
        if (!targetStream || slot.stopped || streamMatches(slot.stream, targetStream)) {
            return Promise.resolve(false);
        }
        var resumeMs = Number.isFinite(Number(startPositionMs)) ?
            Math.max(0, Number(startPositionMs)) :
            Math.max(0, (slot.video.currentTime || 0) * 1000);
        var wasPaused = slot.video.paused;
        slot.switchingStream = true;
        slot.fallbackStarted = !!automaticFallback;
        slot.status.hidden = false;
        slot.status.textContent = reason || '正在切换播放方式…';
        detachStream(
            slot,
            !isHlsStream(targetStream),
            !!preserveClipCache
        );
        // Opening a pane defaults to direct play. HLS memory caching is enabled
        // only for an explicitly selected clip or a manual cache-first switch.
        slot.mediaCacheEnabled = isHlsStream(targetStream) &&
            slot.forceClipCache;
        slot.stream = targetStream;
        slot.fallbackStream = streamMatches(targetStream, slot.directStream) ?
            slot.cacheStream : null;
        return attachStream(
            slot,
            targetStream,
            resumeMs / 1000
        ).then(function () {
            if (wasPaused) {
                slot.video.pause();
            }
            slot.switchingStream = false;
            return true;
        }).catch(function (error) {
            slot.switchingStream = false;
            slot.status.hidden = false;
            slot.status.textContent = error.message || '切换播放方式失败';
            throw error;
        });
    }

    function switchToFallback(slot, reason) {
        var fallbackStream = slot.cacheStream || slot.fallbackStream;
        if (!fallbackStream || slot.fallbackStarted || slot.stopped ||
            streamMatches(slot.stream, fallbackStream)) {
            return Promise.resolve(false);
        }
        console.warn('[Emby Multi Window] Native video fallback:', reason);
        return switchSlotStream(
            slot,
            fallbackStream,
            '原始视频无法正常解码，正在切换兼容缓存播放…',
            true
        );
    }

    function scheduleNativeDecodeCheck(slot) {
        if (!slot.cacheStream || !slot.stream.nativeTrial || slot.fallbackStarted) {
            return;
        }
        clearTimeout(slot.videoDecodeTimer);
        var startTime = slot.video.currentTime || 0;
        var startFrames = 0;
        if (slot.video.getVideoPlaybackQuality) {
            startFrames = slot.video.getVideoPlaybackQuality().totalVideoFrames || 0;
        }
        var renderedFrame = false;
        if (typeof slot.video.requestVideoFrameCallback === 'function') {
            slot.video.requestVideoFrameCallback(function () {
                renderedFrame = true;
            });
        }
        slot.videoDecodeTimer = setTimeout(function () {
            var advanced = (slot.video.currentTime || 0) - startTime > 1;
            var currentFrames = slot.video.getVideoPlaybackQuality ?
                slot.video.getVideoPlaybackQuality().totalVideoFrames || 0 : 0;
            var hasVideoFrame = renderedFrame || currentFrames > startFrames;
            if (advanced && (slot.video.videoWidth === 0 || !hasVideoFrame)) {
                switchToFallback(slot, 'audio advanced without decoded video frames')
                    .catch(function () {});
            }
        }, 3500);
    }

    function removeSlot(id) {
        var slot = slots.get(id);
        if (!slot) {
            return;
        }
        reportStopped(slot);
        slots.delete(id);
        destroyMedia(slot);
        slot.tile.remove();
        updateGrid();
    }

    function populateSegments(slot) {
        var select = slot.segmentSelect;
        select.innerHTML = '';
        var full = document.createElement('option');
        full.value = '';
        full.textContent = slot.segments.length ? '完整视频（不循环）' : '没有已保存片段';
        select.appendChild(full);
        slot.segments.forEach(function (segment) {
            var option = document.createElement('option');
            option.value = segment.id;
            option.textContent = segment.name + '  ' + formatTime(segment.startMs / 1000) +
                '–' + formatTime(segment.endMs / 1000);
            option.dataset.originalText = option.textContent;
            select.appendChild(option);
        });
        select.disabled = !slot.segments.length;
    }

    function loadSegments(slot) {
        return fetch(slot.endpoints.segments).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        }).catch(function () {
            return slot.localSegments || [];
        }).then(function (segments) {
            slot.segments = (Array.isArray(segments) ? segments : [])
                .map(normalizeSegment)
                .filter(function (segment) {
                    return segment.endMs > segment.startMs;
                })
                .sort(function (a, b) {
                    return a.order - b.order || a.startMs - b.startMs;
                });
            populateSegments(slot);
        });
    }

    function formatBytes(bytes) {
        bytes = Math.max(0, Number(bytes) || 0);
        if (bytes < 1024 * 1024) {
            return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
        }
        return (bytes / 1024 / 1024).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0) +
            ' MB';
    }

    function setSegmentCacheLabel(slot, prefix, title) {
        if (!slot.segmentSelect) {
            return;
        }
        Array.from(slot.segmentSelect.options).forEach(function (option) {
            if (option.dataset.originalText) {
                option.textContent = option.dataset.originalText;
            }
        });
        var selected = slot.segmentSelect.selectedOptions[0];
        if (prefix && selected && selected.dataset.originalText) {
            selected.textContent = prefix + ' · ' + selected.dataset.originalText;
        }
        slot.segmentSelect.title = title || '';
    }

    function cancelClipCache(slot, resumeHls) {
        slot.clipCacheGeneration = (slot.clipCacheGeneration || 0) + 1;
        if (slot.clipCacheController) {
            slot.clipCacheController.abort();
            slot.clipCacheController = null;
        }
        var abandonedStream = slot.clipCacheStream;
        slot.clipCacheStream = null;
        if (abandonedStream && !streamMatches(slot.stream, abandonedStream)) {
            stopActiveEncoding(slot, abandonedStream).catch(function () {});
        }
        slot.clipCacheLoading = false;
        slot.clipCacheReady = false;
        slot.clipCacheProtectedKeys = null;
        if (resumeHls && slot.hls && !slot.stopped) {
            try {
                slot.hls.startLoad(slot.video.currentTime || -1);
            } catch (error) {}
        }
    }

    function currentLevelDetails(slot) {
        if (!slot.hls) {
            return null;
        }
        if (slot.hls.latestLevelDetails) {
            return slot.hls.latestLevelDetails;
        }
        var levelIndex = slot.hls.currentLevel;
        if (levelIndex < 0) {
            levelIndex = slot.hls.loadLevel;
        }
        var level = slot.hls.levels && slot.hls.levels[levelIndex];
        return level && level.details || null;
    }

    function mediaDurationSeconds(slot) {
        var runtimeTicks = Number(slot && slot.item && slot.item.RunTimeTicks) ||
            Number(slot && slot.mediaSource && slot.mediaSource.RunTimeTicks);
        if (runtimeTicks > 0) {
            return runtimeTicks / 10000000;
        }
        var videoDuration = Number(slot && slot.video && slot.video.duration);
        return Number.isFinite(videoDuration) && videoDuration > 0 ?
            videoDuration : 0;
    }

    function clipCacheWindow(slot, segment, details) {
        var fragments = details && details.fragments || [];
        var longestFragment = fragments.reduce(function (longest, fragment) {
            return Math.max(longest, Number(fragment.duration) || 0);
        }, 0);
        // Four full HLS fragments covers keyframe lookup, audio priming and
        // timestamp drift. Keep at least 30 seconds because some source files
        // have unusually long GOPs or inaccurate saved segment boundaries.
        var guard = Math.min(
            CLIP_CACHE_MAX_GUARD_SECONDS,
            Math.max(CLIP_CACHE_GUARD_SECONDS, longestFragment * 4)
        );
        var start = Math.max(0, segment.startMs / 1000 - guard);
        var end = segment.endMs / 1000 + guard;
        var duration = mediaDurationSeconds(slot);
        if (duration > 0) {
            end = Math.min(duration, end);
        }
        return {
            start: start,
            end: Math.max(start, end),
            guardSeconds: guard
        };
    }

    function clipFragmentPlan(
        slot,
        segment,
        suppliedDetails,
        suppliedWindow
    ) {
        var details = suppliedDetails || currentLevelDetails(slot);
        var windowRange = suppliedWindow ||
            clipCacheWindow(slot, segment, details);
        return (details && details.fragments || []).map(function (fragment) {
            var metadata = fragmentMetadata(fragment, fragment.url);
            var rangeStart = Number(fragment.byteRangeStartOffset);
            var rangeEnd = Number(fragment.byteRangeEndOffset);
            rangeStart = Number.isFinite(rangeStart) ? rangeStart : 0;
            rangeEnd = Number.isFinite(rangeEnd) ? rangeEnd : 0;
            return Object.assign(metadata, {
                fragment: fragment,
                rangeStart: rangeStart,
                rangeEnd: rangeEnd,
                key: mediaCacheKey({
                    url: fragment.url,
                    rangeStart: rangeStart,
                    rangeEnd: rangeEnd
                })
            });
        }).filter(function (entry) {
            // HLS.js may request preceding keyframe/decode data and can buffer
            // slightly beyond the loop boundary. Cache a bounded guard area so
            // those requests still hit memory after the encoding is stopped.
            return entry.end > windowRange.start &&
                entry.start < windowRange.end;
        }).sort(function (first, second) {
            return first.start - second.start;
        });
    }

    function clipPlaybackFragment(plan, segment) {
        var startSeconds = Math.max(0, Number(segment && segment.startMs) || 0) /
            1000;
        return (plan || []).find(function (entry) {
            return entry.start <= startSeconds && entry.end > startSeconds;
        }) || (plan || []).find(function (entry) {
            return entry.end > startSeconds;
        }) || null;
    }

    function planCoversWindow(plan, windowRange) {
        if (!plan.length) {
            return false;
        }
        if (plan[0].start > windowRange.start + 0.5 ||
            plan[plan.length - 1].end < windowRange.end - 0.5) {
            return false;
        }
        return !plan.some(function (entry, index) {
            return index > 0 && entry.start > plan[index - 1].end + 0.5;
        });
    }

    function createPlaybackSessionId() {
        if (crypto.randomUUID) {
            return crypto.randomUUID().replace(/-/g, '');
        }
        return Date.now().toString(36) +
            Math.random().toString(36).slice(2) +
            Math.random().toString(36).slice(2);
    }

    function createClipCacheStream(slot, windowRange) {
        var template = slot.cacheStreamTemplate || slot.cacheStream;
        if (!template || !isHlsStream(template)) {
            return null;
        }
        var playSessionId = createPlaybackSessionId();
        var url = new URL(template.url, location.href);
        url.searchParams.set('PlaySessionId', playSessionId);
        url.searchParams.set(
            'StartTimeTicks',
            String(Math.max(0, Math.round(windowRange.start * 10000000)))
        );
        return Object.assign({}, template, {
            url: url.href,
            playSessionId: playSessionId,
            isHls: true,
            cacheWindowStart: windowRange.start
        });
    }

    function playlistVariantUrl(text, baseUrl, cacheStream) {
        var lines = String(text || '').split(/\r?\n/);
        for (var index = 0; index < lines.length; index += 1) {
            if (!/^#EXT-X-STREAM-INF:/i.test(lines[index].trim())) {
                continue;
            }
            for (var next = index + 1; next < lines.length; next += 1) {
                var candidate = lines[next].trim();
                if (!candidate) {
                    continue;
                }
                if (candidate.charAt(0) !== '#') {
                    return authenticatedFragmentUrl(
                        null,
                        new URL(candidate, baseUrl).href,
                        cacheStream
                    );
                }
            }
        }
        return '';
    }

    function parseMediaPlaylist(text, playlistUrl) {
        var lines = String(text || '').split(/\r?\n/);
        var fragments = [];
        var mediaSequence = 0;
        var timeline = 0;
        var pendingDuration = null;
        var pendingRange = null;
        var nextRangeStart = 0;
        var targetDuration = 0;
        lines.forEach(function (rawLine) {
            var line = rawLine.trim();
            var match;
            if (!line) {
                return;
            }
            match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(line);
            if (match) {
                mediaSequence = Number(match[1]) || 0;
                return;
            }
            match = /^#EXT-X-TARGETDURATION:([\d.]+)/i.exec(line);
            if (match) {
                targetDuration = Number(match[1]) || 0;
                return;
            }
            match = /^#EXTINF:([\d.]+)/i.exec(line);
            if (match) {
                pendingDuration = Number(match[1]) || 0;
                return;
            }
            match = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i.exec(line);
            if (match) {
                var length = Number(match[1]) || 0;
                var offset = match[2] == null ?
                    nextRangeStart : Number(match[2]) || 0;
                pendingRange = {
                    start: offset,
                    end: offset + length
                };
                nextRangeStart = offset + length;
                return;
            }
            if (line.charAt(0) === '#' || pendingDuration == null) {
                return;
            }
            var duration = Math.max(0, pendingDuration);
            fragments.push({
                sn: mediaSequence + fragments.length,
                start: timeline,
                duration: duration,
                url: new URL(line, playlistUrl).href,
                byteRangeStartOffset: pendingRange ?
                    pendingRange.start : 0,
                byteRangeEndOffset: pendingRange ?
                    pendingRange.end : 0
            });
            timeline += duration;
            pendingDuration = null;
            pendingRange = null;
        });
        if (!fragments.length) {
            throw new Error('HLS 媒体清单中没有分片');
        }
        return {
            fragments: fragments,
            targetduration: targetDuration
        };
    }

    async function fetchPlaylistText(url, cacheStream, signal) {
        var response = await fetch(
            authenticatedFragmentUrl(null, url, cacheStream),
            {
                method: 'GET',
                cache: 'no-store',
                credentials: 'omit',
                signal: signal
            }
        );
        if (!response.ok) {
            throw new Error('HLS 清单 HTTP ' + response.status);
        }
        return response.text();
    }

    async function loadClipPlaylistDetails(slot, cacheStream, signal) {
        var masterText = await fetchPlaylistText(
            cacheStream.url,
            cacheStream,
            signal
        );
        var mediaUrl = cacheStream.url;
        var mediaText = masterText;
        if (!/#EXTINF:/i.test(masterText)) {
            mediaUrl = playlistVariantUrl(
                masterText,
                cacheStream.url,
                cacheStream
            );
            if (!mediaUrl) {
                throw new Error('HLS 主清单中没有媒体清单地址');
            }
            mediaText = await fetchPlaylistText(
                mediaUrl,
                cacheStream,
                signal
            );
        }
        var details = parseMediaPlaylist(mediaText, mediaUrl);
        diagnosticLog('clip-cache-playlist-loaded', {
            masterUrl: diagnosticSafeUrl(cacheStream.url),
            mediaUrl: diagnosticSafeUrl(mediaUrl),
            fragmentCount: details.fragments.length,
            targetDuration: details.targetduration,
            state: diagnosticSlotState(slot)
        });
        return details;
    }

    async function waitForClipFragmentPlan(
        slot,
        segment,
        cacheStream,
        windowRange,
        signal
    ) {
        if (typeof slot.clipCachePlanProvider === 'function') {
            return Promise.resolve(
                slot.clipCachePlanProvider(cacheStream, windowRange, signal)
            ).then(function (details) {
                var testPlan = clipFragmentPlan(
                    slot,
                    segment,
                    details,
                    windowRange
                );
                if (!planCoversWindow(testPlan, windowRange)) {
                    throw new Error('测试清单没有覆盖片段保护区');
                }
                return {
                    plan: testPlan,
                    windowRange: windowRange
                };
            });
        }
        var details = await loadClipPlaylistDetails(
            slot,
            cacheStream,
            signal
        );
        var plan = clipFragmentPlan(
            slot,
            segment,
            details,
            windowRange
        );
        if (!planCoversWindow(plan, windowRange)) {
            throw new Error('HLS 清单没有覆盖片段保护区');
        }
        return {
            plan: plan,
            windowRange: windowRange
        };
    }

    function authenticatedFragmentUrl(slot, fragmentUrl, cacheStream) {
        cacheStream = cacheStream || slot.clipCacheStream || slot.cacheStream;
        var parsed = new URL(fragmentUrl, cacheStream.url);
        var source = new URL(cacheStream.url);
        ['api_key', 'DeviceId', 'MediaSourceId', 'PlaySessionId'].forEach(function (name) {
            if (!parsed.searchParams.has(name) && source.searchParams.has(name)) {
                parsed.searchParams.set(name, source.searchParams.get(name));
            }
        });
        return parsed.href;
    }

    function waitForRetry(milliseconds, signal) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(resolve, milliseconds);
            if (signal) {
                signal.addEventListener('abort', function () {
                    clearTimeout(timer);
                    var error = new Error('Aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, {once: true});
            }
        });
    }

    async function fetchClipFragment(
        slot,
        entry,
        protectedKeys,
        signal,
        cacheStream
    ) {
        if (!slot.mediaCacheInflight) {
            slot.mediaCacheInflight = new Map();
        }
        var existing = slot.mediaCache.get(entry.key);
        if (existing) {
            return existing.size || 0;
        }
        var inflight = slot.mediaCacheInflight &&
            slot.mediaCacheInflight.get(entry.key);
        if (inflight) {
            await inflight;
            existing = slot.mediaCache.get(entry.key);
            if (existing) {
                return existing.size || 0;
            }
        }
        var headers = {};
        if (entry.rangeEnd > entry.rangeStart) {
            headers.Range = 'bytes=' + entry.rangeStart + '-' + (entry.rangeEnd - 1);
        }
        diagnosticLog('clip-fragment-fetch-start', {
            url: diagnosticSafeUrl(entry.url),
            start: entry.start,
            end: entry.end,
            rangeStart: entry.rangeStart,
            rangeEnd: entry.rangeEnd,
            state: diagnosticSlotState(slot)
        });
        var requestStartedAt = performance.now();
        var request = (async function () {
            var response;
            var attempt = 0;
            for (attempt = 0; attempt < 7; attempt += 1) {
                response = await fetch(
                    authenticatedFragmentUrl(slot, entry.url, cacheStream),
                    {
                        method: 'GET',
                        headers: headers,
                        cache: 'no-store',
                        credentials: 'omit',
                        signal: signal
                    }
                );
                if (response.ok) {
                    break;
                }
                diagnosticLog('clip-fragment-fetch-retry', {
                    url: diagnosticSafeUrl(entry.url),
                    status: response.status,
                    attempt: attempt + 1,
                    state: diagnosticSlotState(slot)
                }, 'warn');
                if (![404, 409, 425, 500, 503].includes(response.status) ||
                    attempt === 6) {
                    throw new Error('分片 HTTP ' + response.status);
                }
                await waitForRetry(Math.min(2000, 250 * Math.pow(2, attempt)), signal);
            }
            var data = await response.arrayBuffer();
            slot.cacheNetworkLoads = (slot.cacheNetworkLoads || 0) + 1;
            if (!putMediaCache(slot, entry.key, data, {
                url: entry.url,
                start: entry.start,
                duration: entry.duration,
                end: entry.end,
                clipPrefetched: true
            }, protectedKeys)) {
                throw new Error('片段超过当前 ' +
                    Math.round(slot.mediaCacheLimitBytes / 1024 / 1024) +
                    ' MB 内存上限');
            }
            diagnosticLog('clip-fragment-fetch-complete', {
                url: diagnosticSafeUrl(entry.url),
                start: entry.start,
                end: entry.end,
                bytes: data.byteLength,
                attempts: attempt + 1,
                durationMs: Math.round(performance.now() - requestStartedAt),
                state: diagnosticSlotState(slot)
            });
            return data.byteLength;
        }());
        slot.mediaCacheInflight.set(entry.key, request);
        try {
            return await request;
        } finally {
            if (slot.mediaCacheInflight.get(entry.key) === request) {
                slot.mediaCacheInflight.delete(entry.key);
            }
        }
    }

    async function prefetchClipFragments(
        slot,
        plan,
        protectedKeys,
        controller,
        generation,
        cacheStream
    ) {
        var completed = 0;
        var cachedBytes = 0;
        var startedAt = performance.now();
        for (var index = 0; index < plan.length; index += 1) {
            if (slot.clipCacheGeneration !== generation) {
                return {
                    bytes: cachedBytes,
                    durationMs: performance.now() - startedAt
                };
            }
            var bytes = await fetchClipFragment(
                slot,
                plan[index],
                protectedKeys,
                controller.signal,
                cacheStream
            );
            cachedBytes += bytes;
            completed += 1;
            var elapsedSeconds = Math.max(
                0.001,
                (performance.now() - startedAt) / 1000
            );
            var speedText = formatBytes(cachedBytes / elapsedSeconds) + '/s';
            slot.status.textContent = '边播边缓存 ' + completed + '/' +
                plan.length + ' · ' + formatBytes(cachedBytes) +
                ' · ' + speedText;
            setSegmentCacheLabel(
                slot,
                '缓存 ' + completed + '/' + plan.length,
                '正在边播边缓存：' + formatBytes(cachedBytes) +
                    '，平均 ' + speedText
            );
        }
        return {
            bytes: cachedBytes,
            durationMs: performance.now() - startedAt
        };
    }

    function waitForClipPlaybackReady(slot, segment) {
        var video = slot.video;
        var startSeconds = segment.startMs / 1000;
        if (!video.addEventListener || !video.removeEventListener) {
            seekExact(video, segment.startMs);
            return Promise.resolve(video.play()).then(function () {});
        }
        return new Promise(function (resolve, reject) {
            var settled = false;
            var decodedFrame = false;
            var playRequested = false;
            var events = [
                'loadedmetadata',
                'canplay',
                'playing',
                'progress',
                'seeked',
                'timeupdate'
            ];
            var timer = setTimeout(function () {
                finish(new Error(
                    '片段起点已缓存，但 ' +
                    Math.round(CLIP_READY_TIMEOUT_MS / 1000) +
                    ' 秒内没有开始播放'
                ));
            }, CLIP_READY_TIMEOUT_MS);

            function cleanup() {
                clearTimeout(timer);
                events.forEach(function (eventName) {
                    video.removeEventListener(eventName, check);
                });
            }

            function finish(error) {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            }

            function requestPlayback() {
                if (playRequested || settled) {
                    return;
                }
                playRequested = true;
                diagnosticLog('clip-play-request-after-buffer', {
                    state: diagnosticSlotState(slot)
                });
                var playPromise;
                try {
                    playPromise = video.play();
                } catch (error) {
                    finish(error);
                    return;
                }
                if (typeof video.requestVideoFrameCallback === 'function') {
                    video.requestVideoFrameCallback(function () {
                        if (settled) {
                            return;
                        }
                        diagnosticLog('clip-first-frame-after-buffer', {
                            state: diagnosticSlotState(slot)
                        });
                        finish();
                    });
                }
                Promise.resolve(playPromise).then(function () {
                    diagnosticLog('clip-play-started-after-buffer', {
                        state: diagnosticSlotState(slot)
                    });
                    finish();
                }).catch(function (error) {
                    if (error.name === 'NotAllowedError') {
                        slot.status.hidden = false;
                        slot.status.textContent = '片段已缓冲，点击画面开始播放';
                        finish();
                        return;
                    }
                    finish(error);
                });
            }

            function check(event) {
                if (playRequested && event && event.type === 'playing') {
                    diagnosticLog('clip-playing-after-buffer', {
                        state: diagnosticSlotState(slot)
                    });
                    finish();
                    return;
                }
                var range = bufferedRangeAt(video, startSeconds);
                var hasDecodedDimensions = video.videoWidth > 0 &&
                    video.videoHeight > 0;
                var hasCurrentData = video.readyState >=
                    HTMLMediaElement.HAVE_CURRENT_DATA;
                if (range && range.ahead >= 0.35 && !video.seeking &&
                    (decodedFrame || hasDecodedDimensions || hasCurrentData)) {
                    requestPlayback();
                }
            }

            events.forEach(function (eventName) {
                video.addEventListener(eventName, check);
            });
            if (typeof video.requestVideoFrameCallback === 'function') {
                video.requestVideoFrameCallback(function () {
                    decodedFrame = true;
                    check();
                });
            }
            seekExact(video, segment.startMs);
            check();
        });
    }

    function restartSegmentLoop(slot) {
        if (!slot.activeSegment || slot.loopSeeking) {
            return;
        }
        diagnosticLog('loop-seek-start', {
            targetSeconds: slot.activeSegment.startMs / 1000,
            state: diagnosticSlotState(slot)
        });
        slot.loopSeeking = true;
        clearTimeout(slot.loopSeekTimer);
        seekExact(slot.video, slot.activeSegment.startMs);
        // A seek itself makes HLS.js choose the required fragment. Repeatedly
        // stopping and restarting its controllers here races SourceBuffer
        // updates and can leave audio and video on different append cycles.
        slot.video.play().catch(function () {});
        slot.loopSeekTimer = setTimeout(function () {
            diagnosticLog('loop-seek-timeout', {
                state: diagnosticSlotState(slot)
            }, 'warn');
            slot.loopSeeking = false;
            slot.loopSeekTimer = null;
        }, LOOP_SEEK_TIMEOUT_MS);
    }

    function cancelSegmentBoundaryMonitor(slot) {
        if (slot && slot.segmentFrameCallbackId != null &&
            slot.video &&
            typeof slot.video.cancelVideoFrameCallback === 'function') {
            try {
                slot.video.cancelVideoFrameCallback(slot.segmentFrameCallbackId);
            } catch (error) {}
        }
        if (slot) {
            slot.segmentFrameCallbackId = null;
        }
    }

    function startSegmentBoundaryMonitor(slot) {
        var video = slot && slot.video;
        if (!video ||
            typeof video.requestVideoFrameCallback !== 'function' ||
            slot.segmentFrameCallbackId != null) {
            return;
        }
        function checkFrame(now, metadata) {
            slot.segmentFrameCallbackId = null;
            if (slot.stopped) {
                return;
            }
            if (slot.activeSegment && !slot.loopSeeking && !video.seeking) {
                var mediaTime = Number(metadata && metadata.mediaTime);
                var currentMs = (
                    Number.isFinite(mediaTime) ? mediaTime : video.currentTime
                ) * 1000;
                if (currentMs < slot.activeSegment.startMs - 500 ||
                    currentMs >= slot.activeSegment.endMs) {
                    restartSegmentLoop(slot);
                }
            }
            slot.segmentFrameCallbackId =
                video.requestVideoFrameCallback(checkFrame);
        }
        slot.segmentFrameCallbackId =
            video.requestVideoFrameCallback(checkFrame);
    }

    function finishSegmentLoopSeek(slot) {
        clearTimeout(slot.loopSeekTimer);
        slot.loopSeekTimer = null;
        slot.loopSeeking = false;
        diagnosticLog('loop-seek-complete', {
            state: diagnosticSlotState(slot)
        });
    }

    function stopActiveEncoding(slot, stream) {
        var url = new URL(slot.endpoints.stopEncoding, location.href);
        var playSessionId = stream && stream.playSessionId;
        if (playSessionId) {
            url.searchParams.set('PlaySessionId', playSessionId);
        }
        return fetch(url.href, {
            method: 'POST'
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('停止转码 HTTP ' + response.status);
            }
        });
    }

    async function cacheActiveSegment(slot) {
        var segment = slot.activeSegment;
        if (!segment || slot.stopped) {
            return;
        }
        diagnosticLog('clip-cache-start', {
            segment: {
                id: segment.id,
                name: segment.name,
                startMs: segment.startMs,
                endMs: segment.endMs
            },
            state: diagnosticSlotState(slot)
        });
        cancelClipCache(slot, false);
        releaseMediaCache(slot);
        var cacheTemplate = slot.cacheStreamTemplate || slot.cacheStream;
        if (!cacheTemplate || !isHlsStream(cacheTemplate)) {
            showToast('当前视频没有可用于片段缓存的 HLS 流。', 4800);
            return;
        }
        cacheTemplate.isHls = true;
        slot.forceClipCache = false;
        if (slot.directStream && !streamMatches(slot.stream, slot.directStream)) {
            try {
                await switchSlotStream(
                    slot,
                    slot.directStream,
                    '正在恢复直连并后台缓存片段…',
                    false,
                    segment.startMs
                );
            } catch (error) {
                showToast(error.message || '无法恢复直连播放。', 5200);
                return;
            }
            if (slot.activeSegment !== segment || slot.stopped) {
                return;
            }
        } else {
            seekExact(slot.video, segment.startMs);
            slot.video.play().catch(function () {});
        }
        // Keep the visible pane on its current online stream. The cache uses a
        // separate HLS PlaySessionId and starts before the guard window, so
        // Emby only sees one forward-moving consumer for that transcode.
        var sessionWindow = {
            start: Math.max(
                0,
                segment.startMs / 1000 - CLIP_CACHE_MAX_GUARD_SECONDS
            ),
            end: segment.endMs / 1000 + CLIP_CACHE_MAX_GUARD_SECONDS,
            guardSeconds: CLIP_CACHE_MAX_GUARD_SECONDS
        };
        var duration = mediaDurationSeconds(slot);
        if (duration > 0) {
            sessionWindow.end = Math.min(duration, sessionWindow.end);
        }
        var cacheStream = createClipCacheStream(slot, sessionWindow);
        if (!cacheStream) {
            showToast('无法创建独立的片段缓存会话。', 4800);
            return;
        }
        slot.clipCacheStream = cacheStream;
        slot.mediaCacheEnabled = false;
        slot.clipCacheLoading = true;
        slot.clipCacheReady = false;
        var generation = (slot.clipCacheGeneration || 0) + 1;
        slot.clipCacheGeneration = generation;
        var controller = new AbortController();
        slot.clipCacheController = controller;
        setPlaybackStatus(
            slot,
            'clip-cache',
            '当前直连播放 · 正在建立独立缓存会话…'
        );
        setSegmentCacheLabel(
            slot,
            '边播边缓存',
            '当前继续在线播放，后台使用独立会话顺序缓存'
        );
        var cacheStage = '建立独立 HLS 缓存会话';
        try {
            diagnosticLog('clip-cache-session-created', {
                url: diagnosticSafeUrl(cacheStream.url),
                sessionStart: sessionWindow.start,
                sessionEnd: sessionWindow.end,
                state: diagnosticSlotState(slot)
            });
            var planResult = await waitForClipFragmentPlan(
                slot,
                segment,
                cacheStream,
                sessionWindow,
                controller.signal
            );
            var plan = planResult.plan;
            var cachedWindow = planResult.windowRange;
            slot.clipCacheWindow = cachedWindow;
            diagnosticLog('clip-cache-plan', {
                fragmentCount: plan.length,
                windowStart: cachedWindow.start,
                windowEnd: cachedWindow.end,
                guardSeconds: cachedWindow.guardSeconds,
                state: diagnosticSlotState(slot)
            });
            if (slot.clipCacheGeneration !== generation || slot.activeSegment !== segment) {
                return;
            }
            var protectedKeys = new Set(plan.map(function (entry) {
                return entry.key;
            }));
            slot.clipCacheProtectedKeys = protectedKeys;
            var playbackFragment = clipPlaybackFragment(plan, segment);
            if (!playbackFragment) {
                throw new Error('HLS 清单中没有覆盖片段起点的分片');
            }
            slot.status.textContent = '当前在线播放 · 正在从保护区起点顺序缓存';
            cacheStage = '下载 HLS 分片';
            var prefetchResult = await prefetchClipFragments(
                slot,
                plan,
                protectedKeys,
                controller,
                generation,
                cacheStream
            );
            diagnosticLog('clip-cache-prefetch-complete', {
                bytes: prefetchResult.bytes,
                durationMs: Math.round(prefetchResult.durationMs),
                fragments: plan.length,
                state: diagnosticSlotState(slot)
            });
            slot.clipCacheBytes = plan.reduce(function (total, entry) {
                var cached = slot.mediaCache.get(entry.key);
                return total + (cached ? cached.size || 0 : 0);
            }, 0);
            var cacheComplete = plan.every(function (entry) {
                return slot.mediaCache.has(entry.key);
            });
            if (!cacheComplete) {
                throw new Error('片段缓存不完整');
            }
            slot.clipCacheReady = false;
            if (slot.clipCacheGeneration !== generation ||
                slot.activeSegment !== segment) {
                return;
            }
            cacheStage = '切换到内存片段';
            slot.status.textContent = '缓存完整 · 正在切换到内存播放…';
            slot.cacheStream = cacheStream;
            slot.forceClipCache = true;
            slot.mediaCacheEnabled = true;
            if (typeof slot.clipCacheActivationProvider === 'function') {
                await slot.clipCacheActivationProvider(cacheStream, segment);
            } else {
                await switchSlotStream(
                    slot,
                    cacheStream,
                    '缓存完整 · 正在切换到内存播放…',
                    false,
                    segment.startMs,
                    true
                );
                await waitForClipPlaybackReady(slot, segment);
            }
            slot.clipCacheReady = true;
            if (slot.clipCacheGeneration !== generation ||
                slot.activeSegment !== segment) {
                return;
            }
            cacheStage = '停止服务器转码';
            var stopEncodingWarning = '';
            try {
                await stopActiveEncoding(slot, cacheStream);
            } catch (stopError) {
                // The media bytes are already complete in memory. A failure of
                // the cleanup endpoint must not discard a valid clip cache.
                stopEncodingWarning = stopError.message || String(stopError);
                console.warn(
                    '[Emby Multi Window] 片段已缓存，但停止转码请求失败：',
                    stopError
                );
            }
            if (slot.clipCacheGeneration !== generation || slot.activeSegment !== segment) {
                return;
            }
            cacheStage = '启动内存循环';
            slot.clipCacheLoading = false;
            slot.clipCacheController = null;
            slot.clipCacheStream = null;
            diagnosticLog('clip-cache-ready', {
                bytes: slot.clipCacheBytes,
                stopEncodingWarning: stopEncodingWarning,
                state: diagnosticSlotState(slot)
            });
            showTransientPlaybackStatus(slot, 'memory-ready', '内存片段已就绪 · ' +
                formatBytes(slot.clipCacheBytes) +
                ' · 保护 ' + Math.round(cachedWindow.guardSeconds) + ' 秒' +
                (stopEncodingWarning ? ' · 转码停止请求失败' : ''), 1800);
            setSegmentCacheLabel(
                slot,
                '✓ 内存',
                '当前片段已完整缓存到内存：' + formatBytes(slot.clipCacheBytes) +
                    '；片段前后保护区目标 ' +
                    Math.round(cachedWindow.guardSeconds) + ' 秒' +
                    (stopEncodingWarning ?
                        '；服务器转码停止请求失败：' + stopEncodingWarning : '')
            );
            showToast('片段已缓存到内存：' + formatBytes(slot.clipCacheBytes) +
                ' · 保护 ' + Math.round(cachedWindow.guardSeconds) + ' 秒' +
                ' · 平均 ' + formatBytes(
                    prefetchResult.bytes /
                    Math.max(0.001, prefetchResult.durationMs / 1000)
                ) + '/s' +
                (stopEncodingWarning ? '；但转码停止请求失败' : ''));
        } catch (error) {
            if (error.name === 'AbortError' ||
                slot.clipCacheGeneration !== generation) {
                return;
            }
            slot.clipCacheLoading = false;
            slot.clipCacheReady = false;
            slot.clipCacheController = null;
            slot.clipCacheProtectedKeys = null;
            if (cacheStream) {
                stopActiveEncoding(slot, cacheStream).catch(function () {});
            }
            if (slot.directStream && streamMatches(slot.stream, cacheStream) &&
                !slot.stopped) {
                slot.forceClipCache = false;
                switchSlotStream(
                    slot,
                    slot.directStream,
                    '内存缓存失败 · 正在恢复直连…',
                    false,
                    segment.startMs,
                    true
                ).catch(function () {});
            }
            slot.clipCacheStream = null;
            diagnosticLog('clip-cache-failed', {
                stage: cacheStage,
                error: diagnosticError(error),
                state: diagnosticSlotState(slot)
            }, 'error');
            setSegmentCacheLabel(
                slot,
                '⚠ 在线',
                cacheStage + '失败：' + (error.message || error)
            );
            setPlaybackStatus(
                slot,
                'cache-failed',
                '片段缓存失败（' + cacheStage + '）：' +
                    (error.message || error)
            );
            showToast('片段缓存失败（' + cacheStage + '）：' +
                (error.message || error), 10000);
        }
    }

    function loadThumbnails(slot) {
        slot.chapters = (slot.item.Chapters || []).slice().sort(function (a, b) {
            return Number(a.StartPositionTicks) - Number(b.StartPositionTicks);
        });
        return fetch(slot.endpoints.thumbnailSet).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + response.status);
            }
            return response.json();
        }).then(function (result) {
            slot.thumbnails = (result && Array.isArray(result.Thumbnails) ?
                result.Thumbnails : []).slice().sort(function (a, b) {
                return Number(a.PositionTicks) - Number(b.PositionTicks);
            });
        }).catch(function () {
            slot.thumbnails = [];
        });
    }

    function findEntry(entries, ticks, field) {
        var selected = null;
        (entries || []).some(function (entry) {
            if ((Number(entry[field]) || 0) <= ticks) {
                selected = entry;
                return false;
            }
            return !!selected;
        });
        return selected;
    }

    function updatePreview(slot, value) {
        var percent = Math.max(0, Math.min(1, Number(value) / 1000 || 0));
        var runtimeTicks = Number(slot.item.RunTimeTicks) ||
            Number(slot.mediaSource.RunTimeTicks) ||
            (Number.isFinite(slot.video.duration) ? slot.video.duration * 10000000 : 0);
        var ticks = Math.max(0, runtimeTicks * percent);
        var thumbnail = findEntry(slot.thumbnails, ticks, 'PositionTicks');
        var chapter = findEntry(slot.chapters, ticks, 'StartPositionTicks');
        var previewLabel = (chapter && chapter.Name ? chapter.Name + ' · ' : '') +
            formatTime(ticks / 10000000);
        var hasImage = !!(thumbnail && thumbnail.ImageTag);
        var requestedWidth = hasImage ? settings.previewWidth :
            Math.max(82, Math.min(220, previewLabel.length * 7 + 22));
        var width = Math.min(requestedWidth, Math.max(80, slot.tile.clientWidth - 20));
        slot.preview.style.width = width + 'px';
        slot.preview.style.left = 'clamp(' + Math.round(width / 2) + 'px,' +
            (percent * 100) + '%,calc(100% - ' + Math.round(width / 2) + 'px))';
        slot.previewText.textContent = previewLabel;
        slot.preview.classList.toggle('no-image', !hasImage);
        if (hasImage) {
            var imageUrl = new URL(slot.endpoints.thumbnailImage);
            imageUrl.searchParams.set('MaxWidth', String(settings.previewWidth));
            imageUrl.searchParams.set('Tag', thumbnail.ImageTag);
            imageUrl.searchParams.set('PositionTicks', thumbnail.PositionTicks);
            slot.previewImage.style.backgroundImage =
                'url("' + imageUrl.href.replace(/"/g, '%22') + '")';
            slot.previewImage.hidden = false;
        } else {
            slot.previewImage.style.backgroundImage = '';
            slot.previewImage.hidden = true;
        }
        slot.preview.hidden = false;
    }

    function createTile(slot) {
        var tile = document.createElement('section');
        tile.className = 'tile';
        var video = document.createElement('video');
        video.controls = false;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        var title = document.createElement('div');
        title.className = 'title';
        title.textContent = displayName(slot.item);
        var dragHandle = document.createElement('button');
        dragHandle.type = 'button';
        dragHandle.className = 'drag-handle';
        dragHandle.title = '拖动调整画面顺序';
        dragHandle.setAttribute('aria-label', '拖动调整画面顺序');
        dragHandle.draggable = true;
        dragHandle.textContent = '⠿';
        var close = document.createElement('button');
        close.type = 'button';
        close.className = 'close';
        close.title = '关闭此视频';
        close.setAttribute('aria-label', '关闭此视频');
        close.textContent = '×';
        var status = document.createElement('div');
        status.className = 'status';
        status.textContent = '正在连接 Emby…';

        var segmentHost = document.createElement('div');
        segmentHost.className = 'segments';
        var segmentSelect = document.createElement('select');
        segmentSelect.setAttribute('aria-label', '选择循环片段');
        segmentHost.appendChild(segmentSelect);

        var seekHost = document.createElement('div');
        seekHost.className = 'seek';
        var seekSlider = document.createElement('input');
        seekSlider.type = 'range';
        seekSlider.min = '0';
        seekSlider.max = '1000';
        seekSlider.step = '1';
        seekSlider.value = '0';
        seekSlider.setAttribute('aria-label', '播放进度');
        var preview = document.createElement('div');
        preview.className = 'preview';
        preview.hidden = true;
        var previewImage = document.createElement('div');
        previewImage.className = 'preview-image';
        previewImage.hidden = true;
        var previewText = document.createElement('div');
        previewText.className = 'preview-text';
        preview.append(previewImage, previewText);
        seekHost.append(seekSlider, preview);

        var transport = document.createElement('div');
        transport.className = 'transport';
        var play = document.createElement('button');
        play.type = 'button';
        play.className = 'play';
        play.title = '播放';
        play.textContent = '▶';
        var volume = document.createElement('label');
        volume.className = 'volume';
        var volumeIcon = document.createElement('span');
        volumeIcon.textContent = '🔊';
        var volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '1';
        volumeSlider.step = '0.01';
        volumeSlider.value = '1';
        volumeSlider.setAttribute('aria-label', '音量');
        volume.append(volumeIcon, volumeSlider);
        var time = document.createElement('div');
        time.className = 'time';
        time.textContent = '0:00';
        transport.append(play, volume, time);

        var controls = document.createElement('div');
        controls.className = 'controls';
        controls.append(segmentHost, seekHost, transport);
        tile.append(video, title, dragHandle, close, status, controls);
        Object.assign(slot, {
            tile: tile,
            video: video,
            status: status,
            segmentSelect: segmentSelect,
            seekSlider: seekSlider,
            preview: preview,
            previewImage: previewImage,
            previewText: previewText,
            playButton: play,
            volumeSlider: volumeSlider,
            seekDragging: false
        });

        close.addEventListener('click', function () {
            removeSlot(slot.id);
        });
        dragHandle.addEventListener('dragstart', function (event) {
            dragState = {
                tile: tile,
                target: null,
                after: false
            };
            tile.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', slot.id);
        });
        // Some Chrome builds omit `drop` when the target contains a video or
        // an overlay. Commit the last valid hover target on dragend as a
        // fallback, which is especially important for a two-tile grid.
        dragHandle.addEventListener('dragend', commitDragState);
        dragHandle.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveTileByKeyboard(tile, -1);
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                moveTileByKeyboard(tile, 1);
            }
        });
        tile.addEventListener('dragover', function (event) {
            if (!dragState || dragState.tile === tile) {
                return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            grid.querySelectorAll('.drop-before,.drop-after').forEach(function (element) {
                element.classList.remove('drop-before', 'drop-after');
            });
            var tiles = Array.from(grid.querySelectorAll('.tile'));
            var sourceIndex = tiles.indexOf(dragState.tile);
            var targetIndex = tiles.indexOf(tile);
            // Dropping an earlier tile onto a later tile must place it after
            // the target. This also makes the common two-video case swap
            // reliably instead of reinserting the first tile before the second.
            var after = sourceIndex < targetIndex;
            dragState.target = tile;
            dragState.after = after;
            tile.classList.add(after ? 'drop-after' : 'drop-before');
        });
        tile.addEventListener('drop', function (event) {
            if (!dragState || dragState.tile === tile) {
                return;
            }
            event.preventDefault();
            commitDragState();
        });
        status.addEventListener('click', function () {
            video.play().catch(function () {});
        });
        play.addEventListener('click', function () {
            if (video.paused) {
                video.play().catch(function () {});
            } else {
                video.pause();
            }
        });
        volumeSlider.addEventListener('input', function () {
            video.volume = Number(volumeSlider.value);
            video.muted = video.volume === 0;
        });
        segmentSelect.addEventListener('change', function () {
            setSegmentCacheLabel(slot, '', '');
            slot.activeSegment = slot.segments.find(function (segment) {
                return segment.id === segmentSelect.value;
            }) || null;
            if (slot.activeSegment) {
                if (settings.mediaCacheMode === 'off') {
                    slot.forceClipCache = false;
                    cancelClipCache(slot, false);
                    releaseMediaCache(slot);
                    setSegmentCacheLabel(
                        slot,
                        '在线',
                        '片段内存缓存已关闭，当前从服务器在线循环'
                    );
                    seek(video, slot.activeSegment.startMs);
                    video.play().catch(function () {});
                } else {
                    slot.forceClipCache = true;
                    cacheActiveSegment(slot);
                }
            } else {
                slot.forceClipCache = false;
                cancelClipCache(slot, false);
                releaseMediaCache(slot);
                var resumeStream = slot.directStream || slot.cacheStream;
                if (resumeStream && !streamMatches(slot.stream, resumeStream)) {
                    switchSlotStream(
                        slot,
                        resumeStream,
                        '正在恢复优先直连…',
                        false
                    ).catch(function (error) {
                        showToast(error.message || '恢复播放方式失败。', 4800);
                    });
                } else if (slot.hls) {
                    slot.mediaCacheEnabled = false;
                    try {
                        slot.hls.startLoad(slot.video.currentTime || -1);
                    } catch (error) {}
                }
            }
            reportProgress(slot, 'seek');
        });
        function pointerValue(event) {
            var rect = seekSlider.getBoundingClientRect();
            return Math.max(0, Math.min(1000,
                (event.clientX - rect.left) / Math.max(1, rect.width) * 1000));
        }
        seekSlider.addEventListener('pointerdown', function () {
            slot.seekDragging = true;
        });
        seekSlider.addEventListener('pointerenter', function (event) {
            updatePreview(slot, pointerValue(event));
        });
        seekSlider.addEventListener('pointermove', function (event) {
            updatePreview(slot, slot.seekDragging ? seekSlider.value : pointerValue(event));
        });
        seekSlider.addEventListener('pointerleave', function () {
            if (!slot.seekDragging) {
                preview.hidden = true;
            }
        });
        seekSlider.addEventListener('input', function () {
            updatePreview(slot, seekSlider.value);
            if (Number.isFinite(video.duration) && video.duration > 0) {
                seek(video, video.duration * Number(seekSlider.value));
            }
        });
        seekSlider.addEventListener('change', function () {
            slot.seekDragging = false;
            preview.hidden = true;
            reportProgress(slot, 'seek');
        });
        seekSlider.addEventListener('pointerup', function () {
            slot.seekDragging = false;
        });
        video.addEventListener('loadedmetadata', function () {
            diagnosticLog('video-loadedmetadata', {
                state: diagnosticSlotState(slot)
            });
        });
        video.addEventListener('timeupdate', function () {
            // requestVideoFrameCallback enforces the boundary at rendered-frame
            // cadence. Keep timeupdate only as a fallback for older engines.
            if (typeof video.requestVideoFrameCallback !== 'function' &&
                slot.activeSegment && !slot.loopSeeking && !video.seeking) {
                var currentMs = video.currentTime * 1000;
                if (currentMs < slot.activeSegment.startMs - 500 ||
                    currentMs >= slot.activeSegment.endMs) {
                    restartSegmentLoop(slot);
                }
            }
            time.textContent = formatTime(video.currentTime) +
                (Number.isFinite(video.duration) ? ' / ' + formatTime(video.duration) : '');
            if (!slot.seekDragging && Number.isFinite(video.duration) && video.duration > 0) {
                seekSlider.value = String(Math.round(video.currentTime / video.duration * 1000));
            }
        });
        video.addEventListener('playing', function () {
            clearTimeout(slot.waitingTimer);
            if (!slot.clipCacheLoading) {
                status.hidden = true;
            }
            play.textContent = '❚❚';
            play.title = '暂停';
            reportStart(slot);
            scheduleNativeDecodeCheck(slot);
            if (video.muted && video.volume > 0) {
                video.muted = false;
            }
            diagnosticLog('video-playing', {
                state: diagnosticSlotState(slot)
            });
        });
        video.addEventListener('waiting', function () {
            diagnosticLog('video-waiting', {
                state: diagnosticSlotState(slot)
            }, 'warn');
            clearTimeout(slot.waitingTimer);
            slot.waitingTimer = setTimeout(function () {
                if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
                    return;
                }
                if (!slot.clipCacheReady) {
                    setPlaybackStatus(slot, 'network-buffering', '网络缓冲中…');
                    diagnosticLog('video-waiting-confirmed', {
                        source: 'network',
                        state: diagnosticSlotState(slot)
                    }, 'warn');
                    return;
                }
                var range = bufferedRangeAt(video, video.currentTime || 0);
                var recentCacheHit = slot.lastCacheHitAt &&
                    performance.now() - slot.lastCacheHitAt < 2000;
                setPlaybackStatus(
                    slot,
                    range ? 'decode-waiting' : 'mse-waiting',
                    range ?
                        '内存数据已写入，正在等待视频解码…' :
                        (recentCacheHit ?
                            '已从内存读取分片，正在写入播放缓冲…' :
                            '播放缓冲缺失，等待 HLS.js 从内存追加…')
                );
                diagnosticLog('video-waiting-confirmed', {
                    source: range ? 'decoder' :
                        (recentCacheHit ? 'mse-after-cache-hit' :
                            'mse-before-cache-hit'),
                    state: diagnosticSlotState(slot)
                }, 'warn');
            }, 350);
        });
        video.addEventListener('stalled', function () {
            diagnosticLog('video-stalled', {
                state: diagnosticSlotState(slot)
            }, 'warn');
        });
        video.addEventListener('pause', function () {
            play.textContent = '▶';
            play.title = '播放';
            reportProgress(slot, 'pause');
            diagnosticLog('video-pause', {
                state: diagnosticSlotState(slot)
            });
        });
        video.addEventListener('play', function () {
            reportProgress(slot, 'unpause');
            diagnosticLog('video-play', {
                state: diagnosticSlotState(slot)
            });
        });
        video.addEventListener('seeking', function () {
            diagnosticLog('video-seeking', {
                state: diagnosticSlotState(slot)
            });
        });
        video.addEventListener('seeked', function () {
            finishSegmentLoopSeek(slot);
            reportProgress(slot, 'seek');
            diagnosticLog('video-seeked', {
                state: diagnosticSlotState(slot)
            });
        });
        video.addEventListener('volumechange', function () {
            volumeSlider.value = String(video.muted ? 0 : video.volume);
            reportProgress(slot, 'volumechange');
        });
        video.addEventListener('ended', function () {
            diagnosticLog('video-ended', {
                state: diagnosticSlotState(slot)
            });
            if (slot.activeSegment) {
                restartSegmentLoop(slot);
            } else {
                reportStopped(slot);
            }
        });
        video.addEventListener('error', function () {
            diagnosticLog('video-error', {
                mediaError: video.error ? {
                    code: video.error.code,
                    message: video.error.message || ''
                } : null,
                state: diagnosticSlotState(slot)
            }, 'error');
            if (slot.switchingStream) {
                return;
            }
            if (slot.cacheStream && slot.stream.nativeTrial &&
                !slot.fallbackStarted) {
                switchToFallback(slot, 'native media error').catch(function () {});
                return;
            }
            status.hidden = false;
            status.textContent = video.error ?
                '播放失败（媒体错误 ' + video.error.code + '）' : '视频播放失败';
        });
        populateSegments(slot);
        startSegmentBoundaryMonitor(slot);
        return tile;
    }

    function attachStream(slot, stream, startPositionSeconds) {
        stream = stream || slot.stream;
        if (shouldUseHlsJs(slot, stream)) {
            if (!window.Hls || (typeof Hls.isSupported === 'function' && !Hls.isSupported())) {
                return Promise.reject(new Error('当前 Chrome 无法使用 HLS.js 播放此转码流。'));
            }
            var hlsConfig = createHlsConfig(slot, startPositionSeconds);
            var hls = new Hls(hlsConfig);
            slot.hls = hls;
            slot.hlsMemoryLoaderEnabled = slot.mediaCacheEnabled;
            diagnosticLog('hls-attach', {
                url: diagnosticSafeUrl(stream.url),
                memoryLoader: slot.hlsMemoryLoaderEnabled,
                forceClipCache: !!slot.forceClipCache,
                config: {
                    enableWorker: hlsConfig.enableWorker,
                    workerPath: diagnosticSafeUrl(hlsConfig.workerPath),
                    maxBufferLength: hlsConfig.maxBufferLength,
                    maxMaxBufferLength: hlsConfig.maxMaxBufferLength,
                    backBufferLength: hlsConfig.backBufferLength,
                    maxBufferSize: hlsConfig.maxBufferSize,
                    startPosition: hlsConfig.startPosition
                },
                state: diagnosticSlotState(slot)
            });
            return new Promise(function (resolve, reject) {
                var settled = false;
                hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
                    diagnosticLog('hls-manifest-parsed', {
                        levels: data && data.levels ? data.levels.length : 0,
                        audioTracks: data && data.audioTracks ?
                            data.audioTracks.length : 0,
                        state: diagnosticSlotState(slot)
                    });
                    if (settled) {
                        return;
                    }
                    settled = true;
                    // Manifest attachment is complete. Do not make callers wait
                    // for play() to resolve; that promise can remain pending
                    // until HLS has buffered the selected time position.
                    resolve();
                    if (slot.forceClipCache) {
                        diagnosticLog('hls-play-deferred-for-clip-cache', {
                            startPosition: hlsConfig.startPosition,
                            state: diagnosticSlotState(slot)
                        });
                        return;
                    }
                    var playPromise;
                    try {
                        playPromise = slot.video.play();
                    } catch (error) {
                        diagnosticLog('hls-play-request-failed', {
                            error: diagnosticError(error),
                            state: diagnosticSlotState(slot)
                        }, 'warn');
                        return;
                    }
                    Promise.resolve(playPromise).catch(function (error) {
                        if (error.name === 'NotAllowedError') {
                            slot.status.textContent = '点击画面开始播放';
                        } else {
                            diagnosticLog('hls-play-request-failed', {
                                error: diagnosticError(error),
                                state: diagnosticSlotState(slot)
                            }, 'warn');
                        }
                    });
                });
                if (Hls.Events.LEVEL_LOADED) {
                    hls.on(Hls.Events.LEVEL_LOADED, function (event, data) {
                        var details = data && data.details;
                        var fragments = details && details.fragments || [];
                        diagnosticLog('hls-level-loaded', {
                            level: data && data.level,
                            fragmentCount: fragments.length,
                            start: fragments.length ? fragments[0].start : null,
                            end: fragments.length ?
                                fragments[fragments.length - 1].start +
                                fragments[fragments.length - 1].duration : null,
                            targetDuration: details && details.targetduration,
                            state: diagnosticSlotState(slot)
                        });
                    });
                }
                [
                    ['FRAG_LOADING', 'hls-frag-loading'],
                    ['FRAG_LOADED', 'hls-frag-loaded'],
                    ['FRAG_BUFFERED', 'hls-frag-buffered'],
                    ['BUFFER_APPENDING', 'hls-buffer-appending'],
                    ['BUFFER_APPENDED', 'hls-buffer-appended']
                ].forEach(function (entry) {
                    var eventName = Hls.Events[entry[0]];
                    if (eventName) {
                        hls.on(eventName, function (event, data) {
                            diagnosticHlsEvent(slot, entry[1], data);
                        });
                    }
                });
                hls.on(Hls.Events.ERROR, function (event, data) {
                    var details = String(data && data.details || '');
                    var type = String(data && data.type || '');
                    var expectedClipAbort = details === 'aborted' &&
                        slot.clipCacheLoading && !(data && data.fatal);
                    if (expectedClipAbort) {
                        diagnosticHlsEvent(
                            slot,
                            'hls-load-aborted-for-clip-cache',
                            data,
                            'info'
                        );
                        return;
                    }
                    slot.lastHlsError = {
                        at: Date.now(),
                        details: details,
                        type: type,
                        fatal: !!(data && data.fatal)
                    };
                    diagnosticHlsEvent(
                        slot,
                        'hls-error',
                        data,
                        data && data.fatal ? 'error' : 'warn'
                    );
                    if (slot.clipCacheReady && !(data && data.fatal) &&
                        /buffer.*(?:stall|full)|stall.*buffer/i.test(details)) {
                        console.warn(
                            '[Emby Multi Window] cached clip HLS buffer warning:',
                            slot.lastHlsError
                        );
                    }
                    if (data && data.fatal) {
                        var error = new Error('HLS 播放失败：' +
                            (data.details || data.type || '未知错误'));
                        if (!settled) {
                            settled = true;
                            reject(error);
                        } else {
                            setPlaybackStatus(slot, 'hls-fatal', error.message);
                        }
                    }
                });
                hls.loadSource(stream.url);
                hls.attachMedia(slot.video);
            });
        }
        diagnosticLog('native-stream-attach', {
            url: diagnosticSafeUrl(stream.url),
            startPosition: Number.isFinite(Number(startPositionSeconds)) ?
                Number(startPositionSeconds) : 0,
            state: diagnosticSlotState(slot)
        });
        slot.video.src = stream.url;
        var startSeconds = Number.isFinite(Number(startPositionSeconds)) ?
            Math.max(0, Number(startPositionSeconds)) : 0;
        var started = false;

        function requestPlay() {
            var playPromise;
            try {
                playPromise = slot.video.play();
            } catch (error) {
                diagnosticLog('native-play-request-failed', {
                    error: diagnosticError(error),
                    state: diagnosticSlotState(slot)
                }, 'error');
                slot.status.hidden = false;
                slot.status.textContent = error.message || '视频播放失败';
                return;
            }
            Promise.resolve(playPromise).catch(function (error) {
                if (error.name === 'NotAllowedError') {
                    slot.status.textContent = '点击画面开始播放';
                    return;
                }
                diagnosticLog('native-play-request-failed', {
                    error: diagnosticError(error),
                    state: diagnosticSlotState(slot)
                }, 'error');
            });
        }

        function startAfterMetadata() {
            if (started) {
                return;
            }
            started = true;
            if (startSeconds > 0) {
                seekExact(slot.video, startSeconds * 1000);
                if (slot.video.seeking) {
                    slot.video.addEventListener('seeked', requestPlay, {
                        once: true
                    });
                    return;
                }
            }
            requestPlay();
        }

        // Starting playback before metadata and the initial seek lets the
        // audio clock run at the old position while video decoding is being
        // relocated. Mount first, seek once, and only then start both tracks.
        if (slot.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
            startAfterMetadata();
        } else {
            slot.video.addEventListener(
                'loadedmetadata',
                startAfterMetadata,
                {once: true}
            );
        }
        return Promise.resolve();
    }

    function addPayload(payload) {
        if (!payload || !payload.item || !payload.stream || !payload.endpoints) {
            throw new Error('收到的播放数据不完整。');
        }
        if (slots.size >= MAX_SLOTS) {
            throw new Error('当前版本最多同时播放 ' + MAX_SLOTS + ' 个视频。');
        }
        if (Array.from(slots.values()).some(function (slot) {
            return slot.item.Id === payload.item.Id;
        })) {
            throw new Error('这个视频已经在多画面窗口中。');
        }
        var directStream = payload.directStream ||
            (!payload.stream.isHls ? payload.stream : null);
        var cacheStream = payload.cacheStream ||
            (payload.stream.isHls ? payload.stream : payload.fallbackStream);
        // Opening a pane always starts from the original direct stream when
        // one is available. HLS is reserved for decode fallback and clip
        // prefetch, so opening a pane cannot block on cache/transcode startup.
        var selectedStream = directStream || cacheStream;
        var slot = Object.assign({}, payload, {
            id: payload.requestId,
            stream: selectedStream,
            directStream: directStream,
            cacheStream: cacheStream,
            cacheStreamTemplate: cacheStream,
            fallbackStream: streamMatches(selectedStream, directStream) ?
                cacheStream : null,
            startPositionMs: Math.max(0, Number(payload.startPositionTicks) || 0) / 10000,
            segments: [],
            thumbnails: [],
            chapters: [],
            activeSegment: null,
            startReported: false,
            stopped: false,
            hls: null,
            hlsMemoryLoaderEnabled: false,
            fallbackStarted: false,
            switchingStream: false,
            videoDecodeTimer: null,
            waitingTimer: null,
            mediaCache: new Map(),
            mediaCacheInflight: new Map(),
            mediaCacheBytes: 0,
            cacheHits: 0,
            cacheNetworkLoads: 0,
            clipCacheBytes: 0,
            clipCacheLoading: false,
            clipCacheReady: false,
            clipCacheGeneration: 0,
            clipCacheController: null,
            clipCacheStream: null,
            clipCacheProtectedKeys: null,
            clipCacheWindow: null,
            segmentFrameCallbackId: null,
            lastHlsError: null,
            loopSeeking: false,
            loopSeekTimer: null,
            forceClipCache: false,
            mediaCacheEnabled: false,
            mediaCacheLimitBytes: clampMediaCacheLimit(
                settings.mediaCacheLimitMb
            ) * 1024 * 1024,
            statusHideTimer: null,
            progressTimer: null,
            diagnosticTimer: null
        });
        diagnosticLog('slot-added', {
            stream: {
                url: diagnosticSafeUrl(selectedStream && selectedStream.url),
                isHls: isHlsStream(selectedStream),
                directAvailable: !!directStream,
                cacheAvailable: !!cacheStream
            },
            state: diagnosticSlotState(slot)
        });
        slots.set(slot.id, slot);
        grid.appendChild(createTile(slot));
        updateGrid();
        var initialStartSeconds = slot.startPositionMs / 1000;
        slot.startPositionMs = 0;
        return Promise.all([
            attachStream(slot, slot.stream, initialStartSeconds),
            loadSegments(slot),
            loadThumbnails(slot)
        ])
            .then(function () {
                slot.progressTimer = setInterval(function () {
                    reportProgress(slot, 'timeupdate');
                }, PROGRESS_INTERVAL_MS);
                slot.diagnosticTimer = setInterval(function () {
                    if (slot.activeSegment && !slot.stopped) {
                        diagnosticLog('playback-snapshot', {
                            state: diagnosticSlotState(slot)
                        });
                    }
                }, 2000);
                showToast('已加入：' + displayName(slot.item));
            }).catch(function (error) {
                diagnosticLog('slot-add-failed', {
                    error: diagnosticError(error),
                    state: diagnosticSlotState(slot)
                }, 'error');
                removeSlot(slot.id);
                throw error;
            });
    }

    async function drainPending(requestId) {
        if (draining) {
            drainAgain = true;
            return;
        }
        draining = true;
        try {
            if (settingsReadyPromise) {
                await settingsReadyPromise;
            }
            var currentWindowId = await playerWindowIdPromise;
            var all = await chrome.storage.session.get(null);
            var keys = Object.keys(all).filter(function (key) {
                var envelope = all[key];
                return key.indexOf(PENDING_PREFIX) === 0 &&
                    (!requestId || key === PENDING_PREFIX + requestId) &&
                    (!envelope.targetWindowId ||
                        envelope.targetWindowId === currentWindowId);
            });
            for (var i = 0; i < keys.length; i += 1) {
                var key = keys[i];
                var envelope = all[key];
                var payload = envelope.payload || envelope;
                try {
                    await addPayload(payload);
                } catch (error) {
                    console.error('[Emby Multi Window]', error);
                    showToast(error.message || '加入视频失败。', 5200);
                    var rejected = payload;
                    if (rejected && rejected.endpoints && rejected.endpoints.stopEncoding) {
                        fetch(rejected.endpoints.stopEncoding, {method: 'POST'})
                            .catch(function () {});
                    }
                } finally {
                    await chrome.storage.session.remove(key);
                }
            }
        } finally {
            draining = false;
            if (drainAgain) {
                drainAgain = false;
                drainPending();
            }
        }
    }

    function revealControls() {
        stage.classList.remove('controls-hidden');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(function () {
            stage.classList.add('controls-hidden');
            slots.forEach(function (slot) {
                slot.preview.hidden = true;
            });
        }, settings.controlsIdleMs);
    }

    chrome.runtime.onMessage.addListener(function (message) {
        if (message && message.type === 'EMBY_MULTIWINDOW_QUEUE_UPDATED') {
            playerWindowIdPromise.then(function (windowId) {
                if (!message.targetWindowId || message.targetWindowId === windowId) {
                    drainPending(message.requestId);
                }
            });
        }
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === 'sync' && changes.previewWidth) {
            settings.previewWidth = Math.max(180,
                Math.min(520, Number(changes.previewWidth.newValue) || 280));
            document.documentElement.style.setProperty(
                '--preview-width',
                settings.previewWidth + 'px'
            );
        }
        if (area === 'sync' && changes.controlsIdleSeconds) {
            settings.controlsIdleMs = clampControlsIdleMs(
                changes.controlsIdleSeconds.newValue
            );
            revealControls();
        }
        if (area === 'sync' && changes.mediaCacheMode) {
            settings.mediaCacheMode = changes.mediaCacheMode.newValue === 'off' ?
                'off' : 'memory';
            if (settings.mediaCacheMode === 'off') {
                slots.forEach(function (slot) {
                    if (!slot.activeSegment) {
                        return;
                    }
                    slot.forceClipCache = false;
                    cancelClipCache(slot, false);
                    releaseMediaCache(slot);
                    setSegmentCacheLabel(
                        slot,
                        '在线',
                        '片段内存缓存已关闭，当前从服务器在线循环'
                    );
                    if (slot.hls) {
                        try {
                            slot.hls.startLoad(slot.video.currentTime || -1);
                        } catch (error) {}
                    }
                });
            }
        }
        if (area === 'sync' && changes.mediaCacheLimitMb) {
            settings.mediaCacheLimitMb = clampMediaCacheLimit(
                changes.mediaCacheLimitMb.newValue
            );
            slots.forEach(function (slot) {
                slot.mediaCacheLimitBytes =
                    settings.mediaCacheLimitMb * 1024 * 1024;
                trimMediaCache(slot, slot.clipCacheProtectedKeys);
            });
        }
        if (area === 'session' && Object.keys(changes).some(function (key) {
            return key.indexOf(PENDING_PREFIX) === 0 && changes[key].newValue;
        })) {
            drainPending();
        }
    });
    ['pointermove', 'pointerdown', 'keydown'].forEach(function (name) {
        stage.addEventListener(name, revealControls);
    });
    newWindowButton.addEventListener('click', function () {
        newWindowButton.disabled = true;
        chrome.runtime.sendMessage({
            type: 'EMBY_MULTIWINDOW_NEW_PLAYER'
        }).then(function (response) {
            if (!response || !response.ok) {
                throw new Error(response && response.error || '无法创建新的播放窗口。');
            }
            showToast('已新建播放窗口；后续视频将加入新窗口');
        }).catch(function (error) {
            showToast(error.message || '无法创建新的播放窗口。', 4800);
        }).finally(function () {
            newWindowButton.disabled = false;
        });
    });
    window.addEventListener('error', function (event) {
        diagnosticLog('window-error', {
            message: event.message || '',
            filename: diagnosticSafeUrl(event.filename),
            line: event.lineno || 0,
            column: event.colno || 0,
            error: diagnosticError(event.error)
        }, 'error');
    });
    window.addEventListener('unhandledrejection', function (event) {
        diagnosticLog('unhandled-rejection', {
            error: diagnosticError(event.reason)
        }, 'error');
    });
    window.addEventListener('pagehide', function () {
        diagnosticLog('player-pagehide', {
            slots: Array.from(slots.values()).map(diagnosticSlotState)
        });
        flushDiagnosticLogsOnPageHide();
    });
    window.addEventListener('beforeunload', function () {
        slots.forEach(function (slot) {
            reportStopped(slot, true);
            destroyMedia(slot);
        });
    });

    settingsReadyPromise = chrome.storage.sync.get({
        previewWidth: 280,
        controlsIdleSeconds: DEFAULT_CONTROLS_IDLE_MS / 1000,
        mediaCacheMode: 'memory',
        mediaCacheLimitMb: DEFAULT_MEDIA_CACHE_LIMIT_MB,
        mediaCacheLimitVersion: 0
    }).then(function (stored) {
        var migratedLimit = stored.mediaCacheLimitMb;
        var migration = Promise.resolve();
        if (Number(stored.mediaCacheLimitVersion) < MEDIA_CACHE_LIMIT_VERSION &&
            Number(migratedLimit) === 256) {
            migratedLimit = DEFAULT_MEDIA_CACHE_LIMIT_MB;
        }
        if (Number(stored.mediaCacheLimitVersion) < MEDIA_CACHE_LIMIT_VERSION) {
            migration = chrome.storage.sync.set({
                mediaCacheLimitMb: clampMediaCacheLimit(migratedLimit),
                mediaCacheLimitVersion: MEDIA_CACHE_LIMIT_VERSION
            }).catch(function (error) {
                console.warn('[Emby Multi Window] 无法保存缓存容量迁移', error);
            });
        }
        settings.previewWidth = Math.max(180,
            Math.min(520, Number(stored.previewWidth) || 280));
        document.documentElement.style.setProperty(
            '--preview-width',
            settings.previewWidth + 'px'
        );
        settings.controlsIdleMs = clampControlsIdleMs(
            stored.controlsIdleSeconds
        );
        settings.mediaCacheMode = stored.mediaCacheMode === 'off' ?
            'off' : 'memory';
        settings.mediaCacheLimitMb = clampMediaCacheLimit(migratedLimit);
        return migration;
    });
    updateGrid();
    revealControls();
    settingsReadyPromise.finally(function () {
        drainPending();
    });
})();
