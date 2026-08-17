# Texnobazar — ERP, POS va e-commerce monorepo

Loyiha beshta Vite/React ilovasi, umumiy UI, Supabase data qatlami va Cloudflare R2 media servisidan iborat. Interfeyslar hozircha demo ma’lumotlardan foydalanadi; ushbu bosqich backend/data poydevorini tayyorlaydi.

## Arxitektura
- `apps/storefront` — ochiq katalog va online buyurtma; jadvalga bevosita INSERT emas, `create_online_order` RPC ishlatiladi.
- `apps/superadmin`, `manager`, `seller`, `courier` — Auth + RLS bilan rol/filial doirasida ishlaydi.
- `packages/data` — browser-safe Supabase client va RPC yordamchilari; unda maxfiy kalit yo‘q.
- `packages/server` — faqat Node/server uchun R2 presign/delete moduli; browser bundle’ga import qilinmaydi.
- `apps/superadmin/api/media/presign.js` — Vercel Node Function; JWT va `superadmin`/`manager` rolini tekshiradi.
- `supabase/migrations` — boshlang‘ich sxema va undan keyingi timestamped migratsiyalar; RLS, audit va tranzaksion RPC’lar shu yerda.
- `scripts/bootstrap-superadmin.mjs` — service secret bilan faqat serverda ishlaydigan, idempotent boshlang‘ich superadmin vositasi.
- Media fayllari Supabase Storage’da emas, R2’da; bazada faqat R2 key, HTTPS URL va metadata saqlanadi.

## Lokal ishga tushirish
```bash
npm install
npm run dev:storefront   # 5173
npm run dev:superadmin   # 5174
npm run dev:manager      # 5175
npm run dev:seller       # 5176
npm run dev:courier      # 5177
npm run build
```
Barcha Vite ilovalari repo ildizidagi `.env.local` ni `envDir` orqali o‘qiydi. `.env.example` ni nusxalang va haqiqiy qiymatlarni faqat lokal/Vercel environment’da saqlang.

## Supabase migratsiyasi
Remote bazaga bu repository avtomatik ulanmaydi. Parent/operator tekshirganidan keyin credential’ni komandaga yozmasdan environment orqali qo‘llang:
```powershell
$env:SUPABASE_DB_URL = "postgresql://..."   # terminal yoki secret manager orqali
npx supabase db push --db-url $env:SUPABASE_DB_URL
```
Migratsiyalar timestamp tartibida qo‘llanadi; `20260101000000_initial_schema.sql` bazaviy sxemani, `20260102000000_access_context_and_role_hardening.sql` Auth/RBAC hardeningni, `20260103000000_master_data_hardening.sql` master-data audit/grantlarini, `20260104000000_product_catalog.sql` tranzaksion mahsulot katalogini, `20260105000000_product_media_invariants.sql` media invariantlarini, `20260106000000_inventory_receiving_qr.sql` real partiya/QR/qoldiq oqimini, `20260107000000_inventory_receiving_smoke_validation.sql` rollback qilinadigan DB assertlarini, `20260108000000_inventory_qr_labels.sql` QR yorliq ma’lumotlarini, `20260109000000_branch_transfers_debts.sql` filiallararo transfer va qarz oqimini, `20260109100000_branch_transfer_trigger_hotfix.sql` jadvalga bog‘liq immutable trigger hardeningini, `20260110000000_branch_transfer_smoke_validation.sql` esa shu oqimning rollback qilinadigan DB tekshiruvlarini o‘rnatadi. Migratsiyalarni aynan timestamp tartibida, keyin `supabase/seed.sql` ni bajaring. Remote bazada `20260101000000`–`20260110000000` migration history local holat bilan mos va transfer/qarz smoke-validatsiyasi muvaffaqiyatli o‘tgan.

## Boshlang‘ich superadmin
Migratsiya qo‘llangach operator CLI argumentlari (yoki `.env.example` dagi `SUPERADMIN_*` env qiymatlari) bilan idempotent bootstrap bajaradi:
```bash
npm run bootstrap:superadmin -- --email owner@example.uz --password "StrongPass123" --name "Bosh administrator"
```
Skript root `.env.local` ni faqat Node/server jarayonida o‘qiydi, mavjud foydalanuvchini email bo‘yicha topadi yoki yaratadi, profilni faollashtiradi va global `superadmin` rolini biriktiradi. Yangi bootstrap foydalanuvchisi birinchi kirishda vaqtinchalik parolni almashtirishi shart. Parol, email yoki service secret log qilinmaydi.

