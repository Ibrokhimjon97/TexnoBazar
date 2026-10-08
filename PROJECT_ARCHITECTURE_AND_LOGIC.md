# Texnobazar Platformasi — To'liq Arxitektura, Biznes Mantiqi va Tizim Qo'llanmasi

Ushbu hujjat **Texnobazar** loyihasining to'liq arxitekturasi, biznes jarayonlari, ma'lumotlar bazasi mantiqi, frontend ilovalari va integratsiyalarini batafsil tushuntirish uchun tuzilgan. Kelgusida loyihani istalgan hisobdan yoki dasturchi tomonidan davom ettirishda asosiy yo'riqnoma hisoblanadi.

---

## 1. Loyihaning Umumiy Maqsadi va Tuzilishi

**Texnobazar** — maishiy texnika va elektronika savdosi bilan shug'ullanuvchi kompaniyalar uchun to'liq avtomatlashtirilgan ERP, POS (savdo nuqtasi), omborxona, filiallararo hisob-kitob, kuryerlik logistikasi hamda ommaviy internet do'kon (E-commerce Storefront) ekotizimidir.

### Texnologik Stack:
- **Arxitektura:** Monorepo (NPM Workspaces)
- **Frontend kutubxonalari:** React 18, Vite 7, Lucide Icons, Recharts, QR-code, React-Quill
- **Backend / Ma'lumotlar Bazasi:** Supabase (PostgreSQL 15+), Row-Level Security (RLS), PL/pgSQL Tranzaksion RPC funksiyalari, Realtime Websockets
- **Serverless & API:** Vite Dev Middlewares & Vercel Serverless Functions (Node.js)
- **Media / Fayllar:** Cloudflare R2 Storage (S3-compatible Presigned URLs orqali xavfsiz yuklash)
- **To'lov integratsiyalari:** Click, Payme, Naqd, Terminal, Aralash to'lov (Split payment)
- **AI Integratsiyasi:** OpenAI, Google Gemini, Claude, Groq, Kimi (Mahsulot tavsiflari, aqlli qidiruv, savdo tahlili)
- **Telegram Bot:** Real vaqt statistikasi va xabarnomalar

---

## 2. Monorepo Jildlar Tuzilishi

Loyiha `apps/` va `packages/` qismlariga bo'lingan:

```
TexnobazarKiro2/
├── apps/
│   ├── storefront/   # 🛒 Mijozlar uchun ochiq online do'kon (Port: 5173)
│   ├── superadmin/   # 👑 Kompaniya rahbari va bosh administrator paneli (Port: 5174)
│   ├── manager/      # 🏬 Do'kon va ombor mudiri / kassir paneli (Port: 5175)
│   ├── seller/       # 📱 Sotuvchi (POS) mobil / planshet interfeysi (Port: 5176)
│   └── courier/      # 🚚 Kuryer mobil yetkazib berish ilovasi (Port: 5177)
│
├── packages/
│   ├── data/         # 📦 Brauzer uchun xavfsiz Supabase client va barcha RPC/CRUD funksiyalar
│   ├── server/       # 🛡️ Faqat serverda ishlovchi Cloudflare R2, Click, Payme, Resend modullari
│   └── ui/           # 🎨 Umumiy komponentlar (Auth, AiChat, ThemeToggle, Toast, dual narx, QR skaner)
│
├── supabase/
│   ├── migrations/   # 110+ ta SQL migratsiya fayllari (Baza sxemalari, RLS va RPC lar)
│   └── seed.sql      # Boshlang'ich test ma'lumotlari
│
├── scripts/          # Boshlang'ich superadminni yaratish skriptlari (bootstrap)
├── .env.example      # Muhit o'zgaruvchilari namunasi
└── .env.local        # Lokal muhit o'zgaruvchilari
```

---

## 3. Rollar va Ruxsatlar Tizimi (RBAC & RLS)

Tizimda qat'iy rol va filialga bog'langan xavfsizlik modeli o'rnatilgan:

