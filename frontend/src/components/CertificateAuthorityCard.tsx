import { useState } from 'react'
import { usePlatformTrust } from '../api/hooks'

/**
 * Settings card that shows the local certificate authority's SHA-256
 * fingerprint, its expiry and the approval page's address. It renders nothing
 * when the environment has no fingerprint to show.
 */
export default function CertificateAuthorityCard() {
  const { data } = usePlatformTrust()
  const [copied, setCopied] = useState(false)
  if (!data?.ca_fingerprint_sha256) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(data.ca_fingerprint_sha256)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="bg-panel border border-border rounded-lg mb-6">
      <div className="p-4 border-b border-border">
        <h2 className="font-bold text-sm text-text">Certificate authority</h2>
      </div>
      <div className="p-4">
        <p className="text-sm text-text mb-4">
          Compare this fingerprint with the one on your device before you trust the CA.
        </p>
        <dl className="space-y-4">
          <div className="flex items-start gap-4">
            <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">SHA-256 fingerprint</dt>
            <dd className="min-w-0 text-sm text-text">
              <code data-testid="ca-fingerprint" className="font-mono break-all">{data.ca_fingerprint_sha256}</code>
              <button
                type="button"
                onClick={handleCopy}
                className="ml-3 text-xs text-accent-blue hover:text-accent-blue/80"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </dd>
          </div>
          {data.ca_not_after && (
            <div className="flex items-start gap-4">
              <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">Expires</dt>
              <dd className="text-sm text-text">{data.ca_not_after}</dd>
            </div>
          )}
          {data.approval_page_name && (
            <div className="flex items-start gap-4">
              <dt className="text-[11px] text-muted uppercase tracking-wider font-semibold w-32 shrink-0 pt-0.5">Approval page</dt>
              <dd className="text-sm text-text break-all">{data.approval_page_name}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}
