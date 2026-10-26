'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { QlchatClient, courseUrl, loginUrl, STUDY_URL, QlchatError, ORIGIN, USER_AGENT } = require('./core/qlchat');
const { DownloadManager } = require('./core/download');
const { QlchatLicense } = require('./core/license');
const { atomicWriteFile } = require('./core/storage');

app.setName('千聊下载器');
app.commandLine.appendSwitch('force-renderer-accessibility');
app.setPath('userData', path.join(app.getPath('appData'), 'QlchatDownloader'));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

let mainWindow, loginWindow, client, manager, qlSession, license;
let outputDir, course = null, parsing = false;
let activeBatchPromise = null, exitPending = false, exitAllowed = false;
const allowedOutputDirs = new Set();
const tasksById = new Map();
let courseLibrary = [];
let studyCourses = [], studySyncedAt = null;

function status(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qlchat:status', payload);
}

function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame?.url?.startsWith('file:')) throw new Error('无效的窗口请求。');
}

function isLoginNavigation(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['qlchat.com', 'qianliaowang.com', 'qq.com', 'weixin.qq.com', 'douyin.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  } catch { return false; }
}

function openLogin(input) {
  let url = STUDY_URL;
  if (input?.trim()) url = loginUrl(input);
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (loginWindow.webContents.getURL() !== url && !loginWindow.webContents.getURL().includes('/page/login')) {
      loginWindow.loadURL(url).catch(() => status({ type: 'log', message: '千聊页面加载失败，请在登录窗口刷新或检查网络。' }));
    }
    loginWindow.show(); loginWindow.focus(); return { ok: true };
  }
  loginWindow = new BrowserWindow({ width: 1040, height: 800, minWidth: 760, minHeight: 620, title: '千聊登录 · 登录后回到下载器读取课程',
    autoHideMenuBar: true, icon: path.join(__dirname, '../assets/app.ico'),
    webPreferences: { partition: 'persist:qlchat-v1', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  loginWindow.webContents.setUserAgent(USER_AGENT);
  loginWindow.webContents.on('will-navigate', (event, target) => { if (!isLoginNavigation(target)) event.preventDefault(); });
  loginWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isLoginNavigation(target)) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: 'persist:qlchat-v1', contextIsolation: true, sandbox: true, nodeIntegration: false } } };
  });
  loginWindow.webContents.on('did-finish-load', () => {
    status({ type: 'log', message: '登录窗口已打开。完成登录后，回到下载器点击“读取课程”。' });
    // Use the site's own visible login control; credentials remain in its page.
    if (loginWindow.webContents.getURL().includes('/page/login')) loginWindow.webContents.executeJavaScript(`(() => { const items = [...document.querySelectorAll('li')]; const scan = items.find(el => el.textContent.trim() === '扫码登录'); if (scan) scan.click(); })()`).catch(() => {});
  });
  loginWindow.on('closed', () => { loginWindow = null; });
  loginWindow.loadURL(url).catch(() => status({ type: 'log', message: '千聊页面加载失败，请在登录窗口刷新或检查网络。' }));
  return { ok: true };
}

async function savePreferences() {
  const file = path.join(app.getPath('userData'), 'preferences.json');
  await atomicWriteFile(file, JSON.stringify({ outputDir }));
}

async function loadCourseLibrary() {
  try {
    const value = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'course-library.json'), 'utf8'));
    return Array.isArray(value) ? value.filter(item => item && typeof item.url === 'string').slice(0, 100) : [];
  } catch { return []; }
}

async function saveCourseLibrary() {
  const file = path.join(app.getPath('userData'), 'course-library.json');
  await atomicWriteFile(file, JSON.stringify(courseLibrary));
}

async function loadStudyCourses() {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'study-courses.json'), 'utf8'));
    if (!Array.isArray(saved.courses) || typeof saved.syncedAt !== 'string') return;
    const courses = saved.courses.filter(item => {
      try {
        if (!item || typeof item.title !== 'string' || !/^\d{5,24}$/.test(String(item.id))) return false;
        if (item.kind === 'unsupported' && item.supported === false && item.url === null) return true;
        return ['channel', 'topic'].includes(item.kind) && courseUrl(item.url) === item.url;
      } catch { return false; }
    });
    studyCourses = courses;
    studySyncedAt = saved.syncedAt;
  } catch { /* first sync or invalid prior cache */ }
}

