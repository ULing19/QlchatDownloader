'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QlchatLicense, normalizeOrder, PRODUCT_ID } = require('../src/core/license');

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qlchat-license-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function response(payload, ok = true, status = 200, url = 'https://license.uling19.com/v1/activate') {
  return { ok, status, url, json: async () => payload };
}

const testSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(`encrypted:${text}`),
  decryptString: value => {
    const text = value.toString();
    assert.ok(text.startsWith('encrypted:'));
    return text.slice('encrypted:'.length);
  },
};

async function readLicense(dir) {
  const encoded = await fs.readFile(path.join(dir, 'license.dat'));
  return JSON.parse(testSafeStorage.decryptString(Buffer.from(encoded.toString('utf8'), 'base64')));
}

test('normalizes the raw Xianyu order number without adding a redeem-code prefix', () => {
  assert.equal(normalizeOrder(' 123456789012 '), '123456789012');
  assert.equal(normalizeOrder('123456789012'), '123456789012');
  assert.equal(normalizeOrder('QLCHAT-123456789012'), '123456789012');
  assert.throws(() => normalizeOrder('short'), /格式/);
});

test('activation sends the same raw order and code with a separate product ID', async t => {
  const dir = await temp(t); let calls = 0;
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-a', safeStorage: testSafeStorage, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://license.uling19.com/v1/activate');
    const body = JSON.parse(options.body);
    assert.equal(body.order_id, '123456789012');
    assert.equal(body.code, '123456789012');
    assert.equal(body.product, PRODUCT_ID);
    assert.equal(options.redirect, 'error');
    return response({ authorized: true, expires_at: null });
  } });
  assert.equal((await license.activate('123456789012')).authorized, true);
  assert.equal((await license.authorize()).authorized, true);
  assert.equal(calls, 1);
  const saved = await readLicense(dir);
  assert.equal(saved.orderId, '123456789012');
  assert.equal(saved.code, saved.orderId);
});

test('loads the previous QLCHAT-prefixed credential and upgrades it to raw order = code', async t => {
  const dir = await temp(t);
  const previous = { orderId: 'QLCHAT-123456789012', code: 'QLCHAT-123456789012', lastOnlineAt: 1, expiresAt: null };
  await fs.writeFile(path.join(dir, 'license.dat'), testSafeStorage.encryptString(JSON.stringify(previous)).toString('base64'));
  let sent;
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-legacy', safeStorage: testSafeStorage, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return response({ authorized: true, expires_at: null }, true, 200, 'https://license.uling19.com/v1/check');
  } });
  assert.equal((await license.authorize()).authorized, true);
  assert.equal(sent.order_id, '123456789012');
  assert.equal(sent.code, sent.order_id);
  assert.equal(sent.product, 'qlchat');
  const upgraded = await readLicense(dir);
  assert.equal(upgraded.orderId, '123456789012');
});

test('rejects server activation without exposing raw response details', async t => {
  const license = new QlchatLicense({ storageDir: await temp(t), deviceId: 'install-b', safeStorage: testSafeStorage, fetchImpl: async () => response({ detail: '未找到此订单授权，请联系卖家' }, false, 403) });
  await assert.rejects(license.activate('123456789012'), /未找到此订单授权/);
});

test('uses short offline grace after a network interruption', async t => {
  const dir = await temp(t); let network = false;
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-c', safeStorage: testSafeStorage, fetchImpl: async () => {
    if (network) throw new Error('offline');
    return response({ authorized: true, expires_at: null });
  } });
  await license.activate('123456789012');
  const cached = await readLicense(dir);
  cached.lastOnlineAt -= 2 * 24 * 60 * 60;
  await fs.writeFile(path.join(dir, 'license.dat'), testSafeStorage.encryptString(JSON.stringify(cached)).toString('base64'));
  network = true;
  const state = await license.authorize();
  assert.equal(state.authorized, true);
  assert.equal(state.detail, '离线授权有效');
});

test('an explicit server rejection never falls back to offline grace', async t => {
  const dir = await temp(t); let reject = false;
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-reject', safeStorage: testSafeStorage, fetchImpl: async () => {
    if (reject) return response({ detail: '订单未授权' }, false, 403);
    return response({ authorized: true, expires_at: null });
  } });
  await license.activate('123456789012');
  await fs.writeFile(path.join(dir, 'license.dat'), testSafeStorage.encryptString(JSON.stringify({
    orderId: '123456789012', code: '123456789012', lastOnlineAt: Math.floor(Date.now() / 1000) + 86400, expiresAt: null,
  })).toString('base64'));
  reject = true;
  const state = await license.authorize();
  assert.equal(state.authorized, false);
  assert.match(state.detail, /订单未授权/);
});

test('refuses to cache an authorization if Windows safe storage is unavailable', async t => {
  const dir = await temp(t);
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-no-encryption', safeStorage: { isEncryptionAvailable: () => false }, fetchImpl: async () => response({ authorized: true, expires_at: null }) });
  await assert.rejects(license.activate('123456789012'), /安全存储不可用/);
  await assert.rejects(fs.access(path.join(dir, 'license.dat')));
});

test('does not trust a future local timestamp after the system clock moves backwards', async t => {
  const dir = await temp(t); let calls = 0;
  await fs.writeFile(path.join(dir, 'license.dat'), testSafeStorage.encryptString(JSON.stringify({
    orderId: '123456789012', code: '123456789012', lastOnlineAt: Math.floor(Date.now() / 1000) + 86400, expiresAt: null,
  })).toString('base64'));
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-clock', safeStorage: testSafeStorage, fetchImpl: async () => { calls++; return response({ detail: '订单撤销' }, false, 403); } });
  const state = await license.authorize();
  assert.equal(calls, 1);
  assert.equal(state.authorized, false);
});

test('refuses a cross-origin redirect response for authorization data', async t => {
  const license = new QlchatLicense({ storageDir: await temp(t), deviceId: 'install-redirect', safeStorage: testSafeStorage, fetchImpl: async () => response({ authorized: true }, true, 200, 'https://evil.example/collect') });
  await assert.rejects(license.activate('123456789012'), /不安全的跳转/);
});

test('clearing authorization removes the local credential', async t => {
  const dir = await temp(t);
  const license = new QlchatLicense({ storageDir: dir, deviceId: 'install-d', safeStorage: testSafeStorage, fetchImpl: async () => response({ authorized: true, expires_at: null }) });
  await license.activate('123456789012');
  await license.clear();
  assert.equal((await license.authorize()).authorized, false);
});
