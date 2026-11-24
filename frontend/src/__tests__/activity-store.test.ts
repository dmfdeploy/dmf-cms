/**
 * Console-local activity record (#174 WP3): the C5 quartet from a console
 * write lands in the History lane's store, newest first, bounded, persisted
 * under a stable localStorage key.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CONSOLE_ACTION_RECORDS,
  useActivityStore,
  type AwxWriteRecord,
} from '../store/activity'

function awxWrite(overrides: Partial<AwxWriteRecord> = {}): AwxWriteRecord {
  return {
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    action: 'deploy',
    target: 'mxl-videotest-view',
    reason: 'scheduled provision',
    actor: 'ops',
    role: 'operator',
    outcome: 'launched',
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  useActivityStore.setState({ records: [] })
})

describe('activity store', () => {
  it('records the C5 quartet from an AWX write, newest first (#185 WP-E)', () => {
    useActivityStore.getState().recordAwxWrite(awxWrite({ request_id: 'first' }))
    useActivityStore.getState().recordAwxWrite(awxWrite({ request_id: 'second', action: 'launch' }))
    const records = useActivityStore.getState().records
    expect(records.map((r) => r.request_id)).toEqual(['second', 'first'])
    expect(records[0]).toMatchObject({
      action: 'launch',
      target: 'mxl-videotest-view',
      reason: 'scheduled provision',
      actor: 'ops',
      role: 'operator',
      outcome: 'launched',
    })
    expect(records[0].at).toBeTruthy()
  })

  it('caps the record list', () => {
    for (let i = 0; i < MAX_CONSOLE_ACTION_RECORDS + 5; i++) {
      useActivityStore.getState().recordAwxWrite(awxWrite({ request_id: `r${i}` }))
    }
    expect(useActivityStore.getState().records).toHaveLength(MAX_CONSOLE_ACTION_RECORDS)
  })

  it('persists under the dmf-console-activity key', () => {
    useActivityStore.getState().recordAwxWrite(awxWrite({ request_id: 'persisted' }))
    const raw = window.localStorage.getItem('dmf-console-activity')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).state.records[0].request_id).toBe('persisted')
  })
})
