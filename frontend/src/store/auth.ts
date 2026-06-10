import { create } from 'zustand'
import type { UserIdentity } from '../api/types'

interface AuthStore {
  user: UserIdentity | null
  isLoading: boolean
  setUser: (user: UserIdentity | null) => void
  setLoading: (loading: boolean) => void
  logout: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isLoading: true,
  setUser: (user) => set({ user, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
  logout: () => set({ user: null }),
}))
