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

async function run() {
  await client.connect();
  const q1 = await client.query(`
    SELECT 
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, 
      count(*) as cnt,
      round(sum(pg_column_size(row(audit_log.*)))::numeric / 1024 / 1024, 2) as estimated_mb
    FROM public.audit_log 
    GROUP BY 1 
    ORDER BY 1 ASC
  `);
  console.log('Daily audit distribution:');
  console.table(q1.rows);
  
  const total = await client.query(`
    SELECT 
      pg_size_pretty(pg_total_relation_size('public.audit_log')) as total_audit_size,
      pg_size_pretty(pg_database_size(current_database())) as total_db_size,
      (SELECT count(*) FROM public.audit_log) as total_rows
  `);
  console.log('Total overview:', total.rows[0]);
  
  const tables = await client.query(`
    SELECT 
      entity_table,
      action,
      count(*) as cnt
    FROM public.audit_log
    GROUP BY 1, 2
    ORDER BY 3 DESC
  `);
  console.log('Breakdown by table and action:');
  console.table(tables.rows);

  await client.end();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
