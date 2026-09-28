import { describe, expect, test } from "bun:test";
import { createMcpRoutes } from "./plugin";
import type { AgentApi } from "../services/agent-api";
import type { MessageEnvelope } from "../db/messages";

const API_KEY = "local-api-key-1234567";

function envelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    key: "msg-1",
    account: "proton:hello@example.com",
    direction: "inbound",
    fromAddress: "sender@example.com",
    toAddresses: ["hello@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Hello there",
    date: "2026-01-01T00:00:00.000Z",
    size: 1024,
    hasAttachments: false,
    threadKey: null,
    flags: [],
    ...overrides,
  };
}

function fakeAgentApi(overrides: Partial<AgentApi> = {}): AgentApi {
  return {
    searchMail: () => ({ via: "fts" as const, keys: [] }),
    readMessage: () => ({ ok: false as const, error: "not_found" as const }),
    getThread: () => ({ ok: false as const, error: "not_found" as const }),
    getThreadSummary: async () => ({
      ok: false as const,
      error: "not_found" as const,
    }),
    listNeedsAction: () => ({ rows: [], nextCursor: null }),
    draftReply: async () => ({
      ok: false as const,
      error: "not_found" as const,
    }),
    sendTemplate: () => ({ ok: false as const, error: "not_found" as const }),
    getJobStatus: () => ({ ok: false as const, error: "not_found" as const }),
    ...overrides,
  };
}

function testApp(apiKey: string | undefined, agentApi?: AgentApi) {
  return createMcpRoutes({ apiKey, agentApi: agentApi ?? fakeAgentApi() });
}

function rpcRequest(
  method: string,
  params: Record<string, unknown>,
  { key, path = "/mcp" }: { key?: string | undefined; path?: string } = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      // The streamable HTTP transport 406s a POST that does not accept both
      // media types, exactly as real MCP clients advertise them.
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

// The stateless legacy path answers a single JSON-RPC request either as a
// plain JSON body or as an SSE stream; normalise both to the JSON-RPC object.
async function rpcBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const json = contentType.includes("text/event-stream")
    ? (text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())[0] ?? "")
    : text;
  return JSON.parse(json) as Record<string, unknown>;
}

describe("MCP auth", () => {
  test("API_KEY unset -> the whole /mcp prefix 404s", async () => {
    const app = testApp(undefined);

    const response = await app.handle(
      rpcRequest("tools/call", {
        name: "search_mail",
        arguments: { q: "test" },
      }),
    );

    expect(response.status).toBe(404);
  });

  test("missing bearer -> 401", async () => {
    const app = testApp(API_KEY);

    const response = await app.handle(
      rpcRequest("tools/call", {
        name: "search_mail",
        arguments: { q: "test" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("wrong bearer -> 401", async () => {
    const app = testApp(API_KEY);

    const response = await app.handle(
      rpcRequest(
        "tools/call",
        { name: "search_mail", arguments: { q: "test" } },
        { key: "wrong-key-0123456789" },
      ),
    );

    expect(response.status).toBe(401);
  });
});

describe("MCP tools", () => {
  test("search_mail happy path returns the service result as structured content", async () => {
    const app = testApp(
      API_KEY,
      fakeAgentApi({
        searchMail: () => ({
          via: "fts" as const,
          keys: [
            {
              ...envelope({ key: "msg-1" }),
              locations: [],
              classification: null,
            },
          ],
        }),
      }),
    );

    const response = await app.handle(
      rpcRequest(
        "tools/call",
        { name: "search_mail", arguments: { q: "test" } },
        { key: API_KEY },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await rpcBody(response)) as {
      result: {
        isError?: boolean;
        structuredContent: { via: string; keys: { key: string }[] };
      };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.via).toBe("fts");
    expect(body.result.structuredContent.keys.map((row) => row.key)).toEqual([
      "msg-1",
    ]);
  });

  test("send_template returns the same unwrapped payload as POST /api/sends", async () => {
    const app = testApp(
      API_KEY,
      fakeAgentApi({
        sendTemplate: () => ({
          ok: true as const,
          sendLogId: "log-1",
          jobId: "job-1",
        }),
      }),
    );

    const response = await app.handle(
      rpcRequest(
        "tools/call",
        {
          name: "send_template",
          arguments: {
            templateId: "fpp-sender",
            to: "jane@example.com",
            templateProps: { name: "Jane" },
          },
        },
        { key: API_KEY },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await rpcBody(response)) as {
      result: { isError?: boolean; structuredContent: unknown };
    };
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual({
      enqueued: true,
      sendLogId: "log-1",
      jobId: "job-1",
    });
  });

  test("an upstream LLM failure is mapped to a stable code, never raw text", async () => {
    const app = testApp(
      API_KEY,
      fakeAgentApi({
        draftReply: async () => ({
          ok: false as const,
          error: "gateway 500: upstream exploded",
        }),
      }),
    );

    const response = await app.handle(
      rpcRequest(
        "tools/call",
        { name: "draft_reply", arguments: { key: "msg-1" } },
        { key: API_KEY },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await rpcBody(response)) as {
      result: { isError?: boolean; content: { type: string; text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("Error: internal_error");
    expect(body.result.content[0].text).not.toContain("upstream exploded");
  });

  test("a service ok:false outcome becomes an isError tool result naming the code", async () => {
    const app = testApp(
      API_KEY,
      fakeAgentApi({
        readMessage: () => ({
          ok: false as const,
          error: "not_found" as const,
        }),
      }),
    );

    const response = await app.handle(
      rpcRequest(
        "tools/call",
        { name: "read_message", arguments: { key: "missing" } },
        { key: API_KEY },
      ),
    );

    expect(response.status).toBe(200);
    const body = (await rpcBody(response)) as {
      result: { isError?: boolean; content: { type: string; text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not_found");
  });
});
