#!/usr/bin/env node
// Checks that a change to the selector contract bumps its version, by
// comparing the lock in this revision with the lock on the base branch.
// A lock in the same revision cannot prove a bump, so CI runs this script on
// pull requests. See the "Selector contract" section of frontend/README.md.
//
// Usage: node scripts/check-selector-contract-version.mjs [base-ref]
// The base ref defaults to origin/main.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOCK_PATH = 'frontend/src/lib/selectorContract.lock.json'

/**
 * Decides whether the head lock is a valid successor of the base lock.
 * @param {{version: number, digest: string} | null} base null when the base has no lock.
 * @param {{version: number, digest: string}} head
 * @returns {string | null} null when the change is valid, otherwise what to do.
 */
export function decideVersionBump(base, head) {
  if (base === null) return null
  const digestChanged = head.digest !== base.digest
  const bumped = head.version > base.version
  if (digestChanged && !bumped) {
    return (
      `The selector contract changed (digest differs from the base) but SELECTOR_CONTRACT_VERSION is ${head.version}, ` +
      `not greater than the base version ${base.version}. Bump SELECTOR_CONTRACT_VERSION and update the lock.`
    )
  }
  if (!digestChanged && bumped) {
    return (
      `SELECTOR_CONTRACT_VERSION went from ${base.version} to ${head.version} but the contract digest did not change. ` +
      `Revert the version bump, or change the contract.`
    )
  }
  if (head.version < base.version) {
    return `SELECTOR_CONTRACT_VERSION went down, from ${base.version} to ${head.version}. Restore the base version.`
  }
  return null
}

/**
 * Reads a lock file's text.
 * @param {string} text
 * @returns {{version: number, digest: string} | null} null when the text is not a valid lock.
 */
export function parseLock(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !Number.isInteger(value.version) ||
    typeof value.digest !== 'string' ||
    value.digest === ''
  ) {
    return null
  }
  return { version: value.version, digest: value.digest }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function succeeds(args) {
  try {
    git(args)
    return true
  } catch {
    return false
  }
}

function main() {
  const baseRef = process.argv[2] ?? 'origin/main'
  const repoRoot = git(['rev-parse', '--show-toplevel']).trim()
  const head = parseLock(readFileSync(`${repoRoot}/${LOCK_PATH}`, 'utf8'))
  if (head === null) {
    console.error(`${LOCK_PATH} in this revision is not valid JSON with an integer version and a digest.`)
    return 1
  }
  if (!succeeds(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])) {
    console.error(`The base ref ${baseRef} does not resolve to a commit. Fetch it, or pass a ref that exists.`)
    return 1
  }
  if (!succeeds(['cat-file', '-e', `${baseRef}:${LOCK_PATH}`])) {
    console.log(`No lock at ${baseRef}: first introduction, nothing to compare.`)
    return 0
  }
  const base = parseLock(git(['show', `${baseRef}:${LOCK_PATH}`]))
  if (base === null) {
    console.error(`${LOCK_PATH} at ${baseRef} is not valid JSON with an integer version and a digest.`)
    return 1
  }
  const problem = decideVersionBump(base, head)
  if (problem) {
    console.error(problem)
    return 1
  }
  console.log(`Selector contract version ok (base ${base.version}, head ${head.version}).`)
  return 0
}

// Compare real paths so a symlinked invocation still runs the check.
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invoked === realpathSync(fileURLToPath(import.meta.url))) process.exit(main())
