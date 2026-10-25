'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { courseUrl, parseInitialState, findCourseMetadata, buildTasks, decodePlayUrl, QlchatClient, QlchatError } = require('../src/core/qlchat');

test('accept only official course links and canonicalize tracking parameters', () => {
  assert.equal(courseUrl('分享课程 https://h5.qlchat.com/wechat/page/topic-simple-video?topicId=2000000001&byhand=1'), 'https://h5.qlchat.com/wechat/page/topic-simple-video?topicId=2000000001');
  assert.equal(courseUrl('https://h5.qlchat.com/wechat/page/channel-intro?channelId=2000000002'), 'https://h5.qlchat.com/wechat/page/channel-intro?channelId=2000000002');
  for (const input of ['file:///C:/x', 'https://qlchat.com.evil.example/?topicId=2000000001', 'https://other.example/?topicId=2000000001', 'https://user:pass@h5.qlchat.com/?topicId=2000000001', 'https://h5.qlchat.com/?topicId=oops']) assert.throws(() => courseUrl(input));
});

test('parse embedded JSON without executing page JavaScript or breaking on braces in strings', () => {
  const payload = { video: { topicInfo: { topic: '函数 {x} \\" }' }, isLogin: true } };
  assert.deepEqual(parseInitialState(`<script>window.__INIT_STATE__ = ${JSON.stringify(payload)}; throw Error('never run');</script>`), payload);
  assert.equal(parseInitialState('window.__INIT_STATE__ = (() => 2)();'), null);
  assert.equal(parseInitialState('window.__INIT_STATE__ = {bad};'), null);
});

test('read video or channel metadata without interpreting account fields as courses', () => {
  const state = { video: { isLogin: true, topicInfo: { id: '10101', topic: '单课', channelId: '20202', liveId: '30303', channelName: '高等数学' } }, userInfo: { id: '77777', liveId: '88888', name: 'account' } };
  assert.equal(findCourseMetadata(state).title, '高等数学');
  assert.equal(findCourseMetadata({ channelIntro: { channelInfo: { id: '20202', liveId: '30303', name: '专栏' } } }).channelId, '20202');
});

test('assemble chapters across pages, ignore nonvideo materials and duplicate IDs', () => {
  const chapter = { businessType: 'chapter', businessId: '50000', businessName: '第一章 函数' };
  const row = { businessType: 'topic', businessId: '60000', businessName: '1.1 函数', chapterId: '50000', topicPo: { style: 'videoGraphic', duration: '2566.0' } };
  const tasks = buildTasks([row, { businessType: 'file', businessId: '70000' }, chapter, row, { ...row, businessId: '80000', topicPo: { style: 'audio' } }]);
  assert.deepEqual(tasks, [{ id: '60000', title: '1.1 函数', chapter: '第一章 函数', index: 1, duration: 2566 }]);
});

test('decode official URL envelope while rejecting unsupported protocols and formats', () => {
  const url = 'https://1378190640.vod-qcloud.com/test/video.m3u8?t=one-use';
  const encoder = crypto.createCipheriv('aes-256-cbc', Buffer.from('711AAB17E204816B783374025FD08DE8'), Buffer.from('0102030405060708'));
  const encrypted = Buffer.concat([encoder.update(url), encoder.final()]).toString('base64');
  assert.equal(decodePlayUrl(encrypted), url);
  for (const invalid of ['https://bad.example/file.m3u8', 'https://vod-qcloud.com/file.mpd', 'javascript:alert(1)', 'garbage']) assert.throws(() => decodePlayUrl(invalid));
});

