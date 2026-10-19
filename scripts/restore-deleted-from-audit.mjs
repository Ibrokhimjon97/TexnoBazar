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

  const sinceTime = '2026-10-19T18:30:00Z';
  console.log('=== ULTRA-FAST BATCH RESTORE FROM AUDIT_LOG ===\n');

  await client.query('BEGIN');

  try {
    // 1. Restore products
    const pRes = await client.query(`
      INSERT INTO public.products
      SELECT DISTINCT ON (p.id) p.*
      FROM audit_log a,
      LATERAL jsonb_populate_record(null::public.products, a.old_data) p
      WHERE a.entity_table = 'products' 
        AND a.action = 'DELETE' 
        AND a.created_at >= $1
      ORDER BY p.id, a.created_at DESC
      ON CONFLICT (id) DO NOTHING
    `, [sinceTime]);
    console.log(`✅ Mahsulotlar tiklandi: ${pRes.rowCount} ta.`);

    // 2. Restore product_variants
    const vRes = await client.query(`
      INSERT INTO public.product_variants
      SELECT DISTINCT ON (v.id) v.*
      FROM audit_log a,
      LATERAL jsonb_populate_record(null::public.product_variants, a.old_data) v
      WHERE a.entity_table = 'product_variants' 
        AND a.action = 'DELETE' 
        AND a.created_at >= $1
      ORDER BY v.id, a.created_at DESC
      ON CONFLICT (id) DO NOTHING
    `, [sinceTime]);
    console.log(`✅ Mahsulot variantlari tiklandi: ${vRes.rowCount} ta.`);

    // 3. Restore stock_batches
    const bRes = await client.query(`
      INSERT INTO public.stock_batches
      SELECT DISTINCT ON (b.id) b.*
      FROM audit_log a,
      LATERAL jsonb_populate_record(null::public.stock_batches, a.old_data) b
      WHERE a.entity_table = 'stock_batches' 
        AND a.action = 'DELETE' 
        AND a.created_at >= $1
      ORDER BY b.id, a.created_at DESC
      ON CONFLICT (id) DO NOTHING
    `, [sinceTime]);
    console.log(`✅ Partiya qatorlari (stock_batches) tiklandi: ${bRes.rowCount} ta.`);

    // 4. Restore inventory_units
    const uRes = await client.query(`
      INSERT INTO public.inventory_units
      SELECT DISTINCT ON (u.id) u.*
      FROM audit_log a,
      LATERAL jsonb_populate_record(null::public.inventory_units, a.old_data) u
      WHERE a.entity_table = 'inventory_units' 
        AND a.action = 'DELETE' 
        AND a.created_at >= $1
      ORDER BY u.id, a.created_at DESC
      ON CONFLICT (id) DO NOTHING
    `, [sinceTime]);
    console.log(`✅ Birliklar (inventory_units) tiklandi: ${uRes.rowCount} ta.`);

    // 5. Restore product_media safely (prevent duplicate r2_key or primary collision)
    const mRes = await client.query(`
      INSERT INTO public.product_media (id, product_id, variant_id, r2_key, public_url, mime_type, bytes, alt_text, sort_order, is_primary, created_at, updated_at)
      SELECT DISTINCT ON (COALESCE(m.r2_key, m.id::text)) 
        m.id, m.product_id, m.variant_id, m.r2_key, m.public_url, m.mime_type, m.bytes, m.alt_text, m.sort_order, 
        false as is_primary,
        m.created_at, m.updated_at
      FROM audit_log a,
      LATERAL jsonb_populate_record(null::public.product_media, a.old_data) m
      WHERE a.entity_table = 'product_media' 
        AND a.action = 'DELETE' 
        AND a.created_at >= $1
        AND NOT EXISTS (
          SELECT 1 FROM public.product_media pm2 
          WHERE (m.r2_key IS NOT NULL AND pm2.r2_key = m.r2_key) OR pm2.id = m.id
        )
      ORDER BY COALESCE(m.r2_key, m.id::text), a.created_at DESC
      ON CONFLICT DO NOTHING
    `, [sinceTime]);
    console.log(`✅ Mahsulot rasmlari (product_media) tiklandi: ${mRes.rowCount} ta.`);

    // 6. Fix is_primary on one image per product where missing
    await client.query(`
      WITH first_media AS (
        SELECT DISTINCT ON (product_id) id
        FROM public.product_media
        WHERE product_id IN (
          SELECT DISTINCT p.id 
          FROM audit_log a, LATERAL jsonb_populate_record(null::public.products, a.old_data) p
          WHERE a.entity_table = 'products' AND a.action = 'DELETE' AND a.created_at >= $1
        )
        ORDER BY product_id, sort_order ASC, created_at ASC
      )
      UPDATE public.product_media
      SET is_primary = true
      WHERE id IN (SELECT id FROM first_media)
        AND NOT EXISTS (
          SELECT 1 FROM public.product_media pm2 
          WHERE pm2.product_id = product_media.product_id AND pm2.is_primary = true
        )
    `, [sinceTime]);
    console.log('✅ Asosiy rasm belgilari (is_primary) to‘g‘rilandi.');

    // 7. Recalculate inventory_balances
    console.log('🔄 inventory_balances qayta yangilanmoqda...');
    await client.query(`
      INSERT INTO public.inventory_balances (location_id, product_id, on_hand, reserved, updated_at)
      SELECT 
        u.location_id,
        u.product_id,
        count(*) as on_hand,
        count(*) FILTER (WHERE u.status = 'reserved') as reserved,
        now() as updated_at
      FROM public.inventory_units u
      WHERE u.status IN ('available', 'reserved')
      GROUP BY u.location_id, u.product_id
      ON CONFLICT (location_id, product_id) DO UPDATE SET
        on_hand = EXCLUDED.on_hand,
        reserved = EXCLUDED.reserved,
        updated_at = EXCLUDED.updated_at
    `);
    console.log('✅ inventory_balances to‘liq yangilandi.');

    await client.query('COMMIT');
    console.log('\n🎉 BARCHA MA’LUMOTLAR MUVAFFAQIYATLI QAYTA TIKLANDI!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Xatolik yuz berdi, rollback qilindi:', err);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
