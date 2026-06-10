import { useCurrentUser } from '../../api/hooks'
import AdminOverview from './AdminOverview'
import OperatorOverview from './OperatorOverview'
import EngineerOverview from './EngineerOverview'
import ViewerOverview from './ViewerOverview'

export default function Overview() {
  const { data: user } = useCurrentUser()
  const role = user?.role ?? 'viewer'

  if (role === 'admin') return <AdminOverview />
  if (role === 'operator') return <OperatorOverview />
  if (role === 'engineer') return <EngineerOverview />
  return <ViewerOverview />
}
