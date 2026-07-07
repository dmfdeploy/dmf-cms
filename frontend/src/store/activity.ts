import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ClearForDeploymentResult } from '../api/types'

/**
 * Console-local record of console-originated consequential actions (#174
 * WP3, the #173 recorded follow-on). The backend logs the C5 quartet but
 * does not persist a queryable audit record yet, so this lane is honest
 * about its provenance: it exists only in this browser (localStorage) and
 * never claims to show other operators' actions. A server-side audit
 * surface arrives with the Audit/Event-Log spec, not this store.
 */
export type ConsoleActionType =
  | 'clear-for-deployment'
  | 'deploy'
  | 'teardown'
  | 'launch'

export interface ConsoleActionRecord {
  request_id: string
  action: ConsoleActionType
  target: string
  reason: string
  actor: string
  role: string
  at: string
  // clear-for-deployment carries the NetBox desired-state transition; the AWX
  // writes (deploy/teardown/launch) don't, so these stay optional. AWX writes
  // instead carry `outcome` (the launch result: launched / already-active / …).
  requested_state?: string
  previous_state?: string
  reconcile_expectation?: string
  outcome?: string
}

/** A console-originated AWX write (deploy / teardown / launch) for the Activity
 * lane. request_id + reason come from the write; actor/role from the current
 * (effective) user — the record is explicitly browser-local (see file docstring). */
export interface AwxWriteRecord {
  request_id: string
  action: 'deploy' | 'teardown' | 'launch'
  target: string
  reason: string
  actor: string
  role: string
  outcome: string
}

export const MAX_CONSOLE_ACTION_RECORDS = 50

interface ActivityStore {
  records: ConsoleActionRecord[]
  recordClear: (result: ClearForDeploymentResult) => void
  recordAwxWrite: (record: AwxWriteRecord) => void
}

export const useActivityStore = create<ActivityStore>()(
  persist(
    (set) => ({
      records: [],
      recordClear: (result) =>
        set((state) => ({
          records: [
            {
              request_id: result.request_id,
              action: 'clear-for-deployment' as const,
              target: result.instance,
              reason: result.reason,
              actor: result.actor,
              role: result.role,
              at: new Date().toISOString(),
              requested_state: result.requested_state,
              previous_state: result.previous_state,
              reconcile_expectation: result.reconcile.expectation,
            },
            ...state.records,
          ].slice(0, MAX_CONSOLE_ACTION_RECORDS),
        })),
      recordAwxWrite: (record) =>
        set((state) => ({
          records: [
            { ...record, at: new Date().toISOString() },
            ...state.records,
          ].slice(0, MAX_CONSOLE_ACTION_RECORDS),
        })),
    }),
    {
      name: 'dmf-console-activity',
      // window.localStorage explicitly: the bare `localStorage` global is
      // shadowed by Node's non-functional experimental webstorage under
      // vitest, and in the browser the two are identical.
      storage: createJSONStorage(() => window.localStorage),
    },
  ),
)
