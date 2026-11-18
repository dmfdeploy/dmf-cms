/**
 * The sandbox banner (top bar) and the "Certificate authority" settings card
 * both read /api/platform-trust.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import Topbar from '../components/Topbar'
import Settings from '../pages/Settings'
import { useAuthStore } from '../store/auth'
import type { PlatformTrust, UserIdentity } from '../api/types'

const USER: UserIdentity = {
  subject: 'ops',
  display_name: 'Ops Operator',
  email: 'ops@dmf.example.com',
  role: 'engineer',
  real_role: 'engineer',
  view_as_active: false,
  groups: [],
  awx_configured: true,
  authentik_configured: true,
}

const NO_TRUST: PlatformTrust = {
  network_mode: '',
  approval_page_name: '',
  ca_fingerprint_sha256: '',
  ca_not_after: '',
  sandbox: false,
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubApi(trust: PlatformTrust) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/platform-trust')) return json(trust)
      if (url.includes('/api/me')) return json(USER)
      return json({})
    }),
  )
}

function renderWith(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const BANNER = "This sandbox is an unsafe, ephemeral learning environment. Don't use it for anything that matters."
const PUBLIC_SENTENCE = 'If this server loses its IP address, the sandbox is lost.'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAuthStore.getState().setUser(null)
})

describe('sandbox banner', () => {
  it('is absent when the server says this is not a sandbox', async () => {
    // Catches a banner that always renders.
    useAuthStore.getState().setUser(USER)
    stubApi(NO_TRUST)
    renderWith(<Topbar />)

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/platform-trust'), expect.anything()))
    expect(screen.queryByTestId('sandbox-banner')).toBeNull()
  })

  it('shows the warning in lan mode without the public sentence', async () => {
    // Catches a banner that adds the public sentence in every sandbox.
    useAuthStore.getState().setUser(USER)
    stubApi({ ...NO_TRUST, network_mode: 'lan', sandbox: true })
    renderWith(<Topbar />)

    const banner = await screen.findByTestId('sandbox-banner')
    expect(banner.textContent).toContain(BANNER)
    expect(banner.textContent).not.toContain(PUBLIC_SENTENCE)
  })

  it('adds the lost-IP sentence in public mode', async () => {
    // Catches a banner that ignores network_mode.
    useAuthStore.getState().setUser(USER)
    stubApi({ ...NO_TRUST, network_mode: 'public', sandbox: true })
    renderWith(<Topbar />)

    const banner = await screen.findByTestId('sandbox-banner')
    expect(banner.textContent).toContain(BANNER)
    expect(banner.textContent).toContain(PUBLIC_SENTENCE)
  })
})

describe('Certificate authority card', () => {
  const TRUST: PlatformTrust = {
    network_mode: 'lan',
    approval_page_name: 'trust.example.invalid',
    ca_fingerprint_sha256: 'AA:BB:CC:DD',
    ca_not_after: '2036-01-01',
    sandbox: true,
  }

  it('shows the fingerprint, the expiry, the approval page and the comparison advice', async () => {
    // Catches a card that omits a field or the advice sentence.
    stubApi(TRUST)
    renderWith(<Settings />)

    expect(await screen.findByRole('heading', { name: 'Certificate authority' })).toBeTruthy()
    expect(screen.getByTestId('ca-fingerprint').textContent).toBe('AA:BB:CC:DD')
    expect(screen.getByText('2036-01-01')).toBeTruthy()
    expect(screen.getByText('trust.example.invalid')).toBeTruthy()
    expect(screen.getByText(/Compare this fingerprint with the one on your device before you trust the CA/)).toBeTruthy()
  })

  it('shows the fingerprint in monospace', async () => {
    // Catches a fingerprint rendered in the proportional body font.
    stubApi(TRUST)
    renderWith(<Settings />)

    const fingerprint = await screen.findByTestId('ca-fingerprint')
    expect(fingerprint.className).toContain('font-mono')
  })

  it('copies the fingerprint to the clipboard', async () => {
    // Catches a Copy button that copies nothing or the wrong value.
    stubApi(TRUST)
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderWith(<Settings />)

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))

    expect(writeText).toHaveBeenCalledWith('AA:BB:CC:DD')
  })

  it('is absent when the environment has no fingerprint', async () => {
    // Catches an empty card on environments without a local CA.
    stubApi(NO_TRUST)
    renderWith(<Settings />)

    await screen.findByText('Profile')
    expect(screen.queryByRole('heading', { name: 'Certificate authority' })).toBeNull()
  })
})
