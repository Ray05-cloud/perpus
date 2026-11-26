/*
  Small Express-free HTTP layer: serves the three static pages and exposes the
  saved-stories list at /api/saved. The browser keeps a visitor id in an
  httpOnly cookie, so the list follows the visitor rather than the device.
*/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from './db/index.js';
import {
  ensureStorage,
  receivePdf,
  pdfPath,
  pdfInfo,
  removePdf
} from './lib/pdf-store.js';
import { uniqueSlug, coverLines, slugify } from './lib/slug.js';
import { withPercent } from './lib/progress.js';
import { validateBook } from './lib/validate.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT === undefined || process.env.PORT === ''
  ? 3000
  : Number(process.env.PORT);
const COOKIE = 'perpus_vid';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Only these files are public. Directory traversal cannot reach the rest of the
// project (db/, scripts/, .env) because the path never comes from the request.
const PAGES = new Set(['/', '/index.html', '/book.html', '/bookmarks.html', '/add.html', '/reader.html', '/books.js', '/saved.js']);

// The eight books that shipped with the shelf. index.html draws their covers as
// hand-written markup, so removing one leaves a card pointing at nothing.
const SEED_SLUGS = new Set(['beauty', 'fire', 'narnia', 'deadpool', 'hp6', 'lost', 'got', 'hobbit']);

function visitorId(req, res) {
  const raw = req.headers.cookie || '';
  const hit = raw
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + '='));

  if (hit) {
    const value = decodeURIComponent(hit.slice(COOKIE.length + 1));
    if (/^[0-9a-f-]{36}$/.test(value)) return value;
  }

  const fresh = randomUUID();
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
  );
  return fresh;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

/*
  Writes are open to every visitor, but only on their own shelf.

  The first attempt at this guard was a single admin password; that was replaced
  when the shelf became per-visitor. Ownership is now carried by the row
  (books.owner_id) and checked in getBook, so there is no shared secret to leak
  and no env var that can silently unlock the site.
*/

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const SELECT_COLUMNS =
  'slug, title, author, cat, cover, series, saved_at as "savedAt"';

async function listSaved(visitor) {
  const { rows } = await pool.query(
    `select ${SELECT_COLUMNS} from saved_books where visitor_id = $1 order by saved_at desc`,
    [visitor]
  );
  return rows;
}

async function upsertSaved(visitor, book) {
  const { rows } = await pool.query(
    `insert into saved_books (visitor_id, slug, title, author, cat, cover, series)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (visitor_id, slug) do nothing
     returning ${SELECT_COLUMNS}`,
    [visitor, book.slug, book.title, book.author ?? null, book.cat ?? null, book.cover ?? null, book.series ?? null]
  );
  return rows[0] ?? null;
}

async function deleteSaved(visitor, slug) {
  await pool.query('delete from saved_books where visitor_id = $1 and slug = $2', [visitor, slug]);
}

async function clearSaved(visitor) {
  await pool.query('delete from saved_books where visitor_id = $1', [visitor]);
}

// Column names are snake_case in Postgres and camelCase in books.js, because
// every page already reads the camelCase shape.
const BOOK_COLUMNS = `
  slug, label, title, author, cat,
  cat_slug    as "catSlug",
  cover, kicker,
  line1, line2, line3,
  cover_author as "coverAuthor",
  badge, series, pages, blurb, blurb2, edition,
  pdf_name    as "pdfName",
  pdf_size    as "pdfSize",
  pdf_added_at as "pdfAddedAt",
  sort_order  as "sortOrder"
`;

// The UI must not offer a delete button for a book the server would refuse, so the
// permission travels with the record instead of being guessed on the client.
//
// Only a book the visitor added themselves can be deleted. A shared book
// (ownerId null) is on everybody's shelf, so nobody may remove it: one visitor
// deleting it would take it off every other visitor's shelf too, along with the
// PDF on disk and every visitor's notes and reading position for it.
function withDeletable(book, visitor) {
  const { ownerId, ...rest } = book;
  const mine = ownerId !== null && ownerId === visitor;
  return {
    ...rest,
    owned: ownerId !== null,
    deletable: !SEED_SLUGS.has(book.slug) && mine
  };
}

// Who may see a book: the shared shelf (owner_id null — the eight drawn books
// and anything that predates ownership) plus a visitor's own additions.
const VISIBLE_TO = '(owner_id is null or owner_id = $1)';

