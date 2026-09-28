import type { ReactNode } from "react";
import { AppShell, Button, Group, NavLink, Stack, Title } from "@mantine/core";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { logout } from "../lib/session";

const NAV = [
  { to: "/inbox", label: "Inbox" },
  { to: "/submissions", label: "Submissions" },
  { to: "/accounts", label: "Accounts" },
] as const;

export function AppLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleLogout() {
    await logout();
    await queryClient.invalidateQueries({ queryKey: ["session"] });
    await navigate({ to: "/inbox" });
  }

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{ width: 200, breakpoint: "sm" }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={4}>email-gateway</Title>
          <Button variant="subtle" size="xs" onClick={handleLogout}>
            Log out
          </Button>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <Stack gap={4}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              component={Link}
              to={item.to}
              label={item.label}
              active={pathname.startsWith(item.to)}
            />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
