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
  await client.connect();
  const sql = process.argv[2] || "SELECT version()";
  const res = await client.query(sql);
  if (res.rows) {
    console.log(JSON.stringify(res.rows, null, 2));
  } else {
    console.log('Command executed successfully');
  }
  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
