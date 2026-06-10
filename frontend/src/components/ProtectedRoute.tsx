import { useAuthStore } from '../store/auth'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  const isLoading = useAuthStore((state) => state.isLoading)

  if (isLoading) {
    return null
  }

  if (!user) {
    window.location.href = '/auth/login'
    return null
  }

  return <>{children}</>
}
