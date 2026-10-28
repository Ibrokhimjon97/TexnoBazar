import { createClient } from '@supabase/supabase-js';
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

const supabase = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SECRET_KEY);

async function main() {
  const { data: sales, error: sErr } = await supabase
    .from('pos_pending_sales')
    .select('id, pending_no, status, total')
    .order('created_at', { ascending: false })
    .limit(3);
  
  if (sErr) {
    console.error('Error fetching sales:', sErr);
    return;
  }
  console.log('Recent sales:', sales);

  for (const s of sales) {
    const { data: detail, error } = await supabase.rpc('get_pos_pending_sale', { p_pending_id: s.id });
    if (error) {
      console.error('RPC Error for', s.pending_no, error);
    } else {
      console.log(`\nSale ${s.pending_no} (${s.status}):`);
      detail.lines?.forEach(l => {
        console.log({
          product_name: l.product_name,
          sku: l.sku,
          unit_cost: l.unit_cost,
          retail_price: l.retail_price,
          unit_price: l.unit_price,
          discount: l.discount,
          profit: l.profit,
          line_total: l.line_total
        });
      });
    }
  }
}

main().catch(console.error);
