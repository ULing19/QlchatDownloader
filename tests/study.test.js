'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { QlchatClient, QlchatError, STUDY_URL } = require('../src/core/qlchat');

const ok = data => ({ state: { code: 0 }, data });
const row = (id, extra = {}) => ({ bussinessId: String(id), type: 'channel', title: `课程 ${id}`, ...extra });
const recent = (id, joinTime, extra = {}) => ({ topicId: String(id), courseType: 'topic', skuTitle: `最近 ${id}`, joinTime, ...extra });

function studyClient(handler) {
  const calls = [];
  const client = new QlchatClient({ fetchImpl: async (url, options = {}) => {
    if (!url.includes('/api/')) return { ok: true, status: 200, url, text: async () => 'window.__INIT_STATE__ = {"video":{"isLogin":true}};' };
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    const payload = handler(url, body, calls.length);
    return { ok: true, status: 200, url, text: async () => JSON.stringify(payload) };
  } });
  return { client, calls };
}

test('purchased pagination follows full page size and deduplicates across pages', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(2000000000000000 + i));
  const { client, calls } = studyClient((_url, body) => ok({
    list: body.page.page === 1 ? rows : [rows[9], row(2000000000000010)],
    nextPage: false,
  }));
  const result = await client.getPurchasedCourses();
  assert.equal(result.length, 11);
  assert.deepEqual(calls.map(c => c.body.page.page), [1, 2]);
  assert.deepEqual(calls[0].body.page, { page: 1, size: 10 });
});

test('purchased pagination follows full page length even when nextPage is false', async () => {
  const { client, calls } = studyClient((_url, body) => ok({
    list: body.page.page === 1
      ? Array.from({ length: 10 }, (_, i) => row(2000000000000100 + i))
      : [row(2000000000000110)],
    nextPage: false,
  }));
  const result = await client.getPurchasedCourses();
  assert.equal(result.length, 11);
  assert.equal(calls.length, 2);
});

test('purchased pagination honors nextPage true even when a page is short', async () => {
  const { client, calls } = studyClient((_url, body) => ok({
    list: [row(2000000000000120 + body.page.page)], nextPage: true,
  }));
  await assert.rejects(client.getPurchasedCourses(), /分页过多/);
  assert.equal(calls.length, 200);
});

test('recent pagination allows distinct courses sharing the same joinTime', async () => {
  const { client, calls } = studyClient((_url, body) => ok(body.page.page === 1
    ? { learningList: [recent(2000000000000201, 1770000000)], nextPage: true }
    : { learningList: [recent(2000000000000202, 1770000000)], nextPage: false }));
  const result = await client.getRecentCourses();
  assert.deepEqual(result.map(course => course.id), ['2000000000000201', '2000000000000202']);
  assert.deepEqual(calls.map(c => c.body.page.page), [1, 2]);
  assert.deepEqual(calls.map(c => c.body.time), [0, 1770000000]);
});

test('study list merges purchased and recent matches and retains unsupported purchases', async () => {
  const { client } = studyClient((url) => url.includes('purchaseCourse')
    ? ok({ list: [row(2000000000000301, { type: 'topic' }), row(2000000000000302, { type: 'camp', purchaseType: 'camp' })], nextPage: false })
    : ok({ learningList: [recent(2000000000000301, 1770000001), recent(2000000000000303, 1770000002)], nextPage: false }));
  const result = await client.getStudyCourses(STUDY_URL);
  assert.deepEqual(result.courses.map(c => [c.id, c.source]), [
    ['2000000000000301', 'both'], ['2000000000000302', 'purchased'], ['2000000000000303', 'recent'],
  ]);
  assert.deepEqual(result.courses[0].sources, ['purchased', 'recent']);
  assert.equal(result.courses[1].supported, false);
  assert.equal(result.unsupportedCount, 1);
});

test('empty lists are valid and stop pagination', async () => {
  const { client, calls } = studyClient(url => url.includes('purchaseCourse')
    ? ok({ list: [], nextPage: false }) : ok({ learningList: [], nextPage: false }));
  assert.deepEqual(await client.getStudyCourses(), { courses: [], complete: true, unsupportedCount: 0 });
  assert.equal(calls.length, 2);
});

test('login, permission and malformed responses fail without exposing server details', async () => {
  const login = new QlchatClient({ fetchImpl: async url => ({ ok: true, status: 200, url, text: async () => '<div class="login-page"></div>' }) });
  await assert.rejects(login.getStudyCourses(), error => error.reasonCode === 'LOGIN_REQUIRED');

  const denied = studyClient(() => ({ state: { code: 403, msg: 'SECRET_COOKIE_VALUE' }, data: null }));
  await assert.rejects(denied.client.getPurchasedCourses(), error => !error.message.includes('SECRET_COOKIE_VALUE') && /权限/.test(error.message));

  const malformed = studyClient(() => ok({ list: { private: true } }));
  await assert.rejects(malformed.client.getPurchasedCourses(), /返回格式发生变化/);
});

test('repeated pages, network failure and invalid cursor cannot claim a complete sync', async () => {
  const repeatedRows = Array.from({ length: 10 }, (_, i) => row(2000000000000400 + i));
  const repeated = studyClient((_url, _body, call) => ok({ list: repeatedRows, nextPage: true }));
  await assert.rejects(repeated.client.getPurchasedCourses(), /分页异常/);

  const failed = studyClient((url, _body, call) => {
    if (url.includes('purchaseCourse')) return ok({ list: [row(2000000000000501)], nextPage: false });
    throw new Error('SECRET_NETWORK_DIAGNOSTIC');
  });
  await assert.rejects(failed.client.getStudyCourses(), error => !error.message.includes('SECRET_NETWORK_DIAGNOSTIC'));

  const badCursor = studyClient(() => ok({ learningList: [recent(2000000000000601, 0)], nextPage: true }));
  await assert.rejects(badCursor.client.getRecentCourses(), /分页异常/);
});

test('cancellation is forwarded to study API fetches', async () => {
  const controller = new AbortController();
  let signal;
  const client = new QlchatClient({ fetchImpl: async (url, options = {}) => {
    signal = options.signal;
    if (!url.includes('/api/')) return { ok: true, status: 200, url, text: async () => 'window.__INIT_STATE__ = {};' };
    controller.abort();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(client.getPurchasedCourses({ signal: controller.signal }), error => error instanceof QlchatError && error.reasonCode === 'CANCELLED');
  assert.equal(signal.aborted, true);
});
