'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const pendingWrites = new Map();

class StorageWriteError extends Error {
  constructor(error) {
    const code = String(error?.code || error?.storageCode || 'UNKNOWN');
    const storageCode = /^[A-Z][A-Z0-9_]{1,24}$/.test(code) ? code : 'UNKNOWN';
    super(`本机数据保存失败（${storageCode}），请确认应用数据目录可写后重试。`);
    this.name = 'StorageWriteError';
    this.storageCode = storageCode;
  }
}

async function writeOnce(destination, value, io) {
  let handle, temporary, physicalTemporary, committed = false;
  try {
    const logicalParent = path.dirname(destination);
    await io.mkdir(logicalParent, { recursive: true });
    const parent = await io.realpath(logicalParent);
    temporary = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    handle = await io.open(temporary, 'wx', 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = null;

    // MSIX can redirect individual newly-created files while realpath(parent)
    // still reports the original C: directory. Resolve the file AFTER creation.
    physicalTemporary = await io.realpath(temporary);
    const physicalDestination = path.join(path.dirname(physicalTemporary), path.basename(destination));
    await io.rename(physicalTemporary, physicalDestination);
    committed = true;
    const actual = await io.readFile(destination);
    const expected = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (!actual.equals(expected)) {
      const error = new Error();
      error.code = 'VERIFY_FAILED';
      throw error;
    }
    return physicalDestination;
  } catch (error) {
    throw error instanceof StorageWriteError ? error : new StorageWriteError(error);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed && temporary) await io.unlink(physicalTemporary || temporary).catch(() => {});
  }
}

function atomicWriteFile(destination, value, { fsImpl = fs } = {}) {
  const key = path.resolve(destination);
  const previous = pendingWrites.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeOnce(key, value, fsImpl));
  pendingWrites.set(key, current);
  return current.finally(() => { if (pendingWrites.get(key) === current) pendingWrites.delete(key); });
}

module.exports = { atomicWriteFile, StorageWriteError };
