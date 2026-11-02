import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { loadEnv } from 'vite';

const mode = process.env.NODE_ENV || (process.argv.includes('dev') ? 'development' : 'production');
const publicEnv = loadEnv(mode, process.cwd(), 'PUBLIC_');
const endpoint = process.env.PUBLIC_ORDER_API_URL ?? publicEnv.PUBLIC_ORDER_API_URL;
let orderOrigin = '';
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error('PUBLIC_ORDER_API_URL must be an HTTPS endpoint without credentials, query, or fragment.');
  }
  orderOrigin = ` ${url.origin}`;
}

export default defineConfig({
  site: 'https://acceptmetall.ru',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],
  // No Markdown code blocks are used; avoid inline-style syntax highlighters.
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        `connect-src 'self'${orderOrigin}`,
        `form-action 'self'${orderOrigin}`,
      ],
    },
  },
  vite: {
    server: {
      proxy: {
        '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
      },
    },
  },

  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],

    routing: {
      prefixDefaultLocale: false,
    },
  },
});
