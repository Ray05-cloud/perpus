/*
  Copies the eight original books into the books table.

  The source is db/books.seed.json, a snapshot taken from books.js before that
  file started reading from the database. The shelf in Postgres is therefore
  identical to the one the pages used to render, and the seed stays runnable
  after books.js no longer contains any book data.

  Safe to re-run: slug is unique, so a second run updates instead of
  duplicating.
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool, migrate } from '../db/index.js';

const SEED_JSON = fileURLToPath(new URL('../db/books.seed.json', import.meta.url));

// The page label for a category is not the same string as the filter pill's
// data-cat value, and index.html filters on the latter.
const CAT_SLUG = {
  Classics: 'classic',
  'Fantasy and lore': 'fantasy',
  'Graphic novels': 'graphic',
  Historical: 'history'
};

function loadShelf() {
  const shelf = JSON.parse(readFileSync(SEED_JSON, 'utf8'));
  if (!Array.isArray(shelf.order) || !Array.isArray(shelf.books)) {
    throw new Error('db/books.seed.json must have "order" and "books" arrays');
  }
  const bySlug = new Map(shelf.books.map((book) => [book.slug, book]));
  const missing = shelf.order.filter((slug) => !bySlug.has(slug));
  if (missing.length) throw new Error('order references unknown slugs: ' + missing.join(', '));
  return { order: shelf.order, bySlug };
}

const shelf = loadShelf();

await migrate();

const client = await pool.connect();
let written = 0;

try {
  await client.query('begin');

  for (const [index, slug] of shelf.order.entries()) {
    const book = shelf.bySlug.get(slug);
    const catSlug = CAT_SLUG[book.cat];
    if (!catSlug) throw new Error(`No filter slug for category "${book.cat}" (${slug})`);

    await client.query(
      `insert into books (
         slug, label, title, author, cat, cat_slug, cover, kicker,
         line1, line2, line3, cover_author, badge, series, pages,
         blurb, blurb2, edition, sort_order
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       )
       on conflict (slug) do update set
         label        = excluded.label,
         title        = excluded.title,
         author       = excluded.author,
         cat          = excluded.cat,
         cat_slug     = excluded.cat_slug,
         cover        = excluded.cover,
         kicker       = excluded.kicker,
         line1        = excluded.line1,
         line2        = excluded.line2,
         line3        = excluded.line3,
         cover_author = excluded.cover_author,
         badge        = excluded.badge,
         series       = excluded.series,
         pages        = excluded.pages,
         blurb        = excluded.blurb,
         blurb2       = excluded.blurb2,
         edition      = excluded.edition,
         sort_order   = excluded.sort_order,
         updated_at   = now()`,
      [
        book.slug,
        book.label,
        book.title,
        book.author,
        book.cat,
        catSlug,
        book.cover,
        book.kicker ?? null,
        book.line1 ?? null,
        book.line2 ?? null,
        book.line3 ?? null,
        book.coverAuthor ?? null,
        book.badge ?? null,
        book.series ?? null,
        book.pages ?? null,
        book.blurb ?? null,
        book.blurb2 ?? null,
        book.edition ?? null,
        index
      ]
    );
    written += 1;
  }

  await client.query('commit');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  client.release();
}

const { rows } = await pool.query(
  `select slug, cat_slug, pages, sort_order
     from books
    order by sort_order, id`
);

console.log(`Seeded ${written} books from db/books.seed.json.`);
console.table(rows);
console.log(
  'Categories in use:',
  [...new Set(rows.map((r) => r.cat_slug))].join(', ')
);

await pool.end();
