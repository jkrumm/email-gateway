// A liveness check for one long-running call (an LLM enrichment/Jev call),
// not a time budget for it. Per rules/agent-limits.md the job runner has no
// step/turn limit and no wall-clock ceiling — the only thing that may abort a
// call is silence: no progress signal for `idleMs`. A handler calls `arm()`
// on every observable step of its own work (each chunk of a stream, each
// retry attempt); the clock resets on any of those and only fires once a
// call has produced nothing at all for the whole idle window.
export interface IdleWatchdog {
  readonly signal: AbortSignal;
  // Reset the idle clock — call on every progress event the handler observes.
  arm: () => void;
  // Stop the timer. Always call this once the call settles (finally), or the
  // timer leaks for `idleMs` past a call that already finished.
  clear: () => void;
}

export function createIdleWatchdog(idleMs: number): IdleWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const arm = (): void => {
    stopTimer();
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      controller.abort(new Error(`idle: no activity for ${idleMs}ms`));
    }, idleMs);
    // Never keep the process alive on its own.
    if (typeof timer.unref === "function") timer.unref();
  };

  const clear = (): void => {
    stopTimer();
  };

  // Start the idle window immediately, not on the caller's first `arm()` —
  // otherwise a call that hangs before ever making progress (the request
  // never even starts) would never trip the only liveness guard a
  // no-timeout handler has.
  arm();

  return { signal: controller.signal, arm, clear };
}