function response(body, url = 'https://h5.qlchat.com/api/example') {
  return { ok: true, status: 200, url, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}
const state = { video: { isLogin: true, topicInfo: { id: '10000', topic: '第一节', channelId: '20000', liveId: '30000', channelName: '测试课程' } } };
const success = data => ({ state: { code: 0 }, data });

test('read entire multi-page course including a chapter that spans pagination', async () => {
  const calls = [];
  const client = new QlchatClient({ fetchImpl: async (url, options) => {
    if (!url.includes('/api/')) return response(`window.__INIT_STATE__ = ${JSON.stringify(state)};`, url);
    const body = JSON.parse(options.body); calls.push(body);
    const page = body.page.page;
    const rows = page === 1 ? [{ businessType: 'chapter', businessId: '90000', businessName: '第一章' }] : [];
    for (let i = 0; i < (page === 1 ? 19 : 3); i++) rows.push({ businessType: 'topic', businessId: String(10000 + (page - 1) * 19 + i), businessName: `第${i + 1}节`, chapterId: '90000', topicPo: { style: 'videoGraphic' } });
    return response(success({ dataList: rows, count: 22 }));
  } });
  const result = await client.getCourse('https://h5.qlchat.com/?topicId=10000');
  assert.equal(result.tasks.length, 22); assert.equal(calls.length, 2);
  assert.equal(result.tasks.at(-1).chapter, '第一章'); assert.equal(result.title, '测试课程');
  assert.deepEqual(calls[0].page, { page: 1, size: 20 });
});

test('repeated full page fails rather than silently returning an incomplete catalog', async () => {
  let pages = 0;
  const rows = Array.from({ length: 20 }, (_, i) => ({ businessType: 'topic', businessId: String(10000 + i), businessName: '视频' }));
  const client = new QlchatClient({ fetchImpl: async (url) => {
    if (!url.includes('/api/')) return response(`window.__INIT_STATE__ = ${JSON.stringify(state)};`, url);
    pages++; return response(success({ dataList: rows }));
  } });
  await assert.rejects(client.getCourse('https://h5.qlchat.com/?topicId=10000'), /分页异常.*未读取完整/);
  assert.equal(pages, 2);
});

test('unauthenticated course fails before listing private catalog', async () => {
  const client = new QlchatClient({ fetchImpl: async url => response(`window.__INIT_STATE__ = ${JSON.stringify({ video: { ...state.video, isLogin: false } })};`, url) });
  await assert.rejects(client.getCourse('https://h5.qlchat.com/?topicId=10000'), /登录/);
});

test('refresh media per request and choose the highest available resolution', async () => {
  let count = 0;
  const client = new QlchatClient({ fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { topicId: '10000' }); count++;
    return response(success({ video: [ { playUrl: 'https://x.vod-qcloud.com/a.mp4', resolution: '360', duration: 10 }, { playUrl: `https://x.vod-qcloud.com/b.m3u8?refresh=${count}`, resolution: '720', duration: 12 } ] }));
  } });
  assert.equal((await client.resolveMedia({ id: '10000' })).height, NaN);
  assert.match((await client.resolveMedia({ id: '10000' })).url, /refresh=2/);
});

test('API failure messages do not expose server diagnostics or signed URLs', async () => {
  const client = new QlchatClient({ fetchImpl: async () => response({ state: { code: 401, msg: 'https://secret.example/?token=SECRET' } }) });
  await assert.rejects(client.resolveMedia({ id: '10000' }), error => !error.message.includes('SECRET') && /权限/.test(error.message));
});

test('client creates identifiable safe errors while sanitizing unrelated network exceptions', async () => {
  assert.throws(() => courseUrl('invalid'), error => error instanceof QlchatError && error.code === 'QLCHAT_CLIENT' && error.name === 'QlchatError');
  assert.throws(() => decodePlayUrl('invalid-envelope'), error => error instanceof QlchatError && error.code === 'QLCHAT_CLIENT');
  const client = new QlchatClient({ fetchImpl: async () => { throw new Error('千聊 HTTP failure https://private.example/?token=SECRET'); } });
  await assert.rejects(client.resolveMedia({ id: '10000' }), error => error instanceof QlchatError && error.code === 'QLCHAT_CLIENT' && !error.message.includes('SECRET'));
});

test('request deadline includes a response body stalled after successful headers', async () => {
  let requestSignal;
  const client = new QlchatClient({ requestTimeoutMs: 20, fetchImpl: async (_url, options) => {
    requestSignal = options.signal;
    return { ok: true, status: 200, url: 'https://h5.qlchat.com/api/example', text: () => new Promise(() => {}) };
  } });
  await assert.rejects(client.resolveMedia({ id: '10000' }), /超时/);
  assert.equal(requestSignal.aborted, true);
});

test('media cancellation reaches the fetch body and rejects promptly without leaking abort reasons', async () => {
  const controller = new AbortController();
  let bodyStarted;
  const body = new Promise(resolve => { bodyStarted = resolve; });
  let requestSignal;
  const client = new QlchatClient({ fetchImpl: async (_url, options) => {
    requestSignal = options.signal;
    return { ok: true, status: 200, text: () => { bodyStarted(); return new Promise(() => {}); } };
  } });
  const pending = client.resolveMedia({ id: '10000' }, { signal: controller.signal });
  await body;
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await assert.rejects(pending, error => error.code === 'QLCHAT_CLIENT' && error.reasonCode === 'CANCELLED' && !error.message.includes('PRIVATE'));
  assert.equal(requestSignal.aborted, true);
});

