import { createClient } from '@supabase/supabase-js';

export class ApiError extends Error {
  constructor(status, message, code = 'API_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function createServerSupabase(env = process.env) {
  const url = env.VITE_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error('Supabase server muhiti sozlanmagan.');
  }
  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function getBearerToken(req) {
  const authorization = Array.isArray(req.headers?.authorization)
    ? req.headers.authorization[0]
    : req.headers?.authorization;
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+([^\s]+)$/i)
    : null;
  if (!match) {
    throw new ApiError(401, 'Autentifikatsiya talab qilinadi.', 'AUTH_REQUIRED');
  }
  return match[1];
}

export async function getActiveActor(admin, token) {
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) {
    throw new ApiError(401, 'Sessiya yaroqsiz.', 'INVALID_SESSION');
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id,is_active')
    .eq('id', authData.user.id)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile?.is_active) {
    throw new ApiError(403, 'Faol profil talab qilinadi.', 'INACTIVE_PROFILE');
  }
  return { id: authData.user.id };
}

export async function requireCatalogPermission(admin, actorId) {
  const { data: roles, error } = await admin.from('profile_roles').select('role,branch_id')
    .eq('profile_id', actorId).in('role', ['superadmin', 'admin', 'manager']);
  if (error) throw error;
  if (!roles || roles.length === 0) {
    throw new ApiError(403, 'Katalog boshqaruvi uchun admin yoki manager roli talab qilinadi.', 'FORBIDDEN');
  }
}

export async function requireMediaPermission(admin, actorId) {
  const { data: roles, error } = await admin
    .from('profile_roles')
    .select('role,branch_id')
    .eq('profile_id', actorId)
    .in('role', ['superadmin', 'admin', 'manager']);
  if (error) throw error;
  if (!roles || roles.length === 0) {
    throw new ApiError(403, 'Rasm yuklash uchun admin yoki manager roli talab qilinadi.', 'FORBIDDEN');
  }
}


export async function requireEmployeeCreationPermission(admin, actorId) {
  const { data: roles, error } = await admin
    .from('profile_roles')
    .select('role,branch_id')
    .eq('profile_id', actorId)
    .eq('role', 'superadmin');
  if (error) throw error;

  const isGlobalSuperadmin = roles?.some(({ branch_id: assignedBranchId }) => assignedBranchId === null);
  if (!isGlobalSuperadmin) {
    throw new ApiError(
      403,
      'Xodim yaratish uchun global superadmin roli talab qilinadi.',
      'FORBIDDEN',
    );
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const existingCors = (typeof res.getHeader === 'function')
    ? (res.getHeader('Access-Control-Allow-Origin') || res.getHeader('access-control-allow-origin'))
    : null;
  if (!existingCors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  if (!res.getHeader?.('Access-Control-Allow-Methods') && !res.getHeader?.('access-control-allow-methods')) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (!res.getHeader?.('Access-Control-Allow-Headers') && !res.getHeader?.('access-control-allow-headers')) {
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req, { maxBytes = 16 * 1024 } = {}) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
    return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ApiError(413, 'So‘rov hajmi juda katta.', 'BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  if (size === 0) throw new ApiError(400, 'JSON tanasi talab qilinadi.', 'BODY_REQUIRED');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function handleApiError(res, error, fallbackMessage) {
  if (error instanceof ApiError) {
    return sendJson(res, error.status, { error: error.message, code: error.code });
  }
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
    return sendJson(res, 400, { error: error.message, code: 'INVALID_INPUT' });
  }
  console.error(fallbackMessage, { name: error?.name, message: error?.message, code: error?.code, stack: error?.stack?.split('\n').slice(0, 5).join('\n') });
  return sendJson(res, 500, { error: fallbackMessage, code: 'INTERNAL_ERROR', detail: error?.message || null });
}
