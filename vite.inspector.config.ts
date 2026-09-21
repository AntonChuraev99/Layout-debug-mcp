import { defineConfig } from 'vite'

// The inspector is injected into the *target* page, so it must be a single
// self-contained classic script with no imports and no module semantics.
export default defineConfig({
  build: {
    outDir: 'dist/inspector',
    emptyOutDir: true,
    lib: {
      entry: 'src/inspector/index.ts',
      formats: ['iife'],
      name: 'LayoutDebugInspector',
      fileName: () => 'inspector.js',
    },
    minify: false,
  },
})
