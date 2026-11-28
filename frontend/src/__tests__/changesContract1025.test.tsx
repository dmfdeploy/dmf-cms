/**
 * Case list: docs/changes-forgejo-cases.md. Row ids in test names refer to it.
 *
 * Component layer (C) for dmfdeploy/dmfdeploy#1025.
 *
 * Renders the History lane from the same JSON fixture the backend tests assert
 * against (frontend/src/__tests__/fixtures/changes-contract-1025.json), then checks that each
 * panel shows exactly the lane of the row: notices first, in the
 * the case list's order, then the rows. Each test id is a row id of the case list.
 *
 * The fixture is the only link between the two layers. A drift in either one
 * fails its own side.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import contract from './fixtures/changes-contract-1025.json'
import {
  expectedLane,
  laneOf,
  renderLane,
  rowCountOf,
  settled,
  type Kind,
} from './changesLaneKit'

interface PanelRow {
  response: Record<string, unknown>
  lane: string[]
}
interface ContractRow {
  layers: string
  pulls?: PanelRow
  commits?: PanelRow
}

const rows = contract as unknown as Record<string, ContractRow>
const EMPTY = {
  commits: { repos: [], reason: '' },
  pulls: { pulls: [], reason: '' },
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

for (const kind of ['pulls', 'commits'] as Kind[]) {
  const ids = Object.keys(rows).filter((id) => rows[id].layers.includes('C') && rows[id][kind])
  describe(`${kind} panel renders the lane of each case`, () => {
    it.each(ids)('%s', async (id) => {
      const row = rows[id][kind] as PanelRow
      const other: Kind = kind === 'pulls' ? 'commits' : 'pulls'
      renderLane({ [kind]: row.response, [other]: EMPTY[other] } as never)
      const panel = await settled(kind)
      expect(laneOf(panel)).toEqual(expectedLane(row.lane, kind, rowCountOf(kind, row.response)))
    })
  })
}

describe('the fixture covers the layers the case list names', () => {
  it('every row that names C has a lane for at least one panel', () => {
    const missing = Object.entries(rows)
      .filter(([, r]) => r.layers.includes('C') && !r.pulls && !r.commits)
      .map(([id]) => id)
    expect(missing).toEqual([])
  })
})
