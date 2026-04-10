'use strict';

/**
 * Unit test for the invert-selection logic in companies-duplicate-cleanup-app.js.
 *
 * Bug: the invert-selection handler iterates all input[type=checkbox] inside
 * dc-groups-list and maps each by its forEach index to domainRecords[i].
 * If a group card gains a second checkbox (e.g. a future per-group option),
 * the index drifts — group 1's real checkbox falls on index 2, which maps to
 * records[2] (undefined), so the handler silently skips it. Group 1's checkbox
 * is never toggled: the UI shows it as unselected while it is actually added to
 * _selectedDomains by the extra checkbox landing at index 1. DOM and model diverge.
 *
 * Fix: iterate details[data-di] elements (one per group) instead of raw
 * checkboxes. Read di from the data attribute, find the summary checkbox inside
 * that element. Each group is processed exactly once, by its true index.
 *
 * Test structure:
 *   Test 1 — normal case: both approaches agree (sanity check).
 *   Test 2 — PRE-FIX: asserts the correct invariant using the BUGGY approach.
 *             Fails because the buggy code does not toggle group 1's real checkbox.
 *   Test 3 — POST-FIX: same invariant, fixed approach. Passes.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// ── Simulations ───────────────────────────────────────────────────────────────

/**
 * Buggy handler (mirrors current production code).
 * Mutates checkboxes in place — caller can inspect .checked afterwards.
 */
function buggyInvert(checkboxes, records) {
  const selected = new Set();
  checkboxes.forEach((cb, i) => {
    const dr = records[i]; // BUG: forEach index, not data-di
    if (!dr) return;
    cb.checked = !cb.checked;
    if (cb.checked) selected.add(dr.index);
  });
  return selected;
}

/**
 * Fixed handler (mirrors code after the fix is applied).
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

// ── Invariant tests — same assertion, different handler ───────────────────────
//
// After inverting all-unchecked groups, every group's real checkbox must be
// toggled.  The buggy handler violates this when a card has extra checkboxes.
// The fixed handler satisfies it regardless.

test('invert-selection: every group checkbox toggled after invert [PRE-FIX — fails with buggy handler]', () => {
  const records    = makeRecords(2);
  const checkboxes = [
    { checked: false, di: 0 }, // group 0 main checkbox
    { checked: false, di: 0 }, // group 0 extra checkbox — triggers the drift
    { checked: false, di: 1 }, // group 1 main checkbox
  ];

  buggyInvert(checkboxes, records); // mutates in place

  assert.ok(checkboxes[0].checked, 'group 0 main checkbox must be toggled');
  // Group 1's checkbox (index 2) maps to records[2] = undefined in the buggy
  // handler so it is skipped. This assertion FAILS before the fix is applied.
  assert.ok(checkboxes[2].checked, 'group 1 checkbox must be toggled');
});

test('invert-selection: every group checkbox toggled after invert [POST-FIX — passes with fixed handler]', () => {
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
