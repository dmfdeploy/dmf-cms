/**
 * Operator-language label helpers (UX Constitution Art. 3/8). Pure mapping
 * from machine strings (alert rule names, AWX template names, key=value
 * label blobs) to readable default-level text, with a humanising fallback.
 */
import { describe, expect, it } from 'vitest'
import {
  humanizeAlertName,
  humanizeContext,
  describeJob,
  jobOutcome,
  humaniseIdentifier,
} from '../lib/labels'

describe('humanizeAlertName', () => {
  it('maps known rules to plain titles', () => {
    expect(humanizeAlertName('ContainerCPUThrottling')).toBe('Container CPU throttling')
    expect(humanizeAlertName('PodCrashLooping')).toBe('Pods restarting repeatedly')
    expect(humanizeAlertName('NodeDown')).toBe('Node down')
  })
  it('humanises unmapped CamelCase rule names', () => {
    expect(humanizeAlertName('SomeNewAlertRule')).toBe('Some new alert rule')
  })
  it('never returns empty', () => {
    expect(humanizeAlertName('')).toBe('Condition')
  })
})

describe('humanizeContext', () => {
  it('drops key=value jargon, keeps disambiguating values', () => {
    expect(humanizeContext('namespace=mxl pod=a')).toBe('mxl · pod a')
    expect(humanizeContext('namespace=nmos pod=b')).toBe('nmos · pod b')
  })
  it('keeps non-namespace/instance keys as readable pairs', () => {
    expect(humanizeContext('container=writer')).toBe('container writer')
  })
  it('returns empty for empty input', () => {
    expect(humanizeContext('')).toBe('')
  })
})

