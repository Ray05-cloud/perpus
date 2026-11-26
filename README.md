# PERPUS

Personal reading room: a static shelf plus a small Node backend backed by
Neon Postgres. Books live in the database, PDFs live on disk, bookmarks are
per-visitor.

Live: https://perpus-production-e7ced382.up.railway.app

## Pages

| File | Purpose |
|---|---|
| `index.html` | Shelf: carousel, category filter, search, bookmark toggle |
| `book.html` | Book detail (`?slug=`), bookmark, delete (own books only), open PDF |
| `add.html` | Add a book, with optional PDF upload and progress |
| `bookmarks.html` | Saved stories list |
| `reader.html` | PDF reader |

## Run locally

```bash
npm install
cp .env.example .env    # fill DATABASE_URL
npm run db:migrate
npm run seed:books
npm start               # http://localhost:3000
```

`DATABASE_URL` points at a Neon Postgres database. `PDF_STORAGE_DIR` overrides
where uploaded PDFs are written (defaults to `storage/pdf/`).

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/books` | All books |
| `GET /api/books/:slug` | One book |
| `POST /api/books` | Create a book |
| `POST /api/books/:slug/pdf` | Attach a PDF |
| `GET /api/books/:slug/pdf` | Download a PDF |
| `DELETE /api/books/:slug` | Delete book, its PDF, and its bookmarks (409 for the eight seed books) |
| `GET/POST/DELETE /api/saved` | Visitor bookmarks, scoped by the `perpus_vid` cookie |

## Shelves are per visitor

Every visitor gets their own shelf. A book added through `add.html` is listed
only for the visitor who added it, and only they can delete it or attach a PDF.

Ownership is carried by `books.owner_id`. `NULL` means shared: the eight drawn
books and anything added before ownership existed stay visible to everyone, and
read-only — no visitor can delete a shared book, because it is not only on their
shelf. Removing it would unlink the PDF and wipe every visitor's notes and
reading position for it.

Deleting is therefore limited to books you added yourself. The eight drawn books
answer `409` (they are the shelf's design), and any other shared book answers
`409` too.

Identity comes from the `perpus_vid` cookie, the same one bookmarks use — there
are no accounts. Clearing cookies therefore starts a fresh shelf; books from the
old identity stay in the database but are not listed.

A book owned by someone else answers `404` (not `403`) on every route, so slugs
do not leak the titles other visitors added. Attaching or removing a PDF on a
shared book is refused with `403`.

## Tests

```bash
npm test
```

Two layers, one command:

| Layer | What it covers | Needs a database |
|---|---|---|
| `test/slug.test.js`, `progress.test.js`, `validate.test.js` | Pure logic: slugs, progress percentages, request validation | no |
| `test/api.test.js` | Real HTTP requests against a real Postgres: ownership, bookmarks, progress, notes, status codes | yes |

The API tests run only when `TEST_DATABASE_URL` is set, and skip themselves
with a reason when it is not. They drop and rebuild every table from
`db/schema.sql` before each run, so they need their own database — never the one
the app reads from. `test/helpers/db.js` refuses to start if
`TEST_DATABASE_URL` names the same database as `DATABASE_URL`.

See `test/README.md` for creating that database on Neon.

## Deploy

Pushes to `main` deploy automatically to Railway. Persistent uploads need the
volume mounted at `/data` with `PDF_STORAGE_DIR=/data/pdf`.
