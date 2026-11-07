import type { InstanceTopology } from '../api/types'

/**
 * True when `topology.sources` is an array whose every entry is an object
 * with a string `id`. Anything else is malformed: reading `s.id` on a `null`
 * entry throws, and an id-less entry would be shown or offered as a source
 * with no id, so a consumer treats the whole payload as unknown instead.
 */
export function hasValidSources(topology: InstanceTopology | null | undefined): topology is InstanceTopology {
  const sources: unknown = topology?.sources
  return (
    Array.isArray(sources) &&
    sources.every(
      (s) => typeof s === 'object' && s !== null && typeof (s as { id?: unknown }).id === 'string',
    )
  )
}
