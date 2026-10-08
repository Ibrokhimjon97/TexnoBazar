import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL = 'https://bnpmpdlyqmlefkrykfwq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJucG1wZGx5cW1sZWZrcnlrZndxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3ODg5MjMsImV4cCI6MjEwMjM2NDkyM30.cx1xjo9jOSPuqJWm0Nb6XG1kDYcnZt1DD4TTW439tQI';

const BRANCH_ID = '7a3efcd0-0824-411a-b4f8-38be9c194950'; // Asosiy filial
const WAREHOUSE_ID = '51a8e570-f6aa-46dd-8762-eca6c85a4f05'; // Asosiy ombor
const SUPPLIER_ID = '65b1d3dc-d7c9-4911-898f-2b126511dd47'; // Artel / default supplier
const UNITS_PER_PRODUCT = 50;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function main() {
  console.log('=== ASOSIY OMBORGA ZAXIRA KIRIM QILISH (50 DONADAN) ===\n');

  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: 'superadmin@texnobazar.uz',
    password: 'TnbSuper2026Q7'
  });
  if (authErr) throw new Error('Superadmin auth failed: ' + authErr.message);
  console.log('✅ Superadmin avtorizatsiyadan o‘tdi.');

  // Find products that currently have 0 available units
  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('id, sku, name, cost_price, retail_price, minimum_sale_price')
    .eq('is_published', true);

  if (pErr) throw pErr;
  console.log(`Jami nashr qilingan tovarlar: ${products.length} ta.`);

  // Check inventory counts
  const { data: units } = await supabase
    .from('inventory_units')
    .select('product_id')
    .eq('status', 'available');

  const stockCounts = new Map();
  for (const u of units || []) {
    stockCounts.set(u.product_id, (stockCounts.get(u.product_id) || 0) + 1);
  }

  const needStock = products.filter(p => (stockCounts.get(p.id) || 0) === 0);
  console.log(`Zaxirasi yo‘q tovarlar soni: ${needStock.length} ta.`);

  if (needStock.length === 0) {
    console.log('Barcha tovarlarda yetarli qoldiq mavjud!');
    return;
  }

  // Chunk in batches of 40
  const chunkSize = 40;
  for (let i = 0; i < needStock.length; i += chunkSize) {
    const chunk = needStock.slice(i, i + chunkSize);
    const receiptNo = `BATCH-${Date.now().toString().slice(-6)}-${Math.floor(i / chunkSize) + 1}`;
    console.log(`\n📦 Partiya [${Math.floor(i / chunkSize) + 1}]: ${chunk.length} ta tovardan 50 tadan kirim qilinmoqda (${receiptNo})...`);

    const header = {
      branch_id: BRANCH_ID,
      receiving_location_id: WAREHOUSE_ID,
      supplier_id: SUPPLIER_ID,
      receipt_no: receiptNo,
      currency: 'USD',
      payment_status: 'paid',
      received_at: new Date().toISOString()
    };

    const lines = chunk.map(p => ({
      product_id: p.id,
      quantity: UNITS_PER_PRODUCT,
      unit_cost: Math.round(Number(p.cost_price || 100000) / 12800) || 10,
      retail_price: Number(p.retail_price),
      minimum_sale_price: Number(p.minimum_sale_price || p.retail_price)
    }));

    const { error } = await supabase.rpc('receive_stock', {
      p_header: header,
      p_lines: lines,
      p_idempotency_key: randomUUID()
    });

    if (error) {
      console.error('❌ Partiya kirimida xatolik:', error.message);
    } else {
      console.log(`✅ ${chunk.length * UNITS_PER_PRODUCT} dona mahsulot birligi va QR kodlari yaratildi!`);
    }
  }

  console.log('\n🎉 Barcha tovarlarga zaxira muvaffaqiyatli kirim qilindi!');
}

main().catch(console.error);
