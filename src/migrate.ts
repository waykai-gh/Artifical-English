import { readConfig } from './config.js';
import { createPool, migrate } from './storage.js';

async function main() {
  const pool = createPool(readConfig().DATABASE_URL);
  try { await migrate(pool); console.log('PostgreSQL schema is ready.'); }
  finally { await pool.end(); }
}
main().catch(() => { console.error('Migration failed. Check DATABASE_URL and PostgreSQL availability.'); process.exitCode = 1; });
