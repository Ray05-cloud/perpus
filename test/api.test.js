/*
  API tests against a real HTTP server and a real Postgres.

  These are the tests that would have caught the two bugs the unit tests cannot
  see: a status code that lies, a query that filters by the wrong visitor, a
  DELETE that leaves rows behind.

  They are skipped, not failed, when TEST_DATABASE_URL is not set, so a fresh
  clone still runs `npm test` without any database.
*/
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasTestDatabase,
  openTestPool,
  resetSchema,
  startTestServer
} from './helpers/db.js';

const skip = hasTestDatabase()
  ? false
  : 'TEST_DATABASE_URL is not set: see test/README.md for how to create the test database';

let app;
let pool;

before(async () => {
  if (skip) return;
  pool = await openTestPool();
  await resetSchema(pool);
  app = await startTestServer(pool);
});

after(async () => {
  if (skip) return;
  if (app) await app.close();
  if (pool) await pool.end();
});

/* A fetch wrapper that keeps its own cookie jar, the way a browser would. */
function client() {
  let cookie = '';
  return async function call(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(app.base + path, { ...options, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  };
}

function json(payload) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}

async function addBook(api, overrides = {}) {
  const res = await api('/api/books', json({
    title: 'Test Book',
    author: 'Test Author',
    catSlug: 'classic',
    pages: 100,
    ...overrides
  }));
  return res;
}

test('GET /api/books starts empty on a fresh shelf', { skip }, async () => {
  const api = client();
  const res = await api('/api/books');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.books, []);
});

test('GET /api/books sets a visitor cookie', { skip }, async () => {
  const api = client();
  const res = await api('/api/books');
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, 'no Set-Cookie header');
  assert.match(cookie, /perpus_vid=/);
  assert.match(cookie, /HttpOnly/i);
});

test('POST /api/books creates a book and returns it', { skip }, async () => {
  const api = client();
  const res = await addBook(api, { title: 'Dune', author: 'Frank Herbert', pages: 412 });
  assert.equal(res.status, 201);
  assert.equal(res.body.book.title, 'Dune');
  assert.equal(res.body.book.slug, 'dune');
  assert.equal(res.body.book.pages, 412);
  assert.equal(res.body.book.hasPdf, false);
});

test('POST /api/books rejects a missing title', { skip }, async () => {
  const api = client();
  const res = await addBook(api, { title: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /title/i);
});

test('POST /api/books rejects a missing author', { skip }, async () => {
  const api = client();
  const res = await addBook(api, { author: '' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /author/i);
});

test('POST /api/books rejects an unknown category', { skip }, async () => {
  const api = client();
  const res = await addBook(api, { catSlug: 'not-a-category' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /category/i);
});

test('two books with the same title get different slugs', { skip }, async () => {
  const api = client();
  const first = await addBook(api, { title: 'Same Title' });
  const second = await addBook(api, { title: 'Same Title' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.book.slug, 'same-title');
  assert.equal(second.body.book.slug, 'same-title-2');
});

test('GET /api/books/:slug returns one book', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Lookup Me' });
  const res = await api('/api/books/' + created.body.book.slug);
  assert.equal(res.status, 200);
  assert.equal(res.body.book.title, 'Lookup Me');
});

test('GET /api/books/:slug returns 404 for a slug nobody owns', { skip }, async () => {
  const api = client();
  const res = await api('/api/books/never-existed');
  assert.equal(res.status, 404);
});

test('GET /api/books/:slug rejects a malformed slug with 400', { skip }, async () => {
  const api = client();
  const res = await api('/api/books/not%20a%20slug');
  assert.equal(res.status, 400);
});

test('a book added by one visitor is invisible to another', { skip }, async () => {
  const mine = client();
  const theirs = client();
  await addBook(mine, { title: 'Private Shelf' });

  const myList = await mine('/api/books');
  const theirList = await theirs('/api/books');

  assert.ok(myList.body.books.some((b) => b.slug === 'private-shelf'));
  assert.ok(!theirList.body.books.some((b) => b.slug === 'private-shelf'));

  const direct = await theirs('/api/books/private-shelf');
  assert.equal(direct.status, 404);
});

test('deleting your own book removes it and its bookmark', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Delete Me' });
  const slug = created.body.book.slug;

  const saved = await api('/api/saved', json({ slug, title: 'Delete Me' }));
  assert.equal(saved.status, 201);

  const del = await api('/api/books/' + slug, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, slug);

  const after = await api('/api/books/' + slug);
  assert.equal(after.status, 404);

  // The bookmark of a deleted book would otherwise open a page that is gone.
  const bookmarks = await api('/api/saved');
  assert.ok(!bookmarks.body.saved.some((b) => b.slug === slug));
});

test('deleting a seed book is refused with 409', { skip }, async () => {
  const api = client();
  const res = await api('/api/books/beauty', { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /original shelf/i);
});

/*
  A shared book has no owner, so it is on every visitor's shelf at once. It used
  to be deletable by anybody, which meant one visitor could remove it from
  everyone's shelf and take the PDF, notes and reading positions with it.
*/
test('a shared book is not deletable, and says so', { skip }, async () => {
  await pool.query(
    `insert into books (slug, label, title, author, cat, cat_slug, cover, sort_order, owner_id)
     values ('shared-one', 'S', 'Shared One', 'Nobody', 'Classics', 'classic', 'c-plain', 90, null)
     on conflict (slug) do nothing`
  );

  const api = client();
  const list = await api('/api/books');
  const book = list.body.books.find((b) => b.slug === 'shared-one');

  assert.ok(book, 'shared book missing from the shelf');
  assert.equal(book.deletable, false);

  const res = await api('/api/books/shared-one', { method: 'DELETE' });
  assert.equal(res.status, 409);

  const still = await api('/api/books/shared-one');
  assert.equal(still.status, 200);
});

test('deleting a shared book leaves other visitors\' notes and progress alone', { skip }, async () => {
  await pool.query(
    `insert into books (slug, label, title, author, cat, cat_slug, cover, sort_order, owner_id)
     values ('shared-two', 'S', 'Shared Two', 'Nobody', 'Classics', 'classic', 'c-plain', 91, null)
     on conflict (slug) do nothing`
  );

  const reader = client();
  const stranger = client();
  await reader('/api/books');

  await reader('/api/books/shared-two/progress', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 42, totalPages: 100 })
  });
  await reader('/api/books/shared-two/notes', json({ body: 'mine to keep', page: 7 }));

  const del = await stranger('/api/books/shared-two', { method: 'DELETE' });
  assert.equal(del.status, 409);

  const progress = await reader('/api/books/shared-two/progress');
  assert.equal(progress.body.progress.page, 42);

  const notes = await reader('/api/books/shared-two/notes');
  assert.equal(notes.body.notes.length, 1);
  assert.equal(notes.body.notes[0].body, 'mine to keep');
});

