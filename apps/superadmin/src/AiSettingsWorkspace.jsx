import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, Bot, CheckCircle2, KeyRound, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Zap,
} from 'lucide-react';
import { Empty, Modal, Status } from '@texnobazar/ui';
import {
  deleteAiProvider, fetchAiProviderModels, listAiActionLog, listAiProviders, saveAiProvider, testAiProvider,
} from '@texnobazar/data';

// Model lists are fetched live from each provider, so nothing here hardcodes model
// names — providers retire them often and availability differs per account.
const PROVIDERS = [
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'groq', label: 'Groq' },
  { value: 'kimi', label: 'Kimi (Moonshot)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'custom', label: 'Boshqa (OpenAI-mos API)' },
];

const providerLabel = value => PROVIDERS.find(p => p.value === value)?.label || value;
const emptyForm = { id: '', provider: 'openai', label: '', api_key: '', base_url: '', models: [], default_model: '', is_active: true, sort_order: 0 };

export default function AiSettingsWorkspace({ toast }) {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [log, setLog] = useState([]);

  const load = async () => {
    setLoading(true); setError('');
    try {
      setProviders(await listAiProviders());
      setLog(await listAiActionLog({ limit: 30, writesOnly: true }).catch(() => []));
    } catch (e) {
      setError(e?.message || 'AI sozlamalari yuklanmadi.');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async provider => {
    if (!confirm(`"${provider.label}" provayderini o'chirasizmi?`)) return;
    try {
      await deleteAiProvider(provider.id);
      toast?.('Provayder o\'chirildi');
      await load();
    } catch (e) { setError(e?.message || 'O\'chirilmadi'); }
  };

  const test = async provider => {
    setTesting(provider.id); setTestResult(null);
    try {
      setTestResult({ id: provider.id, ...(await testAiProvider(provider.id)) });
    } catch (e) {
      setTestResult({ id: provider.id, ok: false, error: e?.message || 'Test bajarilmadi' });
    } finally { setTesting(null); }
  };

  return (
    <>
      <div className="page-head between">
        <div>
          <h2>AI sozlamalari</h2>
          <p>Sun'iy intellekt provayderlari va API kalitlari. Kalitlar faqat serverda saqlanadi va brauzerga qaytarilmaydi.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ ...emptyForm })}><Plus /> Provayder qo'shish</button>
      </div>

      <div className="ai-security-note card">
        <ShieldCheck size={22} />
        <div>
          <b>Xavfsizlik</b>
          <span>
            API kalitlar <code>ai_providers</code> jadvalida saqlanadi va <code>authenticated</code> rolidan
            SELECT huquqi olib tashlangan. Kalitni faqat server tomonidagi AI endpoint o'qiydi.
            AI ma'lumot o'qiganda sizning huquqlaringiz bilan ishlaydi — o'zingiz ko'rmaydigan narsani ko'rsatmaydi.
          </span>
        </div>
      </div>

      {loading ? <div className="employee-loading">Yuklanmoqda…</div>
        : error ? <div className="empty"><AlertTriangle /><h3>Xatolik</h3><p>{error}</p><button className="btn" onClick={load}>Qayta urinish</button></div>
        : providers.length === 0 ? <Empty title="Provayder qo'shilmagan" text="AI yordamchisidan foydalanish uchun kamida bitta provayder va API kalit kiriting." />
        : <div className="ai-provider-list">
          {providers.map(provider => (
            <article className="ai-provider-card card" key={provider.id}>
              <div className="ai-provider-head">
                <span className="ai-provider-icon"><Bot size={20} /></span>
                <div>
                  <b>{provider.label}</b>
                  <small>{providerLabel(provider.provider)}</small>
                </div>
                <Status type={provider.is_active ? 'green' : 'gray'}>{provider.is_active ? 'Faol' : 'O\'chirilgan'}</Status>
              </div>

              <div className="ai-provider-meta">
                <span>
                  <KeyRound size={13} />
                  {provider.has_api_key ? `Kalit saqlangan ${provider.api_key_hint || ''}` : 'Kalit yo\'q'}
                </span>
                {provider.base_url && <span>Base URL: <code>{provider.base_url}</code></span>}
                <span>Standart model: <b>{provider.default_model || '—'}</b></span>
              </div>

              {Array.isArray(provider.models) && provider.models.length > 0 && (
                <div className="ai-provider-models">
                  {provider.models.map(model => <span key={model}>{model}</span>)}
                </div>
              )}

              {testResult?.id === provider.id && (
                <div className={`ai-test-result ${testResult.ok ? 'ok' : 'bad'}`}>
                  {testResult.ok
                    ? <><CheckCircle2 size={15} /> Ulanish ishlayapti · {testResult.model} · {testResult.latency_ms} ms{testResult.reply ? ` · "${testResult.reply}"` : ''}</>
                    : <><AlertTriangle size={15} /> {testResult.error}</>}
                </div>
              )}

              <div className="ai-provider-actions">
                <button className="btn btn-outline" disabled={testing === provider.id || !provider.has_api_key} onClick={() => test(provider)}>
                  <Zap size={14} /> {testing === provider.id ? 'Sinalmoqda…' : 'Ulanishni sinash'}
                </button>
                <button className="btn btn-outline" onClick={() => setModal({
                  ...emptyForm,
                  id: provider.id,
                  provider: provider.provider,
                  label: provider.label,
                  base_url: provider.base_url || '',
                  models: provider.models || [],
                  default_model: provider.default_model || '',
                  is_active: provider.is_active,
                  sort_order: provider.sort_order ?? 0,
                  has_api_key: provider.has_api_key,
                })}><Pencil size={14} /> Tahrirlash</button>
                <button className="icon-btn danger-icon" title="O'chirish" onClick={() => remove(provider)}><Trash2 size={15} /></button>
              </div>
            </article>
          ))}
        </div>}

      {log.length > 0 && (
        <div className="card data-card ai-audit">
          <div className="toolbar"><b>AI bajargan o'zgartirishlar</b></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Vaqt</th><th>Amal</th><th>Parametrlar</th><th>Holat</th></tr></thead>
              <tbody>
                {log.map(row => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString('uz-UZ')}</td>
                    <td><code>{row.tool_name}</code></td>
                    <td><code className="ai-audit-args">{JSON.stringify(row.arguments)}</code></td>
                    <td><Status type={row.status === 'ok' ? 'green' : 'red'}>{row.status === 'ok' ? 'Bajarildi' : 'Xato'}</Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && <ProviderModal form={modal} close={() => setModal(null)} saved={async () => { setModal(null); toast?.('Saqlandi'); await load(); }} />}
    </>
  );
}

function ProviderModal({ form: initial, close, saved }) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState(initial.models || []);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  const [filter, setFilter] = useState('');
  const isEdit = Boolean(initial.id);

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  // Pull the real list from the provider. Uses the stored key when editing, or the
  // freshly typed key when the provider does not exist yet.
  const loadModels = async () => {
    setLoadingModels(true); setModelError('');
    try {
      const canUseStoredKey = isEdit && !form.api_key.trim();
      const result = await fetchAiProviderModels(canUseStoredKey
        ? { providerId: form.id }
        : { provider: form.provider, apiKey: form.api_key.trim(), baseUrl: form.base_url.trim() || null });

      if (!result.ok) { setModelError(result.error || 'Model ro\'yxati olinmadi'); return; }
      if (!result.models?.length) { setModelError('Provayder bo\'sh ro\'yxat qaytardi.'); return; }

      setAvailable(result.models);
      // Keep only selections the provider still offers, so retired models drop out.
      setForm(current => {
        const stillValid = (current.models || []).filter(m => result.models.includes(m));
        return {
          ...current,
          models: stillValid,
          default_model: stillValid.includes(current.default_model) ? current.default_model : (stillValid[0] || ''),
        };
      });
    } catch (e) {
      setModelError(e?.message || 'Model ro\'yxati olinmadi');
    } finally { setLoadingModels(false); }
  };

  const toggleModel = model => setForm(current => {
    const selected = current.models || [];
    const next = selected.includes(model) ? selected.filter(m => m !== model) : [...selected, model];
    return {
      ...current,
      models: next,
      default_model: next.includes(current.default_model) ? current.default_model : (next[0] || ''),
    };
  });

  const submit = async event => {
    event.preventDefault();
    if (!form.models?.length) { setError('Kamida bitta modelni tanlang.'); return; }
    setBusy(true); setError('');
    try {
      await saveAiProvider({
        ...(isEdit ? { id: form.id } : {}),
        provider: form.provider,
        label: form.label.trim(),
        // Blank on edit means "keep the stored key", which is why we never prefill it.
        ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}),
        base_url: form.base_url.trim() || null,
        models: form.models,
        default_model: form.default_model || form.models[0],
        is_active: form.is_active,
        sort_order: Number(form.sort_order) || 0,
      });
      await saved();
    } catch (e) {
      setError(e?.message || 'Saqlanmadi');
    } finally { setBusy(false); }
  };

  const canLoad = (form.api_key.trim() || (isEdit && initial.has_api_key)) && !loadingModels;
  const shown = filter.trim()
    ? available.filter(m => m.toLowerCase().includes(filter.trim().toLowerCase()))
    : available;

  return (
    <Modal open onClose={close} title={isEdit ? 'Provayderni tahrirlash' : 'Yangi AI provayder'} wide>
      <form className="employee-form-grid" onSubmit={submit}>
        {error && <div className="employee-error wide">{error}</div>}

        <label>
          <span className="label">Provayder turi</span>
          <select className="select" value={form.provider} onChange={e => {
            const next = e.target.value;
            setAvailable([]); setModelError('');
            setForm(current => ({
              ...current,
              provider: next,
              models: [],
              default_model: '',
              label: current.label || PROVIDERS.find(p => p.value === next)?.label || '',
            }));
          }}>
            {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>

        <label>
          <span className="label">Nomi (ichki)</span>
          <input className="input" value={form.label} onChange={e => set('label', e.target.value)} required minLength="2" placeholder="Masalan: Asosiy GPT" />
        </label>

        <label className="wide">
          <span className="label">API kalit {isEdit && <small>(bo'sh qoldirsangiz eski kalit saqlanadi)</small>}</span>
          <input className="input" type="password" autoComplete="new-password" value={form.api_key}
            onChange={e => set('api_key', e.target.value)} required={!isEdit && !initial.has_api_key}
            placeholder={isEdit ? '•••••••• (o\'zgartirmaslik uchun bo\'sh qoldiring)' : 'sk-…'} />
        </label>

        <label className="wide">
          <span className="label">Base URL {form.provider === 'custom' ? '' : '(ixtiyoriy — standart ishlatiladi)'}</span>
          <input className="input" type="url" value={form.base_url} onChange={e => set('base_url', e.target.value)}
            required={form.provider === 'custom'} placeholder="https://api.example.com/v1" />
        </label>

        <div className="wide ai-model-picker">
          <div className="ai-model-picker-head">
            <div>
              <span className="label">Ruxsat etilgan modellar</span>
              <small className="ai-hint">
                Ro'yxat provayderning o'zidan olinadi — faqat sizning kalitingiz ishlatishi mumkin bo'lgan modellar ko'rinadi.
              </small>
            </div>
            <button type="button" className="btn btn-outline" disabled={!canLoad} onClick={loadModels}>
              <RefreshCw size={14} className={loadingModels ? 'spin' : undefined} />
              {loadingModels ? 'Yuklanmoqda…' : 'Modellarni yuklash'}
            </button>
          </div>

          {modelError && <div className="ai-model-error"><AlertTriangle size={14} /> {modelError}</div>}

          {available.length === 0 && !modelError && (
            <p className="ai-model-empty">
              {form.api_key.trim() || initial.has_api_key
                ? 'Modellarni ko\'rish uchun "Modellarni yuklash" tugmasini bosing.'
                : 'Avval API kalitni kiriting, keyin modellarni yuklang.'}
            </p>
          )}

          {available.length > 0 && (
            <>
              <div className="ai-model-toolbar">
                <input className="input" value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder={`Qidirish… (${available.length} model)`} />
                <span>{form.models.length} tanlangan</span>
              </div>
              <div className="ai-model-list">
                {shown.map(model => (
                  <label key={model} className={form.models.includes(model) ? 'selected' : ''}>
                    <input type="checkbox" checked={form.models.includes(model)} onChange={() => toggleModel(model)} />
                    <span>{model}</span>
                  </label>
                ))}
                {shown.length === 0 && <p className="ai-model-empty">Qidiruvga mos model yo'q.</p>}
              </div>
            </>
          )}
        </div>

        <label>
          <span className="label">Standart model</span>
          <select className="select" value={form.default_model} onChange={e => set('default_model', e.target.value)} disabled={!form.models.length}>
            {form.models.length === 0 && <option value="">Avval model tanlang</option>}
            {form.models.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>

        <label>
          <span className="label">Tartib raqami</span>
          <input className="input" type="number" value={form.sort_order} onChange={e => set('sort_order', e.target.value)} />
        </label>

        <label className="cms-check wide">
          <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} />
          <span>Faol (chatda tanlash mumkin)</span>
        </label>

        <button className="btn btn-primary wide" disabled={busy || !form.models.length}>
          {busy ? 'Saqlanmoqda…' : 'Saqlash'}
        </button>
      </form>
    </Modal>
  );
}
