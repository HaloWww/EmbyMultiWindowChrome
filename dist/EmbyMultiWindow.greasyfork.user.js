// ==UserScript==
// @name         Emby Multi Window
// @name:zh-CN   Emby 多画面播放器
// @namespace    https://github.com/HaloWww/EmbyMultiWindowChrome
// @version      0.7.28
// @author       HaloWww (westmelon)
// @license      All Rights Reserved
// @description  Emby 四画面播放、片段离线内存循环和独立播放窗口
// @match        http://*/web/*
// @match        https://*/web/*
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
// @grant        GM_getResourceText
// @connect      *
// @homepageURL  https://github.com/HaloWww/EmbyMultiWindowChrome
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.7.0-beta.2/dist/hls.min.js#sha256=EVhWL1k+LlZQuzgsf7rlEJDObvfecvdAZxS3uoMdvbE=
// @resource     embyHlsWorker https://cdn.jsdelivr.net/npm/hls.js@1.7.0-beta.2/dist/hls.worker.js#sha256=7d3qaLAflJL3WzNZnO87FSLoamaZQeCfgsN5tUZg56Q=
// ==/UserScript==

(function () {
'use strict';
/* Bundled HLS.js license:
Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

src/remux/mp4-generator.js and src/demux/exp-golomb.ts implementation in this project
are derived from the HLS library for video.js (https://github.com/videojs/videojs-contrib-hls)

That work is also covered by the Apache 2 License, following copyright:
Copyright (c) 2013-2015 Brightcove


THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/
const window = unsafeWindow;
const document = window.document;
const location = window.location;
const fetch = gmFetch;
const WORKER_SOURCE = GM_getResourceText('embyHlsWorker');
const PLAYER_HTML = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n    <title>&#8203;</title>\n    <link rel=\"stylesheet\" href=\"player.css\">\n</head>\n<body>\n    <main id=\"stage\" aria-live=\"polite\">\n        <div id=\"grid\"></div>\n        <div id=\"windowTools\">\n            <button id=\"newWindow\" type=\"button\" title=\"新建一个独立的多画面窗口\" aria-label=\"新建窗口\">\n                <span aria-hidden=\"true\">＋</span>\n            </button>\n            <button id=\"fullscreen\" type=\"button\" title=\"全屏（F / 双击画面）\" aria-label=\"全屏\" aria-pressed=\"false\">⛶</button>\n        </div>\n        <div id=\"empty\">\n            <div class=\"empty-icon\">▦</div>\n            <div>在 Emby 视频详情页或播放页点击“加入更多画面”</div>\n        </div>\n        <div id=\"toast\" role=\"status\"></div>\n    </main>\n    <script src=\"hls.js\"></script>\n    <script src=\"player.js\"></script>\n</body>\n</html>\n";
const PLAYER_CSS = ":root {\n    color-scheme: dark;\n    --preview-width: 280px;\n    background: #080808;\n}\n\n* {\n    box-sizing: border-box;\n}\n\nhtml,\nbody,\n#stage {\n    width: 100%;\n    height: 100%;\n    margin: 0;\n    overflow: hidden;\n}\n\nbody {\n    color: #fff;\n    background: #080808;\n    font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n}\n\n#stage {\n    position: relative;\n}\n\n#stage.controls-hidden {\n    cursor: none;\n}\n\n#grid {\n    display: grid;\n    width: 100%;\n    height: 100%;\n    gap: 1px;\n    padding: 0;\n}\n\n#windowTools {\n    position: fixed;\n    top: 7px;\n    right: 43px;\n    z-index: 12;\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    transition: opacity .18s ease;\n}\n\n#windowTools button {\n    display: inline-flex;\n    width: 30px;\n    height: 30px;\n    align-items: center;\n    justify-content: center;\n    gap: 5px;\n    padding: 0;\n    border: 1px solid rgba(255, 255, 255, .2);\n    border-radius: 999px;\n    color: rgba(255, 255, 255, .9);\n    background: rgba(12, 12, 12, .78);\n    box-shadow: 0 3px 12px rgba(0, 0, 0, .28);\n    font: 18px/1 system-ui, sans-serif;\n    backdrop-filter: blur(7px);\n    cursor: pointer;\n}\n\n#windowTools button:hover {\n    border-color: rgba(117, 204, 111, .72);\n    background: rgba(24, 24, 24, .94);\n}\n\n#windowTools button:disabled {\n    opacity: .55;\n    cursor: wait;\n}\n\n#windowTools button[hidden] { display: none; }\n\n#stage:fullscreen { background: #000; }\n\n#empty {\n    position: absolute;\n    inset: 0;\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    justify-content: center;\n    gap: 14px;\n    color: #aaa;\n    font-size: 15px;\n    text-align: center;\n}\n\n#empty[hidden] {\n    display: none;\n}\n\n.empty-icon {\n    color: #52b54b;\n    font-size: 44px;\n}\n\n.tile {\n    position: relative;\n    min-width: 0;\n    min-height: 0;\n    overflow: hidden;\n    border: 0;\n    border-radius: 0;\n    background: #000;\n}\n\n.tile video {\n    display: block;\n    width: 100%;\n    height: 100%;\n    background: #000;\n    object-fit: contain;\n}\n\n.title {\n    position: absolute;\n    top: 0;\n    right: 0;\n    left: 0;\n    z-index: 2;\n    overflow: hidden;\n    padding: 9px 116px 27px 42px;\n    background: linear-gradient(to bottom, rgba(0, 0, 0, .72), transparent);\n    font-size: 13px;\n    font-weight: 600;\n    pointer-events: none;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.drag-handle {\n    position: absolute;\n    top: 6px;\n    left: 7px;\n    z-index: 5;\n    display: grid;\n    width: 27px;\n    height: 28px;\n    padding: 0;\n    border: 0;\n    place-items: center;\n    color: rgba(255, 255, 255, .78);\n    background: transparent;\n    font-size: 18px;\n    line-height: 1;\n    cursor: grab;\n}\n\n.drag-handle:active {\n    cursor: grabbing;\n}\n\n.tile.dragging {\n    opacity: .42;\n}\n\n.tile.drop-before {\n    box-shadow: inset 3px 0 #52b54b;\n}\n\n.tile.drop-after {\n    box-shadow: inset -3px 0 #52b54b;\n}\n\n.close {\n    position: absolute;\n    top: 6px;\n    right: 6px;\n    z-index: 5;\n    width: 30px;\n    height: 30px;\n    padding: 0;\n    border: 0;\n    border-radius: 50%;\n    color: #fff;\n    background: rgba(0, 0, 0, .68);\n    font-size: 20px;\n    line-height: 30px;\n    cursor: pointer;\n}\n\n.close:hover {\n    background: #c62828;\n}\n\n.status {\n    position: absolute;\n    inset: 0;\n    z-index: 3;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    padding: 20px;\n    color: #fff;\n    background: rgba(0, 0, 0, .62);\n    font-size: 14px;\n    text-align: center;\n    cursor: pointer;\n}\n\n.status[hidden] {\n    display: none;\n}\n\n.controls {\n    position: absolute;\n    right: 0;\n    bottom: 0;\n    left: 0;\n    z-index: 4;\n    display: grid;\n    grid-template-areas:\n        \"segments\"\n        \"seek\"\n        \"transport\";\n    grid-template-rows: auto 18px 30px;\n    gap: 5px;\n    padding: 30px 10px 8px;\n    background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, .9));\n}\n\n.segments {\n    grid-area: segments;\n    display: flex;\n    min-width: 0;\n    justify-content: center;\n}\n\n.segments {\n    position: relative;\n}\n\n.segments::before {\n    position: absolute;\n    top: 50%;\n    left: max(7px, calc(50% - 174px));\n    z-index: 1;\n    color: #75cc6f;\n    content: \"↻\";\n    font-size: 14px;\n    pointer-events: none;\n    transform: translateY(-52%);\n}\n\n.segments::after {\n    position: absolute;\n    top: 50%;\n    right: max(8px, calc(50% - 174px));\n    border-top: 5px solid rgba(255, 255, 255, .72);\n    border-right: 4px solid transparent;\n    border-left: 4px solid transparent;\n    content: \"\";\n    pointer-events: none;\n    transform: translateY(-30%);\n}\n\n.segments select {\n    appearance: none;\n    width: min(100%, 360px);\n    min-width: 0;\n    height: 29px;\n    padding: 0 29px 0 29px;\n    border: 1px solid rgba(255, 255, 255, .18);\n    border-radius: 999px;\n    color: rgba(255, 255, 255, .94);\n    background: linear-gradient(180deg, rgba(40, 40, 40, .9), rgba(17, 17, 17, .9));\n    box-shadow: inset 0 1px rgba(255, 255, 255, .06), 0 2px 8px rgba(0, 0, 0, .2);\n    font: 12px system-ui, sans-serif;\n    cursor: pointer;\n}\n\n.segments select:hover,\n.segments select:focus {\n    border-color: rgba(117, 204, 111, .58);\n    outline: none;\n}\n\n.segments select option {\n    color: #171717;\n    background: #f4f4f4;\n}\n\n.segments select option:checked {\n    color: #fff;\n    background: #397f35;\n}\n\n.segments select option:disabled {\n    color: #666;\n    background: #e7e7e7;\n}\n\n.segments select:disabled {\n    color: rgba(255, 255, 255, .5);\n    cursor: default;\n    opacity: .72;\n}\n\n.seek {\n    position: relative;\n    grid-area: seek;\n    height: 18px;\n}\n\n.seek > input {\n    width: 100%;\n    height: 18px;\n    margin: 0;\n    accent-color: #52b54b;\n    cursor: pointer;\n}\n\n.preview {\n    position: absolute;\n    bottom: 58px;\n    width: var(--preview-width);\n    min-height: 34px;\n    overflow: hidden;\n    border-radius: 6px;\n    color: #fff;\n    background: #111;\n    box-shadow: 0 4px 16px rgba(0, 0, 0, .68);\n    pointer-events: none;\n    transform: translateX(-50%);\n}\n\n.preview.no-image {\n    min-height: 0;\n    border: 1px solid rgba(255, 255, 255, .2);\n    border-radius: 999px;\n    background: rgba(12, 12, 12, .94);\n    box-shadow: 0 3px 12px rgba(0, 0, 0, .52);\n}\n\n.preview[hidden],\n.preview-image[hidden] {\n    display: none;\n}\n\n.preview-image {\n    width: 100%;\n    aspect-ratio: 16 / 9;\n    background: #000 center / contain no-repeat;\n}\n\n.preview-text {\n    overflow: hidden;\n    padding: 5px 8px;\n    font-size: 12px;\n    text-align: center;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.preview.no-image .preview-text {\n    padding: 6px 11px;\n    color: rgba(255, 255, 255, .94);\n    font-size: 11px;\n    font-variant-numeric: tabular-nums;\n    letter-spacing: .02em;\n}\n\n.transport {\n    grid-area: transport;\n    display: flex;\n    min-width: 0;\n    height: 30px;\n    align-items: center;\n    gap: 8px;\n}\n\n.play {\n    flex: none;\n    width: 34px;\n    height: 30px;\n    padding: 0;\n    border: 0;\n    border-radius: 5px;\n    color: #fff;\n    background: rgba(255, 255, 255, .15);\n    font-size: 16px;\n    cursor: pointer;\n}\n\n.volume {\n    display: flex;\n    width: min(34%, 150px);\n    min-width: 76px;\n    align-items: center;\n    gap: 5px;\n}\n\n.volume input {\n    width: 100%;\n    min-width: 0;\n    accent-color: #52b54b;\n}\n\n.time {\n    margin-left: auto;\n    font-size: 11px;\n    white-space: nowrap;\n}\n\n.title,\n.close,\n.status,\n.controls {\n    transition: opacity .18s ease;\n}\n\n.controls-hidden .title,\n.controls-hidden .close,\n.controls-hidden .drag-handle,\n.controls-hidden #windowTools,\n.controls-hidden .status[data-phase=\"clip-cache\"],\n.controls-hidden .status[data-phase=\"memory-ready\"],\n.controls-hidden .controls {\n    opacity: 0;\n    pointer-events: none;\n}\n\n#toast {\n    position: fixed;\n    right: 18px;\n    bottom: 18px;\n    z-index: 20;\n    max-width: min(390px, calc(100vw - 36px));\n    padding: 10px 13px;\n    border: 1px solid rgba(255, 255, 255, .16);\n    border-radius: 7px;\n    color: #fff;\n    background: rgba(20, 20, 20, .95);\n    box-shadow: 0 7px 24px rgba(0, 0, 0, .45);\n    font-size: 13px;\n    opacity: 0;\n    pointer-events: none;\n    transform: translateY(7px);\n    transition: opacity .18s ease, transform .18s ease;\n}\n\n#toast.visible {\n    opacity: 1;\n    transform: translateY(0);\n}\n\n@media (max-width: 620px) {\n    #windowTools {\n        top: 41px;\n    }\n}\n\n@media (max-height: 520px) {\n    .controls {\n        grid-template-areas: \"seek seek\" \"segments transport\";\n        grid-template-columns: minmax(130px, .8fr) minmax(210px, 1.2fr);\n        grid-template-rows: 18px 30px;\n    }\n\n    .segments select {\n        width: 100%;\n    }\n\n    .preview {\n        bottom: 24px;\n    }\n}\n";
const OPTIONS_HTML = "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n    <meta charset=\"utf-8\">\n    <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n    <title>Emby 多画面设置</title>\n    <link rel=\"stylesheet\" href=\"options.css\">\n</head>\n<body>\n    <main>\n        <header>\n            <div class=\"mark\">▦</div>\n            <div>\n                <h1>Emby 多画面设置</h1>\n                <p>设置会自动应用到已打开的多画面窗口。</p>\n            </div>\n        </header>\n\n        <section>\n            <h2>适配的网址</h2>\n            <p class=\"explain site-help\">\n                只有列表中的 HTTP/HTTPS 地址会加载 Emby 多画面功能。省略端口表示允许该主机的任意端口。\n            </p>\n            <div class=\"site-editor\">\n                <input id=\"siteInput\" type=\"text\"\n                    placeholder=\"例如：http://192.168.8.8:8096\"\n                    aria-label=\"Emby 服务器网址\">\n                <button id=\"addSite\" type=\"button\">添加网址</button>\n            </div>\n            <div id=\"siteError\" role=\"alert\"></div>\n            <ul id=\"siteList\" aria-label=\"已适配的网址\"></ul>\n            <p class=\"site-note\">支持示例：<code>https://emby.example.com</code>、<code>https://*.example.com</code>。修改后请刷新 Emby 页面。</p>\n        </section>\n\n        <section>\n            <div class=\"setting-head\">\n                <label for=\"previewWidth\">进度预览窗口宽度</label>\n                <output id=\"previewWidthValue\" for=\"previewWidth\">280 px</output>\n            </div>\n            <input id=\"previewWidth\" type=\"range\" min=\"180\" max=\"520\" step=\"10\" value=\"280\">\n            <div class=\"scale\"><span>180 px</span><span>520 px</span></div>\n            <div id=\"previewSample\">\n                <div class=\"sample-image\">预览画面</div>\n                <div class=\"sample-time\">章节名称 · 12:34</div>\n            </div>\n        </section>\n\n        <section>\n            <div class=\"setting-head\">\n                <label for=\"controlsIdleSeconds\">控件自动隐藏延迟</label>\n                <output id=\"controlsIdleSecondsValue\"\n                    for=\"controlsIdleSeconds\">2.5 秒</output>\n            </div>\n            <input id=\"controlsIdleSeconds\" type=\"range\"\n                min=\"0.5\" max=\"30\" step=\"0.5\" value=\"2.5\">\n            <div class=\"scale\"><span>0.5 秒</span><span>30 秒</span></div>\n            <p class=\"site-note\">\n                鼠标、键盘停止操作后，标题、播放控件和缓存进度提示会在设定时间后一起隐藏。\n            </p>\n        </section>\n\n        <section>\n            <h2>循环片段缓存</h2>\n            <p class=\"explain cache-help\">\n                普通播放始终优先直连，不会写入扩展缓存。选择循环片段后才会完整预取对应 HLS 分片，完成后停止服务器转码并从内存循环；关闭画面后立即释放该路缓存。\n            </p>\n            <div class=\"cache-setting\">\n                <label for=\"mediaCacheMode\">片段缓存方式</label>\n                <select id=\"mediaCacheMode\">\n                    <option value=\"memory\">每路内存缓存</option>\n                    <option value=\"off\">关闭缓存，在线循环</option>\n                </select>\n            </div>\n            <div id=\"cacheLimitRow\">\n                <div class=\"setting-head\">\n                    <label for=\"mediaCacheLimitMb\">每路最大缓存</label>\n                    <output id=\"mediaCacheLimitValue\" for=\"mediaCacheLimitMb\">4 GB</output>\n                </div>\n                <input id=\"mediaCacheLimitMb\" type=\"range\"\n                    min=\"256\" max=\"16384\" step=\"256\" value=\"4096\">\n                <div class=\"scale\"><span>256 MB</span><span>16 GB</span></div>\n            </div>\n            <p class=\"site-note\">\n                容量上限只用于片段完整预取。关闭片段缓存后，选中的片段仍会循环，但会继续读取服务器。直连 MP4 的 HTTP 缓存仍由 Chrome 和 Emby 的 Range 策略控制。\n            </p>\n        </section>\n\n        <section>\n            <h2>多画面窗口</h2>\n            <p class=\"explain\">窗口大小会在拖动后自动记忆。重置后，下次新建窗口使用 1100 × 720。</p>\n            <button id=\"resetWindow\" type=\"button\">恢复默认窗口大小</button>\n        </section>\n\n        <div id=\"saved\" role=\"status\">设置已保存</div>\n    </main>\n    <script src=\"options.js\"></script>\n</body>\n</html>\n";
const OPTIONS_CSS = ":root {\n    color-scheme: dark;\n    background: #111;\n}\n\n* {\n    box-sizing: border-box;\n}\n\nbody {\n    min-width: 520px;\n    margin: 0;\n    color: #eee;\n    background: #111;\n    font-family: system-ui, -apple-system, \"Segoe UI\", sans-serif;\n}\n\nmain {\n    width: min(720px, calc(100vw - 32px));\n    margin: 36px auto;\n}\n\nheader {\n    display: flex;\n    align-items: center;\n    gap: 16px;\n    margin-bottom: 26px;\n}\n\n.mark {\n    color: #52b54b;\n    font-size: 44px;\n}\n\nh1,\nh2,\np {\n    margin: 0;\n}\n\nh1 {\n    font-size: 25px;\n}\n\nh2 {\n    margin-bottom: 9px;\n    font-size: 17px;\n}\n\nheader p,\n.explain {\n    margin-top: 5px;\n    color: #aaa;\n    font-size: 13px;\n}\n\nsection {\n    margin-bottom: 18px;\n    padding: 20px;\n    border: 1px solid #333;\n    border-radius: 10px;\n    background: #1a1a1a;\n}\n\n.site-help {\n    margin-bottom: 13px;\n}\n\n.site-editor {\n    display: flex;\n    align-items: stretch;\n    gap: 8px;\n}\n\n.site-editor input {\n    min-width: 0;\n    flex: 1;\n    padding: 9px 11px;\n    border: 1px solid #444;\n    border-radius: 6px;\n    color: #fff;\n    background: #111;\n    font: 13px system-ui, sans-serif;\n}\n\n.site-editor input:focus {\n    border-color: #62ba5d;\n    outline: none;\n    box-shadow: 0 0 0 2px rgba(82, 181, 75, .18);\n}\n\n.site-editor button {\n    margin-top: 0;\n}\n\n#siteError {\n    min-height: 19px;\n    padding-top: 5px;\n    color: #ff8b8b;\n    font-size: 12px;\n}\n\n#siteList {\n    display: grid;\n    gap: 7px;\n    margin: 5px 0 0;\n    padding: 0;\n    list-style: none;\n}\n\n#siteList li {\n    display: flex;\n    min-width: 0;\n    align-items: center;\n    gap: 10px;\n    padding: 8px 9px 8px 11px;\n    border: 1px solid #333;\n    border-radius: 7px;\n    background: #141414;\n}\n\n#siteList code {\n    overflow: hidden;\n    flex: 1;\n    color: #d7d7d7;\n    font-size: 12px;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n#siteList button {\n    margin: 0;\n    padding: 4px 9px;\n    border-color: #493838;\n    color: #ffb0b0;\n    font-size: 12px;\n}\n\n.site-note {\n    margin-top: 11px;\n    color: #888;\n    font-size: 12px;\n}\n\n.site-note code {\n    color: #aaa;\n}\n\n.cache-help {\n    margin-bottom: 15px;\n}\n\n.cache-setting {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 16px;\n    margin-bottom: 18px;\n}\n\n.cache-setting label {\n    font-weight: 600;\n}\n\n.cache-setting select {\n    min-width: 180px;\n    padding: 8px 30px 8px 10px;\n    border: 1px solid #444;\n    border-radius: 6px;\n    color: #eee;\n    background: #222;\n}\n\n#cacheLimitRow.is-disabled {\n    opacity: .42;\n}\n\n#mediaCacheLimitMb {\n    width: 100%;\n    accent-color: #52b54b;\n}\n\n.setting-head {\n    display: flex;\n    justify-content: space-between;\n    margin-bottom: 14px;\n}\n\n.setting-head label {\n    font-weight: 600;\n}\n\noutput {\n    color: #75cc6f;\n    font-variant-numeric: tabular-nums;\n}\n\n#previewWidth,\n#controlsIdleSeconds {\n    width: 100%;\n    accent-color: #52b54b;\n}\n\n.scale {\n    display: flex;\n    justify-content: space-between;\n    color: #888;\n    font-size: 11px;\n}\n\n#previewSample {\n    width: 280px;\n    max-width: 100%;\n    margin: 22px auto 0;\n    overflow: hidden;\n    border-radius: 7px;\n    background: #0b0b0b;\n    box-shadow: 0 5px 20px rgba(0, 0, 0, .45);\n}\n\n.sample-image {\n    display: flex;\n    aspect-ratio: 16 / 9;\n    align-items: center;\n    justify-content: center;\n    color: #777;\n    background: linear-gradient(135deg, #151515, #292929);\n}\n\n.sample-time {\n    padding: 6px 8px;\n    font-size: 12px;\n    text-align: center;\n}\n\nbutton {\n    margin-top: 15px;\n    padding: 8px 14px;\n    border: 1px solid #4a4a4a;\n    border-radius: 6px;\n    color: #fff;\n    background: #2a2a2a;\n    cursor: pointer;\n}\n\nbutton:hover {\n    background: #343434;\n}\n\n#saved {\n    position: fixed;\n    right: 22px;\n    bottom: 20px;\n    padding: 9px 12px;\n    border-radius: 6px;\n    color: #fff;\n    background: #2d7d2a;\n    opacity: 0;\n    transform: translateY(7px);\n    transition: opacity .18s ease, transform .18s ease;\n}\n\n#saved.visible {\n    opacity: 1;\n    transform: translateY(0);\n}\n";
const ENTRY_CSS = "#emby-multiwindow-toast {\n    position: fixed;\n    right: 22px;\n    bottom: 22px;\n    z-index: 2147483647;\n    max-width: min(380px, calc(100vw - 44px));\n    padding: 11px 14px;\n    border: 1px solid rgba(255, 255, 255, .16);\n    border-radius: 8px;\n    color: #fff;\n    background: rgba(16, 16, 16, .96);\n    box-shadow: 0 8px 30px rgba(0, 0, 0, .42);\n    font: 14px/1.45 system-ui, -apple-system, \"Segoe UI\", sans-serif;\n    opacity: 0;\n    pointer-events: none;\n    transform: translateY(8px);\n    transition: opacity .18s ease, transform .18s ease;\n}\n\n#emby-multiwindow-toast.is-visible {\n    opacity: 1;\n    transform: translateY(0);\n}\n\n.emby-multiwindow-detail-button {\n    display: inline-flex;\n    align-items: center;\n    gap: .5em;\n}\n\n.emby-multiwindow-icon {\n    color: #52b54b;\n    font-size: 1.15em;\n}\n\n#emby-multiwindow-launcher {\n    position: fixed;\n    right: 22px;\n    bottom: max(22px, env(safe-area-inset-bottom));\n    z-index: 2147483646;\n    display: inline-flex;\n    min-height: 42px;\n    align-items: center;\n    gap: 8px;\n    padding: 0 16px;\n    border: 1px solid rgba(255, 255, 255, .2);\n    border-radius: 999px;\n    color: #fff;\n    background: rgba(18, 18, 18, .92);\n    box-shadow: 0 6px 24px rgba(0, 0, 0, .35);\n    font: 600 14px/1 system-ui, -apple-system, \"Segoe UI\", sans-serif;\n    cursor: pointer;\n    transition: background .16s ease, opacity .16s ease, transform .16s ease;\n}\n\n#emby-multiwindow-launcher[hidden] {\n    display: none;\n}\n\n#emby-multiwindow-launcher:hover {\n    background: rgba(35, 35, 35, .98);\n    transform: translateY(-1px);\n}\n\n#emby-multiwindow-launcher:disabled,\n.emby-multiwindow-detail-button:disabled {\n    cursor: wait;\n    opacity: .62;\n}\n";
const Hls = globalThis.Hls || unsafeWindow.Hls;
function runPlayer() {
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
    var fullscreenButton = document.getElementById('fullscreen');
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
    var diagnosticFetch = fetch;

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
            hlsVersion: Hls && Hls.version || '',
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
            httpStatus: data && data.response && data.response.code ||
                data && data.networkDetails && data.networkDetails.status || null,
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
        hlsVersion: Hls && Hls.version || '',
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
            if (slot.clipOfflinePlaylist) {
                hlsConfig.timelineOffset = slot.clipOfflinePlaylist.start;
            }
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
        slot.clipOfflinePlaylist = null;
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
            context &&
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
                var offline = slot.mediaCacheEnabled && slot.clipOfflinePlaylist;
                if (offline && context.responseType === 'text' &&
                    canonicalMediaUrl(context.url) === canonicalMediaUrl(offline.url)) {
                    this.cacheHit = true;
                    var now = performance.now();
                    this.stats.loading.start = now;
                    this.stats.loading.first = now;
                    this.stats.loading.end = now;
                    this.stats.loaded = this.stats.total = offline.text.length;
                    queueMicrotask(function () {
                        if (loader.callbacks && !loader.stats.aborted) {
                            callbacks.onSuccess({url: context.url, data: offline.text, code: 200},
                                loader.stats, context, null);
                        }
                    });
                    return;
                }
                if (!shouldCacheLoaderContext(slot, context)) {
                    if (offline) {
                        failOfflineLoad(slot, loader, context, callbacks);
                        return;
                    }
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
                if (offline || slot.clipCacheReady) {
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
                    failOfflineLoad(slot, loader, context, callbacks);
                    return;
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

    function failOfflineLoad(slot, loader, context, callbacks) {
        // An offline resource set must never silently restart a stopped encoder.
        loader.cacheHit = true;
        queueMicrotask(function () {
            if (!loader.callbacks || loader.stats.aborted) {
                return;
            }
            callbacks.onError({code: 0, text: '本地片段资源缺失'}, context, null, loader.stats);
            if (slot.clipCacheReady && !slot.recoveringCache && !slot.stopped) {
                slot.recoveringCache = true;
                restoreOnlinePlayback(slot, '内存资源缺失 · 正在恢复在线播放…')
                    .catch(function (error) {
                        setPlaybackStatus(slot, 'cache-recovery-failed', error.message);
                    }).finally(function () { slot.recoveringCache = false; });
            }
        });
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
            parsePlaylist: parseMediaPlaylist,
            offlinePlaylist: createOfflinePlaylist,
            dependencies: clipPlanDependencies,
            restoreOnline: restoreOnlinePlayback,
            addPayload: addPayload,
            getSlots: function () { return Array.from(slots.values()); },
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
        requests.push(stopActiveEncoding(slot, slot.stream, keepalive).catch(function () {}));
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
        document.title = '\u200b';
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
        var previousStream = slot.stream;
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
            if (previousStream && previousStream.playMethod === 'Transcode' &&
                !streamMatches(previousStream, targetStream)) {
                stopActiveEncoding(slot, previousStream).catch(function () {});
            }
            return true;
        }).catch(function (error) {
            slot.switchingStream = false;
            slot.status.hidden = false;
            slot.status.textContent = error.message || '切换播放方式失败';
            throw error;
        });
    }

    function switchToFallback(slot, reason) {
        slot.directPlaybackFailed = true;
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

    function restoreOnlinePlayback(slot, reason, positionMs) {
        var resumeMs = Number.isFinite(positionMs) ? positionMs :
            Math.max(0, slot.video.currentTime * 1000 || 0);
        var target = !slot.directPlaybackFailed && slot.directStream ||
            createClipCacheStream(slot, {start: resumeMs / 1000});
        if (!target) {
            return Promise.reject(new Error('没有可恢复的在线播放流。'));
        }
        slot.forceClipCache = false;
        cancelClipCache(slot, false);
        releaseMediaCache(slot);
        setSegmentCacheLabel(slot, '在线', '已切换到在线播放');
        return switchSlotStream(slot, target, reason, false, resumeMs);
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
        var keyTag = '';
        var keyResource = null;
        var initSegment = null;
        var discontinuity = 0;
        var version = 3;
        if (/#EXT-X-(?:DEFINE|SKIP|PART|GAP|I-FRAMES-ONLY)(?=:|\s|$)/im.test(text)) {
            throw new Error('当前 HLS 清单包含暂不支持离线缓存的标签');
        }
        lines.forEach(function (rawLine) {
            var line = rawLine.trim();
            var match;
            if (!line) {
                return;
            }
            match = /^#EXT-X-VERSION:(\d+)/i.exec(line);
            if (match) { version = Number(match[1]); return; }
            match = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/i.exec(line);
            if (match) { discontinuity = Number(match[1]); return; }
            if (line === '#EXT-X-DISCONTINUITY') { discontinuity += 1; return; }
            if (/^#EXT-X-KEY:/i.test(line)) {
                var method = /(?:^|,)METHOD=([^,]+)/i.exec(line.slice(line.indexOf(':') + 1));
                if (!method || !/^(NONE|AES-128)$/i.test(method[1])) {
                    throw new Error('当前 HLS 加密方式不支持片段离线缓存');
                }
                keyTag = rewritePlaylistUris(line, playlistUrl);
                var keyUri = /URI="([^"]+)"/i.exec(keyTag);
                keyResource = method[1].toUpperCase() === 'NONE' ? null :
                    Object.assign(playlistResource(keyUri && keyUri[1], 0, 0), {resourceType: 'key'});
                return;
            }
            if (/^#EXT-X-MAP:/i.test(line)) {
                var mapTag = rewritePlaylistUris(line, playlistUrl);
                var mapUri = /URI="([^"]+)"/i.exec(mapTag);
                var mapRange = /BYTERANGE="(\d+)@(\d+)"/i.exec(mapTag);
                if (/BYTERANGE=/i.test(mapTag) && !mapRange) {
                    throw new Error('初始化段字节范围缺少显式偏移');
                }
                initSegment = Object.assign(playlistResource(mapUri && mapUri[1],
                    mapRange ? Number(mapRange[2]) : 0,
                    mapRange ? Number(mapRange[2]) + Number(mapRange[1]) : 0),
                    {tag: mapTag, keyTag: keyTag, keyResource: keyResource});
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
                cc: discontinuity,
                keyTag: keyTag,
                keyResource: keyResource,
                initSegment: initSegment,
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
            targetduration: targetDuration,
            version: version
        };
    }

    function rewritePlaylistUris(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/g, function (_, uri) {
            return 'URI="' + new URL(uri, baseUrl).href + '"';
        });
    }

    function playlistResource(url, rangeStart, rangeEnd) {
        if (!url) { throw new Error('HLS 依赖资源缺少 URI'); }
        return {url: url, rangeStart: rangeStart, rangeEnd: rangeEnd,
            key: mediaCacheKey({url: url, rangeStart: rangeStart, rangeEnd: rangeEnd})};
    }

    function clipPlanDependencies(plan) {
        var resources = new Map();
        plan.forEach(function (entry) {
            var fragment = entry.fragment;
            [fragment.keyResource, fragment.initSegment,
                fragment.initSegment && fragment.initSegment.keyResource].forEach(function (resource) {
                if (resource) { resources.set(resource.key, resource); }
            });
        });
        return Array.from(resources.values());
    }

    function createOfflinePlaylist(plan, details, url) {
        if (!plan.length) { throw new Error('本地清单没有分片'); }
        var first = plan[0].fragment;
        var target = Math.ceil(Math.max.apply(null, plan.map(function (entry) {
            return entry.duration;
        })));
        var lines = ['#EXTM3U', '#EXT-X-VERSION:' + Math.max(7, details.version || 3),
            '#EXT-X-TARGETDURATION:' + target, '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-MEDIA-SEQUENCE:' + (Number(first.sn) || 0),
            '#EXT-X-DISCONTINUITY-SEQUENCE:' + (Number(first.cc) || 0)];
        var lastCc = first.cc;
        var lastKey = '';
        var lastMap = '';
        plan.forEach(function (entry) {
            var fragment = entry.fragment;
            if (fragment.cc !== lastCc) { lines.push('#EXT-X-DISCONTINUITY'); lastCc = fragment.cc; }
            var map = fragment.initSegment;
            if (map && map.tag !== lastMap) {
                if (map.keyTag && map.keyTag !== lastKey) {
                    lines.push(map.keyTag); lastKey = map.keyTag;
                }
                lines.push(map.tag); lastMap = map.tag;
            }
            if (fragment.keyTag && fragment.keyTag !== lastKey) {
                lines.push(fragment.keyTag); lastKey = fragment.keyTag;
            }
            lines.push('#EXTINF:' + entry.duration.toFixed(6) + ',');
            if (entry.rangeEnd > entry.rangeStart) {
                lines.push('#EXT-X-BYTERANGE:' + (entry.rangeEnd - entry.rangeStart) + '@' + entry.rangeStart);
            }
            lines.push(entry.url);
        });
        lines.push('#EXT-X-ENDLIST');
        return {url: url, text: lines.join('\n') + '\n', start: plan[0].start,
            end: plan[plan.length - 1].end};
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
        return {text: await response.text(), url: response.url || url};
    }

    async function loadClipPlaylistDetails(slot, cacheStream, signal) {
        var master = await fetchPlaylistText(
            cacheStream.url,
            cacheStream,
            signal
        );
        var masterText = master.text;
        if (/#EXT-X-MEDIA:.*TYPE=AUDIO.*URI=/i.test(masterText) ||
            /#EXT-X-MEDIA:.*URI=.*TYPE=AUDIO/i.test(masterText)) {
            throw new Error('当前 HLS 使用独立音轨，保留在线播放');
        }
        var mediaUrl = master.url;
        var mediaText = masterText;
        if (!/#EXTINF:/i.test(masterText)) {
            mediaUrl = playlistVariantUrl(
                masterText,
                master.url,
                cacheStream
            );
            if (!mediaUrl) {
                throw new Error('HLS 主清单中没有媒体清单地址');
            }
            var media = await fetchPlaylistText(
                mediaUrl,
                cacheStream,
                signal
            );
            mediaText = media.text;
            mediaUrl = media.url;
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
                    details: details,
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
            details: details,
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
            if (entry.rangeEnd > entry.rangeStart) {
                if (response.status === 200) {
                    data = data.slice(entry.rangeStart, entry.rangeEnd);
                }
                if (data.byteLength !== entry.rangeEnd - entry.rangeStart) {
                    throw new Error('分片字节范围响应不完整');
                }
            }
            if (entry.resourceType === 'key' && data.byteLength !== 16) {
                throw new Error('AES-128 密钥长度不正确');
            }
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
            slot.lastSegmentFrameAt = performance.now();
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

    function stopActiveEncoding(slot, stream, keepalive) {
        var url = new URL(slot.endpoints.stopEncoding, location.href);
        var playSessionId = stream && stream.playSessionId;
        if (playSessionId) {
            url.searchParams.set('PlaySessionId', playSessionId);
        }
        return fetch(url.href, {
            method: 'POST',
            keepalive: !!keepalive
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
        if (slot.directStream && !slot.directPlaybackFailed &&
            !streamMatches(slot.stream, slot.directStream)) {
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
            var dependencies = clipPlanDependencies(plan);
            var resources = dependencies.concat(plan);
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
            var protectedKeys = new Set(resources.map(function (entry) {
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
                resources,
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
            slot.clipCacheBytes = resources.reduce(function (total, entry) {
                var cached = slot.mediaCache.get(entry.key);
                return total + (cached ? cached.size || 0 : 0);
            }, 0);
            var cacheComplete = resources.every(function (entry) {
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
            slot.clipOfflinePlaylist = createOfflinePlaylist(plan, planResult.details, cacheStream.url);
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
            if (streamMatches(slot.stream, cacheStream) && !slot.stopped) {
                await restoreOnlinePlayback(slot, '内存缓存失败 · 正在恢复在线播放…',
                    segment.startMs).catch(function () {});
            } else {
                slot.clipOfflinePlaylist = null;
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
        tile.setAttribute('aria-label', displayName(slot.item));
        var video = document.createElement('video');
        video.controls = false;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        var title = document.createElement('div');
        title.className = 'title';
        title.textContent = displayName(slot.item);
        title.title = title.textContent;
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
                    restoreOnlinePlayback(slot, '正在恢复在线循环…', slot.activeSegment.startMs)
                        .then(function () { video.play().catch(function () {}); })
                        .catch(function (error) { showToast(error.message, 4800); });
                } else {
                    slot.forceClipCache = true;
                    cacheActiveSegment(slot);
                }
            } else {
                restoreOnlinePlayback(slot, '正在恢复在线播放…')
                    .catch(function (error) { showToast(error.message, 4800); });
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
                var seekDuration = slot.clipOfflinePlaylist ? mediaDurationSeconds(slot) : video.duration;
                var seconds = seekDuration * Number(seekSlider.value) / 1000;
                if (slot.clipOfflinePlaylist && slot.activeSegment) {
                    seconds = Math.max(slot.activeSegment.startMs / 1000,
                        Math.min(slot.activeSegment.endMs / 1000 - 0.05, seconds));
                }
                seekExact(video, seconds * 1000);
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
            // cadence. Use timeupdate when background rendering suppresses frames too.
            if ((typeof video.requestVideoFrameCallback !== 'function' ||
                performance.now() - (slot.lastSegmentFrameAt || 0) > 500) &&
                slot.activeSegment && !slot.loopSeeking && !video.seeking) {
                var currentMs = video.currentTime * 1000;
                if (currentMs < slot.activeSegment.startMs - 500 ||
                    currentMs >= slot.activeSegment.endMs) {
                    restartSegmentLoop(slot);
                }
            }
            var displayDuration = slot.clipOfflinePlaylist ? mediaDurationSeconds(slot) : video.duration;
            time.textContent = formatTime(video.currentTime) +
                (Number.isFinite(displayDuration) ? ' / ' + formatTime(displayDuration) : '');
            if (!slot.seekDragging && Number.isFinite(displayDuration) && displayDuration > 0) {
                seekSlider.value = String(Math.round(video.currentTime / displayDuration * 1000));
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
            if (!Hls || (typeof Hls.isSupported === 'function' && !Hls.isSupported())) {
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
            if (slot.stopped || slot.stream && !streamMatches(slot.stream, stream)) {
                return;
            }
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
            if (started || slot.stopped || slot.stream && !streamMatches(slot.stream, stream)) {
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
            clipOfflinePlaylist: null,
            recoveringCache: false,
            directPlaybackFailed: false,
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
                    restoreOnlinePlayback(slot, '片段缓存已关闭 · 正在恢复在线播放…')
                        .catch(function (error) { showToast(error.message, 4800); });
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
                if (!trimMediaCache(slot, slot.clipCacheProtectedKeys) && slot.clipCacheReady) {
                    restoreOnlinePlayback(slot, '缓存超过新容量上限 · 正在恢复在线播放…')
                        .catch(function (error) { showToast(error.message, 4800); });
                }
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
    function toggleFullscreen() {
        try {
            var action = document.fullscreenElement ? document.exitFullscreen() :
                stage.requestFullscreen({navigationUI: 'hide'});
            Promise.resolve(action).catch(function (error) {
                showToast(error.message || '无法进入全屏，请使用浏览器的全屏功能。', 4800);
            });
        } catch (error) {
            showToast('此浏览器无法进入全屏，请使用浏览器的全屏功能。', 4800);
        }
    }
    fullscreenButton.hidden = !document.fullscreenEnabled;
    fullscreenButton.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', function () {
        var active = !!document.fullscreenElement;
        fullscreenButton.textContent = active ? '⤢' : '⛶';
        fullscreenButton.title = active ? '退出全屏（Esc / F）' : '全屏（F / 双击画面）';
        fullscreenButton.setAttribute('aria-label', active ? '退出全屏' : '全屏');
        fullscreenButton.setAttribute('aria-pressed', String(active));
        revealControls();
    });
    stage.addEventListener('dblclick', function (event) {
        if (event.target === stage || event.target === grid || event.target.tagName === 'VIDEO') {
            event.preventDefault();
            toggleFullscreen();
        }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key.toLowerCase() !== 'f' || event.repeat || event.ctrlKey || event.altKey || event.metaKey ||
            event.target.closest('input, select, textarea, [contenteditable="true"]')) { return; }
        event.preventDefault();
        toggleFullscreen();
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

}
function runOptions() {
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

}
function runEntry() {
(function () {
    'use strict';

    if (window.__embyMultiWindowLoaded) {
        return;
    }
    window.__embyMultiWindowLoaded = true;

    var VERSION = '0.7.28';
    var READY_RETRY_MS = 700;
    var MODULE_ROOT = './modules/';
    var SEGMENT_STORAGE_KEY = 'embySegmentLoop.v1';
    var launcher = null;
    var toast = null;
    var toastTimer = null;
    var readyAttempts = 0;
    var launcherTimer = null;
    var launcherObserver = null;
    var detailRequests = new WeakMap();
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
        var width = Number(videoStream.Width) || 0;
        var height = Number(videoStream.Height) || 0;
        var frameRate = Number(videoStream.RealFrameRate ||
            videoStream.AverageFrameRate) || 0;
        var level = Number(videoStream.Level) || 0;
        var levelCode = level > 0 && level < 10 ? level * 10 : level;
        var bitrate = Number(videoStream.BitRate || source.Bitrate) || 0;
        var mime;
        if (codec === 'hevc' || codec === 'h265') {
            return false;
        }
        if (codec === 'h264' || codec === 'avc') {
            if (bitDepth > 8 || /high\s*10|high\s*4:|4:4:4/.test(profile) ||
                (pixelFormat && !/^(yuvj?420p|nv12)$/.test(pixelFormat)) ||
                levelCode > 52 ||
                (width && height && width * height > 3840 * 2160) ||
                frameRate > 60 || bitrate > 40000000) {
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
        var options = {
            UserId: client.getCurrentUserId(),
            StartTimeTicks: context.positionTicks || 0,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            // Always ask Emby for an HLS-capable path. The original file URL
            // is built separately so the player window can choose either one.
            EnableDirectPlay: false,
            EnableDirectStream: false,
            // The visible pane still opens the original file directly. The HLS
            // path exists specifically for a cached loop, so it must have
            // encoder-created keyframes at the HLS boundaries. Stream-copying
            // long-GOP H.264 can produce (for example) 10.4 seconds of media in
            // a playlist entry advertised as 6 seconds, shifting the cached
            // content away from the segment timestamps selected on the MP4.
            AllowVideoStreamCopy: false,
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
        Array.from(compatibleUrl.searchParams.keys()).forEach(function (key) {
            if (key.toLowerCase() === 'allowvideostreamcopy') {
                compatibleUrl.searchParams.delete(key);
            }
        });
        compatibleUrl.searchParams.set('VideoCodec', 'h264');
        compatibleUrl.searchParams.set('AllowVideoStreamCopy', 'false');
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
        // Cache streams must be timestamp-accurate even when the browser can
        // direct-play the source. Long-GOP stream copy makes Emby's nominal
        // HLS durations diverge from the TS presentation timestamps.
        streamUrl = forceCompatibleTranscodeUrl(streamUrl);
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
        var preparedWindow = null;
        try {
            preparedWindow = window.__embyMultiWindowPrepareWindow ?
                window.__embyMultiWindowPrepareWindow(!!openInNewWindow) : null;
        } catch (error) {
            showToast(error.message || '无法打开多画面窗口。', 4800);
            return;
        }
        if (trigger) {
            trigger.disabled = true;
        }
        Promise.resolve(contextPromise).then(function (context) {
            return preparePayload(context).then(function (payload) {
                payload.openInNewWindow = !!openInNewWindow;
                if (preparedWindow) { payload.targetPlayerId = preparedWindow; }
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
        view = view || event.target;
        if (view && item) { view.embyMultiWindowItem = item; }
        renderDetailButton(view, item);
    }

    function routeItemId() {
        var match = location.href.match(/[?&#](?:id|itemid)=([^&#]+)/i);
        try { return match ? decodeURIComponent(match[1]) : null; }
        catch (_) { return null; }
    }

    function scanDetailButtons() {
        document.querySelectorAll('.mainDetailButtons').forEach(function (host) {
            if (!host.isConnected || !host.getClientRects().length) { return; }
            var view = host.closest('.itemView') || host.parentElement;
            if (!view) { return; }
            var itemId = routeItemId() || view.getAttribute('data-itemid');
            var item = view.embyMultiWindowItem;
            if (item && (!itemId || String(item.Id) === String(itemId))) {
                renderDetailButton(view, item);
                return;
            }
            var button = host.querySelector('.emby-multiwindow-detail-button');
            if (button && itemId && String(button.embyMultiWindowItem.Id) !== String(itemId)) { button.remove(); }
            var client = window.ApiClient;
            if (!itemId || !client || typeof client.getItem !== 'function' ||
                typeof client.getCurrentUserId !== 'function' || !client.getCurrentUserId()) { return; }
            var previous = detailRequests.get(host);
            if (previous && previous.id === itemId && (previous.pending || Date.now() - previous.time < 5000)) { return; }
            var request = {id: itemId, pending: true, time: Date.now()};
            var route = location.href;
            detailRequests.set(host, request);
            Promise.resolve().then(function () {
                return client.getItem(client.getCurrentUserId(), itemId);
            }).then(function (loaded) {
                if (detailRequests.get(host) !== request || !host.isConnected ||
                    !host.getClientRects().length || location.href !== route) { return; }
                view.embyMultiWindowItem = loaded;
                renderDetailButton(view, loaded);
            }).catch(function (error) {
                warn('读取详情页视频失败。', error);
            }).finally(function () { request.pending = false; request.time = Date.now(); });
        });
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
        scanDetailButtons();
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
        if (document.body && window.Emby && typeof window.Emby.importModule === 'function' &&
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
            setInterval(updateLauncherVisibility, 2000);
            log('Extension initialized.');
            return;
        }
        readyAttempts += 1;
        setTimeout(initializeWhenReady, readyAttempts < 90 ? READY_RETRY_MS : 3000);
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

}
// Bundled by tools/build-userscript.cjs inside a private userscript scope.
const VERSION = '0.7.28';
const namespace = 'embyMultiWindow.userscript.';
const listeners = [];
const runtimeListeners = [];
function newId() {
    if (typeof crypto.randomUUID === 'function') { return crypto.randomUUID(); }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
const playerId = new URL(location.href).searchParams.get('embyMultiWindowId') || newId();
const mode = new URL(location.href).searchParams.get('embyMultiWindow');
const localWindows = new Map();
let workerUrl = null;
let entryActivated = false;

function getStored(key, fallback) { return GM_getValue(namespace + key, fallback); }
function setStored(key, value) { GM_setValue(namespace + key, value); }
function readSettings() { return getStored('settings', {}); }
function siteAllowed(url) {
    const defaults = ['http://localhost', 'https://localhost', 'http://127.0.0.1', 'https://127.0.0.1', 'http://192.168.8.10:8096'];
    return (readSettings().allowedSites || defaults).some(site => {
        try {
            const configured = new URL(site), page = new URL(url);
            return configured.protocol === page.protocol && (!configured.port || configured.port === page.port) &&
                (configured.hostname === page.hostname || configured.hostname.startsWith('*.') &&
                    (page.hostname === configured.hostname.slice(2) || page.hostname.endsWith(configured.hostname.slice(1))));
        } catch (_) { return false; }
    });
}

function popupUrl(kind, id) {
    const url = new URL(location.href);
    url.searchParams.set('embyMultiWindow', kind);
    url.searchParams.set('embyMultiWindowId', id);
    url.hash = '';
    return url.href;
}
function prepareWindow(newWindow, kind = 'player') {
    const active = getStored('activePlayer', null);
    const existing = active && getStored('window.' + active, null);
    const reusable = kind === 'player' && !newWindow && existing &&
        Date.now() - existing.seen < 15000;
    if (reusable) {
        const popup = localWindows.get(active);
        if (popup && !popup.closed) { popup.focus(); }
        else { setStored('focusSignal', {id: active, nonce: newId()}); }
        return active;
    }
    const id = reusable ? active : newId();
    const settings = readSettings();
    // Called synchronously by the click handler, before PlaybackInfo awaits.
    const popup = window.open(popupUrl(kind, id), 'emby-multiwindow-' + id,
        'popup=yes,width=' + (settings.windowWidth || 1100) + ',height=' + (settings.windowHeight || 720));
    if (!popup) { throw new Error('弹窗被拦截，请允许此 Emby 网站打开弹窗。'); }
    localWindows.set(id, popup);
    if (kind === 'player') { setStored('activePlayer', id); }
    popup.focus();
    return id;
}

function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        let request;
        const signal = options.signal;
        const abort = () => { if (request) { request.abort(); } reject(new DOMException('Aborted', 'AbortError')); };
        if (signal && signal.aborted) { abort(); return; }
        const cleanup = () => { if (signal) { signal.removeEventListener('abort', abort); } };
        request = GM_xmlhttpRequest({
            method: options.method || 'GET', url: String(url),
            headers: Object.fromEntries(new Headers(options.headers || {}).entries()),
            data: options.body, responseType: 'arraybuffer', anonymous: options.credentials === 'omit',
            timeout: 30000,
            onload(response) {
                cleanup();
                const body = response.response || new ArrayBuffer(0);
                const result = new Response(body.byteLength ? body : null, {status: response.status || 502});
                Object.defineProperty(result, 'url', {value: response.finalUrl || String(url)});
                resolve(result);
            },
            onerror() { cleanup(); reject(new TypeError('网络请求失败')); },
            ontimeout() { cleanup(); reject(new TypeError('网络请求超时')); },
            onabort() { cleanup(); reject(new DOMException('Aborted', 'AbortError')); }
        });
        if (signal) { signal.addEventListener('abort', abort, {once: true}); }
    });
}

function createGmLoaderClass() {
    return class GmLoader {
        constructor() {
            this.stats = {aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0,
                loading: {start: 0, first: 0, end: 0}, parsing: {start: 0, end: 0}, buffering: {start: 0, end: 0}};
        }
        load(context, config, callbacks) {
            this.context = context;
            this.callbacks = callbacks;
            this.controller = new AbortController();
            this.stats.loading.start = performance.now();
            const headers = {};
            if (context.rangeEnd > context.rangeStart) { headers.Range = 'bytes=' + context.rangeStart + '-' + (context.rangeEnd - 1); }
            gmFetch(context.url, {headers, signal: this.controller.signal, credentials: 'omit'})
                .then(async response => {
                    if (!response.ok) { throw {code: response.status, text: 'HTTP ' + response.status}; }
                    const data = context.responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
                    if (this.stats.aborted || !this.callbacks) { return; }
                    this.stats.loading.first = this.stats.loading.end = performance.now();
                    this.stats.loaded = this.stats.total = data.byteLength || data.length;
                    callbacks.onSuccess({url: response.url, data, code: response.status}, this.stats, context, null);
                }).catch(error => {
                    if (!this.stats.aborted && this.callbacks) {
                        callbacks.onError({code: error.code || 0, text: error.text || error.message}, context, null, this.stats);
                    }
                });
        }
        abort() {
            this.stats.aborted = true;
            if (this.controller) { this.controller.abort(); }
            if (this.callbacks && this.callbacks.onAbort) { this.callbacks.onAbort(this.stats, this.context, null); }
        }
        destroy() { this.abort(); this.callbacks = null; }
        getCacheAge() { return null; }
        getResponseHeader() { return null; }
    };
}

function storageArea(kind) {
    return {
        async get(defaults) {
            const values = kind === 'sync' ? readSettings() : getStored('queue.' + playerId, {});
            return defaults === null ? values : Object.assign({}, defaults, values);
        },
        async set(values) {
            if (kind !== 'sync') { throw new Error('会话队列只由窗口通信层写入'); }
            setStored('settings', Object.assign({}, readSettings(), values));
        },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                // Every queued request is a distinct GM key, avoiding read/modify/write races.
                GM_deleteValue(namespace + 'request.' + key);
            }
        }
    };
}
const chrome = {
    windows: {getCurrent: async () => ({id: playerId})},
    storage: {sync: storageArea('sync'), session: storageArea('session'),
        onChanged: {addListener: callback => listeners.push(callback)}},
    runtime: {
        getManifest: () => ({version: VERSION}),
        getURL(name) {
            if (name !== 'hls.worker.js') { throw new Error('未知内置资源'); }
            if (!workerUrl) { workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], {type: 'text/javascript'})); }
            return workerUrl;
        },
        onMessage: {addListener: callback => runtimeListeners.push(callback)},
        async sendMessage(message) {
            if (message.type === 'EMBY_MULTIWINDOW_NEW_PLAYER') {
                return {ok: true, windowId: prepareWindow(true)};
            }
            throw new Error('未知窗口消息');
        }
    }
};

// Queue snapshots are synthesized from independent keys for safe concurrent adds.
chrome.storage.session.get = async () => {
    const queue = {};
    for (const key of GM_listValues()) {
        if (!key.startsWith(namespace + 'request.')) { continue; }
        const envelope = GM_getValue(key);
        if (!envelope || Date.now() - envelope.created > 120000) {
            const stopUrl = envelope && envelope.payload && envelope.payload.endpoints && envelope.payload.endpoints.stopEncoding;
            if (stopUrl) { gmFetch(stopUrl, {method: 'POST'}).catch(() => {}); }
            GM_deleteValue(key); continue;
        }
        if (envelope.targetWindowId === playerId) { queue[key.slice((namespace + 'request.').length)] = envelope; }
    }
    return queue;
};
GM_addValueChangeListener(namespace + 'settings', (_, oldValue = {}, newValue = {}) => {
    const changes = {};
    for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
        if (JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key])) {
            changes[key] = {oldValue: oldValue[key], newValue: newValue[key]};
        }
    }
    listeners.forEach(callback => callback(changes, 'sync'));
    if (changes.allowedSites) { activateEntry(); }
});

function queuePayload(payload) {
    const id = payload.targetPlayerId || prepareWindow(!!payload.openInNewWindow);
    const key = 'embyMultiWindow.pending.' + payload.requestId;
    GM_setValue(namespace + 'request.' + key, {targetWindowId: id, payload, created: Date.now()});
    GM_setValue(namespace + 'queueSignal', {id, nonce: newId()});
}
GM_addValueChangeListener(namespace + 'queueSignal', (_, oldValue, signal) => {
    if (signal && signal.id === playerId) {
        runtimeListeners.forEach(callback => callback({type: 'EMBY_MULTIWINDOW_QUEUE_UPDATED', targetWindowId: playerId}));
    }
});

function announcePlayer() {
    for (const key of GM_listValues()) {
        if (key.startsWith(namespace + 'window.')) {
            const entry = GM_getValue(key);
            if (!entry || Date.now() - entry.seen > 60000) { GM_deleteValue(key); }
        }
    }
    setStored('window.' + playerId, {seen: Date.now(), origin: location.origin});
}
GM_addValueChangeListener(namespace + 'focusSignal', (_, oldValue, signal) => {
    if (mode === 'player' && signal && signal.id === playerId) { window.focus(); }
});

function showSettings() { prepareWindow(true, 'options'); }
GM_registerMenuCommand('Emby 多画面：设置', showSettings);
GM_registerMenuCommand('启用此 Emby 网站', () => {
    const settings = readSettings();
    setStored('settings', Object.assign({}, settings, {allowedSites: [...new Set([...(settings.allowedSites || []), location.origin])]}));
    location.reload();
});

function mountPage(html, css) {
    const parsed = new DOMParser().parseFromString(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<link\b[^>]*>/gi, ''), 'text/html');
    const element = document.importNode(parsed.documentElement, true);
    if (document.documentElement) { document.documentElement.replaceWith(element); }
    else { document.appendChild(element); }
    GM_addStyle(css);
}

function whenDocumentReady(callback) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, {once: true});
    } else { callback(); }
}

if (mode === 'player' || mode === 'options') {
    // Prevent the host application's deferred/module bootstrap from sharing the player DOM.
    const blocker = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
        if (node.nodeType !== 1) { return; }
        if (node.tagName === 'SCRIPT') { node.remove(); }
        else { node.querySelectorAll('script').forEach(script => script.remove()); }
    })));
    blocker.observe(document, {childList: true, subtree: true});
    whenDocumentReady(() => blocker.disconnect());
}

if (mode === 'player') { whenDocumentReady(() => {
    mountPage(PLAYER_HTML, PLAYER_CSS);
    announcePlayer();
    const heartbeat = setInterval(() => {
        announcePlayer();
        runtimeListeners.forEach(callback => callback({type: 'EMBY_MULTIWINDOW_QUEUE_UPDATED', targetWindowId: playerId}));
    }, 3000);
    window.addEventListener('focus', () => { setStored('activePlayer', playerId); announcePlayer(); });
    window.addEventListener('resize', () => {
        setStored('settings', Object.assign({}, readSettings(), {windowWidth: window.outerWidth, windowHeight: window.outerHeight}));
    });
    window.addEventListener('pagehide', () => {
        clearInterval(heartbeat);
        GM_deleteValue(namespace + 'window.' + playerId);
        if (workerUrl) { URL.revokeObjectURL(workerUrl); }
    });
    Hls.DefaultConfig.loader = createGmLoaderClass();
    runPlayer();
}); } else if (mode === 'options') { whenDocumentReady(() => {
    mountPage(OPTIONS_HTML, OPTIONS_CSS);
    runOptions();
}); } else { activateEntry(); }

function activateEntry() {
    if (mode === 'player' || mode === 'options' || !siteAllowed(location.href) || entryActivated) { return; }
    entryActivated = true;
    window.__embyMultiWindowPrepareWindow = newWindow => prepareWindow(newWindow);
    window.addEventListener('message', event => {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || !data ||
            data.source !== 'emby-multiwindow-page' || data.type !== 'ADD_VIDEO' || !data.payload) { return; }
        try {
            queuePayload(data.payload);
            window.postMessage({source: 'emby-multiwindow-extension', type: 'ADD_VIDEO_RESULT',
                requestId: data.payload.requestId, ok: true}, location.origin);
        } catch (error) {
            window.postMessage({source: 'emby-multiwindow-extension', type: 'ADD_VIDEO_RESULT',
                requestId: data.payload.requestId, ok: false, error: error.message}, location.origin);
        }
    });
    GM_addStyle(ENTRY_CSS);
    runEntry();
}

})();
