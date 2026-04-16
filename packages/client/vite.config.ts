import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const stub = path.resolve(__dirname, 'src/stubs/serverOnly.ts');

// Plugin that replaces server-only modules (NnAgent/NnMoEAgent) with browser-safe stubs.
// These modules use node:path + onnxruntime-node which cannot be bundled for the browser.
// shared/dist/index.js imports them as './nnAgent.js' and './nnMoEAgent.js'.
function stubServerModules() {
  const STUB_CONTENT = `export class NnAgent { init(){} act(){ return null; } }
export class NnMoEAgent { init(){} act(){ return null; } }`;
  const VIRTUAL_ID = '\0stub:nn-server';
  const SHARED_INDEX = /packages[/\\]shared[/\\]dist[/\\]index\.js$/;

  return {
    name: 'stub-server-modules',
    resolveId(source: string, importer?: string) {
      if (!importer) return null;
      if ((source === './nnAgent.js' || source === './nnMoEAgent.js') && SHARED_INDEX.test(importer)) {
        return VIRTUAL_ID;
      }
      return null;
    },
    load(id: string) {
      if (id === VIRTUAL_ID) return STUB_CONTENT;
      return null;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [stubServerModules(), react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, '../server/public'),
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['onnxruntime-node', '@sc/shared'],
  },
});
