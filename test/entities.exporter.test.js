'use strict';

/**
 * Unit tests for src/services/entities/exporter.js.
 * Pure functions — no HTTP mocking needed.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  rowsToCsv,
  buildExportHeaders,
  formatFieldValue,
  entityToRow,
  buildNameMapFromEntities,
  resolveBreadcrumb,
  ROOT_ENTITY_TYPES,
} = require('../src/services/entities/exporter');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(systemFields = [], customFields = []) {
  return { systemFields, customFields };
}

function makeSystemField(id, name) {
  return { id, name };
}

function makeCustomField(id, name, displayType, schema) {
  return { id, name, displayType, schema };
}

// Minimal entity object
function makeEntity(id, fields = {}, rels = []) {
  return { id, fields, relationships: { data: rels } };
}

// ---------------------------------------------------------------------------
// rowsToCsv
// ---------------------------------------------------------------------------

describe('rowsToCsv — BOM and structure', () => {
  test('prepends UTF-8 BOM', () => {
    const csv = rowsToCsv(['A'], [{ A: 'val' }]);
    assert.ok(csv.startsWith('\uFEFF'), 'BOM missing');
  });

  test('produces header row matching headers array order', () => {
    const csv = rowsToCsv(['Z', 'A', 'M'], [{ Z: '1', A: '2', M: '3' }]);
    const lines = csv.replace(/^\uFEFF/, '').split('\n');
    assert.equal(lines[0].trim(), 'Z,A,M'); // trim handles CRLF from papaparse
  });

  test('null cell value becomes empty string', () => {
    const csv = rowsToCsv(['A', 'B'], [{ A: null, B: 'ok' }]);
    const data = csv.replace(/^\uFEFF/, '').split('\n')[1];
    assert.ok(data.startsWith(','), `expected empty first cell, got: ${data}`);
  });

  test('undefined cell value becomes empty string', () => {
    const csv = rowsToCsv(['A'], [{ A: undefined }]);
    const data = csv.replace(/^\uFEFF/, '').split('\n')[1];
    assert.equal(data.trim(), '');
  });

  test('produces correct number of data rows', () => {
    const rows = [{ X: 'a' }, { X: 'b' }, { X: 'c' }];
    const csv = rowsToCsv(['X'], rows);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n');
    assert.equal(lines.length, 4); // header + 3 rows
  });

  test('empty rows array produces only header', () => {
    const csv = rowsToCsv(['A', 'B'], []);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'A,B');
  });
});

// ---------------------------------------------------------------------------
// buildExportHeaders
// ---------------------------------------------------------------------------

describe('buildExportHeaders — column structure', () => {
  test('always starts with pb_id, ext_key', () => {
    const config = makeConfig([makeSystemField('name', 'Name')]);
    const headers = buildExportHeaders('feature', config);
    assert.equal(headers[0], 'pb_id');
    assert.equal(headers[1], 'ext_key');
  });

  test('feature: includes timeframe + health synthetic cols', () => {
    const config = makeConfig([makeSystemField('name', 'Name')]);
    const headers = buildExportHeaders('feature', config);
    assert.ok(headers.includes('timeframe_start (YYYY-MM-DD)'));
    assert.ok(headers.includes('timeframe_end (YYYY-MM-DD)'));
    assert.ok(headers.includes('health_status'));
    assert.ok(headers.includes('health_comment'));
    assert.ok(headers.includes('health_updated_by (email)'));
    assert.ok(headers.includes('health_last_updated'));
    assert.ok(headers.includes('health_previous_status'));
  });

  test('product: no timeframe, no health synthetic cols', () => {
    const config = makeConfig([makeSystemField('name', 'Name')]);
    const headers = buildExportHeaders('product', config);
    assert.ok(!headers.includes('timeframe_start (YYYY-MM-DD)'));
    assert.ok(!headers.includes('health_status'));
  });

  test('feature: includes parent_ext_key rel col', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('feature', config);
    assert.ok(headers.includes('parent_ext_key'));
  });

  test('subfeature: includes parent_feat_ext_key (not parent_ext_key)', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('subfeature', config);
    assert.ok(headers.includes('parent_feat_ext_key'));
    assert.ok(!headers.includes('parent_ext_key'));
  });

  test('release: includes parent_rlgr_ext_key', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('release', config);
    assert.ok(headers.includes('parent_rlgr_ext_key'));
  });

  test('release: no health/timeframe synthetic cols', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('release', config);
    assert.ok(!headers.includes('health_status'));
    assert.ok(headers.includes('timeframe_start (YYYY-MM-DD)')); // release HAS timeframe
  });

  test('objective: no health synthetic cols', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('objective', config);
    assert.ok(headers.includes('health_status')); // objective HAS health
    assert.ok(headers.includes('parent_obj_ext_key'));
  });

  test('custom field header uses "{name} [{displayType}] [{id}]" format', () => {
    const config = makeConfig(
      [],
      [makeCustomField('my-field-id', 'Priority', 'SingleSelect', 'SingleSelectFieldValue')]
    );
    const headers = buildExportHeaders('feature', config);
    assert.ok(headers.includes('Priority [SingleSelect] [my-field-id]'));
  });

  test('system fields ordered by SYSTEM_FIELD_ORDER', () => {
    // Provide fields out of order — expect them sorted
    const config = makeConfig([
      makeSystemField('owner', 'Owner'),
      makeSystemField('name', 'Name'),
      makeSystemField('status', 'Status'),
    ]);
    const headers = buildExportHeaders('feature', config);
    const nameIdx   = headers.indexOf('Name');
    const ownerIdx  = headers.indexOf('Owner');
    const statusIdx = headers.indexOf('Status');
    assert.ok(nameIdx < ownerIdx, 'name should come before owner');
    assert.ok(ownerIdx < statusIdx, 'owner should come before status');
  });
});

// ---------------------------------------------------------------------------
// formatFieldValue
// ---------------------------------------------------------------------------

describe('formatFieldValue — schema type dispatch', () => {
  test('null → empty string', () => {
    assert.equal(formatFieldValue(null, 'TextFieldValue'), '');
  });

  test('empty string → empty string', () => {
    assert.equal(formatFieldValue('', 'TextFieldValue'), '');
  });

  test('Number schema → string', () => {
    assert.equal(formatFieldValue(42, 'NumberFieldValue'), '42');
  });

  test('Text schema → string passthrough', () => {
    assert.equal(formatFieldValue('hello', 'TextFieldValue'), 'hello');
  });

  test('SingleSelect → name property', () => {
    assert.equal(formatFieldValue({ name: 'High' }, 'SingleSelectFieldValue'), 'High');
  });

  test('SingleSelect with no name → empty string', () => {
    assert.equal(formatFieldValue({}, 'SingleSelectFieldValue'), '');
  });

  test('MultiSelect → comma-joined names', () => {
    const val = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
    assert.equal(formatFieldValue(val, 'MultiSelectFieldValue'), 'A, B, C');
  });

  test('MultiSelect empty array → empty string', () => {
    assert.equal(formatFieldValue([], 'MultiSelectFieldValue'), '');
  });

  test('Members array → names joined', () => {
    const val = [{ name: 'Alice' }, { name: 'Bob' }];
    assert.equal(formatFieldValue(val, 'MembersFieldValue'), 'Alice, Bob');
  });

  test('Members array — uses email when name missing', () => {
    const val = [{ email: 'alice@x.com' }];
    assert.equal(formatFieldValue(val, 'MembersFieldValue'), 'alice@x.com');
  });

  test('Member/User schema → email', () => {
    assert.equal(formatFieldValue({ email: 'user@x.com' }, 'MemberFieldValue'), 'user@x.com');
  });

  test('Date schema string → passthrough', () => {
    assert.equal(formatFieldValue('2026-03-01', 'DateFieldValue'), '2026-03-01');
  });

  test('Date schema object with date property', () => {
    assert.equal(formatFieldValue({ date: '2026-03-01' }, 'DateFieldValue'), '2026-03-01');
  });

  test('unknown schema with array value → names joined', () => {
    const val = [{ name: 'X' }, { name: 'Y' }];
    assert.equal(formatFieldValue(val, 'UnknownFieldValue'), 'X, Y');
  });

  test('unknown schema with object → name property', () => {
    assert.equal(formatFieldValue({ name: 'Foo' }, 'UnknownFieldValue'), 'Foo');
  });

  test('unknown schema with primitive → String()', () => {
    assert.equal(formatFieldValue(123, 'UnknownFieldValue'), '123');
  });
});

// ---------------------------------------------------------------------------
// entityToRow — system fields
// ---------------------------------------------------------------------------

describe('entityToRow — tracking columns', () => {
  test('pb_id from entity.id', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('uuid-1'), 'feature', config);
    assert.equal(row['pb_id'], 'uuid-1');
  });

  test('ext_key from fields.externalKey', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('uuid-1', { externalKey: 'FEAT-1' }), 'feature', config);
    assert.equal(row['ext_key'], 'FEAT-1');
  });

  test('ext_key empty when externalKey absent', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('uuid-1', {}), 'feature', config);
    assert.equal(row['ext_key'], '');
  });
});

describe('entityToRow — system field values', () => {
  test('name field', () => {
    const config = makeConfig([makeSystemField('name', 'Name')]);
    const row = entityToRow(makeEntity('id', { name: 'My Feature' }), 'feature', config);
    assert.equal(row['Name'], 'My Feature');
  });

  test('owner → email', () => {
    const config = makeConfig([makeSystemField('owner', 'Owner')]);
    const row = entityToRow(makeEntity('id', { owner: { email: 'dev@x.com' } }), 'feature', config);
    assert.equal(row['Owner'], 'dev@x.com');
  });

  test('status → name', () => {
    const config = makeConfig([makeSystemField('status', 'Status')]);
    const row = entityToRow(makeEntity('id', { status: { name: 'In Progress' } }), 'feature', config);
    assert.equal(row['Status'], 'In Progress');
  });

  test('teams → comma-joined names', () => {
    const config = makeConfig([makeSystemField('teams', 'Teams')]);
    const row = entityToRow(
      makeEntity('id', { teams: [{ name: 'Eng' }, { name: 'PM' }] }),
      'feature', config
    );
    assert.equal(row['Teams'], 'Eng, PM');
  });

  test('objective teams field handled (plural, like all entity types)', () => {
    const config = makeConfig([makeSystemField('teams', 'Teams')]);
    const row = entityToRow(
      makeEntity('id', { teams: [{ name: 'Strategy' }] }), // API returns 'teams' plural
      'objective', config
    );
    assert.equal(row['Teams'], 'Strategy');
  });

  test('archived=true → "TRUE" string', () => {
    const config = makeConfig([makeSystemField('archived', 'Archived')]);
    const row = entityToRow(makeEntity('id', { archived: true }), 'feature', config);
    assert.equal(row['Archived'], 'TRUE');
  });

  test('archived=false → "FALSE" string', () => {
    const config = makeConfig([makeSystemField('archived', 'Archived')]);
    const row = entityToRow(makeEntity('id', { archived: false }), 'feature', config);
    assert.equal(row['Archived'], 'FALSE');
  });

  test('workProgress → value as string', () => {
    const config = makeConfig([makeSystemField('workProgress', 'Work Progress')]);
    const row = entityToRow(makeEntity('id', { workProgress: { value: 75 } }), 'feature', config);
    assert.equal(row['Work Progress'], '75');
  });
});

// ---------------------------------------------------------------------------
// entityToRow — synthetic columns
// ---------------------------------------------------------------------------

describe('entityToRow — timeframe (feature)', () => {
  test('extracts timeframe startDate and endDate', () => {
    const config = makeConfig();
    const row = entityToRow(
      makeEntity('id', { timeframe: { startDate: '2026-01-01', endDate: '2026-03-31' } }),
      'feature', config
    );
    assert.equal(row['timeframe_start (YYYY-MM-DD)'], '2026-01-01');
    assert.equal(row['timeframe_end (YYYY-MM-DD)'], '2026-03-31');
  });

  test('empty timeframe → empty strings', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('id', {}), 'feature', config);
    assert.equal(row['timeframe_start (YYYY-MM-DD)'], '');
    assert.equal(row['timeframe_end (YYYY-MM-DD)'], '');
  });

  test('product has no timeframe columns', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('id', {}), 'product', config);
    assert.equal(row['timeframe_start (YYYY-MM-DD)'], undefined);
  });
});

describe('entityToRow — health columns (feature)', () => {
  test('extracts health status, comment, email, lastUpdatedAt, previousStatus', () => {
    const config = makeConfig();
    const row = entityToRow(
      makeEntity('id', {
        health: {
          status: 'on_track',
          comment: 'Looking good',
          createdBy: { email: 'pm@x.com' },
          lastUpdatedAt: '2026-03-15T10:30:00Z',
          previousStatus: 'at_risk',
        },
      }),
      'feature', config
    );
    assert.equal(row['health_status'], 'on_track');
    assert.equal(row['health_comment'], 'Looking good');
    assert.equal(row['health_updated_by (email)'], 'pm@x.com');
    assert.equal(row['health_last_updated'], '2026-03-15T10:30:00Z');
    assert.equal(row['health_previous_status'], 'at_risk');
  });

  test('missing health → empty strings', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('id', {}), 'feature', config);
    assert.equal(row['health_status'], '');
    assert.equal(row['health_comment'], '');
    assert.equal(row['health_updated_by (email)'], '');
    assert.equal(row['health_last_updated'], '');
    assert.equal(row['health_previous_status'], '');
  });

  test('product has no health columns', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('id', {}), 'product', config);
    assert.equal(row['health_status'], undefined);
  });
});

// ---------------------------------------------------------------------------
// entityToRow — custom fields
// ---------------------------------------------------------------------------

describe('entityToRow — custom fields', () => {
  test('single-select custom field → name', () => {
    const config = makeConfig(
      [],
      [makeCustomField('cf-1', 'Priority', 'SingleSelect', 'SingleSelectFieldValue')]
    );
    const row = entityToRow(
      makeEntity('id', { 'cf-1': { name: 'High' } }),
      'feature', config
    );
    assert.equal(row['Priority [SingleSelect] [cf-1]'], 'High');
  });

  test('number custom field → string', () => {
    const config = makeConfig(
      [],
      [makeCustomField('cf-2', 'Score', 'Number', 'NumberFieldValue')]
    );
    const row = entityToRow(makeEntity('id', { 'cf-2': 99 }), 'feature', config);
    assert.equal(row['Score [Number] [cf-2]'], '99');
  });

  test('absent custom field → empty string', () => {
    const config = makeConfig(
      [],
      [makeCustomField('cf-3', 'Notes', 'Text', 'TextFieldValue')]
    );
    const row = entityToRow(makeEntity('id', {}), 'feature', config);
    assert.equal(row['Notes [Text] [cf-3]'], '');
  });
});

// ---------------------------------------------------------------------------
// entityToRow — relationship columns
// ---------------------------------------------------------------------------

describe('entityToRow — parent relationships', () => {
  test('component parent → parent_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'parent', target: { id: 'parent-uuid', type: 'component' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'feature', config);
    assert.equal(row['parent_ext_key'], 'parent-uuid');
  });

  test('subfeature parent → parent_feat_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'parent', target: { id: 'feat-uuid', type: 'feature' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'subfeature', config);
    assert.equal(row['parent_feat_ext_key'], 'feat-uuid');
  });

  test('objective parent → parent_obj_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'parent', target: { id: 'obj-uuid', type: 'objective' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'objective', config);
    assert.equal(row['parent_obj_ext_key'], 'obj-uuid');
  });

  test('release parent → parent_rlgr_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'parent', target: { id: 'rlgr-uuid', type: 'releaseGroup' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'release', config);
    assert.equal(row['parent_rlgr_ext_key'], 'rlgr-uuid');
  });

  test('no parent rel → no parent column set', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('id', {}, []), 'feature', config);
    assert.equal(row['parent_ext_key'], undefined);
  });
});

describe('entityToRow — connected-link relationships', () => {
  test('connected objectives → connected_objs_ext_key (comma-joined)', () => {
    const config = makeConfig();
    const rels = [
      { type: 'link', target: { id: 'obj-1', type: 'objective' } },
      { type: 'link', target: { id: 'obj-2', type: 'objective' } },
    ];
    const row = entityToRow(makeEntity('id', {}, rels), 'feature', config);
    assert.equal(row['connected_objs_ext_key'], 'obj-1, obj-2');
  });

  test('connected initiatives → connected_inis_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'link', target: { id: 'ini-1', type: 'initiative' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'feature', config);
    assert.equal(row['connected_inis_ext_key'], 'ini-1');
  });

  test('connected releases → connected_rels_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'link', target: { id: 'rel-1', type: 'release' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'initiative', config);
    assert.equal(row['connected_rels_ext_key'], 'rel-1');
  });

  test('no link rels → no connected columns set', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('id', {}, []), 'feature', config);
    assert.equal(row['connected_objs_ext_key'], undefined);
    assert.equal(row['connected_inis_ext_key'], undefined);
  });

  test('isBlockedBy rels → blocked_by_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'isBlockedBy', target: { id: 'blocker-1' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'feature', config);
    assert.equal(row['blocked_by_ext_key'], 'blocker-1');
  });

  test('isBlocking rels → blocking_ext_key', () => {
    const config = makeConfig();
    const rels = [{ type: 'isBlocking', target: { id: 'blocking-1' } }];
    const row = entityToRow(makeEntity('id', {}, rels), 'feature', config);
    assert.equal(row['blocking_ext_key'], 'blocking-1');
  });
});

// ---------------------------------------------------------------------------
// buildNameMapFromEntities
// ---------------------------------------------------------------------------

describe('buildNameMapFromEntities', () => {
  test('basic entity with a parent rel → maps id to {name, parentId}', () => {
    const entities = [
      makeEntity('child-id', { name: 'Child' }, [{ type: 'parent', target: { id: 'parent-id' } }]),
    ];
    const map = buildNameMapFromEntities(entities);
    assert.deepEqual(map['child-id'], { name: 'Child', parentId: 'parent-id' });
  });

  test('entity with no parent rel → parentId is null', () => {
    const entities = [makeEntity('root-id', { name: 'Root' }, [])];
    const map = buildNameMapFromEntities(entities);
    assert.deepEqual(map['root-id'], { name: 'Root', parentId: null });
  });

  test('multiple entities → all mapped', () => {
    const entities = [
      makeEntity('a', { name: 'A' }, []),
      makeEntity('b', { name: 'B' }, [{ type: 'parent', target: { id: 'a' } }]),
      makeEntity('c', { name: 'C' }, [{ type: 'parent', target: { id: 'b' } }]),
    ];
    const map = buildNameMapFromEntities(entities);
    assert.equal(Object.keys(map).length, 3);
    assert.equal(map['c'].parentId, 'b');
    assert.equal(map['b'].parentId, 'a');
    assert.equal(map['a'].parentId, null);
  });

  test('entity with no fields.name → falls back to entity id', () => {
    const entities = [makeEntity('orphan-id', {}, [])];
    const map = buildNameMapFromEntities(entities);
    assert.equal(map['orphan-id'].name, 'orphan-id');
  });

  test('ignores non-parent relationship types when determining parentId', () => {
    const entities = [
      makeEntity('feat-id', { name: 'Feat' }, [
        { type: 'link', target: { id: 'some-obj' } },
        { type: 'parent', target: { id: 'comp-id' } },
      ]),
    ];
    const map = buildNameMapFromEntities(entities);
    assert.equal(map['feat-id'].parentId, 'comp-id');
  });

  test('empty array → empty map', () => {
    assert.deepEqual(buildNameMapFromEntities([]), {});
  });
});

// ---------------------------------------------------------------------------
// resolveBreadcrumb
// ---------------------------------------------------------------------------

describe('resolveBreadcrumb', () => {
  test('root entity (no parent) → empty string', () => {
    const map = { 'root': { name: 'Root', parentId: null } };
    assert.equal(resolveBreadcrumb('root', map), '');
  });

  test('entity with one parent → parent name', () => {
    const map = {
      'root':  { name: 'Root',    parentId: null   },
      'child': { name: 'Child',   parentId: 'root' },
    };
    assert.equal(resolveBreadcrumb('child', map), 'Root');
  });

  test('three-level chain → grandparent > parent (entity itself excluded)', () => {
    const map = {
      'prod': { name: 'MyProduct',   parentId: null     },
      'comp': { name: 'MyComponent', parentId: 'prod'   },
      'feat': { name: 'MyFeature',   parentId: 'comp'   },
    };
    assert.equal(resolveBreadcrumb('feat', map), 'MyProduct > MyComponent');
  });

  test('four-level chain → all ancestors included in order', () => {
    const map = {
      'p':  { name: 'Product',    parentId: null  },
      'c':  { name: 'Component',  parentId: 'p'   },
      'f':  { name: 'Feature',    parentId: 'c'   },
      'sf': { name: 'Subfeature', parentId: 'f'   },
    };
    assert.equal(resolveBreadcrumb('sf', map), 'Product > Component > Feature');
  });

  test('entity not in map → empty string', () => {
    const map = {};
    assert.equal(resolveBreadcrumb('missing-id', map), '');
  });

  test('parent id not in map (deleted ancestor) → partial path up to last known', () => {
    const map = {
      'feat': { name: 'Feature', parentId: 'missing-comp' },
      // missing-comp is not in the map
    };
    assert.equal(resolveBreadcrumb('feat', map), '');
  });

  test('known parent points to unknown grandparent → shows known parent only', () => {
    const map = {
      'comp': { name: 'Component', parentId: 'missing-prod' },
      'feat': { name: 'Feature',   parentId: 'comp' },
    };
    assert.equal(resolveBreadcrumb('feat', map), 'Component');
  });

  test('cycle guard — circular reference breaks loop, returns partial path', () => {
    const map = {
      'a': { name: 'A', parentId: 'b' },
      'b': { name: 'B', parentId: 'a' }, // cycle: a→b→a
    };
    // Should not throw or loop forever; 'b' is visited first
    const result = resolveBreadcrumb('a', map);
    assert.equal(typeof result, 'string');
    // 'b' is the immediate parent of 'a'; then 'a' is seen → stop
    assert.equal(result, 'B');
  });
});

// ---------------------------------------------------------------------------
// ROOT_ENTITY_TYPES
// ---------------------------------------------------------------------------

describe('ROOT_ENTITY_TYPES — correct membership', () => {
  test('product, releaseGroup, initiative are root types', () => {
    assert.ok(ROOT_ENTITY_TYPES.has('product'));
    assert.ok(ROOT_ENTITY_TYPES.has('releaseGroup'));
    assert.ok(ROOT_ENTITY_TYPES.has('initiative'));
  });

  test('component, feature, subfeature, objective, keyResult, release are NOT root types', () => {
    for (const t of ['component', 'feature', 'subfeature', 'objective', 'keyResult', 'release']) {
      assert.ok(!ROOT_ENTITY_TYPES.has(t), `${t} should not be a root type`);
    }
  });
});

// ---------------------------------------------------------------------------
// buildExportHeaders — breadcrumb option
// ---------------------------------------------------------------------------

describe('buildExportHeaders — breadcrumb option', () => {
  test('breadcrumb: true → hierarchy_path appears after updated_at at position 4', () => {
    const config = makeConfig([makeSystemField('name', 'Name')]);
    const headers = buildExportHeaders('feature', config, { breadcrumb: true });
    assert.equal(headers[4], 'hierarchy_path');
  });

  test('breadcrumb: true → prefix is pb_id, ext_key, created_at, updated_at, hierarchy_path', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('component', config, { breadcrumb: true });
    assert.deepEqual(headers.slice(0, 5), ['pb_id', 'ext_key', 'created_at', 'updated_at', 'hierarchy_path']);
  });

  test('breadcrumb: false → no hierarchy_path column', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('feature', config, { breadcrumb: false });
    assert.ok(!headers.includes('hierarchy_path'));
  });

  test('no options arg → no hierarchy_path column', () => {
    const config = makeConfig();
    const headers = buildExportHeaders('feature', config);
    assert.ok(!headers.includes('hierarchy_path'));
  });

  test('breadcrumb: true → all other columns still present', () => {
    const config = makeConfig(
      [makeSystemField('name', 'Name')],
      [makeCustomField('cf-1', 'Score', 'Number', 'NumberFieldValue')]
    );
    const headers = buildExportHeaders('feature', config, { breadcrumb: true });
    assert.ok(headers.includes('pb_id'));
    assert.ok(headers.includes('Name'));
    assert.ok(headers.includes('Score [Number] [cf-1]'));
    assert.ok(headers.includes('parent_ext_key'));
  });

  test('breadcrumb: true on product → no hierarchy_path (root type)', () => {
    const headers = buildExportHeaders('product', makeConfig(), { breadcrumb: true });
    assert.ok(!headers.includes('hierarchy_path'));
  });

  test('breadcrumb: true on releaseGroup → no hierarchy_path (root type)', () => {
    const headers = buildExportHeaders('releaseGroup', makeConfig(), { breadcrumb: true });
    assert.ok(!headers.includes('hierarchy_path'));
  });

  test('breadcrumb: true on initiative → no hierarchy_path (root type)', () => {
    const headers = buildExportHeaders('initiative', makeConfig(), { breadcrumb: true });
    assert.ok(!headers.includes('hierarchy_path'));
  });

  test('breadcrumb: true on component → hierarchy_path IS included (not a root type)', () => {
    const headers = buildExportHeaders('component', makeConfig(), { breadcrumb: true });
    assert.ok(headers.includes('hierarchy_path'));
  });
});

// ---------------------------------------------------------------------------
// entityToRow — hierarchy_path column (nameMap option)
// ---------------------------------------------------------------------------

describe('entityToRow — hierarchy_path via nameMap option', () => {
  test('nameMap provided, entity has ancestors → hierarchy_path populated', () => {
    const nameMap = {
      'prod':  { name: 'MyProduct',   parentId: null   },
      'comp':  { name: 'MyComponent', parentId: 'prod' },
      'feat':  { name: 'MyFeature',   parentId: 'comp' },
    };
    const config = makeConfig();
    const row = entityToRow(makeEntity('feat', { name: 'MyFeature' }), 'feature', config, { nameMap });
    assert.equal(row['hierarchy_path'], 'MyProduct > MyComponent');
  });

  test('nameMap provided, top-level component (no parent) → hierarchy_path is empty string', () => {
    const nameMap = {
      'comp': { name: 'Top Component', parentId: null },
    };
    const config = makeConfig();
    const row = entityToRow(makeEntity('comp', { name: 'Top Component' }), 'component', config, { nameMap });
    assert.equal(row['hierarchy_path'], '');
  });

  test('no nameMap (default) → hierarchy_path not present in row', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('feat', { name: 'Feat' }), 'feature', config);
    assert.equal(row['hierarchy_path'], undefined);
  });

  test('nameMap null explicitly → hierarchy_path not present in row', () => {
    const config = makeConfig();
    const row = entityToRow(makeEntity('feat', { name: 'Feat' }), 'feature', config, { nameMap: null });
    assert.equal(row['hierarchy_path'], undefined);
  });

  test('entity id missing from nameMap → hierarchy_path is empty string', () => {
    const nameMap = {}; // entity not in map
    const config = makeConfig();
    const row = entityToRow(makeEntity('feat', { name: 'Feat' }), 'feature', config, { nameMap });
    assert.equal(row['hierarchy_path'], '');
  });

  test('nameMap provided but entity is product → hierarchy_path NOT added (root type)', () => {
    const nameMap = { 'prod': { name: 'MyProduct', parentId: null } };
    const row = entityToRow(makeEntity('prod', { name: 'MyProduct' }), 'product', makeConfig(), { nameMap });
    assert.equal(row['hierarchy_path'], undefined);
  });

  test('nameMap provided but entity is releaseGroup → hierarchy_path NOT added (root type)', () => {
    const nameMap = { 'rg': { name: 'Q1', parentId: null } };
    const row = entityToRow(makeEntity('rg', { name: 'Q1' }), 'releaseGroup', makeConfig(), { nameMap });
    assert.equal(row['hierarchy_path'], undefined);
  });

  test('nameMap provided but entity is initiative → hierarchy_path NOT added (root type)', () => {
    const nameMap = { 'ini': { name: 'Growth', parentId: null } };
    const row = entityToRow(makeEntity('ini', { name: 'Growth' }), 'initiative', makeConfig(), { nameMap });
    assert.equal(row['hierarchy_path'], undefined);
  });
});
