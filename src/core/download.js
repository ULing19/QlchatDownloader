'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://h5.qlchat.com/',
});
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const RETRYABLE_CODES = new Set([
  'RESOLVE_FAILED', 'MANIFEST_NETWORK', 'MANIFEST_HTTP', 'MANIFEST_REDIRECT',
  'FFMPEG_START', 'FFMPEG_FAILED', 'VERIFY_FAILED', 'INCOMPLETE_FILE', 'INVALID_FILE',
]);

class DownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

function safeName(value, fallback = '未命名', maxLength = 100) {
  let text = typeof value === 'string' ? value : '';
  text = text.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_');
  text = text.replace(/[.\s]+$/g, '').trim();
  if (!text || /^\.+$/.test(text)) text = fallback;
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(text)) text = `_${text}`;
  return [...text].slice(0, maxLength).join('').replace(/[.\s]+$/g, '') || fallback;
}

function positiveNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function mediaExtension(mediaKind) {
  return mediaKind === 'audio' ? 'm4a' : mediaKind === 'document' ? 'html' : 'mp4';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderDocumentContent(value) {
  const escaped = escapeHtml(value);
  return escaped.replace(/https:\/\/[^\s&"'<>]+/gi, candidate => {
    if (!/\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(candidate)) return candidate;
    return `<img src="${candidate}" alt="课程图片" loading="lazy">`;
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateMediaUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    if (/voddrm\.token\.|\.mpd(?:$|[?#])/i.test(value)) {
      throw new DownloadError('UNSUPPORTED_DRM', '这节课程使用受保护的视频格式，当前版本暂不支持。');
    }
    return parsed;
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('INVALID_MEDIA_URL', '未获取到有效的视频地址，请重新登录后重试。');
  }
}

function abortError() {
  return new DownloadError('CANCELLED', '已取消下载。');
}

function fetchText(url, { signal, redirects = 0 } = {}) {
  const parsed = validateMediaUrl(url);
  if (signal?.aborted) return Promise.reject(abortError());
  if (redirects > 5) return Promise.reject(new DownloadError('MANIFEST_REDIRECT', '视频服务器重定向次数过多，请稍后重试。'));
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.get(parsed, { headers: REQUEST_HEADERS, signal }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        let target;
        try { target = new URL(response.headers.location, parsed).href; } catch { reject(new DownloadError('MANIFEST_REDIRECT', '视频服务器返回了无效的跳转地址。')); return; }
        fetchText(target, { signal, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new DownloadError('MANIFEST_HTTP', response.statusCode === 403
          ? '视频地址已失效或没有访问权限，请重新解析课程。'
          : `视频服务器暂时不可用（HTTP ${Number(response.statusCode) || 0}）。`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_MANIFEST_BYTES) {
          response.destroy();
          reject(new DownloadError('MANIFEST_SIZE', '视频播放清单过大，已停止解析。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', () => reject(new DownloadError('MANIFEST_NETWORK', '读取视频清单中断，请检查网络后重试。')));
    });
    request.setTimeout(30000, () => request.destroy());
    request.on('error', () => reject(signal?.aborted ? abortError() : new DownloadError('MANIFEST_NETWORK', '无法连接视频服务器，请检查网络后重试。')));
  });
}

function inspectManifest(text) {
  if (typeof text !== 'string' || !text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
    throw new DownloadError('INVALID_MANIFEST', '视频服务器未返回有效的播放清单，请重新解析课程。');
  }
  const methods = [...text.matchAll(/#EXT-X-(?:SESSION-)?KEY:[^\r\n]*METHOD=([^,\s]+)/gi)].map(match => match[1].toUpperCase());
  if (methods.some(method => method !== 'NONE') || /#EXT-X-(?:SESSION-)?KEY:[^\r\n]*KEYFORMAT\s*=/i.test(text)) {
    throw new DownloadError('UNSUPPORTED_DRM', '这节课程的视频清单包含加密保护，当前版本暂不支持。');
  }
  const duration = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + positiveNumber(match[1]), 0);
  return { duration, master: /#EXT-X-STREAM-INF:/i.test(text), ended: /#EXT-X-ENDLIST/i.test(text) };
}

function parseProgressLine(line) {
  if (/^out_time_(?:us|ms)=/.test(line)) return Math.max(0, positiveNumber(line.split('=')[1]) / 1000000);
  if (line.startsWith('out_time=')) {
    const match = line.match(/^out_time=(\d+):(\d+):([\d.]+)/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

class DownloadManager extends EventEmitter {
  constructor({ ffmpegPath, resolveMedia, fetchManifest = fetchText, spawnProcess = spawn, verifyMedia, resumeExisting = true, maxAttempts = 3 } = {}) {
    super();
    if (!ffmpegPath || typeof resolveMedia !== 'function') throw new TypeError('ffmpegPath and resolveMedia are required');
    this.ffmpegPath = ffmpegPath;
    this.resolveMedia = resolveMedia;
    this.fetchManifest = fetchManifest;
    this.spawnProcess = spawnProcess;
    this.verifyMedia = verifyMedia;
    this.resumeExisting = resumeExisting;
    this.maxAttempts = Math.max(1, Math.min(5, Math.floor(Number(maxAttempts) || 3)));
    this._busy = false;
    this._cancelled = false;
    this._child = null;
    this._abort = null;
  }

  get busy() { return this._busy; }

  cancel() {
    if (!this._busy) return;
    this._cancelled = true;
    this._abort?.abort();
    this._child?.kill();
  }

  _checkCancelled() { if (this._cancelled) throw abortError(); }

  _progress(task, status, extra = {}) {
    const duration = positiveNumber(task.duration);
    this.emit('progress', { taskId: task.id, status, percent: 0, downloadedSeconds: 0, totalSeconds: duration, ...extra });
  }

  async start({ tasks, outputDir, courseTitle } = {}) {
    if (this._busy) throw new DownloadError('BUSY', '已有下载任务正在运行。');
    if (!Array.isArray(tasks) || !tasks.length) throw new DownloadError('NO_TASKS', '请先选择需要下载的课程。');
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new DownloadError('NO_OUTPUT', '请选择保存文件夹。');
    this._busy = true;
    this._cancelled = false;
    const entries = tasks.map((task, index) => ({ ...task, id: String(task.id ?? index + 1), index: positiveNumber(task.index) || index + 1 }));
    const result = { total: entries.length, completed: 0, failed: 0, cancelled: 0, results: [] };
    try {
      await fs.mkdir(path.resolve(outputDir), { recursive: true });
      const root = await fs.realpath(path.resolve(outputDir));
      const courseDir = path.join(root, safeName(courseTitle, '千聊课程'));
      await fs.mkdir(courseDir, { recursive: true });
      if (!isInside(root, await fs.realpath(courseDir))) throw new DownloadError('OUTPUT_PATH', '课程文件夹指向保存目录之外，请更换保存位置。');
      for (const task of entries) this._progress(task, 'queued');
      for (const task of entries) {
        if (this._cancelled) {
          this._progress(task, 'cancelled');
          result.cancelled++;
          result.results.push({ taskId: task.id, status: 'cancelled' });
          continue;
        }
        try {
          const file = await this._downloadWithRetry(task, courseDir);
          result.completed++;
          result.results.push({ taskId: task.id, status: 'completed', path: file });
        } catch (error) {
          const cancelled = this._cancelled || error?.code === 'CANCELLED';
          const status = cancelled ? 'cancelled' : 'failed';
          const message = cancelled ? '已取消下载。' : this._safeMessage(error);
          result[status === 'failed' ? 'failed' : 'cancelled']++;
          result.results.push({ taskId: task.id, status, error: message });
          this._progress(task, status, { error: message });
          this.emit('log', cancelled ? '下载已取消。' : `一节课程下载失败：${message}`);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      throw new DownloadError('OUTPUT_UNAVAILABLE', '无法创建保存文件夹，请检查路径、权限和磁盘空间。');
    } finally {
      this._child = null;
      this._abort = null;
      this._busy = false;
    }
  }

  _safeMessage(error) {
    if (error instanceof DownloadError) return error.message;
    if (error?.code === 'ENOSPC') return '磁盘空间不足，请更换保存文件夹。';
    if (['EACCES', 'EPERM'].includes(error?.code)) return '没有写入保存文件夹的权限，请更换位置。';
    return '下载失败，请确认登录状态、课程播放权限和网络后重试。';
  }

  async _downloadWithRetry(task, courseDir) {
    const attempts = Math.max(1, Math.floor(Number(this.maxAttempts) || 1));
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this._checkCancelled();
      try {
        return await this._download(task, courseDir);
      } catch (error) {
        lastError = error;
        if (this._cancelled || !(error instanceof DownloadError) || !RETRYABLE_CODES.has(error.code) || attempt >= attempts) throw error;
        this.emit('log', `一节课程暂时失败，正在刷新播放地址重试（${attempt + 1}/${attempts}）。`);
      }
    }
    throw lastError;
  }

  async _download(task, courseDir) {
    let partial;
    this._abort = new AbortController();
    try {
      const requestedKind = ['audio', 'document', 'video'].includes(task.mediaKind) ? task.mediaKind : 'video';
      const chapterValue = typeof task.chapter === 'object' && task.chapter ? task.chapter.title || task.chapter.name : task.chapter;
      const folder = path.join(courseDir, safeName(chapterValue, '课程视频'));
      await fs.mkdir(folder, { recursive: true });
      if (!isInside(await fs.realpath(courseDir), await fs.realpath(folder))) throw new DownloadError('OUTPUT_PATH', '章节文件夹指向课程目录之外，请更换保存位置。');
      const number = String(Math.floor(task.index)).padStart(2, '0');
      const base = `${number} ${safeName(task.title, `课程 ${number}`, 120)}`;
      if (this.resumeExisting) {
        const existing = await this._findExisting(folder, number, requestedKind);
        if (existing) {
          this._progress(task, 'resolving');
          this._progress(task, 'verifying', { percent: 99, totalSeconds: positiveNumber(task.duration) });
          const verified = await this._verifyFile(existing, positiveNumber(task.duration), requestedKind);
          if (verified) {
            const actualDuration = positiveNumber(verified.duration);
            this._progress(task, 'completed', { percent: 100, downloadedSeconds: actualDuration, totalSeconds: actualDuration || positiveNumber(task.duration), path: existing });
            this.emit('log', '已复用本地完整课时，跳过重复下载。');
            return existing;
          }
        }
        await this._removeStalePartials(folder, number, requestedKind);
      }
      this._progress(task, 'resolving');
      let media;
      try { media = await this.resolveMedia(task, { signal: this._abort.signal }); } catch (error) {
        this._checkCancelled();
        if (error instanceof DownloadError) throw error;
        if (error?.code === 'QLCHAT_CLIENT' && error?.name === 'QlchatError') {
          throw new DownloadError('RESOLVE_FAILED', error.message);
        }
        throw new DownloadError('RESOLVE_FAILED', '获取播放地址失败，请在登录窗口确认该课程可以播放。');
      }
      this._checkCancelled();
      const mediaKind = ['audio', 'document', 'video'].includes(media?.mediaKind) ? media.mediaKind : requestedKind;
      if (mediaKind === 'document') {
        const content = typeof media?.content === 'string' ? media.content : typeof media?.text === 'string' ? media.text : typeof media?.body === 'string' ? media.body : '';
        if (!content.trim()) throw new DownloadError('INVALID_FILE', '图文内容为空，无法保存。');
        partial = path.join(folder, `.${safeName(base, number, 125)}.${randomUUID()}.part.html`);
        this._progress(task, 'downloading', { totalSeconds: 0 });
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(task.title || '千聊图文')}</title><style>body{font-family:system-ui,sans-serif;line-height:1.7;max-width:960px;margin:2rem auto;padding:0 1rem;color:#243b32}pre{white-space:pre-wrap;word-break:break-word}img{display:block;max-width:100%;height:auto;margin:1rem 0}</style></head><body><pre>${renderDocumentContent(content)}</pre></body></html>`;
        await fs.writeFile(partial, html, { encoding: 'utf8', flag: 'wx' });
        this._checkCancelled();
        const info = await fs.stat(partial);
        if (!info.isFile() || info.size < 32) throw new DownloadError('INVALID_FILE', '图文内容为空或不完整，请重试。');
        const finalPath = await this._publish(partial, folder, base, 'html');
        partial = null;
        this._progress(task, 'completed', { percent: 100, path: finalPath });
        this.emit('log', '一节图文课程已保存到本地。');
        return finalPath;
      }
      const url = validateMediaUrl(media?.url);
      let totalSeconds = positiveNumber(media.duration) || positiveNumber(task.duration);
      if (/\.m3u8$/i.test(url.pathname)) {
        const text = await this.fetchManifest(url.href, { signal: this._abort.signal });
        this._checkCancelled();
        const manifest = inspectManifest(text);
        // A master playlist is inspected recursively so protected variants are not passed to FFmpeg.
        if (manifest.master) await this._inspectVariants(text, url.href, 0);
        else if (!manifest.ended) throw new DownloadError('LIVE_NOT_SUPPORTED', '该课程仍在直播，结束后再下载回放。');
        totalSeconds = manifest.duration || totalSeconds;
      }
      this._checkCancelled();
      const extension = mediaExtension(mediaKind);
      partial = path.join(folder, `.${safeName(base, number, 125)}.${randomUUID()}.part.${extension}`);
      const headers = Object.entries(REQUEST_HEADERS).map(([name, value]) => `${name}: ${value}\r\n`).join('');
      this._progress(task, 'downloading', { totalSeconds });
      const ffmpegArgs = [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-rw_timeout', '30000000',
        '-headers', headers, '-i', url.href,
        ...(mediaKind === 'audio' ? ['-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] : ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart']),
        '-progress', 'pipe:1', partial,
      ];
      const downloadedSeconds = await this._run(ffmpegArgs, seconds => this._progress(task, 'downloading', {
        percent: totalSeconds ? Math.min(98, Math.max(0, seconds / totalSeconds * 98)) : 0,
        downloadedSeconds: seconds, totalSeconds,
      }));
      this._checkCancelled();
      const info = await fs.stat(partial);
      if (!info.isFile() || info.size < 1024) throw new DownloadError('INVALID_FILE', '下载文件为空或不完整，请重试。');
      this._progress(task, 'verifying', { percent: 99, downloadedSeconds, totalSeconds });
      const verified = await this._verifyFile(partial, totalSeconds, mediaKind);
      this._checkCancelled();
      const actualDuration = positiveNumber(verified?.duration);
      if (!actualDuration || (totalSeconds && actualDuration < totalSeconds - Math.max(2, totalSeconds * 0.02))) {
        throw new DownloadError('INCOMPLETE_FILE', '视频时长不足，文件可能不完整，请重新下载。');
      }
      const finalPath = await this._publish(partial, folder, base, extension);
      partial = null;
      this._progress(task, 'completed', { percent: 100, downloadedSeconds: actualDuration, totalSeconds: totalSeconds || actualDuration, path: finalPath });
      this.emit('log', `一节课程已下载并通过完整性检查。`);
      return finalPath;
    } finally {
      if (partial) await fs.unlink(partial).catch(() => {});
      this._abort = null;
    }
  }

  async _findExisting(folder, number, mediaKind = 'video') {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return null; }
    const extension = `.${mediaExtension(mediaKind)}`;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${number} `) || !entry.name.toLowerCase().endsWith(extension) || entry.name.includes('.part.')) continue;
      const candidate = path.join(folder, entry.name);
      try {
        const minimum = mediaKind === 'document' ? 32 : 1024;
        if ((await fs.stat(candidate)).size > minimum) return candidate;
      } catch { /* changed during scan */ }
    }
    return null;
  }

  async _removeStalePartials(folder, number, mediaKind = 'video') {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    const extension = `.part.${mediaExtension(mediaKind)}`;
    await Promise.all(entries.filter(entry => entry.isFile() && entry.name.startsWith(`.${number} `) && entry.name.endsWith(extension)).map(entry => fs.unlink(path.join(folder, entry.name)).catch(() => {})));
  }

  async _verifyFile(file, expectedDuration, mediaKind = 'video') {
    if (mediaKind === 'document') {
      const info = await fs.stat(file).catch(() => null);
      if (!info?.isFile() || info.size < 32) throw new DownloadError('VERIFY_FAILED', '图文文件未通过完整性检查，请重新保存。');
      return { duration: positiveNumber(expectedDuration) };
    }
    if (this.verifyMedia) return this.verifyMedia(file, { expectedDuration, mediaKind, signal: this._abort.signal });
    return { duration: await this._run([
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', file,
      ...(mediaKind === 'audio' ? ['-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a:0?']), '-progress', 'pipe:1', '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ], () => {}, true) };
  }

  async _inspectVariants(text, baseUrl, depth) {
    if (depth > 3) throw new DownloadError('MANIFEST_DEPTH', '播放清单嵌套过深，当前版本暂不支持。');
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^#EXT-X-STREAM-INF:/i.test(lines[i].trim())) {
        const next = lines.slice(i + 1).find(line => line.trim() && !line.trim().startsWith('#'));
        if (next) variants.push(new URL(next.trim(), baseUrl).href);
      }
    }
    if (!variants.length || variants.length > 24) throw new DownloadError('INVALID_MANIFEST', '视频播放清单中的清晰度列表无效。');
    for (const variant of variants) {
      this._checkCancelled();
      const content = await this.fetchManifest(variant, { signal: this._abort.signal });
      const parsed = inspectManifest(content);
      if (parsed.master) await this._inspectVariants(content, variant, depth + 1);
      else if (!parsed.ended) throw new DownloadError('LIVE_NOT_SUPPORTED', '该课程仍在直播，结束后再下载回放。');
    }
  }

  _run(args, onProgress, verifying = false) {
    return new Promise((resolve, reject) => {
      this._checkCancelled();
      let child;
      try { child = this.spawnProcess(this.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch {
        reject(new DownloadError('FFMPEG_START', '无法启动视频处理组件，请重新安装下载器。'));
        return;
      }
      this._child = child;
      let buffer = '';
      let duration = 0;
      let diagnostics = '';
      child.stdout?.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        if (buffer.length > 10000) buffer = '';
        for (const line of lines) {
          const seconds = parseProgressLine(line);
          if (seconds !== null && seconds >= duration) { duration = seconds; onProgress(seconds); }
        }
      });
      child.stderr?.on('data', chunk => {
        // Kept only in memory for classification. Raw FFmpeg messages can contain signed URLs.
        diagnostics = (diagnostics + chunk.toString()).slice(-65536);
      });
      child.once('error', () => {
        if (this._child === child) this._child = null;
        reject(this._cancelled ? abortError() : new DownloadError('FFMPEG_START', '无法启动视频处理组件，请重新安装下载器。'));
      });
      child.once('close', code => {
        if (this._child === child) this._child = null;
        if (this._cancelled) { reject(abortError()); return; }
        if (code !== 0) {
          let message = verifying ? '视频文件未通过完整解码检查，请重新下载。' : '下载或合并失败，请检查课程播放权限和网络后重试。';
          if (/No space left|not enough space|磁盘空间不足/i.test(diagnostics)) message = '磁盘空间不足，请更换保存文件夹。';
          else if (/403|Forbidden|401|Unauthorized/i.test(diagnostics)) message = '视频地址已失效或没有访问权限，请重新解析课程。';
          reject(new DownloadError(verifying ? 'VERIFY_FAILED' : 'FFMPEG_FAILED', message));
          return;
        }
        resolve(duration);
      });
    });
  }

  async _publish(partial, folder, base, extension = 'mp4') {
    for (let suffix = 0; suffix < 10000; suffix++) {
      this._checkCancelled();
      const destination = path.join(folder, `${base}${suffix ? ` (${suffix + 1})` : ''}.${extension}`);
      try {
        // Same-volume hard-link creation is atomic and fails on an existing name.
        // Node's rename replaces a destination, so it cannot provide the no-overwrite guarantee.
        await fs.link(partial, destination);
        await fs.unlink(partial).catch(() => {});
        return destination;
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
          // exFAT and network shares may not support hard links. Reserve a new name,
          // then rename the complete file over only our empty reservation.
          let reservation;
          try { reservation = await fs.open(destination, 'wx'); } catch (reserveError) {
            if (reserveError.code === 'EEXIST') continue;
            throw reserveError;
          }
          await reservation.close();
          try { await fs.rename(partial, destination); return destination; } catch (renameError) {
            await fs.unlink(destination).catch(() => {});
            throw renameError;
          }
        }
        throw error;
      }
    }
    throw new DownloadError('TOO_MANY_NAMES', '同名文件过多，请更换保存文件夹。');
  }
}

module.exports = { DownloadManager, DownloadError, safeName, inspectManifest, parseProgressLine };
