import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShoppingCart } from 'lucide-react';

export default function FloatingCartButton({ count, onClick }) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: null, y: null });
  const [dragging, setDragging] = useState(false);
  const [pulse, setPulse] = useState(false);
  const btnRef = useRef(null);
  const dragState = useRef({ active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 });
  const prevCount = useRef(count);

  // Show/hide based on cart count
  useEffect(() => {
    if (count > 0) {
      setVisible(true);
    } else {
      const timer = setTimeout(() => setVisible(false), 300);
      return () => clearTimeout(timer);
    }
  }, [count]);

  // Pulse animation when cart count increases
  useEffect(() => {
    if (count > prevCount.current && count > 0) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 600);
      prevCount.current = count;
      return () => clearTimeout(timer);
    }
    prevCount.current = count;
  }, [count]);

  // Get default position (bottom center)
  const getDefaultPos = useCallback(() => {
    const btnW = 60;
    return {
      x: (window.innerWidth - btnW) / 2,
      y: window.innerHeight - 90,
    };
  }, []);

  // Set initial position
  useEffect(() => {
    if (visible && position.x === null) {
      setPosition(getDefaultPos());
    }
  }, [visible, position.x, getDefaultPos]);

  // Reposition on resize
  useEffect(() => {
    const onResize = () => {
      if (!dragState.current.active) {
        setPosition(prev => {
          if (prev.x === null) return getDefaultPos();
          const btnW = 60, btnH = 60;
          return {
            x: Math.min(Math.max(0, prev.x), window.innerWidth - btnW),
            y: Math.min(Math.max(0, prev.y), window.innerHeight - btnH),
          };
        });
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [getDefaultPos]);

  // Drag handlers - pointer events for both mouse and touch
  const onPointerDown = useCallback(e => {
    if (e.button && e.button !== 0) return;
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragState.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      moved: false,
    };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(e => {
    if (!dragState.current.active) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragState.current.moved = true;
    }
    const btnW = 60, btnH = 60;
    const newX = Math.min(Math.max(0, e.clientX - dragState.current.offsetX), window.innerWidth - btnW);
    const newY = Math.min(Math.max(0, e.clientY - dragState.current.offsetY), window.innerHeight - btnH);
    setPosition({ x: newX, y: newY });
  }, []);

  const onPointerUp = useCallback(e => {
    if (!dragState.current.active) return;
    const wasDrag = dragState.current.moved;
    dragState.current.active = false;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!wasDrag) {
      onClick?.();
    }
  }, [onClick]);

  if (!visible && count === 0) return null;

  return (
    <div
      ref={btnRef}
      className={`floating-cart-btn${count > 0 ? ' show' : ' hide'}${pulse ? ' pulse' : ''}${dragging ? ' dragging' : ''}`}
      style={{
        left: position.x != null ? `${position.x}px` : '50%',
        top: position.y != null ? `${position.y}px` : 'auto',
        bottom: position.y != null ? 'auto' : '90px',
        transform: position.x == null ? 'translateX(-50%)' : 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="button"
      aria-label={`Savatchaga o'tish (${count} ta mahsulot)`}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
    >
      <div className="floating-cart-ring" />
      <div className="floating-cart-ring ring2" />
      <ShoppingCart size={24} />
      {count > 0 && <span className="floating-cart-badge">{count > 99 ? '99+' : count}</span>}
      <span className="floating-cart-label">Savatchaga o'tish</span>
    </div>
  );
}
