// Shared by adapter.ts (imapflow's envelope addresses) and provider.ts
// (postal-mime's parsed addresses) — same shape, same rule: drop an address
// with no address field entirely rather than keep an empty-string placeholder.
export function addressList(
  addresses: { address?: string | null }[] | undefined,
): string[] {
  return (addresses ?? [])
    .map((address) => address.address)
    .filter((address): address is string => Boolean(address));
}
