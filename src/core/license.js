'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const LICENSE_API = 'https://license.uling19.com';
const PRODUCT_PREFIX = 'QLCHAT-';
const PRODUCT_ID = 'qlchat';
const RECHECK_SECONDS = 24 * 60 * 60;
const OFFLINE_GRACE_SECONDS = 30 * 24 * 60 * 60;

class QlchatLicenseError extends Error {
  constructor(message, kind = 'rejected') {
    super(message);
    this.name = 'QlchatLicenseError';
    this.kind = kind;
  }
}

function normalizeOrder(value) {
  let order = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (order.startsWith(PRODUCT_PREFIX)) order = order.slice(PRODUCT_PREFIX.length);
  if (!/^[A-Z0-9-]{6,56}$/.test(order)) {
    throw new QlchatLicenseError('订单号格式不正确，请输入完整订单号。');
  }
  return PRODUCT_PREFIX + order;
}

function safeDetail(payload, fallback) {
  const detail = typeof payload?.detail === 'string' ? payload.detail : '';
  return detail && detail.length <= 160 ? detail : fallback;
}

class QlchatLicense {
  constructor({ storageDir, fetchImpl = globalThis.fetch, safeStorage, deviceId } = {}) {
    if (!storageDir || typeof fetchImpl !== 'function') throw new TypeError('storageDir and fetchImpl are required');
    this.storageDir = storageDir;
    this.fetchImpl = fetchImpl;
    this.safeStorage = safeStorage;
    this._deviceId = deviceId || null;
    this._state = { authorized: false, detail: '尚未激活' };
  }

  get state() { return { ...this._state }; }

  async _device() {
    if (this._deviceId) return this._deviceId;
    const file = path.join(this.storageDir, 'install-id');
    try {
      this._deviceId = (await fs.readFile(file, 'utf8')).trim();
    } catch {
      this._deviceId = crypto.randomBytes(24).toString('hex');
      await fs.mkdir(this.storageDir, { recursive: true });
      await fs.writeFile(file, this._deviceId, { encoding: 'utf8', mode: 0o600 });
    }
    return this._deviceId;
  }

  async _deviceHash() {
    return crypto.createHash('sha256').update('QlchatDownloader\0' + await this._device()).digest('hex');
  }

  _licenseFile() { return path.join(this.storageDir, 'license.dat'); }

  async _load() {
    try {
      const raw = await fs.readFile(this._licenseFile(), 'utf8');
      const text = this.safeStorage?.isEncryptionAvailable?.() ? this.safeStorage.decryptString(Buffer.from(raw, 'base64')) : raw;
      const value = JSON.parse(text);
      if (value && typeof value.orderId === 'string' && typeof value.code === 'string') return value;
    } catch { /* missing or invalid local authorization */ }
    return null;
  }

  async _save(value) {
    await fs.mkdir(this.storageDir, { recursive: true });
    const text = JSON.stringify(value);
    const encoded = this.safeStorage?.isEncryptionAvailable?.()
      ? this.safeStorage.encryptString(text).toString('base64')
      : text;
    const temp = this._licenseFile() + '.tmp';
    await fs.writeFile(temp, encoded, 'utf8');
    await fs.rename(temp, this._licenseFile());
  }

  async _request(route, orderId, code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(`${LICENSE_API}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ order_id: orderId, code, device_id: await this._deviceHash(), product: PRODUCT_ID }),
        signal: controller.signal,
      });
      let payload = {};
      try { payload = await response.json(); } catch { /* handled below */ }
      if (!response.ok || payload.authorized !== true) {
        if (response.status >= 500 || response.status === 429) throw new QlchatLicenseError('授权服务器暂时不可用，请稍后重试。', 'network');
        throw new QlchatLicenseError(safeDetail(payload, '订单未授权，请核对订单号或联系卖家。'));
      }
      return payload;
    } catch (error) {
      if (error instanceof QlchatLicenseError) throw error;
      throw new QlchatLicenseError('暂时无法连接授权服务器，请检查网络后重试。', 'network');
    } finally { clearTimeout(timer); }
  }

  async activate(input) {
    const orderId = normalizeOrder(input);
    const payload = await this._request('/v1/activate', orderId, orderId);
    const now = Math.floor(Date.now() / 1000);
    await this._save({ orderId, code: orderId, lastOnlineAt: now, expiresAt: payload.expires_at || null });
    this._state = { authorized: true, detail: '授权有效', expiresAt: payload.expires_at || null, orderMask: `${orderId.slice(0, 7)}***` };
    return this.state;
  }

  async authorize() {
    const saved = await this._load();
    if (!saved) { this._state = { authorized: false, detail: '尚未激活' }; return this.state; }
    const now = Math.floor(Date.now() / 1000);
    if (saved.expiresAt && Number(saved.expiresAt) <= now) {
      this._state = { authorized: false, detail: '授权已过期，请重新激活。' };
      return this.state;
    }
    if (saved.lastOnlineAt && now - Number(saved.lastOnlineAt) < RECHECK_SECONDS) {
      this._state = { authorized: true, detail: '授权有效', expiresAt: saved.expiresAt || null, orderMask: `${saved.orderId.slice(0, 7)}***` };
      return this.state;
    }
    try {
      const payload = await this._request('/v1/check', saved.orderId, saved.code);
      saved.lastOnlineAt = now;
      saved.expiresAt = payload.expires_at || null;
      await this._save(saved);
      this._state = { authorized: true, detail: '授权有效', expiresAt: saved.expiresAt, orderMask: `${saved.orderId.slice(0, 7)}***` };
      return this.state;
    } catch (error) {
      if (error.kind === 'network' && saved.lastOnlineAt && now - Number(saved.lastOnlineAt) <= OFFLINE_GRACE_SECONDS) {
        this._state = { authorized: true, detail: '离线授权有效', expiresAt: saved.expiresAt || null, orderMask: `${saved.orderId.slice(0, 7)}***` };
      } else {
        this._state = { authorized: false, detail: error.message };
      }
      return this.state;
    }
  }

  async clear() {
    await fs.unlink(this._licenseFile()).catch(() => {});
    this._state = { authorized: false, detail: '尚未激活' };
    return this.state;
  }
}

module.exports = { QlchatLicense, QlchatLicenseError, normalizeOrder, PRODUCT_PREFIX };
