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
  // Superadmin user ID
  await client.query("SELECT set_config('request.jwt.claim.sub', '007c2ea8-0b98-493a-bc90-0d1b0557f25e', false)");
  
  console.log('--- TEST 1: ai_today_attendance ---');
  const r1 = await client.query('SELECT public.ai_today_attendance(null)');
  console.log(JSON.stringify(r1.rows[0].ai_today_attendance, null, 2));

  console.log('\n--- TEST 2: ai_employee_attendance_detail (Sotuvchi) ---');
  const r2 = await client.query('SELECT public.ai_employee_attendance_detail($1, null, null, null)', ['Sotuvchi']);
  console.log(JSON.stringify(r2.rows[0].ai_employee_attendance_detail, null, 2));

  console.log('\n--- TEST 3: ai_attendance_summary ---');
  const r3 = await client.query('SELECT public.ai_attendance_summary(null, null, null, null)');
  console.log(JSON.stringify(r3.rows[0].ai_attendance_summary, null, 2));

  console.log('\n--- TEST 4: ai_list_orders ---');
  const r4 = await client.query('SELECT public.ai_list_orders(null, null, null, null, null, 5)');
  console.log(JSON.stringify(r4.rows[0].ai_list_orders, null, 2));

  console.log('\n--- TEST 5: ai_search_customers ---');
  const r5 = await client.query('SELECT public.ai_search_customers(null, 5)');
  console.log(JSON.stringify(r5.rows[0].ai_search_customers, null, 2));

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
