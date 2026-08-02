import { create } from 'zustand'

/**
 * The topbar's own transient-message surface (umbrella #347 WO-D1.2, GATE-D1
 * P2.4). SUPPLEMENTAL only — an echo of a job lifecycle moment (started /
 * terminal outcome), never the authoritative record of what happened. The
 * authoritative outcome stays anchored at the acting stage (Constitution
 * Art. 2: close every loop at the point of action) — nothing here replaces
 * or duplicates that; a message that expires unread costs the operator
 * nothing, because the stage still holds the real answer.
 *
 * Ephemeral by design (no persist middleware, unlike store/activity.ts): a
 * page reload has nothing useful to restore here.
 */
const MESSAGE_TTL_MS = 6000

export interface TopbarMessage {
  id: number
  text: string
}

interface TopbarMessageStore {
  message: TopbarMessage | null
  emit: (text: string) => void
}

let nextId = 0

export const useTopbarMessageStore = create<TopbarMessageStore>((set, get) => ({
  message: null,
  emit: (text) => {
    const id = ++nextId
    set({ message: { id, text } })
    // Only clears if THIS message is still the current one — an older
    // message's expiry must never clobber a newer one that already
    // replaced it.
    setTimeout(() => {
      if (get().message?.id === id) set({ message: null })
    }, MESSAGE_TTL_MS)
  },
}))
