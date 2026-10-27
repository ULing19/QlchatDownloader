'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DownloadManager, DownloadError, safeName, inspectManifest, parseProgressLine } = require('../src/core/download');
const { QlchatError } = require('../src/core/qlchat');

const URL = 'https://video.example.test/video.m3u8?token=PRIVATE_SIGNED_VALUE';
const MANIFEST = '#EXTM3U\n#EXTINF:50,\n1.ts\n#EXTINF:50,\n2.ts\n#EXT-X-ENDLIST\n';

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlchat-engine-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function spawnFixture({ downloadCode = 0, verifyCode = 0, duration = 100, waitForCancel = false } = {}) {
  const calls = [];
  function spawnProcess(command, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
    child.kill = () => { setImmediate(() => close(null)); return true; };
    calls.push({ command, args, options, child });
    const downloading = args.includes('copy');
    setImmediate(async () => {
      try {
        if (downloading) {
          await fs.writeFile(args.at(-1), Buffer.alloc(2048, 23));
          child.stdout.write('out_ti');
          child.stdout.write('me_us=25000000\n');
          child.stdout.write(`out_time_us=${duration * 1000000}\n`);
          if (downloadCode) child.stderr.write(`Error fetching ${URL}\nAuthorization: Bearer SECRET\n`);
          if (!waitForCancel) close(downloadCode);
        } else {
          child.stdout.write(`out_time_us=${duration * 1000000}\nprogress=end\n`);
          close(verifyCode);
        }
      } catch (error) { child.emit('error', error); }
    });
    return child;
  }
  return { calls, spawnProcess };
}

function engine(fixture, extra = {}) {
  return new DownloadManager({
    ffmpegPath: 'bundled-ffmpeg.exe',
    resolveMedia: async () => ({ url: URL, duration: 100 }),
    fetchManifest: async () => MANIFEST,
    spawnProcess: fixture.spawnProcess,
    ...extra,
  });
}

async function allFiles(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await allFiles(file)); else result.push(file);
  }
  return result;
}

test('Windows names and traversal fragments remain ordinary filename segments', () => {
  assert.equal(safeName('../../escape'), '.._.._escape');
  assert.equal(safeName('..'), '未命名');
  assert.equal(safeName('NUL.txt'), '_NUL.txt');
  assert.equal(safeName('COM1'), '_COM1');
  assert.equal(safeName('函数:定义? '), '函数_定义_');
  assert.equal(safeName('a'.repeat(150)).length, 100);
});

test('HLS metadata rejects protected media and parses ordinary duration', () => {
  assert.deepEqual(inspectManifest(MANIFEST), { duration: 100, master: false, ended: true });
  for (const method of ['AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR']) {
    assert.throws(() => inspectManifest(`#EXTM3U\n#EXT-X-KEY:METHOD=${method},URI="private"\n`), /加密保护/);
  }
  assert.throws(() => inspectManifest('<html>login</html>'), /有效的播放清单/);
  assert.equal(parseProgressLine('out_time_us=2566206000'), 2566.206);
  assert.equal(parseProgressLine('out_time=00:42:46.206'), 2566.206);
});

test('complete download verifies full video then publishes once without partial files', async t => {
  const outputDir = await sandbox(t);
  const fixture = spawnFixture();
  const manager = engine(fixture, { maxAttempts: 1 });
  const progress = [];
  manager.on('progress', event => progress.push(event));
  const result = await manager.start({ tasks: [{ id: 'first', title: '函数概念', chapter: '第一章', index: 1 }], outputDir, courseTitle: '高等数学' });
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(manager.busy, false);
  assert.match(result.results[0].path, /01 函数概念\.mp4$/);
  assert.equal((await allFiles(outputDir)).length, 1);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0].options.windowsHide, true);
  assert(fixture.calls[1].args.includes('-xerror'));
  assert(progress.some(event => event.status === 'downloading' && event.downloadedSeconds === 25));
  assert.equal(progress.at(-1).status, 'completed');
  assert.equal(progress.at(-1).percent, 100);
});

test('existing output is retained and later downloads use a new filename', async t => {
  const outputDir = await sandbox(t);
  const manager = engine(spawnFixture());
  const input = { tasks: [{ id: '1', title: '函数', chapter: '第一章', index: 1 }], outputDir, courseTitle: '课程' };
  const first = await manager.start(input);
  await fs.writeFile(first.results[0].path, 'user-owned-existing-video');
  const second = await manager.start(input);
  assert.equal(await fs.readFile(first.results[0].path, 'utf8'), 'user-owned-existing-video');
  assert.match(second.results[0].path, /01 函数 \(2\)\.mp4$/);
});

