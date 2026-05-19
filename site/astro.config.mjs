import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://abject.world',
  integrations: [sitemap()],
  build: {
    assets: 'assets',
  },
});
