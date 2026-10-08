import React from 'react';

/**
 * Universal Skeleton komponenti.
 * Dark va Light rejimga moslashuvchan, zamonaviy to'lqinli (shimmer) animatsiyaga ega.
 */
export function Skeleton({
  width = '100%',
  height = '18px',
  borderRadius = '8px',
  circle = false,
  className = '',
  style = {},
}) {
  const inlineStyle = {
    width: circle ? (typeof height === 'number' ? `${height}px` : height) : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: circle ? '50%' : borderRadius,
    ...style,
  };

  return <div className={`skeleton-pulse ${className}`.trim()} style={inlineStyle} aria-hidden="true" />;
}

/**
 * Jadval uchun Skeleton loader
 */
export function SkeletonTable({ rows = 5, cols = 5, className = '' }) {
  return (
    <div className={`skeleton-table-wrap ${className}`.trim()}>
      <div className="skeleton-table-head">
        {Array.from({ length: cols }).map((_, c) => (
          <Skeleton key={c} height={16} width={c === 0 ? '60%' : '80%'} borderRadius={6} />
        ))}
      </div>
      <div className="skeleton-table-body">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="skeleton-table-row">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton
                key={c}
                height={15}
                width={c === 0 ? '75%' : c === cols - 1 ? '40%' : '65%'}
                borderRadius={6}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Kartochka ko'rinishidagi Skeleton loader
 */
export function SkeletonCard({ count = 1, hasImage = true, lines = 3, className = '' }) {
  return (
    <div className="skeleton-cards-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`skeleton-card ${className}`.trim()}>
          {hasImage && <Skeleton height="140px" borderRadius="12px" style={{ marginBottom: 12 }} />}
          <Skeleton height={20} width="85%" style={{ marginBottom: 8 }} />
          {Array.from({ length: lines }).map((_, j) => (
            <Skeleton
              key={j}
              height={14}
              width={j === lines - 1 ? '50%' : '100%'}
              style={{ marginBottom: 6 }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Oddiy ro'yxat ko'rinishidagi Skeleton loader
 */
export function SkeletonList({ count = 4, className = '' }) {
  return (
    <div className={`skeleton-list ${className}`.trim()}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-list-item">
          <Skeleton circle height={38} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <Skeleton height={16} width="60%" style={{ marginBottom: 6 }} />
            <Skeleton height={13} width="35%" />
          </div>
        </div>
      ))}
    </div>
  );
}
