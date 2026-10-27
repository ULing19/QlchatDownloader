'use strict';

const crypto = require('node:crypto');

const ORIGIN = 'https://h5.qlchat.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const STUDY_URL = `${ORIGIN}/wechat/page/mine/study`;

class QlchatError extends Error {
  constructor(message, reasonCode) {
    super(message);
    this.name = 'QlchatError';
    this.code = 'QLCHAT_CLIENT';
    if (reasonCode) this.reasonCode = reasonCode;
  }
}

function parseQlchatUrl(input) {
  const match = String(input || '').match(/https:\/\/[^\s<>"\u201c\u201d]+/i);
  if (!match) throw new QlchatError('请粘贴千聊的课程或单节视频链接。');
  let url;
  try { url = new URL(match[0]); } catch { throw new QlchatError('课程链接格式不正确。'); }
  if (!['h5.qlchat.com', 'www.qlchat.com', 'qlchat.com'].includes(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new QlchatError('请使用 qlchat.com 官方千聊课程链接。');
  }
  return url;
}

function studyUrl(input = STUDY_URL) {
  const url = parseQlchatUrl(input);
  if (url.pathname.replace(/\/$/, '') !== '/wechat/page/mine/study') throw new QlchatError('请使用千聊“我的学习”页面链接。');
  return STUDY_URL;
}

function courseUrl(input) {
  const url = parseQlchatUrl(input);
  const topicId = url.searchParams.get('topicId');
  const channelId = url.searchParams.get('channelId');
  if (topicId && /^\d{5,24}$/.test(topicId)) return `${ORIGIN}/wechat/page/topic-simple-video?topicId=${topicId}`;
  if (channelId && /^\d{5,24}$/.test(channelId)) return `${ORIGIN}/wechat/page/channel-intro?channelId=${channelId}`;
  throw new QlchatError('链接中没有课程编号，请复制课程页面的完整链接。');
}

function loginUrl(input = STUDY_URL) {
  const url = parseQlchatUrl(input);
  return url.pathname.replace(/\/$/, '') === '/wechat/page/mine/study' ? STUDY_URL : courseUrl(input);
}

function parseInitialState(html) {
  const marker = /window\.__INIT_STATE__\s*=\s*/g.exec(html);
  if (!marker) return null;
  let start = marker.index + marker[0].length;
  if (html[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let end = start; end < html.length; end++) {
    const ch = html[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, end + 1)); } catch { return null; }
    }
  }
  return null;
}

function cleanTitle(value, fallback) {
  return String(value || fallback).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function findCourseMetadata(state) {
  const video = state?.video || {};
  const topic = video.topicInfo || state?.thousandLive?.topicInfo || {};
  const candidates = [topic, state?.channel?.channelInfo, state?.channel?.channel, state?.channelIntro?.channelInfo, state?.channelIntro?.channel, state?.channelInfo];
  // Channel landing pages have used different reducer names over time.
  const queue = [state];
  for (let n = 0; queue.length && n < 150; n++) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.liveId && (item.channelId || (item.id && (item.name || item.channelName)))) candidates.push(item);
    for (const [key, value] of Object.entries(item)) {
      if (!/user|power|token|cookie|session|sid/i.test(key) && value && typeof value === 'object' && !Array.isArray(value)) queue.push(value);
    }
  }
  const meta = candidates.find(x => x?.liveId && x?.channelId) || candidates.find(x => x?.liveId && x?.id) || topic;
  const channelId = String(meta.channelId || (meta !== topic ? meta.id : '') || '');
  return { channelId, liveId: String(meta.liveId || ''), title: cleanTitle(meta.channelName || meta.name || meta.title || meta.topic, '千聊课程'), topic, isLogin: video.isLogin };
}

