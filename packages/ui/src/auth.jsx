import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, LogOut, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { changeOwnPassword, getBrowserClient, getMyAccessContext, requestPasswordReset, signInWithPassword, signOut } from '@texnobazar/data';

const AuthContext = createContext(null);
const labels = { superadmin: 'Superadmin', admin: 'Administrator', manager: 'Menejer', seller: 'Sotuvchi', courier: 'Kuryer', warehouse: 'Omborchi', accountant: 'Hisobchi' };
const CONTEXT_STORAGE_KEY = 'tb_user_access_context';

export function confirmLogout(logout) {
  if (window.confirm('Hisobdan chiqishni tasdiqlaysizmi?')) logout();
}

export function isNetworkError(error) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!error) return false;
  const msg = String(error.message || error.error_description || error || '').toLowerCase();
  const name = String(error.name || '').toLowerCase();
  if (name === 'aborterror') return true;
  return (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('abort') ||
    msg.includes('timeout') ||
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('net::') ||
    msg.includes('offline') ||
    msg.includes('connection')
  );
}

function getCachedContext(userId) {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(CONTEXT_STORAGE_KEY) : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!userId || parsed?.profile?.id === userId) return parsed;
    return null;
  } catch {
    return null;
  }
}

function setCachedContext(context) {
  try {
    if (typeof window === 'undefined') return;
    if (context) localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(context));
    else localStorage.removeItem(CONTEXT_STORAGE_KEY);
  } catch {}
}

function friendlyError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('invalid login')) return 'Email yoki parol noto‘g‘ri.';
  if (message.includes('inactive') || message.includes('faol profil')) return 'Profilingiz faol emas. Administratorga murojaat qiling.';
  if (isNetworkError(error)) return 'Tarmoq bilan aloqa yo‘q. Internetni tekshiring.';
  if (message.includes('sozlamalari')) return error.message;
  return 'Kirishda xatolik yuz berdi. Qayta urinib ko‘ring.';
}