| Rol | Kirish Manzili | Asosiy Vazifasi va Ruxsatlari |
| :--- | :--- | :--- |
| **Superadmin / Admin** | `http://localhost:5174` | Kompaniya bo'yicha to'liq nazorat: yangi filiallar, omborlar, xodimlar yaratish, tovar katalogi (CMS, bannerlar), umumiy moliya, audit va AI sozlamalari. |
| **Menejer (Manager)** | `http://localhost:5175` | O'z filialidagi barcha jarayonlar: partiya qabul qilish, QR kodlar chiqarish, filiallararo transfer, qarzlar, kassadagi savdolarni tasdiqlash, qaytarishlar, inventarizatsiya. |
| **Sotuvchi (Seller)** | `http://localhost:5176` | POS savdo: fizik mahsulot QR kodini skanerlash, narx/chegirmani belgilash, savdoni kassaga yo'naltirish (`pending_sale`), o'z kunlik KPI va sotuv tarixini ko'rish. |
| **Kuryer (Courier)** | `http://localhost:5177` | Buyurtmalarni yetkazib berish: biriktirilgan buyurtmalar, QR kod orqali tovarni olib ketishni tasdiqlash, GPS marshrut, mijozga topshirish, naqd pulni kassaga topshirish. |
| **Mijoz (Storefront)** | `http://localhost:5173` | Ommaviy do'konda tovarlarni ko'rish, rang/variant tanlash, savatga qo'shish, Click/Payme yoki naqd orqali buyurtma berish. |

---

## 4. Asosiy Biznes Jarayonlari va Hayot Sikli (Lifecycle)

### 4.1. Tovar Kirimi va QR Kodlar (Partiya / Batch Receiving)
1. Menejer ta'minotchi (supplier), invoice, to'lov holati va kelgan mahsulotlarni tanlab **Partiya** yaratadi.
2. Har bir fizik dona mahsulot uchun bazada alohida `inventory_units` yozuvi ochiladi va kriptografik noyob `TNB1-...` QR kodi generatsiya qilinadi.
3. Menejer QR yorliqlarni PDF shaklida chop etib tovarlarga yopishtiradi.
4. Partiyadagi tovarlar dastlab tanlangan joylashuvga (`Ombor` yoki `Do'kon`) `available` holatda kirim qilinadi.

### 4.2. Joylashuvlar va Harakat (Movement & Relocation)
- Har bir mahsulot birligi qayerda turgani (Asosiy ombor, Vitrina, Savdo zali) QR skaner orqali shu zahoti aniqlanadi va joyi almashtirilishi mumkin.
- Barcha siljishlar `inventory_movements` jadvaliga audit sifatida yozib boriladi.

### 4.3. Filiallararo Transfer va Filiallar Qarzi (Branch Transfers & Debts)
Qat'iy bosqichli lifecycle:
1. **`requested`**: Filial tovar so'raydi yoki jo'natuvchi filial transfer ochadi.
2. **`approved`**: Jo'natuvchi filial transferni tasdiqlaydi.
3. **`in_transit`**: Tovar yo'lga chiqadi va jo'natuvchi filial qoldig'idan yechiladi.
4. **`received`**: Qabul qiluvchi filial QR kodlarni skaner qilib qabul qiladi.
5. **Moliyaviy hisob-kitob:** Qabul qilingan paytda qabul qiluvchi filial hisobiga avtomatik **qarz** yoziladi. To'lov qilinganda kreditor filial menejeri yoki superadmin tomonidan tasdiqlanadi.

### 4.4. POS Savdo Oqimi (Seller & Cashier Confirmation)
1. **Sotuvchi (Seller):** Tovar QR kodini skanerlaydi, narxni kiritadi (ruxsat etilgan chegaralarda: min-price dan past emas, chegirmaning max limiti 20%), to'lov usullarini (split payment) belgilaydi va **"Kassaga yo'naltirish"** tugmasini bosadi.
2. Tovar holati `reserved` bo'ladi va `pos_pending_sales` jadvaliga tushadi.
3. **Menejer (Kassa):** Realtime xabarnoma yoki tovushli signal orqali so'rovni ko'radi, mijozdan pulni oladi va **"Tasdiqlash"** ni bosadi.
4. Tovar birligi atomik tarzda `SOLD` holatiga o'tadi, to'lovlar `sales_payments` ga tushadi, printable chek chiqariladi va sotuvchining shaxsiy KPI hisobiga yoziladi.
5. Agar rad etilsa, tovar zaxiradan yechilib yana erkin savdoga (`available`) qaytadi.

### 4.5. Online Buyurtma va Kuryerlik (Storefront & Delivery)
1. Mijoz saytda buyurtma beradi (`create_online_order_v2` RPC).
2. Menejer yoki Superadmin buyurtmani ko'rib, uni faol kuryerga biriktiradi.
3. Kuryer appida bildirishnoma oladi, do'konga kelib mahsulot QR kodini skanerlaydi (`OrderQrVerification`) va buyurtmani olib ketadi (`picked_up` -> `in_transit`).
4. Kuryer mijozga topshirgach `delivered` statusiga o'tkazadi (kerak bo'lsa fotosurat isboti bilan).
5. Kuryer qabul qilgan naqd pullar uning hisobida turadi va kun oxirida menejerga topshiriladi (`courier_cash_handover`).

