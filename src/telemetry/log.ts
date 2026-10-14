import { emitOtelLog } from "./otel";
import type { LogSeverity } from "./otel-format";

type Sink = (...args: unknown[]) => void;

export interface Logger {
  /** Replaces `console.log`. */
  info(message: string, meta?: unknown): void;
  /** Replaces `console.warn`. */
  warn(message: string, meta?: unknown): void;
  /** Replaces `console.error`. */
  error(message: string, meta?: unknown): void;
  /**
   * A queryable structured event (the stand-in for metrics): a stable `name` and
   * low-cardinality attributes, shipped as an OTLP log record only — no stdout line.
   * Never pass an address, subject, body, auth code or message id.
   */
  event(
    name: string,
    attributes?: Record<string, unknown>,
    severity?: LogSeverity,
  ): void;
}

function fieldsFrom(meta: unknown): Record<string, unknown> {
  if (meta === undefined) return {};
  if (meta instanceof Error) return { error: meta };
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return { meta };
}

export function createLogger({
  sinks = {
    // Resolved at call time so the real console is always the one written to.
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  },
  emit = emitOtelLog,
}: {
  sinks?: { log: Sink; warn: Sink; error: Sink };
  emit?: typeof emitOtelLog;
} = {}): Logger {
  // stdout stays byte-for-byte what the console call it replaces printed; the OTLP record is
  // additive, stamped with the active trace/span id by `emit`.
  function line(
    sink: Sink,
    severity: LogSeverity,
    message: string,
    meta: unknown,
  ): void {
    if (meta === undefined) sink(message);
    else sink(message, meta);
    emit(message, fieldsFrom(meta), severity);
  }

  return {
    info: (message, meta) => line(sinks.log, "info", message, meta),
    warn: (message, meta) => line(sinks.warn, "warn", message, meta),
    error: (message, meta) => line(sinks.error, "error", message, meta),
    event: (name, attributes = {}, severity) =>
      emit(name, attributes, severity),
  };
}

export const log: Logger = createLogger();
