'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { LoginSessionStore } = require('../src/core/login-session');

async function fixture(t, cookies = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qlchat-login-session-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  const now = 1793095000000;
  const restored = [];
  const session = { cookies: { get: async () => cookies, set: async cookie => restored.push(cookie), flushStore: async () => {} } };
  return { dir, now, safeStorage, session, restored, file: path.join(dir, 'auth-session.dat') };
}

const authCookie = { name: 'userId', value: 'DUMMY_COOKIE_NEVER_LOG', domain: '.qlchat.com', path: '/', session: true, secure: true, httpOnly: false };

test('restores session-only authentication after a new process without storing plaintext', async t => {
  const f = await fixture(t, [authCookie, { ...authCookie, name: 'Hm_tracking' }]);
  assert.equal(await new LoginSessionStore({ storageDir: f.dir, safeStorage: f.safeStorage, session: f.session, now: () => f.now }).save(), true);
  const encrypted = await fs.readFile(f.file);
  assert.equal(encrypted.includes(Buffer.from(authCookie.value)), false);
  assert.equal(encrypted.includes(Buffer.from('cookies')), false);
  const reader = new LoginSessionStore({ storageDir: f.dir, safeStorage: f.safeStorage, session: f.session, now: () => f.now + 1000 });
  assert.equal(await reader.restore(), 1);
  assert.equal(f.restored[0].name, 'userId');
  assert.equal(f.restored[0].value, authCookie.value);
  assert.equal('expirationDate' in f.restored[0], false);
});

test('preserves the server cookie expiry and excludes expired authentication cookies', async t => {
  const now = 1793095000000;
  const f = await fixture(t, [
    { ...authCookie, name: 'QLZB_SESSIONID', expirationDate: now / 1000 + 1800 },
    { ...authCookie, name: 'rsessionid', expirationDate: now / 1000 - 1 },
  ]);
  const store = new LoginSessionStore({ storageDir: f.dir, safeStorage: f.safeStorage, session: f.session, now: () => now });
  await store.save();
  assert.equal(await store.restore(), 1);
  assert.equal(f.restored[0].expirationDate, now / 1000 + 1800);
});

test('rejects expired caches and future timestamps', async t => {
  const f = await fixture(t, [authCookie]);
  const options = { storageDir: f.dir, safeStorage: f.safeStorage, session: f.session };
  await new LoginSessionStore({ ...options, now: () => f.now }).save();
  assert.equal(await new LoginSessionStore({ ...options, now: () => f.now + 8 * 86400000 }).restore(), 0);
  assert.equal(await new LoginSessionStore({ ...options, now: () => f.now - 3600000 }).restore(), 0);
  assert.equal(f.restored.length, 0);
});

test('does not restore cookies outside QLChat or analytics stored in a damaged snapshot', async t => {
  const f = await fixture(t);
  const cookies = [
    { ...authCookie, domain: 'qlchat.com.evil.test' },
    { ...authCookie, domain: 'evilqlchat.com' },
    { ...authCookie, name: 'tracking' },
  ];
  await fs.writeFile(f.file, f.safeStorage.encryptString(JSON.stringify({ version: 1, savedAt: f.now, cookies })));
  const store = new LoginSessionStore({ storageDir: f.dir, safeStorage: f.safeStorage, session: f.session, now: () => f.now });
  assert.equal(await store.restore(), 0);
  assert.equal(f.restored.length, 0);
});

test('keeps sessions memory-only if operating system encryption is unavailable', async t => {
  const f = await fixture(t, [authCookie]);
  const safeStorage = { isEncryptionAvailable: () => false };
  const store = new LoginSessionStore({ storageDir: f.dir, safeStorage, session: f.session });
  assert.equal(await store.save(), false);
  assert.equal(await store.restore(), 0);
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
});

test('corrupt or foreign encrypted cache cannot restore an authenticated session', async t => {
  const f = await fixture(t, [authCookie]);
  await fs.writeFile(f.file, Buffer.from('corrupt encrypted data'));
  const store = new LoginSessionStore({ storageDir: f.dir, safeStorage: f.safeStorage, session: f.session });
  assert.equal(await store.restore(), 0);
  assert.equal(f.restored.length, 0);
});