async function syncStudyCourses(url) {
  if (manager.busy || parsing) return { ok: false, error: '请等待当前操作完成。' };
  parsing = true;
  try {
    const result = await client.getStudyCourses(url || STUDY_URL);
    if (!result || result.complete !== true || !Array.isArray(result.courses)) throw new QlchatError('课程列表尚未读取完整，请重新同步。');
    const syncedAt = new Date().toISOString();
    studyCourses = result.courses;
    studySyncedAt = syncedAt;
    await atomicWriteFile(path.join(app.getPath('userData'), 'study-courses.json'), JSON.stringify({ courses: studyCourses, syncedAt })).catch(error => status({ type: 'log', message: error.message }));
    status({ type: 'study', courses: studyCourses, syncedAt });
    return { ok: true, courses: studyCourses, syncedAt, complete: true };
  } catch (error) {
    const message = error.code === 'QLCHAT_CLIENT' ? error.message : '同步我的课程失败，请检查登录状态和网络后重试。';
    if (/登录/.test(message)) { try { openLogin(STUDY_URL); } catch { /* displayed error already explains sign-in */ } }
    return { ok: false, error: message };
  } finally { parsing = false; }
}

async function rememberCourse(url, value) {
  const entry = { url, title: value.title, channelId: value.channelId, tasks: value.tasks, taskCount: value.tasks.length, lastReadAt: new Date().toISOString() };
  courseLibrary = [entry, ...courseLibrary.filter(item => item.url !== url)].slice(0, 100);
  await saveCourseLibrary().catch(error => status({ type: 'log', message: error.message }));
  return entry;
}

function handle(name, callback) {
  ipcMain.handle('qlchat:' + name, async (event, args) => { trusted(event); return callback(args); });
}

async function stopAndExit() {
  if (exitPending) return;
  exitPending = true;
  manager?.cancel();
  // FFmpeg must exit and the engine must finish deleting its partial file
  // before Electron's event loop and filesystem handles are shut down.
  if (activeBatchPromise) await activeBatchPromise.catch(() => {});
  exitAllowed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else app.quit();
}

