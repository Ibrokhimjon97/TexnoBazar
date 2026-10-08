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
    select udt_name, data_type 
    from information_schema.columns 
    where table_schema = 'public' and table_name = 'products' and column_name = 'status';
  `);
  console.log('STATUS COLUMN TYPE:', res.rows);

  const enumVals = await client.query(`
    select enumlabel from pg_enum 
    where enumtypid = (select oid from pg_type where typname = $1)
  `, [res.rows[0].udt_name]);
  console.log('ENUM VALUES:', enumVals.rows.map(r => r.enumlabel));

  await client.end();
}

run().catch(console.error);
