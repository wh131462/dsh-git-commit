/**
 * Dual-face build: Host ESM for Node, Client CJS wrapped in the
 * `window.__ModuleLoader__` registration.
 *
 * `dsh-build-tools` owns the wrapper contract and keeps `react`,
 * `react/jsx-runtime`, and `@deepseek-ai/*` external for the Client.
 */

import { buildDshPlugin } from 'dsh-build-tools';

await buildDshPlugin({
  host: { entry: 'src/host/index.ts', out: 'index.js' },
  client: { entry: 'src/client/index.tsx', out: 'client.js' },
  sourcemap: true,
});
