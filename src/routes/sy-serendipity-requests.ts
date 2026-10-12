import { Elysia, t } from "elysia";
import { extractBearerToken, timingSafeEqualStrings } from "../auth";
import { mailSubmissionsRepo } from "../db/mail-index";
import type {
  MailSubmissionsRepo,
  SubmissionRecord,
  Verdict,
} from "../db/mail-submissions";
import { env } from "../env";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface SySerendipityRequest {
  id: string;
  receivedAt: string;
  verdict: Verdict;
  delivered: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  numberOfPeople: string | null;
  destination: string | null;
  duration: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
  message: string | null;
}

// Whitelist projection: the LLM reason/confidence/model and jev_* columns stay
// inside the gateway.
function toRequest(record: SubmissionRecord): SySerendipityRequest {
  const field = (key: string): string | null => {
    const value = record.submission[key];
    return value === undefined || value === null ? null : String(value);
  };

  return {
    id: record.id,
    receivedAt: record.receivedAt,
    verdict: record.verdict,
    delivered: record.delivered,
    firstName: field("firstName"),
    lastName: field("lastName"),
    email: field("email"),
    phone: field("phone"),
    numberOfPeople: field("numberOfPeople"),
    destination: field("destination"),
    duration: field("duration"),
    arrivalDate: field("arrivalDate"),
    departureDate: field("departureDate"),
    message: field("message"),
  };
}

// Own guard on a fresh Elysia instance (hooks are instance-local), so neither
// the POST route's SECRET_KEY guard nor the host gate applies here. Unset key
// -> 404, like /api without API_KEY.
export function createSySerendipityRequestsRoutes({
  readKey,
  submissions = mailSubmissionsRepo,
}: {
  readKey: string | undefined;
  submissions?: MailSubmissionsRepo;
}) {
  return new Elysia()
    .onBeforeHandle(({ headers, set }) => {
      if (readKey === undefined) {
        set.status = 404;
        return { message: "Not Found" };
      }

      const token = extractBearerToken(headers.authorization);
      if (token && timingSafeEqualStrings(token, readKey)) return;

      set.status = 401;
      set.headers["WWW-Authenticate"] =
        `Bearer realm='sy-serendipity', error="invalid_token"`;
      return { message: "Unauthorized" };
    })
    .get(
      "/sy-serendipity/requests",
      ({ query }) => {
        const { data, total } = submissions.listBySource({
          source: "sy-serendipity",
          since: query.since ? new Date(query.since).toISOString() : undefined,
          limit: query.limit,
        });

        return { requests: data.map(toRequest), total };
      },
      {
        query: t.Object({
          since: t.Optional(t.String({ format: "date-time" })),
          limit: t.Numeric({
            minimum: 1,
            maximum: MAX_LIMIT,
            default: DEFAULT_LIMIT,
          }),
        }),
      },
    );
}

export const sySerendipityRequestsRoutes = createSySerendipityRequestsRoutes({
  readKey: env.SY_SERENDIPITY_READ_KEY,
});