test('resume reuses a valid existing course file without requesting a new signed URL', async t => {
  const outputDir = await sandbox(t);
  let resolveCalls = 0;
  const fixture = spawnFixture();
  const manager = engine(fixture, {
    resolveMedia: async () => { resolveCalls++; return { url: URL, duration: 100 }; },
    verifyMedia: async () => ({ duration: 100 }),
  });
  const input = { tasks: [{ id: 'resume', title: '函数', chapter: '第一章', index: 1 }], outputDir, courseTitle: '课程' };
  const first = await manager.start(input);
  await fs.writeFile(first.results[0].path, Buffer.alloc(2 * 1024 * 1024, 7));
  const second = await manager.start(input);
  assert.equal(second.completed, 1);
  assert.equal(second.results[0].path, first.results[0].path);
  assert.equal(resolveCalls, 1);
});

test('course, chapter, and titles cannot escape the selected output root', async t => {
  const outputDir = await sandbox(t);
  const result = await engine(spawnFixture()).start({
    tasks: [{ id: '1', title: '../../outside', chapter: '..\\..\\outside' }],
    outputDir, courseTitle: '../../outside',
  });
  assert.equal(result.completed, 1);
  assert(!path.relative(await fs.realpath(outputDir), result.results[0].path).startsWith('..' + path.sep));
});

test('failed FFmpeg output never becomes completed and private URLs never reach logs', async t => {
  const outputDir = await sandbox(t);
  const fixture = spawnFixture({ downloadCode: 1 });
  const manager = engine(fixture, { maxAttempts: 1 });
  const events = [];
  manager.on('progress', event => events.push(event));
  manager.on('log', message => events.push(message));
  const result = await manager.start({ tasks: [{ id: '1', title: '课程' }], outputDir, courseTitle: '测试' });
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(await allFiles(outputDir), []);
  assert(!JSON.stringify({ result, events }).includes('PRIVATE_SIGNED_VALUE'));
  assert(!JSON.stringify({ result, events }).includes('SECRET'));
  assert(!events.some(event => event.status === 'completed'));
});

test('decode failure removes partial rather than reporting download success', async t => {
  const outputDir = await sandbox(t);
  const result = await engine(spawnFixture({ verifyCode: 1 })).start({ tasks: [{ id: '1', title: '课程' }], outputDir });
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /完整解码检查/);
  assert.deepEqual(await allFiles(outputDir), []);
});

test('short output is rejected even when FFmpeg exits successfully', async t => {
  const outputDir = await sandbox(t);
  const manager = engine(spawnFixture({ duration: 50 }));
  const result = await manager.start({ tasks: [{ id: '1', title: '课程' }], outputDir });
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /时长不足/);
  assert.deepEqual(await allFiles(outputDir), []);
});

test('cancel terminates the current child and marks remaining tasks cancelled', async t => {
  const outputDir = await sandbox(t);
  const fixture = spawnFixture({ waitForCancel: true });
  const manager = engine(fixture);
  let cancelled = false;
  manager.on('progress', event => {
    if (event.status === 'downloading' && event.downloadedSeconds > 0 && !cancelled) {
      cancelled = true;
      manager.cancel();
    }
  });
  const result = await manager.start({ tasks: [{ id: '1', title: '一' }, { id: '2', title: '二' }], outputDir });
  assert.equal(result.cancelled, 2);
  assert.equal(result.completed, 0);
  assert.equal(fixture.calls.length, 1);
  assert.equal(manager.busy, false);
  assert.deepEqual(await allFiles(outputDir), []);
});

test('one resolver failure does not stop following tasks or expose private exceptions', async t => {
  const outputDir = await sandbox(t);
  const manager = engine(spawnFixture(), { resolveMedia: async task => {
    if (task.id === 'bad') throw new Error(`failed ${URL} Cookie=PRIVATE_COOKIE`);
    return { url: URL, duration: 100 };
  } });
  const result = await manager.start({ tasks: [{ id: 'bad', title: '一' }, { id: 'good', title: '二' }], outputDir });
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 1);
  assert(!JSON.stringify(result).includes('PRIVATE'));
});

test('refreshes a transient signed URL and retries a lesson within one batch', async t => {
  const outputDir = await sandbox(t);
  const fixture = spawnFixture();
  let attempts = 0;
  const manager = engine(fixture, {
    maxAttempts: 3,
    resolveMedia: async () => {
      attempts++;
      if (attempts < 3) throw new DownloadError('RESOLVE_FAILED', '视频地址暂时失效，请重试。');
      return { url: URL, duration: 100 };
    },
  });
  const result = await manager.start({ tasks: [{ id: 'retry', title: '需要重试' }], outputDir });
  assert.equal(attempts, 3);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
});

