import { createClient } from '@supabase/supabase-js';

let singleton;
export function getBrowserClient() {
  if (singleton) return singleton;
  const url = import.meta.env?.VITE_SUPABASE_URL;
  const anonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase brauzer sozlamalari topilmadi.');
  singleton = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return singleton;
}

export async function signInWithPassword(email, password) {
  const { data, error } = await getBrowserClient().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
export async function signOut() {
  const { error } = await getBrowserClient().auth.signOut();
  if (error) throw error;
}
export function subscribeToAuth(callback) {
  return getBrowserClient().auth.onAuthStateChange(callback).data.subscription;
}
export async function getMyAccessContext() {
  const { data, error } = await getBrowserClient().rpc('get_my_access_context');
  if (error) throw error;
  return data;
}
export async function listEmployees() {
  const { data, error } = await getBrowserClient().rpc('list_employees');
  if (error) throw error;
  return data ?? [];
}
export async function listActiveBranches() {
  const { data, error } = await getBrowserClient().rpc('list_active_branches');
  if (error) throw error;
  return data ?? [];
}
export async function deleteBranch(branchId) {
  const { data, error } = await getBrowserClient().rpc('delete_branch', {
    p_branch_id: branchId,
  });
  if (error) throw error;
  return data;
}
export async function setEmployeeActive(employeeId, isActive) {
  const { error } = await getBrowserClient().rpc('set_employee_active', {
    p_employee_id: employeeId, p_is_active: isActive,
  });
  if (error) throw error;
}
export async function deleteEmployee(employeeId) {
  const { data, error } = await getBrowserClient().rpc('delete_employee', {
    p_employee_id: employeeId,
  });
  if (error) throw error;
  return data;
}
export async function createEmployee({ fullName, email, phone, role, branchId, password }) {
  const normName = (fullName || '').trim();
  if (normName.length < 2) throw new Error('To‘liq ism kamida 2 ta belgi bo‘lishi kerak.');
  if (!password || password.length < 4) throw new Error('Parol kamida 4 ta belgi bo‘lishi kerak.');
  if (!branchId) throw new Error('Filial tanlanishi shart.');

  let normEmail = (email || '').trim().toLowerCase();
  if (!normEmail) {
    normEmail = `emp_${Math.random().toString(36).slice(2, 9)}@texnobazar.uz`;
  }

  const client = getBrowserClient();
  const tempClient = createClient(client.supabaseUrl, client.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: signUpData, error: signUpErr } = await tempClient.auth.signUp({
    email: normEmail,
    password,
    options: {
      data: {
        full_name: normName,
        phone: (phone || '').trim() || null,
      },
    },
  });

  if (signUpErr) {
    const msg = (signUpErr.message || '').toLowerCase();
    if (msg.includes('already registered') || msg.includes('already exists') || msg.includes('unique')) {
      throw new Error(`"${normEmail}" email bilan foydalanuvchi allaqachon mavjud.`);
    }
    throw signUpErr;
  }

  const newUserId = signUpData?.user?.id;
  if (!newUserId) throw new Error('Xodim yaratilmadi.');

  const { data: assignData, error: assignErr } = await client.rpc('assign_employee_role', {
    p_user_id: newUserId,
    p_role: role || 'seller',
    p_branch_id: branchId,
    p_full_name: normName,
    p_phone: (phone || '').trim() || null,
  });

  if (assignErr) throw assignErr;

  return {
    employee_id: newUserId,
    email: normEmail,
    full_name: normName,
    role,
    branch_id: branchId,
  };
}
export async function requestPasswordReset(email) {
  const { error } = await getBrowserClient().auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}
export async function changeOwnPassword(password) {
  if (typeof password !== 'string' || password.length < 4) {
    throw new Error('Yangi parol kamida 4 belgi bo‘lsin.');
  }
  const client = getBrowserClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw userError ?? new Error('Sessiya topilmadi.');
  const { error } = await client.auth.updateUser({
    password,
    data: { ...userData.user.user_metadata, must_change_password: false },
  });
  if (error) throw error;
}
export async function getAccessToken() {
  const { data, error } = await getBrowserClient().auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}

// Avatars live in Cloudflare R2 (Supabase Storage is disabled); the superadmin
// deployment owns the authenticated upload endpoint.
export async function uploadProfileAvatar(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  if (!file || !allowed.includes(file.type)) throw new Error('Faqat JPG, PNG, WebP yoki AVIF rasm yuklanadi.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Rasm 5MB dan kichik bo‘lishi kerak.');
  const token = await getAccessToken();
  if (!token) throw new Error('Sessiya topilmadi. Tizimga qayta kiring.');
  const base = (import.meta.env?.VITE_API_BASE || '').replace(/\/$/, '');
  const response = await fetch(`${base}/.netlify/functions/avatar-upload`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, Authorization: `Bearer ${token}` },
    body: file,
  });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!response.ok) throw new Error(result.error || `Profil rasmini yuklab bo‘lmadi (${response.status}).`);
  return result;
}
