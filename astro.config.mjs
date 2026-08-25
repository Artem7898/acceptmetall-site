import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://akceptmetall.ru',

  // Пока сайт работает в поддиректории.
  // После покупки и подключения akceptmetall.ru
  // этот параметр можно будет удалить.
  base: '/acceptmetall-site/',

  output: 'static',

  // Все страницы будут использовать trailing slash:
  // /en/
  // /privacy/
  // /en/privacy/
  trailingSlash: 'always',

  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],

    routing: {
      // Русский — основной язык без /ru/
      // Английский — /en/
      prefixDefaultLocale: false,
    },
  },
});