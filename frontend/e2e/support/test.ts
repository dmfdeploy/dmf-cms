import { test as base, expect } from '@playwright/test'
import { installApi, type ApiStub } from './api'

interface Fixtures {
  api: ApiStub
  pageErrors: string[]
}

// `api` is automatic: every test gets the stubs, and fails if the app
// requested an /api or /auth path the stubs do not know.
export const test = base.extend<Fixtures>({
  api: [
    async ({ page }, use) => {
      const stub = await installApi(page)
      await use(stub)
      expect(stub.unhandled, 'unstubbed /api or /auth requests').toEqual([])
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await use(errors)
    },
    { auto: true },
  ],
})

export { expect }
