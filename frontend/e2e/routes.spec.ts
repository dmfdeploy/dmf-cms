import { test, expect } from './support/test'
import { ROUTES, gotoRoute } from './support/routes'

test.use({ viewport: { width: 1280, height: 800 } })

for (const path of ROUTES) {
  test(`renders ${path}`, async ({ page, api, pageErrors }) => {
    await gotoRoute(page, path)

    await expect(page.locator('main').first()).toBeVisible()
    expect(api.unhandled).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
