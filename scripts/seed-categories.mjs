/**
 * Kategoriya seed skripti.
 *
 * 1. Har bir kategoriya uchun vektor illyustratsiya (SVG) yaratadi.
 * 2. Chrome headless orqali shaffof fonli PNG ga rasterlaydi.
 * 3. PNG ni Cloudflare R2 ga yuklaydi.
 * 4. Supabase `categories` jadvalini slug bo‘yicha upsert qiladi va seo_image_url ni yozadi.
 *
 * Ishlatish: node scripts/seed-categories.mjs [--dry-run]
 * Maxfiy qiymatlar faqat .env.local dan o‘qiladi va hech qachon log qilinmaydi.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} .env.local da sozlanmagan.`);
  return value;
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  const found = candidates.find(item => existsSync(item));
  if (!found) throw new Error('Chrome topilmadi. CHROME_PATH ni ko‘rsating.');
  return found;
}

/* --- illyustratsiya primitivlari ---------------------------------------- */
const SIZE = 512;
const shell = '#2f3239';
const shellSoft = '#4b5160';
const glass = '#0f172a';
const light = '#eef1f6';
const steel = '#c9d0dc';
const brand = '#ffb703';

const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
<defs>
<linearGradient id="screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#0b1220"/></linearGradient>
<linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f6fa"/><stop offset="1" stop-color="#cfd6e3"/></linearGradient>
<linearGradient id="warm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
<linearGradient id="dark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4150"/><stop offset="1" stop-color="#23272f"/></linearGradient>
</defs>
${body}
</svg>`;

const categories = [
  {
    name: 'Smartfonlar', slug: 'smartfonlar', sort_order: 10,
    art: `<rect x="176" y="70" width="160" height="372" rx="34" fill="url(#dark)"/>
<rect x="188" y="84" width="136" height="344" rx="26" fill="url(#screen)"/>
<rect x="232" y="96" width="48" height="10" rx="5" fill="#0b1220"/>
<circle cx="256" cy="392" r="16" fill="#111827" stroke="${shellSoft}" stroke-width="3"/>
<rect x="206" y="130" width="100" height="150" rx="12" fill="#1d4ed8" opacity=".28"/>
<rect x="206" y="296" width="64" height="12" rx="6" fill="${steel}" opacity=".5"/>
<rect x="344" y="150" width="10" height="52" rx="5" fill="${shellSoft}"/>`,
  },
  {
    name: 'Noutbuklar', slug: 'noutbuklar', sort_order: 20,
    art: `<rect x="112" y="112" width="288" height="196" rx="16" fill="url(#dark)"/>
<rect x="128" y="128" width="256" height="164" rx="10" fill="url(#screen)"/>
<rect x="152" y="152" width="120" height="14" rx="7" fill="${brand}" opacity=".85"/>
<rect x="152" y="180" width="180" height="10" rx="5" fill="${steel}" opacity=".45"/>
<rect x="152" y="204" width="150" height="10" rx="5" fill="${steel}" opacity=".3"/>
<path d="M84 320h344l26 56H58z" fill="url(#metal)"/>
<rect x="212" y="336" width="88" height="12" rx="6" fill="${steel}"/>`,
  },
  {
    name: 'Televizorlar', slug: 'televizorlar', sort_order: 30,
    art: `<rect x="72" y="104" width="368" height="228" rx="14" fill="url(#dark)"/>
<rect x="86" y="118" width="340" height="200" rx="8" fill="url(#screen)"/>
<path d="M86 258l84-58 62 44 60-52 134 92v32H86z" fill="#1d4ed8" opacity=".3"/>
<circle cx="330" cy="160" r="26" fill="${brand}" opacity=".5"/>
<rect x="232" y="332" width="48" height="44" fill="${shellSoft}"/>
<rect x="168" y="376" width="176" height="16" rx="8" fill="url(#metal)"/>`,
  },
  {
    name: 'Muzlatgichlar', slug: 'muzlatgichlar', sort_order: 40,
    art: `<rect x="160" y="60" width="192" height="392" rx="26" fill="url(#metal)"/>
