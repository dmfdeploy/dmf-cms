/**
 * The decision logic of scripts/check-selector-contract-version.mjs, which CI
 * runs on pull requests against the base branch's lock (umbrella #741).
 */
import { describe, expect, it } from 'vitest'
import { decideVersionBump, parseLock } from '../lib/selectorContractVersion.mjs'

const base = { version: 1, digest: 'aaa' }

describe('decideVersionBump', () => {
  it('passes when nothing changed', () => {
    expect(decideVersionBump(base, { version: 1, digest: 'aaa' })).toBeNull()
  })

  it('passes when the digest changed and the version went up', () => {
    expect(decideVersionBump(base, { version: 2, digest: 'bbb' })).toBeNull()
  })

  it('fails when the digest changed and the version did not', () => {
    expect(decideVersionBump(base, { version: 1, digest: 'bbb' })).toMatch(/Bump SELECTOR_CONTRACT_VERSION/)
  })

  it('fails when the version went up and the digest did not', () => {
    expect(decideVersionBump(base, { version: 2, digest: 'aaa' })).toMatch(/digest did not change/)
  })

  it('fails when the version went down', () => {
    expect(decideVersionBump({ version: 2, digest: 'aaa' }, { version: 1, digest: 'bbb' })).toMatch(
      /Bump SELECTOR_CONTRACT_VERSION/,
    )
  })

  it('passes when the base has no lock', () => {
    expect(decideVersionBump(null, { version: 1, digest: 'aaa' })).toBeNull()
  })
})

describe('parseLock', () => {
  it('reads a valid lock', () => {
    expect(parseLock('{"version": 2, "digest": "abc"}')).toEqual({ version: 2, digest: 'abc' })
  })

  it('rejects text that is not JSON', () => {
    expect(parseLock('<<<<<<< HEAD')).toBeNull()
  })

  it('rejects a lock without a version or a digest', () => {
    expect(parseLock('{"digest": "abc"}')).toBeNull()
    expect(parseLock('{"version": 2}')).toBeNull()
    expect(parseLock('{"version": "2", "digest": "abc"}')).toBeNull()
    expect(parseLock('{"version": 2, "digest": ""}')).toBeNull()
    expect(parseLock('null')).toBeNull()
  })
})
