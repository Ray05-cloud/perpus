/*
  Tests for lib/slug.js.

  These are pure functions with no database and no HTTP, so they run in
  milliseconds and never touch the real shelf. Run with `npm test`.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, uniqueSlug, coverLines } from '../lib/slug.js';

test('slugify lowercases and joins words with a dash', () => {
  assert.equal(slugify('Harry Potter'), 'harry-potter');
});

test('slugify strips accents instead of dropping the letter', () => {
  assert.equal(slugify('Café Société'), 'cafe-societe');
});

test('slugify removes apostrophes without leaving a dash', () => {
  // "Harry's" must become "harrys", not "harry-s": the dash would split a name
  // that reads as one word.
  assert.equal(slugify("Harry's Game"), 'harrys-game');
});

test('slugify collapses runs of spaces and punctuation into one dash', () => {
  assert.equal(slugify('  Hello   World  '), 'hello-world');
  assert.equal(slugify('Titik... Tiga'), 'titik-tiga');
  assert.equal(slugify('Deadpool & Wolverine'), 'deadpool-wolverine');
});

test('slugify never starts or ends with a dash', () => {
  for (const input of ['---abc---', '!!!abc!!!', '  - spaced -  ']) {
    const slug = slugify(input);
    assert.ok(!slug.startsWith('-'), `${input} -> ${slug} starts with a dash`);
    assert.ok(!slug.endsWith('-'), `${input} -> ${slug} ends with a dash`);
  }
});

test('slugify caps the result at 64 characters', () => {
  assert.equal(slugify('a'.repeat(80)).length, 64);
});

test('slugify returns an empty string for empty input', () => {
  // The caller decides what to do with it (uniqueSlug falls back to "book"),
  // so slugify itself must not invent a value.
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('every title gets a slug the API will accept', async () => {
  // server.js rejects slugs that fail /^[a-z0-9-]{1,64}$/i. A title that ends up
  // with anything else would create a book nobody can open. uniqueSlug is the
  // real entry point, because it is what turns an empty slug into "book".
  const titles = [
    'Harry Potter and the Half Blood Prince',
    'The 100-Year-Old Man Who Climbed Out the Window',
    'Émile Zola: Nana',
    '   ',
    'book_with_underscores',
    'UPPER lower MiXeD',
    '!!!'
  ];
  for (const title of titles) {
    const slug = await uniqueSlug(title, () => false);
    assert.match(slug, /^[a-z0-9-]{1,64}$/, `${JSON.stringify(title)} -> ${JSON.stringify(slug)}`);
  }
});

test('uniqueSlug returns the plain slug when nothing owns it', async () => {
  const taken = new Set();
  assert.equal(await uniqueSlug('Harry Potter', (s) => taken.has(s)), 'harry-potter');
});

test('uniqueSlug appends a counter when the slug is taken', async () => {
  const taken = new Set(['harry-potter', 'harry-potter-2']);
  assert.equal(await uniqueSlug('Harry Potter', (s) => taken.has(s)), 'harry-potter-3');
});

test('uniqueSlug falls back to "book" for a title with no usable characters', async () => {
  assert.equal(await uniqueSlug('!!!', () => false), 'book');
});

test('uniqueSlug keeps numbered candidates inside the 64 character limit', async () => {
  const long = 'a'.repeat(64);
  const slug = await uniqueSlug(long, (s) => s === long);
  assert.ok(slug.length <= 64, `${slug.length} characters`);
  assert.match(slug, /^[a-z0-9-]{1,64}$/);
});

test('coverLines keeps a short title on one line', () => {
  assert.deepEqual(coverLines('Short'), { line1: 'Short', line2: '', line3: '' });
});

test('coverLines splits a long title across at most three lines', () => {
  const lines = coverLines('Harry Potter and the Half Blood Prince');
  assert.equal(lines.line1, 'Harry Potter and');
  assert.equal(lines.line2, 'the Half Blood');
  assert.equal(lines.line3, 'Prince');
});

test('coverLines never returns more than three non-empty lines', () => {
  const lines = coverLines('The 100-Year-Old Man Who Climbed Out the Window and Disappeared');
  const filled = [lines.line1, lines.line2, lines.line3].filter(Boolean);
  assert.ok(filled.length <= 3, `${filled.length} lines`);
  assert.equal(lines.line1, 'The 100-Year-Old');
});

test('coverLines falls back to "Untitled" for empty input', () => {
  assert.deepEqual(coverLines(''), { line1: 'Untitled', line2: '', line3: '' });
  assert.deepEqual(coverLines('   '), { line1: 'Untitled', line2: '', line3: '' });
});