<rect x="160" y="60" width="192" height="150" rx="26" fill="#e6ebf3"/>
<rect x="168" y="204" width="176" height="10" fill="${steel}"/>
<rect x="316" y="112" width="12" height="64" rx="6" fill="${shellSoft}"/>
<rect x="316" y="248" width="12" height="96" rx="6" fill="${shellSoft}"/>
<rect x="196" y="268" width="76" height="12" rx="6" fill="${steel}" opacity=".6"/>
<rect x="196" y="300" width="52" height="12" rx="6" fill="${brand}" opacity=".7"/>`,
  },
  {
    name: 'Kir yuvish mashinalari', slug: 'kir-yuvish-mashinalari', sort_order: 50,
    art: `<rect x="118" y="88" width="276" height="336" rx="26" fill="url(#metal)"/>
<rect x="140" y="112" width="232" height="44" rx="12" fill="#e2e8f1"/>
<circle cx="336" cy="134" r="12" fill="${brand}"/>
<circle cx="256" cy="288" r="104" fill="${shellSoft}" opacity=".35"/>
<circle cx="256" cy="288" r="86" fill="url(#screen)"/>
<circle cx="256" cy="288" r="62" fill="#93a3bd" opacity=".45"/>
<rect x="160" y="126" width="90" height="14" rx="7" fill="${steel}"/>`,
  },
  {
    name: 'Changyutgichlar', slug: 'changyutgichlar', sort_order: 60,
    art: `<ellipse cx="248" cy="330" rx="150" ry="96" fill="url(#dark)"/>
<ellipse cx="248" cy="312" rx="150" ry="92" fill="#3f4654"/>
<circle cx="206" cy="308" r="56" fill="url(#metal)"/>
<circle cx="206" cy="308" r="30" fill="${glass}" opacity=".7"/>
<path d="M330 244c58-38 92-6 82 46" stroke="${shell}" stroke-width="22" fill="none" stroke-linecap="round"/>
<rect x="366" y="286" width="34" height="86" rx="14" fill="${brand}"/>
<circle cx="152" cy="396" r="26" fill="${shell}"/>
<circle cx="352" cy="396" r="26" fill="${shell}"/>`,
  },
  {
    name: 'Havo sovutgichlar', slug: 'havo-sovutgichlar', sort_order: 70,
    art: `<rect x="72" y="122" width="368" height="120" rx="22" fill="url(#metal)"/>
<rect x="72" y="200" width="368" height="42" rx="14" fill="#dbe2ec"/>
<rect x="104" y="152" width="180" height="14" rx="7" fill="${steel}"/>
<circle cx="392" cy="160" r="12" fill="${brand}"/>
<path d="M150 286c22 18 22 40 0 58M232 286c22 18 22 40 0 58M314 286c22 18 22 40 0 58" stroke="#7f8ca3" stroke-width="16" fill="none" stroke-linecap="round"/>
<path d="M150 366c22 18 22 40 0 58M232 366c22 18 22 40 0 58M314 366c22 18 22 40 0 58" stroke="#a9b5c9" stroke-width="14" fill="none" stroke-linecap="round"/>`,
  },
  {
    name: 'Mikroto‘lqinli pechlar', slug: 'mikrotolqinli-pechlar', sort_order: 80,
    art: `<rect x="76" y="150" width="360" height="212" rx="20" fill="url(#dark)"/>
<rect x="96" y="172" width="228" height="168" rx="12" fill="url(#screen)"/>
<circle cx="210" cy="256" r="52" fill="${shellSoft}" opacity=".45"/>
<circle cx="210" cy="256" r="30" fill="${brand}" opacity=".6"/>
<rect x="344" y="180" width="72" height="34" rx="8" fill="#111827"/>
<rect x="352" y="190" width="56" height="14" rx="4" fill="${brand}" opacity=".75"/>
<circle cx="368" cy="262" r="16" fill="url(#metal)"/>
<circle cx="404" cy="262" r="16" fill="url(#metal)"/>
<rect x="344" y="298" width="72" height="14" rx="7" fill="${steel}" opacity=".6"/>`,
  },
  {
    name: 'Qahva mashinalari', slug: 'qahva-mashinalari', sort_order: 90,
    art: `<rect x="132" y="72" width="248" height="240" rx="24" fill="url(#dark)"/>
