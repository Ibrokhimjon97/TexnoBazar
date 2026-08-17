import React from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider, ProtectedApp } from '@texnobazar/ui';
import '@texnobazar/ui/styles.css';
import './app.css';
import App from './App';
createRoot(document.getElementById('root')).render(<React.StrictMode><AuthProvider><ProtectedApp expectedRoles={['seller']} panelLabel="Sotuvchi"><App/></ProtectedApp></AuthProvider></React.StrictMode>);
