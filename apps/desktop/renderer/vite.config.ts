import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

const voiceAssets = new Map([
  ['silero_vad_v5.onnx', '@ricky0123/vad-web/dist'],
  ['vad.worklet.bundle.min.js', '@ricky0123/vad-web/dist'],
  ['ort-wasm-simd-threaded.wasm', 'onnxruntime-web/dist'],
  ['ort-wasm-simd-threaded.mjs', 'onnxruntime-web/dist'],
].map(([name, directory]) => [name, path.resolve(import.meta.dirname, '../../../node_modules', directory, name)]));

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), {
    name: 'local-voice-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split('?')[0].replace(/^\/voice-assets\//, '');
        const source = request.url?.startsWith('/voice-assets/') && voiceAssets.get(name || '');
        if (!source) return next();
        response.setHeader('Content-Type', name?.endsWith('.wasm') ? 'application/wasm' : name?.endsWith('.onnx') ? 'application/octet-stream' : 'text/javascript');
        fs.createReadStream(source).on('error', next).pipe(response);
      });
    },
    writeBundle() {
      const target = path.resolve(import.meta.dirname, 'dist/voice-assets');
      fs.mkdirSync(target, { recursive: true });
      for (const [name, source] of voiceAssets) fs.copyFileSync(source, path.join(target, name));
    },
  }],
  server: {
    host: '127.0.0.1', port: Number(process.env.NICE_PEOPLE_UI_PORT || 4317), strictPort: true,
    proxy: {
      '/api': { target: process.env.NICE_PEOPLE_API || 'http://127.0.0.1:8791', headers: process.env.NICE_PEOPLE_TOKEN ? { Authorization: `Bearer ${process.env.NICE_PEOPLE_TOKEN}` } : {} },
      '/assets': process.env.NICE_PEOPLE_API || 'http://127.0.0.1:8791'
    }
  },
  resolve: { alias: { '@framework': path.resolve(import.meta.dirname, 'src/live2d/framework/src') } },
  build: { outDir: 'dist', emptyOutDir: true }
});
