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

let dbUrl = (env.SUPABASE_DB_URL || '').split('?')[0].replace(':5432', ':6543');
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  const testBranchId = '7a3efcd0-0824-411a-b4f8-38be9c194950';
  const today = '2026-10-27';

  const testPaymentQuery = `
    WITH period_confirmed AS (
      SELECT 
        s.id,
        s.branch_id,
        s.total,
        s.pending_no,
        coalesce(s.confirmed_at, s.created_at) as confirmed_at,
        s.seller_id,
        prof.full_name as seller_name
      FROM public.pos_pending_sales s
      LEFT JOIN public.profiles prof ON prof.id = s.seller_id
      WHERE s.branch_id = $1
        AND s.status = 'confirmed'
        AND (
          ($2::date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date >= $2::date)
          AND
          ($3::date IS NULL OR (coalesce(s.confirmed_at, s.created_at) AT TIME ZONE 'Asia/Tashkent')::date <= $3::date)
        )
    ),
    pending_pmts AS (
      SELECT 
        pc.id as pending_id,
        string_agg(distinct coalesce(pm.name, pm.code), ', ') as payment_methods
      FROM period_confirmed pc
      LEFT JOIN public.sales sa ON sa.pending_sale_id = pc.id
      LEFT JOIN public.sale_payments sp ON sp.sale_id = sa.id AND sp.status IN ('paid', 'pending')
      LEFT JOIN public.payment_methods pm ON pm.id = sp.payment_method_id
      GROUP BY pc.id
    )
    SELECT * FROM pending_pmts LIMIT 5;
  `;

  const res = await client.query(testPaymentQuery, [testBranchId, today, today]);
  console.log('Payment methods sample:', res.rows);

  await client.end();
}

main().catch(console.error);
