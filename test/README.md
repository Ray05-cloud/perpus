# Tests

`npm test` runs everything. The suite has two halves and only the second one
needs a database.

## Pure logic — always runs

`slug.test.js`, `progress.test.js`, `validate.test.js`. These import functions
from `lib/`, which touch nothing but their arguments. Fast, no setup.

## API — needs a test database

`api.test.js` starts the real server on a random port and talks to it with
`fetch`, against a real Postgres. It covers the things unit tests cannot see:
who is allowed to read or delete a book, what status code a stranger gets, what
happens to a bookmark when its book is deleted.

These tests **drop every table** at the start of the run. That is why they need
a database of their own.

### One-time setup on Neon

1. Neon console → your project → **Databases** → **New Database**, name it
   `perpus_test`. Or from SQL:

   ```sql
   create database perpus_test;
   ```

2. Copy the connection string for `perpus_test` and put it in `.env`:

   ```
   TEST_DATABASE_URL="postgresql://...@ep-xxxx-pooler.../perpus_test?sslmode=require"
   ```

   Only the database name at the end changes from `DATABASE_URL`.

3. `npm test`.

Nothing else to run: the helper applies `db/schema.sql` itself.

### Without it

Leave `TEST_DATABASE_URL` unset and those 25 tests report as skipped with the
reason attached. `npm test` still passes, so a fresh clone works before anyone
has set up a database.

### Safety rails

- `test/helpers/db.js` compares the database *name* in `TEST_DATABASE_URL` with
  the one in `DATABASE_URL` and throws if they match. Dropping production tables
  during a test run is not a risk worth leaving to discipline.
- It never falls back to `DATABASE_URL`. No test URL means no API tests.
- The schema comes from `db/schema.sql`, the same file a deploy uses, so a broken
  migration fails here first.

### Running one file

```bash
node --test test/api.test.js
```

On Windows with Git Bash, the inline env var works in one line:

```bash
TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env | cut -d= -f2- | tr -d '\"')" node --test test/api.test.js
```