async function listBooks(visitor) {
  const { rows } = await pool.query(
    `select ${BOOK_COLUMNS}, owner_id as "ownerId"
       from books
      where ${VISIBLE_TO}
      order by sort_order, id`,
    [visitor]
  );
  return rows.map((book) => withDeletable(book, visitor));
}

/*
  Looks a book up as this visitor is allowed to see it.

  A book someone else added is returned as null, exactly like a slug that does
  not exist. Every route above therefore gets the same answer for "not yours"
  and "never existed", which is what keeps other visitors' titles private — a
  403 would confirm the slug is real.
*/
async function getBook(slug, visitor) {
  const { rows } = await pool.query(
    `select ${BOOK_COLUMNS}, owner_id as "ownerId" from books where slug = $1`,
    [slug]
  );
  if (!rows[0]) return null;
  if (rows[0].ownerId !== null && rows[0].ownerId !== visitor) return null;
  return withDeletable(rows[0], visitor);
}

async function slugExists(slug) {
  const { rows } = await pool.query('select 1 from books where slug = $1', [slug]);
  return rows.length > 0;
}

// Categories are a closed set because the shelf's filter pills are hardcoded.
// Adding a new one here without adding a pill would create books that no filter
// can reach, so the mapping is explicit in both directions.
const CATEGORIES = {
  classic: 'Classics',
  fantasy: 'Fantasy and lore',
  graphic: 'Graphic novels',
  history: 'Historical'
};

/*
  Adds a book that has no PDF yet.

  A book can exist on the shelf without a file — that is what the eight seed
  books are — and the PDF is attached afterwards by POST /api/books/:slug/pdf.
  Keeping the two apart means a failed upload does not create a half-book.
*/
async function createBook(body, visitor) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const author = typeof body.author === 'string' ? body.author.trim() : '';

  if (!title || title.length > 300) {
    return { error: 'A title is required and must be under 300 characters.' };
  }
  if (!author || author.length > 200) {
    return { error: 'An author is required and must be under 200 characters.' };
  }

  const catSlug = typeof body.catSlug === 'string' ? body.catSlug.trim() : '';
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, catSlug)) {
    return {
      error: 'Pick a category: ' + Object.keys(CATEGORIES).join(', ') + '.'
    };
  }

  const pages = Number.isInteger(body.pages) && body.pages > 0 ? body.pages : null;
  const series = typeof body.series === 'string' && body.series.trim()
    ? body.series.trim().slice(0, 200)
    : null;
  const blurb = typeof body.blurb === 'string' && body.blurb.trim()
    ? body.blurb.trim().slice(0, 2000)
    : null;

  const slug = await uniqueSlug(title, slugExists);
  const lines = coverLines(title);

  const { rows } = await pool.query(
    `insert into books (
       slug, label, title, author, cat, cat_slug, cover, kicker,
       line1, line2, line3, cover_author, badge, series, pages,
       blurb, edition, sort_order, owner_id
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
       (select coalesce(max(sort_order), -1) + 1 from books),
       $18
     )
     returning ${BOOK_COLUMNS}`,
    [
      slug,
      title,
      title,
      author,
      CATEGORIES[catSlug],
      catSlug,
      // A new book has no hand-drawn cover, so it takes the neutral stone tone.
      // See .c-plain in index.html and book.html.
      'c-plain',
      // The kicker is the small line at the top of the cover. A series name is
      // the natural fit, but a standalone book has none, so the category label
      // keeps the cover from starting with an empty line.
      series || CATEGORIES[catSlug],
      lines.line1,
      lines.line2 || null,
      lines.line3 || null,
      author,
      null,
      series,
      pages,
      blurb,
      pages ? `Added from a PDF, ${pages} pages.` : 'Added from a PDF.',
      visitor
    ]
  );

  return { book: { ...rows[0], hasPdf: false } };
}

