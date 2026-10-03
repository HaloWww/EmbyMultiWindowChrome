'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const version = JSON.parse(read('manifest.json')).version;
const greasyFork = process.argv.includes('--greasyfork');
const header = `// ==UserScript==
// @name         Emby Multi Window
// @namespace    https://github.com/HaloWww/EmbyMultiWindowChrome
// @version      ${version}
// @author       HaloWww (westmelon)
// @license      All Rights Reserved
// @description  Emby 四画面播放、片段离线内存循环和独立播放窗口
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @noframes
// @sandbox      JavaScript
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      *
// @homepageURL  https://github.com/HaloWww/EmbyMultiWindowChrome
// @updateURL    https://raw.githubusercontent.com/HaloWww/EmbyMultiWindowChrome/main/dist/EmbyMultiWindow.user.js
// @downloadURL  https://raw.githubusercontent.com/HaloWww/EmbyMultiWindowChrome/main/dist/EmbyMultiWindow.user.js
// ==/UserScript==
`;
// Bundle exact local HLS/worker sources; the installed script needs no CDN.
const assets = {
    PLAYER_HTML: read('player.html'),
    PLAYER_CSS: read('player.css'), OPTIONS_HTML: read('options.html'),
    OPTIONS_CSS: read('options.css'), ENTRY_CSS: read('emby-entry.css')
};
const workerCdn = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.0-beta.2/dist/hls.worker.js#sha256=7d3qaLAflJL3WzNZnO87FSLoamaZQeCfgsN5tUZg56Q=';
const hlsCdn = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.0-beta.2/dist/hls.min.js#sha256=EVhWL1k+LlZQuzgsf7rlEJDObvfecvdAZxS3uoMdvbE=';
const releaseHeader = greasyFork ? header
    .replace('// @name         Emby Multi Window', '// @name         Emby Multi Window\n// @name:zh-CN   Emby 多画面播放器')
    .replace('// @match        http://*/*\n// @match        https://*/*',
        '// @match        http://*/web/*\n// @match        https://*/web/*')
    .replace('// @grant        GM_addStyle', '// @grant        GM_addStyle\n// @grant        GM_getResourceText')
    .replace(/^\/\/ @(?:updateURL|downloadURL).*\n/gm, '')
    .replace('// ==/UserScript==', '// @require      ' + hlsCdn + '\n// @resource     embyHlsWorker ' + workerCdn + '\n// ==/UserScript==') : header;
const output = releaseHeader + '\n(function () {\n\'use strict\';\n' +
    '/* Bundled HLS.js license:\n' + read('HLS-LICENSE.txt').replace(/\*\//g, '* /') + '\n*/\n' +
    'const window = unsafeWindow;\nconst document = window.document;\nconst location = window.location;\n' +
    'const fetch = gmFetch;\n' +
    (greasyFork ? 'const WORKER_SOURCE = GM_getResourceText(\'embyHlsWorker\');\n' :
        'const WORKER_SOURCE = ' + JSON.stringify(read('hls.worker.js')) + ';\n') +
    Object.entries(assets).map(([name, value]) => 'const ' + name + ' = ' + JSON.stringify(value) + ';').join('\n') +
    (greasyFork ? '\nconst Hls = globalThis.Hls || unsafeWindow.Hls;\n' :
        '\nconst Hls = (function () { const module = {exports:{}}; const exports = module.exports;\n' +
        read('hls.js') + '\nreturn module.exports; })();\n') +
    'function runPlayer() {\n' + read('player.js').replace(/window\.Hls/g, 'Hls').replace('window.fetch.bind(window)', 'fetch') + '\n}\n' +
    'function runOptions() {\n' + read('options.js') + '\n}\n' +
    'function runEntry() {\n' + read('emby-entry.js') + '\n}\n' +
    read('userscript/runtime.js') + '\n})();\n';
const target = path.join(root, 'dist', greasyFork ? 'EmbyMultiWindow.greasyfork.user.js' : 'EmbyMultiWindow.user.js');
fs.writeFileSync(target, output);
console.log('Built ' + target + ' (' + Buffer.byteLength(output) + ' bytes)');
