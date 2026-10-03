(function () {
    'use strict';

    var slider = document.getElementById('previewWidth');
    var output = document.getElementById('previewWidthValue');
    var sample = document.getElementById('previewSample');
    var controlsIdle = document.getElementById('controlsIdleSeconds');
    var controlsIdleValue =
        document.getElementById('controlsIdleSecondsValue');
    var resetButton = document.getElementById('resetWindow');
    var siteInput = document.getElementById('siteInput');
    var addSiteButton = document.getElementById('addSite');
    var siteList = document.getElementById('siteList');
    var siteError = document.getElementById('siteError');
    var mediaCacheMode = document.getElementById('mediaCacheMode');
    var mediaCacheLimit = document.getElementById('mediaCacheLimitMb');
    var mediaCacheLimitValue = document.getElementById('mediaCacheLimitValue');
    var cacheLimitRow = document.getElementById('cacheLimitRow');
    var saved = document.getElementById('saved');
    var savedTimer = null;
    var allowedSites = [];
    var DEFAULT_MEDIA_CACHE_LIMIT_MB = 4096;
    var MIN_MEDIA_CACHE_LIMIT_MB = 256;
    var MAX_MEDIA_CACHE_LIMIT_MB = 16384;
    var MEDIA_CACHE_LIMIT_VERSION = 2;
    var DEFAULT_CONTROLS_IDLE_SECONDS = 2.5;
    var MIN_CONTROLS_IDLE_SECONDS = 0.5;
    var MAX_CONTROLS_IDLE_SECONDS = 30;
    var DEFAULT_ALLOWED_SITES = [
        'http://localhost',
        'https://localhost',
        'http://127.0.0.1',
        'https://127.0.0.1',
        'http://192.168.8.10:8096'
    ];

    function clampWidth(value) {
        return Math.max(180, Math.min(520, Math.round(Number(value) || 280)));
    }

    function render(value) {
        value = clampWidth(value);
        slider.value = String(value);
        output.value = value + ' px';
        sample.style.width = value + 'px';
    }

    function clampControlsIdleSeconds(value) {
        value = Number(value);
        if (!Number.isFinite(value)) {
            value = DEFAULT_CONTROLS_IDLE_SECONDS;
        }
        return Math.max(
            MIN_CONTROLS_IDLE_SECONDS,
            Math.min(
                MAX_CONTROLS_IDLE_SECONDS,
                Math.round(value * 2) / 2
            )
        );
    }

    function renderControlsIdle(value) {
        value = clampControlsIdleSeconds(value);
        controlsIdle.value = String(value);
        controlsIdleValue.value = String(value).replace(/\.0$/, '') + ' 秒';
    }

    function flashSaved(message) {
        saved.textContent = message || '设置已保存';
        saved.classList.add('visible');
        clearTimeout(savedTimer);
        savedTimer = setTimeout(function () {
            saved.classList.remove('visible');
        }, 1700);
    }

    function normalizeSite(value) {
        value = String(value || '').trim();
        if (!value) {
            throw new Error('请输入 Emby 服务器网址。');
        }
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
            value = 'http://' + value;
        }
        var url;
        try {
            url = new URL(value);
        } catch (error) {
            throw new Error('网址格式不正确。');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('只支持 http:// 或 https:// 地址。');
        }
        if (!url.hostname || url.username || url.password) {
            throw new Error('请输入不包含账号密码的服务器地址。');
        }
        return url.protocol + '//' + url.hostname + (url.port ? ':' + url.port : '');
    }

    function saveSites(message) {
        return chrome.storage.sync.set({
            allowedSites: allowedSites.slice()
        }).then(function () {
            flashSaved(message || '网址列表已保存');
        });
    }

    function renderSites() {
        siteList.innerHTML = '';
        if (!allowedSites.length) {
            var empty = document.createElement('li');
            empty.className = 'site-empty';
            empty.textContent = '没有适配网址，扩展不会注入任何网页。';
            siteList.appendChild(empty);
            return;
        }
        allowedSites.forEach(function (site) {
            var item = document.createElement('li');
            var label = document.createElement('code');
            label.textContent = site;
            label.title = site;
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '移除';
            remove.setAttribute('aria-label', '移除 ' + site);
            remove.addEventListener('click', function () {
                allowedSites = allowedSites.filter(function (value) {
                    return value !== site;
                });
                renderSites();
                saveSites();
            });
            item.append(label, remove);
            siteList.appendChild(item);
        });
    }

    function addSite() {
        siteError.textContent = '';
        try {
            var site = normalizeSite(siteInput.value);
            if (allowedSites.includes(site)) {
                throw new Error('这个网址已经在列表中。');
            }
            allowedSites.push(site);
            allowedSites.sort();
            renderSites();
            siteInput.value = '';
            saveSites();
        } catch (error) {
            siteError.textContent = error.message;
        }
    }

    function clampCacheLimit(value) {
        return Math.max(MIN_MEDIA_CACHE_LIMIT_MB, Math.min(MAX_MEDIA_CACHE_LIMIT_MB,
            Math.round((Number(value) || DEFAULT_MEDIA_CACHE_LIMIT_MB) / 256) * 256));
    }

    function formatCacheLimit(value) {
        return value >= 1024 ? String(value / 1024) + ' GB' : value + ' MB';
    }

    function renderCacheSettings() {
        var limit = clampCacheLimit(mediaCacheLimit.value);
        mediaCacheLimit.value = String(limit);
        mediaCacheLimitValue.value = formatCacheLimit(limit);
        var disabled = mediaCacheMode.value === 'off';
        mediaCacheLimit.disabled = disabled;
        cacheLimitRow.classList.toggle('is-disabled', disabled);
    }

    slider.addEventListener('input', function () {
        render(slider.value);
    });
    slider.addEventListener('change', function () {
        var value = clampWidth(slider.value);
        chrome.storage.sync.set({previewWidth: value}).then(function () {
            flashSaved();
        });
    });
    controlsIdle.addEventListener('input', function () {
        renderControlsIdle(controlsIdle.value);
    });
    controlsIdle.addEventListener('change', function () {
        var value = clampControlsIdleSeconds(controlsIdle.value);
        renderControlsIdle(value);
        chrome.storage.sync.set({controlsIdleSeconds: value}).then(function () {
            flashSaved('控件隐藏延迟已保存');
        });
    });
    resetButton.addEventListener('click', function () {
        chrome.storage.sync.set({
            windowWidth: 1100,
            windowHeight: 720
        }).then(function () {
            flashSaved('下次打开将使用默认窗口大小');
        });
    });
    addSiteButton.addEventListener('click', addSite);
    siteInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            addSite();
        }
    });
    mediaCacheMode.addEventListener('change', function () {
        renderCacheSettings();
        chrome.storage.sync.set({
            mediaCacheMode: mediaCacheMode.value === 'off' ? 'off' : 'memory'
        }).then(function () {
            flashSaved('缓存方式已保存');
        });
    });
    mediaCacheLimit.addEventListener('input', renderCacheSettings);
    mediaCacheLimit.addEventListener('change', function () {
        var value = clampCacheLimit(mediaCacheLimit.value);
        renderCacheSettings();
        chrome.storage.sync.set({
            mediaCacheLimitMb: value,
            mediaCacheLimitVersion: MEDIA_CACHE_LIMIT_VERSION
        }).then(function () {
            flashSaved('缓存容量已保存');
        });
    });

    chrome.storage.sync.get({
        previewWidth: 280,
        controlsIdleSeconds: DEFAULT_CONTROLS_IDLE_SECONDS,
        allowedSites: DEFAULT_ALLOWED_SITES,
        mediaCacheMode: 'memory',
        mediaCacheLimitMb: DEFAULT_MEDIA_CACHE_LIMIT_MB,
        mediaCacheLimitVersion: 0
    }).then(function (settings) {
        var migratedLimit = settings.mediaCacheLimitMb;
        if (Number(settings.mediaCacheLimitVersion) < MEDIA_CACHE_LIMIT_VERSION &&
            Number(migratedLimit) === 256) {
            migratedLimit = DEFAULT_MEDIA_CACHE_LIMIT_MB;
        }
        if (Number(settings.mediaCacheLimitVersion) < MEDIA_CACHE_LIMIT_VERSION) {
            chrome.storage.sync.set({
                mediaCacheLimitMb: clampCacheLimit(migratedLimit),
                mediaCacheLimitVersion: MEDIA_CACHE_LIMIT_VERSION
            }).catch(function (error) {
                console.warn('[Emby Multi Window] 无法保存缓存容量迁移', error);
            });
        }
        render(settings.previewWidth);
        renderControlsIdle(settings.controlsIdleSeconds);
        allowedSites = Array.isArray(settings.allowedSites) ?
            settings.allowedSites.slice() : DEFAULT_ALLOWED_SITES.slice();
        renderSites();
        mediaCacheMode.value = settings.mediaCacheMode === 'off' ?
            'off' : 'memory';
        mediaCacheLimit.value = String(clampCacheLimit(migratedLimit));
        renderCacheSettings();
    });
})();
