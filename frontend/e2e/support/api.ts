import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T
}

// A 1x1 transparent PNG, used for the live-preview <img> endpoints.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

export interface StubResponse {
  status?: number
  json?: unknown
  body?: Buffer
  contentType?: string
}

type Handler = StubResponse | ((match: RegExpMatchArray, url: URL) => StubResponse)

interface Rule {
  method: string
  pattern: RegExp
  handler: Handler
}

const json = (name: string): Handler => () => ({ json: fixture(name) })

// Every endpoint the console calls. Patterns match the URL pathname exactly.
const RULES: Rule[] = [
  { method: 'GET', pattern: /^\/api\/me$/, handler: json('me') },
  { method: 'GET', pattern: /^\/api\/contract$/, handler: json('contract') },
  { method: 'GET', pattern: /^\/api\/workflows$/, handler: json('workflows') },
  { method: 'GET', pattern: /^\/api\/workspace\/health$/, handler: json('workspace-health') },
  { method: 'GET', pattern: /^\/api\/monitoring\/alerts$/, handler: json('monitoring-alerts') },
  { method: 'GET', pattern: /^\/api\/monitoring\/targets$/, handler: json('monitoring-targets') },
  { method: 'GET', pattern: /^\/api\/monitoring\/metrics$/, handler: json('monitoring-metrics') },
  { method: 'GET', pattern: /^\/api\/facility\/summary$/, handler: json('facility-summary') },
  { method: 'GET', pattern: /^\/api\/facility\/devices$/, handler: json('facility-devices') },
  { method: 'GET', pattern: /^\/api\/facility\/([^/]+)\/detail$/, handler: json('facility-detail') },
  { method: 'GET', pattern: /^\/api\/changes\/jobs$/, handler: json('changes-jobs') },
  { method: 'GET', pattern: /^\/api\/changes\/commits$/, handler: json('changes-commits') },
  { method: 'GET', pattern: /^\/api\/changes\/pulls$/, handler: json('changes-pulls') },
  { method: 'GET', pattern: /^\/api\/audit\/events$/, handler: json('audit-events') },
  { method: 'GET', pattern: /^\/api\/admin\/health$/, handler: json('admin-health') },
  { method: 'GET', pattern: /^\/api\/admin\/users$/, handler: json('admin-users') },
  { method: 'GET', pattern: /^\/api\/admin\/groups$/, handler: json('admin-groups') },
  { method: 'GET', pattern: /^\/api\/catalog$/, handler: json('catalog') },
  { method: 'GET', pattern: /^\/api\/mxl\/status$/, handler: json('mxl-status') },
  { method: 'GET', pattern: /^\/api\/mxl\/preview\/receiver$/, handler: { body: PNG, contentType: 'image/png' } },
  { method: 'GET', pattern: /^\/api\/media-workloads$/, handler: json('media-workloads') },
  { method: 'GET', pattern: /^\/api\/media-workloads\/grouped$/, handler: json('media-workloads-grouped') },
  {
    method: 'GET',
    pattern: /^\/api\/media-workloads\/([^/]+)\/mxl\/status$/,
    handler: (m) => {
      const all = fixture<Record<string, unknown>>('mxl-instance-status')
      const name = decodeURIComponent(m[1])
      return { json: all[name] ?? { instance: name, available: false, reason: 'no-sidecar' } }
    },
  },
  { method: 'GET', pattern: /^\/api\/media-workloads\/([^/]+)\/mxl\/preview$/, handler: { body: PNG, contentType: 'image/png' } },
  {
    method: 'GET',
    pattern: /^\/api\/media-workloads\/([^/]+)\/topology$/,
    handler: (m) => {
      // An instance without a topology answers 404, which the console treats as "none".
      const all = fixture<Record<string, unknown>>('topology')
      const found = all[decodeURIComponent(m[1])]
      return found ? { json: found } : { status: 404, json: { error: 'no topology' } }
    },
  },
]

export interface ApiStub {
  /** Replace the response for one endpoint, for this test only. */
  override(method: string, path: string, response: StubResponse): void
  /** Every /api or /auth request the stubs could not match. */
  unhandled: string[]
  /** Every stubbed request, as "METHOD pathname". */
  calls: string[]
}

/**
 * Answers every /api/* and /auth/* request from fixtures. The match is on the
 * URL pathname, so Vite module requests such as /static/app/src/api/client.ts
 * are never intercepted. Anything unrecognised gets a 501 and is recorded.
 */
export async function installApi(page: Page): Promise<ApiStub> {
  const overrides = new Map<string, StubResponse>()
  const stub: ApiStub = {
    override: (method, path, response) => overrides.set(`${method.toUpperCase()} ${path}`, response),
    unhandled: [],
    calls: [],
  }

  await page.route(
    (url) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/'),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const key = `${request.method()} ${url.pathname}`

      const respond = (r: StubResponse) =>
        route.fulfill({
          status: r.status ?? 200,
          contentType: r.contentType ?? 'application/json',
          body: r.body ?? JSON.stringify(r.json ?? {}),
        })

      const override = overrides.get(key)
      if (override) {
        stub.calls.push(key)
        return respond(override)
      }
      for (const rule of RULES) {
        if (rule.method !== request.method()) continue
        const match = url.pathname.match(rule.pattern)
        if (!match) continue
        stub.calls.push(key)
        return respond(typeof rule.handler === 'function' ? rule.handler(match, url) : rule.handler)
      }
      stub.unhandled.push(key)
      return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'unstubbed' }) })
    },
  )
  return stub
}
