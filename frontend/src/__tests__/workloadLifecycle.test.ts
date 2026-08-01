/**
 * The media-workload lifecycle rail state machine (umbrella #285 S1).
 *
 * Two load-bearing groups here:
 *   - AVAILABLE IFF ACTION-BEARING — the machine-checkable form of the
 *     rail's "no dead controls" principle: a stage may only present itself
 *     as available if it actually carries something the operator can do.
 *   - single-source-of-position — the rail's active stage must be the
 *     backend's derived lifecycle (ADR-0046 §3), never a second opinion,
 *     so the rail can never contradict the workload badge beside it.
 */
import { describe, expect, it } from 'vitest'
import {
  STAGES,
  classifyWorkloadLifecycle,
  stageActions,
  type StageId,
  type WorkloadLifecycle,
  type WorkloadLifecycleInput,
} from '../lib/workloadLifecycle'

const LIFECYCLES: WorkloadLifecycle[] = ['provision', 'configure', 'operate', 'unknown']

/**
 * Every reachable observation: 4 lifecycles x 3 job flags x the member-state
 * fact, exhaustively — 64 combinations.
 *
 * hasBootstrappedMembers belongs in here because it is part of the input
 * type: leaving it out meant the invariant loop below never exercised the
 * clear affordance at all, while the comment claimed exhaustiveness. The
 * claim is fixed by making it TRUE rather than by narrowing the wording.
 */
const ALL_INPUTS: WorkloadLifecycleInput[] = LIFECYCLES.flatMap((lifecycle) =>
  [false, true].flatMap((launching) =>
    [false, true].flatMap((switching) =>
      [false, true].flatMap((tearingDown) =>
        [false, true].map((hasBootstrappedMembers) => ({
          lifecycle,
          launching,
          switching,
          tearingDown,
          hasBootstrappedMembers,
        })),
      ),
    ),
  ),
)

function describeInput(i: WorkloadLifecycleInput): string {
  return JSON.stringify(i)
}

describe('STAGES', () => {
  it('is the six EBU stages, verbatim and in lifecycle order', () => {
    expect(STAGES.map((s) => s.id)).toEqual([
      'design', 'plan', 'provision', 'configure', 'operate', 'finalise',
    ])
    // Verbatim from DMF EBU Mapping (2026-04-25). The rail is the pedagogy:
    // a re-worded or dropped stage teaches a wrong model.
    expect(STAGES.map((s) => s.label)).toEqual([
      'Design', 'Plan', 'Provision', 'Configure', 'Operate', 'Finalise & Review',
    ])
  })
})

describe('active stage is the backend lifecycle, not a second opinion', () => {
  it('maps each backend lifecycle 1:1 onto its stage when idle', () => {
    expect(classifyWorkloadLifecycle({ lifecycle: 'provision' }).active).toBe('provision')
    expect(classifyWorkloadLifecycle({ lifecycle: 'configure' }).active).toBe('configure')
    expect(classifyWorkloadLifecycle({ lifecycle: 'operate' }).active).toBe('operate')
  })

  it('refuses to place the workload at all when the backend says unknown', () => {
    // Art. 1: a rail that invents a position is worse than one admitting it
    // cannot read the workload. The backend never guesses here; nor do we.
    const s = classifyWorkloadLifecycle({ lifecycle: 'unknown' })
    expect(s.active).toBeNull()
    expect(Object.values(s.states)).not.toContain('active')
  })

  it('teardown in flight wins over everything', () => {
    const s = classifyWorkloadLifecycle({
      lifecycle: 'operate', launching: true, switching: true, tearingDown: true,
    })
    expect(s.active).toBe('finalise')
  })

  it('a running switch is Configure', () => {
    expect(classifyWorkloadLifecycle({ lifecycle: 'operate', switching: true }).active)
      .toBe('configure')
  })

  it('a running launch is Provision', () => {
    expect(classifyWorkloadLifecycle({ lifecycle: 'provision', launching: true }).active)
      .toBe('provision')
  })

  it('an in-flight job places the workload even when the backend cannot', () => {
    // A running job is observed truth about NOW; it outranks a non-answer.
    expect(classifyWorkloadLifecycle({ lifecycle: 'unknown', tearingDown: true }).active)
      .toBe('finalise')
  })

  it('never reaches Finalise from absence — only from an observed teardown', () => {
    // The backend explicitly never infers Finalise; neither may the rail.
    for (const input of ALL_INPUTS.filter((i) => !i.tearingDown)) {
      expect(classifyWorkloadLifecycle(input).active, describeInput(input))
        .not.toBe('finalise')
    }
  })

  it('marks at most one stage active, in every observable state', () => {
    for (const input of ALL_INPUTS) {
      const { active, states } = classifyWorkloadLifecycle(input)
      const activeStages = STAGES.filter((s) => states[s.id] === 'active')
      expect(activeStages.map((s) => s.id), describeInput(input))
        .toEqual(active ? [active] : [])
    }
  })
})

