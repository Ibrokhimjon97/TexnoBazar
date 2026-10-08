import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';

const SUPABASE_URL = 'https://bnpmpdlyqmlefkrykfwq.supabase.co';
const SUPABASE_SECRET = process.env.SUPABASE_SECRET || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

async function main() {
  const { data: products } = await supabase.from('products').select('id, sku, name, category_id, brand_id');
  const { data: media } = await supabase.from('product_media').select('product_id');
  const hasMedia = new Set(media.map(m => m.product_id));

  const missing = products.filter(p => !hasMedia.has(p.id));
  console.log(`Missing products count: ${missing.length}`);

  // Also check Excel mapping
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile('tovarlar.xlsx');
  const ws = wb.worksheets[0];
  const excelRows = new Map();

  for (let r = 5; r <= ws.rowCount; r++) {
    const val = ws.getRow(r).values;
    const code = String(val[3] || '').trim();
    const name = String(val[4] || '').trim();
    const urlRaw = val[7];
    const url = typeof urlRaw === 'object' ? (urlRaw.text || urlRaw.hyperlink) : (urlRaw || '');
    if (code) excelRows.set(`TB-${code}`, { code, name, url });
  }

  const list = missing.map(p => {
    const ex = excelRows.get(p.sku);
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      excelUrl: ex?.url || 'NONE'
    };
  });

  const domains = {};
  list.forEach(item => {
    let domain = 'NO_URL';
    if (item.excelUrl && item.excelUrl.startsWith('http')) {
      try { domain = new URL(item.excelUrl).hostname; } catch {}
    }
    domains[domain] = (domains[domain] || 0) + 1;
  });

  console.log('Domains breakdown:', domains);
  console.log('\nSample items:');
  console.log(list.slice(0, 15));
}

main().catch(console.error);
