/**
 * The console's selector contract (dmfdeploy/dmfdeploy#741).
 *
 * Tests, e2e specs and demo scripts select the console's shell and shared
 * primitives through the entries below. The shell is selected by ARIA role
 * and accessible name. `data-testid` is used only for elements with no
 * semantic handle.
 *
 * Changing, adding or removing an entry changes the digest in
 * selectorContract.lock.json. src/__tests__/selectorContract.test.tsx fails
 * until you bump SELECTOR_CONTRACT_VERSION and regenerate the lock. See the
 * "Selector contract" section of frontend/README.md.
 */

export const SELECTOR_CONTRACT_VERSION = 3

interface EntryBase {
  /** Stable name for the entry. Never reused for a different selector. */
  name: string
  /** The component that renders the selector. */
  component: string
  /** What the `<key>` placeholder means. Present only for keyed entries. */
  key?: string
}

export interface RoleSelector extends EntryBase {
  kind: 'role'
  role: string
  /** Accessible name. May contain `<key>`. */
  accessibleName: string
  /** `regex` reads `accessibleName` as a regular expression source. */
  match: 'exact' | 'regex'
  /**
   * The button is a disclosure trigger: its `aria-controls` is this id, and an
   * element with that id is rendered once the button is activated. Consumers
   * find the panel through the trigger. The panel has no role, because its
   * behaviour is not a menu or dialog.
   */
  controls?: string
}

export interface TestIdSelector extends EntryBase {
  kind: 'testid'
  /** The `data-testid` value. May contain `<key>`. */
  id: string
  /** The element also carries this ARIA role. Present when a consumer selects on both. */
  role?: string
}

export type SelectorEntry = RoleSelector | TestIdSelector

export const SELECTOR_CONTRACT: readonly SelectorEntry[] = [
  // Shell, by role and accessible name.
  {
    name: 'shell-skip-link',
    kind: 'role',
    role: 'link',
    accessibleName: 'Skip to main content',
    match: 'exact',
    component: 'components/Shell.tsx',
  },
  {
    name: 'shell-console-navigation',
    kind: 'role',
    role: 'navigation',
    accessibleName: 'Console navigation',
    match: 'exact',
    component: 'components/Sidebar.tsx',
  },
  {
    name: 'shell-nav-item',
    kind: 'role',
    role: 'link',
    accessibleName: '<key>',
    match: 'exact',
    component: 'components/Sidebar.tsx',
    key: "The nav item's visible label, for example Facilities.",
  },
  {
    name: 'shell-breadcrumb',
    kind: 'role',
    role: 'navigation',
    accessibleName: 'Breadcrumb',
    match: 'exact',
    component: 'components/Topbar.tsx',
  },
  {
    name: 'shell-account-menu',
    kind: 'role',
    role: 'button',
    accessibleName: '<key>, account menu',
    match: 'exact',
    component: 'components/Topbar.tsx',
    controls: 'account-menu-panel',
    key: "The signed-in user's initials, two letters. The view-as controls open from this button.",
  },
  {
    name: 'shell-monitoring-alerts',
    kind: 'role',
    role: 'button',
    accessibleName: '^Monitoring alerts(, \\d+)?$',
    match: 'regex',
    controls: 'monitoring-alerts-panel',
    component: 'components/NotificationBell.tsx',
  },

  // Shell and layout test ids.
  {
    name: 'shell-header-slot-row',
    kind: 'testid',
    id: 'header-slot-row',
    component: 'components/Topbar.tsx',
  },
  {
    name: 'shell-header-slot-reserve',
    kind: 'testid',
    id: 'header-slot-reserve',
    component: 'components/Topbar.tsx',
  },
  {
    name: 'activity-panel',
    kind: 'testid',
    id: 'activity-panel',
    component: 'components/ActivityPanel.tsx',
  },
  {
    name: 'activity-history-lane',
    kind: 'testid',
    id: 'activity-history-lane',
    component: 'pages/Activity/HistoryLane.tsx',
  },

  // Domain-keyed test ids.
  {
    name: 'workload-grid',
    kind: 'testid',
    id: 'workload-grid',
    component: 'pages/MediaWorkloads/index.tsx',
  },
  {
    name: 'workload-tile',
    kind: 'testid',
    id: 'workload-tile-<key>',
    component: 'pages/MediaWorkloads/index.tsx',
    key: "The workload's slug.",
  },
  {
    name: 'viewer-tile',
    kind: 'testid',
    id: 'viewer-tile-<key>',
    role: 'button',
    component: 'pages/MediaWorkloads/WorkloadTile.tsx',
    key: "The instance name, as in the inventory's instance field. Only an openable (MXL) tile has the role.",
  },
  {
    name: 'instance-live-modal',
    kind: 'testid',
    id: 'instance-live-modal',
    component: 'pages/MediaWorkloads/InstanceLiveModal.tsx',
  },

  // Shared primitives. Tile and CanvasGrid take a `testId` prop. The prop is
  // the mechanism: the caller owns the id and names it in this list.
  {
    name: 'reason-confirm-confirm',
    kind: 'testid',
    id: 'confirm-<key>',
    component: 'components/ReasonConfirm.tsx',
    key: "The action's name, passed as testIdPrefix.",
  },
  {
    name: 'reason-confirm-reason',
    kind: 'testid',
    id: 'reason-<key>',
    component: 'components/ReasonConfirm.tsx',
    key: "The action's name, passed as testIdPrefix.",
  },
  {
    name: 'reason-confirm-reason-default',
    kind: 'testid',
    id: 'reason-input',
    component: 'components/ReasonConfirm.tsx',
  },
]

/** Canonical JSON of the entry list: sorted by name, keys sorted. */
export function canonicalContract(entries: readonly SelectorEntry[] = SELECTOR_CONTRACT): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return JSON.stringify(sorted, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

/** SHA-256 of the canonical entry list, as lowercase hex. */
export async function contractDigest(entries: readonly SelectorEntry[] = SELECTOR_CONTRACT): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalContract(entries))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ContractLock {
  version: number
  digest: string
}

/**
 * Compares the committed lock with the current contract. Returns null when
 * they agree, otherwise the message that tells the author what to do.
 */
export function lockProblem(lock: ContractLock, version: number, digest: string): string | null {
  if (lock.version === version && lock.digest === digest) return null
  const lockText = JSON.stringify({ version, digest })
  if (lock.version === version) {
    return (
      `The selector contract no longer matches its lock, and SELECTOR_CONTRACT_VERSION is still ${version}. ` +
      `If you changed an entry on purpose, bump SELECTOR_CONTRACT_VERSION in src/lib/selectorContract.ts to ${version + 1}, ` +
      `then set src/lib/selectorContract.lock.json to ` +
      JSON.stringify({ version: version + 1, digest }) +
      `. If you did not mean to change the contract, revert the change.`
    )
  }
  return (
    `SELECTOR_CONTRACT_VERSION is ${version} but the lock holds version ${lock.version}, or its digest is stale. ` +
    `Set src/lib/selectorContract.lock.json to ${lockText}.`
  )
}
