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
  
  // Only treat as schema error if we have explicit PostgREST schema error codes
  // Don't auto-convert generic 400 errors
  const hasSchemaCode = SCHEMA_ERROR_CODES.has(code);
  const hasSchemaText = text.includes('schema cache') 
    || text.includes('could not find the function')
    || text.includes('could not find the table');
  
  // Debug: if not matching, show what we got
  if (!hasSchemaCode && !hasSchemaText && code) {
    console.warn('[DEBUG] Non-schema error detected:', { code, message: error?.message });
  }
  
  return hasSchemaCode || hasSchemaText;
}

export function normalizeDataError(error, operation = '') {
  if (!isSchemaCompatibilityError(error)) return error;
  
  // Debug: log full error details to console
  console.error('[DEBUG] PostgREST Error Details:', {
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    operation
  });
  
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
