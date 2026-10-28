// Tool catalogue exposed to the model.
//
// Every tool maps to a Postgres RPC that is executed with the ASKING USER's JWT,
// so branch/role restrictions (require_report_access, has_role) still apply.
// The model can therefore never read or change something the user could not do by hand.

const dateProp = description => ({ type: 'string', description: `${description} (YYYY-MM-DD)` });

function safeJsonb(val, fallback = '[]') {
  if (!val) return fallback;
  if (typeof val === 'string') {
    try { JSON.parse(val); return val; } catch { return fallback; }
  }
  try { return JSON.stringify(val); } catch { return fallback; }
}

export const AI_TOOLS = [
  // ---- Read & Reporting Tools (Global & Branch Aware) -----------------------
  {
    name: 'get_metadata_catalogs',
    rpc: 'ai_get_metadata_catalogs',
    write: false,
    description: 'Barcha faol kategoriyalar, brendlar, ta\'minotchilar (suppliers), filiallar va ularning joylashuvlari (locations - do\'kon/ombor). '
      + 'Yangi tovar qo\'shish, partiya qabul qilish yoki foydalanuvchiga kategoriya/brend/joy tanlovlarini tugma qilib ko\'rsatishdan OLDIN shu tool bilan ma\'lumotlarni oling.',
    parameters: { type: 'object', properties: {} },
    map: () => ({}),
  },
  {
    name: 'list_branches',
    rpc: 'ai_list_branches',
    write: false,
    description: 'Barcha faol filiallar va ularning joylashuvlari (do\'kon/ombor) ro\'yxati. '
      + 'Foydalanuvchi filial nomini aytganda uning branch_id sini topish uchun ishlating.',
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
    description: 'Mahsulotlarni nom, SKU yoki shtrix-kod bo\'yicha qidirish. Narxlar, sayt holati (is_published), mavjud qoldiq va rang variantlari qaytadi. '
      + 'color parametri bilan faqat shu rangga ega mahsulotlarni filtrlash mumkin. '
      + 'Mahsulot bilan amal bajarishdan (o\'chirish/yashirish/tavsif) OLDIN har doim shu tool bilan aniq product_id ni toping.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Mahsulot nomi, SKU yoki shtrix-kodning bir qismi' },
        color: { type: 'string', description: 'Rang nomi bo\'yicha filtr (masalan: qora, oq, kulrang). Ixtiyoriy.' },
        limit: { type: 'integer', description: 'Maksimal natija soni (1-30)' },
      },
    },
    map: a => ({ p_query: a.query ?? null, p_limit: a.limit ?? 10, p_color: a.color ?? null }),
  },
  {
    name: 'product_stock_by_branch',
    rpc: 'ai_product_stock_by_branch',
    write: false,
    description: 'Mahsulotning har bir filial va joylashuvda (do\'kon/ombor) nechta mavjud birlik borligini ko\'rsatadi. '
      + '"Do\'kon va filiallarda nechta ARTEL 55 TV bor?" turidagi savollar uchun eng mos tool.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Mahsulot nomi, SKU yoki shtrix-kod (majburiy)' },
        branch_id: { type: 'string', description: 'Faqat bitta filial uchun filtrlamoqchi bo\'lsangiz UUID bering (ixtiyoriy)' },
        color: { type: 'string', description: 'Rang nomi bo\'yicha filtr (masalan: qora, oq). Ixtiyoriy.' },
        limit: { type: 'integer', description: 'Mos mahsulotlar soni (1-20)' },
      },
      required: ['query'],
    },
    map: a => ({ p_query: a.query, p_branch_id: a.branch_id ?? null, p_limit: a.limit ?? 5, p_color: a.color ?? null }),
  },
  {
    name: 'product_detail',
    rpc: 'ai_product_detail',
    write: false,
    description: 'Bitta mahsulotning to\'liq ma\'lumoti: narxlar, tavsif, holat, brend, kategoriya, soni (mavjud/sotilgan/jami).',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Mahsulot UUID' },
      },
      required: ['product_id'],
    },
    map: a => ({ p_product_id: a.product_id }),
  },
  {
    name: 'inventory_valuation',
    rpc: 'ai_inventory_valuation',
    write: false,
    description: 'Qoldiq va uning qiymati: nechta birlik, nechta tur, jami tannarx, minimal/ulgurji/chakana narxda sotilsa qancha bo\'ladi va qancha foyda.',
    parameters: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Filial UUID. Bo\'sh qoldirilsa barcha filiallar.' },
        location_type: { type: 'string', enum: ['store', 'warehouse'], description: 'store = do\'kon, warehouse = ombor.' },
        top_limit: { type: 'integer', description: 'Tannarx bo\'yicha eng yirik nechta mahsulot ko\'rsatilsin (1-50)' },
      },
    },
    map: a => ({ p_branch_id: a.branch_id ?? null, p_location_type: a.location_type ?? null, p_top_limit: a.top_limit ?? 10 }),
  },
  {
    name: 'seller_performance',
    rpc: 'ai_seller_performance',
    write: false,
    description: 'Sotuvchilar savdo natijalari: nechta chek, nechta birlik, jami tannarx, soliqsiz tushum, chegirma va sof foyda.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        employee_query: { type: 'string', description: 'Xodim ismining bir qismi (ixtiyoriy)' },
        limit: { type: 'integer', description: 'Reytingda nechta xodim (1-50)' },
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
    description: 'Tovarlar sotilishi tahlili: eng yaxshi (best) yoki eng kam (worst) sotilgan mahsulotlar hamda sotilmagan qoldiqlar.',
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
    description: 'Xarajatlar hisoboti: soliq, ijara, kommunal va maoshlar birlashtirilgan holda kategoriya kesimida.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi'),
        to: dateProp('Tugash sanasi'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
      },
    },
    map: a => ({ p_from: a.from ?? null, p_to: a.to ?? null, p_branch_id: a.branch_id ?? null }),
  },
  {
    name: 'employee_salary',
    rpc: 'ai_employee_salary',
    write: false,
    description: 'Bitta xodimning maosh tarixi: asosiy maosh, bonus, avans, to\'langan summa va qarz.',
    parameters: {
      type: 'object',
      properties: {
        employee_query: { type: 'string', description: 'Xodim ismining bir qismi (majburiy)' },
        period_month: { type: 'string', description: 'Oy, YYYY-MM formatida.' },
      },
      required: ['employee_query'],
    },
    map: a => ({ p_employee_query: a.employee_query, p_period_month: a.period_month ?? null }),
  },
  {
    name: 'unit_passport',
    rpc: 'get_inventory_unit_passport',
    write: false,
    description: 'QR kod bo\'yicha tovar pasporti: narxlar, partiya ma\'lumoti, ta\'minotchi, joylashuvi va harakatlar tarixi.',
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
    description: 'Foyda va zarar hisoboti: tushum, refund, sof savdo, tannarx, yalpi foyda, xarajatlar va sof foyda.',
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
    description: 'Sotilgan tovarlar ro\'yxati: mahsulot, sotuvchi (seller_name), filial, sotuv narxi, tannarx, sana, QR kod, chek raqami (sale_no). '
      + '"Kim sotdi?", "Qachon sotildi?", "Qaysi chekda sotilgan?" savollari uchun shu tool ni tovar nomi, SKU yoki QR kod bo\'yicha chaqiring.',
    parameters: {
      type: 'object',
      properties: {
        from: dateProp('Boshlanish sanasi (ixtiyoriy)'),
        to: dateProp('Tugash sanasi (ixtiyoriy)'),
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        seller_id: { type: 'string', description: 'Sotuvchi UUID (ixtiyoriy)' },
        query: { type: 'string', description: 'Mahsulot nomi, SKU yoki QR bo\'yicha filtr (masalan: Saratov, ARTEL, QR kod)' },
        limit: { type: 'integer', description: 'Maksimal qatorlar soni' },
      },
    },
    map: a => ({
      p_branch_id: a.branch_id ?? null,
      p_seller_id: a.seller_id ?? null,
      p_from: a.from ?? null,
      p_to: a.to ?? null,
      p_query: a.query ?? null,
      p_limit: Math.min(a.limit ?? 30, 100),
      p_offset: 0,
    }),
  },
  {
    name: 'seller_leaderboard',
    rpc: 'get_seller_leaderboard',
    write: false,
    description: 'Filial sotuvchilari reytingi (leaderboard): 1, 2, 3 va keyingi o\'rinlar, sotuvchilar sotgan jami summa, cheklar soni, sotilgan donalar va filialdagi ulush (%). '
      + 'period parametri: "day" (kunlik), "week" (haftalik), "month" (oylik), "year" (yillik). '
      + 'date parametri: YYYY-MM-DD ko\'rinishidagi sana (standart bugun).',
    parameters: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Filial UUID (ixtiyoriy)' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Davr: day (kunlik), week (haftalik), month (oylik), year (yillik)' },
        date: dateProp('Sana (YYYY-MM-DD formatida, ixtiyoriy)'),
      },
    },
    map: a => ({
      p_branch_id: a.branch_id ?? null,
      p_period: a.period ?? 'day',
      p_date: a.date ?? null,
    }),
  },

  // ---- Write & Action Tools (Conversational Operations) ---------------------
  {
    name: 'create_or_update_product',
    rpc: 'ai_create_or_update_product',
    write: true,
    description: 'Yangi mahsulot yaratish yoki mavjudini tahrirlash. '
      + 'Barcha narxlar (tannarx, sotish, ulgurji, aksiya, minimal), kategoriya, brend, rang variantlari (colors array) va tavsif kiritiladi. '
      + 'Foydalanuvchi bilan ma\'lumotlar aniqlashtirilgach chaqiring.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Mahsulot to\'liq nomi (masalan: Artel UA43H3502 Smart Televizori)' },
        category_name: { type: 'string', description: 'Kategoriya nomi (masalan: Televizorlar)' },
        category_id: { type: 'string', description: 'Kategoriya UUID (ixtiyoriy)' },
        brand_name: { type: 'string', description: 'Brend nomi (masalan: Artel, Samsung, LG)' },
        brand_id: { type: 'string', description: 'Brend UUID (ixtiyoriy)' },
        cost_price: { type: 'number', description: 'Tannarx (so\'m yoki valyutada)' },
        retail_price: { type: 'number', description: 'Chakana sotish narxi' },
        wholesale_price: { type: 'number', description: 'Ulgurji narx (ixtiyoriy)' },
        promotion_price: { type: 'number', description: 'Aksiya narxi (ixtiyoriy)' },
        minimum_price: { type: 'number', description: 'Minimal ruxsat etilgan sotish narxi (ixtiyoriy)' },
        description: { type: 'string', description: 'Mahsulotning to\'liq tavsifi (HTML yoki matn)' },
        sku: { type: 'string', description: 'SKU kodi (bo\'sh bo\'lsa avtomatik generatsiya bo\'ladi)' },
        barcode: { type: 'string', description: 'Shtrix-kod (ixtiyoriy)' },
        youtube_url: { type: 'string', description: 'YouTube video sharh havolasi (ixtiyoriy)' },
        colors: {
          type: 'array',
          description: 'Rang variantlari ro\'yxati: [{ color_name: "Qora", color_hex: "#000000", retail_price: 2500000, image_url: "https://...", images: ["https://..."] }]',
          items: {
            type: 'object',
            properties: {
              color_name: { type: 'string' },
              color_hex: { type: 'string' },
              retail_price: { type: 'number' },
              image_url: { type: 'string', description: 'Rangning asosiy rasmi URL' },
              images: { type: 'array', items: { type: 'string' }, description: 'Rang uchun bir nechta rasm URL massivi' },
            },
          },
        },
        product_id: { type: 'string', description: 'Agar mavjud tovar tahrirlanayotgan bo\'lsa uning UUID si, yangi tovar uchun bo\'sh qoldiring' },
        is_published: { type: 'boolean', description: 'Saytda darhol e\'lon qilinsinmi (standart: true)' },
        image_url: { type: 'string', description: 'Mahsulot rasmining ommaviy havolasi (R2 URL)' },
      },
      required: ['name'],
    },
    map: a => ({
      p_name: a.name,
      p_category_name: a.category_name ?? null,
      p_category_id: a.category_id ?? null,
      p_brand_name: a.brand_name ?? null,
      p_brand_id: a.brand_id ?? null,
      p_cost_price: a.cost_price ?? 0,
      p_retail_price: a.retail_price ?? 0,
      p_wholesale_price: a.wholesale_price ?? null,
      p_promotion_price: a.promotion_price ?? null,
      p_minimum_price: a.minimum_price ?? null,
      p_description: a.description ?? null,
      p_sku: a.sku ?? null,
      p_barcode: a.barcode ?? null,
      p_youtube_url: a.youtube_url ?? null,
      p_colors: safeJsonb(a.colors, '[]'),
      p_product_id: a.product_id ?? null,
      p_is_published: a.is_published ?? true,
      p_image_url: a.image_url ?? null,
    }),
  },
  {
    name: 'receive_stock_batch',
    rpc: 'ai_receive_stock_batch',
    write: true,
    description: 'Yangi partiya tovarlarni qabul qilish (kirim). '
      + 'Har bir mahsulot uchun alohida TNB1-... QR kodlar yaratiladi. '
      + 'lines massivida har bir tovar product_id si, soni (quantity), tannarxi (unit_cost) va sotish narxi (retail_price) bo\'lishi shart.',
    parameters: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Filial UUID' },
        location_id: { type: 'string', description: 'Qabul joyi (Ombor yoki Do\'kon) UUID' },
        supplier_id: { type: 'string', description: 'Yetkazib beruvchi (Ta\'minotchi) UUID' },
        currency: { type: 'string', enum: ['USD', 'UZS'], description: 'Partiya valyutasi (standart USD)' },
        invoice: { type: 'string', description: 'Hisob-faktura (invoys) raqami' },
        payment_status: { type: 'string', enum: ['paid', 'unpaid', 'partial'], description: 'Ta\'minotchiga to\'lov holati' },
        paid_amount: { type: 'number', description: 'To\'langan summa' },
        lines: {
          type: 'array',
          description: 'Kirim qilinayotgan tovarlar massivi: [{ product_id: "...", quantity: 20, unit_cost: 200, retail_price: 260 }]',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'Mahsulot UUID yoki SKU' },
              variant_id: { type: 'string', description: 'Rang variant UUID (ixtiyoriy)' },
              quantity: { type: 'integer', description: 'Nechta dona kelgan' },
              unit_cost: { type: 'number', description: 'Dona tannarxi' },
              retail_price: { type: 'number', description: 'Chakana sotish narxi' },
            },
            required: ['product_id', 'quantity', 'unit_cost', 'retail_price'],
          },
        },
      },
      required: ['branch_id', 'location_id', 'lines'],
    },
    map: a => ({
      p_branch_id: a.branch_id,
      p_location_id: a.location_id,
      p_supplier_id: a.supplier_id ?? null,
      p_lines: safeJsonb(a.lines, '[]'),
      p_currency: a.currency ?? 'USD',
      p_invoice: a.invoice ?? null,
      p_payment_status: a.payment_status ?? 'paid',
      p_paid_amount: a.paid_amount ?? null,
    }),
  },
  {
    name: 'quick_inventory_stock',
    rpc: 'ai_quick_inventory_stock',
    write: true,
    description: 'Bitta tovardan tezkor son qo\'shish / inventarizatsiya kirimi (masalan: "Artel TV dan omborga 10 ta qoldiq kirit"). '
      + 'Avtomatik QR kodlar shakllantiriladi.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Mahsulot UUID yoki SKU' },
        branch_id: { type: 'string', description: 'Filial UUID' },
        location_id: { type: 'string', description: 'Joylashuv (ombor/do\'kon) UUID' },
        quantity: { type: 'integer', description: 'Qo\'shilayotgan dona soni (1-500)' },
        cost_price: { type: 'number', description: 'Tannarx (ixtiyoriy)' },
        retail_price: { type: 'number', description: 'Sotish narxi (ixtiyoriy)' },
        variant_id: { type: 'string', description: 'Rang variant UUID (ixtiyoriy)' },
      },
      required: ['product_id', 'branch_id', 'location_id', 'quantity'],
    },
    map: a => ({
      p_product_id: a.product_id,
      p_branch_id: a.branch_id,
      p_location_id: a.location_id,
      p_quantity: a.quantity,
      p_cost_price: a.cost_price ?? null,
      p_retail_price: a.retail_price ?? null,
      p_variant_id: a.variant_id ?? null,
    }),
  },
  {
    name: 'delete_or_archive_product',
    rpc: 'ai_delete_or_archive_product',
    write: true,
    description: 'Mahsulotni o\'chirish yoki arxivlash. '
      + 'Agar tovardan sotilgan birliklar bo\'lsa, u xavfsiz arxivlanadi. Sotilmagan bo\'lsa to\'liq o\'chiriladi. '
      + 'MUHIM: bu amal oldidan foydalanuvchidan qat\'iy tasdiq oling!',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'O\'chirilishi kerak bo\'lgan mahsulot UUID' },
      },
      required: ['product_id'],
    },
    map: a => ({ p_product_id: a.product_id }),
  },
  {
    name: 'create_expense',
    rpc: 'ai_create_expense',
    write: true,
    description: 'Filial uchun xarajat qayd etish (masalan: ijara, soliq, elektr, transport, boshqa).',
    parameters: {
      type: 'object',
      properties: {
        branch_id: { type: 'string', description: 'Filial UUID' },
        category: {
          type: 'string',
          enum: ['rent', 'tax', 'electricity', 'water', 'gas', 'salary', 'transport', 'other'],
          description: 'Xarajat toifasi',
        },
        title: { type: 'string', description: 'Xarajat nomi yoki maqsadi (masalan: Do\'kon oylik ijarasi)' },
        amount: { type: 'number', description: 'Xarajat summasi (so\'mda)' },
        note: { type: 'string', description: 'Qo\'shimcha izoh (ixtiyoriy)' },
      },
      required: ['branch_id', 'category', 'title', 'amount'],
    },
    map: a => ({
      p_branch_id: a.branch_id,
      p_category: a.category,
      p_title: a.title,
      p_amount: a.amount,
      p_note: a.note ?? null,
      p_paid_at: new Date().toISOString(),
    }),
  },
  {
    name: 'relocate_unit',
    rpc: 'ai_relocate_unit',
    write: true,
    description: 'Bitta fizik tovarning joylashuvini o\'zgartirish (masalan: ombordan do\'konga yoki aksincha). QR kod yoki seriya raqami beriladi.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Mahsulot QR kodi yoki seriya raqami' },
        target_location_id: { type: 'string', description: 'Yangi joylashuv UUID (Ombor yoki Do\'kon)' },
        note: { type: 'string', description: 'Ko\'chirish sababi / izoh' },
      },
      required: ['code', 'target_location_id'],
    },
    map: a => ({
      p_code: a.code,
      p_target_location_id: a.target_location_id,
      p_note: a.note ?? null,
    }),
  },
  {
    name: 'set_product_visibility',
    rpc: 'ai_set_product_visibility',
    write: true,
    description: 'Mahsulotni customer saytida ko\'rsatish (publish=true) yoki yashirish (publish=false).',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Mahsulot UUID' },
        publish: { type: 'boolean', description: 'true = ko\'rsatish, false = yashirish' },
      },
      required: ['product_id', 'publish'],
    },
    map: a => ({ p_product_id: a.product_id, p_publish: a.publish }),
  },
  {
    name: 'update_product_description',
    rpc: 'ai_update_product_description',
    write: true,
    description: 'Mahsulot tavsifini yangilash.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Mahsulot UUID' },
        description: { type: 'string', description: 'Yangi tavsif matni' },
      },
      required: ['product_id', 'description'],
    },
    map: a => ({ p_product_id: a.product_id, p_description: a.description }),
  },
];

