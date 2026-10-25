'use strict';
// Developer integration check. Uses only this application's normal signed-in session.
const { app, session } = require('electron');
const path = require('node:path');
const { QlchatClient, USER_AGENT } = require('../src/core/qlchat');
app.setPath('userData', path.join(app.getPath('appData'), 'QlchatDownloader'));
app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:qlchat-v1');
  ses.setUserAgent(USER_AGENT);
  const client = new QlchatClient({ fetchImpl: async (url, options) => {
    const result = await ses.fetch(url, options);
    if (url.includes('/getMediaActualUrl')) {
      try {
        const data = await result.clone().json();
        console.log(JSON.stringify({ api: 'media', status: result.status, code: data.state?.code, dataKeys: Object.keys(data.data || {}), video: data.data?.video?.map(v => ({ keys: Object.keys(v), urlLength: v.playUrl?.length, resolution: v.resolution })) }));
      } catch { console.log('MEDIA_NON_JSON'); }
    }
    return result;
  } });
  try {
    const course = await client.getCourse(process.argv[2]);
    console.log(JSON.stringify({ course: course.title, count: course.tasks.length }));
    const media = await client.resolveMedia(course.tasks[0]);
    console.log(JSON.stringify({ mediaOk: true, duration: media.duration, height: media.height, host: new URL(media.url).hostname }));
  } catch (error) { console.log(JSON.stringify({ error: error.message, code: error.code })); process.exitCode = 1; }
  await ses.flushStorageData();
  app.quit();
});
