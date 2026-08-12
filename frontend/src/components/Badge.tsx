import type { LucideIcon } from 'lucide-react'

/**
 * Shared status badge (umbrella dmfdeploy/dmfdeploy#347 Arc 4 WP-4, Art. 11:
 * colour is never the only signal — colour plus shape/icon plus text plus
 * position, legible with colour stripped; a hover-only `title=` tooltip does
 * not satisfy it). `tone`, `icon` and `label` are all REQUIRED props, so a
 * caller cannot compile a colour-only badge — the guarantee is structural,
 * not a convention someone can forget. `tone` does NOT auto-select an icon:
 * the mapping below is a deliberate per-call-site choice, not a default this
 * component silently applies, so a future tone can't ship icon-less by
 * omission either.
 *
 * `title`, when given, is genuinely supplementary (extra detail on hover/
 * focus) — never the only way to reach information the badge itself owes at
 * default level, per Art. 11's own text.
 */
export type BadgeTone = 'neutral' | 'info' | 'progress' | 'warning' | 'danger'

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'bg-white/10 text-muted',
  info: 'bg-blue-500/20 text-blue-300',
  progress: 'bg-amber-500/20 text-amber-300',
  warning: 'bg-amber-900/30 text-amber-300',
  danger: 'bg-red-500/20 text-red-300',
}

export default function Badge({
  tone,
  icon: Icon,
  label,
  title,
  className = '',
}: {
  tone: BadgeTone
  icon: LucideIcon
  label: string
  title?: string
  className?: string
}) {
  return (
    <span
      className={`badge inline-flex shrink-0 items-center gap-1 text-xs ${TONE_CLASS[tone]} ${className}`}
      title={title}
    >
      {/* Decorative: `label` already carries the full meaning for assistive
          tech, so the icon doesn't need (and shouldn't get) its own
          announcement — it's here for the SIGHTED, colour-stripped case. */}
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  )
}
