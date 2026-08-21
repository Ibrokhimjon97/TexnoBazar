import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, Database, Loader, Pencil, Plus, Send, Sparkles, Trash2, User,
} from 'lucide-react';
import {
  deleteAiConversation, listAiConversations, listAiMessages, listAiModels, sendAiMessage,
} from '@texnobazar/data';

// Lightweight markdown renderer: supports headers, bold, italic, tables, lists,
// inline code, code blocks, horizontal rules and line breaks. No external deps.
function AiMarkdown({ text }) {
  if (!text) return null;
  const html = renderMarkdown(text);
  return <div className="ai-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderMarkdown(src) {
  const lines = String(src).split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let inTable = false;
  let tableBuf = [];

  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map(row => row.split('|').map(cell => cell.trim()).filter((_, i, arr) => i > 0 && i < arr.length));
    const hasHeader = tableBuf.length > 1 && /^[\s|:-]+$/.test(tableBuf[1]);
    let html = '<table class="ai-md-table"><thead><tr>';
    const headerRow = rows[0] || [];
    headerRow.forEach(cell => { html += `<th>${inline(cell)}</th>`; });
    html += '</tr></thead><tbody>';
    const startIdx = hasHeader ? 2 : 1;
    for (let i = startIdx; i < rows.length; i++) {
      html += '<tr>';
      (rows[i] || []).forEach(cell => { html += `<td>${inline(cell)}</td>`; });
      html += '</tr>';
    }
    html += '</tbody></table>';
    out.push(html);
    tableBuf = [];
    inTable = false;
  };

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        out.push(`<pre class="ai-md-code"><code>${escHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        if (inTable) flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // Table row detection
    if (line.includes('|') && line.trim().startsWith('|')) {
      if (!inTable) inTable = true;
      tableBuf.push(line);
      continue;
    } else if (inTable) { flushTable(); }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { out.push('<hr class="ai-md-hr"/>'); continue; }

    // Headers
    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level + 1} class="ai-md-h">${inline(hMatch[2])}</h${level + 1}>`);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      out.push(`<div class="ai-md-li">${inline(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      out.push(`<div class="ai-md-li ai-md-ol">${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</div>`);
      continue;
    }

    // Empty line
    if (!line.trim()) { out.push('<br/>'); continue; }

    // Paragraph
    out.push(`<p class="ai-md-p">${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre class="ai-md-code"><code>${escHtml(codeBuf.join('\n'))}</code></pre>`);
  if (inTable) flushTable();
  return out.join('');
}

function inline(text) {
  let s = escHtml(text);
  // Bold + italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code class="ai-md-inline-code">$1</code>');
  // Numbers that look like money amounts: highlight them
  s = s.replace(/(\d[\d\s]*(?:\.\d+)?)\s*(so['`\u2018\u2019]m|USD|UZS|usd|uzs)/g, '<span class="ai-md-money">$1 $2</span>');
  return s;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOOL_LABELS = {
  list_branches: 'Filiallar ro\'yxati',
  search_employees: 'Xodim qidirish',
  search_products: 'Mahsulot qidirish',
  inventory_valuation: 'Qoldiq va qiymati',
  seller_performance: 'Sotuvchilar natijasi',
  product_performance: 'Tovar sotilishi tahlili',
  expense_report: 'Xarajatlar hisoboti',
  employee_salary: 'Xodim maoshi',
  transfer_summary: 'Transfer va qarzlar',
  unit_lifecycle: 'Tovar tarixi (QR)',
  unit_passport: 'Tovar pasporti (QR)',
  profit_loss: 'Foyda va zarar',
  sales_history: 'Sotuvlar tarixi',
  set_product_visibility: 'Saytda ko\'rinishni o\'zgartirish',
  update_product_description: 'Tavsifni yangilash',
};

const SUGGESTIONS = [
  'Asosiy filial omborida qancha tovar bor?',
  'Bu oyda qaysi xodim eng ko\'p savdo qildi?',
  'Bu oygi harajatlarni hisobla',
  'Qaysi tovarlar yaxshi sotilyapti?',
];

