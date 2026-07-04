import { useEffect, useState, type ReactNode } from 'react'
import { Film } from 'lucide-react'
import { useMxlStatus } from '@/api/hooks'

const PROVIDER_GLYPHS: Record<
  string,
  { label: string; bg: string; fg: string; glyph?: { viewBox: string; path: string; fill: string; title: string } }
> = {
  aliyun: {
    label: 'Alibaba Cloud',
    bg: '#ffffff',
    fg: '#FF6A00',
    glyph: {
      viewBox: '0 0 24 24',
      fill: '#FF6A00',
      title: 'Alibaba Cloud',
      path: 'M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z',
    },
  },
  hetzner: { label: 'Hetzner', bg: '#D50C2D', fg: '#ffffff' },
  aws: { label: 'AWS', bg: '#FF9900', fg: '#111111' },
}

function ProviderLogo({ provider }: { provider: string }) {
  const p = PROVIDER_GLYPHS[provider?.toLowerCase()] ?? {
    label: provider || 'unknown',
    bg: '#33414f',
    fg: '#e7eef7',
  }

  return (
    <span
      className="inline-flex items-center gap-2 rounded-md px-2.5 py-1 text-xs font-semibold"
      style={{ backgroundColor: p.bg, color: p.fg }}
      title={p.label}
    >
      {'glyph' in p && p.glyph ? (
        <svg width="14" height="14" viewBox={p.glyph.viewBox} aria-hidden focusable="false">
          <title>{p.glyph.title}</title>
          <path d={p.glyph.path} fill={p.glyph.fill} />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
          <path d="M6 16a4 4 0 010-8 5 5 0 019.6-1.5A4.5 4.5 0 1118 16H6z" fill="currentColor" />
        </svg>
      )}
      {p.label}
    </span>
  )
}

function StatPill({ active }: { active?: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-semibold text-green-200 ring-1 ring-green-400/25">
      <span className="h-1.5 w-1.5 rounded-full bg-green-300 animate-pulse" /> Active
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white/8 px-2 py-0.5 text-[11px] font-semibold text-white/65 ring-1 ring-white/10">
      <span className="h-1.5 w-1.5 rounded-full bg-white/45" /> Idle
    </span>
  )
}

