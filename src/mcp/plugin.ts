import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { Elysia } from "elysia";
import { z } from "zod";
import { extractBearerToken, timingSafeEqualStrings } from "../auth";
import { env } from "../env";
import {
  agentErrorStatus,
  createAgentApi,
  isInvalidCursorError,
  type AgentApi,
} from "../services/agent-api";
import { splitCsv } from "../utils/csv";

// The MCP door onto the same service layer the REST routes use (docs/
// architecture.md §Agent API): seven tools, each a thin wrapper over one
// createAgentApi method. There is deliberately no job_wait tool — every call
// here resolves synchronously, and the one enqueueing tool (send_template)
// returns its job id like POST /api/sends does.

// Routes a service outcome's error through the same public mapping the REST
// routes use, so an unrecognized (upstream LLM/provider) error collapses to a
// stable code instead of forwarding raw upstream text to the caller.
function errorResult(error: string): CallToolResult {
  const { code } = agentErrorStatus(error);
  return { content: [{ type: "text", text: `Error: ${code}` }], isError: true };
}

function okResult(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function buildMcpServer(service: AgentApi): McpServer {
  const server = new McpServer({ name: "email-gateway", version: "1.0.0" });

  server.registerTool(
    "search_mail",
    {
      title: "Search mail",
      description:
        "Full-text search over synced message envelopes (subject, addresses and classification summaries — never bodies). Returns the matching message summaries, newest first.",
      inputSchema: z.object({
        q: z.string().describe("Search query"),
        account: z
          .string()
          .optional()
          .describe("Comma-separated account ids to restrict to"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      outputSchema: z.object({
        via: z.literal("fts"),
        keys: z.array(z.unknown()),
      }),
    },
    ({ q, account, limit }) =>
      okResult(
        service.searchMail({
          q,
          accountIds: splitCsv(account),
          limit,
        }),
      ),
  );

  server.registerTool(
    "read_message",
    {
      title: "Read message",
      description:
        "One message's envelope, locations and classification. Pass includeBody: true for the cached html/text body; the body is only ever read from the cache, never fetched live.",
      inputSchema: z.object({
        key: z.string().describe("The message's key"),
        includeBody: z.boolean().optional(),
      }),
      outputSchema: z.looseObject({}),
    },
    ({ key, includeBody }) => {
      const outcome = service.readMessage({ key, includeBody });
      if (!outcome.ok) return errorResult(outcome.error);
      // Unwrapped: GET /api/messages/:key returns the message object itself.
      return okResult(outcome.message);
    },
  );

  server.registerTool(
    "summarize_thread",
    {
      title: "Summarize thread",
      description:
        "A 2-4 sentence LLM summary of the thread a message belongs to, cached on the thread until a new message arrives.",
      inputSchema: z.object({
        key: z.string().describe("Any message key in the thread"),
      }),
      outputSchema: z.object({
        summary: z.string(),
        model: z.string().nullable(),
        messageCount: z.number(),
        cached: z.boolean(),
      }),
    },
    async ({ key }) => {
      const outcome = await service.getThreadSummary({ key });
      if (!outcome.ok) return errorResult(outcome.error);
      // Unwrapped: GET /api/threads/:key/summary returns these four fields.
      return okResult({
        summary: outcome.summary,
        model: outcome.model,
        messageCount: outcome.messageCount,
        cached: outcome.cached,
      });
    },
  );

  server.registerTool(
    "needs_action",
    {
      title: "Needs action",
      description:
        "Messages the classifier flagged as requiring action, newest first, keyset-paginated. Pass the returned nextCursor back as cursor to page.",
      inputSchema: z.object({
        account: z
          .string()
          .optional()
          .describe("Comma-separated account ids to restrict to"),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      }),
      outputSchema: z.object({
        rows: z.array(z.unknown()),
        nextCursor: z.string().nullable(),
      }),
    },
    ({ account, since, until, limit, cursor }) => {
      try {
        return okResult(
          service.listNeedsAction({
            accountIds: splitCsv(account),
            since,
            until,
            limit,
            cursor,
          }),
        );
      } catch (error) {
        if (!isInvalidCursorError(error)) throw error;
        return errorResult("invalid_cursor");
      }
    },
  );

  server.registerTool(
    "draft_reply",
    {
      title: "Draft reply",
      description:
        "Draft a reply as the owner would write it, plain text. Uses the cached body or one live provider read if uncached. Text only — this never sends.",
      inputSchema: z.object({
        key: z.string().describe("The message to reply to"),
        instructions: z
          .string()
          .optional()
          .describe("Trusted tone/content instructions for the draft"),
      }),
      outputSchema: z.object({
        draft: z.string(),
        model: z.string(),
      }),
    },
    async ({ key, instructions }) => {
      const outcome = await service.draftReply({ key, instructions });
      if (!outcome.ok) return errorResult(outcome.error);
      // Unwrapped: POST /api/drafts returns { draft, model }.
      return okResult({ draft: outcome.draft, model: outcome.model });
    },
  );

  server.registerTool(
    "send_template",
    {
      title: "Send template",
      description:
        "Enqueue a registered email template send. Returns the send job id; it does not wait for delivery — poll job_status for it.",
      inputSchema: z.object({
        templateId: z.string(),
        to: z.email(),
        templateProps: z.record(z.string(), z.unknown()),
        subject: z.string().optional(),
        replyTo: z.email().optional(),
      }),
      outputSchema: z.object({
        enqueued: z.literal(true),
        sendLogId: z.string(),
        jobId: z.string(),
      }),
    },
    ({ templateId, to, templateProps, subject, replyTo }) => {
      const outcome = service.sendTemplate({
        templateId,
        to,
        templateProps,
        subject,
        replyTo,
      });
      if (!outcome.ok) return errorResult(outcome.error);
      // Unwrapped: POST /api/sends returns { enqueued, sendLogId, jobId }.
      return okResult({
        enqueued: true,
        sendLogId: outcome.sendLogId,
        jobId: outcome.jobId,
      });
    },
  );

  server.registerTool(
    "job_status",
    {
      title: "Job status",
      description:
        "One background job's status, attempts and last error, by the id a tool or route returned.",
      inputSchema: z.object({
        jobId: z.string(),
      }),
      outputSchema: z.looseObject({}),
    },
    ({ jobId }) => {
      const outcome = service.getJobStatus({ jobId });
      if (!outcome.ok) return errorResult(outcome.error);
      // Unwrapped: GET /api/jobs/:id returns the job object itself.
      return okResult(outcome.job);
    },
  );

  return server;
}

export function createMcpRoutes({
  apiKey,
  agentApi,
}: {
  apiKey: string | undefined;
  // Injectable for tests; defaults to the production service layer, the same
  // singletons src/api/plugin.ts's routes default to.
  agentApi?: AgentApi;
}) {
  const configured = apiKey !== undefined;
  const service = agentApi ?? createAgentApi();
  const handler = createMcpHandler(() => buildMcpServer(service), {
    responseMode: "sse",
    onerror: (error) => {
      console.error("MCP handler error", { error });
    },
  });

  return (
    new Elysia({ prefix: "/mcp" })
      // Bearer-only, agent-facing: no session-cookie alternative here, unlike
      // /api. Unset API_KEY 404s the whole prefix, matching /api's own guard.
      .onBeforeHandle(({ headers, set }) => {
        if (!configured) {
          set.status = 404;
          return { error: "not_found" };
        }

        const token = extractBearerToken(headers.authorization);

        if (
          token &&
          apiKey !== undefined &&
          timingSafeEqualStrings(token, apiKey)
        )
          return;

        set.status = 401;
        set.headers["WWW-Authenticate"] =
          `Bearer realm='mcp', error="invalid_token"`;
        return { error: "unauthorized" };
      })
      // Hidden from the OpenAPI surface: this is a protocol endpoint, not a
      // documented JSON route. Both verbs hand the raw Request to the handler.
      .post("/", ({ request }) => handler.fetch(request), {
        detail: { hide: true },
      })
      .get("/", ({ request }) => handler.fetch(request), {
        detail: { hide: true },
      })
  );
}

export const mcpRoutes = createMcpRoutes({ apiKey: env.API_KEY });
