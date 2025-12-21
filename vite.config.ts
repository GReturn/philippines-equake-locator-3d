import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          mapbox: ['mapbox-gl'],
          vendor: ['react', 'react-dom'], 
          visualization: ['deck.gl', '@deck.gl/core', '@deck.gl/layers', '@loaders.gl/core'],
        }
      }
    }
  },
  base: "/philippines-equake-locator-3d/",
})
