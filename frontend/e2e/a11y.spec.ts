import AxeBuilder from '@axe-core/playwright'
import { test, expect } from './support/test'
import { ROUTES, gotoRoute } from './support/routes'
import { knownAxeViolations } from './support/known-defects'

test.use({ viewport: { width: 1280, height: 800 } })

const BLOCKING = ['serious', 'critical']

for (const path of ROUTES) {
  test(`axe ${path}`, async ({ page }, testInfo) => {
    await gotoRoute(page, path)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze()
    await testInfo.attach('axe-results.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    })
    const known = knownAxeViolations(path)
    const blocking = results.violations.filter(
      (v) => BLOCKING.includes(v.impact ?? '') && !known.has(v.id),
    )
    const summary = blocking.map((v) => {
      const targets = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')
      return `${v.id} (${v.impact}, ${v.nodes.length} nodes): ${targets}`
    })
    expect(summary, 'serious or critical axe violations').toEqual([])

    // A known rule that no longer fires means the defect is fixed: remove its
    // entry from known-defects.ts.
    const found = new Set(results.violations.map((v) => v.id))
    const stale = [...known].filter(([rule]) => !found.has(rule)).map(([r, i]) => `${r} (${i})`)
    expect(stale, 'known axe violations that no longer occur').toEqual([])
  })
}
