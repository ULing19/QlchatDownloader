'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./storage');

const AUTH_NAMES = new Set(['userId', 'rsessionid', 'QLZB_SESSIONID', 'uid', 'isCheckJsession']);
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieDetails(cookie, now) {
  if (!cookie || !AUTH_NAMES.has(cookie.name) || typeof cookie.value !== 'string' || cookie.value.length > 65536) return null;
  const domain = String(cookie.domain || '').toLowerCase();
  const host = domain.replace(/^\./, '');
  if (host !== 'qlchat.com' && !host.endsWith('.qlchat.com')) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') && !/[\r\n]/.test(cookie.path) ? cookie.path : '/';
  const details = { url: `https://${host}${cookiePath}`, name: cookie.name, value: cookie.value, path: cookiePath,
    secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly) };
  if (!cookie.hostOnly) details.domain = domain;
  if (['lax', 'strict', 'no_restriction'].includes(cookie.sameSite)) details.sameSite = cookie.sameSite;
  if (cookie.expirationDate != null) {
    if (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= now / 1000) return null;
    details.expirationDate = cookie.expirationDate;
  }
  return details;
}

class LoginSessionStore {
  constructor({ storageDir, safeStorage, session, now = Date.now }) {
    this.file = path.join(storageDir, 'auth-session.dat');
    this.safeStorage = safeStorage;
    this.session = session;
    this.now = now;
  }

  async save() {
    if (!this.safeStorage?.isEncryptionAvailable()) return false;
    try {
      const now = this.now();
      const cookies = (await this.session.cookies.get({})).filter(cookie => cookieDetails(cookie, now));
      const saved = { version: 1, savedAt: now, cookies };
      const encrypted = this.safeStorage.encryptString(JSON.stringify(saved));
      await atomicWriteFile(this.file, encrypted);
      await this.session.cookies.flushStore?.();
      return true;
    } catch {
      throw new Error('本机登录状态保存失败，下次打开时可能需要重新登录。');
    }
  }

  async restore() {
    if (!this.safeStorage?.isEncryptionAvailable()) return 0;
    try {
      const encrypted = await fs.readFile(this.file);
      const saved = JSON.parse(this.safeStorage.decryptString(encrypted));
      const now = this.now();
      if (saved.version !== 1 || !Number.isFinite(saved.savedAt) || saved.savedAt > now + 300000 || now - saved.savedAt > MAX_AGE_MS || !Array.isArray(saved.cookies)) return 0;
      let restored = 0;
      for (const cookie of saved.cookies.slice(0, 32)) {
        const details = cookieDetails(cookie, now);
        if (!details) continue;
        await this.session.cookies.set(details);
        restored++;
      }
      await this.session.cookies.flushStore?.();
      return restored;
    } catch {
      return 0;
    }
  }
}

module.exports = { LoginSessionStore };
