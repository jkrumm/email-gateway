import { describe, expect, test } from "bun:test";
import {
  createNanoClock,
  errorName,
  isSensitiveKey,
  parseOtlpHeadersEnv,
  parseResourceAttributesEnv,
  scrubText,
  severityFor,
  toLogAttributes,
} from "./otel-format";

describe("parseOtlpHeadersEnv", () => {
  test("parses comma-separated key=value pairs and trims them", () => {
    expect(parseOtlpHeadersEnv("x-foo=bar, x-baz=qux")).toEqual({
      "x-foo": "bar",
      "x-baz": "qux",
    });
  });

  test("splits only on the FIRST `=` so a value may itself contain `=`", () => {
    expect(parseOtlpHeadersEnv("authorization=Bearer abc=def")).toEqual({
      authorization: "Bearer abc=def",
    });
  });

  test("skips a pair with no `=`, an empty key, or an empty value", () => {
    expect(parseOtlpHeadersEnv("garbage,=novalue,nokey=,a=1")).toEqual({
      a: "1",
    });
  });

  test("returns an empty object for the empty string", () => {
    expect(parseOtlpHeadersEnv("")).toEqual({});
  });
});

describe("parseResourceAttributesEnv", () => {
  test("parses comma-separated key=value pairs and trims them", () => {
    expect(
      parseResourceAttributesEnv("host.name=vps, deployment.environment=prod"),
    ).toEqual({ "host.name": "vps", "deployment.environment": "prod" });
  });

  test("skips malformed pairs with no `=` and keeps the rest", () => {
    expect(parseResourceAttributesEnv("a=1,garbage,b=2")).toEqual({
      a: "1",
      b: "2",
    });
  });

  test("returns an empty object for the empty string", () => {
    expect(parseResourceAttributesEnv("")).toEqual({});
  });
});

describe("toLogAttributes", () => {
  test("passes strings, numbers and booleans through", () => {
    expect(toLogAttributes({ kind: "send", n: 3, ok: true })).toEqual({
      kind: "send",
      n: 3,
      ok: true,
    });
  });

  test("drops undefined and null", () => {
    expect(toLogAttributes({ a: 1, b: undefined, c: null })).toEqual({ a: 1 });
  });

  test("JSON.stringifies objects and arrays rather than dropping them", () => {
    expect(toLogAttributes({ raw: { x: 1 }, list: [1, 2] })).toEqual({
      raw: '{"x":1}',
      list: "[1,2]",
    });
  });

  test("renders an Error as `Name: message` (it JSON-stringifies to {})", () => {
    expect(toLogAttributes({ error: new TypeError("bad") })).toEqual({
      error: "TypeError: bad",
    });
  });

  test("drops sensitive keys outright", () => {
    expect(
      toLogAttributes({
        to: "a@b.example",
        subject: "482913 is your code",
        code: "482913",
        providerMessageId: "0100abc",
        kind: "sign-in",
      }),
    ).toEqual({ kind: "sign-in" });
  });

  test("scrubs address-shaped text out of string values", () => {
    expect(
      toLogAttributes({ note: "bounce for guest@example.com <id@mail.host>" }),
    ).toEqual({ note: "bounce for [redacted-email] <[redacted-email]>" });
  });
});

describe("isSensitiveKey", () => {
  test("matches the whole key and the last dot-segment, ignoring separators and case", () => {
    expect(isSensitiveKey("replyTo")).toBe(true);
    expect(isSensitiveKey("reply_to")).toBe(true);
    expect(isSensitiveKey("http.request.header.authorization")).toBe(true);
    expect(isSensitiveKey("message-id")).toBe(true);
    expect(isSensitiveKey("code")).toBe(true);
  });

  test("keeps the generic diagnostics keys", () => {
    expect(isSensitiveKey("email.template")).toBe(false);
    expect(isSensitiveKey("http.response.status_code")).toBe(false);
    expect(isSensitiveKey("error.code")).toBe(false);
    expect(isSensitiveKey("outcome")).toBe(false);
  });
});

describe("scrubText", () => {
  test("replaces every address-shaped token and leaves the rest", () => {
    expect(scrubText("from a.b+c@sub.example.org to x@y.io: nope")).toBe(
      "from [redacted-email] to [redacted-email]: nope",
    );
    expect(scrubText("no addresses here")).toBe("no addresses here");
  });
});

describe("severityFor", () => {
  test("is error for .failed and .error event names", () => {
    expect(severityFor("job.failed", {})).toBe("error");
    expect(severityFor("mcp.error", {})).toBe("error");
  });

  test("is warn for a truthy error field, .rejected, .rate_limited and .stalled", () => {
    expect(severityFor("llm.call", { error: "x" })).toBe("warn");
    expect(severityFor("synthesis.rejected", {})).toBe("warn");
    expect(severityFor("job.rate_limited", {})).toBe("warn");
    expect(severityFor("sync.stalled", {})).toBe("warn");
  });

  test("is info otherwise, including a falsy error field", () => {
    expect(severityFor("send.result", { status: "sent" })).toBe("info");
    expect(severityFor("llm.call", { error: "" })).toBe("info");
    expect(severityFor("llm.call", {})).toBe("info");
  });
});

describe("errorName", () => {
  test("is the error's name, or `Error` for anything else", () => {
    expect(errorName(new RangeError("x"))).toBe("RangeError");
    expect(errorName("a string")).toBe("Error");
    expect(errorName(undefined)).toBe("Error");
  });
});

describe("createNanoClock", () => {
  test("is the wall time at creation plus elapsed monotonic time", () => {
    let monotonic = 5_000;
    const now = createNanoClock(1_000, () => monotonic);

    expect(now()).toBe(1_000_000_000n);
    monotonic += 2_500;
    expect(now()).toBe(1_000_002_500n);
  });

  test("never goes backwards while the monotonic source does not", () => {
    let monotonic = 0;
    const now = createNanoClock(Date.now(), () => monotonic);
    const first = now();
    monotonic += 1;
    expect(now() >= first).toBe(true);
  });
});
