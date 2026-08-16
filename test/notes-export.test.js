'use strict';

/**
 * Notes export tests — source field (v2-only) and type rename.
 *
 * Tests:
 * - buildNoteRow reads metadata.source.system/recordId (the only source of truth — v1 retired)
 * - buildNoteRow returns new note type names (textNote, opportunityNote, conversationNote)
 * - Notes with no metadata.source produce empty source columns (no fields.source or v1 fallback)
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
      name: 'Note with deprecated fields.source only',
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

test('notes export: does not fall back to deprecated fields.source (v1 retired, metadata.source only)', async () => {
  const res = await request(app)
    .post('/api/notes/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  const csv = complete.csv;
  const lines = csv.split('\n');

  // Note 2: has deprecated fields.source.origin='hubspot' but empty metadata.source —
  // should NOT be read since v1 sunset; source columns should be empty.
  const note2Line = lines.find((l) => l.includes('Note with deprecated fields.source only'));
  assert.ok(note2Line, 'Should have Note 2 row');
  assert.ok(!note2Line.includes('hubspot'), 'Note 2 should NOT read deprecated fields.source.origin');
  assert.ok(!note2Line.includes('hs-200'), 'Note 2 should NOT read deprecated fields.source.id');
});

test('notes export: note with no metadata.source has empty source columns (no v1 fallback)', async () => {
  const res = await request(app)
    .post('/api/notes/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  const csv = complete.csv;
  const lines = csv.split('\n');

  // Note 3: no metadata.source — no v1 API to fall back to anymore, columns are just empty
  const note3Line = lines.find((l) => l.includes('Note with no source'));
  assert.ok(note3Line, 'Should have Note 3 row');
  const cols = note3Line.split(',');
  assert.equal(cols[10], '', 'Note 3 source_origin should be empty');
  assert.equal(cols[11], '', 'Note 3 source_record_id should be empty');
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

  const note2Line = lines.find((l) => l.includes('Note with deprecated fields.source only'));
  assert.ok(note2Line.includes('opportunityNote'), 'Note 2 should have opportunityNote type');

  const note3Line = lines.find((l) => l.includes('Note with no source'));
  assert.ok(note3Line.includes('conversationNote'), 'Note 3 should have conversationNote type');
});