export function AiChat({ title = 'AI yordamchi', suggestions = SUGGESTIONS }) {
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState({ providerId: null, model: null });
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await listAiModels();
        setModels(list);
        const first = list[0];
        if (first) {
          setSelected({
            providerId: first.provider_id,
            model: first.default_model || (first.models || [])[0] || null,
          });
        }
        setConversations(await listAiConversations({ limit: 15 }).catch(() => []));
      } catch (e) {
        setError(e?.message || 'AI sozlamalari yuklanmadi.');
      } finally { setReady(true); }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const openConversation = async id => {
    setConversationId(id); setError('');
    try { setMessages(await listAiMessages(id)); }
    catch (e) { setError(e?.message || 'Suhbat yuklanmadi.'); }
  };

  const startNew = () => { setConversationId(null); setMessages([]); setError(''); };

  const removeConversation = async (id, event) => {
    event.stopPropagation();
    if (!confirm('Bu suhbatni o\'chirasizmi?')) return;
    try {
      await deleteAiConversation(id);
      if (id === conversationId) startNew();
      setConversations(await listAiConversations({ limit: 15 }));
    } catch (e) { setError(e?.message || 'O\'chirilmadi'); }
  };

  const submit = async (event, presetText) => {
    event?.preventDefault?.();
    const text = (presetText ?? input).trim();
    if (!text || busy) return;
    if (!selected.providerId) { setError('Avval AI provayderni sozlang (Superadmin → AI sozlamalari).'); return; }

    setInput(''); setError(''); setBusy(true);
    setMessages(current => [...current, { id: `local-${Date.now()}`, role: 'user', content: text }]);

    try {
      const result = await sendAiMessage({
        message: text,
        providerId: selected.providerId,
        model: selected.model,
        conversationId,
      });
      setConversationId(result.conversation_id);
      setMessages(current => [...current, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: result.message,
        tool_calls: result.tools_used?.length ? result.tools_used : null,
      }]);
      setConversations(await listAiConversations({ limit: 15 }).catch(() => conversations));
    } catch (e) {
      setError(e?.message || 'Javob olinmadi.');
      setMessages(current => current.filter(m => m.content !== text || m.role !== 'user'));
      setInput(text);
    } finally { setBusy(false); }
  };

  const activeProvider = models.find(m => m.provider_id === selected.providerId);

  return (
    <div className="ai-chat">
      <aside className="ai-chat-side">
        <button type="button" className="btn btn-primary btn-block" onClick={startNew}>
          <Plus size={15} /> Yangi suhbat
        </button>
        <div className="ai-chat-history">
          {conversations.length === 0
            ? <p className="ai-chat-empty-history">Suhbatlar tarixi bo'sh</p>
            : conversations.map(item => (
              <button type="button" key={item.id}
                className={`ai-chat-history-item${item.id === conversationId ? ' active' : ''}`}
                onClick={() => openConversation(item.id)}>
                <span>{item.title || 'Suhbat'}</span>
                <i onClick={event => removeConversation(item.id, event)} role="button" aria-label="O'chirish"><Trash2 size={13} /></i>
              </button>
            ))}
        </div>
      </aside>

      <section className="ai-chat-main">
        <header className="ai-chat-head">
          <div className="ai-chat-title"><Sparkles size={18} /><b>{title}</b></div>
          {models.length > 0 && (
            <div className="ai-chat-model">
              <select className="select" value={selected.providerId || ''} onChange={e => {
                const provider = models.find(m => m.provider_id === e.target.value);
                setSelected({
                  providerId: e.target.value,
                  model: provider?.default_model || (provider?.models || [])[0] || null,
                });
              }}>
                {models.map(m => <option key={m.provider_id} value={m.provider_id}>{m.label}</option>)}
              </select>
              {(activeProvider?.models || []).length > 0 && (
                <select className="select" value={selected.model || ''} onChange={e => setSelected(s => ({ ...s, model: e.target.value }))}>
                  {activeProvider.models.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              )}
            </div>
          )}
        </header>

        <div className="ai-chat-body" ref={scrollRef}>
          {!ready && <div className="ai-chat-loading"><Loader className="spin" size={18} /> Yuklanmoqda…</div>}

          {ready && models.length === 0 && (
            <div className="ai-chat-setup">
              <Bot size={38} />
              <b>AI provayder sozlanmagan</b>
              <p>Superadmin panelidagi <b>AI sozlamalari</b> bo'limida provayder va API kalit qo'shing.</p>
            </div>
          )}

          {ready && models.length > 0 && messages.length === 0 && (
            <div className="ai-chat-welcome">
              <Bot size={34} />
              <b>Nima bilmoqchisiz?</b>
              <p>Ombor qoldig'i, savdo statistikasi, xodimlar, xarajatlar va tovarlar haqida so'rang.</p>
              <div className="ai-chat-suggestions">
                {suggestions.map(text => (
                  <button type="button" key={text} onClick={event => submit(event, text)}>{text}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map(message => (
            <article key={message.id} className={`ai-msg ai-msg-${message.role}`}>
              <span className="ai-msg-avatar">{message.role === 'user' ? <User size={15} /> : <Bot size={15} />}</span>
              <div className="ai-msg-body">
                {message.tool_calls?.length > 0 && (
                  <div className="ai-msg-tools">
                    {message.tool_calls.map((tool, index) => (
                      <span key={`${tool.name}-${index}`} className={tool.ok === false ? 'bad' : (tool.is_write ? 'write' : '')}>
                        {tool.is_write ? <Pencil size={11} /> : <Database size={11} />}
                        {TOOL_LABELS[tool.name] || tool.name}
                      </span>
                    ))}
                  </div>
                )}
                <div className="ai-msg-text"><AiMarkdown text={message.content} /></div>
              </div>
            </article>
          ))}

          {busy && (
            <article className="ai-msg ai-msg-assistant">
              <span className="ai-msg-avatar"><Bot size={15} /></span>
              <div className="ai-msg-body"><div className="ai-msg-typing"><i /><i /><i /></div></div>
            </article>
          )}
        </div>

        {error && <div className="ai-chat-error"><AlertTriangle size={15} /> {error}</div>}

        <form className="ai-chat-input" onSubmit={submit}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }}
            placeholder={models.length ? 'Savolingizni yozing… (Enter — yuborish, Shift+Enter — yangi qator)' : 'AI provayder sozlanmagan'}
            rows="1"
            disabled={busy || models.length === 0}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim() || models.length === 0}>
            <Send size={16} />
          </button>
        </form>
      </section>
    </div>
  );
}