<rect x="152" y="96" width="208" height="86" rx="14" fill="url(#screen)"/>
<rect x="176" y="120" width="86" height="14" rx="7" fill="${brand}" opacity=".8"/>
<rect x="220" y="216" width="72" height="34" rx="10" fill="${shellSoft}"/>
<path d="M188 312h136v34a68 68 0 0 1-68 68 68 68 0 0 1-68-68z" fill="url(#metal)"/>
<path d="M204 340h104v10a52 52 0 0 1-52 52 52 52 0 0 1-52-52z" fill="#8b5e34" opacity=".75"/>
<rect x="160" y="404" width="192" height="18" rx="9" fill="${shell}"/>`,
  },
  {
    name: 'Uy texnikasi', slug: 'uy-texnikasi', sort_order: 95,
    art: `<rect x="96" y="96" width="150" height="320" rx="22" fill="url(#metal)"/>
<rect x="104" y="188" width="134" height="8" fill="${steel}"/>
<rect x="214" y="130" width="10" height="46" rx="5" fill="${shellSoft}"/>
<rect x="214" y="216" width="10" height="70" rx="5" fill="${shellSoft}"/>
<rect x="268" y="216" width="148" height="200" rx="20" fill="url(#dark)"/>
<circle cx="342" cy="322" r="60" fill="${shellSoft}" opacity=".4"/>
<circle cx="342" cy="322" r="42" fill="url(#screen)"/>
<rect x="284" y="240" width="80" height="14" rx="7" fill="${brand}" opacity=".8"/>
<rect x="268" y="120" width="148" height="66" rx="16" fill="url(#metal)"/>
<circle cx="392" cy="153" r="11" fill="${brand}"/>`,
  },
  {
    name: 'Aksessuarlar', slug: 'aksessuarlar', sort_order: 100,
    art: `<path d="M136 300v-36a120 120 0 0 1 240 0v36" stroke="${shell}" stroke-width="26" fill="none" stroke-linecap="round"/>
<rect x="104" y="288" width="72" height="120" rx="30" fill="url(#dark)"/>
<rect x="336" y="288" width="72" height="120" rx="30" fill="url(#dark)"/>
<rect x="120" y="308" width="40" height="80" rx="20" fill="${brand}" opacity=".8"/>
<rect x="352" y="308" width="40" height="80" rx="20" fill="${brand}" opacity=".8"/>`,
  },
];

/* --- ijro ---------------------------------------------------------------- */
const fileEnv = parseEnv(await readFile(resolve(root, '.env.local'), 'utf8'));
const env = { ...fileEnv, ...process.env };
const supabaseUrl = required(env, 'VITE_SUPABASE_URL');
const serviceKey = env.SUPABASE_SECRET_KEY || required(env, 'SUPABASE_SERVICE_ROLE_KEY');
const bucket = env.R2_BUCKET || required(env, 'R2_BUCKET_NAME');
const publicBase = (env.R2_PUBLIC_BASE_URL || required(env, 'R2_PUBLIC_URL')).replace(/\/$/, '');
if (!publicBase.startsWith('https://')) throw new Error('R2 public bazasi https bo‘lishi kerak.');

const svgDir = resolve(root, 'scripts/assets/categories');
const pngDir = join(tmpdir(), `texnobazar-categories-${randomUUID()}`);
await mkdir(svgDir, { recursive: true });
await mkdir(pngDir, { recursive: true });

const chrome = chromePath();
const rendered = [];
for (const category of categories) {
  const svgPath = join(svgDir, `${category.slug}.svg`);
  const pngPath = join(pngDir, `${category.slug}.png`);
  await writeFile(svgPath, svg(category.art), 'utf8');
  await execFileAsync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${SIZE},${SIZE}`,
    `--screenshot=${pngPath}`, `file:///${svgPath.replace(/\\/gu, '/')}`,
  ], { timeout: 60_000 });
  const png = await readFile(pngPath);
  if (png.length < 1024) throw new Error(`${category.slug}: PNG rasterlash muvaffaqiyatsiz.`);
  rendered.push({ ...category, png });
  console.log(`rasterlandi: ${category.slug} (${png.length} bayt)`);
}

