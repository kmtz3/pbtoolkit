'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startSSE } = require('../src/lib/sse');

// ── helpers ──────────────────────────────────────────────────────────────────

function mockRes() {
  const res = new EventEmitter();
  res._headers = {};
  res._chunks = [];
  res._ended = false;
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.flushHeaders = () => {};
  res.write = (chunk) => { res._chunks.push(chunk); };
  res.end = () => { res._ended = true; };
  return res;
}

function parseEvents(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')),
      };
    });
}

// ── tests ────────────────────────────────────────────────────────────────────

test('startSSE — sets correct headers', () => {
  const res = mockRes();
  startSSE(res);

  assert.equal(res._headers['Content-Type'], 'text/event-stream');
  assert.equal(res._headers['Cache-Control'], 'no-cache');
  assert.equal(res._headers['Connection'], 'keep-alive');
  assert.equal(res._headers['X-Accel-Buffering'], 'no');
});

test('startSSE — progress sends event with message, percent, detail', () => {
  const res = mockRes();
  const sse = startSSE(res);

  sse.progress('Working…', 42, { step: 1 });

  const events = parseEvents(res._chunks);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'progress');
  assert.equal(events[0].data.message, 'Working…');
  assert.equal(events[0].data.percent, 42);
  assert.deepEqual(events[0].data.detail, { step: 1 });
});

test('startSSE — log sends event with level, message, detail, ts', () => {
  const res = mockRes();
  const sse = startSSE(res);

  sse.log('info', 'Row 1 done', { row: 1 });

  const events = parseEvents(res._chunks);
  assert.equal(events[0].event, 'log');
  assert.equal(events[0].data.level, 'info');
  assert.equal(events[0].data.message, 'Row 1 done');
  assert.ok(events[0].data.ts); // ISO timestamp
});

test('startSSE — complete sends event with spread data', () => {
  const res = mockRes();
  const sse = startSSE(res);

  sse.complete({ total: 10, created: 5 });

  const events = parseEvents(res._chunks);
  assert.equal(events[0].event, 'complete');
  assert.equal(events[0].data.total, 10);
  assert.equal(events[0].data.created, 5);
});

test('startSSE — error sends event with message and detail', () => {
  const res = mockRes();
  const sse = startSSE(res);

  sse.error('Something broke', { code: 500 });

  const events = parseEvents(res._chunks);
  assert.equal(events[0].event, 'error');
  assert.equal(events[0].data.message, 'Something broke');
  assert.deepEqual(events[0].data.detail, { code: 500 });
});

test('startSSE — done ends the response', () => {
  const res = mockRes();
  const sse = startSSE(res);

  assert.equal(res._ended, false);
  sse.done();
  assert.equal(res._ended, true);
});

test('startSSE — isAborted returns false before disconnect', () => {
  const res = mockRes();
  const sse = startSSE(res);

  assert.equal(sse.isAborted(), false);
});

test('startSSE — isAborted returns true after res close', () => {
  const res = mockRes();
  const sse = startSSE(res);

  res.emit('close');
  assert.equal(sse.isAborted(), true);
});

test('startSSE — send methods are no-ops after abort', () => {
  const res = mockRes();
  const sse = startSSE(res);

  // First write succeeds
  sse.progress('Before', 10);
  assert.equal(res._chunks.length, 1);

  // Simulate disconnect
  res.emit('close');

  // Subsequent writes are silently dropped
  sse.progress('After', 20);
  sse.log('info', 'nope');
  sse.complete({ done: true });
  sse.error('fail');

  assert.equal(res._chunks.length, 1); // still only the first write
});
