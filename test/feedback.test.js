'use strict';

/**
 * Feedback route tests — note type rename.
 *
 * Verifies POST /api/feedback uses the new 'textNote' type (not legacy 'simple').
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

let mockServer;
let mockPort;
const calls = { notesPost: [] };

function clearCalls() { calls.notesPost = []; }

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : {};

      if (req.method === 'POST' && req.url === '/v2/notes') {
        calls.notesPost.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }));
        return;
      }

      res.writeHead(204); res.end();
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.PB_FEEDBACK_TOKEN = 'test-feedback-token';
  app = require('../src/server.js');
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  delete process.env.PB_API_BASE_URL;
  delete process.env.PB_FEEDBACK_TOKEN;
});

test('POST /api/feedback: uses textNote type (not legacy simple)', async () => {
  clearCalls();

  const res = await request(app)
    .post('/api/feedback')
    .set('Content-Type', 'application/json')
    .send({
      module: 'Companies',
      description: 'Test bug report',
      expectedBehavior: 'Should work correctly',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.notesPost.length, 1);
  assert.equal(
    calls.notesPost[0].data.type,
    'textNote',
    'Should use new textNote type, not legacy simple',
  );
});
