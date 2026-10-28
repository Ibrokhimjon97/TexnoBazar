const SCHEMA_ERROR_CODES = new Set([
  'PGRST202',
  'PGRST205',
  '42P01',
  '42703',
  'DATABASE_SCHEMA_OUTDATED',
]);

export const DATABASE_UPDATE_MESSAGE = 'Tizim yangilandi. Iltimos, sahifani yangilang (F5).';

export function isSchemaCompatibilityError(error) {
  const code = String(error?.code || '');
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ').toLowerCase();
  
  // If the error message is a specific business exception in Uzbek, do NOT treat as schema error
  if (error?.message && (
    error.message.includes('Filial') ||
    error.message.includes('ruxsat') ||
    error.message.includes('topilmadi') ||
    error.message.includes('yetarli emas') ||
    error.message.includes('noto‘g‘ri') ||
    error.message.includes('kiriting')
  )) {
    return false;
  }

  const hasSchemaCode = SCHEMA_ERROR_CODES.has(code);
  const hasSchemaText = text.includes('schema cache') 
    || text.includes('could not find the function')
    || text.includes('could not find the table');
  
  return hasSchemaCode || hasSchemaText;
}

export function normalizeDataError(error, operation = '') {
  // If there's already a clean business message, preserve it!
  if (error?.message && !isSchemaCompatibilityError(error)) {
    return error;
  }
  
  console.warn('[PostgREST Error Handler]:', {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    operation
  });
  
  const displayMsg = error?.message && !error.message.includes('schema cache') && !error.message.includes('could not find')
    ? error.message
    : (operation ? `${operation}: Ma’lumotlarni yangilashda xatolik yuz berdi. Iltimos, sahifani yangilang.` : DATABASE_UPDATE_MESSAGE);

  const normalized = new Error(displayMsg);
  normalized.name = 'DatabaseSchemaError';
  normalized.code = 'DATABASE_SCHEMA_OUTDATED';
  normalized.operation = operation;
  normalized.cause = error;
  return normalized;
}

export function throwDataError(error, operation = '') {
  throw normalizeDataError(error, operation);
}
