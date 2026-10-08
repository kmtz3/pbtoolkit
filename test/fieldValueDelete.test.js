'use strict';

/**
 * Field value (Manage Values) route tests — input validation + shared delete loop.
 *
 * - /create: non-string names are skipped and reported (never crash); all-invalid → 400
 * - /rename: non-string name / invalid valueId → 400
 * - /delete/one, /delete/by-ids: invalid value UUIDs → 400
 * - /fields: config-fetch failure surfaces as an error status, not 200 + empty list
 * - /delete/by-ids: SSE event shape preserved after hoisting runDeleteLoop
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const FIELD_ID = '11111111-2222-3333-4444-555555555555';
const VALUE_1  = 'aaaaaaaa-0000-0000-0000-000000000001';
const VALUE_2  = 'aaaaaaaa-0000-0000-0000-000000000002';

let mockServer;
const calls = [];
let failConfigs = false;

function parseEvents(text) {
  const out = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    const ev = lines.find((l) => l.startsWith('event:'));
    const data = lines.find((l) => l.startsWith('data:'));
    if (ev && data) out.push({ event: ev.slice(6).trim(), data: JSON.parse(data.slice(5).trim()) });
  }
  return out;
}

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url });
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (req.method === 'GET' && req.url.startsWith('/v2/entities/configurations')) {
        if (failConfigs) return json(403, { errors: [{ detail: 'forbidden' }] });
        if (req.url.endsWith('/company')) return json(200, { data: { fields: {} } });
        return json(200, { data: [], links: {} });
      }
      if (req.method === 'POST' && req.url === `/v2/entities/fields/${FIELD_ID}/values`) {
        const parsed = JSON.parse(body);
        return json(201, { data: { id: VALUE_1, fields: { name: parsed.data.fields.name } } });
      }
      if (req.method === 'DELETE' && req.url.startsWith(`/v2/entities/fields/${FIELD_ID}/values/${VALUE_2}`)) {
        return json(404, { errors: [{ detail: 'not found' }] });
      }
      res.writeHead(204); res.end();
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

const api = (method, path) => request(app)[method](path).set('x-pb-token', 'test-token').set('Content-Type', 'application/json');

test('POST /create: non-string names are skipped and reported, strings still created', async () => {
  const res = await api('post', '/api/field-values/create').send({ fieldId: FIELD_ID, names: [{ a: 1 }, 42, null, 'Good'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.created.map((v) => v.name), ['Good']);
  assert.equal(res.body.errors.length, 3);
  assert.ok(res.body.errors.every((e) => e.error === 'Name must be a string'));
});

test('POST /create: no valid string names → 400 (no crash)', async () => {
  const res = await api('post', '/api/field-values/create').send({ fieldId: FIELD_ID, names: [{ a: 1 }, 5] });
  assert.equal(res.status, 400);
});

test('POST /create: non-string fieldId → 400', async () => {
  const res = await api('post', '/api/field-values/create').send({ fieldId: ['tags'], names: ['x'] });
  assert.equal(res.status, 400);
});

test('PATCH /rename: non-string name → 400', async () => {
  for (const name of [{ x: 1 }, 7, ['a'], '   ']) {
    const res = await api('patch', '/api/field-values/rename').send({ fieldId: FIELD_ID, valueId: VALUE_1, name });
    assert.equal(res.status, 400, `name=${JSON.stringify(name)}`);
  }
});

test('PATCH /rename + POST /delete/one: invalid valueId UUID → 400, no API call', async () => {
  calls.length = 0;
  let res = await api('patch', '/api/field-values/rename').send({ fieldId: FIELD_ID, valueId: '../../members', name: 'x' });
  assert.equal(res.status, 400);
  res = await api('post', '/api/field-values/delete/one').send({ fieldId: FIELD_ID, valueId: 'not-a-uuid' });
  assert.equal(res.status, 400);
  res = await api('post', '/api/field-values/delete/one').send({ fieldId: FIELD_ID, valueId: { id: VALUE_1 } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('POST /delete/by-ids: invalid value id → 400', async () => {
  const res = await api('post', '/api/field-values/delete/by-ids')
    .send({ fieldId: FIELD_ID, values: [{ id: VALUE_1, name: 'a' }, { id: 'nope', name: 'b' }] });
  assert.equal(res.status, 400);
});

test('POST /delete/by-ids: SSE shape preserved (success, 404 warn, progress, complete)', async () => {
  const res = await api('post', '/api/field-values/delete/by-ids')
    .send({ fieldId: FIELD_ID, values: [{ id: VALUE_1, name: 'One' }, { id: VALUE_2, name: 'Two' }] });
  const events = parseEvents(res.text);
  const logs = events.filter((e) => e.event === 'log').map((e) => [e.data.level, e.data.message]);
  assert.deepEqual(logs, [['success', 'Deleted "One"'], ['warn', '"Two" not found — skipped']]);
  const progress = events.filter((e) => e.event === 'progress').map((e) => e.data.percent);
  assert.deepEqual(progress, [50, 100]);
  const complete = events.find((e) => e.event === 'complete').data;
  assert.deepEqual(complete, { total: 2, deleted: 1, errors: 0, stopped: false });
});

test('GET /fields: config fetch failure returns error status, not 200 + empty list', async () => {
  failConfigs = true;
  try {
    const res = await api('get', '/api/field-values/fields');
    assert.equal(res.status, 403);
    assert.ok(res.body.error);
  } finally {
    failConfigs = false;
  }
  const ok = await api('get', '/api/field-values/fields');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { fields: [] });
});
