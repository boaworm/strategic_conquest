import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Plugin that replaces server-only modules (NnAgent/NnMoEAgent) with browser-safe stubs.
// These modules use node:path + onnxruntime-node which cannot be bundled for the browser.
function stubServerModules() {
  const STUB_CONTENT = `export class NnAgent { init(){} act(){ return null; } }
export class NnMoEAgent { init(){} act(){ return null; } }`;
  const VIRTUAL_ID = '\0stub:nn-server';

  return {
    name: 'stub-server-modules',
    resolveId(source: string, importer?: string) {
      if (!importer) return null;
      // Stub nnAgent and nnMoEAgent when imported from shared/dist
      if ((source === './nnAgent.js' || source === './nnMoEAgent.js') && importer.includes('shared/dist/index')) {
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
    exclude: ['@sc/shared'],
  },
  resolve: {
    alias: {
      '@sc/shared': path.resolve(__dirname, '../shared/dist/index.js'),
    },
  },
});
