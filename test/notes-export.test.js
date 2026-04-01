'use strict';

/**
 * Notes export tests — source field migration and type rename.
 *
 * Tests:
 * - buildNoteRow reads metadata.source.system/recordId (not fields.source)
 * - buildNoteRow returns new note type names (textNote, opportunityNote, conversationNote)
 * - Falls back to fields.source for backward compat (deprecated)
 * - Falls back to v1 sourceMap when metadata.source and fields.source both empty
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const NOTE_UUID_1 = 'nnnnnnnn-0000-0000-0000-000000000001';
const NOTE_UUID_2 = 'nnnnnnnn-0000-0000-0000-000000000002';
const NOTE_UUID_3 = 'nnnnnnnn-0000-0000-0000-000000000003';

function parseCompleteEvent(text) {
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    const isComplete = lines.some((l) => l === 'event: complete');
    const dataLine   = lines.find((l) => l.startsWith('data:'));
    if (isComplete && dataLine) {
      return JSON.parse(dataLine.slice(5).trim());
    }
  }
  return null;
}

// ─── Mock PB API server ──────────────────────────────────────────────────────

let mockServer;
let mockPort;
let app;

// v2 notes with metadata.source (new format) and type (new names)
const mockV2Notes = [
  {
    id: NOTE_UUID_1,
    type: 'textNote',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    fields: {
      name: 'Note with metadata source',
      content: 'Content 1',
      archived: false,
      processed: false,
    },
    metadata: { source: { system: 'salesforce', recordId: 'sf-100', url: 'https://sf.example.com/sf-100' } },
    relationships: { data: [], links: { next: null } },
  },
  {
    id: NOTE_UUID_2,
    type: 'opportunityNote',
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-02T00:00:00Z',
    fields: {
      name: 'Note with fields.source only',
      content: 'Content 2',
      source: { origin: 'hubspot', id: 'hs-200' },
      archived: false,
      processed: false,
    },
    metadata: { source: {} },
    relationships: { data: [], links: { next: null } },
  },
  {
    id: NOTE_UUID_3,
    type: 'conversationNote',
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-03T00:00:00Z',
    fields: {
      name: 'Note with no source',
      content: 'Content 3',
      archived: false,
      processed: false,
    },
    metadata: { source: {} },
    relationships: { data: [], links: { next: null } },
  },
];

// v1 notes for source enrichment fallback (NOTE_UUID_3 only)
const mockV1Notes = [
  { id: NOTE_UUID_3, source: { origin: 'intercom', record_id: 'ic-300' } },
];

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // v2 notes list
      if (req.method === 'GET' && req.url.startsWith('/v2/notes')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockV2Notes, links: { next: null } }));
        return;
      }

      // v1 notes list (source enrichment)
      if (req.method === 'GET' && req.url.startsWith('/notes')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockV1Notes, pageCursor: null }));
        return;
      }

      // v2 entities (for user/company cache — return empty)
      if (req.method === 'GET' && req.url.startsWith('/v2/entities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [], links: { next: null } }));
        return;
      }

      res.writeHead(204); res.end();
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  app = require('../src/server.js');
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  delete process.env.PB_API_BASE_URL;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('notes export: reads source from metadata.source.system/recordId (new v2 format)', async () => {
  const res = await request(app)
    .post('/api/notes/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete?.csv, 'Should have CSV content');

  const csv = complete.csv;
  const lines = csv.split('\n');

  // Note 1: has metadata.source.system='salesforce', recordId='sf-100'
  const note1Line = lines.find((l) => l.includes('Note with metadata source'));
  assert.ok(note1Line, 'Should have Note 1 row');
  assert.ok(note1Line.includes('salesforce'), 'Note 1 source_origin should be salesforce (from metadata.source.system)');
  assert.ok(note1Line.includes('sf-100'), 'Note 1 source_record_id should be sf-100 (from metadata.source.recordId)');
});

test('notes export: falls back to fields.source for notes without metadata.source', async () => {
  const res = await request(app)
    .post('/api/notes/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  const csv = complete.csv;
  const lines = csv.split('\n');

  // Note 2: has fields.source.origin='hubspot', fields.source.id='hs-200' but empty metadata.source
  const note2Line = lines.find((l) => l.includes('Note with fields.source only'));
  assert.ok(note2Line, 'Should have Note 2 row');
  assert.ok(note2Line.includes('hubspot'), 'Note 2 should fall back to fields.source.origin');
  assert.ok(note2Line.includes('hs-200'), 'Note 2 should fall back to fields.source.id');
});

test('notes export: falls back to v1 sourceMap when both metadata and fields empty', async () => {
  const res = await request(app)
    .post('/api/notes/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  const csv = complete.csv;
  const lines = csv.split('\n');

  // Note 3: no metadata.source, no fields.source → should use v1 sourceMap
  const note3Line = lines.find((l) => l.includes('Note with no source'));
  assert.ok(note3Line, 'Should have Note 3 row');
  assert.ok(note3Line.includes('intercom'), 'Note 3 should fall back to v1 sourceMap');
  assert.ok(note3Line.includes('ic-300'), 'Note 3 should fall back to v1 sourceMap recordId');
});

test('notes export: uses new note type names (textNote, opportunityNote, conversationNote)', async () => {
  const res = await request(app)
    .post('/api/notes/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  const csv = complete.csv;
  const lines = csv.split('\n');

  // All notes should have new type names
  const note1Line = lines.find((l) => l.includes('Note with metadata source'));
  assert.ok(note1Line.includes('textNote'), 'Note 1 should have textNote type');

  const note2Line = lines.find((l) => l.includes('Note with fields.source only'));
  assert.ok(note2Line.includes('opportunityNote'), 'Note 2 should have opportunityNote type');

  const note3Line = lines.find((l) => l.includes('Note with no source'));
  assert.ok(note3Line.includes('conversationNote'), 'Note 3 should have conversationNote type');
});
