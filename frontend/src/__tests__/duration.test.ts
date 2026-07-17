/**
 * formatDuration (dmfdeploy/dmfdeploy#243 follow-up: "Duration on problem
 * rows", Zabbix Problems model). nowMs is passed explicitly so every case
 * here is deterministic regardless of wall-clock time.
 */
import { describe, expect, it } from 'vitest'
import { formatDuration } from '../lib/duration'

const NOW = Date.parse('2026-07-05T12:00:00Z')

describe('formatDuration', () => {
  it('returns null for an empty active_at', () => {
    expect(formatDuration('', NOW)).toBeNull()
  })

  it('returns null for an unparseable active_at', () => {
    expect(formatDuration('not-a-date', NOW)).toBeNull()
  })

  it('returns null for a future active_at (never render garbage)', () => {
    expect(formatDuration('2026-07-05T12:00:01Z', NOW)).toBeNull()
  })

  it('returns "<1m" for just now and for just under a minute', () => {
    expect(formatDuration('2026-07-05T12:00:00Z', NOW)).toBe('<1m')
    expect(formatDuration('2026-07-05T11:59:01Z', NOW)).toBe('<1m')
  })

  it('renders whole minutes under an hour', () => {
    expect(formatDuration('2026-07-05T11:59:00Z', NOW)).toBe('1m')
    expect(formatDuration('2026-07-05T11:45:00Z', NOW)).toBe('15m')
    expect(formatDuration('2026-07-05T11:01:00Z', NOW)).toBe('59m')
  })

  it('renders hours + minutes at and above the 1h boundary, under a day', () => {
    expect(formatDuration('2026-07-05T11:00:00Z', NOW)).toBe('1h 0m')
    expect(formatDuration('2026-07-05T09:45:30Z', NOW)).toBe('2h 14m')
  })

  it('renders days + hours at and above the 24h boundary', () => {
    expect(formatDuration('2026-07-04T12:00:00Z', NOW)).toBe('1d 0h')
    expect(formatDuration('2026-07-03T10:00:00Z', NOW)).toBe('2d 2h')
    expect(formatDuration('2026-06-01T00:00:00Z', NOW)).toBe('34d 12h')
  })

  it('stays in hours just under the 24h boundary', () => {
    expect(formatDuration('2026-07-04T12:00:01Z', NOW)).toBe('23h 59m')
  })
})
