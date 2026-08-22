import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Star, Trash2 } from 'lucide-react';
import { adminDeleteReview, adminListReviews, adminToggleReviewVisibility } from '@texnobazar/data';

export default function ReviewsWorkspace({ toast }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // all | visible | hidden
  const [page, setPage] = useState(1);
  const pageSize = 30;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const visible = filter === 'all' ? null : filter === 'visible';
      const result = await adminListReviews({ visible, page, pageSize });
      setItems(result?.items || []);
      setTotal(Number(result?.total || 0));
    } catch (e) { setError(e?.message || 'Sharhlar yuklanmadi.'); }
    finally { setLoading(false); }
  }, [filter, page]);

  useEffect(() => { load(); }, [load]);

  const toggleVisibility = async (review) => {
    try {
      await adminToggleReviewVisibility(review.id, !review.is_visible);
      toast?.(review.is_visible ? 'Sharh yashirildi' : 'Sharh ko\'rinadigan qilindi');
      await load();
    } catch (e) { toast?.(e?.message || 'Amal bajarilmadi'); }
  };

  const remove = async (review) => {
    if (!window.confirm(`"${review.reviewer_name}" sharhini o'chirasizmi?`)) return;
    try {
      await adminDeleteReview(review.id);
      toast?.('Sharh o\'chirildi');
      await load();
    } catch (e) { toast?.(e?.message || 'O\'chirib bo\'lmadi'); }
  };

  const totalPages = Math.ceil(total / pageSize);

  return <div className="reviews-workspace">
    <div className="workspace-header">
      <div>
        <h2>Sharhlar va baholar</h2>
        <span className="muted">{total} ta sharh</span>
      </div>
      <div className="filter-tabs">
        {[['all', 'Barchasi'], ['visible', 'Ko\'rinadigan'], ['hidden', 'Yashirilgan']].map(([key, label]) =>
          <button key={key} className={filter === key ? 'active' : ''} onClick={() => { setFilter(key); setPage(1); }}>{label}</button>
        )}
      </div>
    </div>

    {error && <div className="workspace-error">{error} <button onClick={load}>Qayta urinish</button></div>}

    {loading ? <p className="muted" style={{ padding: 24 }}>Yuklanmoqda...</p> :
      items.length === 0 ? <p className="muted" style={{ padding: 24 }}>Sharhlar topilmadi.</p> :
      <div className="reviews-table-wrap">
        <table className="table reviews-table">
          <thead>
            <tr>
              <th>Mahsulot</th>
              <th>Mijoz</th>
              <th>Baho</th>
              <th>Sharh matni</th>
              <th>Sana</th>
              <th>Holat</th>
              <th>Amallar</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => <tr key={item.id} className={item.is_visible ? '' : 'row-hidden'}>
              <td><b>{item.product_name}</b></td>
              <td>{item.reviewer_name}</td>
              <td><span className="review-stars-compact">{Array.from({ length: 5 }, (_, i) => <Star key={i} size={14} fill={i < item.rating ? '#f59e0b' : 'none'} color={i < item.rating ? '#f59e0b' : '#d1d5db'}/>)}</span></td>
              <td className="review-body-cell">{item.body || <em className="muted">Matn yo'q</em>}</td>
              <td><time>{new Date(item.created_at).toLocaleDateString('uz-UZ')}</time></td>
              <td>{item.is_visible ? <span className="badge-visible">Ko'rinadi</span> : <span className="badge-hidden">Yashirin</span>}</td>
              <td className="actions-cell">
                <button className="icon-btn" onClick={() => toggleVisibility(item)} title={item.is_visible ? 'Yashirish' : 'Ko\'rsatish'}>{item.is_visible ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
                <button className="icon-btn danger" onClick={() => remove(item)} title="O'chirish"><Trash2 size={16}/></button>
              </td>
            </tr>)}
          </tbody>
        </table>
      </div>
    }

    {totalPages > 1 && <div className="pagination">
      <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Oldingi</button>
      <span>{page} / {totalPages}</span>
      <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Keyingi</button>
    </div>}
  </div>;
}
