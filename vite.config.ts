import { defineConfig, type Plugin } from 'vite';

// Inline the tiny (~1.4 KB gz) stylesheet directly into index.html to eliminate
// a render-blocking CSS round-trip and improve First Contentful Paint!
function inlineCssPlugin(): Plugin {
  return {
    name: 'inline-css',
    enforce: 'post',
    generateBundle(_, bundle) {
      let cssAssetKey: string | null = null;
      let cssSource = '';
      for (const [key, item] of Object.entries(bundle)) {
        if (item.type === 'asset' && key.endsWith('.css')) {
          cssAssetKey = key;
          cssSource = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
          break;
        }
      }
      if (!cssAssetKey) return;
      const htmlItem = bundle['index.html'];
      if (htmlItem && htmlItem.type === 'asset' && typeof htmlItem.source === 'string') {
        htmlItem.source = htmlItem.source.replace(
          /<link rel="stylesheet"[^>]*href="[^"]*\.css"[^>]*>/,
          `<style>${cssSource}</style>`,
        );
        delete bundle[cssAssetKey];
      }
    },
  };
}

export default defineConfig({
  base: '/philippines-equake-locator-3d/',
  plugins: [inlineCssPlugin()],
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    cssMinify: true,
    minify: 'esbuild',
  },
  worker: {
    format: 'es',
  },
});
