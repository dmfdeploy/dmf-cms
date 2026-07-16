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
  it('turns launcher templates into "what changed" titles', () => {
    expect(describeJob('media-launch-mxl-videotestsrc')).toBe('Deployed MXL Test-Pattern Source')
    expect(describeJob('media-launch-mxl-videotest-view')).toBe('Deployed MXL Test-Pattern Viewer')
    expect(describeJob('media-finalise-mxl-videotestsrc')).toBe('Removed MXL Test-Pattern Source')
    expect(describeJob('media-launch-nmos-crosspoint')).toBe('Deployed NMOS Crosspoint')
  })
  it('humanises internal/spike templates without a verb', () => {
    expect(describeJob('eso-openbao-health-check')).toBe('ESO openbao health check')
  })
  it('never returns empty', () => {
    expect(describeJob('')).toBe('Change')
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
