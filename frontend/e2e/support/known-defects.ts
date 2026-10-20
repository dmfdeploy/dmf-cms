// Known failures on current main, each tied to the issue that tracks its fix.
//
// A layout case listed here runs under test.fail(), and an axe rule listed
// here is filtered out for its route. Both directions are strict:
//
// - Any failure that is not listed fails the suite.
// - A listed case that starts passing fails the suite too. If you fix a
//   defect, remove its entry in the same change.

const RAIL_ROUTES = [
  '/media-workloads/studio-a',
  '/media-workloads/studio-a/setup',
  '/media-workloads/studio-a/operate',
  '/media-workloads/studio-b',
  '/media-workloads/studio-b/setup',
  '/media-workloads/studio-c',
]

const ALL_WIDTHS = [390, 768, 1024, 1280]

const SHELL = 'dmfdeploy/dmfdeploy#610'
const A11Y = 'dmfdeploy/dmfdeploy#614'

export type Invariant =
  | 'only main scrolls'
  | 'top bar stays'
  | 'sidebar covers nothing'
  | 'bell popover over rail'
  | 'avatar popover over rail'

interface LayoutDefect {
  invariant: Invariant
  routes: string[]
  widths: number[]
  issue: string
  why: string
}

const LAYOUT_DEFECTS: LayoutDefect[] = [
  {
    invariant: 'only main scrolls',
    routes: ['/activity/history'],
    widths: ALL_WIDTHS,
    issue: SHELL,
    why: '<main> is unpositioned, so an absolute span in HistoryLane extends the document',
  },
  {
    invariant: 'top bar stays',
    routes: ['/activity/history'],
    widths: ALL_WIDTHS,
    issue: SHELL,
    why: 'the document scrolls, so a wheel over the sidebar moves the top bar',
  },
  {
    invariant: 'sidebar covers nothing',
    routes: RAIL_ROUTES,
    // The rail row always starts under the sidebar. Whether its centred first
    // key clears the sidebar depends on font metrics: at 1024px it clears by
    // about 12px with the macOS system font, but not with the Linux one in CI.
    widths: process.platform === 'linux' ? [390, 768, 1024] : [390, 768],
    issue: SHELL,
    why: 'the rail row starts at x=0 under the fixed sidebar',
  },
  {
    invariant: 'bell popover over rail',
    routes: RAIL_ROUTES,
    widths: ALL_WIDTHS,
    issue: SHELL,
    why: 'the header and the rail row each create a z-20 stacking context',
  },
  {
    invariant: 'avatar popover over rail',
    routes: RAIL_ROUTES,
    widths: ALL_WIDTHS,
    issue: SHELL,
    why: 'the header and the rail row each create a z-20 stacking context',
  },
]

/** Returns "<issue>: <why>" when this case is a known failure. */
export function knownLayoutDefect(
  invariant: Invariant,
  route: string,
  width: number,
): string | undefined {
  const hit = LAYOUT_DEFECTS.find(
    (d) => d.invariant === invariant && d.routes.includes(route) && d.widths.includes(width),
  )
  return hit && `${hit.issue}: ${hit.why}`
}

interface AxeDefect {
  rule: string
  routes: string[] | 'all'
  issue: string
}

const AXE_DEFECTS: AxeDefect[] = [
  // The bell's visible alert count is not part of its accessible name.
  { rule: 'label-content-name-mismatch', routes: 'all', issue: A11Y },
  { rule: 'color-contrast', routes: ['/', '/activity/history', '/monitoring'], issue: A11Y },
  // The icon-only PR link in the history lane has no name.
  { rule: 'link-name', routes: ['/activity/history'], issue: A11Y },
  // A colour-only inline link on the setup page.
  {
    rule: 'link-in-text-block',
    routes: ['/media-workloads/studio-a/setup', '/media-workloads/studio-b/setup'],
    issue: A11Y,
  },
]

/** Maps each known axe rule on this route to the issue that tracks it. */
export function knownAxeViolations(route: string): Map<string, string> {
  return new Map(
    AXE_DEFECTS.filter((d) => d.routes === 'all' || d.routes.includes(route)).map((d) => [
      d.rule,
      d.issue,
    ]),
  )
}
