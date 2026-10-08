import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const envContent = fs.readFileSync(path.join(root, '.env.local'), 'utf-8');
const match = envContent.match(/^SUPABASE_DB_URL=(.+)$/m);
let dbUrl = match[1].trim().replace(/^["']|["']$/g, '').split('?')[0];

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();
  const tables = await client.query(`
    select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name;
  `);
  console.log('ALL TABLES:', tables.rows.map(r => r.table_name));

  const variantCols = await client.query(`
    select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'product_variants';
  `);
  console.log('PRODUCT_VARIANTS COLS:', variantCols.rows);

  await client.end();
}

run().catch(console.error);
