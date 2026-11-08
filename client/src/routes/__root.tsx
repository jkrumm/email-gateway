import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Center, Loader } from '@mantine/core'
import type { BasaltRouterContext } from 'basalt-ui'
import { AppLayout } from '../components/AppLayout'
import { LoginView } from '../components/LoginView'
import { fetchSession } from '../lib/session'

export const Route = createRootRouteWithContext<BasaltRouterContext>()({
  component: RootComponent,
})

function RootComponent() {
  const { data, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: fetchSession,
    staleTime: 30_000,
  })

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    )
  }

  if (!data?.authenticated) return <LoginView />

  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  )
}
