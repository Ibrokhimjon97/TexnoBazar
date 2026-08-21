// Tool catalogue exposed to the model.
//
// Every tool maps to a Postgres RPC that is executed with the ASKING USER's JWT,
// so branch/role restrictions (require_report_access, has_role) still apply.
// The model can therefore never read or change something the user could not do by hand.

const dateProp = description => ({ type: 'string', description: `${description} (YYYY-MM-DD)` });

export const AI_TOOLS = [
  {
    name: 'list_branches',
    rpc: 'ai_list_branches',
    write: false,
    description: 'Barcha faol filiallar va ularning joylashuvlari (do\'kon/ombor) ro\'yxati. '
      + 'Foydalanuvchi filial nomini aytganda uning branch_id sini topish uchun ishlating. '
      + 'Agar savol qaysi filial haqida ekani noaniq bo\'lsa, avval shu tool bilan ro\'yxatni oling va foydalanuvchidan aniqlashtirib so\'rang.',
    parameters: { type: 'object', properties: {} },
    map: () => ({}),
  },
  {
    name: 'search_employees',
    rpc: 'ai_search_employees',
    write: false,
    description: 'Xodimlarni ism yoki telefon bo\'yicha qidirish. Foydalanuvchi xodim ismini aytganda employee_id topish uchun.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Xodim ismi yoki telefon raqamining bir qismi' },
        limit: { type: 'integer', description: 'Maksimal natija soni (1-50)' },
      },
    },
    map: a => ({ p_query: a.query ?? null, p_limit: a.limit ?? 10 }),
  },
  {
    name: 'search_products',
    rpc: 'ai_search_products',
    write: false,
    description: 'Mahsulotlarni nom, SKU yoki shtrix-kod bo\'yicha qidirish. Narxlar, sayt holati (is_published) va mavjud qoldiq qaytadi. '
      + 'Mahsulot bilan amal bajarishdan (yashirish/tavsif) OLDIN har doim shu tool bilan aniq product_id ni toping.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Mahsulot nomi, SKU yoki shtrix-kodning bir qismi' },
        limit: { type: 'integer', description: 'Maksimal natija soni (1-30)' },
      },
    },
    map: a => ({ p_query: a.query ?? null, p_limit: a.limit ?? 10 }),
  },
  {
    name: 'inventory_valuation',
    rpc: 'ai_inventory_valuation',
    write: false,
    description: 'Qoldiq va uning qiymati: nechta birlik, nechta tur, jami tannarx, minimal/ulgurji/chakana narxda sotilsa qancha bo\'ladi va qancha foyda. '
      + 'Joylashuv (do\'kon/ombor) va filial bo\'yicha ajratib beradi. "Omborda qancha tovar bor?" turidagi savollar uchun.',
    parameters: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Filial UUID. Bo\'sh qoldirilsa barcha filiallar (faqat admin uchun).' },
        location_type: { type: 'string', enum: ['store', 'warehouse'], description: 'store = do\'kon, warehouse = ombor. Bo\'sh qoldirilsa ikkalasi.' },
        top_limit: { type: 'integer', description: 'Tannarx bo\'yicha eng yirik nechta mahsulot ko\'rsatilsin (1-50)' },
      },
    },
    map: a => ({ p_branch_id: a.branch_id ?? null, p_location_type: a.location_type ?? null, p_top_limit: a.top_limit ?? 10 }),
  },
  {
    name: 'seller_performance',
    rpc: 'ai_seller_performance',
    write: false,
    description: 'Sotuvchilar savdo natijalari: nechta chek, nechta birlik, jami tannarx, soliqsiz tushum, chegirma va sof foyda. '
      + 'employee_query berilsa faqat shu xodim, berilmasa reyting (eng ko\'p savdo qilganlar). '
      + '"Ilhomjon bugun qanday savdo qildi?" yoki "bu oyda qaysi xodim eng ko\'p sotdi?" uchun.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        employee_query: { type: 'string', description: 'Xodim ismining bir qismi (ixtiyoriy)' },
        limit: { type: 'integer', description: 'Reytingda nechta xodim (1-50), masalan top 5 uchun 5' },
      },
    },
    map: a => ({
      p_from: a.from ?? null, p_to: a.to ?? null, p_branch_id: a.branch_id ?? null,
      p_employee_query: a.employee_query ?? null, p_limit: a.limit ?? 5,
    }),
  },
  {
    name: 'product_performance',
    rpc: 'ai_product_performance',
    write: false,
    description: 'Tovarlar sotilishi tahlili: eng yaxshi (best) yoki eng kam (worst) sotilgan mahsulotlar, '
      + 'hamda qoldiqda turgan-u shu oraliqda hech sotilmagan tovarlar (unsold_stock). '
      + '"Qaysi tovarlar yaxshi sotilyapti?" uchun.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        order: { type: 'string', enum: ['best', 'worst'], description: 'best = eng ko\'p sotilgan, worst = eng kam sotilgan' },
        limit: { type: 'integer', description: 'Nechta mahsulot (1-50)' },
      },
    },
    map: a => ({
      p_from: a.from ?? null, p_to: a.to ?? null, p_branch_id: a.branch_id ?? null,
      p_order: a.order ?? 'best', p_limit: a.limit ?? 10,
    }),
  },
  {
    name: 'expense_report',
    rpc: 'ai_expense_report',
    write: false,
    description: 'Xarajatlar hisoboti: kassa tranzaksiyalari, qo\'lda kiritilgan xarajatlar (soliq, ijara, kommunal) va maoshlar birlashtirilgan holda, '
      + 'kategoriya kesimida. Har bir xodim maoshi tafsiloti ham qaytadi. "Bu oygi harajatlarni hisobla" uchun.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy). Bo\'sh = barcha filiallar.' },
      },
    },
    map: a => ({ p_from: a.from ?? null, p_to: a.to ?? null, p_branch_id: a.branch_id ?? null }),
  },
  {
    name: 'employee_salary',
    rpc: 'ai_employee_salary',
    write: false,
    description: 'Bitta xodimning maosh tarixi: asosiy maosh, bonus, avans, to\'langan summa, qo\'shimcha to\'lovlar, '
      + 'qachon to\'langani va qancha qarz qolgani (remaining_uzs). "Xodimga yana qancha to\'lash kerak?" uchun.',
    parameters: {
      type: 'object',
      properties: {
        employee_query: { type: 'string', description: 'Xodim ismining bir qismi (majburiy)' },
        period_month: { type: 'string', description: 'Oy, YYYY-MM formatida. Bo\'sh qoldirilsa oxirgi 24 oy.' },
      },
      required: ['employee_query'],
    },
    map: a => ({ p_employee_query: a.employee_query, p_period_month: a.period_month ?? null }),
  },
  {
    name: 'transfer_summary',
    rpc: 'ai_transfer_summary',
    write: false,
    description: 'Filiallararo transferlar va ular yuzasidan qarzlar: nechta birlik ko\'chirilgan, tannarxi, transfer summasi, '
      + 'to\'langan va qolgan qarz. only_unpaid=true bilan faqat to\'lanmagan qarzlar. '
      + '"N filial asosiy filialdan qancha tovar olgan, qarzi qancha?" uchun.',
    parameters: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        from: dateProp('Boshlanish sanasi (ixtiyoriy)'),
        to: dateProp('Tugash sanasi (ixtiyoriy)'),
        only_unpaid: { type: 'boolean', description: 'true bo\'lsa faqat to\'lanmagan/qisman to\'langan qarzlar' },
      },
    },
    map: a => ({
      p_branch_id: a.branch_id ?? null, p_from: a.from ?? null,
      p_to: a.to ?? null, p_only_unpaid: a.only_unpaid ?? false,
    }),
  },
  {
    name: 'unit_lifecycle',
    rpc: 'get_unit_lifecycle',
    write: false,
    description: 'QR kod yoki seriya raqami bo\'yicha bitta tovar birligining to\'liq tarixi: qaysi partiyada kelgan, tannarx, '
      + 'narxlar, joylashuvi, kim qachon qanchaga sotgan, qaytarilgan/hisobdan chiqarilganmi, barcha harakatlar. '
      + '"Bu QR kodli tovar haqida ayt" uchun.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'QR kod yoki zavod seriya raqami' } },
      required: ['code'],
    },
    map: a => ({ p_code: a.code }),
  },
  {
    name: 'unit_passport',
    rpc: 'get_inventory_unit_passport',
    write: false,
    description: 'QR kod bo\'yicha tovar pasporti: mahsulot narxlari (tannarx, chakana, ulgurji, minimal), partiya ma\'lumoti, '
      + 'ta\'minotchi, joylashuvi va harakatlar tarixi. Saytdagi URL uchun product.slug dan foydalaning.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'QR kod yoki seriya raqami' } },
      required: ['code'],
    },
    map: a => ({ p_code: a.code }),
  },
  {
    name: 'profit_loss',
    rpc: 'report_profit_loss',
    write: false,
    description: 'Foyda va zarar hisoboti: tushum, refund, sof savdo, tannarx (COGS), yalpi foyda, boshqa daromad, '
      + 'operatsion xarajatlar va sof foyda. Umumiy moliyaviy holat uchun.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
      },
      required: ['from', 'to'],
    },
    map: a => ({ p_from: a.from, p_to: a.to, p_branch_id: a.branch_id ?? null }),
  },
  {
    name: 'sales_history',
    rpc: 'list_sales_history',
    write: false,
    description: 'Sotilgan tovarlar ro\'yxati (har bir birlik alohida qator): mahsulot, sotuvchi, filial, sotuv narxi, '
      + 'tannarx, sana, QR kod. Aniq sotuvlarni ko\'rish kerak bo\'lganda.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        query: { type: 'string', description: 'Mahsulot nomi, SKU, QR yoki seriya bo\'yicha filtr' },
        limit: { type: 'integer', description: 'Maksimal qatorlar soni' },
      },
    },
    map: a => ({
      p_branch_id: a.branch_id ?? null, p_from: a.from ?? null, p_to: a.to ?? null,
      p_query: a.query ?? null, p_limit: Math.min(a.limit ?? 30, 100), p_offset: 0,
    }),
  },
  // ---- Write tools -------------------------------------------------------
  {
    name: 'set_product_visibility',
    rpc: 'ai_set_product_visibility',
    write: true,
    description: 'Mahsulotni customer saytida ko\'rinadigan yoki yashirin qilish. '
      + 'MUHIM: bu o\'zgartirish amali. Bajarishdan oldin search_products bilan aniq mahsulotni topib, '
      + 'foydalanuvchidan tasdiq oling (masalan "Samsung TV 55 (SKU: ...) ni saytdan yashiraymi?"). '
      + 'Bir nechta mos mahsulot topilsa, albatta qaysi biri ekanini so\'rang.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Mahsulot UUID (search_products dan olingan)' },
        publish: { type: 'boolean', description: 'true = saytda ko\'rsatish, false = saytdan yashirish' },
      },
      required: ['product_id', 'publish'],
    },
    map: a => ({ p_product_id: a.product_id, p_publish: a.publish }),
  },
  {
    name: 'update_product_description',
    rpc: 'ai_update_product_description',
    write: true,
    description: 'Mahsulot tavsifini yangilash. MUHIM: bu o\'zgartirish amali. '
      + 'Yangi tavsifni foydalanuvchiga ko\'rsatib tasdiq olgandan keyin bajaring. '
      + 'Mahsulotning sayt holati (is_published) o\'zgarmaydi.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Mahsulot UUID' },
        description: { type: 'string', description: 'Yangi tavsif matni (HTML yoki oddiy matn)' },
      },
      required: ['product_id', 'description'],
    },
    map: a => ({ p_product_id: a.product_id, p_description: a.description }),
  },
];

