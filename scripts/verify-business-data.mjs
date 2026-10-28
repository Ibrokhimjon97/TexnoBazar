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
  const tables = [
    'products', 'product_variants', 'stock_batches', 'inventory_units', 
    'sales', 'sale_lines', 'pos_pending_sales', 'customers', 
    'branches', 'expenses', 'categories', 'brands'
  ];
  const counts = [];
  for (const t of tables) {
    const res = await client.query(`SELECT count(*) as count FROM public.${t}`);
    counts.push({ table: t, count: res.rows[0].count });
  }
  console.table(counts);
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