/*
  Percent is derived, never stored: page and total are the facts, so a rounded
  number cannot drift out of sync with them. The rule itself lives in
  lib/progress.js so it can be tested without booting the server.
*/
async function handleApi(req, res, url) {
  const visitor = visitorId(req, res);
  const path = url.pathname;

  if (path === '/api/saved' && req.method === 'GET') {
    return sendJson(res, 200, { saved: await listSaved(visitor) });
  }

  if (path === '/api/books' && req.method === 'GET') {
    return sendJson(res, 200, { books: await listBooks(visitor) });
  }

  // The generic :slug route must not swallow the sub-resources, so anything with
  // a known suffix is matched first and this one excludes them explicitly.
  const hasSubResource = /\/(pdf|notes|progress)(\/\d+)?$/.test(path);
  if (path.startsWith('/api/books/') && req.method === 'GET' && !hasSubResource) {
    const slug = decodeURIComponent(path.slice('/api/books/'.length));
    if (!/^[a-z0-9-]{1,64}$/i.test(slug)) return sendJson(res, 400, { error: 'Bad slug' });
    const book = await getBook(slug, visitor);
    if (!book) return sendJson(res, 404, { error: 'No such book' });
    return sendJson(res, 200, { book });
  }

  // ---- Reader state: notes and reading position ----
  //
  // Both are scoped to the visitor cookie, the same way bookmarks are. A note
  // belongs to the reader who wrote it; nothing here is shared between visitors.

  const notesMatch = path.match(/^\/api\/books\/([a-z0-9-]{1,64})\/notes$/i);
  if (notesMatch) {
    const slug = notesMatch[1];

    if (req.method === 'GET') {
      const book = await getBook(slug, visitor);
      if (!book) return sendJson(res, 404, { error: 'No such book' });
      const { rows } = await pool.query(
        `select id, page, body, quote, color, kind, rect, created_at as "createdAt"
           from notes
          where visitor_id = $1 and slug = $2
          order by created_at desc, id desc`,
        [visitor, slug]
      );
      return sendJson(res, 200, { notes: rows });
    }

    if (req.method === 'POST') {
      const book = await getBook(slug, visitor);
      if (!book) return sendJson(res, 404, { error: 'No such book' });

      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }

      const text = typeof body.body === 'string' ? body.body.trim() : '';
      const page = Number(body.page);
      const kind = ['highlight', 'bookmark'].includes(body.kind) ? body.kind : 'note';
      // Only a written note needs text. A highlight is a rectangle and a
      // bookmark is just a page marker, so both are allowed to be empty.
      if (kind === 'note' && !text) {
        return sendJson(res, 400, { error: 'A note needs some text.' });
      }
      if (text.length > 4000) {
        return sendJson(res, 400, { error: 'A note needs text of at most 4000 characters.' });
      }
      if (!Number.isInteger(page) || page < 1) {
        return sendJson(res, 400, { error: 'A note needs a page number.' });
      }

      const quote = typeof body.quote === 'string' && body.quote.trim()
        ? body.quote.trim().slice(0, 2000)
        : null;
      const color = ['yellow', 'coral', 'mint'].includes(body.color) ? body.color : null;

      // A scanned page has no text to select, so a highlight is a rectangle drawn
      // over the page. Coordinates are relative to the page box (0..1) so the mark
      // stays in place when the reader zooms or the window resizes.
      let rect = null;
      if (kind === 'highlight') {
        const r = body.rect;
        const nums = r && typeof r === 'object' ? [r.x, r.y, r.w, r.h] : [];
        if (nums.length !== 4 || !nums.every((v) => Number.isFinite(Number(v)))) {
          return sendJson(res, 400, { error: 'A highlight needs a rectangle (x, y, w, h).' });
        }
        const clamp = (v) => Math.min(1, Math.max(0, Number(v)));
        rect = { x: clamp(r.x), y: clamp(r.y), w: clamp(r.w), h: clamp(r.h) };
        if (rect.w <= 0.005 || rect.h <= 0.005) {
          return sendJson(res, 400, { error: 'That highlight is too small to keep.' });
        }
      }

      const { rows } = await pool.query(
        `insert into notes (visitor_id, slug, page, body, quote, color, kind, rect)
              values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id, page, body, quote, color, kind, rect, created_at as "createdAt"`,
        [visitor, slug, page, text, quote, color, kind, rect ? JSON.stringify(rect) : null]
      );
      return sendJson(res, 201, { note: rows[0] });
    }
  }

  const oneNoteMatch = path.match(/^\/api\/books\/([a-z0-9-]{1,64})\/notes\/(\d+)$/i);
  if (oneNoteMatch && req.method === 'DELETE') {
    const [slug, id] = [oneNoteMatch[1], Number(oneNoteMatch[2])];
    const { rowCount } = await pool.query(
      'delete from notes where id = $1 and visitor_id = $2 and slug = $3',
      [id, visitor, slug]
    );
    if (!rowCount) return sendJson(res, 404, { error: 'No such note' });
    return sendJson(res, 200, { deleted: id });
  }

  const progressMatch = path.match(/^\/api\/books\/([a-z0-9-]{1,64})\/progress$/i);
  if (progressMatch) {
    const slug = progressMatch[1];

    if (req.method === 'GET') {
      const { rows } = await pool.query(
        `select page, zoom, spread, total_pages as "totalPages",
                finished_at as "finishedAt", updated_at as "updatedAt"
           from reading_progress
          where visitor_id = $1 and slug = $2`,
        [visitor, slug]
      );
      return sendJson(res, 200, { progress: rows[0] ? withPercent(rows[0]) : null });
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const book = await getBook(slug, visitor);
      if (!book) return sendJson(res, 404, { error: 'No such book' });

      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }

      const page = Number(body.page);
      if (!Number.isInteger(page) || page < 1) {
        return sendJson(res, 400, { error: 'A page number is required.' });
      }
      const zoom = Number.isFinite(Number(body.zoom)) ? Math.round(Number(body.zoom)) : null;
      const spread = Boolean(body.spread);

      /*
        The page count comes from the PDF the reader has open, so the client
        sends it with every save. It is optional: an older cached reader keeps
        working, and a save without it stores a page but no percentage.

        finished_at is set once and never cleared. Re-reading a finished book
        from page 1 must not make the shelf claim it is unread.
      */
      const totalPages = Number.isInteger(Number(body.totalPages)) && Number(body.totalPages) > 0
        ? Number(body.totalPages)
        : null;

      const { rows } = await pool.query(
        `insert into reading_progress
                (visitor_id, slug, page, zoom, spread, total_pages, finished_at, updated_at)
              values ($1, $2, $3, $4, $5, $6,
                      case when $6::integer is not null and $3::integer >= $6::integer
                           then now() end,
                      now())
         on conflict (visitor_id, slug) do update
                 set page        = excluded.page,
                     zoom        = excluded.zoom,
                     spread      = excluded.spread,
                     total_pages = coalesce(excluded.total_pages, reading_progress.total_pages),
                     finished_at = case
                                     when reading_progress.finished_at is not null
                                       then reading_progress.finished_at
                                     when excluded.total_pages is not null
                                      and excluded.page >= excluded.total_pages
                                       then now()
                                     else reading_progress.finished_at
                                   end,
                     updated_at  = now()
           returning page, zoom, spread, total_pages as "totalPages",
                     finished_at as "finishedAt", updated_at as "updatedAt"`,
        [visitor, slug, page, zoom, spread, totalPages]
      );
      return sendJson(res, 200, { progress: withPercent(rows[0]) });
    }
  }

  // Every book this visitor has opened, newest first. The home page builds its
  // "continue reading" strip and the finished count from this.
  if (path === '/api/progress' && req.method === 'GET') {
    const { rows } = await pool.query(
      `select p.slug, p.page, p.total_pages as "totalPages",
              p.finished_at as "finishedAt", p.updated_at as "updatedAt",
              b.title, b.author, b.cover
         from reading_progress p
         join books b on b.slug = p.slug
        where p.visitor_id = $1
          and (b.owner_id is null or b.owner_id = $1)
        order by p.updated_at desc
        limit 50`,
      [visitor]
    );
    return sendJson(res, 200, { progress: rows.map(withPercent) });
  }

  if (path === '/api/books' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const result = await createBook(body, visitor);
    if (result.error) return sendJson(res, 400, { error: result.error });
    return sendJson(res, 201, { book: result.book });
  }

  // Deleting a book has to clear three things, or it leaves rubbish behind: the
  // row, the PDF on disk, and any bookmark pointing at the slug. The bookmark of a
  // deleted book would otherwise open a page that no longer exists.
  if (path.startsWith('/api/books/') && req.method === 'DELETE' && !path.endsWith('/pdf')) {
    const slug = decodeURIComponent(path.slice('/api/books/'.length));
    if (!/^[a-z0-9-]{1,64}$/i.test(slug)) return sendJson(res, 400, { error: 'Bad slug' });

    // The eight drawn books are the shelf's design: their covers are hand-built
    // markup in index.html. Deleting one would leave a card pointing nowhere, so
    // they are refused here rather than only hidden in the UI.
    if (SEED_SLUGS.has(slug)) {
      return sendJson(res, 409, {
        error: 'This book is part of the original shelf and cannot be deleted.'
      });
    }

    const book = await getBook(slug, visitor);
    if (!book) return sendJson(res, 404, { error: 'No such book' });

    /*
      A shared book cannot be deleted by anyone.

      It has no owner, so it sits on every visitor's shelf at once. Letting one
      visitor delete it would remove it from everybody else's shelf, unlink the
      PDF, and wipe every visitor's notes and reading position for it (the
      cleanup below filters by slug, not by visitor). This answers 409 rather
      than 404 because the book is not a secret: every visitor can already see
      it, so there is nothing to hide and the honest message is better.
    */
    if (!book.owned) {
      return sendJson(res, 409, {
        error: 'This book is on every visitor\'s shelf, so it cannot be deleted.'
      });
    }

    /*
      Someone else's book is reported as 404, not 403.

      A 403 would confirm the slug exists, which leaks the titles other visitors
      added. Deleting outside your own shelf is indistinguishable from deleting
      something that was never there.
    */
    if (!book.deletable) return sendJson(res, 404, { error: 'No such book' });

    const removedBookmarks = await pool.query(
      'delete from saved_books where slug = $1 returning id',
      [slug]
    );
    // Notes and reading positions belong to the deleted book too; leaving them
    // behind would show up again if a book with the same slug were re-added.
    await pool.query('delete from notes where slug = $1', [slug]);
    await pool.query('delete from reading_progress where slug = $1', [slug]);
    await pool.query('delete from books where slug = $1', [slug]);
    // The row is gone before the file is touched: a failed unlink leaves an
    // orphan file, which removePdf already tolerates, but a failed delete after
    // unlinking would leave a row pointing at a missing file.
    await removePdf(slug);

    return sendJson(res, 200, {
      deleted: slug,
      title: book.title,
      bookmarksRemoved: removedBookmarks.rowCount
    });
  }

  // Attach a PDF to an existing book. Separate from creating the book so a
  // failed upload never leaves a half-created record.
  const pdfMatch = path.match(/^\/api\/books\/([a-z0-9-]{1,64})\/pdf$/i);
  if (pdfMatch && req.method === 'POST') {
    const slug = pdfMatch[1];
    const book = await getBook(slug, visitor);
    if (!book) return sendJson(res, 404, { error: 'No such book' });

    /*
      Only the visitor's own additions take a PDF.

      Uploading to a shared book would let anyone replace the file behind it —
      the shelf's own books and everything added before ownership existed. Those
      stay read-only; a visitor attaches a PDF to the book they just created.
    */
    if (!book.owned) {
      return sendJson(res, 403, {
        error: 'A PDF can only be attached to a book you added yourself.'
      });
    }

    let uploaded;
    try {
      uploaded = await receivePdf(req, { destPath: pdfPath(slug) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const info = await pdfInfo(slug);
    const { rows } = await pool.query(
      `update books
          set pdf_name = $2, pdf_size = $3, pdf_added_at = now(), updated_at = now()
        where slug = $1
        returning ${BOOK_COLUMNS}`,
      [slug, slug + '.pdf', info ? info.size : uploaded.size]
    );

    return sendJson(res, 200, {
      book: rows[0],
      pdf: { size: info ? info.size : uploaded.size },
      hasPdf: true
    });
  }

  // The reader needs the bytes, not a JSON description of them.
  if (pdfMatch && req.method === 'GET') {
    const slug = pdfMatch[1];
    const book = await getBook(slug, visitor);
    if (!book) return sendJson(res, 404, { error: 'No such book' });

    const file = pdfPath(slug);
    let size;
    try {
      size = (await stat(file)).size;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return sendJson(res, 404, { error: 'This book has no PDF yet' });
      }
      throw err;
    }

    // PDF.js asks for byte ranges and reads a 32 MB book a chunk at a time.
    // Serving the whole file with Content-Length alone makes the reader wait for
    // the entire download before the first page appears.
    const range = req.headers.range;
    const headers = {
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      // inline so a reader can embed it; the filename is what a download uses.
      'Content-Disposition': `inline; filename="${slug}.pdf"`,
      'Cache-Control': 'no-cache'
    };

    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

      if (!Number.isFinite(start) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(file).pipe(res);
    return;
  }

  if (pdfMatch && req.method === 'DELETE') {
    const slug = pdfMatch[1];
    const book = await getBook(slug, visitor);
    if (!book) return sendJson(res, 404, { error: 'No such book' });

    if (!book.owned) {
      return sendJson(res, 403, {
        error: 'A PDF can only be removed from a book you added yourself.'
      });
    }

    await removePdf(slug);
    const { rows } = await pool.query(
      `update books
          set pdf_name = null, pdf_size = null, pdf_added_at = null, updated_at = now()
        where slug = $1
        returning ${BOOK_COLUMNS}`,
      [slug]
    );
    return sendJson(res, 200, { book: rows[0], hasPdf: false });
  }

  if (path === '/api/saved' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    const { book, error } = validateBook(body);
    if (error) return sendJson(res, 400, { error });

    const inserted = await upsertSaved(visitor, book);
    if (!inserted) {
      // Already saved: POST is a toggle, so a repeat press removes it.
      await deleteSaved(visitor, book.slug);
      return sendJson(res, 200, { saved: false, savedList: await listSaved(visitor) });
    }
    return sendJson(res, 201, { saved: true, item: inserted, savedList: await listSaved(visitor) });
  }

  if (path === '/api/saved' && req.method === 'DELETE') {
    await clearSaved(visitor);
    return sendJson(res, 200, { savedList: [] });
  }

  if (path.startsWith('/api/saved/') && req.method === 'DELETE') {
    const slug = decodeURIComponent(path.slice('/api/saved/'.length));
    if (!/^[a-z0-9-]{1,64}$/i.test(slug)) return sendJson(res, 400, { error: 'Bad slug' });
    await deleteSaved(visitor, slug);
    return sendJson(res, 200, { savedList: await listSaved(visitor) });
  }

  return sendJson(res, 404, { error: 'No such endpoint' });
}

async function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;

  // PDF.js ships its own files inside node_modules. They are served from one
  // fixed directory and never from a path the request controls, so this cannot
  // be used to read anything outside it.
  let file;
  if (target.startsWith('/vendor/pdfjs/')) {
    const name = target.slice('/vendor/pdfjs/'.length);
    if (!/^[a-z0-9.-]+$/i.test(name)) return false;
    file = join(ROOT, 'node_modules', 'pdfjs-dist', 'build', name);
  } else if (PAGES.has(target)) {
    file = join(ROOT, normalize(target).replace(/^([/\\])+/, ''));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return false;
  } else {
    return false;
  }

  let body;
  let mtimeHex = '0';
  try {
    const info = await stat(file);
    mtimeHex = Math.round(info.mtimeMs).toString(16);
    body = await readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }

  // The worker is a module, and the main bundle imports it by relative name.
  const type = target.endsWith('.mjs') || target.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : (MIME[extname(file)] || 'application/octet-stream');

  /*
    These pages are edited and redeployed often, and the browser cannot tell a
    new copy from an old one unless it asks. A day-long max-age meant a returning
    visitor kept running yesterday's reader.html and index.html: the page and the
    percentage it saves, and the card that shows them, were deployed but never
    reached the browser that had already cached the files. no-cache keeps the
    copy, so the common case is still a cheap 304, but it always revalidates
    first. The pdf.js bundle under /vendor/pdfjs/ is a versioned third-party
    asset and keeps the long cache.
  */
  const isPdfJs = target.startsWith('/vendor/pdfjs/');

  // A redeploy changes the file, so the same ETag must not outlive it: the mtime
  // is part of the tag. 304 keeps a repeat visit cheap.
  const etag = '"' + body.length.toString(16) + '-' + mtimeHex + '"';
  const inm = req.headers['if-none-match'];
  const head = {
    'Content-Type': type,
    'Cache-Control': isPdfJs ? 'public, max-age=86400' : 'no-cache',
    ETag: etag
  };
  if (!isPdfJs && inm && inm.split(',').some((tag) => tag.trim() === etag)) {
    res.writeHead(304, head);
    res.end();
    return true;
  }

  res.writeHead(200, { ...head, 'Content-Length': body.length });
  res.end(body);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (await serveStatic(req, res, url.pathname)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.end();
  }
});

await migrate();
await ensureStorage();
server.listen(PORT, () => {
  // A test server asks for port 0 and needs the port it actually got.
  const address = server.address();
  console.log(`PERPUS on http://localhost:${address && address.port ? address.port : PORT}`);
});

export { server };
