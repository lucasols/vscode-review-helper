import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  clean: true,
  format: ['esm'],
  splitting: false,
  external: ['vscode'],
  sourcemap: false,
  esbuildOptions(options) {
    options.mangleProps = /[^_]_$/
  },
})
