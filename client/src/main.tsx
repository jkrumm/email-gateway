import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { BasaltProvider, createBasaltTheme } from "basalt-ui";

import "@mantine/core/styles.layer.css";
import "basalt-ui/styles.css";

import { queryClient } from "./lib/query";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BasaltProvider theme={createBasaltTheme()} defaultColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </BasaltProvider>
  </React.StrictMode>,
);