function buildTasks(rows) {
  const chapters = new Map(rows.filter(r => r.businessType === 'chapter').map(r => [String(r.businessId), cleanTitle(r.businessName, '课程章节')]));
  const seen = new Set();
  // QLChat uses `normal` and `ppt` for video/live lessons as well as the
  // newer videoGraphic/video styles. Only the known audio-only styles are
  // omitted; an unknown style is retained and resolved through the media API
  // instead of silently disappearing from an "all lessons" batch.
  const audioStyles = new Set(['audio', 'audiographic', 'audiolive']);
  return rows.filter(r => r.businessType === 'topic' && !audioStyles.has(String(r.topicPo?.style || '').toLowerCase()))
    .filter(r => /^\d+$/.test(String(r.businessId)) && !seen.has(String(r.businessId)) && seen.add(String(r.businessId)))
    .map((r, index) => ({ id: String(r.businessId), title: cleanTitle(r.businessName || r.topicPo?.topic, `第 ${index + 1} 节`), chapter: chapters.get(String(r.chapterId)) || '课程视频', index: index + 1, duration: Number(r.topicPo?.duration) || undefined }));
}

function normalizeStudyCourse(row) {
  if (!row || typeof row !== 'object') throw new QlchatError('课程列表格式发生变化，请更新下载器后重试。');
  const originalId = row.bussinessId;
  const id = String(originalId ?? '');
  if (!/^\d{5,24}$/.test(id) || (typeof originalId === 'number' && !Number.isSafeInteger(originalId))) {
    throw new QlchatError('课程列表中的课程编号无效，尚未同步完整。');
  }
  const type = String(row.type || row.purchaseType || '');
  const special = (row.system && row.system !== 'QLCHAT') || row.isCamp === 'Y' || row.isNewCamp === 'Y' || !['channel', 'topic'].includes(type) || ['camp', 'new_book', 'book', 'activity', 'liveCamp', 'small_course'].includes(row.purchaseType);
  const kind = special ? 'unsupported' : type;
  const url = kind === 'channel' ? `${ORIGIN}/wechat/page/channel-intro?channelId=${id}` : kind === 'topic' ? `${ORIGIN}/wechat/page/topic-simple-video?topicId=${id}` : null;
  const course = { id, title: cleanTitle(row.title || row.topicName, '未命名课程'), kind, supported: !special, courseType: type, source: 'purchased', url };
  if (/^\d{5,24}$/.test(String(row.liveId || ''))) course.liveId = String(row.liveId);
  if (Number.isFinite(Number(row.topicCount)) && Number(row.topicCount) >= 0) course.courseCount = Math.floor(Number(row.topicCount));
  return course;
}

function normalizeRecentCourse(row) {
  if (!row || typeof row !== 'object') throw new QlchatError('最近学习格式发生变化，请更新下载器后重试。');
  const rawId = row.topicId || row.bussinessId;
  const id = String(rawId ?? '');
  if (!/^\d{5,24}$/.test(id) || (typeof rawId === 'number' && !Number.isSafeInteger(rawId))) {
    throw new QlchatError('最近学习中的课程编号无效，尚未同步完整。');
  }
  const type = String(row.courseType || row.topicType || 'topic');
  const supported = type === 'topic' && String(row.system || 'QLCHAT') === 'QLCHAT';
  const course = {
    id,
    title: cleanTitle(row.skuTitle || row.topicName || row.title, '未命名最近学习'),
    kind: supported ? 'topic' : 'unsupported',
    supported,
    courseType: type,
    source: 'recent',
    url: supported ? `${ORIGIN}/wechat/page/topic-simple-video?topicId=${id}` : null,
  };
  if (/^\d{5,24}$/.test(String(row.liveId || ''))) course.liveId = String(row.liveId);
  if (Number.isFinite(Number(row.duration)) && Number(row.duration) > 0) course.duration = Number(row.duration);
  if (Number.isFinite(Number(row.joinTime))) course.joinTime = Number(row.joinTime);
  return course;
}