describe('stage states', () => {
  it('Design and Plan are always informational — never not-applicable', () => {
    // The chosen template and the assigned facility are facts even before
    // anything runs.
    for (const input of ALL_INPUTS) {
      const { states } = classifyWorkloadLifecycle(input)
      expect(states.design, describeInput(input)).toBe('informational')
      expect(states.plan, describeInput(input)).toBe('informational')
    }
  })

  it('Operate is informational while running, not-applicable before', () => {
    // Operate carries no action by design, so it is never "available" — its
    // truth is read-only: running state, and the pointer to Problems.
    expect(classifyWorkloadLifecycle({ lifecycle: 'configure' }).states.operate)
      .toBe('informational')
    expect(classifyWorkloadLifecycle({ lifecycle: 'provision' }).states.operate)
      .toBe('not-applicable')
  })

  it('Provision degrades to informational once the workload runs', () => {
    expect(classifyWorkloadLifecycle({ lifecycle: 'operate' }).states.provision)
      .toBe('informational')
  })

  it('post-Provision stages are not-applicable before anything runs', () => {
    const { states } = classifyWorkloadLifecycle({ lifecycle: 'provision' })
    expect(states.configure).toBe('not-applicable')
    expect(states.operate).toBe('not-applicable')
    expect(states.finalise).toBe('not-applicable')
  })

  it('never invents a seventh position for a failed job', () => {
    // Outcome is not position: a failure renders inside the stage that ran
    // the job. There is deliberately no input flag that could move the rail.
    for (const input of ALL_INPUTS) {
      const { states } = classifyWorkloadLifecycle(input)
      expect(Object.keys(states).sort(), describeInput(input))
        .toEqual(STAGES.map((s) => s.id).sort())
    }
  })
})

describe('AVAILABLE IFF ACTION-BEARING', () => {
  it('holds for every non-active stage in every observable state', () => {
    for (const input of ALL_INPUTS) {
      const { states } = classifyWorkloadLifecycle(input)
      for (const stage of STAGES) {
        if (states[stage.id] === 'active') continue // position, not affordance
        const bearing = stageActions(stage.id, input).length > 0
        expect(states[stage.id] === 'available', `${stage.id} @ ${describeInput(input)}`)
          .toBe(bearing)
      }
    }
  })

  it('offers no action anywhere while a job is in flight', () => {
    // The write seam is already gated server-side on observed runtime truth;
    // a control offered mid-job would be dead on arrival.
    for (const input of ALL_INPUTS.filter((i) => i.launching || i.switching || i.tearingDown)) {
      for (const stage of STAGES) {
        expect(stageActions(stage.id, input), `${stage.id} @ ${describeInput(input)}`).toEqual([])
      }
    }
  })

  it('offers no action anywhere when the workload state is unknown', () => {
    // Fail closed: if the console cannot read where the workload is, it has
    // no business offering to change it.
    for (const input of ALL_INPUTS.filter((i) => i.lifecycle === 'unknown')) {
      for (const stage of STAGES) {
        expect(stageActions(stage.id, input), `${stage.id} @ ${describeInput(input)}`).toEqual([])
      }
    }
  })

  it('Design, Plan and Operate never bear an action', () => {
    const readOnly: StageId[] = ['design', 'plan', 'operate']
    for (const input of ALL_INPUTS) {
      for (const id of readOnly) {
        expect(stageActions(id, input), `${id} @ ${describeInput(input)}`).toEqual([])
      }
    }
  })

  it('names the console write seams the rail actually exposes', () => {
    // Clear is keyed to MEMBER STATE, deploy to POSITION.
    expect(stageActions('provision', { lifecycle: 'provision' })).toEqual(['deploy'])
    expect(stageActions('provision', { lifecycle: 'provision', hasBootstrappedMembers: true }))
      .toEqual(['deploy', 'clear-for-deployment'])
    expect(stageActions('configure', { lifecycle: 'operate' })).toEqual(['switch-source'])
    expect(stageActions('finalise', { lifecycle: 'operate' })).toEqual(['tear-down'])
    // Deploy is gone the moment there is something to operate — you cannot
    // deploy what is already running.
    expect(stageActions('provision', { lifecycle: 'operate' })).toEqual([])
  })
})

describe('a bootstrapped member always has a reachable clear path', () => {
  it('keeps Provision offering clear after the position moves to configure', () => {
    // GATE-S1-RV3 P1, codex's exact scenario: clearing the first of two
    // siblings flips the backend derivation to configure (any_active wins).
    // Reading the affordance off position alone stranded the second sibling
    // PERMANENTLY — the reachability principle turned on my own placement.
    const afterFirstClear = { lifecycle: 'configure' as const, hasBootstrappedMembers: true }
    expect(stageActions('provision', afterFirstClear)).toEqual(['clear-for-deployment'])

    const { active, states } = classifyWorkloadLifecycle(afterFirstClear)
    // Position is still the backend's truth...
    expect(active).toBe('configure')
    // ...and Provision is available-not-active, which is exactly what
    // available means: it bears an action without being where we are.
    expect(states.provision).toBe('available')
  })

  it('withdraws it once no member is bootstrapped', () => {
    // The discriminator: an affordance that never withdraws is not gated.
    expect(stageActions('provision', { lifecycle: 'configure' })).toEqual([])
    expect(classifyWorkloadLifecycle({ lifecycle: 'configure' }).states.provision)
      .toBe('informational')
  })

  it('still suppresses it while a job is in flight and on unknown', () => {
    expect(stageActions('provision', {
      lifecycle: 'configure', hasBootstrappedMembers: true, switching: true,
    })).toEqual([])
    expect(stageActions('provision', {
      lifecycle: 'unknown', hasBootstrappedMembers: true,
    })).toEqual([])
  })
})
