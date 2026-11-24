// Type the `toHaveNoViolations` matcher for vitest 5. The package's own
// `extend-expect` typing targets the older `Vi` namespace.
import type { AxeMatchers } from 'vitest-axe/matchers'

declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends AxeMatchers {}
}
