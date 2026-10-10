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

createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><ProtectedApp expectedRoles={['superadmin','admin']} panelLabel="Superadmin"><App/></ProtectedApp></AuthProvider></React.StrictMode>);
