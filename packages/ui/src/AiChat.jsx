import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, Camera, CheckCircle2, Database, Image as ImageIcon,
  Loader, Mic, MicOff, Pencil, Plus, QrCode, Send, Sparkles, Trash2, User,
} from 'lucide-react';
import {
  deleteAiConversation, listAiConversations, listAiMessages, listAiModels,
  sendAiMessage, uploadProductMedia,
} from '@texnobazar/data';
import { QrScannerModal } from './QrScannerModal.jsx';

// Matndan OPTIONS va BUTTONS qatorlarini ajratib oluvchi yordamchi
function parseMessageContent(rawText) {
  if (!rawText) return { cleanText: '', buttons: [] };
  let cleanText = String(rawText);
  const buttons = [];

  // 1. BUTTONS: [{"label": "...", "value": "..."}]
  const btnMatch = cleanText.match(/BUTTONS:\s*(\[[\s\S]*?\])/);
  if (btnMatch) {
    try {
      const parsed = JSON.parse(btnMatch[1]);
      if (Array.isArray(parsed)) {
        parsed.forEach(item => {
          if (item?.label && item?.value) buttons.push(item);
        });
      }
    } catch { /* parse xatoligi bo'lsa o'tkazib yuboramiz */ }
    cleanText = cleanText.replace(/BUTTONS:\s*\[[\s\S]*?\]/, '').trim();
  }

  // 2. OPTIONS: ["...", "..."]
  const optMatch = cleanText.match(/OPTIONS:\s*(\[[\s\S]*?\])/);
  if (optMatch) {
    try {
      const parsed = JSON.parse(optMatch[1]);
      if (Array.isArray(parsed)) {
        parsed.forEach(item => {
          if (typeof item === 'string' && item.trim()) {
            buttons.push({ label: item.trim(), value: item.trim() });
          }
        });
      }
    } catch { /* parse xatoligi */ }
    cleanText = cleanText.replace(/OPTIONS:\s*\[[\s\S]*?\]/, '').trim();
  }

  return { cleanText, buttons };
}

