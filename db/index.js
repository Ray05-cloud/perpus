import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

function loadEnv() {
  try {
    process.loadEnvFile();
  } catch {
    // No .env on disk: rely on the real environment (deploy targets set it there).
  }
}

loadEnv();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and paste the Neon connection string.'
  );
}

// Neon needs TLS. rejectUnauthorized:false is what their own docs use, because
// the pooler presents a certificate signed by a CA Node does not ship with.
export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  max: 5
});

pool.on('error', (err) => {
  console.error('Idle Postgres client error:', err.message);
});

export async function migrate() {
  const sql = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}
