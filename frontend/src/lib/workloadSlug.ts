// Workload-tag slug (dmfdeploy/dmfdeploy#239 trio: dmf-cms + dmf-runbooks +
// dmf-infra). Fixed across all three PRs — do not rename or relax. Mirrors
// dmf_cms.main.WORKLOAD_SLUG_RE exactly; k8s-label-ish, max 40 chars.
export const WORKLOAD_SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/

export function isValidWorkloadSlug(slug: string): boolean {
  return WORKLOAD_SLUG_RE.test(slug)
}
