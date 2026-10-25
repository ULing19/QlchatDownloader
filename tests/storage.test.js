'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteFile } = require('../src/core/storage');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qlchat-redirected-storage-')));
  const logicalDir = path.join(root, 'C-volume', 'Roaming', 'QlchatDownloader');
  const physicalDir = path.join(root, 'E-volume', 'WpSystem', 'LocalCache', 'Roaming', 'QlchatDownloader');
  await fs.mkdir(physicalDir, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = value => {
    const resolved = path.resolve(value);
    if (resolved === path.resolve(logicalDir)) return physicalDir;
    if (resolved.startsWith(path.resolve(logicalDir) + path.sep)) return path.join(physicalDir, path.relative(logicalDir, resolved));
    return value;
  };
  return { root, logicalDir, physicalDir, local };
}

function redirectedFs(fx, { renameError } = {}) {
  let renameObserved;
  const fsImpl = {
    mkdir: (p, options) => fs.mkdir(fx.local(p), options),
    open: (p, flags, mode) => fs.open(fx.local(p), flags, mode),
    readFile: (p, options) => fs.readFile(fx.local(p), options),
    unlink: p => fs.unlink(fx.local(p)),
    realpath: async p => {
      if (path.resolve(p) === path.resolve(fx.logicalDir)) return path.resolve(fx.logicalDir);
      return fs.realpath(fx.local(p));
    },
    rename: async (from, to) => {
      renameObserved = { from, to };
      if (renameError) throw Object.assign(new Error(`mock ${renameError}`), { code: renameError });
      assert.equal(path.dirname(from), path.dirname(to), 'both rename operands must use one physical parent');
      assert.ok(from.startsWith(fx.physicalDir), 'the temporary file path must be physically redirected');
      return fs.rename(from, to);
    },
  };
  return { fsImpl, renamePath: () => renameObserved };
}

test('resolves the created temp file after file redirection and replaces the physical destination', async t => {
  const fx = await fixture(t);
  const redirect = redirectedFs(fx);
  const destination = path.join(fx.logicalDir, 'license.dat');
  await atomicWriteFile(destination, Buffer.from('encrypted-license'), { fsImpl: redirect.fsImpl });

  assert.deepEqual(await fs.readFile(path.join(fx.physicalDir, 'license.dat')), Buffer.from('encrypted-license'));
  assert.deepEqual(await fs.readFile(destination, { encoding: 'utf8' }).catch(() => ''), '');
  const renamed = redirect.renamePath();
  assert.ok(renamed.from.startsWith(fx.physicalDir));
  assert.equal(path.dirname(renamed.from), path.dirname(renamed.to));
  assert.deepEqual(await fs.readdir(fx.physicalDir), ['license.dat']);
});

test('simulated EXDEV leaves the previous credential unchanged and removes the temp file', async t => {
  const fx = await fixture(t);
  const destination = path.join(fx.logicalDir, 'license.dat');
  const physicalDestination = path.join(fx.physicalDir, 'license.dat');
  await fs.writeFile(physicalDestination, 'previous-encrypted-license');
  const redirect = redirectedFs(fx, { renameError: 'EXDEV' });

  await assert.rejects(
    atomicWriteFile(destination, Buffer.from('replacement-secret'), { fsImpl: redirect.fsImpl }),
    error => error.name === 'StorageWriteError' && error.storageCode === 'EXDEV' && !error.message.includes(fx.root) && !error.message.includes('replacement-secret'),
  );
  assert.equal(await fs.readFile(physicalDestination, 'utf8'), 'previous-encrypted-license');
  assert.deepEqual(await fs.readdir(fx.physicalDir), ['license.dat']);
});

test('concurrent writes serialize per logical destination and clean unique temporary files', async t => {
  const fx = await fixture(t);
  const destination = path.join(fx.logicalDir, 'course-library.json');
  const redirect = redirectedFs(fx);
  const values = Array.from({ length: 8 }, (_, i) => JSON.stringify({ revision: i }));
  await Promise.all(values.map(value => atomicWriteFile(destination, value, { fsImpl: redirect.fsImpl })));

  const saved = JSON.parse(await fs.readFile(path.join(fx.physicalDir, 'course-library.json'), 'utf8'));
  assert.deepEqual(saved, { revision: values.length - 1 });
  assert.deepEqual(await fs.readdir(fx.physicalDir), ['course-library.json']);
});
