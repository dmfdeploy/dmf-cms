import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './support/test'
import { gotoRoute } from './support/routes'
import { addSpacer, shellState } from './support/shell'

// A public-mode sandbox: the top bar shows the warning on every page and the
// Settings page shows the certificate authority card.
const PUBLIC_SANDBOX = {
  network_mode: 'public',
  approval_page_name: 'trust.example.invalid',
  ca_fingerprint_sha256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  ca_not_after: '2036-01-01T00:00:00Z',
  sandbox: true,
}

const BLOCKING = ['serious', 'critical']

test.use({ viewport: { width: 1280, height: 800 } })

test.beforeEach(({ api }) => {
  api.override('GET', '/api/platform-trust', { json: PUBLIC_SANDBOX })
})

for (const path of ['/', '/settings']) {
  test(`axe ${path} in a public sandbox`, async ({ page }) => {
    await gotoRoute(page, path)
    await expect(page.getByTestId('sandbox-banner')).toBeVisible()
    if (path === '/settings') {
      await expect(page.getByRole('heading', { name: 'Certificate authority' })).toBeVisible()
    }
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    const blocking = results.violations.filter((v) => BLOCKING.includes(v.impact ?? ''))
    const summary = blocking.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
    expect(summary, 'serious or critical axe violations').toEqual([])
  })
}

test.describe('[390] the banner keeps the shell contract', () => {
  test.use({ viewport: { width: 390, height: 800 } })

  for (const path of ['/', '/settings']) {
    test(`${path}: only main scrolls`, async ({ page }) => {
      await gotoRoute(page, path)
      await expect(page.getByTestId('sandbox-banner')).toBeVisible()
      await addSpacer(page)
      const m = await page.evaluate(() => {
        const main = document.querySelector('main')!
        return {
          docHeight: document.scrollingElement!.scrollHeight,
          innerHeight: window.innerHeight,
          overflowY: getComputedStyle(main).overflowY,
          mainScrollable: main.scrollHeight > main.clientHeight,
        }
      })
      expect(m.docHeight, 'document height must not exceed the viewport').toBeLessThanOrEqual(m.innerHeight)
      expect(['auto', 'scroll'], '<main> must be the scroll container').toContain(m.overflowY)
      expect(m.mainScrollable, '<main> must overflow with the spacer inside it').toBe(true)
    })

    test(`${path}: top bar stays`, async ({ page }) => {
      await gotoRoute(page, path)
      await expect(page.getByTestId('sandbox-banner')).toBeVisible()
      await addSpacer(page)
      await page.locator('main').first().evaluate((main) => {
        main.scrollTo({ top: main.scrollHeight, behavior: 'instant' })
      })
      const s = await shellState(page)
      expect(s.scrollY, 'window.scrollY after scrolling <main>').toBe(0)
      expect(s.headerTop, 'header top after scrolling <main>').toBeGreaterThanOrEqual(0)
      expect(s.headerBottom).toBeLessThanOrEqual(s.viewportHeight)
    })
  }
})
