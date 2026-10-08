'use strict';

/**
 * Notes merge route tests — client-supplied ID validation.
 *
 * /run and /delete-empty must reject non-UUID IDs with 400 before any API call
 * (IDs are interpolated into request paths).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const T = 'aaaaaaaa-0000-0000-0000-000000000001';
const S = 'bbbbbbbb-0000-0000-0000-000000000002';

let mockServer;
const calls = [];
let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: T } }));
    });
  });
  await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;
  app = require('../src/server.js');
});

after(async () => {
  await new Promise((r) => mockServer.close(r));
  delete process.env.PB_API_BASE_URL;
});

const run = (groups) => request(app).post('/api/notes-merge/run')
  .set('x-pb-token', 'test-token').set('Content-Type', 'application/json').send({ groups });

test('POST /run: invalid target.id → 400, no API call', async () => {
  calls.length = 0;
  const res = await run([{ target: { id: '../members' }, secondaries: [{ id: S }] }]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /target\.id/);
  assert.equal(calls.length, 0);
});

test('POST /run: invalid secondary id → 400, no API call', async () => {
  calls.length = 0;
  const res = await run([{ target: { id: T }, secondaries: [{ id: S }, { id: 'x?y' }] }]);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /secondaries\[1\]\.id/);
  assert.equal(calls.length, 0);
});

test('POST /run: invalid customer_id / product_links → 400', async () => {
  let res = await run([{ target: { id: T }, secondaries: [{ id: S, customer_id: 'nope', customer_type: 'user' }] }]);
  assert.equal(res.status, 400);
  res = await run([{ target: { id: T, product_links: ['bad'] }, secondaries: [{ id: S }] }]);
  assert.equal(res.status, 400);
});

test('POST /run: non-array groups → 400', async () => {
  const res = await run({ target: { id: T } });
  assert.equal(res.status, 400);
});

test('POST /run: valid ids proceed to SSE merge', async () => {
  calls.length = 0;
  const res = await run([{ target: { id: T, customer_id: '' }, secondaries: [{ id: S, customer_id: '' }] }]);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === `/v2/notes/${S}`));
});

test('POST /delete-empty: invalid note id → 400, no API call', async () => {
  calls.length = 0;
  const res = await request(app).post('/api/notes-merge/delete-empty')
    .set('x-pb-token', 'test-token').set('Content-Type', 'application/json')
    .send({ notes: [{ id: T }, { id: '../../x' }] });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});
