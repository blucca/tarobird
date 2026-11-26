import type { HubConnection } from './connection.js';
import { HubHttpError } from './http-error.js';
import {
  nextCrossHostFolderUpdatedAt,
  readCrossHostFolderOrder,
  readyCrossHostFolderOrder,
  setCrossHostServerTimeOffset,
  subscribeCrossHostFolderOrder,
  writeCrossHostFolderOrder,
} from './cross-host-folder-order.js';

export type CrossHostOrderConnectionSource = {
  subscribe: (listener: () => void) => () => void;
  getConnections: () => readonly HubConnection[];
};

type OrderValue = {
  updatedAt?: number;
  pinned: readonly string[];
  ordinary: readonly string[];
};

const MAX_CONFLICT_PASSES = 6;

function canonicalOrder(order: Pick<OrderValue, 'pinned' | 'ordinary'>): string {
  return JSON.stringify([order.pinned, order.ordinary]);
}

function isNewerOrder(candidate: OrderValue, current: OrderValue): boolean {
  const candidateTs = candidate.updatedAt ?? 0;
  const currentTs = current.updatedAt ?? 0;
  if (candidateTs !== currentTs) return candidateTs > currentTs;
  if (candidateTs === 0) return false;
  return canonicalOrder(candidate) > canonicalOrder(current);
}

function isEligibleConnection(connection: HubConnection): boolean {
  const { state } = connection;
  return !connection.isClosed
    && !connection.isReadOnly
    && state.status === 'online'
    && state.crossHostFolderOrderAvailable === true
    && state.crossHostFolderOrder !== undefined
    && state.user?.role === 'owner';
}

type ObservedConnectionState = {
  status: HubConnection['state']['status'];
  available: HubConnection['state']['crossHostFolderOrderAvailable'];
  order: HubConnection['state']['crossHostFolderOrder'];
  role: string | undefined;
  readOnly: boolean;
  closed: boolean;
};

function snapshotOf(connection: HubConnection): ObservedConnectionState {
  const { state } = connection;
  return {
    status: state.status,
    available: state.crossHostFolderOrderAvailable,
    order: state.crossHostFolderOrder,
    role: state.user?.role,
    readOnly: connection.isReadOnly,
    closed: connection.isClosed,
  };
}

function sameSnapshot(a: ObservedConnectionState | undefined, b: ObservedConnectionState): boolean {
  return !!a
    && a.status === b.status
    && a.available === b.available
    && a.order === b.order
    && a.role === b.role
    && a.readOnly === b.readOnly
    && a.closed === b.closed;
}

/** Coordinates cross-host folder order sync across all connected owner Hubs
 * that advertise `cross-host-folder-order.v1`, with LWW timestamp reconciliation,
 * one-time pre-upgrade migration upload, and offline reconnect catch-up. */
export class CrossHostFolderOrderSync {
  private readonly subscriptions = new Map<HubConnection, { stop: () => void; snapshot: ObservedConnectionState }>();
  private readonly unsubSource: () => void;
  private readonly unsubOrder: () => void;
  private disposed = false;
  private running = false;
  private dirty = false;
  private suppressLocalEvent = false;
  private conflictPasses = 0;
  private currentLoop: Promise<void> = Promise.resolve();

  constructor(private readonly source: CrossHostOrderConnectionSource) {
    this.unsubSource = source.subscribe(() => {
      this.refreshConnections();
      this.schedule();
    });
    this.unsubOrder = subscribeCrossHostFolderOrder(() => {
      if (!this.suppressLocalEvent) this.schedule();
    });
    this.refreshConnections();
    this.schedule();
  }

  private refreshConnections(): void {
    if (this.disposed) return;
    const active = new Set(this.source.getConnections());
    for (const [connection, entry] of this.subscriptions) {
      if (!active.has(connection)) {
        entry.stop();
        this.subscriptions.delete(connection);
      }
    }
    for (const connection of active) {
      if (this.subscriptions.has(connection)) continue;
      const entry = {
        snapshot: snapshotOf(connection),
        stop: connection.subscribe(() => {
          const next = snapshotOf(connection);
          if (sameSnapshot(entry.snapshot, next)) return;
          entry.snapshot = next;
          this.schedule();
        }),
      };
      this.subscriptions.set(connection, entry);
    }
  }

