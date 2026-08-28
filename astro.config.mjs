import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://acceptmetall.ru',
  output: 'static',
  trailingSlash: 'always',

  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],

    routing: {
      prefixDefaultLocale: false,
    },
  },
});