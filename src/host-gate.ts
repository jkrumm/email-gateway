// Host gate for the mail surface (/app, /api and, later, /mcp): when MAIL_HOST
// is set those routes answer only on that hostname, so the public tunnel
// hostname can keep serving the send routes while a tailnet-only hostname
// serves mail. Unset MAIL_HOST -> a no-op (dev, and prod until Wave 9 sets it).
export function hostAllowed(
  hostHeader: string | null | undefined,
  mailHost: string | undefined,
): boolean {
  if (!mailHost) return true;
  if (!hostHeader) return false;
  return hostnameOf(hostHeader) === hostnameOf(mailHost);
}

// Compares only the hostname: the request's Host carries a port (e.g.
// `mail.test:3010`) while MAIL_HOST is a bare hostname. IPv6 literals are
// bracketed (`[::1]:3010`), so the port colon is only the one after `]`.
function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}
