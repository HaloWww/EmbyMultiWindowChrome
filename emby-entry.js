(function () {
    'use strict';

    if (window.__embyMultiWindowLoaded) {
        return;
    }
    window.__embyMultiWindowLoaded = true;

    var VERSION = '0.7.7';
    var READY_RETRY_MS = 700;
    var MODULE_ROOT = './modules/';
    var SEGMENT_STORAGE_KEY = 'embySegmentLoop.v1';
    var launcher = null;
    var toast = null;
    var toastTimer = null;
    var readyAttempts = 0;
    var launcherTimer = null;
    var launcherObserver = null;
    var playbackManagerPromise = null;
    var apiClientClassPromise = null;
    var profileBuilderPromise = null;
    var pending = new Map();

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Emby Multi Window]');
        console.log.apply(console, args);
    }

    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Emby Multi Window]');
        console.warn.apply(console, args);
    }

    function moduleDefault(module) {
        return module && (module.default || module);
    }

    function importModule(path) {
        if (!window.Emby || typeof window.Emby.importModule !== 'function') {
            return Promise.reject(new Error('Emby 模块加载器不可用。'));
        }
        return window.Emby.importModule(path).then(moduleDefault);
    }

    function getPlaybackManager() {
        if (!playbackManagerPromise) {
            playbackManagerPromise = importModule('playbackManager').catch(function () {
                return importModule(MODULE_ROOT + 'common/playback/playbackmanager.js');
            }).catch(function (error) {
                playbackManagerPromise = null;
                throw error;
            });
        }
        return playbackManagerPromise;
    }

    function getApiClientClass() {
        if (!apiClientClassPromise) {
            apiClientClassPromise = importModule(MODULE_ROOT + 'emby-apiclient/apiclient.js')
                .catch(function (error) {
                    apiClientClassPromise = null;
                    throw error;
                });
        }
        return apiClientClassPromise;
    }

    function getProfileBuilder() {
        if (!profileBuilderPromise) {
            profileBuilderPromise = importModule(MODULE_ROOT + 'browserdeviceprofile.js')
                .catch(function (error) {
                    profileBuilderPromise = null;
                    throw error;
                });
        }
        return profileBuilderPromise;
    }

    function randomId(prefix) {
        var value;
        if (crypto && typeof crypto.randomUUID === 'function') {
            value = crypto.randomUUID().replace(/-/g, '');
        } else {
            var bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            value = Array.prototype.map.call(bytes, function (byte) {
                return byte.toString(16).padStart(2, '0');
            }).join('');
        }
        return prefix + value;
    }

    function showToast(message, duration) {
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'emby-multiwindow-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.classList.remove('is-visible');
        }, duration || 3400);
    }

    function isVideoItem(item) {
        return !!item && (item.MediaType === 'Video' ||
            ['Movie', 'Episode', 'Video', 'MusicVideo', 'Trailer', 'Program'].includes(item.Type));
    }

    function getDisplayName(item) {
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

    function getLocalSegments(itemId) {
        try {
            var state = JSON.parse(localStorage.getItem(SEGMENT_STORAGE_KEY)) || {};
            return (state.items && state.items[itemId] || []).map(normalizeSegment)
                .filter(function (segment) {
                    return segment.endMs > segment.startMs;
                });
        } catch (error) {
            return [];
        }
    }

    function getCurrentPlaybackContext() {
        return getPlaybackManager().then(function (playbackManager) {
            var item = playbackManager.currentItem && playbackManager.currentItem();
            var player = playbackManager.getCurrentPlayer && playbackManager.getCurrentPlayer();
            var mediaSource = playbackManager.currentMediaSource &&
                playbackManager.currentMediaSource(player);
            var positionTicks = 0;
            try {
                positionTicks = playbackManager.getCurrentTicks ?
                    playbackManager.getCurrentTicks(player) :
                    Math.round((playbackManager.currentTime(player) || 0) * 10000000);
            } catch (error) {
                warn('读取原播放器进度失败。', error);
            }
            if (!isVideoItem(item)) {
                throw new Error('请先在 Emby 中播放一个视频。');
            }
            return {
                playbackManager: playbackManager,
                player: player,
                item: item,
                mediaSource: mediaSource,
                positionTicks: Math.max(0, Number(positionTicks) || 0)
            };
        });
    }

    function createSlotApiClient(baseClient, ApiClientClass) {
        var deviceId = randomId('emby-multiwindow-');
        var deviceName = (baseClient.deviceName && baseClient.deviceName()) || 'Chrome';
        var client = new ApiClientClass(
            baseClient.serverAddress(),
            'Emby Multi Window',
            VERSION,
            deviceName + ' Multi Window',
            deviceId,
            window.devicePixelRatio || 1
        );
        if (typeof client.serverInfo === 'function' && typeof baseClient.serverInfo === 'function') {
            client.serverInfo(baseClient.serverInfo());
        }
        client.setAuthenticationInfo({
            UserId: baseClient.getCurrentUserId(),
            AccessToken: baseClient.accessToken()
        });
        client.enableAutomaticNetworking = false;
        return client;
    }

    function getFreshItem(client, item) {
        return client.getItem(client.getCurrentUserId(), item.Id, {
            Fields: 'MediaSources,MediaStreams,Path,ProviderIds,Overview,Chapters',
            EnableImages: false
        }).catch(function () {
            return item;
        });
    }

    function canBrowserPlayMediaSource(source) {
        var streams = source.MediaStreams || [];
        var videoStream = streams.find(function (stream) {
            return stream.Type === 'Video';
        }) || {};
        var codec = String(videoStream.Codec || '').toLowerCase();
        var container = String(source.Container || '').toLowerCase();
        var profile = String(videoStream.Profile || '').toLowerCase();
        var pixelFormat = String(videoStream.PixelFormat || '').toLowerCase();
        var bitDepth = Number(videoStream.BitDepth) || 0;
        var mime;
        if (codec === 'hevc' || codec === 'h265') {
            return false;
        }
        if (codec === 'h264' || codec === 'avc') {
            if (bitDepth > 8 || /high\s*10|high\s*4:|4:4:4/.test(profile) ||
                (pixelFormat && !/^(yuvj?420p|nv12)$/.test(pixelFormat))) {
                return false;
            }
            mime = 'video/mp4; codecs="avc1.42E01E"';
        } else if (codec === 'vp9') {
            mime = 'video/webm; codecs="vp9"';
        } else if (codec === 'av1') {
            mime = 'video/mp4; codecs="av01.0.05M.08"';
        } else if (container === 'webm') {
            mime = 'video/webm';
        } else if (['mp4', 'm4v', 'mov'].includes(container)) {
            mime = 'video/mp4';
        } else {
            return false;
        }
        return document.createElement('video').canPlayType(mime) !== '';
    }

    function requestPlaybackInfo(client, item, profile, context) {
        var requestedSource = context.mediaSource ||
            (item.MediaSources && item.MediaSources[0]) || null;
        var canCopyVideo = !!requestedSource &&
            canBrowserPlayMediaSource(requestedSource);
        var options = {
            UserId: client.getCurrentUserId(),
            StartTimeTicks: context.positionTicks || 0,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            // Always ask Emby for an HLS-capable path. The original file URL
            // is built separately so the player window can choose either one.
            EnableDirectPlay: false,
            EnableDirectStream: false,
            AllowVideoStreamCopy: canCopyVideo,
            AllowAudioStreamCopy: true,
            MaxStreamingBitrate: 40000000
        };
        if (context.mediaSource && context.mediaSource.Id) {
            options.MediaSourceId = context.mediaSource.Id;
        }
        if (context.mediaSource && context.mediaSource.DefaultAudioStreamIndex != null) {
            options.AudioStreamIndex = context.mediaSource.DefaultAudioStreamIndex;
        }
        if (context.mediaSource && context.mediaSource.DefaultSubtitleStreamIndex != null) {
            options.SubtitleStreamIndex = context.mediaSource.DefaultSubtitleStreamIndex;
        }
        return client.getPlaybackInfo(item.Id, options, profile);
    }

    function chooseMediaSource(playbackInfo, preferredId) {
        var sources = playbackInfo && playbackInfo.MediaSources || [];
        if (!sources.length) {
            throw new Error((playbackInfo && playbackInfo.ErrorCode) ||
                '服务器没有返回可播放媒体源。');
        }
        return sources.find(function (source) {
            return preferredId && source.Id === preferredId;
        }) || sources.find(function (source) {
            return source.DirectStreamUrl;
        }) || sources.find(function (source) {
            return source.TranscodingUrl;
        }) || sources[0];
    }

    function appendParams(url, params) {
        var parsed = new URL(url, location.href);
        Object.keys(params).forEach(function (key) {
            var value = params[key];
            if (value != null && value !== '' && !parsed.searchParams.has(key)) {
                parsed.searchParams.set(key, value);
            }
        });
        return parsed.href;
    }

    function authenticatedUrl(client, path, extra) {
        return appendParams(client.getUrl(path), Object.assign({
            api_key: client.accessToken(),
            DeviceId: client.deviceId()
        }, extra || {}));
    }

    function forceCompatibleTranscodeUrl(url) {
        var compatibleUrl = new URL(url, location.href);
        compatibleUrl.searchParams.set('VideoCodec', 'h264');
        compatibleUrl.searchParams.set('allowVideoStreamCopy', 'false');
        compatibleUrl.searchParams.set('h264-profile', 'high,main,baseline');
        compatibleUrl.searchParams.set('h264-level', '52');
        compatibleUrl.searchParams.set('SegmentContainer', 'ts');
        compatibleUrl.searchParams.set('TranscodeReasons', 'VideoCodecNotSupported');
        return compatibleUrl.href;
    }

    function buildCacheStreamInfo(client, source, playbackInfo) {
        if (!source.TranscodingUrl) {
            return null;
        }
        var playSessionId = playbackInfo.PlaySessionId || randomId('window-session-');
        var streamUrl = /^https?:/i.test(source.TranscodingUrl) ?
            source.TranscodingUrl : client.getUrl(source.TranscodingUrl);
        if (!canBrowserPlayMediaSource(source)) {
            streamUrl = forceCompatibleTranscodeUrl(streamUrl);
        }
        return {
            url: appendParams(streamUrl, {
                api_key: client.accessToken(),
                DeviceId: client.deviceId(),
                MediaSourceId: source.Id,
                PlaySessionId: playSessionId
            }),
            playMethod: 'Transcode',
            playSessionId: playSessionId,
            isHls: /\.m3u8(?:$|[?#])/i.test(streamUrl) ||
                String(source.TranscodingSubProtocol || '').toLowerCase() === 'hls'
        };
    }

    function getVideoStream(source) {
        return (source.MediaStreams || []).find(function (stream) {
            return stream.Type === 'Video';
        }) || {};
    }

    function buildDirectStreamInfo(client, item, source, session) {
        var videoStream = getVideoStream(source);
        var codec = String(videoStream.Codec || '').toLowerCase();
        var container = String(source.Container || '').toLowerCase().replace('m4v', 'mp4');
        var nativeContainer = (
            ['mp4', 'mov'].includes(container) &&
            ['h264', 'avc', 'hevc', 'h265', 'av1'].includes(codec)
        ) || (
            container === 'webm' &&
            ['vp9', 'av1'].includes(codec)
        );
        if (!nativeContainer) {
            return null;
        }
        var playSessionId = typeof session === 'string' ?
            session : session && session.playSessionId;
        playSessionId = playSessionId || randomId('window-session-');
        var path = 'Videos/' + encodeURIComponent(item.Id) +
            '/original.' + encodeURIComponent(container);
        return {
            url: appendParams(client.getUrl(path), {
                api_key: client.accessToken(),
                DeviceId: client.deviceId(),
                MediaSourceId: source.Id,
                PlaySessionId: playSessionId,
                Static: 'true'
            }),
            playMethod: 'DirectPlay',
            playSessionId: playSessionId,
            isHls: false,
            nativeTrial: true
        };
    }

    function buildPayload(client, item, source, directStream, cacheStream, context) {
        var stream = cacheStream || directStream;
        var auth = {
            PlaySessionId: stream.playSessionId
        };
        return {
            requestId: randomId('request-'),
            item: JSON.parse(JSON.stringify(item)),
            mediaSource: JSON.parse(JSON.stringify(source)),
            stream: stream,
            directStream: directStream || null,
            cacheStream: cacheStream || null,
            // Kept for payload compatibility with an already-open 0.4.x player.
            fallbackStream: directStream && cacheStream ? cacheStream : null,
            startPositionTicks: Math.max(0, Number(context.positionTicks) || 0),
            localSegments: getLocalSegments(item.Id),
            endpoints: {
                reportStart: authenticatedUrl(client, 'Sessions/Playing'),
                reportProgress: authenticatedUrl(client, 'Sessions/Playing/Progress'),
                reportStopped: authenticatedUrl(client, 'Sessions/Playing/Stopped'),
                stopEncoding: authenticatedUrl(client, 'Videos/ActiveEncodings/Delete', auth),
                segments: authenticatedUrl(client,
                    'SegmentLoop/Segments/' + encodeURIComponent(item.Id)),
                thumbnailSet: authenticatedUrl(client,
                    'Items/' + encodeURIComponent(item.Id) + '/ThumbnailSet', {
                        MediaSourceId: source.Id,
                        Width: 400
                    }),
                thumbnailImage: authenticatedUrl(client,
                    'Items/' + encodeURIComponent(item.Id) + '/Images/Thumbnail', {
                        MediaSourceId: source.Id
                    })
            }
        };
    }

    function preparePayload(context) {
        if (!isVideoItem(context.item)) {
            return Promise.reject(new Error('当前详情项目不是可播放视频。'));
        }
        var baseClient = window.ApiClient;
        if (!baseClient || !baseClient.isLoggedIn || !baseClient.isLoggedIn()) {
            return Promise.reject(new Error('Emby 尚未登录或 ApiClient 不可用。'));
        }
        return Promise.all([getApiClientClass(), getProfileBuilder()]).then(function (modules) {
            var client = createSlotApiClient(baseClient, modules[0]);
            return getFreshItem(client, context.item).then(function (item) {
                context.item = item;
                return Promise.resolve(modules[1]({item: item})).then(function (profile) {
                    return requestPlaybackInfo(client, item, profile, context);
                }).then(function (playbackInfo) {
                    var source = chooseMediaSource(
                        playbackInfo,
                        context.mediaSource && context.mediaSource.Id
                    );
                    var cacheStream = buildCacheStreamInfo(
                        client,
                        source,
                        playbackInfo
                    );
                    var directStream = buildDirectStreamInfo(
                        client,
                        item,
                        source,
                        cacheStream && cacheStream.playSessionId ||
                            playbackInfo.PlaySessionId
                    );
                    if (!cacheStream && !directStream) {
                        throw new Error('当前媒体源没有可用的缓存流或浏览器直连流。');
                    }
                    return buildPayload(
                        client,
                        item,
                        source,
                        directStream,
                        cacheStream,
                        context
                    );
                });
            });
        });
    }

    function pauseOriginal(context) {
        try {
            if (context.player && context.playbackManager &&
                context.playbackManager.isPlaying(context.player)) {
                context.playbackManager.pause(context.player);
            }
        } catch (error) {
            warn('暂停原播放器失败。', error);
        }
    }

    function queueContext(contextPromise, trigger, openInNewWindow) {
        if (trigger) {
            trigger.disabled = true;
        }
        Promise.resolve(contextPromise).then(function (context) {
            return preparePayload(context).then(function (payload) {
                payload.openInNewWindow = !!openInNewWindow;
                pending.set(payload.requestId, {context: context, trigger: trigger});
                window.postMessage({
                    source: 'emby-multiwindow-page',
                    type: 'ADD_VIDEO',
                    payload: payload
                }, location.origin);
            });
        }).catch(function (error) {
            if (trigger && trigger.isConnected) {
                trigger.disabled = false;
            }
            warn(error);
            showToast(error && error.message ? error.message : '加入多画面失败。', 4800);
        });
    }

    function onBridgeResult(event) {
        var data = event.data;
        if (event.source !== window || !data || data.source !== 'emby-multiwindow-extension' ||
            data.type !== 'ADD_VIDEO_RESULT') {
            return;
        }
        var request = pending.get(data.requestId);
        if (!request) {
            return;
        }
        pending.delete(data.requestId);
        if (request.trigger && request.trigger.isConnected) {
            request.trigger.disabled = false;
        }
        if (data.ok) {
            pauseOriginal(request.context);
            showToast('已发送到多画面窗口：' + getDisplayName(request.context.item));
        } else {
            showToast(data.error || '多画面窗口没有接收视频。', 4800);
        }
    }

    function detailContext(item) {
        return {
            playbackManager: null,
            player: null,
            item: item,
            mediaSource: null,
            positionTicks: Math.max(0,
                Number(item && item.UserData && item.UserData.PlaybackPositionTicks) || 0)
        };
    }

    function renderDetailButton(view, item) {
        if (!view || !isVideoItem(item)) {
            return;
        }
        var host = view.querySelector('.mainDetailButtons');
        if (!host) {
            return;
        }
        var button = host.querySelector('.emby-multiwindow-detail-button');
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.className = 'emby-multiwindow-detail-button raised detailButton';
            button.title = '直接加入多画面窗口；按住 Shift 点击可新建窗口';
            button.innerHTML = '<span class="emby-multiwindow-icon">▦</span>' +
                '<span>加入更多画面</span>';
            button.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                if (button.embyMultiWindowItem) {
                    queueContext(
                        detailContext(button.embyMultiWindowItem),
                        button,
                        event.shiftKey
                    );
                }
            });
            host.appendChild(button);
        }
        button.embyMultiWindowItem = item;
    }

    function onItemShow(event) {
        var item = event.detail && event.detail.item;
        var view = event.target && event.target.closest ?
            event.target.closest('.itemView') : null;
        renderDetailButton(view || event.target, item);
    }

    function hasVisiblePlaybackVideo() {
        return Array.prototype.some.call(document.querySelectorAll('video'), function (video) {
            return video.isConnected && video.getClientRects().length > 0 &&
                (video.currentSrc || video.src || video.readyState > 0);
        });
    }

    function updateLauncherVisibility() {
        if (launcher) {
            launcher.hidden = !hasVisiblePlaybackVideo();
        }
    }

    function scheduleLauncherUpdate() {
        clearTimeout(launcherTimer);
        launcherTimer = setTimeout(updateLauncherVisibility, 120);
    }

    function createLauncher() {
        launcher = document.createElement('button');
        launcher.id = 'emby-multiwindow-launcher';
        launcher.type = 'button';
        launcher.hidden = true;
        launcher.title = '加入多画面窗口；按住 Shift 点击可新建窗口';
        launcher.innerHTML = '<span class="emby-multiwindow-icon">▦</span>' +
            '<span>加入多画面</span>';
        launcher.addEventListener('click', function (event) {
            queueContext(getCurrentPlaybackContext(), launcher, event.shiftKey);
        });
        document.body.appendChild(launcher);
        updateLauncherVisibility();
    }

    function initializeWhenReady() {
        if (window.Emby && typeof window.Emby.importModule === 'function' &&
            window.ApiClient && typeof window.ApiClient.getPlaybackInfo === 'function') {
            createLauncher();
            document.addEventListener('itemshow', onItemShow);
            launcherObserver = new MutationObserver(scheduleLauncherUpdate);
            launcherObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'src']
            });
            window.addEventListener('hashchange', scheduleLauncherUpdate);
            log('Extension initialized.');
            return;
        }
        readyAttempts += 1;
        if (readyAttempts < 90) {
            setTimeout(initializeWhenReady, READY_RETRY_MS);
        }
    }

    if (window.__embyMultiWindowTestMode) {
        window.__embyMultiWindowCodecTest = {
            canPlay: canBrowserPlayMediaSource,
            forceTranscodeUrl: forceCompatibleTranscodeUrl,
            buildCacheStream: buildCacheStreamInfo,
            buildDirectTrial: buildDirectStreamInfo
        };
    }

    window.addEventListener('message', onBridgeResult);
    initializeWhenReady();
})();