export const TOOL_BY_NAME = new Map(AI_TOOLS.map(tool => [tool.name, tool]));

export function buildSystemPrompt({ actorName, roles, branches, today }) {
  const roleList = roles.map(r => (r.branch_name ? `${r.role}@${r.branch_name}` : `${r.role} (global)`)).join(', ');
  const branchList = branches.length
    ? branches.map(b => `- ${b.name} (code: ${b.code}, branch_id: ${b.branch_id})`).join('\n')
    : '- (filial ro\'yxati mavjud emas)';

  return `Sen Texnobazar savdo tizimining ichki AI yordamchisisan. Sen ombor, savdo, xodimlar, moliya va sayt ma'lumotlariga tool'lar orqali kirishing mumkin.

## Kim bilan gaplashyapsan
Foydalanuvchi: ${actorName || 'xodim'}
Rollari: ${roleList || 'aniqlanmagan'}
Bugungi sana: ${today}

## Mavjud filiallar
${branchList}

## Asosiy qoidalar
1. **Har doim tool'lardan foydalan.** Hech qachon son yoki statistika o'ylab topma. Ma'lumot kerak bo'lsa tool chaqir.
2. **Javob tilida:** foydalanuvchi o'zbek tilida yozsa o'zbek tilida javob ber. Sonlarni o'qishga qulay yoz (masalan 12 500 000 so'm).
3. **Valyuta:** bazadagi barcha narxlar UZS (so'm)da. Tool javobida exchange_rate_usd_uzs bo'lsa, USD ni shu kurs bilan hisoblab, ikkalasini ko'rsat: "1 250 USD (15 625 000 so'm)". Kurs bo'lmasa faqat so'mda ber va kurs kiritilmaganini eslat.
4. **Noaniqlikni aniqlashtir.** Savol qaysi filial, qaysi oy yoki qaysi mahsulot haqida ekani aniq bo'lmasa — taxmin qilma, foydalanuvchidan so'ra. Masalan: "Qaysi filialni nazarda tutyapsiz yoki barcha filiallar bo'yicha hisoblaymi?"
5. **O'zgartirish amallari (set_product_visibility, update_product_description):** avval search_products bilan aniq mahsulotni top, foydalanuvchiga nima o'zgarishini aytib TASDIQ ol, keyin bajarising. Bir nechta mos mahsulot bo'lsa — qaysi biri ekanini so'ra.
6. **Ruxsat cheklovi:** tool "ruxsat yo'q" xatosi qaytarsa, foydalanuvchiga bu ma'lumot uning roli uchun yopiq ekanini muloyim tushuntir. Boshqa yo'l bilan olishga urinma.
7. **Sana oralig'i:** "bugun" = ${today}. "bu oy" = shu oyning 1-sanasidan bugungacha. "bu hafta" = dushanbadan bugungacha. Sanalarni YYYY-MM-DD formatida ber.
8. **Foyda hisobi:** sof foyda = sotuv summasi − soliq − tannarx. Tool'lar buni allaqachon hisoblab beradi (profit_uzs), o'zingiz qayta hisoblamang.

## Javob uslubi
Aniq va tuzilgan javob ber. Ko'p sonli ma'lumot bo'lsa ro'yxat yoki jadval ko'rinishida yoz. Har bir sonning nimani anglatishini ayt. Agar ma'lumot bo'sh chiqsa, "shu oraliqda yozuv topilmadi" deb ochiq ayt — bo'sh natijani nolga aylantirib taxmin qilma.`;
}
