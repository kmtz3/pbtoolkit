'use strict';

/**
 * Unit test for the invert-selection logic in companies-duplicate-cleanup-app.js.
 *
 * The handler iterates details[data-di] elements (one per group) and reads di
 * from the data attribute. This avoids index drift when a group card contains
 * more than one checkbox — each group is processed exactly once by its true index.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Simulations ───────────────────────────────────────────────────────────────

/**
 * Index-based handler (iterates checkboxes by forEach index).
 * Used in the sanity-check test to confirm both approaches agree when
 * each group has exactly one checkbox.
 */
function buggyInvert(checkboxes, records) {
  const selected = new Set();
  checkboxes.forEach((cb, i) => {
    const dr = records[i]; // index-based: drifts when a card has extra checkboxes
    if (!dr) return;
    cb.checked = !cb.checked;
    if (cb.checked) selected.add(dr.index);
  });
  return selected;
}

/**
 * data-di-based handler (mirrors production code).
 * groups: [{ di, cb: { checked } }] — one entry per details[data-di] element.
 * Mutates group.cb in place.
 */
function fixedInvert(groups, records) {
  const selected = new Set();
  groups.forEach(({ di, cb }) => {
    const dr = records[di]; // FIXED: data-di, not forEach index
    if (!dr) return;
    cb.checked = !cb.checked;
    if (cb.checked) selected.add(dr.index);
  });
  return selected;
}

function makeRecords(n) {
  return Array.from({ length: n }, (_, i) => ({ index: i }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('invert-selection: both handlers agree when each group has exactly one checkbox', () => {
  const records    = makeRecords(3);
  const checkboxes = [
    { checked: false, di: 0 },
    { checked: false, di: 1 },
    { checked: false, di: 2 },
  ];
  const groups = checkboxes.map(c => ({ di: c.di, cb: { checked: c.checked } }));

  const buggy = buggyInvert(checkboxes.map(c => ({ ...c })), records);
  const fixed = fixedInvert(groups, records);

  assert.deepEqual(buggy, fixed, 'both handlers must agree in the normal case');
  assert.deepEqual(fixed, new Set([0, 1, 2]), 'invert of all-unchecked must select all');
});

test('invert-selection: every group checkbox toggled after invert', () => {
  const records = makeRecords(2);
  // Fixed handler iterates details[data-di] — one entry per group, regardless
  // of how many checkboxes are inside the card.
  const groups = [
    { di: 0, cb: { checked: false } },
    { di: 1, cb: { checked: false } },
  ];

  fixedInvert(groups, records); // mutates in place

  assert.ok(groups[0].cb.checked, 'group 0 checkbox must be toggled');
  assert.ok(groups[1].cb.checked, 'group 1 checkbox must be toggled');
});
