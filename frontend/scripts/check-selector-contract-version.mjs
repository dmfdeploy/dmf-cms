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
import { decideVersionBump, parseLock } from '../src/lib/selectorContractVersion.mjs'

const LOCK_PATH = 'frontend/src/lib/selectorContract.lock.json'

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
