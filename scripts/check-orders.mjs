import pg from 'pg';
import fs from 'fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

let dbUrl = env.SUPABASE_DB_URL;
if (dbUrl && dbUrl.includes(':5432')) {
  dbUrl = dbUrl.replace(':5432', ':6543');
}
const client = new pg.Client({ 
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await client.connect();
  const res = await client.query(`
    SELECT o.id, o.order_no, o.status, o.placed_at,
           l.id as line_id, l.product_id, l.product_name, l.sku, l.variant_color, l.quantity, l.unit_price, l.line_total,
           p.name as prod_name, p.slug as prod_slug, p.seo_image_url
    FROM public.orders o
    LEFT JOIN public.order_lines l ON l.order_id = o.id
    LEFT JOIN public.products p ON p.id = l.product_id
    ORDER BY o.placed_at DESC
  `);
  console.log('Orders found:', res.rows.length);
  console.log(JSON.stringify(res.rows, null, 2));

  // Also check receipt_delivery_outbox and payment_transactions for these orders
  const outbox = await client.query('SELECT id, order_id, status FROM public.receipt_delivery_outbox');
  console.log('Outbox entries:', outbox.rows);

  const payments = await client.query('SELECT id, order_id, provider, state FROM public.payment_transactions');
  console.log('Payment transactions:', payments.rows);

  await client.end();
}

main().catch(console.error);
