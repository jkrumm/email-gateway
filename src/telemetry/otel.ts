import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../env";
import {
  createNanoClock,
  errorName,
  parseOtlpHeadersEnv,
  parseResourceAttributesEnv,
  scrubText,
  toLogAttributes,
  severityFor,
  type LogSeverity,
} from "./otel-format";

// Owns ALL OTel wiring for this service — traces AND logs, exported as OTLP/HTTP JSON over
// plain `fetch`, no OpenTelemetry SDK (the same house pattern as research-gateway and
// audio-gateway, running against the same ClickStack collector). SDK-free on purpose:
// `@opentelemetry/context-async-hooks` is not certified on Bun, and `@elysiajs/opentelemetry`
// builds on it. Parent/child propagation here is a plain `AsyncLocalStorage`.
//
// Not used, on purpose: the AI SDK's own `experimental_telemetry`, which records prompts and
// outputs — mail content must never reach a span.
//
// Disabled — a total no-op on the network path — unless OTEL_EXPORTER_OTLP_ENDPOINT is set
// (the default in local dev and every test). Span/log record CONSTRUCTION always happens: it
// is cheap bookkeeping, and it is what makes this module testable without a collector; only
// the queue-and-fetch step is gated.
//
// Metrics are deliberately not an OTel signal here: the dashboards and alerts are ClickStack
// tiles over spans and logs, so counters travel as named structured log events (log.ts's
// `event`).

const ENDPOINT = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, "");
const ENABLED = Boolean(ENDPOINT);

// ── Attribute values ─────────────────────────────────────────────────────────

type AttrValue = string | number | boolean;
export type SpanAttributes = Record<string, AttrValue | null | undefined>;

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

function toOtlpValue(v: AttrValue): OtlpValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: v };
}

type OtlpAttribute = { key: string; value: OtlpValue };

/**
 * Every attribute of every signal passes through here: sensitive keys are dropped and
 * address-shaped text is scrubbed (see otel-format.ts), so a call site that gets it wrong
 * still cannot ship mail content.
 */
function toOtlpAttributes(attrs: Record<string, unknown>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(toLogAttributes(attrs))) {
    out.push({ key, value: toOtlpValue(value) });
  }
  return out;
}

const RESOURCE = {
  attributes: toOtlpAttributes({
    "service.name": env.OTEL_SERVICE_NAME,
    "deployment.environment": process.env["NODE_ENV"] ?? "development",
    ...parseResourceAttributesEnv(env.OTEL_RESOURCE_ATTRIBUTES ?? ""),
  }),
};

// ── IDs ──────────────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive a 32-hex OTel trace id from a job id when it is UUID-shaped (dashes stripped), so a
 * job's trace joins its `jobs` row on a value that already exists. Any other id gets a fresh
 * random trace id.
 */
export function traceIdFromJobId(jobId: string): string {
  const hex = jobId.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : newTraceId();
}

function newTraceId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

function newSpanId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)));
}

const nowNanos = createNanoClock(Date.now(), () => Bun.nanoseconds());

// ── Span kind / status codes (OTLP proto enums) ──────────────────────────────

export type SpanKind = "internal" | "server" | "client";
const KIND_CODE: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
};

export type StatusCode = "unset" | "ok" | "error";
const STATUS_CODE: Record<StatusCode, number> = { unset: 0, ok: 1, error: 2 };

// ── Span ─────────────────────────────────────────────────────────────────────

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setName(name: string): void;
  setAttributes(attrs: SpanAttributes): void;
  setStatus(code: StatusCode, message?: string): void;
  recordException(err: unknown): void;
  addEvent(name: string, attrs?: SpanAttributes): void;
  end(attrs?: SpanAttributes): void;
}

interface SpanEventData {
  name: string;
  timeUnixNano: string;
  attributes: SpanAttributes;
}

interface InternalSpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: bigint;
  attributes: SpanAttributes;
  statusCode: StatusCode;
  statusMessage: string | undefined;
  events: SpanEventData[];
  ended: boolean;
}

const currentSpan = new AsyncLocalStorage<InternalSpanData>();
const publicSpans = new WeakMap<InternalSpanData, Span>();
const spanData = new WeakMap<Span, InternalSpanData>();

