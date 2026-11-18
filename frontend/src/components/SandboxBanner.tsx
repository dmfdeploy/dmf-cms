import { usePlatformTrust } from '../api/hooks'

/**
 * Tells every signed-in user that this environment is a sandbox. It renders
 * nothing unless the server reports `sandbox`. In public mode it adds the
 * warning about losing the server's IP address.
 */
export default function SandboxBanner() {
  const { data } = usePlatformTrust()
  if (!data?.sandbox) return null

  return (
    <div
      data-testid="sandbox-banner"
      className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
    >
      <p>This sandbox is an unsafe, ephemeral learning environment. Don&apos;t use it for anything that matters.</p>
      {data.network_mode === 'public' && (
        <p>If this server loses its IP address, the sandbox is lost.</p>
      )}
    </div>
  )
}
