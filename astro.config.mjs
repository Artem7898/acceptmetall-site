import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';


export default defineConfig({
  site: 'https://acceptmetall.ru',
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap()],

  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],

    routing: {
      prefixDefaultLocale: false,
    },
  },
});