function LiveDot({ active, label }: { active?: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${
        active ? 'bg-emerald-500/15 text-emerald-200 ring-emerald-400/25' : 'bg-white/8 text-white/60 ring-white/10'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-300 animate-pulse' : 'bg-white/45'}`} />
      {label}
    </span>
  )
}

function TagChip({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold ${
        mono ? 'font-mono tracking-[0.08em] text-white/72' : 'text-white/65'
      }`}
    >
      {children}
    </span>
  )
}

const ROW_HEIGHT_CLASS = 'h-[9rem]'

const ROW_AXIS_STYLES = [
  {
    bg: 'rgba(16, 57, 34, 0.24)',
    accent: 'rgba(74, 222, 128, 0.95)',
  },
  {
    bg: 'rgba(15, 50, 32, 0.22)',
    accent: 'rgba(74, 222, 128, 0.72)',
  },
  {
    bg: 'rgba(13, 44, 30, 0.20)',
    accent: 'rgba(132, 204, 22, 0.52)',
  },
  {
    bg: 'rgba(17, 37, 68, 0.22)',
    accent: 'rgba(96, 165, 250, 0.88)',
  },
  {
    bg: 'rgba(15, 32, 58, 0.20)',
    accent: 'rgba(96, 165, 250, 0.70)',
  },
  {
    bg: 'rgba(13, 28, 50, 0.18)',
    accent: 'rgba(96, 165, 250, 0.52)',
  },
] as const

function RowLabel({ title, caption, index }: { title: string; caption: string; index: number }) {
  const style = ROW_AXIS_STYLES[index] ?? ROW_AXIS_STYLES[ROW_AXIS_STYLES.length - 1]
  return (
    <div
      className={`relative flex ${ROW_HEIGHT_CLASS} flex-col justify-center overflow-hidden rounded-xl border border-white/10 px-4 py-3 text-white shadow-sm`}
      style={{ backgroundColor: style.bg }}
    >
      <div className="absolute left-0 top-0 h-full w-1.5" style={{ backgroundColor: style.accent }} />
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/82">{title}</div>
      <div className="mt-1 text-xs leading-snug text-white/68">{caption}</div>
    </div>
  )
}

function Cell({ children, dim = false }: { children: ReactNode; dim?: boolean }) {
  return (
    <div
      className={`flex ${ROW_HEIGHT_CLASS} items-center rounded-xl border px-3 py-2 text-sm shadow-sm overflow-hidden ${
        dim ? 'border-white/6 bg-white/[0.03] text-white/40' : 'border-white/10 bg-white/[0.06] text-white'
      }`}
    >
      <div className="w-full">{children}</div>
    </div>
  )
}

function ExchangeCell({
  title,
  statusLabel,
  subtitle,
  titleTone = 'text-white',
  metricA,
  metricB,
  active,
  showActivePill = false,
  metricATextClass = 'text-white/75',
  metricBTextClass = 'text-white/75',
}: {
  title: string
  statusLabel: string
  subtitle?: string
  titleTone?: string
  metricA?: { label: string; value: string }
  metricB?: { label: string; value: string }
  active?: boolean
  showActivePill?: boolean
  metricATextClass?: string
  metricBTextClass?: string
}) {
  return (
    <div className="flex h-full flex-col justify-between gap-2 overflow-hidden">
      <div className={`text-sm font-medium ${titleTone}`}>{title}</div>
      {subtitle ? <div className="text-[11px] leading-snug text-white/60">{subtitle}</div> : null}
      <div className="flex items-center justify-between gap-2">
        <LiveDot active={!!active} label={statusLabel} />
        {showActivePill ? <StatPill active={!!active} /> : <span className="h-6" aria-hidden />}
      </div>
      <div className="flex h-4 items-center justify-between gap-3 text-xs">
        {metricA && (<><span className="text-[10px] uppercase tracking-[0.18em] text-white/55">{metricA.label}</span><span className={`font-mono tabular-nums ${metricATextClass}`}>{metricA.value}</span></>)}
      </div>
      <div className="flex h-4 items-center justify-between gap-3 text-xs">
        {metricB && (<><span className="text-[10px] uppercase tracking-[0.18em] text-white/55">{metricB.label}</span><span className={`font-mono tabular-nums ${metricBTextClass}`}>{metricB.value}</span></>)}
      </div>
    </div>
  )
}

function SectionTitle() {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <p className="kicker">MXL flows</p>
        {/* Art. 3: operator-tier wording at default level; the EBU layer
            ontology stays expert/internal (Console Glossary). */}
        <h1 className="text-2xl font-semibold text-text">Media stack by node</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Compact stack-by-node grid, backed by live status data. Missing facts remain em dashes for later phases.
        </p>
      </div>
      <div className="hidden items-center gap-2 text-xs text-muted md:flex">
        <Film className="h-4 w-4 text-accent" />
        Live preview
      </div>
    </div>
  )
}

export default function MxlFlows() {
  const { data, isLoading } = useMxlStatus()

  // Cache-bust the preview ~5/s so the clock overlay visibly ticks.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => (t + 1) % 100000), 200)
    return () => clearInterval(id)
  }, [])

  const flow = data?.flow ?? {}
  const transport = data?.transport ?? {}
  const nodes = data?.nodes ?? []
  const producer = nodes.find((n) => n.role === 'producer') ?? nodes[0]
  const receiver = nodes.find((n) => n.role === 'receiver') ?? nodes[1]
  const receiverHeadIndex = flow.head_index != null ? Number(flow.head_index).toLocaleString() : '—'
  const receiverLatencyGrains = flow.latency_grains != null ? `${flow.latency_grains} grains` : '—'
  const receiverLatency = flow.latency_ms != null ? `${Number(flow.latency_ms).toFixed(1)} ms / ${receiverLatencyGrains}` : '—'
  const transportLine = `${transport.library ?? '—'} · ${transport.provider ?? '—'}${transport.service ? ` · :${transport.service}` : ''}${transport.interface ? ` · ${transport.interface}` : ''}`
  const mxlVersion = flow.mxl_version ?? producer?.mxl_version ?? receiver?.mxl_version ?? '—'
  const formatHost = (host?: { os?: string | null; kernel?: string | null; arch?: string | null }) =>
    `OS ${host?.os ?? '—'} · kernel ${host?.kernel ?? '—'} · arch ${host?.arch ?? '—'}`
  const formatK8s = (version?: string | null) => `k3s ${version ?? '—'}`
  const formatZone = (zone?: string | null) => `zone ${zone ?? '—'}`

  return (
    <div className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top,_rgba(34,197,94,0.08),_transparent_32%),linear-gradient(180deg,_#08101b_0%,_#09131c_100%)] px-6 py-5 text-text">
      <div className="mx-auto flex w-full max-w-[100rem] flex-col">
        <SectionTitle />

        {!isLoading && data && !data.configured && (
          <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            MXL status endpoints are not configured (set <span className="font-mono">DMF_CONSOLE_MXL_ENDPOINTS</span>).
          </div>
        )}
        {!isLoading && data?.configured && !data.reachable && (
          <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            No MXL status sidecar is reachable right now.
          </div>
        )}

        {nodes.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.05] px-5 py-6 text-sm text-muted">
            <div className="text-lg font-semibold text-text">Deploy the producer + receiver functions to populate the DMF stack</div>
            <p className="mt-1 max-w-2xl">This view fills in once both media functions are live.</p>
          </div>
        ) : (
          <div className="mx-auto w-fit overflow-hidden rounded-2xl border border-white/10 bg-black/10 shadow-[0_14px_40px_rgba(0,0,0,0.18)]">
            <div className="grid w-fit grid-cols-[15rem_20rem_6rem_20rem] gap-y-px gap-x-0 bg-white/8">
              {/* Row 1 */}
              <RowLabel index={0} title="Application & UI" caption="What an operator sees: running app and live output." />
              <Cell dim>
                <div className="text-xs text-white/50">none</div>
              </Cell>
              <div aria-hidden className={`${ROW_HEIGHT_CLASS} flex items-center justify-center bg-transparent`} />
              <Cell>
                <div className="flex flex-col gap-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">Preview</div>
                    <div className="mt-1 truncate font-mono text-xs text-white/78">{flow.id ?? '—'}</div>
                  </div>
                  <div className="overflow-hidden rounded-md border border-white/10 bg-black/30" style={{ maxWidth: '110px' }}>
                    <img
                      src={`/api/mxl/preview/receiver?t=${tick}`}
                      alt="Received MXL flow (test pattern)"
                      className="aspect-video w-full object-contain"
                      onError={(e) => {
                        ;(e.currentTarget as HTMLImageElement).style.opacity = '0.15'
                      }}
                    />
                  </div>
                </div>
              </Cell>

              {/* Row 2 */}
              <RowLabel index={1} title="Media Functions" caption="Modular media building blocks deployed on demand." />
              <Cell>
                <div className="flex h-full flex-col justify-center gap-1.5">
                  <div className="text-sm font-medium">Test-pattern source</div>
                  <div className="flex flex-wrap gap-1.5">
                    <TagChip mono>mxl-videotestsrc</TagChip>
                    <TagChip>producer</TagChip>
                  </div>
                </div>
              </Cell>
              <div aria-hidden className={`${ROW_HEIGHT_CLASS} flex items-center justify-center bg-transparent`} />
              <Cell>
                <div className="flex h-full flex-col justify-center gap-1.5">
                  <div className="text-sm font-medium">Test-pattern viewer</div>
                  <div className="flex flex-wrap gap-1.5">
                    <TagChip mono>mxl-videotest-view</TagChip>
                    <TagChip>receiver</TagChip>
                  </div>
                </div>
              </Cell>

              {/* Row 3 */}
              <RowLabel index={2} title="Media Exchange" caption="How media functions hand grains to each other - this is MXL." />
              <Cell>
                <ExchangeCell
                  title="MXL initiator"
                  statusLabel={flow.active ? 'transmitting' : 'idle'}
                  subtitle={`MXL ${mxlVersion} · ${transportLine}`}
                  active={!!flow.active}
                />
              </Cell>
              <div aria-hidden className={`${ROW_HEIGHT_CLASS} bg-transparent`} />
              <Cell>
                <ExchangeCell
                  title="MXL target"
                  statusLabel={flow.active ? 'receiving' : 'idle'}
                  subtitle={`MXL ${mxlVersion} · ${transportLine}`}
                  metricA={{ label: 'head index', value: receiverHeadIndex }}
                  metricB={{ label: 'latency', value: receiverLatency }}
                  active={!!flow.active}
                  metricATextClass={flow.head_index != null ? 'text-white/82' : 'text-white/55'}
                  metricBTextClass={flow.latency_ms != null ? 'text-white/82' : 'text-white/55'}
                />
              </Cell>

              {/* Row 4 */}
              <RowLabel index={3} title="Container Platform" caption="The k8s platform scheduling the functions." />
              <Cell>
                <div className="text-sm font-medium">{producer?.node ?? '—'}</div>
                <div className="mt-1 text-xs text-white/72">{formatK8s(producer?.container?.k8s_version)}</div>
              </Cell>
              <div aria-hidden className={`${ROW_HEIGHT_CLASS} flex items-center justify-center bg-transparent`} />
              <Cell>
                <div className="text-sm font-medium">{receiver?.node ?? '—'}</div>
                <div className="mt-1 text-xs text-white/72">{formatK8s(receiver?.container?.k8s_version)}</div>
              </Cell>

              {/* Row 5 */}
              <RowLabel index={4} title="Host Platform" caption="The OS on each compute node." />
              <Cell>
                <div className="text-xs text-white/72">{formatHost(producer?.host)}</div>
              </Cell>
              <div aria-hidden className={`${ROW_HEIGHT_CLASS} flex items-center justify-center bg-transparent`} />
              <Cell>
                <div className="text-xs text-white/72">{formatHost(receiver?.host)}</div>
              </Cell>

              {/* Row 6 */}
              <RowLabel index={5} title="Infrastructure" caption="The cloud or compute the whole stack runs on." />
              <Cell>
                <div className="flex items-center gap-2">
                  <ProviderLogo provider={producer?.provider ?? 'aliyun'} />
                </div>
                <div className="mt-1 text-xs text-white/72">{formatZone(producer?.infra?.zone)}</div>
              </Cell>
              <div aria-hidden className={`${ROW_HEIGHT_CLASS} flex items-center justify-center bg-transparent`} />
              <Cell>
                <div className="flex items-center gap-2">
                  <ProviderLogo provider={receiver?.provider ?? 'aliyun'} />
                </div>
                <div className="mt-1 text-xs text-white/72">{formatZone(receiver?.infra?.zone)}</div>
              </Cell>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
