import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://akceptmetall.ru',
  base: '/acceptmetall-site/',
  output: 'static',
  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],
    routing: {
      prefixDefaultLocale: false
    }
  }
});
