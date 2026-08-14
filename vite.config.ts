import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      strategies: "generateSW",
      registerType: "autoUpdate",
      injectRegister: "script-defer",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        id: ".",
        name: "Scriptorium — Typing Reader",
        short_name: "Scriptorium",
        description: "Type your way through EPUB, PDF, TXT, Markdown, and HTML books—entirely on your device.",
        lang: "en",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#323437",
        theme_color: "#323437",
        categories: ["education", "productivity"],
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        globPatterns: ["**/*.{js,mjs,css,html,ico,png,svg,webp,avif,woff,woff2,ttf,otf}"],
        globIgnores: [
          "**/apple-touch-icon.png",
          "**/favicon.svg",
          "**/maskable-icon-512x512.png",
          "**/pwa-192x192.png",
          "**/pwa-512x512.png",
        ],
      },
    }),
  ],
  build: { target: "es2022", sourcemap: true },
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
