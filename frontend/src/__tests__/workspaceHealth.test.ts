/**
 * The shared "are we OK?" classifier (Constitution Art. 1). The bell and
 * HealthCore both consume this, so a degraded/unknown state can never render
 * as a green "all systems nominal".
 */
import { describe, expect, it } from 'vitest'
import { classifyWorkspaceHealth, isNominal } from '../lib/workspaceHealth'
import type { WorkspaceHealth } from '../api/types'

function health(overrides: Partial<WorkspaceHealth> = {}): WorkspaceHealth {
  return { configured: true, reachable: true, reason: '', watchdog_firing: true, alerts: [], ...overrides }
}
function alert(severity = 'warning') {
  return {
    id: `fp-${severity}`, name: 'HostMemoryPressure', state: 'firing', severity,
    instance: 'n1', context: '', summary: '', description: '', runbook_url: '', active_at: '',
  }
}

describe('classifyWorkspaceHealth', () => {
  it('nominal only when live, not stale, verified, zero problems', () => {
    const s = classifyWorkspaceHealth({ isLoading: false, isError: false, data: health() })
    expect(s.phase).toBe('live')
    expect(isNominal(s)).toBe(true)
  })

  it('loading before any data', () => {
    const s = classifyWorkspaceHealth({ isLoading: true, isError: false, data: undefined })
    expect(s.phase).toBe('loading')
    expect(isNominal(s)).toBe(false)
  })

  it('not-configured is never nominal', () => {
    const s = classifyWorkspaceHealth({ isLoading: false, isError: false, data: health({ configured: false }) })
    expect(s.phase).toBe('not-configured')
    expect(isNominal(s)).toBe(false)
  })

  it('unreachable with no cache is unknown, never nominal', () => {
    const s = classifyWorkspaceHealth({ isLoading: false, isError: true, data: undefined })
    expect(s.phase).toBe('unknown')
    expect(isNominal(s)).toBe(false)
  })

  it('stale (errored but cached) is live+stale and never nominal', () => {
    const s = classifyWorkspaceHealth({ isLoading: false, isError: true, data: health() })
    expect(s.phase).toBe('live')
    expect(s.stale).toBe(true)
    expect(isNominal(s)).toBe(false)
  })

  it('missing Watchdog is never nominal even with zero alerts', () => {
    const s = classifyWorkspaceHealth({ isLoading: false, isError: false, data: health({ watchdog_firing: false }) })
    expect(s.verified).toBe(false)
    expect(isNominal(s)).toBe(false)
  })

  it('problems present → hasProblems, not nominal', () => {
    const s = classifyWorkspaceHealth({ isLoading: false, isError: false, data: health({ alerts: [alert()] }) })
    expect(s.hasProblems).toBe(true)
    expect(isNominal(s)).toBe(false)
  })
})
