'use strict';

(() => {
  const api = window.qlchat;
  const $ = (id) => document.getElementById(id);
  const state = {
    course: null,
    selected: new Set(),
    taskStates: new Map(),
    taskElements: new Map(),
    chapterElements: [],
    outputDir: '',
    parsing: false,
    running: false,
    openingLogin: false,
    stopping: false,
    collapsed: false,
    batchIds: [],
    batchFinished: false,
    authorized: false,
    courses: [],
    licenseBusy: false,
    studyCourses: [],
    studySyncedAt: null,
    studyLoaded: false,
    view: 'course',
  };
  const studyUrl = 'https://h5.qlchat.com/wechat/page/mine/study';
  let toastTimer;
  const statusLabels = {
    pending: '待下载', resolving: '解析中', downloading: '下载中',
    verifying: '检查中', completed: '已完成', failed: '失败', cancelled: '已停止',
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = String(message || '操作未完成，请重试。');
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5200);
  }

  function setSourceStatus(message, type = 'neutral') {
    $('source-status-text').textContent = message;
    $('source-status').className = `notice notice-${type}`;
  }

  function addLog(message, error = false) {
    if (!message) return;
    const container = $('log-content');
    const nearBottom = container.scrollHeight - container.clientHeight - container.scrollTop < 35;
    container.querySelector('.log-placeholder')?.remove();
    const line = element('p', error ? 'log-error' : '');
    line.append(element('span', 'log-time', new Date().toLocaleTimeString('zh-CN', { hour12: false })), document.createTextNode(String(message)));
    container.append(line);
    while (container.children.length > 250) container.firstElementChild.remove();
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '';
    const total = Math.round(Number(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function getInputUrl() {
    const text = $('course-url').value.trim();
    if (!text) throw new Error('请先粘贴千聊课程链接。');
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    if (!match) throw new Error('没有找到有效链接，请粘贴完整的千聊分享链接。');
    const url = new URL(match[0]);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'qlchat.com' || host.endsWith('.qlchat.com') || host === 'qianliao.cn' || host.endsWith('.qianliao.cn'))) {
      throw new Error('请使用千聊提供的 HTTPS 课程分享链接。');
    }
    return url.href;
  }

  function isStudyPage(url) {
    try { return new URL(url).pathname.replace(/\/$/, '') === '/wechat/page/mine/study'; } catch { return false; }
  }

  function refreshControls() {
    const tasks = state.course?.tasks || [];
    const locked = state.parsing || state.running;
    $('parse-button').disabled = locked;
    $('login-button').disabled = locked || state.openingLogin;
    $('course-url').disabled = locked;
    $('parse-button').firstChild.textContent = state.parsing ? '正在读取…' : '读取课程';
    if (!state.parsing && isStudyPage($('course-url').value.trim())) $('parse-button').firstChild.textContent = '同步学习列表';
    $('sync-study-button').disabled = locked;
    $('sync-all-study-button').disabled = locked;
    $('refresh-study-button').disabled = locked;
    $('show-study-button').disabled = locked;
    $('show-study-button').hidden = !state.studyLoaded;
    for (const button of document.querySelectorAll('.study-course-open')) button.disabled = locked || button.dataset.supported === 'false';
    $('choose-output-button').disabled = state.running;
    $('open-output-button').disabled = !state.outputDir;
    $('download-button').disabled = locked || state.view === 'study' || !state.authorized || !state.selected.size || !state.outputDir;
    const allSelected = tasks.length > 0 && state.selected.size === tasks.length;
    const hasNonVideo = tasks.some(task => task.mediaKind && task.mediaKind !== 'video');
    $('download-button-label').textContent = state.running ? '正在保存课程…' : allSelected ? hasNonVideo ? '下载全部课程内容' : '下载全部视频课程' : '下载所选课程';
    $('catalog-download-button').disabled = $('download-button').disabled;
    $('catalog-download-button').textContent = $('download-button-label').textContent;
    $('cancel-button').hidden = !state.running;
    $('cancel-button').disabled = state.stopping;
    $('cancel-button').textContent = state.stopping ? '正在停止…' : '停止下载';
    $('selected-count').textContent = String(state.selected.size);
    $('selected-badge').textContent = state.running ? '下载进行中' : state.selected.size ? `共 ${tasks.length} 节` : '尚未选择';
    $('selection-note').textContent = state.running ? '可在右侧查看进度，完成后自动保存。' : tasks.length ? '已选课时将依次保存到指定文件夹。' : '读取课程后，在右侧勾选需要的课时。';
    $('select-all').disabled = locked || !tasks.length;
    $('select-all').checked = tasks.length > 0 && state.selected.size === tasks.length;
    $('select-all').indeterminate = state.selected.size > 0 && state.selected.size < tasks.length;
    $('clear-selection-button').disabled = locked || !state.selected.size;
    for (const record of state.taskElements.values()) {
      record.checkbox.disabled = locked;
      record.checkbox.checked = state.selected.has(record.task.id);
      record.row.classList.toggle('selected', record.checkbox.checked);
    }
    for (const group of state.chapterElements) {
      const count = group.ids.filter((id) => state.selected.has(id)).length;
      group.checkbox.disabled = locked;
      group.checkbox.checked = count === group.ids.length;
      group.checkbox.indeterminate = count > 0 && count < group.ids.length;
    }
  }

  function renderStudyCourses() {
    const list = $('study-course-list');
    list.replaceChildren();
    const query = $('study-search').value.trim().toLocaleLowerCase();
    const sourceFilter = $('study-source-filter').value;
    const visible = state.studyCourses.filter(item => {
      const sources = Array.isArray(item.sources) ? item.sources : item.source === 'both' ? ['purchased', 'recent'] : [item.source || 'purchased'];
      const matchesSource = sourceFilter === 'both' || sources.includes(sourceFilter);
      return matchesSource && `${item.title || ''} ${item.liveName || ''}`.toLocaleLowerCase().includes(query);
    });
    $('course-count').textContent = `${visible.length} / ${state.studyCourses.length} 项`;
    for (const course of visible) {
      const card = element('article', 'study-course-card');
      card.append(element('h3', '', course.title || '未命名课程'));
      const supported = course.supported !== false && ['channel', 'topic'].includes(course.kind) && typeof course.url === 'string';
      const sources = Array.isArray(course.sources) ? course.sources : [course.source];
      const sourceLabel = sources.includes('purchased') && sources.includes('recent') ? '我的课程 · 最近学习' : sources.includes('recent') ? '最近学习' : '我的课程';
      const details = [sourceLabel, course.kind === 'channel' ? '系列课程' : course.kind === 'topic' ? '单节课程' : '特殊课程'];
      if (course.liveName) details.push(course.liveName);
      if (Number(course.courseCount) > 0) details.push(`${Number(course.courseCount)} 节`);
      card.append(element('p', 'study-course-meta', details.join(' · ')));
      const button = element('button', 'button button-secondary study-course-open', supported ? '读取目录' : '暂不支持此类型');
      button.type = 'button';
      button.dataset.supported = String(supported);
      button.disabled = state.parsing || state.running || !supported;
      button.addEventListener('click', () => {
        if (state.parsing || state.running || !supported) return;
        $('course-url').value = course.url;
        $('parse-button').click();
      });
      card.append(button);
      list.append(card);
    }
    $('study-list-empty').hidden = visible.length > 0;
    $('study-list-empty').textContent = state.studyCourses.length ? '没有找到匹配的课程，请修改搜索词。' : '当前账号没有可显示的课程。请确认登录渠道，或重新同步。';
  }

  function showStudyCourses() {
    if (state.running) return;
    state.view = 'study';
    $('course-title').textContent = '我的学习';
    $('course-subtitle').textContent = '同时收录“我的课程”和“最近学习”，选择课程后读取章节目录。';
    $('course-count').textContent = `${state.studyCourses.length} 门课程`;
    $('course-count').hidden = false;
    $('catalog-toolbar').hidden = true;
    $('empty-state').hidden = true;
    $('chapter-list').hidden = true;
    $('batch-summary').hidden = true;
    $('study-courses').hidden = false;
    let date = state.studySyncedAt ? new Date(state.studySyncedAt) : null;
    const when = date && !Number.isNaN(date.getTime()) ? `上次同步：${date.toLocaleString('zh-CN', { hour12: false })}。` : '';
    $('study-cache-note').textContent = `${when}切换账号或购买新课程后请重新同步。`;
    renderStudyCourses();
    refreshControls();
  }

  function setStudyCourses(courses, syncedAt) {
    const seen = new Set();
    state.studyCourses = (Array.isArray(courses) ? courses : []).filter(item => item && typeof item.title === 'string' && (typeof item.url === 'string' || item.kind === 'unsupported')).filter(item => {
      const key = `${item.courseType || item.kind}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    state.studySyncedAt = syncedAt || null;
    state.studyLoaded = true;
    showStudyCourses();
  }

  async function syncStudy() {
    if (state.parsing || state.running) return;
    state.parsing = true;
    refreshControls();
    setSourceStatus('正在同步千聊账号的课程列表…', 'busy');
    addLog('正在同步我的课程和最近学习…');
    try {
      const result = await api.syncStudyCourses({ url: studyUrl });
      if (!result?.ok || result.complete !== true) throw new Error(result?.error || '课程列表未完整同步，请重试。');
      setStudyCourses(result.courses, result.syncedAt);
      setSourceStatus(`已同步 ${state.studyCourses.length} 项课程和学习记录，选择后读取目录。`, 'success');
      addLog(`我的课程和最近学习同步完成，合并后共 ${state.studyCourses.length} 项。`);
    } catch (error) {
      setSourceStatus(error.message, 'error'); addLog(error.message, true); showToast(error.message);
    } finally { state.parsing = false; refreshControls(); }
  }

  async function syncAllStudy() {
    if (state.parsing || state.running) return;
    state.parsing = true;
    refreshControls();
    setSourceStatus('正在展开全部专栏并整理学习内容…', 'busy');
    addLog('正在读取全部已购专栏和最近学习课时…');
    try {
      const result = await api.syncAllStudyCourses();
      if (!result?.ok || !result.course?.tasks?.length) throw new Error(result?.error || '全部学习内容未完整读取，请重试。');
      setCourse(result.course);
      const failed = Array.isArray(result.failedCourses) ? result.failedCourses.length : 0;
      setSourceStatus(`已整理 ${result.course.tasks.length} 个课时，可一次批量处理${failed ? `；${failed} 个专栏需要单独重试` : ''}。`, failed ? 'error' : 'success');
      addLog(`全部学习内容整理完成，共 ${result.course.tasks.length} 个课时${failed ? `，${failed} 个专栏失败` : ''}。`);
    } catch (error) {
      setSourceStatus(error.message, 'error'); addLog(error.message, true); showToast(error.message);
    } finally { state.parsing = false; refreshControls(); }
  }

  function renderLicense(license) {
    const value = license || { authorized: false, detail: '尚未激活' };
    state.authorized = Boolean(value.authorized);
    const status = $('license-status');
    const text = $('license-status-text');
    text.textContent = value.authorized ? `${value.detail}${value.orderMask ? ` · ${value.orderMask}` : ''}` : value.detail;
    status.className = `notice ${value.authorized ? 'notice-success license-authorized' : 'notice-error license-error'}`;
    $('clear-license-button').hidden = !value.authorized;
    $('license-order').disabled = state.licenseBusy;
    $('activate-button').disabled = state.licenseBusy;
    $('activate-button').textContent = state.licenseBusy ? '正在验证…' : value.authorized ? '重新激活' : '激活下载权限';
    refreshControls();
  }

  function renderLibrary(courses) {
    state.courses = Array.isArray(courses) ? courses : [];
    const container = $('course-library-list');
    container.replaceChildren();
    if (!state.courses.length) { container.append(element('p', 'library-empty', '还没有已读取课程。')); return; }
    for (const course of state.courses) {
      const row = element('div', 'library-entry');
      const button = element('button', 'library-entry-copy');
      button.type = 'button';
      button.append(element('span', 'library-entry-title', course.title || '未命名课程'), element('span', 'library-entry-meta', `${course.taskCount || course.tasks?.length || 0} 节 · 点击重新读取`));
      button.addEventListener('click', async () => {
        $('course-url').value = course.url;
        $('parse-button').click();
      });
      const remove = element('button', 'library-entry-remove', '×');
      remove.type = 'button';
      remove.title = '从本机课程库移除';
      remove.addEventListener('click', async () => {
        await api.removeCourse({ url: course.url });
      });
      row.append(button, remove);
      container.append(row);
    }
  }

  function renderTask(task, index) {
    const row = element('div', 'task-row');
    row.dataset.taskId = task.id;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `选择 ${task.title}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(task.id); else state.selected.delete(task.id);
      refreshControls();
    });
    const order = element('span', 'task-order', String(task.index || index + 1).padStart(2, '0'));
    const copy = element('div', 'task-copy');
    const title = element('p', 'task-title', task.title || '未命名课时');
    const meta = element('p', 'task-meta');
    const typeLabels = { video: '视频课', audio: '音频课', document: '图文课' };
    const type = element('span', '', typeLabels[task.mediaKind] || '课程内容');
    const duration = element('span', '', formatDuration(task.duration));
    const detail = element('span', 'task-detail');
    meta.append(type, duration, detail);
    const progress = element('div', 'task-progress');
    progress.hidden = true;
    const progressFill = element('div');
    progress.append(progressFill);
    const error = element('p', 'task-error');
    error.hidden = true;
    copy.append(title, meta, progress, error);
    const status = element('span', 'task-status', '待下载');
    status.dataset.status = 'pending';
    row.append(checkbox, order, copy, status);
    state.taskElements.set(task.id, { row, checkbox, task, status, duration, detail, progress, progressFill, error });
    return row;
  }

  function setCourse(course) {
    if (!course || !Array.isArray(course.tasks)) return;
    const seen = new Set();
    const tasks = course.tasks.filter((task) => task && task.id != null).map((task, index) => ({ ...task, id: String(task.id), index: task.index || index + 1 })).filter((task) => { if (seen.has(task.id)) return false; seen.add(task.id); return true; });
    state.course = { ...course, tasks };
    state.view = 'course';
    state.collapsed = false;
    $('study-courses').hidden = true;
    state.selected = new Set(tasks.map((task) => task.id));
    state.taskStates.clear();
    state.taskElements.clear();
    state.chapterElements = [];
    state.batchIds = [];
    state.batchFinished = false;
    $('batch-summary').hidden = true;
    $('course-title').textContent = course.title || '千聊课程';
    const skipped = Number(course.skippedTopicCount) || 0;
    const failedCourses = Array.isArray(course.failedCourses) ? course.failedCourses.length : 0;
    const mediaCounts = { video: 0, audio: 0, document: 0 };
    for (const task of tasks) mediaCounts[['video', 'audio', 'document'].includes(task.mediaKind) ? task.mediaKind : 'video']++;
    const mediaSummary = [`视频 ${mediaCounts.video}`, `音频 ${mediaCounts.audio}`, `图文 ${mediaCounts.document}`].join(' · ');
    $('course-subtitle').textContent = tasks.length
      ? `${mediaSummary}。默认全选已整理课时，可按课程分类调整。${skipped ? `另有 ${skipped} 项特殊课程暂不支持。` : ''}${failedCourses ? `${failedCourses} 个专栏读取失败，请重新同步。` : ''}`
      : '暂未读取到可下载课时，请确认课程已发布并重新读取。';
    $('course-count').textContent = `${tasks.length} 节课程`;
    $('course-count').hidden = !tasks.length;
    $('catalog-toolbar').hidden = !tasks.length;
    $('empty-state').hidden = Boolean(tasks.length);
    $('chapter-list').hidden = !tasks.length;
    $('chapter-list').replaceChildren();
    const chapters = new Map();
    for (const task of tasks) {
      const name = task.chapter || '课程列表';
      if (!chapters.has(name)) chapters.set(name, []);
      chapters.get(name).push(task);
    }
    for (const [name, items] of chapters) {
      const chapter = element('section', state.collapsed ? 'chapter collapsed' : 'chapter');
      const header = element('div', 'chapter-header');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `选择全部 ${name}`);
      const ids = items.map((task) => task.id);
      checkbox.addEventListener('change', () => {
        for (const id of ids) { if (checkbox.checked) state.selected.add(id); else state.selected.delete(id); }
        refreshControls();
      });
      const button = element('button', 'chapter-title-button');
      button.type = 'button';
      button.setAttribute('aria-expanded', String(!state.collapsed));
      button.append(element('strong', '', name), element('span', 'chapter-size', `${items.length} 节`));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.classList.add('chapter-chevron');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', 'm4 6 4 4 4-4');
      svg.append(line);
      button.append(svg);
      button.addEventListener('click', () => {
        chapter.classList.toggle('collapsed');
        button.setAttribute('aria-expanded', String(!chapter.classList.contains('collapsed')));
      });
      header.append(checkbox, button);
      const rows = element('div', 'chapter-tasks');
      for (const task of items) rows.append(renderTask(task, tasks.indexOf(task)));
      chapter.append(header, rows);
      $('chapter-list').append(chapter);
      state.chapterElements.push({ checkbox, ids, chapter, button });
    }
    $('toggle-chapters-button').textContent = state.collapsed ? '展开章节' : '收起章节';
    refreshControls();
  }

  function updateTask(payload) {
    const id = String(payload.taskId);
    const old = state.taskStates.get(id) || {};
    const data = { ...old, ...payload, status: payload.status || old.status || 'pending' };
    state.taskStates.set(id, data);
    const record = state.taskElements.get(id);
    if (record) {
      const percent = Number.isFinite(Number(data.percent)) ? Math.max(0, Math.min(100, Number(data.percent))) : 0;
      record.status.dataset.status = data.status;
      record.status.textContent = data.status === 'downloading' ? `${Math.floor(percent)}%` : statusLabels[data.status] || data.status;
      record.progress.hidden = !['downloading', 'verifying', 'completed'].includes(data.status);
      record.progressFill.style.width = `${data.status === 'completed' ? 100 : percent}%`;
      const done = formatDuration(data.downloadedSeconds);
      const total = formatDuration(data.totalSeconds || record.task.duration);
      record.detail.textContent = data.status === 'downloading' && done ? `${done}${total ? ` / ${total}` : ''}` : data.status === 'verifying' ? '正在检查音视频' : data.status === 'completed' ? '已保存到本地' : '';
      record.error.hidden = !data.error;
      record.error.textContent = data.error || '';
      if (data.path) record.status.title = data.path;
      if (data.totalSeconds) record.duration.textContent = formatDuration(data.totalSeconds);
    }
    updateBatchSummary();
  }

  function updateBatchSummary() {
    const ids = state.batchIds;
    if (!ids.length) return;
    $('batch-summary').hidden = false;
    let completed = 0, failed = 0, cancelled = 0, progress = 0;
    for (const id of ids) {
      const task = state.taskStates.get(id) || {};
      if (task.status === 'completed') completed++;
      if (task.status === 'failed') failed++;
      if (task.status === 'cancelled') cancelled++;
      const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
      progress += terminal ? 100 : Math.min(99, Math.max(0, Number(task.percent) || 0));
    }
    const percent = Math.round(progress / ids.length);
    const finished = completed + failed + cancelled;
    $('overall-progress-fill').style.width = `${percent}%`;
    $('overall-progress').setAttribute('aria-valuenow', String(percent));
    $('batch-counts').textContent = `${finished} / ${ids.length} 节`;
    $('batch-status').textContent = state.stopping ? '正在停止下载' : state.running ? '正在保存课程' : failed ? '本次下载结束，部分课时需重试' : cancelled || finished < ids.length ? '下载已停止' : '所选课程已保存';
    const details = [`已完成 ${completed} 节`];
    if (failed) details.push(`失败 ${failed} 节`);
    if (cancelled) details.push(`已停止 ${cancelled} 节`);
    if (state.running && ids.length > finished) details.push(`剩余 ${ids.length - finished} 节`);
    $('batch-detail').textContent = details.join(' · ');
  }

  $('login-button').addEventListener('click', async () => {
    if (state.openingLogin || state.parsing || state.running) return;
    let url;
    try { url = $('course-url').value.trim() ? getInputUrl() : studyUrl; } catch (error) { setSourceStatus(error.message, 'error'); showToast(error.message); return; }
    state.openingLogin = true;
    refreshControls();
    setSourceStatus('正在打开千聊登录窗口…', 'busy');
    try {
      const result = await api.openLogin({ url });
      if (result && !result.ok) throw new Error(result.error || '登录窗口打开失败，请重试。');
      setSourceStatus('请在登录窗口完成登录，再点击「读取课程」。');
      addLog('已打开千聊窗口，请完成登录后读取课程。');
    } catch (error) { setSourceStatus(error.message, 'error'); addLog(error.message, true); }
    finally { state.openingLogin = false; refreshControls(); }
  });

  $('activate-button').addEventListener('click', async () => {
    if (state.licenseBusy) return;
    const order = $('license-order').value.trim();
    if (!order) { showToast('请输入订单号。'); return; }
    state.licenseBusy = true;
    renderLicense({ authorized: false, detail: '正在验证订单…' });
    try {
      const result = await api.activateLicense({ order });
      if (!result?.ok) throw new Error(result?.error || '订单授权失败。');
      $('license-order').value = '';
      renderLicense(result);
      addLog('订单授权成功，可以开始下载。');
    } catch (error) { renderLicense({ authorized: false, detail: error.message }); addLog(error.message, true); showToast(error.message); }
    finally { state.licenseBusy = false; renderLicense(await api.getLicenseState().catch(() => ({ authorized: false, detail: '授权状态读取失败' }))); }
  });
  $('clear-license-button').addEventListener('click', async () => {
    await api.clearLicense();
    renderLicense({ authorized: false, detail: '尚未激活' });
  });

  $('parse-button').addEventListener('click', async () => {
    if (state.parsing || state.running) return;
    let url;
    try { url = getInputUrl(); } catch (error) { setSourceStatus(error.message, 'error'); showToast(error.message); return; }
    if (isStudyPage(url)) { await syncStudy(); return; }
    state.parsing = true;
    refreshControls();
    setSourceStatus('正在读取课程信息和章节目录…', 'busy');
    addLog('正在读取千聊课程目录…');
    try {
      const result = await api.parseCourse({ url });
      if (!result?.ok) throw new Error(result?.error || '课程读取失败，请登录后重试。');
      if (result.course) setCourse(result.course);
      const count = state.course?.tasks?.length || 0;
      if (!count) throw new Error('暂未读取到课程目录，请确认当前链接可以正常听课。');
      setSourceStatus(`已读取 ${count} 节课，请选择需要保存的课时。`, 'success');
      addLog(`目录读取完成，共 ${count} 节课。`);
    } catch (error) { setSourceStatus(error.message, 'error'); addLog(error.message, true); showToast(error.message); }
    finally { state.parsing = false; refreshControls(); }
  });

  $('sync-study-button').addEventListener('click', syncStudy);
  $('sync-all-study-button').addEventListener('click', syncAllStudy);
  $('refresh-study-button').addEventListener('click', syncStudy);
  $('show-study-button').addEventListener('click', showStudyCourses);
  $('study-search').addEventListener('input', renderStudyCourses);
  $('study-source-filter').addEventListener('change', renderStudyCourses);
  $('course-url').addEventListener('input', refreshControls);

  $('choose-output-button').addEventListener('click', async () => {
    try {
      const result = await api.selectOutputDir();
      if (result) { state.outputDir = result; $('output-dir').value = result; $('output-dir').title = result; refreshControls(); }
    } catch { showToast('无法选择保存文件夹，请重试。'); }
  });
  $('open-output-button').addEventListener('click', async () => {
    if (!state.outputDir) return;
    try {
      const result = await api.openOutput({ path: state.outputDir });
      if (result?.ok === false) showToast(result.error || '无法打开保存文件夹。');
    } catch { showToast('无法打开保存文件夹，请确认路径仍然存在。'); }
  });
  $('select-all').addEventListener('change', () => {
    if (state.parsing || state.running) return;
    state.selected = $('select-all').checked ? new Set(state.course.tasks.map((task) => task.id)) : new Set();
    refreshControls();
  });
  $('clear-selection-button').addEventListener('click', () => { if (!state.running && !state.parsing) { state.selected.clear(); refreshControls(); } });
  $('toggle-chapters-button').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    for (const item of state.chapterElements) { item.chapter.classList.toggle('collapsed', state.collapsed); item.button.setAttribute('aria-expanded', String(!state.collapsed)); }
    $('toggle-chapters-button').textContent = state.collapsed ? '展开章节' : '收起章节';
  });
  $('log-toggle').addEventListener('click', () => {
    const expanded = $('log-toggle').getAttribute('aria-expanded') === 'true';
    $('log-toggle').setAttribute('aria-expanded', String(!expanded));
    $('log-content').hidden = expanded;
  });

  $('download-button').addEventListener('click', async () => {
    if (state.running || state.parsing || !state.course || !state.outputDir) return;
    const tasks = state.course.tasks.filter((task) => state.selected.has(task.id));
    if (!tasks.length) return;
    state.running = true;
    state.stopping = false;
    state.batchFinished = false;
    state.batchIds = tasks.map((task) => task.id);
    for (const task of tasks) updateTask({ taskId: task.id, status: 'pending', percent: 0, downloadedSeconds: 0, error: '', path: '' });
    refreshControls();
    updateBatchSummary();
    addLog(`开始保存 ${tasks.length} 节课程。`);
    try {
      const result = await api.startDownload({ tasks, outputDir: state.outputDir, courseTitle: state.course.title });
      if (!result?.ok) throw new Error(result?.error || '下载未能启动，请重试。');
    } catch (error) {
      state.running = false;
      state.stopping = false;
      addLog(error.message, true);
      showToast(error.message);
      refreshControls();
      updateBatchSummary();
    }
  });
  $('catalog-download-button').addEventListener('click', () => $('download-button').click());
  $('cancel-button').addEventListener('click', async () => {
    if (!state.running || state.stopping) return;
    state.stopping = true;
    refreshControls();
    updateBatchSummary();
    try { await api.cancelDownload(); }
    catch { state.stopping = false; refreshControls(); showToast('停止请求未完成，请重试。'); }
  });

  if (!api) {
    setSourceStatus('应用连接未就绪，请关闭并重新打开下载器。', 'error');
    for (const id of ['login-button', 'parse-button', 'choose-output-button', 'download-button']) $(id).disabled = true;
    return;
  }
  api.onStatus((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'log') addLog(event.message);
    else if (event.type === 'license') renderLicense(event);
    else if (event.type === 'library') renderLibrary(event.courses);
    else if (event.type === 'study' && !state.running) setStudyCourses(event.courses, event.syncedAt);
    else if (event.type === 'course' && !state.running) {
      setCourse(event.course);
      const failed = event.course?.failedCourses?.length || 0;
      setSourceStatus(`已整理 ${state.course?.tasks?.length || 0} 个课时并默认全选${failed ? `，${failed} 个专栏需重试` : '，可开始下载'}。`, failed ? 'error' : 'success');
    }
    else if (event.type === 'progress') updateTask(event);
    else if (event.type === 'batch') {
      state.running = Boolean(event.running);
      if (!state.running) {
        if (state.stopping) {
          for (const id of state.batchIds) {
            const task = state.taskStates.get(id) || {};
            if (!['completed', 'failed', 'cancelled'].includes(task.status)) updateTask({ taskId: id, status: 'cancelled' });
          }
        }
        state.stopping = false;
        if (!state.batchFinished && state.batchIds.length) {
          state.batchFinished = true;
          const completed = state.batchIds.filter((id) => state.taskStates.get(id)?.status === 'completed').length;
          const failed = state.batchIds.filter((id) => state.taskStates.get(id)?.status === 'failed').length;
          addLog(`本次下载结束：已保存 ${completed} 节${failed ? `，失败 ${failed} 节` : ''}。`);
        }
      }
      refreshControls();
      updateBatchSummary();
    }
  });
  api.getInitialState().then((initial) => {
    state.outputDir = initial?.outputDir || '';
    $('output-dir').value = state.outputDir;
    $('output-dir').title = state.outputDir;
    renderLibrary(initial?.courses || []);
    renderLicense(initial?.license || { authorized: false, detail: '尚未激活' });
    if (initial?.studySyncedAt) setStudyCourses(initial.studyCourses, initial.studySyncedAt);
    if (initial?.version) $('version').textContent = `v${initial.version}`;
    refreshControls();
  }).catch(() => { addLog('未能读取默认保存位置，请手动选择文件夹。', true); renderLibrary([]); renderLicense({ authorized: false, detail: '授权状态读取失败' }); });
})();
