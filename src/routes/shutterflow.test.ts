import { describe, expect, test } from "bun:test";
import { createShutterflowRoutes } from "./shutterflow";
import { TEMPLATE_IDS } from "../emails/registry";
import type { sendMail } from "../utils/send-mail";

type Sent = Parameters<typeof sendMail>[0];

const KEY = process.env.SHUTTERFLOW_SECRET_KEY ?? "";
const valid = {
  kind: "sign-in",
  to: "user@example.com",
  code: "482913",
  expiresInMinutes: 10,
};

function setup({
  keyConfigured = true,
  fail = false,
}: { keyConfigured?: boolean; fail?: boolean } = {}) {
  const sent: Sent[] = [];
  const send = (async (input: Sent) => {
    if (fail) throw new Error("ses down");
    sent.push(input);
    return { id: "m", from: "f" };
  }) as typeof sendMail;
  const app = createShutterflowRoutes({
    secretKey: keyConfigured ? KEY : undefined,
    fromEmail: "Shutterflow <no-reply@shutterflow.example>",
    send,
  });
  const post = (payload: unknown, token: string | null = KEY) =>
    app.handle(
      new Request("http://localhost/shutterflow", {
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

describe("POST /shutterflow", () => {
  test("valid -> 200, one mail with the code subject and redacted logs", async () => {
    const { sent, post } = setup();
    const response = await post(valid);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "user@example.com",
      from: "Shutterflow <no-reply@shutterflow.example>",
      subject: "482913 is your Shutterflow sign-in code",
      source: TEMPLATE_IDS.shutterflowCode,
      sensitiveSubject: true,
    });
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

  test("the shared SECRET_KEY does not open it", async () => {
    const { post } = setup();
    expect((await post(valid, "test-secret-key")).status).toBe(401);
  });

  test.each([
    { ...valid, kind: "other" },
    { ...valid, to: "not-an-email" },
    { ...valid, code: "<script>" },
    { ...valid, expiresInMinutes: 0 },
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
