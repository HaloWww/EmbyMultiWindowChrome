(function () {
    'use strict';

    var PAGE_SOURCE = 'emby-multiwindow-page';
    var EXTENSION_SOURCE = 'emby-multiwindow-extension';
    var enabled = false;

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!enabled || event.source !== window || !data || data.source !== PAGE_SOURCE ||
            data.type !== 'ADD_VIDEO' || !data.payload) {
            return;
        }
        chrome.runtime.sendMessage({
            type: 'EMBY_MULTIWINDOW_ADD',
            payload: data.payload
        }).then(function (response) {
            window.postMessage({
                source: EXTENSION_SOURCE,
                type: 'ADD_VIDEO_RESULT',
                requestId: data.payload.requestId,
                ok: !!(response && response.ok),
                error: response && response.error
            }, location.origin);
        }).catch(function (error) {
            window.postMessage({
                source: EXTENSION_SOURCE,
                type: 'ADD_VIDEO_RESULT',
                requestId: data.payload.requestId,
                ok: false,
                error: error && error.message ? error.message : '扩展后台没有响应。'
            }, location.origin);
        });
    });

    chrome.runtime.sendMessage({
        type: 'EMBY_MULTIWINDOW_INIT',
        url: location.href
    }).then(function (response) {
        enabled = !!(response && response.ok && response.enabled);
    }).catch(function () {
        enabled = false;
    });
})();
