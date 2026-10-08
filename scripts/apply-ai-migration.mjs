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
  console.log('PostgreSQL ga ulanish muvaffaqiyatli o\'rnatildi.');

  const migPath = path.join(root, 'supabase/migrations/20260936000000_ai_advanced_operations.sql');
  const sql = fs.readFileSync(migPath, 'utf-8');

  console.log('20260936000000_ai_advanced_operations.sql qo\'llanilmoqda...');
  await client.query(sql);
  console.log('✅ Migratsiya muvaffaqiyatli Supabase bazasiga qo\'llandi!');

  const res = await client.query(`
    select routine_name 
    from information_schema.routines 
    where routine_schema = 'public' and routine_name like 'ai_%'
    order by routine_name;
  `);
  console.log('Bazadagi barcha AI RPC funksiyalari:', res.rows.map(r => r.routine_name));

  await client.end();
}

run().catch(err => {
  console.error('Xatolik yuz berdi:', err);
  process.exit(1);
});