if (dryRun) {
  console.log(`dry-run: ${rendered.length} ta rasm tayyor, yuklash va DB yozish o‘tkazib yuborildi.`);
  process.exit(0);
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${required(env, 'R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required(env, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'R2_SECRET_ACCESS_KEY'),
  },
});
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[‘’ʻʼ']/gu, '').replace(/\s+/gu, ' ');
const desiredSlugs = new Set(categories.map(item => item.slug));

async function loadState() {
  const { data: rows, error } = await admin.from('categories').select('id,name,slug,parent_id,seo_image_url,sort_order');
  if (error) throw error;
  const { data: products, error: productError } = await admin.from('products').select('id,category_id');
  if (productError) throw productError;
  const counts = new Map();
  for (const product of products) counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
  return { rows, counts };
}

async function upload(category) {
  const key = `categories/${category.slug}/${randomUUID()}.png`;
  await r2.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: category.png, ContentType: 'image/png',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  const publicUrl = `${publicBase}/${key}`;
  const probe = await fetch(publicUrl, { method: 'GET' });
  if (!probe.ok) throw new Error(`${category.slug}: R2 public URL ${probe.status} qaytardi.`);
  return publicUrl;
}

let { rows, counts } = await loadState();
const targets = new Map();

for (const category of rendered) {
  // Mavjud mahsulotlarni uzmaslik uchun bir xil nomdagi/slugdagi eng "to‘la" kategoriya tanlanadi.
  const matches = rows.filter(row => row.slug === category.slug || normalize(row.name) === normalize(category.name));
  const target = matches.slice().sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)
    || Number(b.slug === category.slug) - Number(a.slug === category.slug))[0] ?? null;
  const publicUrl = await upload(category);

  if (target) {
    const { error } = await admin.from('categories')
      .update({ name: category.name, seo_image_url: publicUrl, sort_order: category.sort_order, is_active: true })
      .eq('id', target.id);
    if (error) throw error;
    targets.set(category.slug, target.id);
    console.log(`rasm bog‘landi: ${target.slug} (${category.name}, ${counts.get(target.id) ?? 0} mahsulot)`);
  } else {
    const { data, error } = await admin.from('categories')
      .insert({ name: category.name, slug: category.slug, seo_image_url: publicUrl, sort_order: category.sort_order, is_active: true })
      .select('id').single();
    if (error) throw error;
    targets.set(category.slug, data.id);
    console.log(`yangi kategoriya: ${category.slug}`);
  }
}

// Faqat shu skript yaratgan, mahsuloti va bolasi yo‘q dublikat yozuvlar tozalanadi.
({ rows, counts } = await loadState());
for (const row of rows) {
  if (!desiredSlugs.has(row.slug)) continue;
  const keepId = targets.get(row.slug);
  const duplicate = [...targets.values()].includes(row.id);
  if (duplicate || row.id === keepId) continue;
  if ((counts.get(row.id) ?? 0) > 0) continue;
  if (rows.some(other => other.parent_id === row.id)) continue;
  const { error } = await admin.from('categories').delete().eq('id', row.id);
  if (error) throw error;
  console.log(`bo‘sh dublikat o‘chirildi: ${row.slug}`);
}
console.log(`tayyor: ${rendered.length} ta kategoriya rasm bilan saqlandi.`);
