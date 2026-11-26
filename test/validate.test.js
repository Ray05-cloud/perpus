/*
  Tests for lib/validate.js.

  These lock in what the API accepts today. Some of the cases below are marked
  KNOWN GAP: they describe behaviour that is arguably wrong but is deliberate
  for now, because changing it changes what the running site accepts. The
  validation pass is where those become real rejections; until then a test that
  says "this is accepted" is the honest record.
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBook } from '../lib/validate.js';

const valid = () => ({ slug: 'harry-potter', title: 'Harry Potter' });

test('accepts a minimal bookmark', () => {
  const { book, error } = validateBook(valid());
  assert.equal(error, undefined);
  assert.deepEqual(book, {
    slug: 'harry-potter',
    title: 'Harry Potter',
    author: null,
    cat: null,
    cover: null,
    series: null
  });
});

test('trims whitespace from slug and title', () => {
  const { book } = validateBook({ slug: '  harry-potter  ', title: '  Harry Potter  ' });
  assert.equal(book.slug, 'harry-potter');
  assert.equal(book.title, 'Harry Potter');
});

test('rejects a missing or empty slug', () => {
  for (const slug of [undefined, null, '', '   ', 42, {}, []]) {
    const { error } = validateBook({ slug, title: 'A Title' });
    assert.ok(error, `slug ${JSON.stringify(slug)} was accepted`);
    assert.match(error, /slug/);
  }
});

test('rejects a slug with characters that would break the URL', () => {
  for (const slug of ['Harry Potter', 'harry_potter', 'harry/../etc', 'harry#1', 'é']) {
    const { error } = validateBook({ slug, title: 'A Title' });
    assert.ok(error, `slug ${JSON.stringify(slug)} was accepted`);
  }
});

test('rejects a slug longer than 64 characters', () => {
  const { error } = validateBook({ slug: 'a'.repeat(65), title: 'A Title' });
  assert.ok(error);
  assert.match(error, /64/);
});

test('accepts a 64 character slug', () => {
  const { error } = validateBook({ slug: 'a'.repeat(64), title: 'A Title' });
  assert.equal(error, undefined);
});

test('rejects a missing, empty or over-long title', () => {
  for (const title of [undefined, null, '', '   ', 'x'.repeat(301)]) {
    const { error } = validateBook({ slug: 'a-book', title });
    assert.ok(error, `title ${JSON.stringify(title)} was accepted`);
    assert.match(error, /title/);
  }
});

test('accepts a 300 character title', () => {
  const { error } = validateBook({ slug: 'a-book', title: 'x'.repeat(300) });
  assert.equal(error, undefined);
});

test('checks the slug before the title', () => {
  // Both are wrong; the slug message wins so the client fixes one field at a
  // time instead of chasing a message that moves.
  const { error } = validateBook({ slug: '', title: '' });
  assert.match(error, /slug/);
});

test('a non-object body is rejected, not thrown on', () => {
  for (const body of [null, undefined, 'a string', 42, []]) {
    const result = validateBook(body);
    assert.ok(result.error, `body ${JSON.stringify(body)} was accepted`);
  }
});

test('optional fields become null when absent or blank', () => {
  const { book } = validateBook({ ...valid(), author: '   ', cat: '', cover: null });
  assert.equal(book.author, null);
  assert.equal(book.cat, null);
  assert.equal(book.cover, null);
});

test('optional fields are trimmed', () => {
  const { book } = validateBook({ ...valid(), author: '  J. K. Rowling  ' });
  assert.equal(book.author, 'J. K. Rowling');
});

test('KNOWN GAP: over-long optional fields are truncated, not rejected', () => {
  // A 300 character author comes back as 200 characters with no error. This is
  // the behaviour the site has today; the validation pass decides whether it
  // should instead be a 400.
  const { book, error } = validateBook({ ...valid(), author: 'a'.repeat(300) });
  assert.equal(error, undefined);
  assert.equal(book.author.length, 200);
});

test('KNOWN GAP: a non-string optional field becomes null, not an error', () => {
  const { book, error } = validateBook({ ...valid(), author: 12345, cat: {}, cover: [] });
  assert.equal(error, undefined);
  assert.equal(book.author, null);
  assert.equal(book.cat, null);
  assert.equal(book.cover, null);
});

test('KNOWN GAP: an upper-case slug passes validation', () => {
  // The pattern is case-insensitive, but every slug stored in books is
  // lower-case, so "Beauty" would create a bookmark that matches no shelf row.
  const { book, error } = validateBook({ slug: 'Beauty', title: 'Beauty' });
  assert.equal(error, undefined);
  assert.equal(book.slug, 'Beauty');
});

test('only the six known fields survive', () => {
  // Extra keys must not reach the insert, or a caller could set columns the
  // bookmark is not supposed to own.
  const { book } = validateBook({
    ...valid(),
    ownerId: 'someone-else',
    pdfName: 'x.pdf',
    savedAt: '2020-01-01'
  });
  assert.deepEqual(Object.keys(book).sort(), ['author', 'cat', 'cover', 'series', 'slug', 'title']);
});
