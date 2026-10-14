import { describe, expect, test } from "bun:test";
import {
  _test,
  activateSpan,
  emitOtelLog,
  flushOtel,
  getActiveSpan,
  startSpan,
  traceIdFromJobId,
  withRootSpan,
  withSpan,
  type SpanRecord,
} from "./otel";

// OTEL_EXPORTER_OTLP_ENDPOINT is unset under `bun test` (src/test/setup.ts), the
// production-realistic "disabled" path: every assertion observes the real records through
// the `_test` hooks, which fire regardless of that gate.

function byName(records: SpanRecord[], name: string): SpanRecord {
  const found = records.find((r) => r.name === name);
  if (!found) {
    throw new Error(
      `no span named ${name} in [${records.map((r) => r.name).join(", ")}]`,
    );
  }
  return found;
}

describe("traceIdFromJobId", () => {
  test("returns the dash-stripped UUID as 32 lowercase hex", () => {
    expect(traceIdFromJobId("0189D4F1-2A3B-4C5D-8E9F-A0B1C2D3E4F5")).toBe(
      "0189d4f12a3b4c5d8e9fa0b1c2d3e4f5",
    );
  });

  test("falls back to a fresh random trace id for a non-UUID job id", () => {
    const a = traceIdFromJobId("job-17");
    const b = traceIdFromJobId("job-17");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("span context propagation", () => {
  test("parents a nested withSpan to its root and keeps the root trace id", async () => {
    const capture = _test.capture();
    const traceId = traceIdFromJobId("0189d4f1-2a3b-4c5d-8e9f-a0b1c2d3e4f5");
    let rootSpanId = "";
    await withRootSpan({ traceId, name: "job.x" }, async (root) => {
      rootSpanId = root.spanId;
      await withSpan("child", {}, async () => {});
    });
    capture.stop();

    const child = byName(capture.spans, "child");
    expect(child.traceId).toBe(traceId);
    expect(child.parentSpanId).toBe(rootSpanId);
    expect(byName(capture.spans, "job.x").parentSpanId).toBeUndefined();
  });

  test("a root span is a root even when started inside another span", async () => {
    const capture = _test.capture();
    await withSpan("outer", {}, async () => {
      await withRootSpan(
        { traceId: traceIdFromJobId("-"), name: "job.inner" },
        async () => {},
      );
    });
    capture.stop();

    expect(byName(capture.spans, "job.inner").parentSpanId).toBeUndefined();
  });

  test("parents concurrent siblings to the root, not to each other", async () => {
    const capture = _test.capture();
    let rootSpanId = "";
    await withRootSpan(
      { traceId: traceIdFromJobId("-"), name: "job.x" },
      async (root) => {
        rootSpanId = root.spanId;
        await Promise.all([
          withSpan("a", {}, async () => {}),
          withSpan("b", {}, async () => {}),
        ]);
      },
    );
    capture.stop();

    const a = byName(capture.spans, "a");
    const b = byName(capture.spans, "b");
    expect(a.parentSpanId).toBe(rootSpanId);
    expect(b.parentSpanId).toBe(rootSpanId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  test("activateSpan makes a detached span the parent for the rest of the flow", async () => {
    const capture = _test.capture();
    // A fresh async flow, as a request handler would have.
    await (async () => {
      const span = startSpan("GET", {}, "server");
      activateSpan(span);
      expect(getActiveSpan().spanId).toBe(span.spanId);
      await withSpan("handler", {}, async () => {});
      span.end();
    })();
    capture.stop();

    expect(byName(capture.spans, "handler").parentSpanId).toBe(
      byName(capture.spans, "GET").spanId,
    );
  });
});

describe("withSpan", () => {
  test("records the exception TYPE only, marks the span errored, and re-throws", async () => {
    const capture = _test.capture();
    let thrown: unknown = null;
    try {
      await withSpan("boom", {}, async () => {
        throw new Error("kaboom");
      });
    } catch (err) {
      thrown = err;
    }
    capture.stop();

    expect(thrown).toBeInstanceOf(Error);
    const span = byName(capture.spans, "boom");
    expect(span.status).toEqual({ code: 2, message: "Error" });
    expect(
      span.events?.find((e) => e.name === "exception")?.attributes,
    ).toEqual([{ key: "exception.type", value: { stringValue: "Error" } }]);
    expect(JSON.stringify(capture.spans)).not.toContain("kaboom");
  });

  test("a status the callback set itself is kept on return", async () => {
    const capture = _test.capture();
    await withSpan("custom", {}, async (span) => {
      span.setStatus("error", "handled failure");
    });
    capture.stop();

    expect(byName(capture.spans, "custom").status.code).toBe(2);
  });

  test("ends ok when nothing set a status", async () => {
    const capture = _test.capture();
    await withSpan("fine", {}, async () => {});
    capture.stop();

    expect(byName(capture.spans, "fine").status.code).toBe(1);
  });
});

describe("redaction at the exporter", () => {
  test("sensitive attribute keys never reach a span record", async () => {
    const capture = _test.capture();
    await withSpan(
      "ses.send",
      {
        "email.template": "shutterflow-code",
        to: "guest@example.com",
        code: "482913",
      },
      async () => {},
    );
    capture.stop();

    const json = JSON.stringify(capture.spans);
    expect(json).toContain("shutterflow-code");
    expect(json).not.toContain("guest@example.com");
    expect(json).not.toContain("482913");
  });

  test("an error's message and stack never reach a span", async () => {
    const capture = _test.capture();
    await withSpan("fail", {}, async () => {
      throw new TypeError("subject 482913 for guest@example.com rejected");
    }).catch(() => {});
    capture.stop();

    const json = JSON.stringify(capture.spans);
    expect(json).not.toContain("482913");
    expect(json).not.toContain("guest@example.com");
    expect(json).not.toContain("stacktrace");
    expect(byName(capture.spans, "fail").status.message).toBe("TypeError");
  });

  test("log bodies and attributes are scrubbed too", () => {
    const capture = _test.capture();
    emitOtelLog("bounce for guest@example.com", {
      note: "ping other@example.com",
      subject: "482913 is your code",
    });
    capture.stop();

    const json = JSON.stringify(capture.logs);
    expect(json).not.toContain("example.com");
    expect(json).not.toContain("482913");
  });
});

describe("emitOtelLog", () => {
  test("maps the event name to the body and classifies severity", () => {
    const capture = _test.capture();
    emitOtelLog("job.failed", { kind: "send" });
    capture.stop();

    const [record] = capture.logs;
    expect(record?.body.stringValue).toBe("job.failed");
    expect(record?.severityText).toBe("ERROR");
    expect(record?.severityNumber).toBe(17);
    expect(record?.attributes).toContainEqual({
      key: "kind",
      value: { stringValue: "send" },
    });
  });

  test("an explicit severity wins over the name", () => {
    const capture = _test.capture();
    emitOtelLog("ses.event", {}, "warn");
    capture.stop();

    expect(capture.logs[0]?.severityText).toBe("WARN");
  });

  test("stamps the active span ids inside a span and none outside one", async () => {
    const capture = _test.capture();
    let ids = { traceId: "", spanId: "" };
    await withSpan("job", {}, async (span) => {
      ids = { traceId: span.traceId, spanId: span.spanId };
      emitOtelLog("inside", {});
    });
    emitOtelLog("outside", {});
    capture.stop();

    const inside = capture.logs.find((r) => r.body.stringValue === "inside");
    expect(inside?.traceId).toBe(ids.traceId);
    expect(inside?.spanId).toBe(ids.spanId);
    const outside = capture.logs.find((r) => r.body.stringValue === "outside");
    expect(outside?.traceId).toBeUndefined();
  });
});

describe("OTLP payloads", () => {
  test("carry the service.name resource on both signals", () => {
    const resourceOf = (payload: object, key: string) =>
      JSON.stringify((payload as Record<string, unknown[]>)[key]);
    expect(resourceOf(_test.tracesPayload([]), "resourceSpans")).toContain(
      '{"key":"service.name","value":{"stringValue":"email-gateway"}}',
    );
    expect(resourceOf(_test.logsPayload([]), "resourceLogs")).toContain(
      '"service.name"',
    );
  });
});

/** Swap in a `fetch` stub for the duration of `fn`, always restoring the real one. */
async function withStubbedFetch(
  stub: () => Promise<unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("postBatch", () => {
  test("resolves rather than throwing when the collector is unreachable", async () => {
    await withStubbedFetch(
      () => Promise.reject(new Error("connection refused")),
      async () => {
        await expect(
          _test.postBatch("http://collector.invalid/v1/traces", {}),
        ).resolves.toBeUndefined();
      },
    );
  });

  test("resolves rather than throwing when the collector rejects the batch", async () => {
    await withStubbedFetch(
      () =>
        Promise.resolve({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        }),
      async () => {
        await expect(
          _test.postBatch("http://collector.invalid/v1/traces", {}),
        ).resolves.toBeUndefined();
      },
    );
  });
});

describe("flushOtel", () => {
  test("resolves without throwing while a post is outstanding", async () => {
    await withStubbedFetch(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, status: 200, statusText: "OK" }),
            1,
          ),
        ),
      async () => {
        void _test.postBatch("http://collector.invalid/v1/logs", {});
        await expect(flushOtel()).resolves.toBeUndefined();
      },
    );
  });
});