## Xodimlar va kirish panellari
- Storefront ochiq qoladi. Himoyalangan panellar: Superadmin `http://localhost:5174`, Menejer `:5175`, Sotuvchi `:5176`, Kuryer `:5177`.
- Superadmin panelidagi **Xodimlar** sahifasi faol filialga manager/seller/courier/warehouse/accountant yaratadi. So‘rov Bearer access token bilan `POST /api/employees/create` ga yuboriladi; Vite lokal middleware va Vercel function bir xil server service’dan foydalanadi.
- Xodimni faollashtirish/faolsizlantirish RPC orqali audit qilinadi; superadmin o‘zini faolsizlantira olmaydi.

## Partiya, QR va real qoldiq
Menejer panelidagi **Partiyalar** bo‘limi yetkazib beruvchi, invoice, valyuta, to‘lov holati va bir nechta mahsulot qatoridan iborat real kirim yaratadi. Har bir fizik dona uchun kriptografik tasodifiy `TNB1-...` QR kodi, ixtiyoriy zavod seriyasi va partiya ketma-ket raqami yaratiladi. Bir so‘rovni takror yuborish branch-scoped idempotency key sabab ikkinchi marta kirim qilmaydi.

**Qoldiq** bo‘limi `inventory_units`dan avtomatik sinxronlanadigan `inventory_balances` projectionini location kesimida ko‘rsatadi. QR/seriya skaneri mahsulot elektron pasportini — mahsulot, partiya, supplier, tannarx, joriy joy/status va to‘liq movement tarixini — chiqaradi; manager mahsulotni o‘z filiali doirasida ombor/do‘kon orasida atomik joylashtira oladi. Partiya detailidan 200 tagacha haqiqiy skanerlanadigan QR yorliqlarini chop etish mumkin. Superadmin **Ombor** sahifasi barcha filial/location qoldiqlarini global monitoring qiladi.

Receipt, QR, balance, passport, placement va idempotency zanjiri remote PostgreSQL’da nested subtransaction orqali tekshirilgan; smoke fixture’lari ataylab rollback qilinadi.

## Filiallararo transfer va qarzdorlik
`20260109000000_branch_transfers_debts.sql` dona mahsulotlar uchun qat’iy `requested → approved → in_transit → received` lifecycle’ni o‘rnatadi: so‘ralgan transfer tasdiqlanmasdan jo‘natilmaydi. Mahsulotlar qabul qiluvchi filial joyiga atomik o‘tadi va filial qarzi faqat `received` bosqichida yaratiladi. `20260110000000_branch_transfer_smoke_validation.sql` lifecycle, ruxsat va hisob-kitob invariantlarini rollback qilinadigan fixture bilan tekshiradi.

Menejer panelidagi **Transfer** va **Qarzdorlik** sahifalari demo emas, real RPC’larga ulangan. To‘lovni faqat kreditor filialning vakolatli manager/accountant xodimi (yoki global administrator) qayd etadi; qarzdor filial menejeri qarz va tarixni ko‘radi, lekin to‘lovni tasdiqlamaydi. Transfer yaratish va qarz to‘lovlari takroriy so‘rovda dublikat yozuv yaratmasligi uchun idempotency key bilan himoyalangan. Yangi transfer, trigger hotfix va rollback-smoke migratsiyalari remote development bazaga muvaffaqiyatli qo‘llangan.

## Mahsulot katalogi va R2 media
Superadmin **Mahsulotlar** bo‘limi real Supabase katalogiga ulangan: server-side qidiruv, holat/kategoriya/brend filtrlari, pagination, draft yaratish, tahrirlash, dinamik kategoriya atributlari, nashr/yashirish va arxivlash mavjud. Mahsulot yozuvlari browserdan bevosita yozilmaydi — save/publish/archive tranzaksion RPC orqali bajariladi. Nashr uchun barcha majburiy atributlar va asosiy rasm talab qilinadi.

Rasm oqimi `POST /api/media/presign` → Cloudflare R2 `PUT` → `POST /api/media/complete` tartibida ishlaydi. Complete endpoint R2 obyektini `HeadObject` bilan tekshiradi va key/URL/MIME/hajm metadata’ni server tomonda DBga biriktiradi. Rasmlar orasidan asosiy rasm tanlanadi; nashrdagi mahsulotning asosiy rasmini avval mahsulotni yashirmasdan o‘chirib bo‘lmaydi. `DELETE /api/media/delete` DB metadata va R2 obyektini tozalaydi.

