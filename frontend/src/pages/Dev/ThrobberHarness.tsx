import AutomationInProgressNotice, {
  type AutomationRunningReadout,
} from '../../components/AutomationInProgressNotice'

/**
 * dmfdeploy/dmfdeploy#390 (F16, operator ruling) — the throbber inspection
 * harness. Same reason LifecycleRailHarness.tsx exists (see that file's own
 * docstring): 783 jsdom tests prove the component's LOGIC, but jsdom
 * computes no pixels — nobody has actually SEEN this component rendered.
 * DEV-ONLY, reachable only through devHarnessRoute.ts's
 * isThrobberHarnessRoute gate (see that file for how this bypasses App.tsx's
 * normal auth flow, tree-shaken out of a production build the same
 * empirically-verified way the lifecycle-rail harness is).
 *
 * Every specimen renders the REAL AutomationInProgressNotice with real
 * props — never a mocked/simplified stand-in — so what a human sees here is
 * exactly what the two real call sites (WorkloadMaterializing.tsx,
 * FinaliseStage.tsx) would render for the same inputs.
 *
 * "Switchable without editing code" (F16's own words) — same shape as
 * LifecycleRailHarness: every state is listed on one scrollable page rather
 * than gated behind a dropdown/toggle, so a human can walk all of them by
 * scrolling, in well under a minute, exactly as that file already does for
 * the rail.
 */

const TAIL_KNOWN_READOUT: AutomationRunningReadout = { running: 2, total: 3, trustworthy: true }
// G1's own two ways to fail: untrustworthy, or (less commonly reachable in
// real code, since the component guards it, but included here as the OTHER
// half of "count unknown") a trustworthy-but-empty read.
const TAIL_UNTRUSTWORTHY_READOUT: AutomationRunningReadout = { running: 0, total: 0, trustworthy: false }

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString()
}

function secondsAgo(n: number): string {
  return new Date(Date.now() - n * 1_000).toISOString()
}

const PlaceholderChildren = (
  <>
    It shows up on <span className="text-accent">Workspace</span> while it runs, and in{' '}
    <span className="text-accent">Media Workloads</span> once it&apos;s recorded.
  </>
)

interface Specimen {
  id: string
  title: string
  note: string
  props: Parameters<typeof AutomationInProgressNotice>[0]
}

