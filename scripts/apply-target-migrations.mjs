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

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let dbUrl = (env.SUPABASE_DB_URL || '').split('?')[0];
if (dbUrl.includes(':5432')) {
  dbUrl = dbUrl.replace(':5432', ':6543');
}

const client = new pg.Client({ 
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

const TARGET_MIGRATIONS = [
  '20261011000000_fix_receive_stock_and_update_stock_receipt_schema.sql',
  '20261012000000_fix_delivery_accept_cash_sale_payments_immutable.sql',
  '20261013000000_add_product_names_to_pending_sales.sql',
  '20261014000000_cascade_product_prices_to_variants_and_all_batches.sql',
  '20261015000000_fix_cash_period_stats_and_all_time_filter.sql',
  '20261016000000_fix_exchange_rate_sync_minimum_price_constraint.sql',
  '20261017000000_add_printed_status_and_date_filter_to_pos_deliveries.sql',
  '20261018000000_add_pos_cash_expenses_and_summary.sql',
  '20261019000000_auto_substitute_unavailable_pos_units.sql',
  '20261020000000_fix_pos_cash_expense_timezone.sql',
  '20261021000000_cash_expense_payment_method_and_search_filter_enhancements.sql',
  '20261022000000_audit_log_pruning_support.sql',
  '20261023000000_audit_prune_1day_support.sql',
  '20261024000000_fix_price_sync_cost_timestamp_and_cash_profit.sql',
  '20261025000000_smart_fuzzy_and_normalized_product_search.sql'
];

async function applyMigrations() {
  await client.connect();
  console.log('Connected to PostgreSQL successfully.');

  for (const filename of TARGET_MIGRATIONS) {
    const filePath = `supabase/migrations/${filename}`;
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found: ${filePath}, skipping.`);
      continue;
    }

    const version = filename.split('_')[0];
    const name = filename.replace(`${version}_`, '').replace('.sql', '');

    console.log(`\n--- [MIGRATION START] ${filename} ---`);
    const sql = fs.readFileSync(filePath, 'utf8');

    await client.query('RESET ROLE;');
    await client.query(sql);
    console.log(`✅ SQL applied for ${filename}`);

    // Record in supabase_migrations.schema_migrations if table exists
    try {
      await client.query(`
        INSERT INTO supabase_migrations.schema_migrations(version, name)
        VALUES ($1, $2)
        ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name
      `, [version, name]);
      console.log(`✅ Recorded in supabase_migrations.schema_migrations: ${version} (${name})`);
    } catch (recErr) {
      console.warn(`⚠️ Failed to record migration version (non-fatal):`, recErr.message);
    }
  }

  // Reload PostgREST schema cache explicitly
  console.log('\n--- Reloading PostgREST Schema Cache ---');
  await client.query("NOTIFY pgrst, 'reload schema';");
  await client.query("NOTIFY pgrst, 'reload config';");
  console.log("✅ Sent NOTIFY pgrst, 'reload schema' and 'reload config'");

  // Wait 2 seconds for PostgREST cache reload
  await new Promise(r => setTimeout(r, 2000));

  await client.end();
  console.log('\nPostgreSQL connection closed.');

  // Test receive_stock via PostgREST
  console.log('\n--- Testing receive_stock via Supabase PostgREST ---');
  const supabaseUrl = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase.rpc('receive_stock', {
    p_header: {},
    p_lines: [],
    p_idempotency_key: '00000000-0000-0000-0000-000000000000'
  });

  console.log('PostgREST RPC response:', { data, error });
  if (error && error.message === 'Kamida bitta tovar qatori kiritilishi shart') {
    console.log('🎉 Verification SUCCESS: PostgREST schema cache is fresh and receive_stock is operational!');
  } else if (error && error.code === 'PGRST202') {
    console.error('❌ Schema cache still outdated:', error);
  } else {
    console.log('Result evaluated:', error?.message || 'Success');
  }
}

applyMigrations().catch(err => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
