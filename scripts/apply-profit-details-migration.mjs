import pg from 'pg';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

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

let dbUrl = (env.SUPABASE_DB_URL || '').split('?')[0].replace(':5432', ':6543');
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  console.log('Connected to PostgreSQL database.');

  const migrationFile = '20261026000000_get_pos_confirmed_profit_details.sql';
  const sql = fs.readFileSync(`supabase/migrations/${migrationFile}`, 'utf8');

  console.log(`Applying ${migrationFile}...`);
  await client.query('RESET ROLE;');
  await client.query(sql);
  console.log(`✅ SQL applied successfully.`);

  const version = '20261026000000';
  const name = 'get_pos_confirmed_profit_details';

  try {
    await client.query(`
      INSERT INTO supabase_migrations.schema_migrations(version, name)
      VALUES ($1, $2)
      ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name
    `, [version, name]);
    console.log(`✅ Recorded in supabase_migrations.schema_migrations: ${version} (${name})`);
  } catch (err) {
    console.warn('⚠️ Record migration error:', err.message);
  }

  console.log('Reloading PostgREST schema cache...');
  await client.query("NOTIFY pgrst, 'reload schema';");
  await client.query("NOTIFY pgrst, 'reload config';");
  console.log("✅ Sent NOTIFY pgrst, 'reload schema' and 'reload config'");

  await new Promise(r => setTimeout(r, 2000));
  await client.end();

  // Test RPC via Supabase JS client
  console.log('\n--- Testing RPC get_pos_confirmed_profit_details via PostgREST ---');
  const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
  const testBranchId = '7a3efcd0-0824-411a-b4f8-38be9c194950';
  const { data, error } = await supabase.rpc('get_pos_confirmed_profit_details', {
    p_branch_id: testBranchId,
    p_start_date: '2026-10-27',
    p_end_date: '2026-10-27'
  });

  if (error) {
    console.error('❌ PostgREST RPC error:', error);
  } else {
    console.log('✅ PostgREST RPC call SUCCESSFUL!');
    console.log('Summary:', data.summary);
    console.log('Total items returned:', data.items?.length);
    console.log('First item:', data.items?.[0]);
  }
}

main().catch(console.error);
