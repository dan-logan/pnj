import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',  // Use relative paths for GitHub Pages
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Relative paths so the app installs correctly from a GitHub Pages subpath
      // (e.g. https://user.github.io/repo/) as well as from the domain root.
      manifest: {
        name: 'Pegs and Jokers',
        short_name: 'Pegs',
        description: 'A digital Pegs and Jokers board game — you vs. three AI opponents.',
        theme_color: '#111827',
        background_color: '#111827',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The whole game is client-side, so precache the built shell for
        // full offline play.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
      },
      includeAssets: ['apple-touch-icon.png', 'favicon-32x32.png', 'favicon.png'],
    }),
  ],
})
