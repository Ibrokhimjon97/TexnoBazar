import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import sitemapHandler from './api/sitemap.js';
import robotsHandler from './api/robots.js';
import paymentMethodsHandler from './api/payments/methods.js';
import paymentInitiateHandler from './api/payments/initiate.js';
import paymentStatusHandler from './api/payments/status.js';
import clickHandler from './api/payments/click.js';
import paymeHandler from './api/payments/payme.js';
import refundHandler from './api/payments/refunds.js';

const rootEnvDir = fileURLToPath(new URL('../..', import.meta.url));
const handlers = new Map([
  ['/api/payments/methods', paymentMethodsHandler],
  ['/api/payments/initiate', paymentInitiateHandler],
  ['/api/payments/status', paymentStatusHandler],
  ['/api/payments/click', clickHandler],
  ['/api/payments/payme', paymeHandler],
  ['/api/payments/refunds', refundHandler],
]);

function storefrontApiDevMiddleware() {
  return {
    name: 'texnobazar-storefront-api',
    apply: 'serve',
    configureServer(server) {
      const prefixes = ['VITE_SUPABASE_', 'STOREFRONT_', 'SUPABASE_', 'CLICK_', 'PAYME_', 'PAYMENT_', 'CRON_SECRET'];
      for (const prefix of prefixes) {
        const values = loadEnv(server.config.mode, rootEnvDir, prefix);
        for (const [key, value] of Object.entries(values)) if (!process.env[key]) process.env[key] = value;
      }
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url || '/', 'http://localhost').pathname;
        if (path === '/sitemap.xml' || path === '/api/sitemap') return sitemapHandler(req, res);
        if (path === '/robots.txt' || path === '/api/robots') return robotsHandler(req, res);
        const handler = handlers.get(path);
        if (handler) return handler(req, res);
        next();
      });
    },
  };
}

export default defineConfig({ envDir: rootEnvDir, plugins: [storefrontApiDevMiddleware(), react()] });
