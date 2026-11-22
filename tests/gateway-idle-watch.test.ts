import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIdleWatch } from "../src/gateway/idle-watch.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("sets no timer while nothing waits for the worker to go quiet", () => {
  const ready = vi.fn(() => true), fire = vi.fn();
  const watch = createIdleWatch(ready, fire);
  watch.arm();
  vi.advanceTimersByTime(60_000);
  expect(watch.polling).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(ready).not.toHaveBeenCalled();
});

it("fires once the worker is quiet after a restart was requested, also when the request came before startup finished", () => {
  let quiet = false; const fire = vi.fn();
  const watch = createIdleWatch(() => quiet, fire);
  watch.want(true);                       // requested while the worker was still starting
  vi.advanceTimersByTime(1_000); expect(fire).not.toHaveBeenCalled(); expect(watch.polling).toBe(false);
  watch.arm();
  vi.advanceTimersByTime(1_000); expect(fire).not.toHaveBeenCalled(); expect(watch.polling).toBe(true);
  quiet = true;
  vi.advanceTimersByTime(250); expect(fire).toHaveBeenCalledTimes(1);
});

it("stops checking when the drain is cancelled and no restart is pending", () => {
  const ready = vi.fn(() => false);
  const watch = createIdleWatch(ready, vi.fn());
  watch.arm(); watch.want(true);
  vi.advanceTimersByTime(500); expect(ready).toHaveBeenCalledTimes(2);
  watch.want(false);
  vi.advanceTimersByTime(5_000); expect(ready).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  watch.want(true); vi.advanceTimersByTime(250); expect(ready).toHaveBeenCalledTimes(3);
  watch.stop(); expect(vi.getTimerCount()).toBe(0);
});
