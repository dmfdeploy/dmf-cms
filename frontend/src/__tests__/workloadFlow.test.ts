import { describe, expect, it } from 'vitest'
import {
  FLOW_STEPS,
  classifyDraftFlow,
  classifyWorkloadFlow,
  isStepOpenable,
  lifecycleBadge,
  type FlowStepId,
} from '../lib/workloadFlow'
import { stageActions, type WorkloadLifecycle, type WorkloadLifecycleInput } from '../lib/workloadLifecycle'

/**
 * Tests for the "only then" gate (umbrella #285, operator direction
 * 2026-08-01). Two of these are PROPERTIES over the whole input space
 * rather than examples, because the risk the gate introduces is not a wrong
 * label on one screen — it is that locking a step silently swallows a
 * control the operator needs. An example test proves one case; the property
 * proves the class.
 */

/** Every input combination the classifier can be handed. */
const ALL_INPUTS: WorkloadLifecycleInput[] = (() => {
  const out: WorkloadLifecycleInput[] = []
  const lifecycles: WorkloadLifecycle[] = ['provision', 'configure', 'operate', 'unknown']
  for (const lifecycle of lifecycles)
    for (const launching of [false, true])
      for (const switching of [false, true])
        for (const tearingDown of [false, true])
          for (const hasBootstrappedMembers of [false, true])
            out.push({ lifecycle, launching, switching, tearingDown, hasBootstrappedMembers })
  return out
})()

describe('the "only then" gate', () => {
  it('locks Configure and Finalise while the workload still sits at Provision', () => {
    const { steps, current } = classifyWorkloadFlow({ lifecycle: 'provision' })
    expect(current).toBe('provision')
    expect(steps.design).toBe('complete')
    expect(steps.plan).toBe('complete')
    expect(steps.configure).toBe('locked')
    expect(steps.finalise).toBe('locked')
  })

  it('opens Configure only once the workload is actually there', () => {
    const { steps, current } = classifyWorkloadFlow({ lifecycle: 'configure' })
    expect(current).toBe('configure')
    // Configure is the position AND bears switch-source, so it reads `open`
    // — the affordance outranks the position label by design.
    expect(steps.configure).toBe('open')
    expect(steps.provision).toBe('complete')
    // Finalise bears teardown once the workload is running, so "only then"
    // is satisfied for it too — it is reachable, not locked.
    expect(steps.finalise).toBe('open')
  })

  it('keeps completed steps reviewable, never closed', () => {
    const { steps } = classifyWorkloadFlow({ lifecycle: 'configure' })
    expect(steps.design).toBe('complete')
    expect(isStepOpenable(steps.design)).toBe(true)
    expect(isStepOpenable(steps.plan)).toBe(true)
  })
})

