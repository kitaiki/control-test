import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const geoserverProxy = {
  '/geoserver': {
    target: 'http://192.168.0.232:8897', changeOrigin: true,
    timeout: 20_000, proxyTimeout: 20_000,
  },
}

// https://vite.dev/config/
export default defineConfig({
  server: { proxy: geoserverProxy },
  preview: { proxy: geoserverProxy },
  define: {
    CESIUM_BASE_URL: JSON.stringify('/cesiumStatic'),
  },
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/cesium/Build/Cesium/Workers',
          dest: 'cesiumStatic',
          rename: { stripBase: 4 },
        },
        {
          src: 'node_modules/cesium/Build/Cesium/ThirdParty',
          dest: 'cesiumStatic',
          rename: { stripBase: 4 },
        },
        {
          src: 'node_modules/cesium/Build/Cesium/Assets',
          dest: 'cesiumStatic',
          rename: { stripBase: 4 },
        },
        {
          src: 'node_modules/cesium/Build/Cesium/Widgets',
          dest: 'cesiumStatic',
          rename: { stripBase: 4 },
        },
      ],
    }),
  ],
})
