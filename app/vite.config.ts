import { defineConfig } from 'vite'

export default defineConfig({
  // Caminhos relativos: dentro do .ehpk o WebView pode servir o app a partir
  // de um subcaminho, e '/assets/...' não resolveria.
  base: './',
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
  server: {
    host: true,
  },
})
