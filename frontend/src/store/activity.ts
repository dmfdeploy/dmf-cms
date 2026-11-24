import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Console-local record of console-originated consequential actions (#174
 * WP3, the #173 recorded follow-on). The backend logs the C5 quartet but
 * does not persist a queryable audit record yet, so this lane is honest
 * about its provenance: it exists only in this browser (localStorage) and
 * never claims to show other operators' actions. A server-side audit
 * surface arrives with the Audit/Event-Log spec, not this store.
 */
export type ConsoleActionType =
  | 'deploy'
  | 'teardown'
  | 'launch'
  | 'switch-source'
  | 'finalise-purge'

export interface ConsoleActionRecord {
  request_id: string
  action: ConsoleActionType
  target: string
  reason: string
  actor: string
  role: string
  at: string
  // The launch result of an AWX write: launched / already-active / …
  outcome?: string
}

/** A console-originated AWX write (deploy / teardown / launch) for the Activity
 * lane. request_id + reason come from the write; actor/role from the current
 * (effective) user — the record is explicitly browser-local (see file docstring). */
export interface AwxWriteRecord {
  request_id: string
  action: 'deploy' | 'teardown' | 'launch' | 'switch-source' | 'finalise-purge'
  target: string
  reason: string
  actor: string
  role: string
  outcome: string
}

export const MAX_CONSOLE_ACTION_RECORDS = 50

interface ActivityStore {
  records: ConsoleActionRecord[]
  recordAwxWrite: (record: AwxWriteRecord) => void
}

export const useActivityStore = create<ActivityStore>()(
  persist(
    (set) => ({
      records: [],
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