## Superadmin ma’lumotnomalari
Superadmin panelidagi **Ma’lumotnomalar** bo‘limi filiallar, joylashuvlar, kategoriyalar, brendlar, kategoriya atributlari, ta’minotchilar va to‘lov usullarini real Supabase CRUD orqali boshqaradi. Filiallar va ta’minotchilar menyusi ham shu yagona boshqaruv sahifasining tegishli tabini ochadi. O‘chirish o‘rniga operatsion yozuvlar faolsizlantiriladi; bog‘langan filial yoki boshqa reference yozuvlar bazadagi constraintlar bilan himoyalangan. Katalog va master-data o‘zgarishlari `audit_log` ga yoziladi.

## Access-context RPC’lari
Authenticated klientlar jadval rol yozuvlarini to‘g‘ridan-to‘g‘ri o‘qimaydi: `get_my_access_context()`, `list_employees()`, `list_active_branches()` va `set_employee_active(employee_id, bool)` RPC’laridan foydalanadi. Global xodim boshqaruvi faqat `superadmin`; kuryer faqat o‘z delivery/order zanjirini, sotuvchi esa filial katalog/qoldig‘i hamda o‘z pending sale/savdolarini ko‘radi.

## Xavfsizlik
`VITE_SUPABASE_URL` va `VITE_SUPABASE_ANON_KEY` brauzer uchun ochiq. `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL` va barcha `R2_*` qiymatlari faqat serverda bo‘lishi shart; ularga hech qachon `VITE_` prefiksi bermang, commit yoki log qilmang. Service secret RLS’ni chetlab o‘tadi. POS’da `SOLD` holati faqat manager tasdiqlaydigan RPC ichida, row lock bilan o‘rnatiladi.

## R2 / Vercel
Vercel’da repo root’ni loyiha root sifatida saqlang yoki `apps/superadmin/api/**` ni platforma Function path’iga map qiling. Employee API uchun `VITE_SUPABASE_URL` va `SUPABASE_SECRET_KEY`; media API uchun ularga qo‘shimcha `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` server environment qiymatlarini kiriting. Functionlar Node 18+ talab qiladi. R2 bucket va public custom-domain URL haqiqiy va faol bo‘lmaguncha presign ishlamaydi. Upload PUT so‘rovida qaytarilgan `Content-Type` va aniq fayl hajmini yuboring; limit 10 MiB, formatlar JPEG/PNG/WebP/AVIF.

## TASK 13 — real POS va kassa
`20260111000000_pos_cashier_hardening.sql` POS rezerv, narx/chegirma siyosati, split payment, manager tasdig‘i va chek/KPI RPC’larini o‘rnatadi; `20260112000000_pos_cashier_smoke_validation.sql` rollback qilinadigan POS invariant tekshiruvlarini beradi. Seller oqimi fizik unit tanlashdan boshlanadi: sotuvchi narxni mahsulot minimumidan past yoki retail narxining ikki baravaridan yuqori qo‘ya olmaydi, seller qator chegirmasi esa 20% dan oshmaydi. Bir nechta to‘lov usuli yig‘indisi soliq bilan hisoblangan aniq jami summaga teng bo‘lishi shart.

Seller yuborgan savdo `pending` rezerv bo‘ladi; manager saqlangan to‘lov rejasini ko‘rib pulni qabul qilgach savdo yakunlanadi va mahsulot birligi `SOLD` holatiga o‘tadi. Rad etish sababi majburiy, rad etilgan yoki muddati tugagan rezerv mahsulotlarni qayta `available` holatiga bo‘shatadi. Seller real bugungi KPI, savdo tarixi va printable chekni, manager esa pending summa/soni, bugungi tasdiqlar, qator foydasi va printable yakuniy chekni ko‘radi.

Task 13 migratsiyalari development Supabase bazasiga hali push qilinmagan: dry-runlarda Supabase pooler `:5432` ulanishi timeout bo‘ldi. Remote wrapper diagnostikasida DB connection string terminalga chiqib ketgani sabab DB parolini rotate qilish va faqat yangi credential bilan push/rollback smoke bajarish shart. POS unit list/find RPC javoblari `tax_rate`ni qaytaradi; frontend va server split payment jami summasini bir xil soliq formulasi bilan hisoblaydi. Minimal sotuv narxi chegirmadan keyingi sof qator narxiga tatbiq qilinadi.
