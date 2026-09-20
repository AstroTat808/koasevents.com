import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://koasevents.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
