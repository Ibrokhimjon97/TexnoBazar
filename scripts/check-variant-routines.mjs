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
  const res = await client.query(`
    select routine_name, routine_type from information_schema.routines 
    where routine_schema = 'public' and routine_name like '%variant%';
  `);
  console.log('VARIANT ROUTINES:', res.rows);
  await client.end();
}

run().catch(console.error);
