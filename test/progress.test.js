/*
  Tests for lib/progress.js.

  The percentage is the one number the shelf and the reader both display, and
  the comment in the module records two bugs it already fixed. These tests lock
  those fixes in so a future "simplification" cannot bring them back.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { percentFor, withPercent } from '../lib/progress.js';

test('page 1 is always 0%, however long the book is', () => {
  assert.equal(percentFor(1, 2220), 0);
  assert.equal(percentFor(1, 2), 0);
  assert.equal(percentFor(1, 1), 100); // page 1 of a 1-page book is also the last page
});

test('the last page is always exactly 100%', () => {
  assert.equal(percentFor(2220, 2220), 100);
  assert.equal(percentFor(10, 10), 100);
});

test('a page past the first never reads as 0%', () => {
  // This is the bug the comment describes: 6 / 2220 rounds down to 0.27%, which
  // floored to 0 - the same number the shelf shows before you start reading.
  assert.equal(percentFor(6, 2220), 1);
  assert.equal(percentFor(2, 2220), 1);
  assert.equal(percentFor(2, 1000), 1);
});

test('100% is never reached before the last page', () => {
  // 2219 / 2220 is 99.95%, which rounds to 100. Flooring keeps it honest.
  assert.equal(percentFor(2219, 2220), 99);
  assert.equal(percentFor(99, 100), 99);
  assert.equal(percentFor(999, 1000), 99);
});

test('percentages in the middle of the book are floored, not rounded', () => {
  assert.equal(percentFor(50, 100), 50);
  assert.equal(percentFor(51, 100), 51);
  assert.equal(percentFor(1109, 2220), 49); // 49.95% must not become 50%
});

test('no total means no percentage at all', () => {
  // A book whose page count was never recorded cannot show progress. null is
  // what the shelf checks for before drawing the bar.
  assert.equal(percentFor(5, null), null);
  assert.equal(percentFor(5, undefined), null);
  assert.equal(percentFor(5, 0), null);
  assert.equal(percentFor(5, -10), null);
  assert.equal(percentFor(5, NaN), null);
});

test('a missing page number is treated as page 1', () => {
  assert.equal(percentFor(undefined, 100), 0);
  assert.equal(percentFor(null, 100), 0);
  assert.equal(percentFor(NaN, 100), 0);
});

test('withPercent keeps the row fields it was given', () => {
  const row = { page: 50, totalPages: 100, finishedAt: null, updatedAt: '2026-01-01' };
  const out = withPercent(row);
  assert.equal(out.page, 50);
  assert.equal(out.totalPages, 100);
  assert.equal(out.updatedAt, '2026-01-01');
  assert.equal(out.percent, 50);
});

test('withPercent turns finishedAt into a boolean', () => {
  // The client reads progress.finished, not finishedAt, so the raw timestamp
  // must not leak as the flag.
  assert.equal(withPercent({ page: 10, totalPages: 10, finishedAt: '2026-01-01T00:00:00Z' }).finished, true);
  assert.equal(withPercent({ page: 3, totalPages: 10, finishedAt: null }).finished, false);
  assert.equal(withPercent({ page: 3, totalPages: 10 }).finished, false);
});

test('withPercent does not mutate the row it was given', () => {
  const row = { page: 2, totalPages: 10 };
  withPercent(row);
  assert.equal(row.percent, undefined);
  assert.equal(row.finished, undefined);
});

test('a row with no totalPages still reports null percent and a finished flag', () => {
  const out = withPercent({ page: 4, totalPages: null, finishedAt: null });
  assert.equal(out.percent, null);
  assert.equal(out.finished, false);
});

test('percent never leaves the 0-100 range', () => {
  const cases = [[0, 100], [-5, 100], [1, 100], [100, 100], [500, 100], [7, 2220]];
  for (const [page, total] of cases) {
    const p = percentFor(page, total);
    if (p !== null) {
      assert.ok(p >= 0 && p <= 100, `page ${page} of ${total} gave ${p}`);
    }
  }
});
