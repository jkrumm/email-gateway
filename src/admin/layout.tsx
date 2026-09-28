import type { ReactNode } from "react";
import { NavIcon } from "./ui";
import { APP_CSS_VERSION } from "./assets";

export type AdminNav = "submissions" | "templates";

const NAV_ITEMS: {
  id: AdminNav;
  label: string;
  href: string;
  icon: Parameters<typeof NavIcon>[0]["name"];
}[] = [
  {
    id: "submissions",
    label: "Spam filter",
    href: "/admin/submissions",
    icon: "spam",
  },
  {
    id: "templates",
    label: "Templates",
    href: "/admin/templates",
    icon: "templates",
  },
];

export function AdminLayout({
  title,
  active,
  notice,
  children,
}: {
  title: string;
  active: AdminNav;
  notice?: { text: string; error?: boolean } | null;
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{`${title} · Mail`}</title>
        <link
          rel="stylesheet"
          href={`/admin/assets/app.css?v=${APP_CSS_VERSION}`}
        />
      </head>
      <body>
        <div className="app-shell">
          <header className="app-header">
            <span className="wordmark">Mail</span>
          </header>
          <div className="app-body">
            <nav className="app-sidebar">
              <ul className="nav-list">
                {NAV_ITEMS.map((item) => (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      className={
                        item.id === active ? "nav-item active" : "nav-item"
                      }
                      aria-current={item.id === active ? "page" : undefined}
                    >
                      <NavIcon name={item.icon} />
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <main className="app-content">
              {notice ? (
                <p className={notice.error ? "notice notice-error" : "notice"}>
                  {notice.text}
                </p>
              ) : null}
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