async function createMainWindow() {
  outputDir = path.join(app.getPath('downloads'), '千聊课程');
  courseLibrary = await loadCourseLibrary();
  await loadStudyCourses();
  try {
    const prefs = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'preferences.json'), 'utf8'));
    if (typeof prefs.outputDir === 'string' && path.isAbsolute(prefs.outputDir)) outputDir = prefs.outputDir;
  } catch { /* first launch */ }
  allowedOutputDirs.add(path.resolve(outputDir));
  qlSession = session.fromPartition('persist:qlchat-v1');
  qlSession.setUserAgent(USER_AGENT);
  client = new QlchatClient({ fetchImpl: (url, options) => qlSession.fetch(url, options), onLog: message => status({ type: 'log', message }) });
  license = new QlchatLicense({ storageDir: app.getPath('userData'), safeStorage: require('electron').safeStorage });
  manager = new DownloadManager({ ffmpegPath: app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg.exe') : path.join(__dirname, '../assets/ffmpeg.exe'), resolveMedia: (task, options) => client.resolveMedia(task, options), fetchManifest: async (url, { signal } = {}) => {
    const reply = await qlSession.fetch(url, { headers: { Referer: ORIGIN + '/', 'User-Agent': USER_AGENT }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40000)]) : AbortSignal.timeout(40000) });
    if (!reply.ok) throw new Error('视频清单暂时无法访问，请稍后重试。');
    return reply.text();
  } });
  manager.on('progress', payload => status({ type: 'progress', ...payload }));
  manager.on('log', message => status({ type: 'log', message }));

  handle('get-initial-state', () => ({ outputDir, version: app.getVersion(), courses: courseLibrary, license: license.state, studyCourses, studySyncedAt }));
  handle('sync-study-courses', ({ url } = {}) => syncStudyCourses(url));
  handle('get-license-state', () => license.authorize());
  handle('activate-license', async ({ order } = {}) => {
    try {
      const value = await license.activate(order);
      status({ type: 'license', ...value });
      return { ok: true, ...value };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  handle('clear-license', () => license.clear());
  handle('remove-course', async ({ url } = {}) => {
    courseLibrary = courseLibrary.filter(item => item.url !== url);
    await saveCourseLibrary().catch(error => status({ type: 'log', message: error.message }));
    status({ type: 'library', courses: courseLibrary });
    return { ok: true, courses: courseLibrary };
  });
  handle('select-output-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择千聊课程保存文件夹', defaultPath: outputDir, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    outputDir = result.filePaths[0];
    allowedOutputDirs.add(path.resolve(outputDir));
    await savePreferences().catch(error => status({ type: 'log', message: error.message }));
    return outputDir;
  });
  handle('open-login', ({ url } = {}) => {
    try { return openLogin(url); } catch (error) { return { ok: false, error: error.message }; }
  });
  handle('parse-course', async ({ url } = {}) => {
    if (manager.busy || parsing) return { ok: false, error: '请等待当前操作完成。' };
    parsing = true;
    try {
      const parsed = await client.getCourse(url);
      course = parsed;
      const canonical = courseUrl(url);
      await rememberCourse(canonical, parsed);
      status({ type: 'library', courses: courseLibrary });
      tasksById.clear();
      course.tasks.forEach(task => tasksById.set(task.id, task));
      status({ type: 'course', course });
      return { ok: true, course };
    } catch (error) {
      if (/登录/.test(error.message)) { try { openLogin(url); } catch { /* invalid URL already explained */ } }
      return { ok: false, error: error.message };
    } finally { parsing = false; }
  });
  handle('start-download', async ({ tasks, outputDir: chosenDir } = {}) => {
    const auth = await license.authorize();
    if (!auth.authorized) return { ok: false, error: `下载前需要激活订单授权：${auth.detail}` };
    if (manager.busy || parsing) return { ok: false, error: '当前已有操作进行中。' };
    if (!Array.isArray(tasks) || !tasks.length || !course) return { ok: false, error: '请先读取课程并选择要下载的视频。' };
    const selected = [...new Set(tasks.map(task => String(task.id)))].map(id => tasksById.get(id));
    if (selected.some(task => !task)) return { ok: false, error: '目录已变化，请重新读取课程后选择。' };
    if (typeof chosenDir !== 'string' || !allowedOutputDirs.has(path.resolve(chosenDir))) return { ok: false, error: '请通过“选择文件夹”设置保存位置。' };
    status({ type: 'batch', running: true });
    activeBatchPromise = manager.start({ tasks: selected, outputDir: chosenDir, courseTitle: course.title }).then(result => {
      status({ type: 'batch', running: false, completed: result.completed, failed: result.failed, cancelled: result.cancelled });
    }).catch(() => {
      status({ type: 'log', message: '下载未完成，请检查保存位置和网络后重试。' });
      status({ type: 'batch', running: false });
    }).finally(() => { activeBatchPromise = null; });
    return { ok: true };
  });
  handle('cancel-download', () => { manager.cancel(); return { ok: true }; });
  handle('open-output', async ({ path: selectedPath } = {}) => {
    const target = typeof selectedPath === 'string' ? path.resolve(selectedPath) : path.resolve(outputDir);
    if (!allowedOutputDirs.has(target)) return { ok: false, error: '请使用已选择的下载文件夹。' };
    await fs.mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    return error ? { ok: false, error: '无法打开文件夹，请在资源管理器中手动打开。' } : { ok: true };
  });

  mainWindow = new BrowserWindow({ width: 1220, height: 840, minWidth: 860, minHeight: 650, title: '千聊下载器', backgroundColor: '#f7f5ef', autoHideMenuBar: true,
    icon: path.join(__dirname, '../assets/app.ico'), webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.on('close', event => {
    if (exitAllowed) return;
    if (exitPending) { event.preventDefault(); return; }
    if (manager.busy || activeBatchPromise) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['继续下载', '停止并退出'], defaultId: 0, cancelId: 0, title: '正在下载课程', message: '退出会停止当前下载，已完成的视频会保留。' });
      if (choice === 0) return;
      void stopAndExit();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close(); app.quit(); });
  await mainWindow.loadFile(path.join(__dirname, 'index.html'));
  status({ type: 'license', ...(await license.authorize()) });
  status({ type: 'library', courses: courseLibrary });
}

app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
app.whenReady().then(() => { if (singleInstance) return createMainWindow(); }).catch(() => {
  dialog.showErrorBox('千聊下载器启动失败', '程序资源不完整，请重新安装千聊下载器。'); app.quit();
});
app.on('before-quit', event => {
  if (exitAllowed || (!manager?.busy && !activeBatchPromise)) return;
  event.preventDefault();
  if (exitPending) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else void stopAndExit();
});
app.on('window-all-closed', () => app.quit());
