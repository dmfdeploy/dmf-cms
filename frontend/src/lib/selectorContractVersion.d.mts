export function decideVersionBump(
  base: { version: number; digest: string } | null,
  head: { version: number; digest: string },
): string | null

export function parseLock(text: string): { version: number; digest: string } | null
