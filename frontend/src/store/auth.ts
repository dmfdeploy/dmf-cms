import { create } from 'zustand'
import type { UserIdentity } from '../api/types'
import { useDraftWorkloadStore } from './draftWorkload'

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
  // WP-3 spec C: a draft is session residue once the session ends — see
  // store/draftWorkload.ts's own docstring for the other two callers
  // (successful provision, explicit start-over). Topbar's actual Logout
  // link is a hard `<a href="/auth/logout">` navigation today, which wipes
  // every in-memory store on its own; this call makes the guarantee hold
  // even if logout is ever driven client-side instead; belt and suspenders,
  // not a guess about which path is live.
  logout: () => {
    set({ user: null })
    useDraftWorkloadStore.getState().reset()
  },
}))
