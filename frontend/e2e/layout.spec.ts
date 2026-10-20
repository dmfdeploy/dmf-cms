import { test, expect } from './support/test'
import { ROUTES, gotoRoute } from './support/routes'
import {
  VIEWPORTS,
  VIEWPORT_HEIGHT,
  addSpacer,
  shellState,
  wheelOverSidebar,
  railRow,
} from './support/shell'
import { knownLayoutDefect, type Invariant } from './support/known-defects'

// Marks a case as an expected failure when it is listed in known-defects.ts.
function expectKnownDefect(invariant: Invariant, path: string, width: number) {
  const known = knownLayoutDefect(invariant, path, width)
  test.fail(!!known, known)
}

// Layout invariants from the shell contract. Each case loads one route at one
// width and checks one property, so a failure names the route, the width and
// the property.
for (const width of VIEWPORTS) {
  test.describe(`[${width}]`, () => {
    test.use({ viewport: { width, height: VIEWPORT_HEIGHT } })

    for (const path of ROUTES) {
      test(`[${width}] ${path}: only main scrolls`, async ({ page }) => {
        expectKnownDefect('only main scrolls', path, width)
        await gotoRoute(page, path)
        await addSpacer(page)
        const m = await page.evaluate(() => {
          const main = document.querySelector('main')!
          const doc = document.scrollingElement!
          return {
            docHeight: doc.scrollHeight,
            innerHeight: window.innerHeight,
            overflowY: getComputedStyle(main).overflowY,
            mainScrollable: main.scrollHeight > main.clientHeight,
          }
        })
        expect(m.docHeight, 'document height must not exceed the viewport').toBeLessThanOrEqual(
          m.innerHeight,
        )
        expect(['auto', 'scroll'], '<main> must be the scroll container').toContain(m.overflowY)
        expect(m.mainScrollable, '<main> must overflow with the spacer inside it').toBe(true)
      })

      test(`[${width}] ${path}: top bar stays`, async ({ page }) => {
        expectKnownDefect('top bar stays', path, width)
        await gotoRoute(page, path)
        await addSpacer(page)
        await page.locator('main').first().evaluate((main) => {
          main.scrollTo({ top: main.scrollHeight, behavior: 'instant' })
        })
        let s = await shellState(page)
        expect(s.scrollY, 'window.scrollY after scrolling <main>').toBe(0)
        expect(s.headerTop, 'header top after scrolling <main>').toBeGreaterThanOrEqual(0)
        expect(s.headerBottom).toBeLessThanOrEqual(s.viewportHeight)

        await wheelOverSidebar(page)
        s = await shellState(page)
        expect(s.scrollY, 'window.scrollY after a wheel over the sidebar').toBe(0)
        expect(s.headerTop, 'header top after a wheel over the sidebar').toBeGreaterThanOrEqual(0)
        expect(s.headerBottom).toBeLessThanOrEqual(s.viewportHeight)
      })

      test(`[${width}] ${path}: sidebar covers nothing`, async ({ page }) => {
        expectKnownDefect('sidebar covers nothing', path, width)
        await gotoRoute(page, path)
        const offenders = await page.evaluate(() => {
          const sel = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
          const aside = document.querySelector('aside')
          const vw = window.innerWidth
          const vh = window.innerHeight
          const describe = (el: Element | null) => {
            if (!el) return 'nothing'
            const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30)
            return `<${el.tagName.toLowerCase()}> "${label}"`
          }
          const items: { el: Element; r: DOMRect }[] = []
          // An inline link that wraps has a bounding box wider than its text,
          // so measure its first line box.
          document.querySelectorAll(sel).forEach((el) => {
            if (aside && aside.contains(el)) return
            if (!el.checkVisibility()) return
            const r = el.getClientRects()[0] ?? el.getBoundingClientRect()
            if (r.width < 4 || r.height < 4) return
            if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return
            items.push({ el, r })
          })
          const rows = new Map<number, { el: Element; r: DOMRect }>()
          for (const it of items) {
            const key = Math.round(it.r.top)
            const first = rows.get(key)
            if (!first || it.r.left < first.r.left) rows.set(key, it)
          }
          const bad: string[] = []
          for (const { el, r } of rows.values()) {
            const x = Math.max(0, r.left) + Math.min(2, r.width / 2)
            const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
            const hit = document.elementFromPoint(x, y)
            if (hit && (hit === el || el.contains(hit))) continue
            bad.push(
              `${describe(el)} at left=${Math.round(r.left)} top=${Math.round(r.top)} is covered at (${Math.round(x)},${Math.round(y)}) by ${describe(hit)}`,
            )
          }
          return bad
        })
        expect(offenders, 'first focusable element of each row must be hittable').toEqual([])
      })

      for (const [name, trigger, popover] of [
        [
          'bell',
          (p: import('@playwright/test').Page) =>
            p.getByRole('button', { name: 'Monitoring alerts' }),
          'xpath=following-sibling::div[1]',
        ],
        [
          'avatar',
          (p: import('@playwright/test').Page) => p.locator('header button[aria-expanded]'),
          'xpath=following-sibling::div[1]',
        ],
      ] as const) {
        test(`[${width}] ${path}: ${name} popover over rail`, async ({ page }) => {
          expectKnownDefect(`${name} popover over rail`, path, width)
          await gotoRoute(page, path)
          test.skip((await railRow(page).count()) === 0, 'no lifecycle rail row on this route')
          const button = trigger(page).first()
          await button.click()
          const pop = button.locator(popover)
          await expect(pop).toBeVisible()
          const result = await pop.evaluate((popEl) => {
            const row = document.querySelector('[data-testid="header-slot-row"]')!
            const p = popEl.getBoundingClientRect()
            const r = row.getBoundingClientRect()
            const left = Math.max(p.left, r.left, 0)
            const right = Math.min(p.right, r.right, window.innerWidth)
            const top = Math.max(p.top, r.top, 0)
            const bottom = Math.min(p.bottom, r.bottom, window.innerHeight)
            if (right - left < 4 || bottom - top < 4) return { checked: 0, bad: [] as string[] }
            const bad: string[] = []
            let checked = 0
            for (const fx of [0.1, 0.5, 0.9]) {
              for (const fy of [0.1, 0.5, 0.9]) {
                const x = left + (right - left) * fx
                const y = top + (bottom - top) * fy
                const hit = document.elementFromPoint(x, y)
                checked += 1
                if (!hit || !popEl.contains(hit)) {
                  const label = hit
                    ? `<${hit.tagName.toLowerCase()}${hit.getAttribute('data-testid') ? ` data-testid=${hit.getAttribute('data-testid')}` : ''}>`
                    : 'nothing'
                  bad.push(`(${Math.round(x)},${Math.round(y)}) hits ${label}`)
                }
              }
            }
            return { checked, bad }
          })
          expect(
            result.bad,
            `${name} popover points that overlap the rail row must land inside the popover`,
          ).toEqual([])
        })
      }
    }
  })
}
