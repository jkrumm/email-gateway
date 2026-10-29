import { describe, expect, test } from "bun:test";
import { createAthenaRoutes } from "./athena";
import { TEMPLATE_IDS } from "../emails/registry";
import type { sendMail } from "../utils/send-mail";

type Sent = Parameters<typeof sendMail>[0];

const KEY = process.env.ATHENA_SECRET_KEY ?? "";
const valid = {
  kind: "sign-in",
  to: "person@iu.org",
  code: "482915",
  expiresInMinutes: 10,
};

function setup({
  keyConfigured = true,
  fail = false,
  fromEmail = "Athena <athena@sender.example>",
}: {
  keyConfigured?: boolean;
  fail?: boolean;
  fromEmail?: string | null;
} = {}) {
  const sent: Sent[] = [];
  const send = (async (input: Sent) => {
    if (fail) throw new Error("ses down");
    sent.push(input);
    return { id: "m", from: "f" };
  }) as typeof sendMail;
  const app = createAthenaRoutes({
    secretKey: keyConfigured ? KEY : undefined,
    fromEmail: fromEmail ?? undefined,
    replyTo: "owner@reply.example",
    send,
  });
  const post = (payload: unknown, token: string | null = KEY) =>
    app.handle(
      new Request("http://localhost/athena", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      }),
    );
  return { sent, post };
}

describe("POST /athena", () => {
  test("valid -> 200, one mail with the spaced-code subject, sender and reply-to", async () => {
    const { sent, post } = setup();
    const response = await post(valid);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "person@iu.org",
      from: "Athena <athena@sender.example>",
      replyTo: "owner@reply.example",
      subject: "Your Athena code: 482 915",
      source: TEMPLATE_IDS.athenaCode,
      sensitiveSubject: true,
      templateProps: expect.objectContaining({ code: "482915" }),
    });
  });

  test("an uppercase IU domain is accepted", async () => {
    const { sent, post } = setup();
    expect((await post({ ...valid, to: "Person@IU.ORG" })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test("no sender configured -> the default sender (no from passed)", async () => {
    const { sent, post } = setup({ fromEmail: null });
    expect((await post(valid)).status).toBe(200);
    expect(sent[0]).not.toHaveProperty("from");
  });

  test("unset key -> 404, nothing sent", async () => {
    const { sent, post } = setup({ keyConfigured: false });
    expect((await post(valid)).status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("missing or wrong bearer -> 401", async () => {
    const { sent, post } = setup();
    expect((await post(valid, null)).status).toBe(401);
    expect((await post(valid, "nope")).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  test("the shared SECRET_KEY and the Shutterflow key do not open it", async () => {
    const { post } = setup();
    expect((await post(valid, "test-secret-key")).status).toBe(401);
    expect(
      (await post(valid, "test-shutterflow-secret-key-0123456789")).status,
    ).toBe(401);
  });

  test.each([
    { ...valid, kind: "forget-password" },
    { ...valid, to: "not-an-email" },
    { ...valid, to: "person@example.com" },
    { ...valid, to: "person@iu.org.evil.example" },
    { ...valid, to: "person@sub.iu.org" },
    { ...valid, to: "person@iu-study.org" },
    { ...valid, to: "a@iu.org, b@iu.org" },
    { ...valid, to: "a@iu.org,b@example.com" },
    { ...valid, to: ["a@iu.org", "b@iu.org"] },
    { ...valid, code: "12345" },
    { ...valid, code: "1234567" },
    { ...valid, code: "12a456" },
    { ...valid, code: "482915\n" },
    { ...valid, expiresInMinutes: 0 },
    { ...valid, expiresInMinutes: 16 },
  ])("invalid body -> 422", async (payload) => {
    const { sent, post } = setup();
    expect((await post(payload)).status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  test("provider error -> 502", async () => {
    const { post } = setup({ fail: true });
    expect((await post(valid)).status).toBe(502);
  });
});
