import { describe, expect, test } from "bun:test";
import { createJkrummContactRoutes } from "./jkrumm-contact";
import { TEMPLATE_IDS } from "../emails/registry";
import type { SubmissionRecord } from "../db/mail-submissions";
import { gateSubmission } from "../spam/gate";
import type { sendMail } from "../utils/send-mail";

type Sent = Parameters<typeof sendMail>[0];

const ORIGIN = "https://site.example";

function setup(origins: string[] = [ORIGIN]) {
  const sent: Sent[] = [];
  const gated: Parameters<typeof gateSubmission>[0][] = [];
  const gate = (async (input) => {
    gated.push(input);
    await input.deliver({ subjectPrefix: "" });
    return { delivered: true };
  }) as typeof gateSubmission;
  const send = (async (input: Sent) => {
    sent.push(input);
    return { id: "m", from: "f" };
  }) as typeof sendMail;
  const app = createJkrummContactRoutes({
    origins,
    gate,
    send,
    receiverEmail: "owner@example.com",
  });
  const post = (payload: unknown, origin: string | null = ORIGIN) =>
    app.handle(
      new Request("http://localhost/jkrumm-contact", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(payload),
      }),
    );
  return { app, sent, gated, post };
}

const valid = { name: "Jane", email: "jane@example.com", message: "Hi there" };

describe("POST /jkrumm-contact", () => {
  test("allowed origin -> 200, CORS headers, one receiver mail with replyTo", async () => {
    const { sent, gated, post } = setup();
    const response = await post(valid);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Message sent successfully",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(gated[0]?.source).toBe("jkrumm-contact");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "owner@example.com",
      replyTo: "Jane <jane@example.com>",
      source: TEMPLATE_IDS.jkrummContactReceiver,
    });
  });

  test("null name is accepted", async () => {
    const { sent, post } = setup();
    const response = await post({ ...valid, name: null });

    expect(response.status).toBe(200);
    expect(sent[0]?.replyTo).toBe("jane@example.com");
  });

  test("wrong or missing Origin -> 403, nothing sent", async () => {
    const { sent, post } = setup();

    expect((await post(valid, "https://evil.example")).status).toBe(403);
    expect((await post(valid, null)).status).toBe(403);
    expect(sent).toEqual([]);
  });

  test("wrong Origin with an invalid body is still 403, not 422", async () => {
    const { post } = setup();

    expect((await post({}, "https://evil.example")).status).toBe(403);
  });

  test("a trailing slash gets the same Origin check", async () => {
    const { app, sent } = setup();
    const response = await app.handle(
      new Request("http://localhost/jkrumm-contact/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify(valid),
      }),
    );

    expect(response.status).toBe(403);
    expect(sent).toEqual([]);
  });

  test("replyTo drops header-breaking characters from the name", async () => {
    const { sent, post } = setup();
    await post({ ...valid, name: 'Eve\r\nBcc: x@y.z" <a@b.c>,' });

    expect(sent[0]?.replyTo).not.toMatch(/[\r\n,"]/);
    expect(sent[0]?.replyTo).toEndWith("<jane@example.com>");
  });

  test("no origins configured -> 404", async () => {
    const { post } = setup([]);

    expect((await post(valid)).status).toBe(404);
  });

  test("honeypot -> 200, gate and send untouched", async () => {
    const { sent, gated, post } = setup();
    const response = await post({ ...valid, website: "http://spam.example" });

    expect(response.status).toBe(200);
    expect(gated).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("an empty honeypot field is a real submission", async () => {
    const { sent, post } = setup();
    await post({ ...valid, website: "" });

    expect(sent).toHaveLength(1);
  });

  test("validation -> 422", async () => {
    const { sent, post } = setup();

    const invalid = await post({ ...valid, email: "nope" });
    expect(invalid.status).toBe(422);
    expect(invalid.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await post({ ...valid, message: "" })).status).toBe(422);
    expect((await post({ ...valid, message: "x".repeat(5001) })).status).toBe(
      422,
    );
    expect((await post({ ...valid, name: "x".repeat(201) })).status).toBe(422);
    expect(sent).toEqual([]);
  });

  test("the honeypot is not stored with the submission", async () => {
    const { gated, post } = setup();
    await post({ ...valid, website: "" });

    expect(gated[0]?.submission).toEqual(valid);
  });
});

describe("POST /jkrumm-contact through the real gate", () => {
  test("records a jkrumm-contact submission and enqueues jev_submission", async () => {
    const recorded: { source: string }[] = [];
    const enqueued: string[] = [];
    const app = createJkrummContactRoutes({
      origins: [ORIGIN],
      receiverEmail: "owner@example.com",
      send: (async () => ({ id: "m", from: "f" })) as typeof sendMail,
      gate: (input) =>
        gateSubmission({
          ...input,
          classify: async () => ({
            verdict: "legit",
            confidence: 0.9,
            reason: "ok",
            model: "m",
          }),
          record: (row) => {
            recorded.push(row);
            return { id: "row-1" } as SubmissionRecord;
          },
          jevEnabled: () => true,
          enqueueJevSubmission: (id) => enqueued.push(id),
        }),
    });

    const response = await app.handle(
      new Request("http://localhost/jkrumm-contact", {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(valid),
      }),
    );

    expect(response.status).toBe(200);
    expect(recorded.map((row) => row.source)).toEqual(["jkrumm-contact"]);
    expect(enqueued).toEqual(["row-1"]);
  });
});

describe("OPTIONS /jkrumm-contact", () => {
  const preflight = (app: ReturnType<typeof setup>["app"], origin?: string) =>
    app.handle(
      new Request("http://localhost/jkrumm-contact", {
        method: "OPTIONS",
        headers: origin ? { origin } : {},
      }),
    );

  test("allowed origin -> 204 with POST + Content-Type", async () => {
    const response = await preflight(setup().app, ORIGIN);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Content-Type",
    );
  });

  test("other origin -> 403 without CORS headers", async () => {
    const response = await preflight(setup().app, "https://evil.example");

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
