// Decision logic for the selector contract version check. The CLI in
// scripts/check-selector-contract-version.mjs runs it in CI; it lives under
// src so the unit test and the image build can both reach it.

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
