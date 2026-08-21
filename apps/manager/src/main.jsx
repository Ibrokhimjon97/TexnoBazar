import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, ProtectedApp } from '@texnobazar/ui';
import '@texnobazar/ui/styles.css';
import './app.css';
import App from './App';
createRoot(document.getElementById('root')).render(<AuthProvider><ProtectedApp expectedRoles={['manager']} panelLabel="Menejer"><App/></ProtectedApp></AuthProvider>);
