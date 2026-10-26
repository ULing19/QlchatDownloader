'use strict';
// Runs against the downloader's own saved sign-in; reports no account details.
const { app, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { QlchatClient, USER_AGENT } = require('../src/core/qlchat');

app.setPath('userData', path.join(app.getPath('appData'), 'QlchatDownloader'));
const reportFile = process.argv[2];
async function report(value) {
  if (reportFile) await fs.writeFile(reportFile, JSON.stringify(value, null, 2), 'utf8');
  console.log(JSON.stringify(value));
}
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:qlchat-v1');
  ses.setUserAgent(USER_AGENT);
  const pages = { purchased: 0, recent: 0 };
  const client = new QlchatClient({ fetchImpl: (url, options) => {
    if (url.includes('/purchaseCourse')) pages.purchased++;
    if (url.includes('/listRecentLearn')) pages.recent++;
    return ses.fetch(url, options);
  } });
  try {
    const result = await client.getStudyCourses();
    const counts = { purchased: 0, recent: 0, unsupported: result.unsupportedCount };
    for (const course of result.courses) {
      for (const source of course.sources) if (source in counts) counts[source]++;
    }
    const sample = result.courses.find(course => course.supported);
    const catalog = sample ? await client.getCourse(sample.url) : null;
    await report({ ok: true, complete: result.complete, total: result.courses.length, counts, pages, sampleCatalogCount: catalog?.tasks.length ?? null });
  } catch (error) {
    await report({ ok: false, code: error.code, reasonCode: error.reasonCode, error: error.message });
    process.exitCode = 1;
  } finally {
    await ses.flushStorageData();
    app.quit();
  }
}).catch(() => app.exit(1));
