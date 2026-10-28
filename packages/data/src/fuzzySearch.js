/**
 * O'zbek lotin-kirill transliteratsiyasi va aqlli xatoliklarga chidamli qidiruv yordamchisi.
 * Probel, tire, chiziqcha, nuqta, vergul yoki boshqa belgilar xato kiritilganda
 * yoki kichik orfografik xatoliklarda ham eng yaqin tovarlarni topish uchun xizmat qiladi.
 */

const cyrToLatMap = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'j',
  'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
  'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 'ts',
  'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'ъ': '', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'ў': 'o', 'қ': 'q', 'ғ': 'g', 'ҳ': 'h'
};

export function transliterateCyrillic(str) {
  if (!str) return '';
  return String(str).toLowerCase().split('').map(ch => cyrToLatMap[ch] || ch).join('');
}

export function normalizeSearchText(str) {
  if (!str) return '';
  const latin = transliterateCyrillic(str);
  return latin
    .replace(/[ʻʼ'`‘’]/g, '')
    .replace(/[^a-z0-9]/gi, '');
}

export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Bitta tovar uchun qidiruv moslik ballini hisoblash
 * @param {object} item
 * @param {string} rawQuery
 * @param {string[]} fields
 * @returns {{ match: boolean, score: number, isExact: boolean, matchType: string }}
 */
export function scoreProductMatch(item, rawQuery, fields = ['name', 'sku', 'barcode', 'category_name']) {
  if (!rawQuery || !rawQuery.trim()) {
    return { match: true, score: 100, isExact: true, matchType: 'exact' };
  }

  const q = rawQuery.trim().toLowerCase();
  const qTranslit = transliterateCyrillic(q);
  const qNorm = normalizeSearchText(q);

  // Maydonlar qiymatlarini to'plash
  const fieldValues = fields.map(f => String(item[f] || '').toLowerCase());
  const fieldTranslits = fieldValues.map(v => transliterateCyrillic(v));
  const fieldNorms = fieldValues.map(v => normalizeSearchText(v));

  // 1. To'g'ridan-to'g'ri substring mosligi (aniq moslik)
  const isDirectExact = fieldValues.some(v => v.includes(q)) ||
    fieldTranslits.some(v => v.includes(qTranslit) || v.includes(q));
  if (isDirectExact) {
    // Agar tovar nomi qidiruv so'zi bilan boshlansa - maksimal ball
    const nameVal = fieldValues[0] || '';
    const nameTrans = fieldTranslits[0] || '';
    const startsAtZero = nameVal.startsWith(q) || nameTrans.startsWith(qTranslit);
    return { match: true, score: startsAtZero ? 100 : 98, isExact: true, matchType: 'exact' };
  }

  // 2. Normallashgan moslik (probel, chiziqcha, nuqta, tirelar olib tashlangan holda)
  // Masalan: 't-616' -> 't616', tovar: 'BMCH-T616' -> 'bmcht616'
  if (qNorm.length >= 2) {
    const normIndex = fieldNorms.findIndex(fn => fn.includes(qNorm));
    if (normIndex !== -1) {
      const pos = fieldNorms[normIndex].indexOf(qNorm);
      const score = pos === 0 ? 94 : (normIndex === 0 ? 90 : 85);
      return { match: true, score, isExact: false, matchType: 'normalized' };
    }
  }

  // 3. Ko'p tokenli qidiruv (har bir so'z yoki belgi ajratilganda)
  const qTokens = qTranslit.split(/[\s\-_\/.,+:;()]+/).filter(Boolean).map(normalizeSearchText).filter(t => t.length > 0);
  const allWords = fieldTranslits.flatMap(v => v.split(/[\s\-_\/.,+:;()]+/)).filter(Boolean).map(normalizeSearchText).filter(t => t.length > 0);
  const allFieldJoined = fieldNorms.join(' ');

  if (qTokens.length > 1) {
    const allTokensFound = qTokens.every(qt => allFieldJoined.includes(qt));
    if (allTokensFound) {
      return { match: true, score: 80, isExact: false, matchType: 'tokens' };
    }
  }

  // 4. Noaniq / orfografik xatoliklar (Fuzzy typo matching)
  if (qTokens.length > 0) {
    let matchedCount = 0;
    for (const qt of qTokens) {
      let found = false;
      for (const w of allWords) {
        if (w === qt) {
          found = true;
          break;
        }
        if (qt.length >= 3 && (w.startsWith(qt) || w.includes(qt))) {
          found = true;
          break;
        }
        if (qt.length >= 4 && w.length >= 4) {
          const maxDist = qt.length > 6 ? 2 : 1;
          if (levenshteinDistance(qt, w) <= maxDist) {
            found = true;
            break;
          }
        }
      }
      if (found) matchedCount++;
    }

    if (matchedCount === qTokens.length) {
      return { match: true, score: 68, isExact: false, matchType: 'fuzzy_all' };
    } else if (matchedCount > 0 && matchedCount >= Math.ceil(qTokens.length * 0.6)) {
      return { match: true, score: 52 + Math.round((matchedCount / qTokens.length) * 12), isExact: false, matchType: 'fuzzy_partial' };
    }
  }

  return { match: false, score: 0, isExact: false, matchType: 'none' };
}

/**
 * Tovarlar ro'yxatini filtrlash va reytinglash
 * @param {Array} items - Tovar obyektlari
 * @param {string} query - Qidiruv so'zi
 * @param {object} [options]
 * @returns {{
 *   items: Array,
 *   hasExactMatch: boolean,
 *   hasFuzzyOnly: boolean,
 *   suggestedProducts: Array,
 *   suggestedQuery: string
 * }}
 */
export function filterAndRankProducts(items = [], query = '', options = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return {
      items,
      hasExactMatch: true,
      hasFuzzyOnly: false,
      suggestedProducts: [],
      suggestedQuery: ''
    };
  }

  const fields = options.fields || ['name', 'sku', 'barcode', 'category_name'];
  const minScore = options.minScore || 50;

  const scored = [];
  let exactCount = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const matchRes = scoreProductMatch(it, q, fields);
    if (matchRes.match && matchRes.score >= minScore) {
      if (matchRes.isExact) exactCount++;
      scored.push({
        ...it,
        _searchScore: matchRes.score,
        _searchExact: matchRes.isExact,
        _searchMatchType: matchRes.matchType
      });
    }
  }

  // Yuqori ball bo'yicha saralash
  scored.sort((a, b) => {
    if (b._searchScore !== a._searchScore) {
      return b._searchScore - a._searchScore;
    }
    const nameA = a.name || a.product_name || '';
    const nameB = b.name || b.product_name || '';
    return nameA.localeCompare(nameB, 'uz');
  });

  const hasExactMatch = exactCount > 0;
  const hasFuzzyOnly = !hasExactMatch && scored.length > 0;
  const suggestedProducts = hasFuzzyOnly ? scored.slice(0, 5) : [];
  const suggestedQuery = suggestedProducts.length > 0 ? (suggestedProducts[0].name || suggestedProducts[0].product_name || '') : '';

  return {
    items: scored,
    hasExactMatch,
    hasFuzzyOnly,
    suggestedProducts,
    suggestedQuery
  };
}
