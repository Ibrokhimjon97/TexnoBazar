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
const client = new pg.Client({ 
  connectionString: env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Please specify SQL file');
    process.exit(1);
  }
  const sql = fs.readFileSync(file, 'utf8');
  await client.connect();
  console.log('Applying migration:', file);
  await client.query(sql);
  console.log('Migration applied successfully!');
  await client.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