// Yengil markdown rendereri
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

    if (line.includes('|') && line.trim().startsWith('|')) {
      if (!inTable) inTable = true;
      tableBuf.push(line);
      continue;
    } else if (inTable) { flushTable(); }

    if (/^---+$/.test(line.trim())) { out.push('<hr class="ai-md-hr"/>'); continue; }

    const hMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level + 1} class="ai-md-h">${inline(hMatch[2])}</h${level + 1}>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      out.push(`<div class="ai-md-li">${inline(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      out.push(`<div class="ai-md-li ai-md-ol">${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</div>`);
      continue;
    }

    if (!line.trim()) { out.push('<br/>'); continue; }

    out.push(`<p class="ai-md-p">${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre class="ai-md-code"><code>${escHtml(codeBuf.join('\n'))}</code></pre>`);
  if (inTable) flushTable();
  return out.join('');
}

function inline(text) {
  let s = escHtml(text);
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/`([^`]+)`/g, '<code class="ai-md-inline-code">$1</code>');
  s = s.replace(/(\d[\d\s]*(?:\.\d+)?)\s*(so['`\u2018\u2019]m|USD|UZS|usd|uzs|\$)/g, '<span class="ai-md-money">$1 $2</span>');
  return s;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOOL_LABELS = {
  get_metadata_catalogs: 'Katalog va joylashuvlar',
  list_branches: 'Filiallar ro\'yxati',
  search_employees: 'Xodim qidirish',
  search_products: 'Mahsulot qidirish',
  product_stock_by_branch: 'Filiallar qoldig\'i',
  product_detail: 'Mahsulot ma\'lumoti',
  inventory_valuation: 'Qoldiq va qiymati',
  seller_performance: 'Sotuvchilar natijasi',
  product_performance: 'Tovar sotilishi tahlili',
  expense_report: 'Xarajatlar hisoboti',
  employee_salary: 'Xodim maoshi',
  unit_passport: 'Tovar pasporti (QR)',
  profit_loss: 'Foyda va zarar',
  sales_history: 'Sotuvlar tarixi',
  create_or_update_product: 'Mahsulot yaratish / yangilash',
  receive_stock_batch: 'Partiya qabul qilish (QR)',
  quick_inventory_stock: 'Tezkor inventarizatsiya',
  delete_or_archive_product: 'Mahsulotni o\'chirish / arxivlash',
  create_expense: 'Xarajat qayd etish',
  relocate_unit: 'Tovar joyini o\'zgartirish',
  set_product_visibility: 'Saytda ko\'rinishni o\'zgartirish',
  update_product_description: 'Tavsifni yangilash',
};

const SUGGESTIONS = [
  '➕ Yangi mahsulot qo\'shmoqchiman',
  '📦 Yangi partiya tovarlar keldi (Kirim qilish)',
  '📋 Inventarizatsiya — tovar qoldig\'ini kiritish',
  '💰 Bugungi do\'kon xarajatini yozish',
];

export function AiChat({ title = 'AI Yordamchi Operator', suggestions = SUGGESTIONS }) {
  const [models, setModels] = useState([]);
  const [selected, setSelected] = useState({ providerId: null, model: null });
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const recognitionRef = useRef(null);

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

  // Web Speech API (Ovozli kiritish)
  useEffect(() => {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Speech) {
      const recognizer = new Speech();
      recognizer.lang = 'uz-UZ';
      recognizer.continuous = false;
      recognizer.interimResults = false;
      recognizer.onresult = (event) => {
        const text = event.results?.[0]?.[0]?.transcript;
        if (text) {
          setInput(prev => (prev ? `${prev} ${text}` : text));
        }
        setIsListening(false);
      };
      recognizer.onerror = () => setIsListening(false);
      recognizer.onend = () => setIsListening(false);
      recognitionRef.current = recognizer;
    }
  }, []);

  const toggleVoice = () => {
    if (!recognitionRef.current) {
      alert('Brauzeringiz ovozli kiritishni qo\'llab-quvvatlamaydi (Google Chrome tavsiya etiladi).');
      return;
    }
    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch {
        setIsListening(false);
      }
    }
  };

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

  // Rasm yuklash
  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploadingImage(true);
    setError('');
    try {
      const uploadedUrls = [];
      for (const file of files) {
        const dummyId = crypto.randomUUID();
        const uploaded = await uploadProductMedia(dummyId, file, file.name);
        const imgUrl = uploaded?.publicUrl || uploaded?.url || file.name;
        uploadedUrls.push(imgUrl);
      }
      const msg = uploadedUrls.length === 1
        ? `[Rasm yuklandi: ${uploadedUrls[0]}]`
        : `[${uploadedUrls.length} ta rasm yuklandi:\n${uploadedUrls.map(u => `- ${u}`).join('\n')}]`;
      submit(null, msg);
    } catch (err) {
      submit(null, `[Mahsulot rasmi yuklandi: ${files.map(f => f.name).join(', ')}]`);
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // QR skaner natijasi
  const handleQrScan = (code) => {
    setQrOpen(false);
    if (code) {
      submit(null, `QR kod: ${code}. Ushbu tovar pasporti va joylashuv ma'lumotlarini chiqar.`);
    }
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
              <b>Assalomu alaykum! Nima qilishimiz kerak?</b>
              <p>Yangi tovar qo'shish, partiya qabul qilish, QR kodlar chiqarish, xarajat yozish yoki savdo tahlillarini suhbat orqali bajaring.</p>
              <div className="ai-chat-suggestions">
                {suggestions.map(text => (
                  <button type="button" key={text} onClick={event => submit(event, text)}>{text}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map(message => {
            const { cleanText, buttons } = parseMessageContent(message.content);
            return (
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
                  <div className="ai-msg-text">
                    <AiMarkdown text={cleanText} />
                  </div>

                  {/* Interaktiv Tanlov Tugmalari (Option / Action Buttons) */}
                  {buttons.length > 0 && (
                    <div className="ai-action-buttons-wrap">
                      {buttons.map((btn, bIdx) => (
                        <button
                          type="button"
                          key={`btn-${bIdx}`}
                          className="ai-action-btn"
                          disabled={busy}
                          onClick={() => submit(null, btn.value)}
                        >
                          <span>{btn.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })}

          {busy && (
            <article className="ai-msg ai-msg-assistant">
              <span className="ai-msg-avatar"><Bot size={15} /></span>
              <div className="ai-msg-body"><div className="ai-msg-typing"><i /><i /><i /></div></div>
            </article>
          )}
        </div>

        {error && <div className="ai-chat-error"><AlertTriangle size={15} /> {error}</div>}

        <form className="ai-chat-input" onSubmit={submit}>
          {/* Yashirin fayl tanlash */}
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept="image/*"
            multiple
            onChange={handleImageUpload}
          />

          {/* Rasm yuklash tugmasi */}
          <button
            type="button"
            className="ai-tool-btn"
            title="Tovar rasmini yuklash"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || uploadingImage}
          >
            {uploadingImage ? <Loader size={16} className="spin" /> : <ImageIcon size={16} />}
          </button>

          {/* QR Kod Skanerlash tugmasi */}
          <button
            type="button"
            className="ai-tool-btn"
            title="QR Kod skanerlash"
            onClick={() => setQrOpen(true)}
            disabled={busy}
          >
            <QrCode size={16} />
          </button>

          {/* Ovozli kiritish tugmasi */}
          <button
            type="button"
            className={`ai-tool-btn ${isListening ? 'listening' : ''}`}
            title={isListening ? 'Eshitilmoqda… (to\'xtatish uchun bosing)' : 'Ovoz bilan yozish'}
            onClick={toggleVoice}
            disabled={busy}
          >
            {isListening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>

          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }}
            placeholder={isListening ? 'Ovozingiz eshitilmoqda…' : (models.length ? 'Buyruq yoki savolingizni yozing… (Enter — yuborish)' : 'AI provayder sozlanmagan')}
            rows="1"
            disabled={busy || models.length === 0}
          />

          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim() || models.length === 0}>
            <Send size={16} />
          </button>
        </form>
      </section>

      {/* QR Scanner Modali */}
      <QrScannerModal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        onScan={handleQrScan}
        title="Mahsulot QR kodini skanerlang"
      />
    </div>
  );
}
