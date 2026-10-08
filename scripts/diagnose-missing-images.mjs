import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://bnpmpdlyqmlefkrykfwq.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

async function main() {
  const { data: products } = await supabase
    .from('products')
    .select('id, sku, name, retail_price, is_published')
    .eq('is_published', true);

  const { data: media } = await supabase
    .from('product_media')
    .select('product_id, public_url');

  const mediaByProd = new Map();
  for (const m of media || []) {
    if (!mediaByProd.has(m.product_id)) mediaByProd.set(m.product_id, []);
    mediaByProd.get(m.product_id).push(m.public_url);
  }

  const missing = [];
  const haveMedia = [];

  for (const p of products || []) {
    const list = mediaByProd.get(p.id) || [];
    if (list.length === 0) {
      missing.push(p);
    } else {
      haveMedia.push(p);
    }
  }

  console.log(`Jami tovarlar: ${products.length}`);
  console.log(`Rasmli tovarlar: ${haveMedia.length}`);
  console.log(`Rasmsiz tovarlar: ${missing.length}\n`);

  console.log('Rasmsiz tovarlar ro‘yxati:');
  missing.forEach((m, idx) => {
    console.log(`${idx + 1}. [${m.sku}] ${m.name}`);
  });
}

main().catch(console.error);
