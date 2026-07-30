(function () {
    'use strict';

    var MAX_SLOTS = 4;
    var PROGRESS_INTERVAL_MS = 10000;
    var CONTROLS_IDLE_MS = 2500;
    var CLIP_CACHE_GUARD_SECONDS = 12;
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
    var draining = false;
    var drainAgain = false;
    var controlsTimer = null;
    var toastTimer = null;
    var settingsReadyPromise = null;
    var settings = {
        previewWidth: 280,
        mediaCacheMode: 'memory',
        mediaCacheLimitMb: DEFAULT_MEDIA_CACHE_LIMIT_MB
    };

    function clampMediaCacheLimit(value) {
        return Math.max(MIN_MEDIA_CACHE_LIMIT_MB,
            Math.min(MAX_MEDIA_CACHE_LIMIT_MB,
                Number(value) || DEFAULT_MEDIA_CACHE_LIMIT_MB));
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
        slot.mediaCache.set(key, Object.assign({
            data: data.slice(0),
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
                    var now = performance.now();
                    this.stats.loading.start = now;
                    this.stats.loading.first = now;
                    this.stats.loading.end = now;
                    this.stats.loaded = cached.size;
                    this.stats.total = cached.size;
                    queueMicrotask(function () {
                        if (!loader.callbacks || loader.stats.aborted) {
                            return;
                        }
                        callbacks.onSuccess({
                            url: context.url,
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
                                data,
                                fragmentMetadata(context.frag, context.url),
                                slot.clipCacheProtectedKeys
                            );
                        }
                        slot.cacheNetworkLoads = (slot.cacheNetworkLoads || 0) + 1;
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
            fetchFragment: fetchClipFragment,
            cacheSegment: cacheActiveSegment,
            shouldUseHlsJs: shouldUseHlsJs,
            cacheKey: mediaCacheKey
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
        clearTimeout(slot.videoDecodeTimer);
        clearTimeout(slot.waitingTimer);
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

    function detachStream(slot, releaseCache) {
        cancelClipCache(slot, false);
        clearTimeout(slot.videoDecodeTimer);
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

    function switchSlotStream(slot, targetStream, reason, automaticFallback) {
        if (!targetStream || slot.stopped || streamMatches(slot.stream, targetStream)) {
            return Promise.resolve(false);
        }
        var resumeMs = Math.max(0, (slot.video.currentTime || 0) * 1000);
        var wasPaused = slot.video.paused;
        slot.switchingStream = true;
        slot.fallbackStarted = !!automaticFallback;
        slot.status.hidden = false;
        slot.status.textContent = reason || '正在切换播放方式…';
        detachStream(slot, !isHlsStream(targetStream));
        // Opening a pane defaults to direct play. HLS memory caching is enabled
        // only for an explicitly selected clip or a manual cache-first switch.
        slot.mediaCacheEnabled = isHlsStream(targetStream) &&
            slot.forceClipCache;
        slot.stream = targetStream;
        slot.fallbackStream = streamMatches(targetStream, slot.directStream) ?
            slot.cacheStream : null;
        slot.video.addEventListener('loadedmetadata', function () {
            if (resumeMs > 0) {
                seek(slot.video, resumeMs);
            }
        }, {once: true});
        return attachStream(slot, targetStream).then(function () {
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

    function clipFragmentPlan(slot, segment) {
        var details = currentLevelDetails(slot);
        var startSeconds = segment.startMs / 1000;
        var endSeconds = segment.endMs / 1000;
        var guardStart = Math.max(0, startSeconds - CLIP_CACHE_GUARD_SECONDS);
        var guardEnd = endSeconds + CLIP_CACHE_GUARD_SECONDS;
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
            return entry.end > guardStart && entry.start < guardEnd;
        }).sort(function (first, second) {
            return first.start - second.start;
        });
    }

    function planCoversSegment(plan, segment) {
        if (!plan.length) {
            return false;
        }
        var startSeconds = segment.startMs / 1000;
        var endSeconds = segment.endMs / 1000;
        if (plan[0].start > startSeconds + 0.5 ||
            plan[plan.length - 1].end < endSeconds - 0.5) {
            return false;
        }
        return !plan.some(function (entry, index) {
            return index > 0 && entry.start > plan[index - 1].end + 0.5;
        });
    }

    function waitForClipFragmentPlan(slot, segment) {
        var immediate = clipFragmentPlan(slot, segment);
        if (planCoversSegment(immediate, segment)) {
            return Promise.resolve(immediate);
        }
        if (!slot.hls) {
            return Promise.reject(new Error('当前播放流不是可缓存的 HLS。'));
        }
        return new Promise(function (resolve, reject) {
            var settled = false;
            var timer = setTimeout(function () {
                if (!settled) {
                    settled = true;
                    slot.hls.off(Hls.Events.LEVEL_LOADED, onLevelLoaded);
                    reject(new Error('30 秒内没有取得覆盖完整片段的 HLS 分片清单'));
                }
            }, 30000);
            function onLevelLoaded() {
                var plan = clipFragmentPlan(slot, segment);
                if (!settled && planCoversSegment(plan, segment)) {
                    settled = true;
                    clearTimeout(timer);
                    slot.hls.off(Hls.Events.LEVEL_LOADED, onLevelLoaded);
                    resolve(plan);
                }
            }
            slot.hls.on(Hls.Events.LEVEL_LOADED, onLevelLoaded);
            try {
                // startLoad() does not reliably change position while HLS.js is
                // already loading. Stop first and seek the media element so the
                // Emby playlist is requested around the selected clip.
                slot.hls.stopLoad();
                seek(slot.video, segment.startMs);
                slot.hls.startLoad(segment.startMs / 1000);
            } catch (error) {
                clearTimeout(timer);
                slot.hls.off(Hls.Events.LEVEL_LOADED, onLevelLoaded);
                reject(error);
            }
        });
    }

    function authenticatedFragmentUrl(slot, fragmentUrl) {
        var parsed = new URL(fragmentUrl, slot.cacheStream.url);
        var source = new URL(slot.cacheStream.url);
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

    async function fetchClipFragment(slot, entry, protectedKeys, signal) {
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
        var request = (async function () {
            var response;
            for (var attempt = 0; attempt < 7; attempt += 1) {
                response = await fetch(authenticatedFragmentUrl(slot, entry.url), {
                    method: 'GET',
                    headers: headers,
                    cache: 'no-store',
                    credentials: 'omit',
                    signal: signal
                });
                if (response.ok) {
                    break;
                }
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

    async function prefetchClipFragments(slot, plan, protectedKeys, controller, generation) {
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
                controller.signal
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

    function stopActiveEncoding(slot) {
        return fetch(slot.endpoints.stopEncoding, {
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
        cancelClipCache(slot, false);
        releaseMediaCache(slot);
        if (!slot.cacheStream || !isHlsStream(slot.cacheStream)) {
            showToast('当前视频没有可用于片段缓存的 HLS 流。', 4800);
            return;
        }
        slot.cacheStream.isHls = true;
        slot.forceClipCache = true;
        if (!streamMatches(slot.stream, slot.cacheStream)) {
            try {
                await switchSlotStream(
                    slot,
                    slot.cacheStream,
                    '片段缓存需要 HLS，正在切换…',
                    false
                );
            } catch (error) {
                showToast(error.message || '无法切换到片段缓存流。', 5200);
                return;
            }
            if (slot.activeSegment !== segment || slot.stopped) {
                return;
            }
        } else if (!slot.hls || !slot.hlsMemoryLoaderEnabled) {
            // The stream may already be attached through Chrome's native HLS
            // path. Clip caching requires our HLS.js loader, so remount it.
            detachStream(slot, false);
            slot.mediaCacheEnabled = true;
            slot.stream = slot.cacheStream;
            try {
                await attachStream(slot, slot.cacheStream);
            } catch (error) {
                showToast(error.message || '无法启用片段内存缓存。', 5200);
                return;
            }
        }
        slot.mediaCacheEnabled = true;
        slot.clipCacheLoading = true;
        slot.clipCacheReady = false;
        var generation = (slot.clipCacheGeneration || 0) + 1;
        slot.clipCacheGeneration = generation;
        var controller = new AbortController();
        slot.clipCacheController = controller;
        slot.status.hidden = false;
        slot.status.textContent = '正在准备片段播放…';
        setSegmentCacheLabel(slot, '边播边缓存', '播放当前片段，同时缓存到内存');
        var cacheStage = '获取 HLS 分片清单';
        try {
            var plan = await waitForClipFragmentPlan(slot, segment);
            if (slot.clipCacheGeneration !== generation || slot.activeSegment !== segment) {
                return;
            }
            seekExact(slot.video, segment.startMs);
            await slot.video.play().catch(function (error) {
                if (error.name !== 'NotAllowedError') {
                    throw error;
                }
                slot.status.hidden = false;
                slot.status.textContent = '点击画面开始播放；缓存会在后台继续';
            });
            var protectedKeys = new Set(plan.map(function (entry) {
                return entry.key;
            }));
            slot.clipCacheProtectedKeys = protectedKeys;
            cacheStage = '下载 HLS 分片';
            var prefetchResult = await prefetchClipFragments(
                slot,
                plan,
                protectedKeys,
                controller,
                generation
            );
            slot.clipCacheBytes = plan.reduce(function (total, entry) {
                var cached = slot.mediaCache.get(entry.key);
                return total + (cached ? cached.size || 0 : 0);
            }, 0);
            slot.clipCacheReady = plan.every(function (entry) {
                return slot.mediaCache.has(entry.key);
            });
            if (!slot.clipCacheReady) {
                throw new Error('片段缓存不完整');
            }
            cacheStage = '停止服务器转码';
            var stopEncodingWarning = '';
            try {
                await stopActiveEncoding(slot);
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
            slot.status.textContent = '内存片段已就绪 · ' +
                formatBytes(slot.clipCacheBytes) +
                (stopEncodingWarning ? ' · 转码停止请求失败' : '');
            setSegmentCacheLabel(
                slot,
                '✓ 内存',
                '当前片段已完整缓存到内存：' + formatBytes(slot.clipCacheBytes) +
                    (stopEncodingWarning ?
                        '；服务器转码停止请求失败：' + stopEncodingWarning : '')
            );
            showToast('片段已缓存到内存：' + formatBytes(slot.clipCacheBytes) +
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
            try {
                slot.hls.startLoad(segment.startMs / 1000);
            } catch (loadError) {}
            seek(slot.video, segment.startMs);
            slot.video.play().catch(function () {});
            setSegmentCacheLabel(
                slot,
                '⚠ 在线',
                cacheStage + '失败：' + (error.message || error)
            );
            slot.status.hidden = false;
            slot.status.textContent = '片段缓存失败（' + cacheStage + '）：' +
                (error.message || error);
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
            if (slot.startPositionMs > 0) {
                seek(video, slot.startPositionMs);
                slot.startPositionMs = 0;
            }
        }, {once: true});
        video.addEventListener('timeupdate', function () {
            if (slot.activeSegment) {
                var currentMs = video.currentTime * 1000;
                if (currentMs < slot.activeSegment.startMs - 500 ||
                    currentMs >= slot.activeSegment.endMs) {
                    seekExact(video, slot.activeSegment.startMs);
                    video.play().catch(function () {});
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
            status.hidden = true;
            play.textContent = '❚❚';
            play.title = '暂停';
            reportStart(slot);
            scheduleNativeDecodeCheck(slot);
            if (video.muted && video.volume > 0) {
                video.muted = false;
            }
        });
        video.addEventListener('waiting', function () {
            clearTimeout(slot.waitingTimer);
            slot.waitingTimer = setTimeout(function () {
                if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
                    return;
                }
                status.hidden = false;
                status.textContent = slot.clipCacheReady ?
                    '正在从内存恢复画面…' : '网络缓冲中…';
            }, 350);
        });
        video.addEventListener('pause', function () {
            play.textContent = '▶';
            play.title = '播放';
            reportProgress(slot, 'pause');
        });
        video.addEventListener('play', function () {
            reportProgress(slot, 'unpause');
        });
        video.addEventListener('seeked', function () {
            reportProgress(slot, 'seek');
        });
        video.addEventListener('volumechange', function () {
            volumeSlider.value = String(video.muted ? 0 : video.volume);
            reportProgress(slot, 'volumechange');
        });
        video.addEventListener('ended', function () {
            if (slot.activeSegment) {
                seekExact(video, slot.activeSegment.startMs);
                video.play().catch(function () {});
            } else {
                reportStopped(slot);
            }
        });
        video.addEventListener('error', function () {
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
        return tile;
    }

    function attachStream(slot, stream) {
        stream = stream || slot.stream;
        if (shouldUseHlsJs(slot, stream)) {
            if (!window.Hls || (typeof Hls.isSupported === 'function' && !Hls.isSupported())) {
                return Promise.reject(new Error('当前 Chrome 无法使用 HLS.js 播放此转码流。'));
            }
            var hlsConfig = {
                manifestLoadingTimeOut: 20000,
                debug: false,
                testBandwidth: false,
                // MV3 extension pages do not allow HLS.js' blob worker under
                // the default extension CSP. Main-thread demuxing is reliable
                // here and each window is limited to four streams.
                enableWorker: false,
                loader: slot.mediaCacheEnabled ?
                    createMemoryLoaderClass(slot) : Hls.DefaultConfig.loader,
                emeEnabled: false
            };
            if (slot.forceClipCache) {
                // Limit forward prefetch to the cached guard area, but let the
                // browser retain old MSE data for as long as its own quota
                // permits so short clips can loop without being re-appended.
                hlsConfig.maxBufferLength = 6;
                hlsConfig.maxMaxBufferLength = 12;
                hlsConfig.backBufferLength = Infinity;
            }
            var hls = new Hls(hlsConfig);
            slot.hls = hls;
            slot.hlsMemoryLoaderEnabled = slot.mediaCacheEnabled;
            return new Promise(function (resolve, reject) {
                var settled = false;
                hls.on(Hls.Events.MANIFEST_PARSED, function () {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    slot.video.play().then(resolve).catch(function (error) {
                        if (error.name === 'NotAllowedError') {
                            slot.status.textContent = '点击画面开始播放';
                            resolve();
                        } else {
                            reject(error);
                        }
                    });
                });
            hls.on(Hls.Events.ERROR, function (event, data) {
                    if (data && data.fatal) {
                        var error = new Error('HLS 播放失败：' +
                            (data.details || data.type || '未知错误'));
                        if (!settled) {
                            settled = true;
                            reject(error);
                        } else {
                            slot.status.hidden = false;
                            slot.status.textContent = error.message;
                        }
                    }
                });
                hls.loadSource(stream.url);
                hls.attachMedia(slot.video);
            });
        }
        slot.video.src = stream.url;
        return slot.video.play().catch(function (error) {
            if (error.name === 'NotAllowedError') {
                slot.status.textContent = '点击画面开始播放';
                return;
            }
            throw error;
        });
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
            clipCacheProtectedKeys: null,
            forceClipCache: false,
            mediaCacheEnabled: false,
            mediaCacheLimitBytes: clampMediaCacheLimit(
                settings.mediaCacheLimitMb
            ) * 1024 * 1024,
            progressTimer: null
        });
        slots.set(slot.id, slot);
        grid.appendChild(createTile(slot));
        updateGrid();
        return Promise.all([attachStream(slot, slot.stream), loadSegments(slot), loadThumbnails(slot)])
            .then(function () {
                slot.progressTimer = setInterval(function () {
                    reportProgress(slot, 'timeupdate');
                }, PROGRESS_INTERVAL_MS);
                showToast('已加入：' + displayName(slot.item));
            }).catch(function (error) {
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
        }, CONTROLS_IDLE_MS);
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
    window.addEventListener('beforeunload', function () {
        slots.forEach(function (slot) {
            reportStopped(slot, true);
            destroyMedia(slot);
        });
    });

    settingsReadyPromise = chrome.storage.sync.get({
        previewWidth: 280,
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
