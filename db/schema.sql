-- Schema for PERPUS.
--
-- books: the shelf itself. It moved out of books.js so a book can be added
-- without editing code. Every field the pages render is a column here,
-- including the three cover lines, because the cover is drawn in CSS from text
-- instead of being loaded as an image.
--
-- saved_books: one row per (visitor, book). The book metadata is denormalised
-- on purpose: a saved row keeps the title and cover it was saved with even if
-- the shelf row is edited later.

create table if not exists books (
  id            bigint generated always as identity primary key,
  slug          text        not null unique,
  label         text        not null,
  title         text        not null,
  author        text        not null,
  cat           text        not null,
  cat_slug      text        not null,
  cover         text        not null,
  kicker        text,
  line1         text,
  line2         text,
  line3         text,
  cover_author  text,
  badge         text,
  series        text,
  pages         integer,
  blurb         text,
  blurb2        text,
  edition       text,
  pdf_name      text,
  pdf_size      bigint,
  pdf_added_at  timestamptz,
  sort_order    integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The shelf is always rendered in shelf order.
create index if not exists books_sort_order_idx on books (sort_order, id);

-- The filter pills match on category, so that lookup gets its own index.
create index if not exists books_cat_slug_idx on books (cat_slug);

create table if not exists saved_books (
  id          bigint generated always as identity primary key,
  visitor_id  text        not null,
  slug        text        not null,
  title       text        not null,
  author      text,
  cat         text,
  cover       text,
  series      text,
  saved_at    timestamptz not null default now(),
  constraint saved_books_visitor_slug_key unique (visitor_id, slug)
);

-- bookmarks.html lists newest first for one visitor.
create index if not exists saved_books_visitor_saved_at_idx
  on saved_books (visitor_id, saved_at desc);

-- Columns added after the table was first created.
--
-- "create table if not exists" does nothing to a table that already exists, so
-- a column added to the create statement above never reaches a live database.
-- Anything new therefore also needs an explicit alter here, written so that
-- re-running the whole file stays harmless.
alter table books add column if not exists pdf_name     text;
alter table books add column if not exists pdf_size     bigint;
alter table books add column if not exists pdf_added_at timestamptz;

-- Reading state for the PDF reader. One row per visitor per book.
--
-- notes and highlights are separate because they behave differently: a note is
-- text the reader wrote, a highlight marks a passage in the PDF. Both point at a
-- page so the reader can jump back to them, and a highlight also carries the
-- colour and the quoted text so the panel can show it without re-reading the PDF.
create table if not exists reading_progress (
  visitor_id  text        not null,
  slug        text        not null,
  page        integer     not null default 1,
  zoom        integer,
  spread      boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (visitor_id, slug)
);

create table if not exists notes (
  id          bigint generated always as identity primary key,
  visitor_id  text        not null,
  slug        text        not null,
  page        integer     not null,
  body        text        not null,
  quote       text,
  color       text,
  kind        text        not null default 'note',
  created_at  timestamptz not null default now()
);

-- The panel lists newest first for one visitor and one book.
create index if not exists notes_visitor_slug_created_idx
  on notes (visitor_id, slug, created_at desc);

-- A highlight on a scanned page marks an area, not a range of characters, because
-- there is no text layer to select. The rectangle is stored in page-relative
-- coordinates (0..1) so it survives zoom, spread and window resizing.
alter table notes add column if not exists rect jsonb;
