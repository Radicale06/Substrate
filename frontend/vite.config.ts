import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies /api to the backend so the browser sees a same-origin API and
 * CORS never enters the picture during development.
 *
 * `rewrite` strips the prefix rather than passing it on, because the backend's catch-all
 * route treats any unmatched path as a URL to crawl — `/api/https://example.com` would
 * otherwise be read as a request to fetch the host `api`.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:3000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
            },
        },
    },
});
