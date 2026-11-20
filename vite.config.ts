import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { velaManualDismissalPlugin } from './scripts/velaDismissalPatch.mjs';
import tailwindcss from '@tailwindcss/vite';

const packageLock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'));
const lockedPackages = packageLock.packages;

export default defineConfig({
  define: {
    __OMEGA_DEPENDENCY_VERSIONS__: JSON.stringify({
      pinets: lockedPackages['node_modules/pinets'].version,
      vela: lockedPackages['node_modules/@luxalgo/vela'].version,
      velaPinets: lockedPackages['node_modules/@luxalgo/vela-pinets'].version,
    }),
  },
  plugins: [velaManualDismissalPlugin(), tailwindcss()],
  optimizeDeps: { exclude: ['@luxalgo/vela'] },
  base: './',
  build: {
    // Vite's 500 kB advisory counts every chunk, including build-only artifacts: the Monaco
    // TypeScript worker alone is 6.7 MB and the editor bundle 2.7 MB, both of which load only
    // when the Pine editor opens — or never, for the language workers this app does not use.
    // The number that actually decides how fast the platform opens is how many bytes the
    // browser needs BEFORE first paint, and that is enforced precisely by
    // scripts/check-bundle-budget.mjs (1.75 MB budget, currently ~1.59 MB). The limit is
    // raised so the build log stays readable; the budget script is the real gate.
    chunkSizeWarningLimit: 7000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        indicatorBrowser: fileURLToPath(new URL('./indicator-browser.html', import.meta.url)),
        pineEditor: fileURLToPath(new URL('./pine-editor.html', import.meta.url)),
        visualBacktest: fileURLToPath(new URL('./visual-backtest.html', import.meta.url)),
        marketData: fileURLToPath(new URL('./market-data.html', import.meta.url)),
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    host: true,
    watch: {
      ignored: ['**/.git/**', '**/.vs/**', '**/node_modules/**', '**/release-omega/**', '**/OneDrive/**'],
    },
    proxy: {
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
      },
    },
  },
});
