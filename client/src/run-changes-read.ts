import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";

/** A recorded-changes read. Only these idempotent reads retry temporary admission/timeout failures. */
export async function readRunEvidence(connection: HubConnection, route: string, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try { return await connection.http<unknown>(route, { signal }); }
    catch (error) {
      if (signal.aborted || attempt >= 3 || !(error instanceof HubHttpError) || ![429, 504].includes(error.status)) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 250 * 2 ** attempt);
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      });
    }
  }
}
