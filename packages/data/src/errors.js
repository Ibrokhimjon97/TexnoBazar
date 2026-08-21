const SCHEMA_ERROR_CODES = new Set([
  'PGRST202',
  'PGRST204',
  'PGRST205',
  '42P01',
  '42703',
  'DATABASE_SCHEMA_OUTDATED',
]);

export const DATABASE_UPDATE_MESSAGE = 'Ma’lumotlar bazasi sxemasi yangilanmagan. Target Supabase migratsiyalarini ketma-ket qo‘llang va PostgREST schema cache’ni yangilang.';

export function isSchemaCompatibilityError(error) {
  const code = String(error?.code || '');
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ').toLowerCase();
  return SCHEMA_ERROR_CODES.has(code)
    || text.includes('schema cache')
    || text.includes('could not find the function')
    || text.includes('could not find the table');
}

export function normalizeDataError(error, operation = '') {
  if (!isSchemaCompatibilityError(error)) return error;
  const normalized = new Error(`${DATABASE_UPDATE_MESSAGE}${operation ? ` Amal: ${operation}.` : ''}`);
  normalized.name = 'DatabaseSchemaError';
  normalized.code = 'DATABASE_SCHEMA_OUTDATED';
  normalized.operation = operation;
  normalized.cause = error;
  return normalized;
}

export function throwDataError(error, operation = '') {
  throw normalizeDataError(error, operation);
}