test('saves graph-text lessons as escaped local HTML', async t => {
  const outputDir = await sandbox(t);
  const manager = engine(spawnFixture(), { resolveMedia: async () => ({ mediaKind: 'document', content: '<script>alert(1)</script><p>正文</p> https://img.qlchat.com/course/a.png' }) });
  const result = await manager.start({ tasks: [{ id: 'doc', title: '图文课', chapter: '第一章', mediaKind: 'document' }], outputDir, courseTitle: '图文课程' });
  assert.equal(result.completed, 1);
  assert.match(result.results[0].path, /\.html$/);
  const html = await fs.readFile(result.results[0].path, 'utf8');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /<img src="https:\/\/img\.qlchat\.com\/course\/a\.png"/);
});

test('safe QlchatError details reach the task while ordinary errors remain private', async t => {
  const outputDir = await sandbox(t);
  const message = '千聊播放地址格式发生变化，请更新下载器后重试。';
  const manager = engine(spawnFixture(), { resolveMedia: async task => {
    if (task.id === 'safe') throw new QlchatError(message);
    const error = new Error(`千聊内部错误 ${URL} Cookie=PRIVATE_COOKIE`);
    if (task.id === 'code-only') error.code = 'QLCHAT_CLIENT';
    if (task.id === 'name-only') error.name = 'QlchatError';
    throw error;
  } });
  const events = [];
  manager.on('progress', event => events.push(event));
  manager.on('log', log => events.push(log));
  const result = await manager.start({ tasks: ['safe', 'code-only', 'name-only', 'ordinary'].map(id => ({ id, title: id })), outputDir });
  assert.equal(result.failed, 4);
  assert.equal(result.results[0].error, message);
  assert(events.some(event => event.error === message));
  assert(!JSON.stringify({ result, events }).includes('PRIVATE'));
  assert(result.results.slice(1).every(item => item.error === '获取播放地址失败，请在登录窗口确认该课程可以播放。'));
});

test('encrypted master variants are rejected before starting FFmpeg', async t => {
  const outputDir = await sandbox(t);
  const fixture = spawnFixture();
  const manager = engine(fixture, { fetchManifest: async url => url.includes('variant.m3u8')
    ? '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="protected"\n#EXT-X-ENDLIST\n'
    : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant.m3u8\n' });
  const result = await manager.start({ tasks: [{ id: '1', title: '课程' }], outputDir });
  assert.equal(result.failed, 1);
  assert.equal(fixture.calls.length, 0);
});

test('repeated start while a batch is active is rejected', async t => {
  const outputDir = await sandbox(t);
  let finishResolve;
  const gate = new Promise(resolve => { finishResolve = resolve; });
  const manager = engine(spawnFixture(), { resolveMedia: async () => { await gate; return { url: URL, duration: 100 }; } });
  const promise = manager.start({ tasks: [{ id: '1' }], outputDir });
  assert.equal(manager.busy, true);
  await assert.rejects(manager.start({ tasks: [{ id: '2' }], outputDir }), /正在运行/);
  manager.cancel();
  finishResolve();
  const result = await promise;
  assert.equal(result.cancelled, 1);
});

test('bundled FFmpeg downloads local HLS, merges MP4, and fully decodes the result', async t => {
  const ffmpegPath = path.resolve(__dirname, '..', '..', 'ffmpeg.exe');
  try { await fs.access(ffmpegPath); } catch { t.skip('Bundled FFmpeg is not present in this checkout'); return; }
  const temporary = await sandbox(t);
  const source = path.join(temporary, 'source');
  const outputDir = path.join(temporary, 'downloads');
  await fs.mkdir(source);
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-g', '10', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1',
      '-hls_list_size', '0', path.join(source, 'media.m3u8'),
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Test media generation failed (${code}): ${errorText}`)));
  });
  const server = http.createServer(async (request, response) => {
    const filename = path.basename(new global.URL(request.url, 'http://localhost').pathname);
    try {
      const data = await fs.readFile(path.join(source, filename));
      response.writeHead(200, { 'Content-Type': filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const manager = new DownloadManager({
    ffmpegPath,
    resolveMedia: async () => ({ url: `http://127.0.0.1:${server.address().port}/media.m3u8`, duration: 2 }),
  });
  const result = await manager.start({ tasks: [{ id: 'real', title: '本地音视频验证', chapter: '第一章' }], outputDir, courseTitle: '引擎实测' });
  assert.equal(result.completed, 1, JSON.stringify(result));
  assert.equal(result.failed, 0);
  assert((await fs.stat(result.results[0].path)).size > 2048);
  assert.equal((await allFiles(outputDir)).length, 1);
});
