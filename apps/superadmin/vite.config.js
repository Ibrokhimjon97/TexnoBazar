import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import createEmployeeHandler from './api/employees/create.js';
import presignMediaHandler from './api/media/presign.js';
import uploadMediaHandler from './api/media/upload.js';
import completeMediaHandler from './api/media/complete.js';
import deleteMediaHandler from './api/media/delete.js';
import deliveryProofHandler from './api/media/delivery-proof.js';
import bannerMediaHandler from './api/media/banner.js';
import mediaCleanupHandler from './api/media/cleanup.js';
import receiptDispatchHandler from './api/receipts/dispatch.js';
import telegramWebhookHandler from './api/telegram/webhook.js';
import aiChatHandler from './api/ai/chat.js';
import aiTestProviderHandler from './api/ai/test-provider.js';
import aiListModelsHandler from './api/ai/list-models.js';
import restoreMediaHandler from './api/backup/restore-media.js';
import mediaProxyHandler from './api/backup/media-proxy.js';

const rootEnvDir = fileURLToPath(new URL('../..', import.meta.url));

function employeeApiDevMiddleware() {
  return {
    name: 'texnobazar-employee-api-dev',
    apply: 'serve',
    configureServer(server) {
      const serverEnv = {
        ...loadEnv(server.config.mode, rootEnvDir, 'VITE_SUPABASE_URL'),
        ...loadEnv(server.config.mode, rootEnvDir, 'VITE_SUPABASE_ANON_KEY'),
        ...loadEnv(server.config.mode, rootEnvDir, 'SUPABASE_SECRET_KEY'),
        ...loadEnv(server.config.mode, rootEnvDir, 'R2_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'TELEGRAM_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'MEDIA_CLEANUP_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'NOTIFICATION_CRON_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'RESEND_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'RECEIPT_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'CRON_'),
        ...loadEnv(server.config.mode, rootEnvDir, 'AI_'),
      };
      for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_SECRET_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'MEDIA_CLEANUP_SECRET', 'NOTIFICATION_CRON_SECRET', 'RESEND_API_KEY', 'RECEIPT_FROM_EMAIL', 'CRON_SECRET', 'AI_ALLOWED_ORIGINS']) {
        if (!process.env[key] && serverEnv[key]) process.env[key] = serverEnv[key];
      }

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        const handlers = {
          '/api/employees/create': createEmployeeHandler,
          '/api/media/presign': presignMediaHandler,
          '/api/media/upload': uploadMediaHandler,
          '/.netlify/functions/media-upload': uploadMediaHandler,
          '/api/media/complete': completeMediaHandler,
          '/api/media/delete': deleteMediaHandler,
          '/api/media/delivery-proof': deliveryProofHandler,
          '/api/media/banner': bannerMediaHandler,
          '/api/media/cleanup': mediaCleanupHandler,
          '/api/receipts/dispatch': receiptDispatchHandler,
          '/api/telegram/webhook': telegramWebhookHandler,
          '/api/ai/chat': aiChatHandler,
          '/api/ai/test-provider': aiTestProviderHandler,
          '/api/ai/list-models': aiListModelsHandler,
          '/api/backup/restore-media': restoreMediaHandler,
          '/api/backup/media-proxy': mediaProxyHandler,
        };
        const handler = handlers[pathname];
        if (!handler) return next();
        await handler(req, res);
      });
    },
  };
}

export default defineConfig({
  envDir: rootEnvDir,
  resolve: {
    alias: {
      '@texnobazar/data': fileURLToPath(new URL('../../packages/data/src/index.js', import.meta.url)),
    },
  },
  plugins: [employeeApiDevMiddleware(), react()],
});
