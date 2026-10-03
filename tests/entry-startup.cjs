'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.join(__dirname, '..');
const scriptPath = process.env.EMBY_TEST_USERSCRIPT || path.join(root, 'dist', 'EmbyMultiWindow.user.js');
const script = fs.readFileSync(scriptPath, 'utf8');
const requiredCode = script.includes('// @require') ? fs.readFileSync(path.join(root, 'hls.js'), 'utf8') : '';
const resourceCode = `window.GM_getResourceText = () => ${JSON.stringify(fs.readFileSync(path.join(root, 'hls.worker.js'), 'utf8'))};\n`;
const origin = 'http://192.168.8.10:8096';
const gmMock = `
window.unsafeWindow = window;
window.bootCrypto = {secure: isSecureContext, uuid: typeof crypto.randomUUID};
const gmValues = new Map(), gmWatchers = new Map();
window.GM_getValue = (key, fallback) => gmValues.has(key) ? gmValues.get(key) : fallback;
window.GM_setValue = (key, value) => {
  const old = gmValues.get(key); gmValues.set(key, value);
  (gmWatchers.get(key) || []).forEach(callback => callback(key, old, value, true));
};
window.GM_deleteValue = key => gmValues.delete(key);
window.GM_listValues = () => [...gmValues.keys()];
window.GM_addValueChangeListener = (key, callback) => gmWatchers.set(key, [...(gmWatchers.get(key) || []), callback]);
window.GM_registerMenuCommand = () => {};
window.GM_addStyle = css => {
  const style = document.createElement('style'); style.textContent = css;
  if (document.documentElement) document.documentElement.appendChild(style);
  else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style), {once:true});
};
window.GM_xmlhttpRequest = () => {throw new Error('Unexpected GM network request');};
`;
const html = `<!doctype html><html><body>
<div class="itemView"><div class="mainDetailButtons"></div></div>
<script>
window.itemReads = [];
document.querySelector('.itemView').dispatchEvent(new CustomEvent('itemshow', {
  bubbles: true, detail: {item: {Id:'movie-1', Type:'Movie', MediaType:'Video'}}
}));
setTimeout(() => {
  window.Emby = {importModule: async () => ({})};
  window.ApiClient = {
    getPlaybackInfo() {}, getCurrentUserId: () => 'test-user',
    getItem: async (user, id) => {
      window.itemReads.push(id);
      if (id === 'slow') await new Promise(resolve => setTimeout(resolve, 500));
      return {Id:id, Type:'Movie', MediaType:'Video', Name:id};
    }
  };
}, 50);
</script></body></html>`;
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.EMBY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({content: gmMock + '\n' + resourceCode + requiredCode + '\n' + script});
    await page.route(origin + '/**', route => route.fulfill({contentType:'text/html', body:html}));
    await page.goto(origin + '/web/index.html#!/item?id=movie-1');
    const boot = await page.evaluate(() => window.bootCrypto);
    assert.deepEqual(boot, {secure:false, uuid:'undefined'});
    await page.locator('.emby-multiwindow-detail-button').waitFor({state:'visible'});
    assert.equal(await page.locator('.emby-multiwindow-detail-button').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('.emby-multiwindow-detail-button').embyMultiWindowItem.Id), 'movie-1');
    assert.deepEqual(await page.evaluate(() => window.itemReads), ['movie-1']);
    await page.evaluate(() => {location.hash = '!/item?id=slow';});
    await page.waitForFunction(() => window.itemReads.includes('slow'));
    await page.evaluate(() => {location.hash = '!/item?id=movie-2';});
    await page.waitForFunction(() => document.querySelector('.emby-multiwindow-detail-button')?.embyMultiWindowItem.Id === 'movie-2');
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.querySelector('.emby-multiwindow-detail-button').embyMultiWindowItem.Id), 'movie-2');
    await page.evaluate(() => {
      document.querySelector('.emby-multiwindow-detail-button').remove();
      document.querySelector('.itemView').classList.add('restored');
    });
    await page.locator('.emby-multiwindow-detail-button').waitFor({state:'visible'});
    assert.equal(await page.locator('.emby-multiwindow-detail-button').count(), 1);
    assert.deepEqual(errors, []);
    console.log('HTTP LAN startup, missed itemshow, route races and restored details: OK');
    const player = await browser.newPage();
    await player.addInitScript({content: gmMock + '\n' + resourceCode + requiredCode + '\n' + script});
    await player.route(origin + '/**', route => route.fulfill({contentType:'text/html', body:html}));
    await player.goto(origin + '/web/index.html?embyMultiWindow=player');
    await player.locator('#fullscreen').waitFor({state:'visible'});
    // Use a video surface to exercise a real double-click activation without media/session requests.
    await player.evaluate(() => {
      document.querySelector('#empty').hidden = true;
      const video = document.createElement('video');
      video.style.cssText = 'width:100%;height:100%';
      document.querySelector('#grid').appendChild(video);
    });
    await player.locator('video').dblclick();
    await player.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    await player.waitForFunction(() => document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'true');
    await player.keyboard.press('f');
    await player.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await player.locator('.tile .title').count(), 0);
    console.log('Bundled HTTP LAN userscript player, double-click fullscreen and F exit: OK');
    if (process.env.EMBY_TEST_LIVE_URL) {
      const live = await browser.newPage();
      const liveErrors = [];
      live.on('pageerror', error => liveErrors.push(error.message));
      await live.addInitScript({content: gmMock + '\n' + resourceCode + requiredCode + '\n' + script});
      await live.goto(process.env.EMBY_TEST_LIVE_URL);
      await live.waitForFunction(() => !!document.querySelector('#emby-multiwindow-launcher'));
      assert.ok(!liveErrors.some(error => /randomUUID|before initialization/.test(error)), liveErrors.join('\n'));
      console.log('Actual Emby page: ' + JSON.stringify(await live.evaluate(() => ({
        version: document.documentElement.dataset.appversion, boot:window.bootCrypto,
        entryStarted:!!window.__embyMultiWindowLoaded, launcherCreated:!!document.querySelector('#emby-multiwindow-launcher')
      }))));
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
