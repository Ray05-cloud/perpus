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

Writes (`POST`/`DELETE` on books and PDFs) require the `x-admin-password`
header to match `ADMIN_PASSWORD`. If `ADMIN_PASSWORD` is unset the server
refuses every write with `503` rather than allowing them — a public URL must
never default to open. Reads stay public.

## Deploy

Pushes to `main` deploy automatically to Railway. Persistent uploads need the
volume mounted at `/data` with `PDF_STORAGE_DIR=/data/pdf`.