describe('describeJob', () => {
  // umbrella #432 §F fix-round 3 (codex gate): describeJob's second argument
  // is the ALREADY-COMPUTED jobOutcome() word, not a raw AWX status — every
  // call below runs it through jobOutcome() first, exactly like both real
  // callers (RecentChanges.tsx, HistoryLane.tsx) now do, computing it once
  // and handing the same value to both the title and the badge.
  it('turns a genuinely finished launcher run into a past-tense title', () => {
    expect(describeJob('media-launch-mxl-videotestsrc', jobOutcome('successful'))).toBe('Deployed MXL Test-Pattern Source')
    expect(describeJob('media-launch-mxl-videotest-view', jobOutcome('successful'))).toBe('Deployed MXL Test-Pattern Viewer')
    expect(describeJob('media-finalise-mxl-videotestsrc', jobOutcome('successful'))).toBe('Removed MXL Test-Pattern Source')
    expect(describeJob('media-launch-nmos-crosspoint', jobOutcome('successful'))).toBe('Deployed NMOS Crosspoint')
  })

  // umbrella #432 §F: the defect a live operator walk measured. A row read
  // "Removed MXL Test-Pattern Viewer … Running" — past tense asserting a
  // destructive action as already complete while the badge (from the SAME
  // status) said it was still in progress. This is the exact contradiction
  // this fix exists to make structurally impossible.
  it('uses present-progressive, never past tense, while the job is still running', () => {
    expect(describeJob('media-launch-mxl-videotest-view', jobOutcome('running'))).toBe('Deploying MXL Test-Pattern Viewer')
    expect(describeJob('media-finalise-mxl-videotest-view', jobOutcome('running'))).toBe('Removing MXL Test-Pattern Viewer')
    expect(describeJob('media-finalise-mxl-videotest-view', jobOutcome('running'))).not.toMatch(/^Removed/)
  })

  it('uses a failure form, not past tense, when the run failed', () => {
    expect(describeJob('media-launch-mxl-videotestsrc', jobOutcome('failed'))).toBe('Failed to deploy MXL Test-Pattern Source')
    expect(describeJob('media-finalise-mxl-videotestsrc', jobOutcome('error'))).toBe('Failed to remove MXL Test-Pattern Source')
  })

  it('uses a queued form, not past tense, before the job has started', () => {
    expect(describeJob('media-launch-mxl-videotestsrc', jobOutcome('pending'))).toBe('Queued to deploy MXL Test-Pattern Source')
    expect(describeJob('media-finalise-mxl-videotestsrc', jobOutcome('new'))).toBe('Queued to remove MXL Test-Pattern Source')
  })

  it('uses a cancellation form, not past tense, when canceled', () => {
    expect(describeJob('media-launch-mxl-videotestsrc', jobOutcome('canceled'))).toBe('Canceled deploying MXL Test-Pattern Source')
  })

  it('derives tense from the exact same outcome word the badge renders', () => {
    // Not a claim about the implementation, a claim about behaviour: for
    // every status jobOutcome() maps to "Running", describeJob must use the
    // progressive form, and for every status it maps to "Succeeded" it must
    // use the past form — because both read the same jobOutcome() call.
    for (const status of ['running']) {
      const outcome = jobOutcome(status)
      expect(outcome).toBe('Running')
      expect(describeJob('media-launch-mxl-videotestsrc', outcome)).toMatch(/^Deploying/)
    }
    for (const status of ['successful']) {
      const outcome = jobOutcome(status)
      expect(outcome).toBe('Succeeded')
      expect(describeJob('media-launch-mxl-videotestsrc', outcome)).toMatch(/^Deployed/)
    }
  })

  // umbrella #432 §F fix-round 3 (codex gate): describeJob used to take the
  // raw status and call jobOutcome() a SECOND time internally, independent
  // of whatever the caller had already computed for the badge. That always
  // agreed for jobOutcome's 5 named outcomes (same pure function, same
  // input) — but jobOutcome() also answers 'Unknown' for an empty status
  // (src/dmf_cms/main.py defaults a missing AWX status to '' — reachable,
  // not hypothetical), and describeJob's old fallback
  // (`?? ACTION_VERBS[action].Queued`) discarded that in favour of a
  // hardcoded, WRONG, specific tense: title "Queued to remove X", badge
  // "Unknown", same job. The fallback now echoes the SAME outcome word
  // instead of guessing one, so the two text sites can't diverge — this
  // pins that behaviour directly, and is a genuine regression test: it
  // fails against the previously-committed describeJob (see the PR report
  // for the swapped-file verification).
  it('echoes the exact outcome word instead of guessing a tense when the status is empty', () => {
    const outcome = jobOutcome('') // 'Unknown' — the backend's own default for a missing status
    expect(outcome).toBe('Unknown')
    expect(describeJob('media-finalise-mxl-videotest-view', outcome)).toBe('Unknown — MXL Test-Pattern Viewer')
    // The old bug, pinned as a negative: never a specific tense claim for a
    // status we don't actually know.
    expect(describeJob('media-finalise-mxl-videotest-view', outcome)).not.toMatch(/^Queued/)
  })

  it('echoes the exact outcome word instead of guessing a tense for a genuinely unrecognised status', () => {
    const outcome = jobOutcome('some_new_state')
    expect(outcome).toBe('Some new state')
    expect(describeJob('media-launch-mxl-videotestsrc', outcome)).toBe('Some new state — MXL Test-Pattern Source')
    expect(describeJob('media-launch-mxl-videotestsrc', outcome)).not.toMatch(/^Queued/)
  })

  it('humanises internal/spike templates without a verb, regardless of status', () => {
    expect(describeJob('eso-openbao-health-check', jobOutcome('successful'))).toBe('ESO openbao health check')
    expect(describeJob('eso-openbao-health-check', jobOutcome('running'))).toBe('ESO openbao health check')
  })

  it('never returns empty', () => {
    expect(describeJob('', jobOutcome('successful'))).toBe('Change')
  })
})

describe('jobOutcome', () => {
  it('maps AWX status to plain words', () => {
    expect(jobOutcome('successful')).toBe('Succeeded')
    expect(jobOutcome('failed')).toBe('Failed')
    expect(jobOutcome('error')).toBe('Failed')
    expect(jobOutcome('running')).toBe('Running')
    expect(jobOutcome('canceled')).toBe('Canceled')
  })
  it('humanises unknown status', () => {
    expect(jobOutcome('some_new_state')).toBe('Some new state')
  })
})

describe('humaniseIdentifier', () => {
  it('splits camel/kebab/snake and keeps known acronyms upper', () => {
    expect(humaniseIdentifier('mxl-videotest-view')).toBe('MXL videotest view')
    expect(humaniseIdentifier('cpu_load_high')).toBe('CPU load high')
  })
})
