'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pbAuth } = require('../src/middleware/pbAuth');

// ── helpers ──────────────────────────────────────────────────────────────────

function mockReq(opts = {}) {
  return {
    session: opts.session || {},
    headers: opts.headers || {},
  };
}

function mockRes() {
  const res = {
    locals: {},
    _status: null,
    _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

let nextCalled;
function next() { nextCalled = true; }

// ── tests ────────────────────────────────────────────────────────────────────

test('pbAuth — returns 400 when no token is provided', () => {
  const req = mockReq();
  const res = mockRes();
  nextCalled = false;

  pbAuth(req, res, next);

  assert.equal(res._status, 400);
  assert.match(res._json.error, /missing/i);
  assert.equal(nextCalled, false);
});

test('pbAuth — accepts x-pb-token header', () => {
  const req = mockReq({ headers: { 'x-pb-token': 'tok_123' } });
  const res = mockRes();
  nextCalled = false;

  pbAuth(req, res, next);

  assert.equal(nextCalled, true);
  assert.ok(res.locals.pbClient);
  assert.ok(res.locals.pbClient.pbFetch);
  assert.ok(res.locals.pbClient.withRetry);
});

test('pbAuth — session token takes priority over header', () => {
  const req = mockReq({
    session: { pbToken: 'session_tok' },
    headers: { 'x-pb-token': 'header_tok' },
  });
  const res = mockRes();
  nextCalled = false;

  pbAuth(req, res, next);

  assert.equal(nextCalled, true);
  assert.ok(res.locals.pbClient);
});

test('pbAuth — reads useEu from session', () => {
  const req = mockReq({
    session: { pbToken: 'tok', useEu: true },
  });
  const res = mockRes();
  nextCalled = false;

  pbAuth(req, res, next);

  assert.equal(nextCalled, true);
  assert.ok(res.locals.pbClient);
});

test('pbAuth — reads x-pb-eu header when session has no useEu', () => {
  const req = mockReq({
    headers: { 'x-pb-token': 'tok', 'x-pb-eu': 'true' },
  });
  const res = mockRes();
  nextCalled = false;

  pbAuth(req, res, next);

  assert.equal(nextCalled, true);
  assert.ok(res.locals.pbClient);
});

test('pbAuth — useEu defaults to false', () => {
  const req = mockReq({
    headers: { 'x-pb-token': 'tok' },
  });
  const res = mockRes();
  nextCalled = false;

  pbAuth(req, res, next);

  assert.equal(nextCalled, true);
  assert.ok(res.locals.pbClient);
});