const SPECIMENS: Specimen[] = [
  {
    id: '1-no-marker',
    title: '1 · Provision — no milestone marker has arrived yet',
    note:
      'The degrade path (Art. 1 hard gate): no progressStep means no step line at all — never a blank throbber, ' +
      'never a fabricated one. Spinner + clock + action label + typical-duration are the whole story.',
    props: {
      action: 'Provisioning under way',
      startedAt: secondsAgo(12),
      typicalDuration: 'a few minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '2-deploy-preflight',
    title: '2 · Provision — milestone: preflight-passed',
    note: 'The first deploy token — main.py\'s _L3_MILESTONE_ORDER["deploy"][0].',
    props: {
      action: 'Provisioning under way',
      startedAt: secondsAgo(20),
      progressStep: 'preflight-passed',
      typicalDuration: 'a few minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '3-deploy-provisioning',
    title: '3 · Provision — milestone: provisioning',
    note: 'The middle deploy token.',
    props: {
      action: 'Provisioning under way',
      startedAt: minutesAgo(1),
      progressStep: 'provisioning',
      typicalDuration: 'a few minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '4-deploy-configuring',
    title: '4 · Provision — milestone: configuring (the LAST deploy token — tail begins here)',
    note:
      'WorkloadMaterializing never passes a runningReadout at all (the workload does not exist in NetBox yet at ' +
      'this point in the flow) — G1 satisfied structurally, not by a lucky trustworthy:false. This is what that ' +
      "call site's own tail looks like: frozen step phrase, no count, for the whole remainder of the run.",
    props: {
      action: 'Provisioning under way',
      startedAt: minutesAgo(2),
      progressStep: 'configuring',
      typicalDuration: 'a few minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '5-teardown-preflight',
    title: '5 · Finalise — milestone: preflight-passed',
    note: 'The first teardown token — different vocabulary AND different typical-duration prose from deploy.',
    props: {
      action: 'Tearing down',
      startedAt: secondsAgo(15),
      progressStep: 'preflight-passed',
      typicalDuration: 'two to three minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '6-teardown-tearingdown',
    title: '6 · Finalise — milestone: tearing-down',
    note: 'The middle teardown token.',
    props: {
      action: 'Tearing down',
      startedAt: secondsAgo(45),
      progressStep: 'tearing-down',
      typicalDuration: 'two to three minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '7-tail-known',
    title: '7 · Finalise — tail, milestone: finalising, running count KNOWN',
    note:
      'The last teardown token, with a trustworthy non-empty runningReadout supplied — the count takes over ' +
      'from the step phrase ("Finalising cleanup" does NOT render here; "2 of 3 services running, as of the ' +
      'last check." does). Compare directly against specimen 8.',
    props: {
      action: 'Tearing down',
      startedAt: minutesAgo(2),
      progressStep: 'finalising',
      typicalDuration: 'two to three minutes',
      runningReadout: TAIL_KNOWN_READOUT,
      children: PlaceholderChildren,
    },
  },
  {
    id: '8-tail-unknown',
    title: '8 · Finalise — tail, milestone: finalising, running count UNKNOWN (G1)',
    note:
      'THE STATE MOST LIKELY TO BE WRONG (operator\'s own words). Same progressStep as specimen 7, but the ' +
      'supplied runningReadout is untrustworthy — G1 requires NO COUNT AT ALL here, never "0 of 0". Confirm ' +
      'this row reads "Finalising cleanup", never a zero, never a blank line where the count would be.',
    props: {
      action: 'Tearing down',
      startedAt: minutesAgo(2),
      progressStep: 'finalising',
      typicalDuration: 'two to three minutes',
      runningReadout: TAIL_UNTRUSTWORTHY_READOUT,
      children: PlaceholderChildren,
    },
  },
  {
    id: '9-reduced-motion',
    title: '9 · prefers-reduced-motion — spinner dead, clock still ticking',
    note:
      'jsdom cannot emulate a real OS/browser accessibility preference — VERIFY THIS ROW FOR REAL: open your ' +
      'OS accessibility settings (or Chrome DevTools > Rendering > "Emulate CSS media feature ' +
      'prefers-reduced-motion") and set reduced motion, then reload this page. The row below simulates the ' +
      "SAME CSS effect inline so you have something to compare against even before you do that — index.css's " +
      '.throbber-spin rule (killed under prefers-reduced-motion) is scoped to that ONE class, so this scoped ' +
      'override reproduces exactly what that media query does, nothing more. Either way: the clock next to it ' +
      'is a plain React setInterval with zero dependency on motion preference — watch it for a few seconds and ' +
      "confirm it's still counting up regardless.",
    props: {
      action: 'Provisioning under way',
      startedAt: minutesAgo(1),
      progressStep: 'provisioning',
      typicalDuration: 'a few minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '10-long-elapsed-10m',
    title: '10 · Long elapsed — 10+ minutes',
    note: 'Format check: does "Nm Ss" stay legible once the minutes digit grows past single digits?',
    props: {
      action: 'Provisioning under way',
      startedAt: minutesAgo(12),
      progressStep: 'configuring',
      typicalDuration: 'a few minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '11-long-elapsed-60m',
    title: '11 · Long elapsed — 60+ minutes (a genuinely stuck run)',
    note:
      'Format check: formatElapsed() rolls over to hours past 60 minutes (operator ruling, ' +
      'dmfdeploy/dmfdeploy#390 follow-up) — this renders as "1h 15m Ns", not "75m Ns". Confirm it reads ' +
      'instantly at this length, with no arithmetic required.',
    props: {
      action: 'Tearing down',
      startedAt: minutesAgo(75),
      progressStep: 'finalising',
      typicalDuration: 'two to three minutes',
      children: PlaceholderChildren,
    },
  },
  {
    id: '12-resolved-pacing-window',
    title: '12 · "Terminal" — the operation has resolved, but the notice is still mounted (the G4 fix, live)',
    note:
      "JobStatusLine's own hand-off is deliberately paced (~2s, \"long enough to read the outcome\") — for that " +
      'brief window the calling page can still have this component mounted with a job id that has already ' +
      'concluded. Codex found the running count could render there too (G4). This specimen shows the FIXED ' +
      'behavior for that exact window: step phrase frozen, NO running count, even though a trustworthy count ' +
      'was supplied (see FinaliseStage.tsx\'s progressOperationResolved guard) — compare against specimen 7, ' +
      'which is the identical props MINUS this being a resolved op. Once the pacing window elapses, the real ' +
      'call sites unmount this component entirely and render their own terminal result UI — there is no ' +
      "\"terminal\" prop on this component itself to demo beyond that; it simply stops being rendered.",
    props: {
      action: 'Tearing down',
      startedAt: minutesAgo(3),
      progressStep: 'finalising',
      typicalDuration: 'two to three minutes',
      runningReadout: null, // what FinaliseStage now passes once progressOperationResolved is true
      children: PlaceholderChildren,
    },
  },
]

function SpecimenRow({ specimen }: { specimen: Specimen }) {
  return (
    <section data-testid={`throbber-specimen-${specimen.id}`} className="mb-8">
      <h2 className="text-base font-semibold text-text">{specimen.title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-muted">{specimen.note}</p>
      <div className="panel mt-3 max-w-xl border border-accent/30 px-4 py-4">
        <AutomationInProgressNotice {...specimen.props} />
      </div>
    </section>
  )
}

export default function ThrobberHarness() {
  return (
    <div data-testid="throbber-harness" className="min-h-screen bg-bg p-6 text-text">
      <h1 className="text-lg font-semibold">Throbber inspection harness</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        dmfdeploy/dmfdeploy#390 (F16) — dev-only, reachable without a passkey (see devHarnessRoute.ts). Every
        specimen below renders the real AutomationInProgressNotice component with real props, in the same panel
        chrome the real call sites use — never a mocked stand-in. See this file's own docstring.
      </p>
      <div className="mt-6">
        {SPECIMENS.map((specimen) => (
          <SpecimenRow key={specimen.id} specimen={specimen} />
        ))}
      </div>
    </div>
  )
}
