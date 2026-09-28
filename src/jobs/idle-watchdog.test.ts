import { describe, expect, test } from "bun:test";
import { createIdleWatchdog } from "./idle-watchdog";

function onAbort(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(signal.reason), {
      once: true,
    });
  });
}

describe("createIdleWatchdog", () => {
  test("aborts after idleMs when arm() is never called at all", async () => {
    // The idle window starts at creation — a call that hangs before ever
    // making progress must still trip the guard.
    const watchdog = createIdleWatchdog(10);

    const reason = await onAbort(watchdog.signal);
    expect(String(reason)).toContain("idle: no activity for 10ms");
    watchdog.clear();
  });

  test("aborts after idleMs when arm() is not called again", async () => {
    const watchdog = createIdleWatchdog(10);
    watchdog.arm();

    const reason = await onAbort(watchdog.signal);
    expect(String(reason)).toContain("idle: no activity for 10ms");
    watchdog.clear();
  });

  test("arm() after abort is a no-op — the timer never restarts", async () => {
    const watchdog = createIdleWatchdog(10);
    watchdog.arm();
    await onAbort(watchdog.signal);

    watchdog.arm();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(watchdog.signal.aborted).toBe(true);
    watchdog.clear();
  });

  test("arm() resets the clock, so steady progress never trips it", async () => {
    const watchdog = createIdleWatchdog(20);
    let aborted = false;
    watchdog.signal.addEventListener("abort", () => {
      aborted = true;
    });

    for (let i = 0; i < 5; i++) {
      watchdog.arm();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(aborted).toBe(false);
    watchdog.clear();
  });

  test("clear() stops the timer so it never fires afterwards", async () => {
    const watchdog = createIdleWatchdog(10);
    watchdog.arm();
    watchdog.clear();

    let aborted = false;
    watchdog.signal.addEventListener("abort", () => {
      aborted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(aborted).toBe(false);
  });
});