export function AuthProvider({ children }) {
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState(() => {
    let cached = null;
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(CONTEXT_STORAGE_KEY) : null;
      if (raw) cached = JSON.parse(raw);
    } catch {}
    return {
      loading: true,
      session: null,
      context: cached,
      error: null,
      isOffline: false,
    };
  });

  const load = useCallback(async (session, isSilent = false) => {
    if (!session) {
      setCachedContext(null);
      return setState({ loading: false, session: null, context: null, error: null, isOffline: false });
    }

    const userId = session.user?.id;
    const cached = getCachedContext(userId);

    // If we already have a usable context in state or cache, don't block user with loading spinner
    setState(prev => ({
      ...prev,
      session,
      context: prev.context || cached,
      loading: (prev.context || cached) ? false : (isSilent ? false : true),
    }));

    try {
      const context = await getMyAccessContext();
      setCachedContext(context);
      setState({ loading: false, session, context, error: null, isOffline: false });
    } catch (error) {
      if (isNetworkError(error)) {
        // Network connection dropped (e.g. phone screen locked, asleep, or mobile radio renegotiating).
        // CRITICAL: NEVER wipe out active context on temporary network drops!
        setState(prev => {
          const fallbackContext = prev.context || cached;
          return {
            loading: false,
            session,
            context: fallbackContext,
            error: fallbackContext ? null : friendlyError(error),
            isOffline: true,
          };
        });
      } else {
        // Genuine authentication/authorization error from backend
        setCachedContext(null);
        setState({ loading: false, session, context: null, error: friendlyError(error), isOffline: false });
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let subscription;

    try {
      const client = getBrowserClient();
      client.auth.getSession().then(({ data, error }) => {
        if (!alive) return;
        if (error) {
          if (isNetworkError(error)) {
            setState(prev => ({ ...prev, loading: false, isOffline: true }));
          } else {
            setState({ loading: false, session: null, context: null, error: friendlyError(error), isOffline: false });
          }
        } else {
          load(data.session, false);
        }
      }).catch(err => {
        if (!alive) return;
        if (isNetworkError(err)) {
          setState(prev => ({ ...prev, loading: false, isOffline: true }));
        } else {
          setState({ loading: false, session: null, context: null, error: friendlyError(err), isOffline: false });
        }
      });

      subscription = client.auth.onAuthStateChange((event, session) => {
        if (!alive) return;
        if (event === 'SIGNED_OUT') {
          setCachedContext(null);
          setState({ loading: false, session: null, context: null, error: null, isOffline: false });
          return;
        }
        // Quiet background revalidation on TOKEN_REFRESHED, USER_UPDATED, etc.
        setTimeout(() => {
          if (alive) load(session, true);
        }, 0);
      }).data.subscription;
    } catch (error) {
      if (isNetworkError(error)) {
        setState(prev => ({ ...prev, loading: false, isOffline: true }));
      } else {
        setState({ loading: false, session: null, context: null, error: friendlyError(error), isOffline: false });
      }
    }

    const recheck = () => {
      try {
        const client = getBrowserClient();
        client.auth.getSession().then(({ data }) => {
          if (alive && data?.session) load(data.session, true);
        }).catch(() => {});
      } catch {}
    };

    const handleOnline = () => {
      setState(prev => ({ ...prev, isOffline: false }));
      recheck();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Mobile screen unlocked: wait 350ms for mobile radio to stabilize before checking
        setTimeout(recheck, 350);
      }
    };

    const handleFocus = () => {
      recheck();
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      alive = false;
      subscription?.unsubscribe();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [load, retryKey]);

  const logout = useCallback(async () => {
    setCachedContext(null);
    try {
      await signOut();
    } finally {
      setState({ loading: false, session: null, context: null, error: null, isOffline: false });
    }
  }, []);

  const refresh = useCallback(() => {
    setState(current => ({ ...current, loading: !current.context }));
    setRetryKey(key => key + 1);
  }, []);

  const value = useMemo(() => ({ ...state, refresh, logout }), [state, refresh, logout]);
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
  if (auth.loading && !auth.context) return <div className="auth-loading"><span className="auth-spinner"/><b>Texnobazar yuklanmoqda…</b></div>;
  if (!auth.session && !auth.context) return <LoginPage panelLabel={panelLabel} initialError={auth.error}/>;
  
  // Offline and no context on initial cold start
  if (!auth.context && auth.isOffline) {
    return (
      <div className="auth-state">
        <WifiOff size={48} style={{ color: 'var(--orange, #ea580c)', margin: 'auto' }} />
        <h1>Internet bilan aloqa yo‘q</h1>
        <p>Tarmoq bilan aloqa vaqtincha uzildi. Internet ulanganda sahifa avtomatik davom etadi.</p>
        <button className="btn btn-primary" onClick={auth.refresh}>
          <RefreshCw size={16} /> Qayta urinish
        </button>
        <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => confirmLogout(auth.logout)}>
          <LogOut size={16} /> Tizimdan chiqish
        </button>
      </div>
    );
  }

  if (!auth.context) return <div className="auth-state"><ShieldCheck size={48} style={{ color: 'var(--orange, #ea580c)', margin: 'auto' }}/><h1>Kirish cheklangan</h1><p>{auth.error || 'Faol profil va rol topilmadi.'}</p><button className="btn btn-primary" onClick={() => confirmLogout(auth.logout)}><LogOut size={16} /> Tizimdan chiqish</button></div>;
  if (auth.session?.user?.user_metadata?.must_change_password === true) return <PasswordChangePage/>;
  const allowed = auth.roles.some((item) => expectedRoles.includes(item.role));
  if (!allowed) return <div className="auth-state"><ShieldCheck size={48} style={{ color: 'var(--orange, #ea580c)', margin: 'auto' }}/><h1>Bu panelga ruxsat yo‘q</h1><p>Sizning rolingiz: {auth.roles.map(r => labels[r.role] ?? r.role).join(', ') || 'biriktirilmagan'}.</p><button className="btn btn-primary" onClick={() => confirmLogout(auth.logout)}><LogOut size={16} /> Tizimdan chiqish</button></div>;
  
  return (
    <>
      {auth.isOffline && (
        <div style={{
          position: 'fixed',
          top: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 99999,
          background: 'rgba(234, 88, 12, 0.95)',
          backdropFilter: 'blur(8px)',
          color: '#fff',
          padding: '8px 18px',
          borderRadius: '99px',
          fontSize: '13px',
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          boxShadow: '0 4px 18px rgba(0,0,0,0.22)'
        }}>
          <WifiOff size={16} />
          <span>Internet bilan aloqa vaqtincha uzildi. Qayta ulanmoqda…</span>
          <button
            type="button"
            onClick={auth.refresh}
            style={{
              background: 'rgba(255,255,255,0.25)',
              border: 'none',
              borderRadius: '12px',
              color: '#fff',
              padding: '2px 10px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 700
            }}
          >
            Tekshirish
          </button>
        </div>
      )}
      {children}
    </>
  );
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
