import { createContext, useCallback, useContext, useRef } from 'react'

/**
 * dmfdeploy#319: every write is withdrawn while the inventory it was armed
 * against is stale or degraded. Hiding the controls is not enough: a
 * confirmation armed while the read was fresh stays mounted when the read
 * turns stale. So the flag travels in context, the shared confirm components
 * disable their Confirm button while it is set, and every mutating handler
 * calls the guard below at execution time.
 */
const InventoryWritesBlockedContext = createContext(false)

export const InventoryWritesBlockedProvider = InventoryWritesBlockedContext.Provider

/**
 * What a page needs to tell the user why writes are withdrawn: the read that
 * blocked them, or the first read that has not settled yet. Null while writes are allowed.
 */
export interface InventoryWritesBlockReason {
  stale: boolean
  /** The first inventory read has not settled yet; not a failure. */
  checking?: boolean
  reason?: string
  last_success?: string | null
  failure_since?: string | null
}

export const InventoryWritesBlockReasonContext = createContext<InventoryWritesBlockReason | null>(null)

export function useInventoryWritesBlocked(): boolean {
  return useContext(InventoryWritesBlockedContext)
}

export class InventoryWritesBlockedError extends Error {
  constructor() {
    super('The inventory is out of date; no change was sent.')
    this.name = 'InventoryWritesBlockedError'
  }
}

/**
 * Returns `guardWrite`: call it first in a mutating handler. It reads the
 * latest value, not the one captured when the handler was created, and throws
 * so an async confirm handler keeps its panel armed and shows its failure.
 */
export function useGuardWrite(): () => void {
  const blocked = useInventoryWritesBlocked()
  const ref = useRef(blocked)
  ref.current = blocked
  return useCallback(() => {
    if (ref.current) throw new InventoryWritesBlockedError()
  }, [])
}
