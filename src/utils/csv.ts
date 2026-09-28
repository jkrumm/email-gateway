// Shared by every optional comma-separated-ids query param (src/api/plugin.ts's
// `account` filter, src/mcp/plugin.ts's tool inputs of the same shape): an
// empty/whitespace value means "no filter", never a filter matching nothing.
export function splitCsv(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}
