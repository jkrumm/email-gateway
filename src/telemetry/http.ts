import { Elysia, StatusMap } from 'elysia'
import { activateSpan, startSpan, type Span } from './otel'

// The liveness probe fires every few seconds; a span per probe is pure noise.
const SKIPPED_PATHS = new Set(['/health'])

type StatusLike = number | keyof typeof StatusMap | undefined

function statusCodeOf(status: StatusLike): number {
  if (typeof status === 'number') return status
  return (status && StatusMap[status]) || 200
}

// The status of a request that ended in a thrown error. Elysia's own errors carry a numeric
// `status` (404, 422, ...), a thrown `status(403, ...)` carries `code`; anything else is a 500
// unless the context already holds an error status.
function statusOfError(error: unknown, setStatus: StatusLike): number {
  const carried = error as { status?: unknown; code?: unknown } | null
  if (typeof carried?.status === 'number') return carried.status
  if (typeof carried?.code === 'number') return carried.code
  const status = statusCodeOf(setStatus)
  return status >= 400 ? status : 500
}

/**
 * One HTTP server span per request: opened in `onRequest` and made the active span, so
 * the spans and logs the handler creates link to it; closed in `onAfterResponse`, or
 * already in `onError` for a request that threw (so an errored request is exported even if
 * no after-response hook follows). `end` is idempotent, whichever hook gets there first
 * wins. Attributes are the method, the route PATTERN (`/api/threads/:key/summary`, never the
 * raw URL) and the response status — headers, query strings and bodies are never read.
 * 5xx -> error status, 4xx stays unset (a client mistake is not a server fault).
 *
 * The hooks are global so they cover every plugin and guard mounted after this one.
 */
export function httpTelemetry() {
  const spans = new WeakMap<Request, Span>()

  function finish(
    request: Request,
    route: string | undefined,
    status: number,
    error?: unknown,
  ): void {
    const span = spans.get(request)
    if (!span) return
    spans.delete(request)

    span.setName(route ? `${request.method} ${route}` : request.method)
    span.setAttributes({
      'http.response.status_code': status,
      // Unmatched requests (404 scans) have no pattern; omitting it keeps cardinality flat.
      ...(route ? { 'http.route': route } : {}),
    })
    if (status >= 500) {
      span.setStatus('error', `HTTP ${status}`)
      if (error !== undefined) span.recordException(error)
    }
    span.end()
  }

  return new Elysia({ name: 'http-telemetry' })
    .onRequest(({ request }) => {
      if (SKIPPED_PATHS.has(new URL(request.url).pathname)) return
      const method = request.method
      const span = startSpan(method, { 'http.request.method': method }, 'server')
      spans.set(request, span)
      activateSpan(span)
    })
    .onError({ as: 'global' }, ({ request, route, set, error }) => {
      finish(request, route, statusOfError(error, set.status as StatusLike), error)
    })
    .onAfterResponse({ as: 'global' }, ({ request, route, set, response }) => {
      // A handler's `status(...)` return carries its own code; otherwise it is on `set`.
      const status =
        response instanceof Response ? response.status : statusCodeOf(set.status as StatusLike)
      finish(request, route, status)
    })
}
