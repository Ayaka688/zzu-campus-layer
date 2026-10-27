import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  publicDir: r('./public'),
  define: { __APP_VERSION__: JSON.stringify('0.2.55') },
  // 鐩稿 base锛氫骇鐗╅噷鐨勮祫婧愬紩鐢ㄦ槸鐩稿 HTML 鐨勶紝
  // 杩欐牱 dist 鏃㈠彲浠ユ斁鍩熷悕鏍癸紙Cloudflare Pages / Netlify锛夛紝涔熷彲浠ユ斁瀛愯矾寰勶紙GitHub Pages 椤圭洰椤碉級銆?  base: './',
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: {
        background: r('./src/background/index.ts'),
        sidepanel: r('./sidepanel/index.html'),
        pwa: r('./pwa/index.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
