import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://akceptmetall.ru',
  output: 'static',
  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],
    routing: {
      prefixDefaultLocale: false
    }
  }
});
