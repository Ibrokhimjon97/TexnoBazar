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
export async function setEmployeeActive(employeeId, isActive) {
  const { error } = await getBrowserClient().rpc('set_employee_active', {
    p_employee_id: employeeId, p_is_active: isActive,
  });
  if (error) throw error;
}
export async function requestPasswordReset(email) {
  const { error } = await getBrowserClient().auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw error;
}
export async function changeOwnPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('Yangi parol kamida 10 belgi, katta-kichik harf va raqamdan iborat bo‘lsin.');
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
