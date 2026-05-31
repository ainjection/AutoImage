import { defineConfig } from 'wxt';

// Auto Image Flow — our own clean build.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'AutoImage',
    description: 'Batch-generate images from a JSON of prompts via Google Flow, auto-filed per scene.',
    permissions: ['scripting', 'activeTab', 'downloads'],
    host_permissions: ['*://*.google.com/*', '*://labs.google/*'],
  },
});
