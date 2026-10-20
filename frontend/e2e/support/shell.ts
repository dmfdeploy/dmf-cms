import type { Locator, Page } from '@playwright/test'

export const VIEWPORTS = [390, 768, 1024, 1280] as const
export const VIEWPORT_HEIGHT = 800

/** Appends a tall, inert block inside <main> so every page can scroll. */
export async function addSpacer(page: Page): Promise<void> {
  await page.locator('main').first().evaluate((main) => {
    const spacer = document.createElement('div')
    spacer.setAttribute('aria-hidden', 'true')
    spacer.setAttribute('data-e2e-spacer', '')
    spacer.style.height = '3000px'
    main.appendChild(spacer)
  })
}

/** Returns the window scroll offset and the header's top and bottom edges. */
export async function shellState(page: Page): Promise<{
  scrollY: number
  headerTop: number
  headerBottom: number
  viewportHeight: number
}> {
  return page.evaluate(() => {
    const header = document.querySelector('header')
    const rect = header
      ? header.getBoundingClientRect()
      : { top: Number.NaN, bottom: Number.NaN }
    return {
      scrollY: window.scrollY,
      headerTop: rect.top,
      headerBottom: rect.bottom,
      viewportHeight: window.innerHeight,
    }
  })
}

/** Turns the wheel over the sidebar column, where <main> is not under the pointer. */
export async function wheelOverSidebar(page: Page): Promise<void> {
  await page.mouse.move(8, 400)
  await page.mouse.wheel(0, 6000)
  await page.waitForTimeout(300)
}

/** Describes the hit at a point, for failure messages. */
export function describeNode(el: Element | null): string {
  if (!el) return 'nothing (outside the viewport)'
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join('.') : ''
  const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30)
  return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}> "${label}"`
}

export function railRow(page: Page): Locator {
  return page.getByTestId('header-slot-row')
}
