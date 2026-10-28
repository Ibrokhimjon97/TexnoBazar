import React from 'react';
import { Plus, User, X } from 'lucide-react';

export default function CustomerTabsBar({
  tabs = [],
  activeTabId,
  onSelectTab,
  onAddTab,
  onCloseTab,
  compact = false
}) {
  return (
    <div className={`seller-customer-tabs-bar ${compact ? 'compact' : ''}`}>
      <div className="seller-customer-tabs-scroll">
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          const itemCount = tab.cart?.length || 0;
          const rawName = tab.customer?.full_name?.trim();
          const displayName = rawName || tab.label || `${idx + 1}-mijoz`;
          const isEditing = Boolean(tab.editingPendingSale);

          return (
            <div
              key={tab.id}
              className={`seller-customer-tab-chip ${isActive ? 'active' : ''} ${itemCount > 0 ? 'has-items' : ''}`}
              onClick={() => onSelectTab(tab.id)}
              role="button"
              tabIndex={0}
            >
              <span className="tab-chip-icon">
                {isEditing ? '✏️' : <User size={13} />}
              </span>
              <span className="tab-chip-name" title={displayName}>
                {displayName}
              </span>
              <span className={`tab-chip-count ${itemCount > 0 ? 'highlight' : ''}`}>
                {itemCount > 0 ? `${itemCount}` : '0'}
              </span>
              <button
                type="button"
                className="tab-chip-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title="Mijoz tabini yopish"
                aria-label="Mijoz tabini yopish"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="seller-add-customer-tab-btn"
          onClick={onAddTab}
          title="Yangi mijoz tabini ochish"
        >
          <Plus size={14} />
          <span>Yangi mijoz</span>
        </button>
      </div>
    </div>
  );
}
