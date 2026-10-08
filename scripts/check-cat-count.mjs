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

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function main() {
  const res = await supabase.rpc('storefront_catalog_faceted', {
    p_filters: { query: null, category_ids: ['3e5f59f2-b470-47f1-ba66-9da4b4a43354'], brand_ids: [], attributes: {}, min_price: null, max_price: null, in_stock: false, sort: 'name' },
    p_limit: 100,
    p_offset: 0
  });
  console.log('Gaz plita duxovkali items count:', res.data?.items?.length, 'total:', res.data?.total);

  const res2 = await supabase.rpc('storefront_catalog_faceted', {
    p_filters: { query: null, category_ids: ['d1f37cfe-6055-4b8f-8ff2-72a6909219ec'], brand_ids: [], attributes: {}, min_price: null, max_price: null, in_stock: false, sort: 'name' },
    p_limit: 100,
    p_offset: 0
  });
  console.log('Kir yuvish items count:', res2.data?.items?.length, 'total:', res2.data?.total);
}

main().catch(console.error);
