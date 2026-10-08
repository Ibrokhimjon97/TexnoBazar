import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const envContent = fs.readFileSync(path.join(root, '.env.local'), 'utf-8');
const match = envContent.match(/^SUPABASE_DB_URL=(.+)$/m);
if (!match) {
  console.error('SUPABASE_DB_URL topilmadi');
  process.exit(1);
}
let dbUrl = match[1].trim().replace(/^["']|["']$/g, '').split('?')[0];
if (dbUrl.includes(':5432')) {
  dbUrl = dbUrl.replace(':5432', ':6543');
}

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function run() {
  await client.connect();
  console.log('PostgreSQL ga ulanish muvaffaqiyatli.');

  const migPath = path.join(root, 'supabase/migrations/20260938000000_bulk_and_category_delete.sql');
  const sql = fs.readFileSync(migPath, 'utf-8');

  console.log('20260938000000_bulk_and_category_delete.sql qo\'llanilmoqda...');
  await client.query(sql);
  console.log('✅ delete_products_cascade va delete_category_products_cascade muvaffaqiyatli qo\'shildi!');

  await client.end();
}

run().catch(err => {
  console.error('Xatolik:', err);
  process.exit(1);
});
