import pg from 'pg';
import fs from 'fs';

const envText = fs.readFileSync('.env.local', 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx !== -1) {
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let dbUrl = env.SUPABASE_DB_URL;
if (dbUrl && dbUrl.includes(':5432')) {
  dbUrl = dbUrl.replace(':5432', ':6543');
}

const client = new pg.Client({ 
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();

  const daysToKeep = parseInt(process.argv[2] || '7', 10);
  console.log(`Pruning audit_log records older than ${daysToKeep} days...`);

  // Check stats before
  const beforeRes = await client.query(`
    SELECT 
      pg_size_pretty(pg_total_relation_size('public.audit_log')) as audit_size_before,
      pg_size_pretty(pg_database_size(current_database())) as db_size_before,
      (SELECT count(*) FROM public.audit_log) as total_rows_before,
      (SELECT count(*) FROM public.audit_log WHERE created_at < now() - interval '${daysToKeep} days') as rows_to_delete
  `);
  console.log('Before cleanup:', beforeRes.rows[0]);

  // Execute deletion in a transaction setting the cleanup flag
  await client.query('BEGIN');
  await client.query("SELECT set_config('texnobazar.audit_cleanup', 'allowed', true)");
  const deleteRes = await client.query(
    `DELETE FROM public.audit_log WHERE created_at < now() - interval '${daysToKeep} days'`
  );
  console.log(`Deleted rows: ${deleteRes.rowCount}`);
  await client.query('COMMIT');

  console.log('Running VACUUM FULL public.audit_log (reclaiming physical disk space)...');
  await client.query('VACUUM FULL public.audit_log');
  console.log('VACUUM FULL completed successfully.');

  // Check stats after
  const afterRes = await client.query(`
    SELECT 
      pg_size_pretty(pg_total_relation_size('public.audit_log')) as audit_size_after,
      pg_size_pretty(pg_database_size(current_database())) as db_size_after,
      (SELECT count(*) FROM public.audit_log) as total_rows_after
  `);
  console.log('After cleanup & VACUUM:', afterRes.rows[0]);

  await client.end();
}

main().catch(err => {
  console.error('Error during prune and vacuum:', err);
  process.exit(1);
});