  schedule(): Promise<void> {
    if (this.disposed) return this.currentLoop;
    this.dirty = true;
    if (!this.running) {
      this.running = true;
      this.currentLoop = this.runLoop().finally(() => {
        this.running = false;
        if (this.dirty && !this.disposed) void this.schedule();
      });
    }
    return this.currentLoop;
  }

  async syncNow(): Promise<void> {
    this.refreshConnections();
    await this.schedule();
    while (this.running) await this.currentLoop;
  }

  private async runLoop(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      await this.reconcilePass();
    }
  }

  private async reconcilePass(): Promise<void> {
    await readyCrossHostFolderOrder();
    if (this.disposed) return;
    const eligible = this.source.getConnections().filter(isEligibleConnection);
    if (!eligible.length) return;

    const offset = eligible.find(c => c.state.serverTimeOffset !== undefined)?.state.serverTimeOffset;
    if (offset !== undefined) setCrossHostServerTimeOffset(offset);

    let bestRemote = eligible[0]!.state.crossHostFolderOrder!;
    for (let i = 1; i < eligible.length; i++) {
      const candidate = eligible[i]!.state.crossHostFolderOrder!;
      if (isNewerOrder(candidate, bestRemote)) bestRemote = candidate;
    }

    let local = readCrossHostFolderOrder();
    if (isNewerOrder(bestRemote, local)) {
      this.suppressLocalEvent = true;
      try {
        writeCrossHostFolderOrder({
          version: 1,
          updatedAt: bestRemote.updatedAt,
          pinned: bestRemote.pinned,
          ordinary: bestRemote.ordinary,
        }, { fromSync: true });
      } finally {
        this.suppressLocalEvent = false;
      }
      local = readCrossHostFolderOrder();
    } else if (
      bestRemote.revision === 0
      && bestRemote.updatedAt === 0
      && (local.updatedAt ?? 0) === 0
      && (local.pinned.length > 0 || local.ordinary.length > 0)
    ) {
      // One-time migration upload: stamp pre-upgrade device-local order so all
      // connected owner devices converge on it.
      this.suppressLocalEvent = true;
      try {
        writeCrossHostFolderOrder(local, { updatedAt: nextCrossHostFolderUpdatedAt(0) });
      } finally {
        this.suppressLocalEvent = false;
      }
      local = readCrossHostFolderOrder();
    }

    const target = local;
    const targetTs = target.updatedAt ?? 0;
    if (targetTs === 0) return;

    let sawConflict = false;
    let sawClampedOrNewer = false;
    for (const connection of eligible) {
      if (this.disposed) return;
      const remote = connection.state.crossHostFolderOrder;
      if (!remote || !isNewerOrder(target, remote)) continue;
      try {
        const saved = await connection.saveCrossHostFolderOrder(
          { updatedAt: targetTs, pinned: target.pinned, ordinary: target.ordinary },
          remote.revision,
        );
        if (this.disposed) return;
        if (isNewerOrder(saved, target)) {
          sawClampedOrNewer = true;
        } else if (saved.updatedAt < targetTs && canonicalOrder(saved) === canonicalOrder(target)) {
          // Server clamped a far-future offline clock; align local timestamp so
          // other Hubs converge without repeating PATCHes.
          this.suppressLocalEvent = true;
          try {
            writeCrossHostFolderOrder({
              version: 1,
              updatedAt: saved.updatedAt,
              pinned: saved.pinned,
              ordinary: saved.ordinary,
            }, { fromSync: true });
          } finally {
            this.suppressLocalEvent = false;
          }
          sawClampedOrNewer = true;
        }
      } catch (error) {
        if (error instanceof HubHttpError && error.code === 'cross_host_folder_order_changed') {
          sawConflict = true;
        }
      }
    }

    if (sawClampedOrNewer) {
      this.dirty = true;
    }
    if (sawConflict && this.conflictPasses < MAX_CONFLICT_PASSES) {
      this.conflictPasses++;
      this.dirty = true;
    } else if (!sawConflict) {
      this.conflictPasses = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubSource();
    this.unsubOrder();
    for (const entry of this.subscriptions.values()) entry.stop();
    this.subscriptions.clear();
  }
}
