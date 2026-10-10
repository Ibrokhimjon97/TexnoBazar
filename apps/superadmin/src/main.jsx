import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, ProtectedApp } from '@texnobazar/ui';
import '@texnobazar/ui/styles.css';
import './app.css';
import App from './App';
window.addEventListener('vite:preloadError', (event) => {
  event?.preventDefault?.();
  window.location.reload();
});
window.addEventListener('unhandledrejection', (event) => {
  const msg = String(event?.reason?.message || event?.reason || '');
  if (msg.includes('dynamically imported module') || msg.includes('Failed to fetch dynamically imported module')) {
    event?.preventDefault?.();
    window.location.reload();
  }
});

createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><ProtectedApp expectedRoles={['superadmin','admin']} panelLabel="Superadmin"><App/></ProtectedApp></AuthProvider></React.StrictMode>);
