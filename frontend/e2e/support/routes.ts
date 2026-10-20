import type { Page } from '@playwright/test'

// One concrete path for every <Route> in src/App.tsx, with params filled from
// the fixtures. Skipped on purpose: the <Navigate> redirect aliases
// (/facility, /workflows, /changes, /mxl-flows, the catch-all) and the dev
// harness routes, which bypass the app shell.
export const ROUTES = [
  '/',
  '/facilities',
  '/facilities/studio-site',
  '/activity/jobs',
  '/activity/history',
  '/catalog',
  '/monitoring',
  '/media-workloads',
  '/media-workloads/new',
  '/media-workloads/studio-a',
  '/media-workloads/studio-a/setup',
  '/media-workloads/studio-a/operate',
  '/media-workloads/studio-b',
  '/media-workloads/studio-b/setup',
  '/media-workloads/studio-c',
  '/admin',
  '/settings',
] as const

const APP_BASE = '/static/app/'

/**
 * Loads the app at `path` and waits until it has rendered.
 *
 * The Vite dev server only serves index.html under its base (/static/app/),
 * and the app's router has no basename. So a document request for `path` is
 * answered with the index.html served at the base while the address bar keeps
 * `path`. That is a real deep link, and the module URLs in the page still
 * resolve under the base.
 */
export async function gotoRoute(page: Page, path: string): Promise<void> {
  await page.route(
    (url) => url.pathname === path.split(/[?#]/)[0],
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const base = new URL(route.request().url())
      const response = await route.fetch({ url: `${base.origin}${APP_BASE}` })
      await route.fulfill({ response })
    },
  )
  await page.goto(path)
  await page.locator('main').first().waitFor()
  await page.waitForLoadState('networkidle')
}