describe('the gate can never hide a control (property, all inputs)', () => {
  it('no locked step ever bears an action', () => {
    const offenders: string[] = []
    for (const input of ALL_INPUTS) {
      const { steps } = classifyWorkloadFlow(input)
      for (const id of FLOW_STEPS) {
        if (steps[id] === 'locked' && stageActions(id, input).length > 0) {
          offenders.push(`${id} locked but action-bearing for ${JSON.stringify(input)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no action-bearing step is ever locked — it is always openable', () => {
    const offenders: string[] = []
    for (const input of ALL_INPUTS) {
      const { steps } = classifyWorkloadFlow(input)
      for (const id of FLOW_STEPS) {
        if (stageActions(id, input).length > 0 && !isStepOpenable(steps[id])) {
          offenders.push(`${id} not openable despite an action for ${JSON.stringify(input)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('an action-bearing step is reported `open`, so availability and affordance cannot drift', () => {
    // The S1 invariant AVAILABLE IFF ACTION-BEARING, restated in the flow's
    // vocabulary. Both directions, over the whole input space.
    for (const input of ALL_INPUTS) {
      const { steps } = classifyWorkloadFlow(input)
      for (const id of FLOW_STEPS) {
        expect(steps[id] === 'open').toBe(stageActions(id, input).length > 0)
      }
    }
  })
})

describe('the stranded-sibling case survives the restructure (GATE-S1-RV3 P1)', () => {
  it('keeps Provision reachable when a sibling is still bootstrapped and the position has moved on', () => {
    const input: WorkloadLifecycleInput = {
      lifecycle: 'configure',
      hasBootstrappedMembers: true,
    }
    const { steps } = classifyWorkloadFlow(input)
    // Behind the position, so the naive ordering rule would call it
    // `complete` and the UI would collapse it as settled business — while
    // the sibling still needs clearing.
    expect(stageActions('provision', input)).toContain('clear-for-deployment')
    expect(steps.provision).toBe('open')
    expect(isStepOpenable(steps.provision)).toBe(true)
  })

  it('reports Provision as merely complete once nothing is left to clear', () => {
    const { steps } = classifyWorkloadFlow({
      lifecycle: 'configure',
      hasBootstrappedMembers: false,
    })
    expect(steps.provision).toBe('complete')
  })
})

describe('busy and unknown suppressions reach every step', () => {
  it('a job in flight leaves no step bearing an action, clear included', () => {
    for (const job of ['launching', 'switching', 'tearingDown'] as const) {
      const input: WorkloadLifecycleInput = {
        lifecycle: 'configure',
        hasBootstrappedMembers: true,
        [job]: true,
      }
      const { steps } = classifyWorkloadFlow(input)
      for (const id of FLOW_STEPS) {
        expect(steps[id]).not.toBe('open')
      }
      // Specifically the clear path, which is the one keyed to member state
      // rather than position and so is easiest to leave un-suppressed.
      expect(stageActions('provision', input)).toEqual([])
    }
  })

  it('an undetermined position offers nothing and claims no current step', () => {
    const { steps, current, undetermined, offFlow } = classifyWorkloadFlow({
      lifecycle: 'unknown',
      hasBootstrappedMembers: true,
    })
    expect(current).toBeNull()
    expect(undetermined).toBe(true)
    expect(offFlow).toBe(false)
    // No step is action-bearing, so none is open — that is the suppression.
    for (const id of FLOW_STEPS) expect(steps[id]).not.toBe('open')
    // The three steps that describe a RUNNING thing lock: with no readable
    // position there is nothing true to say about runtime.
    for (const id of ['provision', 'configure', 'finalise'] as const) {
      expect(steps[id]).toBe('locked')
    }
  })

  it('keeps the record steps readable on an undetermined position, without claiming completion', () => {
    // Design and Plan describe CHOICES, not runtime. S1 kept them readable
    // on an unplaceable workload on purpose, and the flow must not quietly
    // regress that into a lock: locking them hides truth the console holds.
    // They are `record`, NOT `complete` — the latter would assert the
    // workload got past them, which is exactly what is unknown here.
    const { steps } = classifyWorkloadFlow({ lifecycle: 'unknown' })
    expect(steps.design).toBe('record')
    expect(steps.plan).toBe('record')
    expect(isStepOpenable(steps.design)).toBe(true)
    expect(isStepOpenable(steps.plan)).toBe(true)
  })

  it('never reports `record` once the position is readable', () => {
    // `record` exists only to survive an unreadable position. Anywhere else
    // it would be a third way of saying "behind the workload", competing
    // with `complete` for the same meaning.
    for (const input of ALL_INPUTS.filter((i) => i.lifecycle !== 'unknown')) {
      const { steps } = classifyWorkloadFlow(input)
      for (const id of FLOW_STEPS) expect(steps[id]).not.toBe('record')
    }
  })
})

describe('Operate is off the flow, not lost from it', () => {
  it('reports offFlow with every orchestration step behind it complete', () => {
    const { steps, current, offFlow, undetermined } = classifyWorkloadFlow({
      lifecycle: 'operate',
    })
    expect(current).toBeNull()
    expect(offFlow).toBe(true)
    expect(undetermined).toBe(false)
    expect(steps.design).toBe('complete')
    expect(steps.plan).toBe('complete')
    expect(steps.provision).toBe('complete')
    // Configure and Finalise both bear actions on a running workload.
    expect(steps.configure).toBe('open')
    expect(steps.finalise).toBe('open')
  })

  it('distinguishes off-flow from undetermined, which both report current=null', () => {
    const operating = classifyWorkloadFlow({ lifecycle: 'operate' })
    const undetermined = classifyWorkloadFlow({ lifecycle: 'unknown' })
    expect(operating.current).toBeNull()
    expect(undetermined.current).toBeNull()
    // The page says two different things; the flags are what let it.
    expect(operating.offFlow).not.toBe(undetermined.offFlow)
    expect(operating.undetermined).not.toBe(undetermined.undetermined)
  })

  it('never includes Operate as a flow step', () => {
    expect(FLOW_STEPS).not.toContain('operate' as FlowStepId)
    expect(FLOW_STEPS).toEqual(['design', 'plan', 'provision', 'configure', 'finalise'])
  })
})

describe('lifecycle badge grammar (umbrella #285 addendum)', () => {
  it('names the completed transition at rest, never the stage not yet reached', () => {
    expect(lifecycleBadge({ lifecycle: 'provision' })).toEqual({
      label: 'planned',
      grammar: 'resting',
    })
    expect(lifecycleBadge({ lifecycle: 'configure' })).toEqual({
      label: 'provisioned',
      grammar: 'resting',
    })
    expect(lifecycleBadge({ lifecycle: 'operate' })).toEqual({
      label: 'configured',
      grammar: 'resting',
    })
  })

  it('a workload waiting to deploy is never labelled provisioned', () => {
    // The whole point of the resting mapping: position `provision` means
    // the deploy has NOT run.
    expect(lifecycleBadge({ lifecycle: 'provision' }).label).not.toBe('provisioned')
  })

  it('uses the progressive form for the stage whose job is running', () => {
    expect(lifecycleBadge({ lifecycle: 'provision', launching: true })).toEqual({
      label: 'provisioning',
      grammar: 'in-flight',
    })
    expect(lifecycleBadge({ lifecycle: 'configure', switching: true })).toEqual({
      label: 'configuring',
      grammar: 'in-flight',
    })
    expect(lifecycleBadge({ lifecycle: 'operate', tearingDown: true })).toEqual({
      label: 'finalizing',
      grammar: 'in-flight',
    })
  })

  it('follows the same job precedence as the flow, so the two cannot disagree', () => {
    // Teardown outranks switch outranks a provision write.
    const badge = lifecycleBadge({
      lifecycle: 'configure',
      launching: true,
      switching: true,
      tearingDown: true,
    })
    expect(badge.label).toBe('finalizing')
  })

  it('keeps unknown honest rather than inventing a participle', () => {
    expect(lifecycleBadge({ lifecycle: 'unknown' })).toEqual({
      label: 'unknown',
      grammar: 'unknown',
    })
    // A job flag DOES override it, and that is deliberate rather than an
    // escape from the honesty rule: the console cannot place the workload,
    // but it does know first-hand that it launched a provision job from
    // this tab. Naming the job it started is not a claim about position, so
    // the badge conjugates the job's stage. Same precedence the flow uses,
    // which is why the two can never name different things.
    expect(lifecycleBadge({ lifecycle: 'unknown', launching: true })).toEqual({
      label: 'provisioning',
      grammar: 'in-flight',
    })
  })

  it('never renders a progressive form without a job in flight', () => {
    const progressives = ['provisioning', 'configuring', 'finalizing']
    for (const input of ALL_INPUTS) {
      const { label } = lifecycleBadge(input)
      if (progressives.includes(label)) {
        expect(Boolean(input.launching || input.switching || input.tearingDown)).toBe(true)
      }
    }
  })
})

describe('the draft flow', () => {
  it('starts at Design with everything after it locked', () => {
    const { steps, current } = classifyDraftFlow({
      hasName: false,
      hasTemplate: false,
      hasFacility: false,
      facilityConfirmed: false,
    })
    expect(current).toBe('design')
    expect(steps.design).toBe('current')
    expect(steps.plan).toBe('locked')
    expect(steps.provision).toBe('locked')
  })

  it('will not complete Design on a template alone — the name carries the identity', () => {
    const { steps, current } = classifyDraftFlow({
      hasName: false,
      hasTemplate: true,
      hasFacility: true,
      facilityConfirmed: true,
    })
    expect(current).toBe('design')
    expect(steps.design).toBe('current')
    expect(steps.plan).toBe('locked')
  })

  it('opens Plan only once the workload is named and a template chosen', () => {
    const { steps, current } = classifyDraftFlow({
      hasName: true,
      hasTemplate: true,
      hasFacility: false,
      facilityConfirmed: false,
    })
    expect(current).toBe('plan')
    expect(steps.design).toBe('complete')
    expect(steps.plan).toBe('current')
    expect(steps.provision).toBe('locked')
  })

  // WP-3 spec D — the placement CONFIRMATION gate.
  describe('Provision opens only once the facility is BOTH resolved and confirmed', () => {
    it('stays locked while the facility is resolved but not yet acknowledged', () => {
      const { steps, current } = classifyDraftFlow({
        hasName: true,
        hasTemplate: true,
        hasFacility: true,
        facilityConfirmed: false,
      })
      expect(current).toBe('plan')
      expect(steps.plan).toBe('current')
      expect(steps.provision).toBe('locked')
    })

    it('opens once the operator has confirmed the resolved facility', () => {
      const { steps, current } = classifyDraftFlow({
        hasName: true,
        hasTemplate: true,
        hasFacility: true,
        facilityConfirmed: true,
      })
      expect(current).toBe('provision')
      expect(steps.plan).toBe('complete')
      expect(steps.provision).toBe('current')
    })

    // GATE ONLY IN THE EXACTLY-ONE-FACILITY CASE: a stray facilityConfirmed
    // must never fake a facility that was never actually resolved — the
    // zero/multiple-facility honest non-answers stay exactly as they were,
    // ungated, regardless of what this flag happens to hold.
    it('a stray facilityConfirmed cannot open Provision with zero facilities resolved', () => {
      const { steps, current } = classifyDraftFlow({
        hasName: true,
        hasTemplate: true,
        hasFacility: false,
        facilityConfirmed: true,
      })
      expect(current).toBe('plan')
      expect(steps.plan).toBe('current')
      expect(steps.provision).toBe('locked')
    })

    it('a stray facilityConfirmed cannot open Provision with more than one facility resolved', () => {
      // hasFacility is already false in this case (PlanAssignment's own
      // "N facilities registered" branch never resolves it to true) — this
      // pins that classifyDraftFlow agrees, not a second source of truth.
      const { steps, current } = classifyDraftFlow({
        hasName: true,
        hasTemplate: true,
        hasFacility: false,
        facilityConfirmed: true,
      })
      expect(current).toBe('plan')
      expect(steps.provision).toBe('locked')
    })
  })

  it('keeps Configure and Finalise locked throughout — nothing runs yet', () => {
    for (const draft of [
      { hasName: false, hasTemplate: false, hasFacility: false, facilityConfirmed: false },
      { hasName: true, hasTemplate: true, hasFacility: true, facilityConfirmed: true },
    ]) {
      const { steps } = classifyDraftFlow(draft)
      expect(steps.configure).toBe('locked')
      expect(steps.finalise).toBe('locked')
    }
  })
})
