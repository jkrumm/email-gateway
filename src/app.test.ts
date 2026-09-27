import { describe, expect, test } from "bun:test";
import { app } from "./app";

describe("app", () => {
  test("GET /health returns ok", async () => {
    const response = await app.handle(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("POST /fpp without bearer returns 400 Unauthorized", async () => {
    const response = await app.handle(
      new Request("http://localhost/fpp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          email: "test@example.com",
          subject: "Hi",
          message: "Hello",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Unauthorized" });
  });

  test("POST /sy-serendipity with valid bearer but invalid body returns 422", async () => {
    const response = await app.handle(
      new Request("http://localhost/sy-serendipity", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.SECRET_KEY}`,
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(422);
  });
});
