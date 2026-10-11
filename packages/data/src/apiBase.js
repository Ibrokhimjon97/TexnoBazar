/**
 * Resolves the backend API base URL for serverless functions (Cloudflare R2, auth, media, etc.).
 *
 * In production, the API endpoints live on the superadmin Netlify deployment:
 * https://texnobazar-admin.netlify.app
 *
 * In local development, if running on localhost or via Vite dev proxy, returns configured base or empty string.
 */
export function getApiBase() {
  if (typeof window !== 'undefined') {
    const configured = (import.meta.env?.VITE_API_BASE || '').trim();
    const isWindowLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (configured) {
      try {
        const url = new URL(configured, window.location.href);
        const isConfigLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        if (isConfigLocal && !isWindowLocal) {
          return 'https://texnobazar-admin.netlify.app';
        }
        return configured.replace(/\/+$/, '');
      } catch {}
    }
    if (!isWindowLocal) {
      return 'https://texnobazar-admin.netlify.app';
    }
    return '';
  }
  return (import.meta.env?.VITE_API_BASE || 'https://texnobazar-admin.netlify.app').replace(/\/+$/, '');
}
