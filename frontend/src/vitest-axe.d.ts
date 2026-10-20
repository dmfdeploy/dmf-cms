// Type the `toHaveNoViolations` matcher for vitest 4. The package's own
// `extend-expect` typing targets the older `Vi` namespace.
import type { AxeMatchers } from 'vitest-axe/matchers'

declare module '@vitest/expect' {
  interface Matchers<T = unknown> extends AxeMatchers {}
}
