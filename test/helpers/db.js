/*
  Test database.

  The API tests must never touch the shelf Rey actually reads from, so they run
  against a separate database. This module is the only place that knows where it
  is and how to reset it.

  Two things it will not do:

  - run against the same database as the app. If TEST_DATABASE_URL points at the
    same database name as DATABASE_URL, it throws. A test suite that deletes rows
    from the wrong database is not a mistake worth leaving to a comment.
  - guess a connection. There is no default, no fallback to DATABASE_URL. Without
    TEST_DATABASE_URL the API tests skip themselves with a reason, so `npm test`
    still works on a machine that has no test database set up.
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export function testDatabaseUrl() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env on disk: rely on the real environment.
  }
  return process.env.TEST_DATABASE_URL || '';
}

function databaseName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

export function guardAgainstProduction(testUrl, appUrl) {
  const test = databaseName(testUrl);
  const app = databaseName(appUrl);
  if (!test) {
    throw new Error('TEST_DATABASE_URL is not a valid database URL.');
  }
  if (test === app) {
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL points at "${test}", the same database ` +
        'the app uses. Point it at a separate database.'
    );
  }
}

export function hasTestDatabase() {
  const url = testDatabaseUrl();
  if (!url) return false;
  try {
    guardAgainstProduction(url, process.env.DATABASE_URL || '');
    return true;
  } catch {
    return false;
  }
}

/*
  A pool for the test database, plus the two helpers the tests need.

  reset() drops every table and rebuilds from db/schema.sql, so each test file
  starts from a known empty shelf. It is slower than truncating, but it also
  proves the schema file still works on an empty database, which is exactly what
  a deploy does.
*/
export async function openTestPool() {
  const url = testDatabaseUrl();
  guardAgainstProduction(url, process.env.DATABASE_URL || '');

  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('sslmode=require') || url.includes('sslmode=verify-full')
      ? { rejectUnauthorized: false }
      : undefined,
    max: 3
  });

  pool.on('error', (err) => {
    console.error('Idle test Postgres client error:', err.message);
  });

  return pool;
}

export async function resetSchema(pool) {
  await pool.query(`
    drop table if exists notes cascade;
    drop table if exists reading_progress cascade;
    drop table if exists saved_books cascade;
    drop table if exists books cascade;
  `);
  // This file sits in test/helpers/, so the schema is two levels up.
  const sql = readFileSync(fileURLToPath(new URL('../../db/schema.sql', import.meta.url)), 'utf8');
  await pool.query(sql);
}

/*
  Starts the real HTTP server against the test database.

  The server module runs migrate() and listen() on import, and reads
  DATABASE_URL when it does, so the environment has to be swapped before the
  import happens. That is why this is a dynamic import and not a top-level one.
*/
export async function startTestServer(pool) {
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.PORT = '0';
  const { server } = await import('../../server.js');
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    pool
  };
}