test('already-cancelled request never starts a fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  const client = new QlchatClient({ fetchImpl: async () => { fetched = true; return response(success({})); } });
  await assert.rejects(client.resolveMedia({ id: '10000' }, { signal: controller.signal }), error => error.code === 'QLCHAT_CLIENT' && error.reasonCode === 'CANCELLED');
  assert.equal(fetched, false);
});

test('desktop blocks unlicensed downloads and waits for cleanup before closing', async () => {
  const vm = require('node:vm');
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const handles = new Map();
  const app = new EventEmitter();
  const outputDir = path.join(require('node:os').tmpdir(), 'qlchat-exit-check', '千聊课程');
  let main, engine, license, finishCleanup, quitCount = 0;
  const preventable = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  Object.assign(app, { setName() {}, setPath() {}, getPath: () => path.dirname(outputDir), getVersion: () => 'test',
    commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    quit() { const event = preventable(); app.emit('before-quit', event); if (!event.defaultPrevented) quitCount++; } });
  class Window extends EventEmitter {
    constructor() { super(); main = this; this.destroyed = false; this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, send() {} }); }
    isDestroyed() { return this.destroyed; }
    async loadFile() {}
    close() { const event = preventable(); this.emit('close', event); if (!event.defaultPrevented) { this.destroyed = true; this.emit('closed'); } }
  }
  class Manager extends EventEmitter {
    constructor(options) { super(); engine = this; this.options = options; this.busy = false; this.cancelled = false; }
    start() { this.busy = true; return new Promise(resolve => { finishCleanup = () => { this.busy = false; resolve({ completed: 0, failed: 0, cancelled: 1 }); }; }); }
    cancel() { this.cancelled = true; }
  }
  class Client {
    async getCourse() { return { title: '测试', tasks: [{ id: '10000', title: '第一节' }] }; }
    async resolveMedia(task, options) { return { task, options }; }
  }
  class License {
    constructor() { license = this; this.state = { authorized: false, detail: '尚未激活' }; }
    async authorize() { return this.state; }
    async activate() { return this.state; }
    async clear() { return { authorized: false, detail: '尚未激活' }; }
  }
  const electron = { app, BrowserWindow: Window, safeStorage: { isEncryptionAvailable: () => false }, dialog: { showMessageBoxSync: () => 1 },
    ipcMain: { handle: (name, callback) => handles.set(name, callback) }, session: { fromPartition: () => ({ setUserAgent() {}, fetch() {} }) }, shell: {} };
  const sandbox = { __dirname: path.resolve(__dirname, '../src'), process, AbortSignal,
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs/promises') return { readFile: async () => { throw new Error('first launch'); } };
      if (name === './core/download') return { DownloadManager: Manager };
      if (name === './core/qlchat') return { QlchatClient: Client, courseUrl: input => input, ORIGIN: 'https://h5.qlchat.com', USER_AGENT: 'test' };
      if (name === './core/license') return { QlchatLicense: License };
      return require(name);
    },
  };
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../src/main.js'), 'utf8'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  const sender = { sender: main.webContents, senderFrame: { url: 'file:///app/index.html' } };
  const denied = await handles.get('qlchat:start-download')(sender, { tasks: [{ id: '10000' }], outputDir });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /激活/);
  assert.equal(engine.busy, false);
  license.state = { authorized: true, detail: '授权有效' };
  await handles.get('qlchat:parse-course')(sender, { url: 'https://h5.qlchat.com/?topicId=10000' });
  await handles.get('qlchat:start-download')(sender, { tasks: [{ id: '10000' }], outputDir });
  const forwarded = new AbortController();
  assert.equal((await engine.options.resolveMedia({ id: '10000' }, { signal: forwarded.signal })).options.signal, forwarded.signal);
  main.close();
  assert.equal(engine.cancelled, true);
  assert.equal(main.destroyed, false);
  assert.equal(quitCount, 0);
  finishCleanup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(main.destroyed, true);
  assert.equal(quitCount, 1);
});
