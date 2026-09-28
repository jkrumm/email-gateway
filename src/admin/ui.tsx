import type { ReactNode } from "react";

export function Badge({
  children,
  color = "gray",
}: {
  children: ReactNode;
  color?: string;
}) {
  return <span className={`badge badge-${color}`}>{children}</span>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      <p className="empty-body">{body}</p>
    </div>
  );
}

export function SegmentedLinks({
  options,
}: {
  options: { label: string; href: string; active: boolean }[];
}) {
  return (
    <span className="seg">
      {options.map((option) => (
        <a
          key={option.href}
          href={option.href}
          className={option.active ? "seg-option active" : "seg-option"}
          aria-current={option.active ? "page" : undefined}
        >
          {option.label}
        </a>
      ))}
    </span>
  );
}

export function EmailFrame({ html }: { html: string }) {
  return (
    // Empty sandbox: no scripts, no same-origin. React escapes the srcDoc
    // attribute value, so untrusted email HTML never breaks out of it.
    <iframe
      sandbox=""
      srcDoc={html}
      className="email-frame"
      title="email preview"
    />
  );
}

const NAV_ICON_PATHS: Record<string, ReactNode> = {
  spam: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9.5 12l2 2 3-3.5" />
    </>
  ),
  templates: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="1.5" />
      <path d="M7.5 8h9M7.5 12h9M7.5 16h5.5" />
    </>
  ),
};

export function NavIcon({ name }: { name: keyof typeof NAV_ICON_PATHS }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {NAV_ICON_PATHS[name]}
    </svg>
  );
}