### 4.6. Qaytarish, Ta'mirlash va Hisobdan Chiqarish
- **Qaytarish (Returns):** Mijozdan qaytgan mahsulot tekshirilib, pul qaytariladi va mahsulot `returned` yoki `available` holatiga qaytariladi.
- **Ta'mirlash (Repairs):** Nosoz tovarlar servis markaziga yuboriladi va holati kuzatiladi.
- **Hisobdan chiqarish (Writeoff):** Yaroqsiz yoki yo'qolgan tovarlar sababi ko'rsatilib chiqim qilinadi.

### 4.7. 🧠 100% AI Boshqaruv Ekotizimi (Conversational Operator)
Admin va Menejer panellaridagi barcha murakkab modal va formalarni AI orqali boshqarish:
- **Tovar yaratish & Tavsif:** AI Nomi, narxlari, kategoriyasi, brendi va rang variantlarini so'raydi. Tavsifni avtomatik taklif etadi.
- **Interaktiv Tanlov Tugmalari:** Bir nechta tovar yoki variantlar chiqqanda `BUTTONS` va `OPTIONS` ko'rinishida chiqariladi, foydalanuvchi klaviaturasiz bitta bosishda tanlaydi.
- **Partiya qabuli & QR generatsiya:** Tovar qatorlari kiritilgach, avtomatik `receive_stock_batch` orqali `TNB1-...` QR kodlar yaratiladi.
- **Rasm yuklash (Cloudflare R2):** Chat oynasidagi 📸 tugmasi orqali tovar rasmi yuklanib, R2 ga joylanadi va tovarga biriktiriladi.
- **Jonli QR Skaner:** 🔲 tugmasi orqali kamera ochiladi, tovar skanerlangach pasporti va tezkor amallar chiqadi.
- **Ovozli buyruq:** 🎙️ Mikrafon tugmasi orqali o'zbek tilida gapirib buyruq berish mumkin.
- **Moliya & Xarajat:** Do'kon ijarasi, soliq, kommunal xarajatlarni yozish.

---

## 5. Dastur Portlari va Lokal Ishga Tushirish

Loyihani lokal muhitda ishga tushirish uchun quyidagi portlar ajratilgan:

| Ilova | Port | URL | Vazifasi |
| :--- | :--- | :--- | :--- |
| **Storefront** | `5173` | [http://localhost:5173](http://localhost:5173) | Mijozlar uchun internet do'kon |
| **Superadmin** | `5174` | [http://localhost:5174](http://localhost:5174) | Boshqaruv va admin paneli |
| **Manager** | `5175` | [http://localhost:5175](http://localhost:5175) | Menejer va kassa paneli |
| **Seller** | `5176` | [http://localhost:5176](http://localhost:5176) | Sotuvchi POS interfeysi |
| **Courier** | `5177` | [http://localhost:5177](http://localhost:5177) | Kuryer yetkazib berish ilovasi |

### Ishga tushirish buyruqlari:
```bash
# Barcha bog'liqliklarni o'rnatish
npm install

# Alohida app'larni ishga tushirish
npm run dev:storefront   # 5173
npm run dev:superadmin   # 5174
npm run dev:manager      # 5175
npm run dev:seller       # 5176
npm run dev:courier      # 5177
```

---

## 6. Kelgusidagi Rivojlantirish va Muhim Qoidalar

1. **Til talabi:** Foydalanuvchi bilan barcha muloqotlar va foydalanuvchi interfeysi (UI) qat'iy **O'zbek tilida** bo'lishi shart.
2. **Xavfsizlik:**
   - Brauzerda faqat `VITE_SUPABASE_URL` va `VITE_SUPABASE_ANON_KEY` ishlatiladi.
   - `SUPABASE_SECRET_KEY`, `R2_*` maxfiy kalitlari faqat server qatlamida (`apps/superadmin/api/*` yoki Vercel functions) ishlatiladi.
3. **Ma'lumotlar yaxlitligi:** Tovar holatini o'zgartirish, sotish yoki o'chirish hech qachon to'g'ridan-to'g'ri `UPDATE/DELETE` bilan emas, doimo atomik tranzaksion **RPC funksiyalar** orqali amalga oshiriladi.
4. **Fayl saqlash:** Mahsulot rasmlari va hujjatlar Supabase Storage'da emas, balki Cloudflare R2'da saqlanadi. Bazada faqat R2 kaliti va URL havolasi saqlanadi.

