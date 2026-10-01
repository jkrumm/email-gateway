import type { ReactNode } from "react";
import { linkOptions, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { BasaltShell, type SettingsMenuItem } from "basalt-ui";
import { defineNav, navGroup, useNav } from "basalt-ui/router-tanstack";
import { logout } from "../lib/session";

const NAV = defineNav({
  groups: [
    navGroup({ id: "mail", label: "Mail" }, [
      {
        id: "inbox",
        label: "Inbox",
        mobile: "tab",
        link: linkOptions({ to: "/inbox" }),
      },
      {
        id: "templates",
        label: "Templates",
        mobile: "tab",
        link: linkOptions({ to: "/templates" }),
      },
      {
        id: "submissions",
        label: "Submissions",
        mobile: "tab",
        link: linkOptions({ to: "/submissions" }),
      },
      {
        id: "accounts",
        label: "Accounts",
        mobile: "tab",
        link: linkOptions({ to: "/accounts" }),
      },
    ]),
  ],
});

export function AppLayout({ children }: { children: ReactNode }) {
  const nav = useNav(NAV);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleLogout() {
    await logout();
    await queryClient.invalidateQueries({ queryKey: ["session"] });
    await navigate({ to: "/inbox" });
  }

  const settingsMenuItems: SettingsMenuItem[] = [
    { key: "logout", label: "Log out", onClick: () => void handleLogout() },
  ];

  return (
    <BasaltShell
      brand={{ name: "email-gateway" }}
      {...nav}
      settingsMenuItems={settingsMenuItems}
    >
      {children}
    </BasaltShell>
  );
}
