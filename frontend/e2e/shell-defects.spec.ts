import { test, expect } from './support/test'
import { gotoRoute } from './support/routes'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { ApiStub } from './support/api'
import { shellState, wheelOverSidebar, railRow, addSpacer } from './support/shell'

// Seeded cases for the shell defects tracked in dmfdeploy/dmfdeploy#610.
// Each asserts the correct behaviour. The first two were seeded as test.fail()
// by the harness; the shell fix turned them into ordinary cases.

test.describe('seeded shell defects', () => {
  test('S1 [390] /activity/history: wheel over the sidebar keeps the top bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await gotoRoute(page, '/activity/history')
    await wheelOverSidebar(page)
    const s = await shellState(page)
    expect(s.scrollY, 'window.scrollY after a wheel over the sidebar').toBe(0)
    expect(s.headerTop, 'header top after a wheel over the sidebar').toBeGreaterThanOrEqual(0)
  })

  test('S2 [768] /media-workloads/studio-a: first rail key is clickable', async ({ page }) => {
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

  test('S3 [320x256] /media-workloads/studio-a: main keeps room and the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 256 })
    await gotoRoute(page, '/media-workloads/studio-a')
    await expect(railRow(page)).toHaveCount(1)
    const m = await page.evaluate(() => {
      const main = document.querySelector('main')!
      const doc = document.scrollingElement!
      return {
        mainHeight: main.clientHeight,
        viewportHeight: window.innerHeight,
        scrollWidth: doc.scrollWidth,
        innerWidth: window.innerWidth,
      }
    })
    expect(
      m.mainHeight,
      'main height must stay at 40% of the viewport or more once the rail wraps',
    ).toBeGreaterThanOrEqual(m.viewportHeight * 0.4)
    expect(m.scrollWidth, 'the document must not scroll sideways').toBeLessThanOrEqual(m.innerWidth)
  })

  test('S4 [768] /media-workloads/studio-a: opening a route resets main and moves focus into it', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 })
    await gotoRoute(page, '/media-workloads/studio-a')
    await addSpacer(page)
    await page.locator('main').first().evaluate((main) => {
      main.scrollTo({ top: 500, behavior: 'instant' })
    })
    await page.getByRole('link', { name: 'Facilities' }).first().click()
    await expect(page).toHaveURL(/\/facilities$/)
    const s = await page.evaluate(() => {
      const main = document.querySelector('main')!
      return {
        scrollTop: main.scrollTop,
        focusInMain: main.contains(document.activeElement),
        focusIsBody: document.activeElement === document.body,
      }
    })
    expect(s.scrollTop, 'main scroll position after navigating').toBe(0)
    expect(s.focusInMain, 'focus must land inside main after navigating').toBe(true)
  })

  test('S5 [768] /media-workloads/studio-a: the first Tab stop is a skip link to main', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 })
    await gotoRoute(page, '/media-workloads/studio-a')
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()
    await page.keyboard.press('Enter')
    const inMain = await page.evaluate(() =>
      document.querySelector('main')!.contains(document.activeElement),
    )
    expect(inMain, 'activating the skip link moves focus into main').toBe(true)
  })

  test('M1 [390x400] /media-workloads/studio-a: the live modal fits a short viewport', async ({ page, api }) => {
    await page.setViewportSize({ width: 390, height: 400 })
    withMxlTiles(api)
    await gotoRoute(page, '/media-workloads/studio-a')
    await openFirstTile(page)
    const m = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="instance-live-modal"]')!
      const panel = dialog.firstElementChild!.getBoundingClientRect()
      const close = [...dialog.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === 'Close')!
        .getBoundingClientRect()
      return {
        panelTop: panel.top,
        panelBottom: panel.bottom,
        closeTop: close.top,
        closeBottom: close.bottom,
        innerHeight: window.innerHeight,
      }
    })
    expect(m.panelTop, 'panel top inside the viewport').toBeGreaterThanOrEqual(0)
    expect(m.panelBottom, 'panel bottom inside the viewport').toBeLessThanOrEqual(m.innerHeight)
    expect(m.closeTop, 'Close button inside the viewport').toBeGreaterThanOrEqual(0)
    expect(m.closeBottom, 'Close button inside the viewport').toBeLessThanOrEqual(m.innerHeight)
  })

  test('M2 [1280] /media-workloads/studio-a: a drag that starts in the modal and ends on the backdrop keeps it open', async ({ page, api }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    withMxlTiles(api)
    await gotoRoute(page, '/media-workloads/studio-a')
    await openFirstTile(page)
    const dialog = page.getByTestId('instance-live-modal')
    const panelBox = (await dialog.locator('> div').first().boundingBox())!
    await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + 20)
    await page.mouse.down()
    await page.mouse.move(4, 4)
    await page.mouse.up()
    await expect(dialog).toBeVisible()
    // A click that starts and ends on the backdrop still closes it.
    await page.mouse.click(4, 4)
    await expect(dialog).toHaveCount(0)
  })

  test('M3 [1280] /media-workloads/studio-a: the live modal sits above the shell', async ({ page, api }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    withMxlTiles(api)
    await gotoRoute(page, '/media-workloads/studio-a')
    await openFirstTile(page)
    const portalled = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="instance-live-modal"]')!
      return !dialog.closest('main')
    })
    expect(portalled, 'the modal must not live inside <main>').toBe(true)
  })

  // The rail registers after the workload loads. Hold that response so the
  // reserved band can be measured, then release it and measure again. The
  // stacked tier (below 390px), the 30vh cap and one desktop width.
  for (const [width, height] of [[375, 800], [375, 400], [1280, 800]] as const) {
    test(`R1 [${width}x${height}] /media-workloads/studio-a: main does not move when the rail registers`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      await page.route((url) => url.pathname === '/api/media-workloads/grouped', async (route) => {
        await held
        await route.fallback()
      })
      await openWithoutIdle(page, '/media-workloads/studio-a')
      await expect(page.getByTestId('header-slot-reserve')).toHaveCount(1)
      const mainTop = () => page.locator('main').first().evaluate((main) => main.getBoundingClientRect().top)
      const before = await mainTop()
      release()
      await expect(railRow(page)).toHaveCount(1)
      await expect(page.getByTestId('header-slot-reserve')).toHaveCount(0)
      expect(await mainTop(), 'main top after the rail registers').toBe(before)
    })
  }
})

// gotoRoute waits for network idle, which never comes while a response is
// held. Same deep-link serving, without that wait.
async function openWithoutIdle(page: Page, path: string) {
  await page.route((url) => url.pathname === path, async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback()
    const base = new URL(route.request().url())
    await route.fulfill({ response: await route.fetch({ url: `${base.origin}/static/app/` }) })
  })
  await page.goto(path)
  await page.locator('main').first().waitFor()
}

// The shared fixtures carry no MXL instance, and only MXL tiles open the live
// modal. Rename the function keys for this test so a tile is openable.
function withMxlTiles(api: ApiStub) {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'media-workloads-grouped.json')
  const body = readFileSync(file, 'utf8').replaceAll('"function_key": "signal-', '"function_key": "mxl-')
  api.override('GET', '/api/media-workloads/grouped', { json: JSON.parse(body) })
}

async function openFirstTile(page: Page) {
  await page.locator('[role="button"][data-testid^="viewer-tile-"]').first().click()
  await expect(page.getByTestId('instance-live-modal')).toBeVisible()
}
