import { pool, migrate } from '../db/index.js';

try {
  await migrate();
  const { rows } = await pool.query(
    "select to_regclass('public.saved_books') as table, (select count(*) from saved_books) as rows"
  );
  console.log('Migration applied. Table:', rows[0].table, '| rows on hand:', rows[0].rows);
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
