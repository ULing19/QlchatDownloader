'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTasks, QlchatClient } = require('../src/core/qlchat');

const response = body => ({ ok: true, status: 200, url: 'https://h5.qlchat.com/api/test', text: async () => JSON.stringify(body), json: async () => body });
const success = data => ({ state: { code: 0 }, data });

test('catalog keeps audio, document, and video topic kinds', () => {
  const tasks = buildTasks([
    { businessType: 'topic', businessId: '70001', businessName: '视频', topicPo: { style: 'normal' } },
    { businessType: 'topic', businessId: '70002', businessName: '图文', topicPo: { style: 'PPT' } },
    { businessType: 'topic', businessId: '70003', businessName: '音频', topicPo: { style: 'audioGraphic' } },
  ]);
  assert.deepEqual(tasks.map(task => task.mediaKind), ['video', 'video', 'audio']);
});

test('audio and document resolvers use their GET APIs and safe nested fields', async () => {
  const calls = [];
  const client = new QlchatClient({ fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('/media-url')) return response(success({ result: { mediaUrl: 'https://x.vod-qcloud.com/lesson.mp3?token=opaque' } }));
    return response(success({ result: { body: '<script>bad()</script>正文' } }));
  } });
  const audio = await client.resolveMedia({ id: '70003', mediaKind: 'audio' });
  const document = await client.resolveMedia({ id: '70002', mediaKind: 'document' });
  assert.match(audio.url, /lesson\.mp3/);
  assert.equal(document.content, '<script>bad()</script>正文');
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET']);
  assert.match(calls[0].url, /topicId=70003/);
});
