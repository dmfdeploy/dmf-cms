import { test, expect } from './support/test'
import { gotoRoute } from './support/routes'
import { shellState, wheelOverSidebar, railRow } from './support/shell'

// Seeded cases for the shell defects tracked in dmfdeploy/dmfdeploy#610.
// Each asserts the correct behaviour.

test.describe('seeded shell defects', () => {
  test('S1 [390] /activity/history: wheel over the sidebar keeps the top bar', async ({ page }) => {
    // Known defect, dmfdeploy/dmfdeploy#610. Remove test.fail() when the shell
    // fix lands: this case must then pass.
    test.fail()
    await page.setViewportSize({ width: 390, height: 800 })
    await gotoRoute(page, '/activity/history')
    await wheelOverSidebar(page)
    const s = await shellState(page)
    expect(s.scrollY, 'window.scrollY after a wheel over the sidebar').toBe(0)
    expect(s.headerTop, 'header top after a wheel over the sidebar').toBeGreaterThanOrEqual(0)
  })

  test('S2 [768] /media-workloads/studio-a: first rail key is clickable', async ({ page }) => {
    // Known defect, dmfdeploy/dmfdeploy#610. Remove test.fail() when the shell
    // fix lands: this case must then pass.
    test.fail()
    await page.setViewportSize({ width: 768, height: 800 })
    await gotoRoute(page, '/media-workloads/studio-a')
    await expect(railRow(page)).toHaveCount(1)
    const result = await railRow(page).evaluate((row) => {
      const key = row.querySelector('a[href], button')
      if (!key) return { found: false, hit: false, left: 0, hitLabel: '' }
      const r = key.getBoundingClientRect()
      const x = r.left + 2
      const y = r.top + r.height / 2
      const hit = document.elementFromPoint(x, y)
      return {
        found: true,
        hit: !!hit && (hit === key || key.contains(hit)),
        left: Math.round(r.left),
        hitLabel: hit ? hit.tagName.toLowerCase() : 'nothing',
      }
    })
    expect(result.found, 'rail key exists').toBe(true)
    expect(
      result.hit,
      `first rail key (left=${result.left}) is covered by <${result.hitLabel}> at its left edge`,
    ).toBe(true)
  })
})
