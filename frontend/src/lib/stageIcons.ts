import { Pencil, Puzzle, CloudUpload, Sliders, CircleCheck, type LucideIcon } from 'lucide-react'
import type { FlowStepId } from './workloadFlow'

/**
 * The lifecycle rail's per-stage IDENTITY icon set (dmfdeploy#482).
 *
 * RECORDED HERE FOR THE FIRST TIME. An operator reference image has shown
 * this set since before dmfdeploy#449, but until this file it existed
 * nowhere in the repos — not the plan, the issues, the design docs, nor the
 * agent transcript archive (confirmed absent per #482's own body). This
 * module, plus the design record at
 * docs/design/DMF Console Lifecycle Rail Visual System.md §3, is that
 * record now. `lucide-react` is the app's existing icon dependency — no new
 * one was needed.
 *
 *   Design             — pencil
 *   Plan                — puzzle
 *   Provision           — cloud-upload
 *   Configure           — sliders
 *   Finalise & Review    — circled-check
 *
 * WHY CIRCLED-CHECK MATTERS BEYOND NAMING. It is why the rail's per-stage
 * mark could never also be a tick: a tick as a "complete" glyph would
 * duplicate the circled-check icon already sitting permanently on the
 * Finalise & Review key. See LifecycleStrip.tsx's own docstring for what
 * the mark channel does instead this round.
 *
 * EVERY KEY RENDERS ITS OWN ICON UNCONDITIONALLY — including a locked key
 * and a key with nothing actionable (Information Architecture doc's
 * 2026-08-30 #493 amendment; Visual System doc §2a). No key is ever
 * iconless, and nothing here ever substitutes a padlock (or any other
 * state glyph) for a key's identity icon — the padlock is reserved for a
 * future authorization-denied state that does not exist in the code yet,
 * and returns to the rail only once it does (Visual System doc §2a/§6).
 * LifecycleStrip.tsx marks every icon `aria-hidden` — decorative next to
 * the always-visible EBU label, never announced twice.
 */
export const STAGE_ICON: Record<FlowStepId, LucideIcon> = {
  design: Pencil,
  plan: Puzzle,
  provision: CloudUpload,
  configure: Sliders,
  finalise: CircleCheck,
}
