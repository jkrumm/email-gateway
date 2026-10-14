import type { SESv2Client } from "@aws-sdk/client-sesv2";

export type SuppressionReason = "BOUNCE" | "COMPLAINT";

export interface Suppression {
  email: string;
  reason: SuppressionReason;
  // ISO UTC.
  lastUpdate: string;
}

export interface SuppressionPage {
  data: Suppression[];
  nextCursor: string | null;
}

// SES allows up to 1000 per page; the dashboard never needs that many.
export const SUPPRESSION_PAGE_SIZE = 100;

// Only what the module calls — narrower than the full SDK client so a test
// fake can be injected.
type SesSuppressionClient = Pick<SESv2Client, "send">;

export interface SesSuppressions {
  list(input?: {
    reason?: SuppressionReason;
    cursor?: string;
  }): Promise<SuppressionPage>;
  // Removes an address from the account-level suppression list. SES throws a
  // NotFoundException (name "NotFoundException") for an address not on it.
  remove(email: string): Promise<void>;
}

// The account-level suppression list SES maintains from hard bounces and
// complaints. Read and delete only — adding is SES's job. Addresses stay in
// the response and are never stored or logged.
export function createSesSuppressions({
  client,
}: {
  client: SesSuppressionClient;
}): SesSuppressions {
  return {
    async list({ reason, cursor } = {}) {
      const { ListSuppressedDestinationsCommand } =
        await import("@aws-sdk/client-sesv2");
      const response = await client.send(
        new ListSuppressedDestinationsCommand({
          PageSize: SUPPRESSION_PAGE_SIZE,
          ...(reason ? { Reasons: [reason] } : {}),
          ...(cursor ? { NextToken: cursor } : {}),
        }),
      );
      const data = (response.SuppressedDestinationSummaries ?? []).flatMap(
        (summary) =>
          summary.EmailAddress && summary.Reason
            ? [
                {
                  email: summary.EmailAddress,
                  reason: summary.Reason,
                  lastUpdate: (
                    summary.LastUpdateTime ?? new Date(0)
                  ).toISOString(),
                },
              ]
            : [],
      );
      return { data, nextCursor: response.NextToken ?? null };
    },

    async remove(email) {
      const { DeleteSuppressedDestinationCommand } =
        await import("@aws-sdk/client-sesv2");
      await client.send(
        new DeleteSuppressedDestinationCommand({ EmailAddress: email }),
      );
    },
  };
}

export function isSuppressionNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundException";
}