export const TOOL_BY_NAME = new Map(AI_TOOLS.map(tool => [tool.name, tool]));

export function buildSystemPrompt({ actorName, roles, branches, categories = [], brands = [], today }) {
  const roleList = roles.map(r => (r.branch_name ? `${r.role}@${r.branch_name}` : `${r.role} (global)`)).join(', ');
  const branchList = branches.length
    ? branches.map(b => `- ${b.name} (code: ${b.code}, branch_id: ${b.branch_id})`).join('\n')
    : '- (filial ro\'yxati mavjud emas)';

  const categoryNames = (categories || []).map(c => c.name).filter(Boolean);
  const brandNames = (brands || []).map(b => b.name).filter(Boolean);

  const categoryButtons = JSON.stringify([
    ...categoryNames.map(c => ({ label: c, value: c })),
    { label: '➕ Yangi kategoriya', value: 'Yangi kategoriya ochmoqchiman' },
  ]);

  const brandButtons = JSON.stringify([
    ...brandNames.map(b => ({ label: b, value: b })),
    { label: '➕ Boshqa brend', value: 'Boshqa brend' },
  ]);

  return `SEN TEXNOBAZAR SAVDO PLATFORMASINING ASOSIY AI OPERATORISAN.
Superadmin va Menejer barcha operatsiyalarni SENING YORDAMINGDA suhbat orqali bajaradi.

Foydalanuvchi: ${actorName || 'xodim'} | Rollar: ${roleList || 'noaniq'} | Bugun: ${today}

Filiallar:
${branchList}

Bazadagi barcha faol kategoriyalar (${categoryNames.length} ta):
${categoryNames.join(', ') || '(mavjud emas)'}

Bazadagi barcha faol brendlar (${brandNames.length} ta):
${brandNames.join(', ') || '(mavjud emas)'}

🚀 SENING ASOSIY VAZIFALARING VA QUROLLARING (TOOLS):
1. **create_or_update_product** — Yangi mahsulot yaratish yoki tahrirlash (Nomi, Brendi, Kategoriyasi, Tannarxi, Sotish narxi, Ulgurji narxi, Minimal sotish narxi, Tavsifi, Ranglari).
2. **receive_stock_batch** — Yangi partiya tovarlarni qabul qilish (kirim) va har bir dona uchun avtomatik TNB1-... QR kodlar generatsiya qilish.
3. **quick_inventory_stock** — Tezkor inventarizatsiya qoldig'i kiritish (bitta buyruq bilan donalar qo'shish).
4. **create_expense** — Do'kon ijarasi, soliq, elektr, maosh kabi xarajatlarni yozish.
5. **delete_or_archive_product** — Mahsulotni o'chirish yoki arxivlash.
6. **get_metadata_catalogs** — Bazadagi barcha faol kategoriyalar, brendlar, ta'minotchilar va filial joylashuvlarini olish.

⚡ MAHSULOT YARATISHNING QAT'IY BOSQICHMA-BOSQICH TARTIBI:
Foydalanuvchi "Yangi mahsulot qo'shmoqchiman" yoki shunga o'xshash buyruq berganda, MA'LUMOTLARNI QUYIDAGI KETMA-KETLIKDA ALOHIDA SO'RA:

▶ 1-QADAM: Kategoriya
- Foydalanuvchiga: "Yangi mahsulot qo'shamiz! Qaysi kategoriyaga mansub? Quyidagilardan birini tanlang yoki yangi kategoriya nomini yozing:" deb so'ra.
- BAZADAGI BARCHA ${categoryNames.length} TA KATEGORIYANI HECH BIRINI TUSHIRMASDAN TO'LIQ BUTTONS QILIB CHIQAR:
  \`BUTTONS: ${categoryButtons}\`

▶ 2-QADAM: Brend
- Kategoriya tanlangach: "Mahsulot brendini tanlang yoki yangi brend nomini yozing:" deb so'ra.
- QAT'IY QOIDA: BAZADAGI BARCHA ${brandNames.length} TA FAOL BRENDNI (${brandNames.join(', ')}) HECH BIRINI TUSHIRMASDAN TO'LIQ BUTTONS QILIB CHIQAR, HECH QANDAY O'ZINGDAN BOSHQA BREND TO'QIMA:
  \`BUTTONS: ${brandButtons}\`

▶ 3-QADAM: Mahsulot to'liq nomi / modeli
- Brend tanlangach: "Mahsulotning to'liq nomini / modelini yozing (masalan: **Artel ART-320 No Frost Muzlatgich**):" deb so'ra.

▶ 4-QADAM: Mahsulot ranglari (Colors)
- Nomi kiritilgach: "Mahsulot qaysi ranglarda mavjud? Quyidagilardan tanlang yoki o'zingiz yozing:" deb so'ra va BUTTONS chiqar:
  \`BUTTONS: [{"label": "⬛ Qora", "value": "Qora rang"}, {"label": "⬜ Oq", "value": "Oq rang"}, {"label": "🔘 Kumush / Metall", "value": "Kumush rang"}, {"label": "🟦 Ko'k", "value": "Ko'k rang"}, {"label": "🎨 Ranglar yo'q (Standart)", "value": "Standart rangsiz"}]\`
- **AGAR BIR NECHTA RANG TANLANSA (masalan: Qora va Oq):**
  Darhol so'ra: "Barcha ranglarga **bir xil narx** qo'llanilsinmi yoki **har bir rang uchun alohida narx** belgilaysizmi?"
  \`OPTIONS: ["Barcha ranglarga bir xil narx", "Har bir rangga alohida narx"]\`

▶ 5-QADAM: Narxlar (Barcha 4 ta narxni aniq so'ra)
- Shunday so'ra:
  "Endi mahsulot narxlarini kiriting:
  1️⃣ **Tannarxi** (dona kelgan narxi)
  2️⃣ **Chakana sotish narxi** (oddiy xaridor uchun)
  3️⃣ **Ulgurji narxi** (ulgurji oluvchilar uchun)
  4️⃣ **Minimal sotish narxi** (sotuvchi tushishi mumkin bo'lgan eng past chegara narxi)
  *(Masalan: Tannarxi 2 500 000, sotish 3 200 000, ulgurji 2 900 000, minimal 2 700 000 so'm deb yozishingiz mumkin)*"

▶ 6-QADAM: Tavsifni ko'rsatish (Review) va Ranglar bo'yicha Rasm so'rash
- Narxlar olingach, mahsulot uchun darhol chiroyli va mukammal texnik tavsif yoz.
- Foydalanuvchiga tavsifni ko'rsat va rasm yuklash opsiyalarini quyidagicha taqdim et:

  1. AGAR MAHSULOTDA BIR NECHTA RANG BO'LSA (masalan: Oq va Qora):
     Foydalanuvchiga tavsifni ko'rsatib, quyidagi 3 ta opsiyani ber:
     "📝 **Mahsulot uchun tavsif tayyor:**
     > [O'zing yozgan batafsil, chiroyli va texnik tavsif]

     📸 **Mahsulot rasmlarini qanday yuklaymiz?**"
     \`OPTIONS: ["🎨 Har bir rang uchun alohida rasm yuklash", "🖼️ Bitta umumiy rasm yuklash", "🚫 Rasmsiz saqlash"]\`

     * **A) Agar foydalanuvchi "🎨 Har bir rang uchun alohida rasm yuklash" ni tanlasa:**
       - 1-RANG UCHUN RASM SO'RA:
         "⚪ **1-rang: [1-rang nomi]** uchun rasmlarni yuklang.
         Chat pastidagi 📸 tugmasi orqali ushbu rang uchun bitta yoki bir nechta rasm yuklashingiz mumkin.
         Rasmlarni yuklab bo'lgach **'✅ [1-rang nomi] tayyor'** tugmasini bosing:"
         \`OPTIONS: ["✅ [1-rang nomi] tayyor", "⏭️ Bu rangga rasm yo'q"]\`
       - Foydalanuvchi rasmlarni yuklab "Tayyor" degach (yoki o'tkazib yuborgach):
       - 2-RANG UCHUN RASM SO'RA:
         "⚫ **2-rang: [2-rang nomi]** uchun rasmlarni yuklang.
         Chat pastidagi 📸 tugmasi orqali ushbu rang uchun bitta yoki bir nechta rasm yuklashingiz mumkin.
         Rasmlarni yuklab bo'lgach **'✅ [2-rang nomi] tayyor'** tugmasini bosing:"
         \`OPTIONS: ["✅ [2-rang nomi] tayyor", "⏭️ Bu rangga rasm yo'q"]\`
       - *(Agar 3- va keyingi ranglar bo'lsa, xuddi shunday ketma-ket har bir rangni alohida so'ra).*
       - Barcha ranglar uchun rasmlar kiritib bo'lingach, to'g'ridan-to'g'ri 7-QADAMga o't.

     * **B) Agar foydalanuvchi "🖼️ Bitta umumiy rasm yuklash" ni tanlasa:**
       - "📸 Mahsulotning umumiy rasmini pastdagi 📸 tugmasi orqali yuklang va **'✅ Tayyor, saqlash'** tugmasini bosing:"
         \`OPTIONS: ["✅ Tayyor, saqlash", "🚫 Rasmsiz saqlash"]\`
       - Foydalanuvchi rasm yuklab "Tayyor" degach, 7-QADAMga o't.

     * **C) Agar "🚫 Rasmsiz saqlash" ni tanlasa:**
       - Darhol 7-QADAMga o't.

  2. AGAR MAHSULOT STANDART / BITTA RANGDA BO'LSA:
     - "📝 **Mahsulot uchun tavsif tayyor:**
     > [O'zing yozgan batafsil, chiroyli va texnik tavsif]

     📸 **Mahsulot rasmini yuklaysizmi?**"
     \`OPTIONS: ["📸 Hozir rasm yuklayman", "✅ Rasmsiz saqlash", "✏️ Tavsifni o'zgartiraman"]\`
     - Foydalanuvchi rasm yuklasa yoki tasdiqlasa, 7-QADAMga o't.

▶ 7-QADAM: Mahsulotni yaratish (create_or_update_product)
- To'plangan barcha ma'lumotlar (Nomi, Kategoriya, Brend, Narxlar, Tavsif, Ranglar va har bir rangga yuklangan rasmlar) bilan \`create_or_update_product\` tool ini chaqir.
- Mahsulot yaratilgach, uning to'liq kartochkasini chiqar (SKU, Nomi, Ranglari, Narxlari, Tavsifi).
- VA HECH QANDAY TO'XTOVSIZ DARHOL 8-QADAMga o't!

▶ 8-QADAM: Dastlabki qoldiq va Partiya kirimi (Receive Stock Batch)
- Mahsulot yaratilgan zahoti darhol so'ra:
  "📦 **Ushbu yangi tovardan hozir filialda (do'kon yoki omborda) nechta bor?**
  Menejer panelida va partiyalar bo'limida qoldiq ko'rinishi uchun har bir rangi bo'yicha sonini kiriting:
  *(Masalan: **Oq rangidan 5 ta, Qora rangidan 10 ta, Asosiy filial do'koniga** deb yozishingiz mumkin)*"
- Va quyidagi tugmalarni chiqar:
  \`OPTIONS: ["Asosiy filial Do'konga kirim qilish", "Asosiy filial Omborga kirim qilish", "Hozircha qoldiq yo'q (0 dona)"]\`
- Foydalanuvchi sonini va joyini aytganda (masalan: "Oq rangidan 5 ta, Qora rangidan 10 ta, Asosiy filial do'koniga"):
  * QAT'IY QOIDA: Yangi yaratilgan tovarning \`product_id\` (yoki SKU) si va rang variantlari suhbat tarixida mavjud. Qayta \`search_products\` yoki \`get_metadata_catalogs\` qilib aylanib o'tirma!
  * DARHOL \`receive_stock_batch\` (yoki har bir rang uchun \`quick_inventory_stock\`) tool ini bitta chaqiriqda bajargin:
    - Masalan: \`receive_stock_batch(branch_id: "...", location_id: "...", lines: [{ product_id: "<yangi_tovar_id_yoki_sku>", quantity: 5, unit_cost: 300, retail_price: 375 }, { product_id: "<yangi_tovar_id_yoki_sku>", quantity: 10, unit_cost: 300, retail_price: 395 }])\`
  * Partiya qabul qilingach DARHOL foydalanuvchiga muvaffaqiyatli xabar qaytar:
    "✅ **Partiya muvaffaqiyatli qabul qilindi!** Barcha donalar uchun TNB1-... QR kodlar yaratildi va Menejer panelidagi Tovarlar (qoldiq) hamda Partiyalar ro'yxatida tovar paydo bo'ldi!"

⚡ BOSHQA MUHIM QOIDALAR:
- **Tovarni kim sotganini aniqlash:** Foydalanuvchi "bu tovarni kim sotdi?", "Saratovni kim sotdi?", "oxirgi sotuv kimniki?" deb so'rasa, DARHOL \`sales_history(query: 'tovar_nomi_yoki_sku')\` tool ini chaqir. Natijadagi \`seller_name\` (sotuvchi ismi), \`sold_at\` (sana va vaqt), \`sale_no\` (chek raqami), \`unit_price\` (sotilgan narx) va \`qr_code\` ni foydalanuvchiga to'liq, aniq va chiroyli qilib aytib ber!
- **Sotuvchilar reytingi:** "Bugun kim ko'p sotdi?", "Sotuvchilar reytingi qanday?", "Top sotuvchilar kimlar?", "Haftalik/oylik peshqadam kim?" deb so'ralsa, \`seller_leaderboard(period: 'day'|'week'|'month'|'year')\` tool ini chaqir va 1, 2, 3-o'rinlarni oltin/kumush/bronza medali bilan, qolgan barcha o'rinlarni esa ro'yxat qilib chiqar.
- **Menejer huquqlari:** Superadmin kabi Menejer ham o'z filiali doirasida barcha imkoniyatlardan (tovar yaratish, partiya qabul qilish, xarajat kiritish, savdolar tarixini tekshirish, reytingni ko'rish) to'liq foydalana oladi. Filial ko'rsatilmagan holatlarda tizim avtomatik ravishda menejerning o'z filialiga moslashtiradi.
- Xarajatlar uchun \`create_expense\` ni chaqir.
- Har doim samimiy, xushmuomala o'zbek tilida muloqot qil.`;
}
