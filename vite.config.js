import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { viteSingleFile } from 'vite-plugin-singlefile' // ✅ 이렇게 구조 분해로 import

export default defineConfig({
  base: './',
  plugins: [
    react(),
    viteSingleFile() // ✅ 함수처럼 호출
  ],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