const NOOP_SPAN: Span = {
  traceId: "",
  spanId: "",
  setName() {},
  setAttributes() {},
  setStatus() {},
  recordException() {},
  addEvent() {},
  end() {},
};

function createSpanData(
  name: string,
  kind: SpanKind,
  attrs?: SpanAttributes,
  explicitTraceId?: string,
): InternalSpanData {
  const parent = currentSpan.getStore();
  return {
    traceId: explicitTraceId ?? parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    // An explicit trace id starts a root: a parent from another trace would be a dangling link.
    parentSpanId: explicitTraceId ? undefined : parent?.spanId,
    name,
    kind,
    startTimeUnixNano: nowNanos(),
    attributes: { ...attrs },
    statusCode: "unset",
    statusMessage: undefined,
    events: [],
    ended: false,
  };
}

function toPublicSpan(data: InternalSpanData): Span {
  const cached = publicSpans.get(data);
  if (cached) return cached;
  const span: Span = {
    traceId: data.traceId,
    spanId: data.spanId,
    setName(name: string): void {
      data.name = name;
    },
    setAttributes(attrs: SpanAttributes): void {
      Object.assign(data.attributes, attrs);
    },
    setStatus(code: StatusCode, message?: string): void {
      data.statusCode = code;
      if (message) data.statusMessage = message;
    },
    // The type only — never `exception.message` or a stacktrace, which can echo the mail
    // being handled. Debug detail lives in the (console) logs, not on spans.
    recordException(err: unknown): void {
      data.events.push({
        name: "exception",
        timeUnixNano: nowNanos().toString(),
        attributes: { "exception.type": errorName(err) },
      });
    },
    addEvent(name: string, attrs?: SpanAttributes): void {
      data.events.push({
        name,
        timeUnixNano: nowNanos().toString(),
        attributes: { ...attrs },
      });
    },
    end(attrs?: SpanAttributes): void {
      if (data.ended) return;
      if (attrs) Object.assign(data.attributes, attrs);
      data.ended = true;
      exportSpan(data);
    },
  };
  publicSpans.set(data, span);
  spanData.set(span, data);
  return span;
}

/** The currently active span (via `withSpan`/`withRootSpan`/`activateSpan`), or a no-op span. */
export function getActiveSpan(): Span {
  const data = currentSpan.getStore();
  return data ? toPublicSpan(data) : NOOP_SPAN;
}

