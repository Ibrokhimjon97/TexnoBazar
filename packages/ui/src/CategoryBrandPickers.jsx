import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, ChevronDown, Check, Pin, X } from 'lucide-react';

export const RECENT_CATS_KEY = 'tb_recent_categories';
export const RECENT_BRANDS_KEY = 'tb_recent_brands';

export function getStoredRecents(key) {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveStoredRecent(key, id) {
  if (!id) return;
  try {
    const current = getStoredRecents(key).filter(item => item !== id);
    const updated = [id, ...current].slice(0, 2);
    window.localStorage.setItem(key, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

/**
 * Qidiruv va oxirgi 2 ta ishlatilgan kategoriya yuqorida pin qilingan kategoriya tanlagich
 */
export function SearchableCategoryPicker({
  categories = [],
  value = '',
  onChange,
  required = false,
  disabled = false,
  placeholder = 'Kategoriyani tanlang yoki qidiring...'
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [recentIds, setRecentIds] = useState(() => getStoredRecents(RECENT_CATS_KEY));
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus search input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearch('');
    }
  }, [open]);

  // Map categories for fast lookup
  const categoryMap = useMemo(() => {
    const map = new Map();
    categories.forEach(c => map.set(c.id, c));
    return map;
  }, [categories]);

  // Selected category info
  const selectedCategory = categoryMap.get(value);
  const selectedLabel = useMemo(() => {
    if (!selectedCategory) return '';
    if (selectedCategory.parent_id && categoryMap.has(selectedCategory.parent_id)) {
      const parent = categoryMap.get(selectedCategory.parent_id);
      return `${parent.name} › ${selectedCategory.name}`;
    }
    return selectedCategory.name;
  }, [selectedCategory, categoryMap]);

  // 2 Pinned recent categories
  const pinnedCategories = useMemo(() => {
    return recentIds
      .map(id => categoryMap.get(id))
      .filter(Boolean)
      .slice(0, 2);
  }, [recentIds, categoryMap]);

  // Filter categories by search
  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (c.parent_id && categoryMap.has(c.parent_id)) {
        return categoryMap.get(c.parent_id).name.toLowerCase().includes(q);
      }
      return false;
    });
  }, [categories, search, categoryMap]);

  // Group filtered categories by parent
  const groupedCategories = useMemo(() => {
    const parents = categories.filter(c => !c.parent_id);
    const groups = [];

    // If searching, show a flat list with breadcrumb paths
    if (search.trim()) {
      return filteredCategories.map(c => {
        let label = c.name;
        if (c.parent_id && categoryMap.has(c.parent_id)) {
          label = `${categoryMap.get(c.parent_id).name} › ${c.name}`;
        }
        return { ...c, displayLabel: label };
      });
    }

    // Normal view: parents with children
    parents.forEach(p => {
      const children = categories.filter(c => c.parent_id === p.id);
      groups.push({ parent: p, children });
    });

    // Standalone children whose parent is missing from categories list
    const standalone = categories.filter(c => c.parent_id && !categoryMap.has(c.parent_id));
    if (standalone.length) {
      groups.push({ parent: { id: '__standalone__', name: 'Boshqa kategoriyalar' }, children: standalone });
    }

    return groups;
  }, [categories, filteredCategories, search, categoryMap]);

  const handleSelect = (catId, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    onChange?.(catId);
    if (catId) {
      const updated = saveStoredRecent(RECENT_CATS_KEY, catId);
      if (updated) setRecentIds(updated);
    }
    setOpen(false);
  };

  const handleClear = e => {
    e.stopPropagation();
    onChange?.('');
  };

  return (
    <div className="picker-container" ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {/* Hidden input for HTML form validation if required */}
      {required && (
        <input
          tabIndex={-1}
          style={{ position: 'absolute', opacity: 0, width: '100%', height: 0, pointerEvents: 'none' }}
          value={value || ''}
          onChange={() => {}}
          required
        />
      )}

      {/* Trigger Button */}
      <div
        className={`picker-trigger ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: '#fff',
          border: open ? '1.5px solid var(--orange, #ea580c)' : '1px solid var(--line, #cbd5e1)',
          borderRadius: 10,
          cursor: disabled ? 'not-allowed' : 'pointer',
          minHeight: 38,
          boxShadow: open ? '0 0 0 3px rgba(249,115,22,0.12)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s'
        }}
      >
        <span style={{ fontSize: 13, color: selectedLabel ? '#0f172a' : '#94a3b8', fontWeight: selectedLabel ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 6 }}>
          {selectedLabel || placeholder}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {value && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              title="Tanlovni tozalash"
              style={{ border: 0, background: 'none', padding: 2, cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center' }}
            >
              <X size={14} />
            </button>
          )}
          <ChevronDown size={16} color="#64748b" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </div>
      </div>

      {/* Dropdown Menu */}
      {open && (
        <div
          className="picker-dropdown card"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 1050,
            background: '#fff',
            border: '1.5px solid #cbd5e1',
            borderRadius: 12,
            boxShadow: '0 10px 25px -5px rgba(0,0,0,0.12), 0 8px 10px -6px rgba(0,0,0,0.08)',
            maxHeight: 340,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {/* Search Bar */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={15} color="#64748b" style={{ flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              className="input"
              style={{
                width: '100%',
                padding: '5px 8px',
                fontSize: 12,
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                background: '#fff'
              }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Kategoriya qidiring..."
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', color: '#94a3b8' }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* 📌 Pinned Recent Categories */}
          {pinnedCategories.length > 0 && !search.trim() && (
            <div style={{ padding: '8px 10px', background: '#fff7ed', borderBottom: '1px solid #ffedd5' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#c2410c', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
                <Pin size={12} color="#ea580c" /> Oxirgi ishlatilganlar:
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {pinnedCategories.map(cat => {
                  const isSelected = cat.id === value;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={e => handleSelect(cat.id, e)}
                      onMouseDown={e => e.stopPropagation()}
                      style={{
                        padding: '3px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: isSelected ? '1.5px solid #ea580c' : '1px solid #fed7aa',
                        background: isSelected ? '#ea580c' : '#fff',
                        color: isSelected ? '#fff' : '#9a3412',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                    >
                      📌 {cat.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Categories List */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
            {/* Clear option */}
            <div
              onClick={e => handleSelect('', e)}
              onMouseDown={e => e.stopPropagation()}
              style={{
                padding: '7px 12px',
                fontSize: 12,
                color: !value ? '#ea580c' : '#64748b',
                background: !value ? '#fff7ed' : 'transparent',
                fontWeight: !value ? 700 : 400,
                cursor: 'pointer',
                borderBottom: '1px solid #f1f5f9'
              }}
            >
              — Kategoriyasiz (Tanlanmagan) —
            </div>

            {search.trim() ? (
              // Search flat results
              groupedCategories.length === 0 ? (
                <div style={{ padding: '16px 12px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                  "{search}" bo‘yicha kategoriya topilmadi
                </div>
              ) : (
                groupedCategories.map(cat => {
                  const isSelected = cat.id === value;
                  return (
                    <div
                      key={cat.id}
                      onClick={e => handleSelect(cat.id, e)}
                      onMouseDown={e => e.stopPropagation()}
                      style={{
                        padding: '8px 12px',
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: isSelected ? '#fff7ed' : 'transparent',
                        color: isSelected ? '#ea580c' : '#1e293b',
                        fontWeight: isSelected ? 700 : 500
                      }}
                      onMouseEnter={e => {
                        if (!isSelected) e.currentTarget.style.background = '#f8fafc';
                      }}
                      onMouseLeave={e => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span>{cat.displayLabel}</span>
                      {isSelected && <Check size={14} color="#ea580c" />}
                    </div>
                  );
                })
              )
            ) : (
              // Normal grouped view
              groupedCategories.map(group => {
                const parent = group.parent;
                const children = group.children || [];
                const isParentSelected = parent.id === value;
                return (
                  <div key={parent.id} style={{ marginBottom: 4 }}>
                    {parent.id !== '__standalone__' && (
                      <div
                        onClick={e => handleSelect(parent.id, e)}
                        onMouseDown={e => e.stopPropagation()}
                        style={{
                          padding: '7px 12px',
                          fontSize: 12,
                          fontWeight: 700,
                          color: isParentSelected ? '#ea580c' : '#0f172a',
                          background: isParentSelected ? '#fff7ed' : '#f8fafc',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderTop: '1px solid #f1f5f9'
                        }}
                      >
                        <span>📁 {parent.name}</span>
                        {isParentSelected && <Check size={14} color="#ea580c" />}
                      </div>
                    )}
                    {children.map(child => {
                      const isChildSelected = child.id === value;
                      return (
                        <div
                          key={child.id}
                          onClick={e => handleSelect(child.id, e)}
                          onMouseDown={e => e.stopPropagation()}
                          style={{
                            padding: '6px 12px 6px 26px',
                            fontSize: 12,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: isChildSelected ? '#fff7ed' : 'transparent',
                            color: isChildSelected ? '#ea580c' : '#334155',
                            fontWeight: isChildSelected ? 700 : 400
                          }}
                          onMouseEnter={e => {
                            if (!isChildSelected) e.currentTarget.style.background = '#f1f5f9';
                          }}
                          onMouseLeave={e => {
                            if (!isChildSelected) e.currentTarget.style.background = 'transparent';
                          }}
                        >
                          <span>↳ {child.name}</span>
                          {isChildSelected && <Check size={14} color="#ea580c" />}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Qidiruv va oxirgi 2 ta ishlatilgan brend yuqorida pin qilingan brend tanlagich
 */
export function SearchableBrandPicker({
  brands = [],
  value = '',
  onChange,
  disabled = false,
  placeholder = 'Brendni tanlang yoki qidiring...'
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [recentIds, setRecentIds] = useState(() => getStoredRecents(RECENT_BRANDS_KEY));
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus search input on open
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearch('');
    }
  }, [open]);

  // Map brands for fast lookup
  const brandMap = useMemo(() => {
    const map = new Map();
    brands.forEach(b => map.set(b.id, b));
    return map;
  }, [brands]);

  // Selected brand
  const selectedBrand = brandMap.get(value);

  // 2 Pinned recent brands
  const pinnedBrands = useMemo(() => {
    return recentIds
      .map(id => brandMap.get(id))
      .filter(Boolean)
      .slice(0, 2);
  }, [recentIds, brandMap]);

  // Filter brands by search
  const filteredBrands = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return brands;
    return brands.filter(b => b.name.toLowerCase().includes(q));
  }, [brands, search]);

  const handleSelect = (brandId, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    onChange?.(brandId);
    if (brandId) {
      const updated = saveStoredRecent(RECENT_BRANDS_KEY, brandId);
      if (updated) setRecentIds(updated);
    }
    setOpen(false);
  };

  const handleClear = e => {
    e.stopPropagation();
    onChange?.('');
  };

  return (
    <div className="picker-container" ref={containerRef} style={{ position: 'relative', width: '100%', flex: 1 }}>
      {/* Trigger Button */}
      <div
        className={`picker-trigger ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: '#fff',
          border: open ? '1.5px solid var(--orange, #ea580c)' : '1px solid var(--line, #cbd5e1)',
          borderRadius: 10,
          cursor: disabled ? 'not-allowed' : 'pointer',
          minHeight: 38,
          boxShadow: open ? '0 0 0 3px rgba(249,115,22,0.12)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s'
        }}
      >
        <span style={{ fontSize: 13, color: selectedBrand ? '#0f172a' : '#94a3b8', fontWeight: selectedBrand ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 6 }}>
          {selectedBrand ? selectedBrand.name : placeholder}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {value && !disabled && (
            <button
              type="button"
              onClick={handleClear}
              title="Tanlovni tozalash"
              style={{ border: 0, background: 'none', padding: 2, cursor: 'pointer', color: '#94a3b8', display: 'flex', alignItems: 'center' }}
            >
              <X size={14} />
            </button>
          )}
          <ChevronDown size={16} color="#64748b" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </div>
      </div>

      {/* Dropdown Menu */}
      {open && (
        <div
          className="picker-dropdown card"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 1050,
            background: '#fff',
            border: '1.5px solid #cbd5e1',
            borderRadius: 12,
            boxShadow: '0 10px 25px -5px rgba(0,0,0,0.12), 0 8px 10px -6px rgba(0,0,0,0.08)',
            maxHeight: 320,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}
        >
          {/* Search Bar */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={15} color="#64748b" style={{ flexShrink: 0 }} />
            <input
              ref={searchInputRef}
              className="input"
              style={{
                width: '100%',
                padding: '5px 8px',
                fontSize: 12,
                border: '1px solid #cbd5e1',
                borderRadius: 8,
                background: '#fff'
              }}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Brend qidiring..."
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', color: '#94a3b8' }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* 📌 Pinned Recent Brands */}
          {pinnedBrands.length > 0 && !search.trim() && (
            <div style={{ padding: '8px 10px', background: '#eff6ff', borderBottom: '1px solid #dbeafe' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 }}>
                <Pin size={12} color="#2563eb" /> Oxirgi ishlatilganlar:
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {pinnedBrands.map(b => {
                  const isSelected = b.id === value;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={e => handleSelect(b.id, e)}
                      onMouseDown={e => e.stopPropagation()}
                      style={{
                        padding: '3px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        borderRadius: 6,
                        border: isSelected ? '1.5px solid #2563eb' : '1px solid #bfdbfe',
                        background: isSelected ? '#2563eb' : '#fff',
                        color: isSelected ? '#fff' : '#1e40af',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4
                      }}
                    >
                      📌 {b.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Brands List */}
          <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
            {/* Brendsiz option */}
            <div
              onClick={e => handleSelect('', e)}
              onMouseDown={e => e.stopPropagation()}
              style={{
                padding: '7px 12px',
                fontSize: 12,
                color: !value ? '#2563eb' : '#64748b',
                background: !value ? '#eff6ff' : 'transparent',
                fontWeight: !value ? 700 : 400,
                cursor: 'pointer',
                borderBottom: '1px solid #f1f5f9'
              }}
            >
              — Brendsiz —
            </div>

            {filteredBrands.length === 0 ? (
              <div style={{ padding: '16px 12px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                "{search}" bo‘yicha brend topilmadi
              </div>
            ) : (
              filteredBrands.map(b => {
                const isSelected = b.id === value;
                return (
                  <div
                    key={b.id}
                    onClick={e => handleSelect(b.id, e)}
                    onMouseDown={e => e.stopPropagation()}
                    style={{
                      padding: '8px 12px',
                      fontSize: 12,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: isSelected ? '#eff6ff' : 'transparent',
                      color: isSelected ? '#1d4ed8' : '#1e293b',
                      fontWeight: isSelected ? 700 : 500
                    }}
                    onMouseEnter={e => {
                      if (!isSelected) e.currentTarget.style.background = '#f8fafc';
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <span>{b.name}</span>
                    {isSelected && <Check size={14} color="#2563eb" />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
