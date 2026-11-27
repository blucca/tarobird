import type { EngineSessionRestartResult } from "./adapter.js";

const EXIT_CONFIRMATION_MS = 8_000;

interface RestartProcess {
  exited: Promise<unknown>;
  stop(): void | Promise<void>;
}

interface PendingRestart {
  process: RestartProcess;
  exited: Promise<void>;
  observed: boolean;
  attempt?: Promise<EngineSessionRestartResult>;
}

/** Retain the exact old process if termination was requested but not observed.
 * A retry can re-signal it, while ordinary input must wait for its exit. */
export class EngineSessionRestarts {
  private readonly pending = new Map<string, PendingRestart>();

  exiting(sessionId: string): Promise<void> | undefined {
    return this.pending.get(sessionId)?.exited;
  }

  close(sessionId: string, process?: RestartProcess): Promise<EngineSessionRestartResult> {
    let pending = this.pending.get(sessionId);
    if (!pending) {
      if (!process) return Promise.resolve({ outcome: "not_running" });
      const record: PendingRestart = { process, observed: false, exited: process.exited.then(() => {
        record.observed = true;
        if (this.pending.get(sessionId) === record) this.pending.delete(sessionId);
      }) };
      this.pending.set(sessionId, record);
      pending = record;
    }
    const record = pending;
    record.attempt ??= this.terminate(record).finally(() => { record.attempt = undefined; });
    return record.attempt;
  }

  private async terminate(record: PendingRestart): Promise<EngineSessionRestartResult> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<EngineSessionRestartResult>(resolve => {
      timer = setTimeout(() => resolve({ outcome: "exit_unconfirmed" }), EXIT_CONFIRMATION_MS);
    });
    // Install the attempt before invoking a potentially reentrant close.
    const stop = Promise.resolve().then(() => {
      if (!record.observed) return record.process.stop();
    }).catch(() => undefined);
    try {
      return await Promise.race([
        Promise.all([record.exited, stop]).then(() => ({ outcome: "closed" as const })),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function observeEngineProcessExit(child: {
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  once(event: "exit" | "close", listener: () => void): unknown;
}): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    child.once("exit", resolve);
    child.once("close", resolve);
  });
}