async function runInSpan<T>(
  data: InternalSpanData,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = toPublicSpan(data);
  return currentSpan.run(data, async () => {
    try {
      const result = await fn(span);
      if (data.statusCode === "unset") span.setStatus("ok");
      return result;
    } catch (err) {
      // A callback that already described its own failure (status error set) keeps that
      // description — the way for a span whose error text must not be recorded.
      if (data.statusCode !== "error") {
        span.setStatus("error", errorName(err));
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Run `fn` inside a new child span (parent = whatever span is currently active). Ends the
 * span on settle either way, marking error status + recording the exception on a throw
 * (unless `fn` already set an error status itself), which it then re-throws — this wraps a
 * step, it does not swallow its failure.
 */
export function withSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = "internal",
): Promise<T> {
  return runInSpan(createSpanData(name, kind, attrs), fn);
}

/**
 * Run `fn` inside a new ROOT span with an explicit trace id (see `traceIdFromJobId`). A
 * status the callback sets itself is kept; otherwise ok on return, error on a throw.
 */
export function withRootSpan<T>(
  params: {
    traceId: string;
    name: string;
    attrs?: SpanAttributes;
    kind?: SpanKind;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const data = createSpanData(
    params.name,
    params.kind ?? "internal",
    params.attrs,
    params.traceId,
  );
  return runInSpan(data, fn);
}

/**
 * A span that is not bound to a callback — for lifecycle hooks (Elysia's onRequest /
 * onAfterResponse) where start and end happen in different functions. The caller must
 * `end()` it; call `activateSpan` to make it the active span for the rest of the async
 * flow so spans and logs created below it link to it.
 */
export function startSpan(
  name: string,
  attrs: SpanAttributes = {},
  kind: SpanKind = "internal",
): Span {
  return toPublicSpan(createSpanData(name, kind, attrs));
}

/**
 * Make `span` the active span for the remainder of the current async flow (`enterWith`).
 * Verified on Bun against Elysia's onRequest hook: the store follows the request's own
 * continuation and does not leak into other requests or timers.
 */
export function activateSpan(span: Span): void {
  const data = spanData.get(span);
  if (data) currentSpan.enterWith(data);
}

// ── OTLP JSON record shapes + payload builders ───────────────────────────────
// Pure — no ENABLED gate, so the records a test observes through `_test` are exactly the ones
// production would put on the wire.

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
  events?: Array<{
    name: string;
    timeUnixNano: string;
    attributes: OtlpAttribute[];
  }>;
}

interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
  traceId?: string;
  spanId?: string;
}

function spanRecord(data: InternalSpanData): SpanRecord {
  return {
    traceId: data.traceId,
    spanId: data.spanId,
    ...(data.parentSpanId ? { parentSpanId: data.parentSpanId } : {}),
    name: data.name,
    kind: KIND_CODE[data.kind],
    startTimeUnixNano: data.startTimeUnixNano.toString(),
    endTimeUnixNano: nowNanos().toString(),
    attributes: toOtlpAttributes(data.attributes),
    status: {
      code: STATUS_CODE[data.statusCode],
      ...(data.statusMessage ? { message: scrubText(data.statusMessage) } : {}),
    },
    ...(data.events.length
      ? {
          events: data.events.map((e) => ({
            name: e.name,
            timeUnixNano: e.timeUnixNano,
            attributes: toOtlpAttributes(e.attributes),
          })),
        }
      : {}),
  };
}

function buildTracesPayload(spans: SpanRecord[]): object {
  return {
    resourceSpans: [
      {
        resource: RESOURCE,
        scopeSpans: [{ scope: { name: env.OTEL_SERVICE_NAME }, spans }],
      },
    ],
  };
}

function buildLogsPayload(logs: LogRecord[]): object {
  return {
    resourceLogs: [
      {
        resource: RESOURCE,
        scopeLogs: [
          { scope: { name: env.OTEL_SERVICE_NAME }, logRecords: logs },
        ],
      },
    ],
  };
}

// ── Export — batched, fire-and-forget, never throws ──────────────────────────

const FLUSH_INTERVAL_MS = 2_000;
const BATCH_MAX = 100;
// Records are held in memory until the next flush; a collector that stays down must not grow
// the queues without bound under the 256 MB container limit — drop the oldest.
const QUEUE_MAX = 2_000;
const FETCH_TIMEOUT_MS = 5_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const MAX_IN_FLIGHT = 4;

const spanQueue: SpanRecord[] = [];
const logQueue: LogRecord[] = [];

/** Test-only observers — fire on every span/log record built, independent of ENABLED. */
let spanHook: ((record: SpanRecord) => void) | null = null;
let logHook: ((record: LogRecord) => void) | null = null;

// `content-type` last so env headers can never override it.
const EXPORT_HEADERS: Record<string, string> = {
  ...parseOtlpHeadersEnv(env.OTEL_EXPORTER_OTLP_HEADERS ?? ""),
  "content-type": "application/json",
};

let lastFailureLogAt = 0;

/**
 * Every batch POST that has started and not yet settled: lets `flushOtel` await a batch an
 * EARLIER flush already spliced out of the queues, and bounds concurrency (MAX_IN_FLIGHT).
 */
const inFlight = new Set<Promise<void>>();

function trackPost(post: Promise<void>): Promise<void> {
  const tracked = post.finally(() => {
    inFlight.delete(tracked);
  });
  inFlight.add(tracked);
  return tracked;
}

/**
 * POST one OTLP JSON batch. Never throws — a non-ok response or a network failure is
 * rate-limited (at most once a minute) to a bare `console.error`, deliberately bypassing
 * log.ts (which feeds this exporter) so an export failure can never route back through the
 * exporter it is reporting on.
 */
async function postBatch(url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: EXPORT_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      reportExportFailure(`export rejected: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    reportExportFailure(
      `export failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function reportExportFailure(message: string): void {
  const now = Date.now();
  if (now - lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLogAt = now;
  console.error(`[otel] ${message}`);
}

/**
 * Splice both queues and post them. `force` is shutdown-only: normally a tick that finds
 * MAX_IN_FLIGHT posts outstanding SKIPS, leaving the records queued for the next tick, so a
 * slow collector can't pile up unbounded concurrent POSTs.
 */
async function flush(force = false): Promise<void> {
  if (!ENDPOINT) return;
  if (!force && inFlight.size >= MAX_IN_FLIGHT) return;
  const spans = spanQueue.splice(0, spanQueue.length);
  const logs = logQueue.splice(0, logQueue.length);
  const tasks: Promise<void>[] = [];
  if (spans.length) {
    tasks.push(
      trackPost(postBatch(`${ENDPOINT}/v1/traces`, buildTracesPayload(spans))),
    );
  }
  if (logs.length) {
    tasks.push(
      trackPost(postBatch(`${ENDPOINT}/v1/logs`, buildLogsPayload(logs))),
    );
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

function enqueue<T>(queue: T[], record: T): void {
  queue.push(record);
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  if (queue.length >= BATCH_MAX) void flush();
}

function exportSpan(data: InternalSpanData): void {
  try {
    const record = spanRecord(data);
    spanHook?.(record);
    if (!ENABLED) return;
    enqueue(spanQueue, record);
  } catch (err) {
    console.warn("[otel] failed to export span:", err);
  }
}

const SEVERITY_NUMBER: Record<LogSeverity, number> = {
  info: 9,
  warn: 13,
  error: 17,
};
const SEVERITY_TEXT: Record<LogSeverity, string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

/**
 * Queues one OTLP log record, stamped with the active span's trace/span id so the line is
 * reachable from its trace. `body` is the event name or log message, the fields travel as
 * attributes. Severity is classified from the name/fields unless the caller states it.
 * No-op on the network path when the endpoint is unset; never throws and never blocks.
 */
export function emitOtelLog(
  body: string,
  fields: Record<string, unknown>,
  severity: LogSeverity = severityFor(body, fields),
): void {
  try {
    const active = currentSpan.getStore();
    const record: LogRecord = {
      timeUnixNano: nowNanos().toString(),
      severityNumber: SEVERITY_NUMBER[severity],
      severityText: SEVERITY_TEXT[severity],
      body: { stringValue: scrubText(body) },
      attributes: toOtlpAttributes(fields),
      ...(active ? { traceId: active.traceId, spanId: active.spanId } : {}),
    };
    logHook?.(record);
    if (!ENABLED) return;
    enqueue(logQueue, record);
  } catch (err) {
    console.warn("[otel] failed to emit log record:", err);
  }
}

/**
 * Force-flushes both queues past the normal export interval — called on SIGTERM/SIGINT so
 * the last records of a deploy aren't lost. No-op when the endpoint is unset; never rejects.
 * Ignores the MAX_IN_FLIGHT cap (shutdown must drain, not skip) and awaits every post still
 * outstanding, including ones an earlier flush already spliced out of the queues.
 */
export async function flushOtel(): Promise<void> {
  await flush(true);
  await Promise.allSettled(inFlight);
}

if (ENABLED) {
  const timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // Unref'd so a pending flush interval can never be the reason the process stays alive.
  timer.unref?.();
}

// ── Test-only seam ───────────────────────────────────────────────────────────
// Tests observe the real span/log records built by the real code path without a live
// endpoint (ENABLED stays false across the whole `bun test` process) and exercise the network
// primitive directly against a stubbed `fetch`.
export const _test = {
  onSpanExport(hook: ((record: SpanRecord) => void) | null): void {
    spanHook = hook;
  },
  onLogExport(hook: ((record: LogRecord) => void) | null): void {
    logHook = hook;
  },
  /** Collect every span and log record built until `stop()`. */
  capture(): { spans: SpanRecord[]; logs: LogRecord[]; stop: () => void } {
    const spans: SpanRecord[] = [];
    const logs: LogRecord[] = [];
    spanHook = (record) => spans.push(record);
    logHook = (record) => logs.push(record);
    return {
      spans,
      logs,
      stop: () => {
        spanHook = null;
        logHook = null;
      },
    };
  },
  postBatch,
  tracesPayload: buildTracesPayload,
  logsPayload: buildLogsPayload,
};
