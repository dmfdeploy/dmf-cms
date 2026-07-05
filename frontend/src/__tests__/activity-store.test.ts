/**
 * Console-local activity record (#174 WP3): the C5 quartet from a
 * clear-for-deployment response lands in the History lane's store,
 * newest first, bounded, persisted under a stable localStorage key.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_CONSOLE_ACTION_RECORDS,
  useActivityStore,
} from '../store/activity'
import type { ClearForDeploymentResult } from '../api/types'

function clearResult(overrides: Partial<ClearForDeploymentResult> = {}): ClearForDeploymentResult {
  return {
    instance: 'mxl-hello',
    requested_state: 'active',
    previous_state: 'bootstrapped',
    request_id: `req-${Math.random().toString(36).slice(2)}`,
    actor: 'operator',
    role: 'engineer',
    reason: 'ready for demo',
    reconcile: {
      expectation: 'The catalog drift loop converges this within minutes.',
      watch: 'Activity → Jobs',
    },
    ...overrides,
  }
}

beforeEach(() => {
  window.localStorage.clear()
  useActivityStore.setState({ records: [] })
})

describe('activity store', () => {
  it('records the C5 quartet from a clear response, newest first', () => {
    useActivityStore.getState().recordClear(clearResult({ request_id: 'first' }))
    useActivityStore.getState().recordClear(clearResult({ request_id: 'second' }))
    const records = useActivityStore.getState().records
    expect(records.map((r) => r.request_id)).toEqual(['second', 'first'])
    expect(records[0]).toMatchObject({
      action: 'clear-for-deployment',
      target: 'mxl-hello',
      actor: 'operator',
      role: 'engineer',
      reason: 'ready for demo',
      previous_state: 'bootstrapped',
      requested_state: 'active',
    })
    expect(records[0].at).toBeTruthy()
  })

  it('caps the record list', () => {
    for (let i = 0; i < MAX_CONSOLE_ACTION_RECORDS + 5; i++) {
      useActivityStore.getState().recordClear(clearResult({ request_id: `r${i}` }))
    }
    expect(useActivityStore.getState().records).toHaveLength(MAX_CONSOLE_ACTION_RECORDS)
  })

  it('persists under the dmf-console-activity key', () => {
    useActivityStore.getState().recordClear(clearResult({ request_id: 'persisted' }))
    const raw = window.localStorage.getItem('dmf-console-activity')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).state.records[0].request_id).toBe('persisted')
  })
})
