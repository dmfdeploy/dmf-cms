// Single source of truth for the app's Vite `base` (must match the
// production backend's static-asset mount point, src/dmf_cms/static/app/).
//
// Shared between vite.config.ts and
// src/__tests__/devHarnessRoute.test.tsx, so the dev harness's
// base-prefix-tolerance test (dmf-cms#391) is driven from the SAME value
// the app actually builds/serves with, not a hardcoded duplicate string —
// if this ever changes, both move together. Deliberately a standalone file
// with zero imports of its own: importing vite.config.ts directly from a
// vitest test breaks esbuild inside the jsdom test environment (the
// @vitejs/plugin-react() call it makes at module-eval time is the likely
// cause), so the shared value has to live somewhere trivially importable
// from both a Node-loaded Vite config and a jsdom-run test — this file is
// that somewhere, and nothing else.
export const APP_BASE = '/static/app/'
