import { createRoot } from 'react-dom/client'
import { BasaltProvider, createBasaltRouter } from 'basalt-ui'

import 'basalt-ui/styles.css'

import { routeTree } from './routeTree.gen'

const router = createBasaltRouter({
  routeTree,
  basepath: '/app',
  query: { defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } },
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <BasaltProvider router={router} defaultColorScheme="dark" />,
)
