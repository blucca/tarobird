/** Checks `ready` on a timer only while something is waiting for the worker to go quiet
 * (a requested restart or a drain). An idle worker with nothing pending sets no timer. */
export function createIdleWatch(ready: () => boolean, fire: () => void, intervalMs = 250) {
  let timer: ReturnType<typeof setInterval> | undefined, armed = false, wanted = false;
  const sync = () => {
    if (armed && wanted) timer ??= setInterval(() => { if (ready()) fire(); }, intervalMs);
    else if (timer) { clearInterval(timer); timer = undefined; }
  };
  return {
    /** The worker has finished starting: `ready` can be asked from now on. */
    arm() { armed = true; sync(); },
    /** Whether a restart or drain is pending. */
    want(value: boolean) { wanted = value; sync(); },
    stop() { armed = false; sync(); },
    get polling() { return timer !== undefined; },
  };
}