function decodePlayUrl(encoded) {
  let value = String(encoded || '');
  if (!/^https:\/\//i.test(value)) {
    try {
      // Same URL envelope as the official web player; this does not decrypt media.
      const decoder = crypto.createDecipheriv('aes-256-cbc', Buffer.from('711AAB17E204816B783374025FD08DE8'), Buffer.from('0102030405060708'));
      value = Buffer.concat([decoder.update(Buffer.from(value, 'base64')), decoder.final()]).toString('utf8');
    } catch { throw new QlchatError('千聊播放地址格式发生变化，请更新下载器后重试。'); }
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new QlchatError('课程没有返回有效的视频地址。'); }
  if (parsed.protocol !== 'https:' || !/\.(?:m3u8|mp4)$/i.test(parsed.pathname) || !isMediaHost(parsed.hostname)) {
    throw new QlchatError('该课程的视频地址格式暂不支持。');
  }
  return parsed.href;
}

function isMediaHost(host) {
  return ['vod-qcloud.com', 'myqcloud.com', 'qcloud.com', 'qianliaowang.com', 'qlchat.com', 'aliyuncs.com', 'tlivesource.com'].some(domain => host === domain || host.endsWith('.' + domain));
}

class QlchatClient {
  constructor({ fetchImpl, onLog = () => {}, requestTimeoutMs = 40000 }) {
    this.fetchImpl = fetchImpl;
    this.onLog = onLog;
    this.requestTimeoutMs = requestTimeoutMs;
    this.meta = null;
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    let timedOut = false;
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => { rejectAborted = reject; });
    const onAbort = () => {
      const error = new QlchatError(timedOut ? '连接千聊超时，请检查网络后重试。' : '已取消当前操作。');
      error.reasonCode = timedOut ? 'REQUEST_TIMEOUT' : 'CANCELLED';
      rejectAborted(error);
    };
    const onExternalAbort = () => controller.abort();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.requestTimeoutMs);
    try {
      return await Promise.race([aborted, (async () => {
        if (controller.signal.aborted) return aborted;
        const response = await this.fetchImpl(url, { ...options, signal: controller.signal, credentials: 'include', headers: { 'User-Agent': USER_AGENT, Referer: `${ORIGIN}/`, ...options.headers } });
        if (!response.ok) throw new QlchatError(`千聊服务返回 HTTP ${response.status}，请稍后重试。`);
        if (response.url && new URL(response.url).pathname.includes('/login')) throw new QlchatError('请先在登录窗口完成千聊登录，然后重新读取课程。');
        // Consume the body before releasing the timeout. A server may send headers
        // successfully and then stall indefinitely while streaming HTML or JSON.
        const text = await response.text();
        // Electron session.fetch can omit response.url even after a login redirect.
        // The official legacy sign-in page has no __INIT_STATE__ and this root class.
        if (!text.includes('window.__INIT_STATE__') && /<[^>]+class=["'][^"']*\blogin-page\b/.test(text)) {
          throw new QlchatError('请先在登录窗口完成千聊登录，然后重新同步我的课程。', 'LOGIN_REQUIRED');
        }
        if (controller.signal.aborted) return aborted;
        return { ok: response.ok, status: response.status, url: response.url, headers: response.headers,
          text: async () => text, json: async () => JSON.parse(text) };
      })()]);
    } catch (error) {
      if (options.signal?.aborted || error.reasonCode === 'CANCELLED') {
        const cancelled = new QlchatError('已取消当前操作。');
        cancelled.reasonCode = 'CANCELLED';
        throw cancelled;
      }
      if (timedOut || error.reasonCode === 'REQUEST_TIMEOUT') throw new QlchatError('连接千聊超时，请检查网络后重试。');
      if (error instanceof QlchatError) throw error;
      throw new QlchatError('连接千聊失败，请检查网络后重试。');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async api(endpoint, body, params, options = {}) {
    const url = new URL(endpoint, ORIGIN);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await this.request(url.href, body ? { ...options, method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify(body) } : options);
    let payload;
    try { payload = await response.json(); } catch { throw new QlchatError('课程接口没有返回数据，请重新登录千聊。'); }
    if (Number(payload.state?.code) !== 0) {
      const code = payload.state?.code;
      throw new QlchatError(`课程访问未通过（${String(code ?? '未知').replace(/[^\d-]/g, '').slice(0, 10) || '未知'}），请确认已登录且账号拥有该课程的播放权限。`);
    }
    return payload.data;
  }

  async getStudyCourses(input = STUDY_URL, options = {}) {
    const url = studyUrl(input);
    this.onLog('正在确认千聊学习页登录状态…');
    const response = await this.request(url, options);
    const initialState = parseInitialState(await response.text());
    if (!initialState) throw new QlchatError('请先在登录窗口完成千聊登录，再同步我的课程。', 'LOGIN_REQUIRED');
    const purchased = await this.getPurchasedCourses(options);
    const recent = await this.getRecentCourses(options);
    const courses = [], byKey = new Map();
    for (const course of [...purchased, ...recent]) {
      const key = `${course.kind}:${course.id}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.sources = [...new Set([...(existing.sources || [existing.source]), course.source])];
        existing.source = existing.sources.length > 1 ? 'both' : existing.sources[0];
        continue;
      }
      const merged = { ...course, sources: [course.source] };
      byKey.set(key, merged);
      courses.push(merged);
    }
    return { courses, complete: true, unsupportedCount: courses.filter(c => !c.supported).length };
  }

  async getPurchasedCourses(options = {}) {
    const courses = [], seen = new Set();
    const size = 10;
    for (let page = 1; page <= 200; page++) {
      const data = await this.api('/api/wechat/transfer/h5/live/purchaseCourse', {
        only: null, purchaseTypeList: 'all', type: 'all', page: { page, size }, pageSize: size,
      }, undefined, options);
      if (!data || !Object.prototype.hasOwnProperty.call(data, 'list') || (data.list !== null && !Array.isArray(data.list))) {
        throw new QlchatError('我的课程返回格式发生变化，尚未同步完整，请稍后重试。');
      }
      const list = data.list || [];
      let added = 0;
      for (const row of list) {
        const course = normalizeStudyCourse(row);
        const key = `${course.courseType}:${course.id}`;
        if (!seen.has(key)) { seen.add(key); courses.push(course); added++; }
      }
      this.onLog(`正在同步我的课程：已读取 ${courses.length} 门…`);
      // The official purchased-course view uses page length. nextPage can be
      // false even for a full page, so fetch again rather than truncating it.
      const hasMore = data.nextPage === true || list.length >= size;
      if (hasMore && !added) throw new QlchatError('课程列表分页异常，尚未同步完整，请重新同步。');
      if (!hasMore) return courses;
    }
    throw new QlchatError('课程列表分页过多，尚未同步完整，请稍后重试。');
  }

  async getRecentCourses(options = {}) {
    const courses = [], seen = new Set();
    const size = 10;
    let time = 0;
    for (let page = 1; page <= 200; page++) {
      const data = await this.api('/api/wechat/transfer/h5/topic/listRecentLearn', {
        time,
        page: { page, size },
        beforeOrAfter: 'before',
        type: 'all',
        pageSize: size,
      }, undefined, options);
      if (!data || !Object.prototype.hasOwnProperty.call(data, 'learningList') || !Array.isArray(data.learningList)) {
        throw new QlchatError('最近学习返回格式发生变化，尚未同步完整，请稍后重试。');
      }
      const list = data.learningList;
      let added = 0;
      for (const row of list) {
        const course = normalizeRecentCourse(row);
        const key = `${course.kind}:${course.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        courses.push(course);
        added++;
      }
      this.onLog(`正在同步最近学习：已读取 ${courses.length} 门…`);
      if (typeof data.nextPage !== 'boolean') throw new QlchatError('最近学习分页信息格式发生变化，尚未同步完整，请稍后重试。');
      const next = list.at(-1)?.joinTime || list.at(-1)?.time || 0;
      const hasMore = data.nextPage;
      if (hasMore && (!added || !Number.isFinite(Number(next)) || Number(next) <= 0)) throw new QlchatError('最近学习分页异常，尚未同步完整，请重新同步。');
      if (!hasMore) return courses;
      time = Number(next);
    }
    throw new QlchatError('最近学习分页过多，尚未同步完整，请稍后重试。');
  }

  async getCourse(input, options = {}) {
    const url = courseUrl(input);
    this.onLog('正在读取课程信息…');
    const response = await this.request(url, options);
    const state = parseInitialState(await response.text());
    if (!state) throw new QlchatError('页面中没有课程信息，请先登录并确认该链接能够播放。');
    const meta = findCourseMetadata(state);
    if (meta.isLogin === false) throw new QlchatError('请先在登录窗口扫码登录，再点击读取课程。');
    meta.channelId ||= new URL(url).searchParams.get('channelId') || '';
    let tasks = [];
    let catalogTopicCount = 0;
    if (meta.channelId && meta.liveId) {
      const rows = [], seenRows = new Set();
      let ended = false;
      for (let page = 1; page <= 200; page++) {
        const data = await this.api('/api/wechat/transfer/h5/interact/getCourseList', { channelId: meta.channelId, sort: 'asc', liveId: meta.liveId, page: { page, size: 20 } }, undefined, options);
        const list = data?.dataList || [];
        let added = 0;
        for (const row of list) {
          const identity = `${row.businessType}:${row.businessId}`;
          if (!seenRows.has(identity)) { rows.push(row); seenRows.add(identity); added++; }
        }
        this.onLog(`正在读取目录：已获取 ${rows.filter(r => r.businessType === 'topic').length} 节…`);
        if (list.length >= 20 && !added) throw new QlchatError('课程目录分页异常，尚未读取完整，请稍后重新读取。');
        if (list.length < 20) { ended = true; break; }
      }
      if (!ended) throw new QlchatError('课程目录过大或分页异常，请使用单节课程链接。');
      catalogTopicCount = rows.filter(r => r.businessType === 'topic').length;
      tasks = buildTasks(rows);
    }
    if (!tasks.length && meta.topic.id) {
      catalogTopicCount = 1;
      tasks = [{ id: String(meta.topic.id), title: cleanTitle(meta.topic.topic, '课程视频'), chapter: '课程视频', index: 1, duration: Number(meta.topic.duration) || undefined }];
    }
    if (!tasks.length) throw new QlchatError('没有找到视频课程，请尝试打开任意一节后复制该视频链接。');
    this.meta = meta;
    return { title: meta.title, channelId: meta.channelId, tasks, catalogTopicCount, skippedTopicCount: Math.max(0, catalogTopicCount - tasks.length) };
  }

  async resolveMedia(task, options = {}) {
    const data = await this.api('/api/wechat/topic/getMediaActualUrl', { topicId: String(task.id) }, undefined, options);
    const videos = (data?.video || []).filter(v => v.playUrl).sort((a, b) => Number(b.resolution || b.height || 0) - Number(a.resolution || a.height || 0));
    if (!videos.length) throw new QlchatError('当前账号无法获取这节视频，请确认已购课且能够在线播放。');
    const chosen = videos[0];
    return { url: decodePlayUrl(chosen.playUrl), duration: Number(chosen.duration) || task.duration, width: Number(chosen.width), height: Number(chosen.height) };
  }
}

module.exports = { QlchatError, ORIGIN, USER_AGENT, STUDY_URL, courseUrl, studyUrl, loginUrl, parseInitialState, findCourseMetadata, buildTasks, normalizeStudyCourse, normalizeRecentCourse, decodePlayUrl, isMediaHost, QlchatClient };
