import { ApiError, requireEmployeeCreationPermission } from './auth.js';

const EMPLOYEE_ROLES = new Set(['manager', 'seller', 'warehouse', 'accountant', 'courier']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{6,19}$/;

function ownKeysOnly(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'JSON obyekt talab qilinadi.', 'INVALID_BODY');
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ApiError(400, `Noma’lum maydon: ${unknown[0]}.`, 'UNKNOWN_FIELD');
  }
}

function requiredText(value, name, min, max) {
  if (typeof value !== 'string') {
    throw new ApiError(400, `${name} matn bo‘lishi kerak.`, 'INVALID_INPUT');
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(400, `${name} ${min}-${max} belgi oralig‘ida bo‘lishi kerak.`, 'INVALID_INPUT');
  }
  return normalized;
}

export function validateEmployeeInput(input) {
  ownKeysOnly(input, new Set(['email', 'password', 'fullName', 'full_name', 'phone', 'role', 'branchId', 'branch_id']));
  if (input.fullName !== undefined && input.full_name !== undefined) {
    throw new ApiError(400, 'fullName yoki full_name dan faqat bittasini yuboring.', 'INVALID_INPUT');
  }
  if (input.branchId !== undefined && input.branch_id !== undefined) {
    throw new ApiError(400, 'branchId yoki branch_id dan faqat bittasini yuboring.', 'INVALID_INPUT');
  }

  const email = requiredText(input.email, 'Email', 3, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, 'Email formati noto‘g‘ri.', 'INVALID_EMAIL');
  const password = requiredText(input.password, 'Parol', 10, 128);
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ApiError(400, 'Parol kamida bitta katta harf, kichik harf va raqamdan iborat bo‘lishi kerak.', 'INVALID_PASSWORD');
  }
  const fullName = requiredText(input.fullName ?? input.full_name, 'F.I.Sh.', 3, 160);
  if (!/^[\p{L}][\p{L}\p{M} .ʼ’'`-]{1,158}[\p{L}.]$/u.test(fullName)) {
    throw new ApiError(400, 'F.I.Sh. faqat harflar, bo‘sh joy, nuqta, apostrof yoki tire ishlatishi mumkin.', 'INVALID_NAME');
  }
  const role = requiredText(input.role, 'Rol', 2, 32).toLowerCase();
  if (!EMPLOYEE_ROLES.has(role)) {
    throw new ApiError(400, 'Xodim roli manager, seller, warehouse, accountant yoki courier bo‘lishi kerak.', 'INVALID_ROLE');
  }
  const branchId = requiredText(input.branchId ?? input.branch_id, 'Filial ID', 36, 36);
  if (!UUID_PATTERN.test(branchId)) throw new ApiError(400, 'Filial ID formati noto‘g‘ri.', 'INVALID_BRANCH');

  let phone = null;
  if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
    phone = requiredText(input.phone, 'Telefon', 7, 20);
    if (!PHONE_PATTERN.test(phone)) throw new ApiError(400, 'Telefon formati noto‘g‘ri.', 'INVALID_PHONE');
  }
  return { email, password, fullName, phone, role, branchId };
}

function authCreationError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('already') || message.includes('registered') || message.includes('exists')) {
    return new ApiError(409, 'Bu email bilan foydalanuvchi mavjud.', 'EMAIL_EXISTS');
  }
  if (message.includes('password')) {
    return new ApiError(400, 'Parol xavfsizlik talablariga mos emas.', 'INVALID_PASSWORD');
  }
  return error;
}

export async function createEmployee({ admin, actorId, input }) {
  const employee = validateEmployeeInput(input);
  await requireEmployeeCreationPermission(admin, actorId);

  const { data: branch, error: branchError } = await admin
    .from('branches').select('id,is_active').eq('id', employee.branchId).maybeSingle();
  if (branchError) throw branchError;
  if (!branch?.is_active) throw new ApiError(400, 'Faol filial tanlanishi kerak.', 'INVALID_BRANCH');

  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email: employee.email,
    password: employee.password,
    email_confirm: true,
    user_metadata: { full_name: employee.fullName, phone: employee.phone, must_change_password: true },
  });
  if (authError || !authData.user) throw authCreationError(authError);

  const userId = authData.user.id;
  try {
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .upsert({ id: userId, email: employee.email, full_name: employee.fullName, phone: employee.phone, is_active: true })
      .select('id,email,full_name,phone,is_active,created_at')
      .single();
    if (profileError) throw profileError;

    const { data: assignment, error: roleError } = await admin
      .from('profile_roles')
      .insert({ profile_id: userId, role: employee.role, branch_id: employee.branchId, created_by: actorId })
      .select('role,branch_id,created_at')
      .single();
    if (roleError) throw roleError;

    return {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone,
      isActive: profile.is_active,
      role: assignment.role,
      branchId: assignment.branch_id,
      createdAt: profile.created_at,
    };
  } catch (error) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(userId);
    if (cleanupError) console.error('Xodim yaratish kompensatsiyasi bajarilmadi.');
    throw error;
  }
}
