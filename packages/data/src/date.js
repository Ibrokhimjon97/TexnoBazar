/**
 * O'zbek tili uchun sana, oy va hafta kunlarini to'g'ri formatlash yordamchilari.
 * Brauzerlarning (Chrome/Edge) 'uz-UZ' bo'yicha cheklovlari (inglizcha "Thu", "M10" chiqishi)ni to'liq hal qiladi.
 */

export const UZ_MONTHS = [
  'Yanvar',
  'Fevral',
  'Mart',
  'Aprel',
  'May',
  'Iyun',
  'Iyul',
  'Avgust',
  'Sentabr',
  'Oktabr',
  'Noyabr',
  'Dekabr',
];

export const UZ_MONTHS_LOWER = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];

export const UZ_WEEKDAYS_LONG = [
  'Yakshanba',
  'Dushanba',
  'Seshanba',
  'Chorshanba',
  'Payshanba',
  'Juma',
  'Shanba',
];

export const UZ_WEEKDAYS_SHORT = [
  'Yak',
  'Dush',
  'Sesh',
  'Chor',
  'Pay',
  'Jum',
  'Shan',
];

/**
 * Xavfsiz Date qismlarini ajratib olish (Timezone va string xatolaridan holi).
 * @param {string|Date|number} input
 */
export function parseDateParts(input) {
  if (!input) return null;
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    return {
      year: input.getFullYear(),
      month: input.getMonth(),
      day: input.getDate(),
      dayOfWeek: input.getDay(),
      hours: input.getHours(),
      minutes: input.getMinutes(),
      seconds: input.getSeconds(),
    };
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    // Faqat sof YYYY-MM yoki YYYY-MM-DD formatlari (vaqtsiz)
    const ymd = trimmed.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (ymd) {
      const year = parseInt(ymd[1], 10);
      const month = parseInt(ymd[2], 10) - 1;
      const day = ymd[3] ? parseInt(ymd[3], 10) : 1;
      const tempDate = new Date(year, month, day);
      return {
        year,
        month,
        day,
        dayOfWeek: tempDate.getDay(),
        hours: 0,
        minutes: 0,
        seconds: 0,
      };
    }

    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      return {
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        dayOfWeek: d.getDay(),
        hours: d.getHours(),
        minutes: d.getMinutes(),
        seconds: d.getSeconds(),
      };
    }
  }

  if (typeof input === 'number') {
    const d = new Date(input);
    if (!isNaN(d.getTime())) {
      return {
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        dayOfWeek: d.getDay(),
        hours: d.getHours(),
        minutes: d.getMinutes(),
        seconds: d.getSeconds(),
      };
    }
  }

  return null;
}

/**
 * O'zbekcha sana formatlash:
 * Masalan:
 * - formatUzDate('2026-10-08') -> "8-oktabr 2026-yil"
 * - formatUzDate('2026-10-08', { weekday: 'long', year: false }) -> "8-oktabr, Payshanba"
 * - formatUzDate('2026-10-08', { weekday: 'short', year: false }) -> "8-oktabr, Pay"
 * - formatUzDate('2026-10-08', { weekday: 'long', year: true }) -> "8-oktabr 2026-yil, Payshanba"
 * - formatUzDate(now, { time: true }) -> "8-oktabr 2026-yil, 22:15"
 */
export function formatUzDate(input, options = {}) {
  const parts = parseDateParts(input);
  if (!parts) return '—';

  const {
    weekday = null, // 'long' | 'short' | null
    month = 'long', // 'long' | 'short' | 'numeric'
    year = true,
    day = true,
    time = false,
  } = options;

  let text = '';

  if (day && month !== 'numeric') {
    const monthName = month === 'short'
      ? UZ_MONTHS_LOWER[parts.month].slice(0, 3)
      : UZ_MONTHS_LOWER[parts.month];
    text = `${parts.day}-${monthName}`;
  } else if (day && month === 'numeric') {
    const dd = String(parts.day).padStart(2, '0');
    const mm = String(parts.month + 1).padStart(2, '0');
    text = `${dd}.${mm}.${parts.year}`;
    return text;
  } else {
    text = UZ_MONTHS[parts.month];
  }

  if (year && month !== 'numeric') {
    text += ` ${parts.year}-yil`;
  }

  if (weekday === 'long') {
    text += `, ${UZ_WEEKDAYS_LONG[parts.dayOfWeek]}`;
  } else if (weekday === 'short') {
    text += `, ${UZ_WEEKDAYS_SHORT[parts.dayOfWeek]}`;
  }

  if (time) {
    const hh = String(parts.hours).padStart(2, '0');
    const min = String(parts.minutes).padStart(2, '0');
    text += `, ${hh}:${min}`;
  }

  return text;
}

/**
 * Hafta kuni nomini olish (masalan, "Payshanba" yoki "Pay")
 */
export function getUzWeekday(input, { short = false } = {}) {
  const parts = parseDateParts(input);
  if (!parts) return '';
  return short ? UZ_WEEKDAYS_SHORT[parts.dayOfWeek] : UZ_WEEKDAYS_LONG[parts.dayOfWeek];
}

/**
 * Oy nomi va yilini olish (masalan, "Oktabr 2026" yoki "Oktabr")
 */
export function getUzMonthName(input, { withYear = true } = {}) {
  const parts = parseDateParts(input);
  if (!parts) return '';
  const monthName = UZ_MONTHS[parts.month];
  return withYear ? `${monthName} ${parts.year}` : monthName;
}

/**
 * Vaqtni "22:15" formatida qaytarish
 */
export function formatUzTime(input) {
  const parts = parseDateParts(input);
  if (!parts) return '—';
  const hh = String(parts.hours).padStart(2, '0');
  const min = String(parts.minutes).padStart(2, '0');
  return `${hh}:${min}`;
}
