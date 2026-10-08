import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, LogOut, ShieldCheck } from 'lucide-react';
import { changeOwnPassword, getBrowserClient, getMyAccessContext, requestPasswordReset, signInWithPassword, signOut } from '@texnobazar/data';

const AuthContext = createContext(null);
const labels = { superadmin: 'Superadmin', admin: 'Administrator', manager: 'Menejer', seller: 'Sotuvchi', courier: 'Kuryer', warehouse: 'Omborchi', accountant: 'Hisobchi' };
export function confirmLogout(logout) {
  if (window.confirm('Hisobdan chiqishni tasdiqlaysizmi?')) logout();
}
function friendlyError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('invalid login')) return 'Email yoki parol noto‘g‘ri.';
  if (message.includes('inactive') || message.includes('faol profil')) return 'Profilingiz faol emas. Administratorga murojaat qiling.';
  if (message.includes('fetch') || message.includes('network')) return 'Tarmoq bilan aloqa yo‘q. Internetni tekshiring.';
  if (message.includes('sozlamalari')) return error.message;
  return 'Kirishda xatolik yuz berdi. Qayta urinib ko‘ring.';
}

export function AuthProvider({ children }) {
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState({ loading: true, session: null, context: null, error: null });
  const load = useCallback(async (session) => {
    if (!session) return setState({ loading: false, session: null, context: null, error: null });
    try {
      const context = await getMyAccessContext();
      setState({ loading: false, session, context, error: null });
    } catch (error) {
      setState({ loading: false, session, context: null, error: friendlyError(error) });
    }
  }, []);
  useEffect(() => {
    let alive = true;
    let subscription;
    try {
      const client = getBrowserClient();
      client.auth.getSession().then(({ data, error }) => {
        if (!alive) return;
        if (error) setState({ loading: false, session: null, context: null, error: friendlyError(error) });
        else load(data.session);
      });
      subscription = client.auth.onAuthStateChange((_event, session) => { if (alive) setTimeout(() => load(session), 0); }).data.subscription;
    } catch (error) { setState({ loading: false, session: null, context: null, error: friendlyError(error) }); }
    return () => { alive = false; subscription?.unsubscribe(); };
  }, [load, retryKey]);
  const value = useMemo(() => ({ ...state, refresh: () => { setState(current => ({ ...current, loading: true })); setRetryKey(key => key + 1); }, logout: signOut }), [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth AuthProvider ichida ishlatilishi kerak.');
  const profile = value.context?.profile;
  const roles = value.context?.roles ?? [];
  const primaryRole = roles[0];
  return { ...value, profile, roles, primaryRole, branch: primaryRole?.branch_id ? { id: primaryRole.branch_id, name: primaryRole.branch_name, code: primaryRole.branch_code } : null };
}

export function ProtectedApp({ expectedRoles, panelLabel, children }) {
  const auth = useAuth();
  if (auth.loading) return <div className="auth-loading"><span className="auth-spinner"/><b>Texnobazar yuklanmoqda…</b></div>;
  if (!auth.session) return <LoginPage panelLabel={panelLabel} initialError={auth.error}/>;
  if (!auth.context) return <div className="auth-state"><ShieldCheck/><h1>Kirish cheklangan</h1><p>{auth.error || 'Faol profil va rol topilmadi.'}</p><button className="btn btn-primary" onClick={() => confirmLogout(auth.logout)}><LogOut/> Tizimdan chiqish</button></div>;
  if (auth.session.user?.user_metadata?.must_change_password === true) return <PasswordChangePage/>;
  const allowed = auth.roles.some((item) => expectedRoles.includes(item.role));
  if (!allowed) return <div className="auth-state"><ShieldCheck/><h1>Bu panelga ruxsat yo‘q</h1><p>Sizning rolingiz: {auth.roles.map(r => labels[r.role] ?? r.role).join(', ') || 'biriktirilmagan'}.</p><button className="btn btn-primary" onClick={() => confirmLogout(auth.logout)}><LogOut/> Tizimdan chiqish</button></div>;
  return children;
}

function PasswordChangePage() {
  const { refresh, logout } = useAuth();
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const submit = async (event) => {
    event.preventDefault(); setMessage('');
    if (password !== confirm) return setMessage('Parollar bir xil emas.');
    setBusy(true);
    try { await changeOwnPassword(password); refresh(); }
    catch (error) { setMessage(error?.message || 'Parol almashtirilmadi.'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page"><section className="auth-brand"><div className="auth-mark">T</div><p>XAVFSIZLIK TALABI</p><h1>Hisobingizni yangi shaxsiy parol bilan himoyalang.</h1></section><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><div className="auth-logo"><b>texnobazar</b><span>Birinchi kirish</span></div><h2>Parolni almashtiring</h2><p>Vaqtinchalik parol bilan davom etib bo‘lmaydi.</p>{message&&<div className="auth-message">{message}</div>}<label><span>Yangi parol</span><div className="auth-password"><input className="input" type={show?'text':'password'} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} required minLength="10"/><button type="button" aria-label={show?'Parolni yashirish':'Parolni ko‘rsatish'} onClick={()=>setShow(!show)}>{show?<EyeOff/>:<Eye/>}</button></div></label><label><span>Yangi parolni takrorlang</span><input className="input" type={show?'text':'password'} autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required minLength="10"/></label><ul className="auth-password-requirements"><li>Kamida 10 ta belgi</li><li>Katta va kichik lotin harfi</li><li>Kamida bitta raqam</li></ul><button className="btn btn-primary btn-block" disabled={busy}>{busy?'Saqlanmoqda…':'Yangi parolni saqlash'}</button><button className="auth-link" type="button" onClick={() => confirmLogout(logout)}>Tizimdan chiqish</button></form></section></main>;
}

function LoginPage({ panelLabel, initialError }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(initialError ?? ''), [reset, setReset] = useState(false);
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      if (reset) { await requestPasswordReset(email); setMessage('Tiklash havolasi emailingizga yuborildi.'); }
      else await signInWithPassword(email, password);
    } catch (error) { setMessage(friendlyError(error)); } finally { setBusy(false); }
  };
  return <main className="auth-page"><section className="auth-brand"><div className="auth-mark">T</div><p>TEXNOBAZAR BOSHQARUV TIZIMI</p><h1>Biznesingizni yagona xavfsiz platformada boshqaring.</h1><div className="auth-panels"><span>Superadmin</span><span>Menejer</span><span>Sotuvchi</span><span>Kuryer</span></div></section><section className="auth-form-wrap"><form className="auth-form" onSubmit={submit}><div className="auth-logo"><b>texnobazar</b><span>{panelLabel} paneli</span></div><h2>{reset ? 'Parolni tiklash' : 'Tizimga kirish'}</h2><p>{reset ? 'Tiklash havolasini olish uchun emailingizni kiriting.' : 'Ish profilingiz orqali davom eting.'}</p>{message&&<div className={message.includes('yuborildi')?'auth-message success':'auth-message'}>{message}</div>}<label><span>Email manzil</span><input className="input" type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required placeholder="name@texnobazar.uz"/></label>{!reset&&<label><span>Parol</span><div className="auth-password"><input className="input" type={show?'text':'password'} autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/><button type="button" aria-label={show?'Parolni yashirish':'Parolni ko‘rsatish'} onClick={()=>setShow(!show)}>{show?<EyeOff/>:<Eye/>}</button></div></label>}<button className="btn btn-primary btn-block" disabled={busy}>{busy?'Kutilmoqda…':reset?'Havolani yuborish':'Kirish'}</button><button className="auth-link" type="button" onClick={()=>{setReset(!reset);setMessage('')}}>{reset?'Kirishga qaytish':'Parolni unutdingizmi?'}</button><small>Muammo bo‘lsa tizim administratoriga murojaat qiling.</small></form></section></main>;
}

export function AccountMenu({ compact = false }) {
  const { profile, primaryRole, branch, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const initials = (profile?.full_name || profile?.email || 'TX').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();
  return <div className="auth-account"><button className="auth-account-trigger" aria-expanded={open} onClick={()=>setOpen(!open)}>{profile?.avatar_url?<img className="avatar avatar-img" src={profile.avatar_url} alt=""/>:<div className="avatar">{initials}</div>}{!compact&&<span><b>{profile?.full_name || profile?.email}</b><small>{labels[primaryRole?.role] || primaryRole?.role}{branch?.name?` · ${branch.name}`:''}</small></span>}</button>{open&&<div className="auth-account-menu"><b>{profile?.full_name || profile?.email}</b><span>{profile?.email}</span><button onClick={() => confirmLogout(logout)}><LogOut/> Tizimdan chiqish</button></div>}</div>;
}