test('deleting another visitor\'s book reports 404, not 403', { skip }, async () => {
  const owner = client();
  const stranger = client();
  const created = await addBook(owner, { title: 'Not Yours' });
  const slug = created.body.book.slug;

  const res = await stranger('/api/books/' + slug, { method: 'DELETE' });
  // 403 would confirm the slug exists and leak another visitor's titles.
  assert.equal(res.status, 404);

  const still = await owner('/api/books/' + slug);
  assert.equal(still.status, 200);
});

test('POST /api/saved saves, and repeating it removes', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Toggle Me' });
  const payload = json({ slug: created.body.book.slug, title: 'Toggle Me' });

  const first = await api('/api/saved', payload);
  assert.equal(first.status, 201);
  assert.equal(first.body.saved, true);
  assert.equal(first.body.savedList.length, 1);

  const second = await api('/api/saved', payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.saved, false);
  assert.equal(second.body.savedList.length, 0);
});

test('POST /api/saved rejects a bad payload with 400', { skip }, async () => {
  const api = client();
  const res = await api('/api/saved', json({ slug: 'Bad Slug', title: 'X' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /slug/);
});

test('DELETE /api/saved/:slug removes one bookmark', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Bookmark One' });
  const slug = created.body.book.slug;
  await api('/api/saved', json({ slug, title: 'Bookmark One' }));

  const res = await api('/api/saved/' + slug, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(res.body.savedList.length, 0);
});

test('PUT progress stores a page and derives the percentage', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Progress Me', pages: 200 });
  const slug = created.body.book.slug;

  const put = await api(`/api/books/${slug}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 100, totalPages: 200 })
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.progress.page, 100);
  assert.equal(put.body.progress.percent, 50);
  assert.equal(put.body.progress.finished, false);
});

test('PUT progress on the last page marks the book finished', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Finish Me', pages: 50 });
  const slug = created.body.book.slug;

  const put = await api(`/api/books/${slug}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 50, totalPages: 50 })
  });
  assert.equal(put.body.progress.percent, 100);
  assert.equal(put.body.progress.finished, true);
});

test('PUT progress rejects a page below 1', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Bad Page' });
  const res = await api(`/api/books/${created.body.book.slug}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 0 })
  });
  assert.equal(res.status, 400);
});

test('PUT progress on an unknown book is 404', { skip }, async () => {
  const api = client();
  const res = await api('/api/books/never-existed/progress', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1 })
  });
  assert.equal(res.status, 404);
});

test('notes are scoped to the visitor who wrote them', { skip }, async () => {
  const writer = client();
  const other = client();
  const created = await addBook(writer, { title: 'Note Book' });
  const slug = created.body.book.slug;

  const post = await writer(`/api/books/${slug}/notes`, json({ body: 'A private thought', page: 5 }));
  assert.equal(post.status, 201);

  const mine = await writer(`/api/books/${slug}/notes`);
  assert.equal(mine.body.notes.length, 1);

  const theirs = await other(`/api/books/${slug}/notes`);
  // The other visitor cannot even see the book, so this is a 404 rather than an
  // empty list.
  assert.equal(theirs.status, 404);
});

test('POST a note without text is rejected', { skip }, async () => {
  const api = client();
  const created = await addBook(api, { title: 'Note Needs Text' });
  const res = await api(`/api/books/${created.body.book.slug}/notes`, json({ page: 3, kind: 'note' }));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /text/i);
});

test('an unknown API path is 404, not a crash', { skip }, async () => {
  const api = client();
  const res = await api('/api/not-a-real-endpoint');
  assert.equal(res.status, 404);
});

test('a write method on an API path that only reads is 404', { skip }, async () => {
  const api = client();
  const res = await api('/api/books', { method: 'PATCH' });
  assert.equal(res.status, 404);
});
