'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QlchatLicense, normalizeOrder, PRODUCT_PREFIX } = require('../src/core/license');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qlchat-license-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function response(payload, ok = true, status = 200) { return { ok, status, json: async () => payload }; }

test('normalizes order numbers to a product-specific prefix', () => {
  assert.equal(normalizeOrder(' 123456789012 '), `${PRODUCT_PREFIX}123456789012`);
  assert.equal(normalizeOrder('qlchat-123456789012'), `${PRODUCT_PREFIX}123456789012`);
  assert.throws(() => normalizeOrder('short'), /格式/);
});

test('activates, stores locally, and reuses a valid lease without another request', async t => {
  const dir = await temp(t); let calls = 0;
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-a', fetchImpl: async (_url, options) => { calls++; const body = JSON.parse(options.body); assert.equal(body.order_id, 'QLCHAT-123456789012'); assert.equal(body.code, body.order_id); return response({ authorized: true, expires_at: null }); } });
  assert.equal((await license.activate('123456789012')).authorized, true);
  assert.equal((await license.authorize()).authorized, true);
  assert.equal(calls, 1);
});

test('rejects server activation without exposing raw response details', async t => {
  const license = new QlchatLicense({ storageDir: await temp(t), deviceId: 'install-b', fetchImpl: async () => response({ detail: '未找到此订单授权，请联系卖家' }, false, 403) });
  await assert.rejects(license.activate('123456789012'), /未找到此订单授权/);
});

test('uses short offline grace after a network interruption', async t => {
  const dir = await temp(t); let network = false;
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-c', fetchImpl: async () => { if (network) throw new Error('offline'); return response({ authorized: true, expires_at: null }); } });
  await license.activate('123456789012');
  network = true;
  const state = await license.authorize();
  assert.equal(state.authorized, true);
  assert.match(state.detail, /授权有效|离线授权有效/);
});

test('clearing authorization removes the local credential', async t => {
  const dir = await temp(t);
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-d', fetchImpl: async () => response({ authorized: true, expires_at: null }) });
  await license.activate('123456789012');
  await license.clear();
  assert.equal((await license.authorize()).authorized, false);
});
