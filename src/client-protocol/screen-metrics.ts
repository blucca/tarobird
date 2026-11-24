import { z } from "zod";

export const SCREEN_ROUTES = [
  "udp_lan_direct",
  "udp_tailscale_direct",
  "udp_p2p",
  "udp_vps_relay",
  "tcp_lan_direct",
  "tcp_tailscale",
  "tcp_vps_relay",
  "tcp_default",
] as const;
export type ScreenRouteKind = (typeof SCREEN_ROUTES)[number];

export const SCREEN_UDP_REASON_CODES = [
  "disabled",
  "udp_relay_port_closed",
  "udp_transport_unavailable",
  "peer_unsupported",
] as const;
export type ScreenUdpReasonCode = (typeof SCREEN_UDP_REASON_CODES)[number];

export const screenUdpStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["disabled", "connected", "fallback_tcp"]),
  route: z.enum(SCREEN_ROUTES),
  reasonCode: z.enum(SCREEN_UDP_REASON_CODES).optional(),
  detail: z.string().max(240).optional(),
}).strict();
export type ScreenUdpStatus = z.infer<typeof screenUdpStatusSchema>;

export interface ScreenPerformanceSnapshot {
  fps: number;
  latencyMs: number | null;
  p95LatencyMs: number | null;
  bitrateKbps: number;
  width: number;
  height: number;
  codec: "h264" | "vp8" | "";
  droppedFrames: number;
  skippedFrames: number;
  route: ScreenRouteKind;
  udpRequested: boolean;
  udpConnected: boolean;
  sampleCount: number;
  updatedAt: number;
}

interface FrameSample {
  at: number;
  bytes: number;
  latencyMs?: number;
}

const WINDOW_MS = 1000;
const MAX_LATENCY_SAMPLES = 60;

/**
 * Pure sliding-window performance tracker for the Remote Screen viewer.
 * Measures FPS, capture-to-display latency (latest & p95), bitrate, resolution,
 * sequence-gap dropped frames, skipped frames, and active transport route.
 */
export class ScreenMetricsTracker {
  private readonly receivedSamples: FrameSample[] = [];
  private readonly renderedSamples: FrameSample[] = [];
  private readonly latencyRing: number[] = [];
  private lastSequence = 0;
  private lastGeneration = 0;
  private width = 0;
  private height = 0;
  private codec: "h264" | "vp8" | "" = "";
  private droppedFrames = 0;
  private skippedFrames = 0;
  private route: ScreenRouteKind = "tcp_default";
  private udpRequested = false;
  private udpConnected = false;

  setRoute(route: ScreenRouteKind, options: { udpRequested?: boolean; udpConnected?: boolean } = {}): void {
    this.route = route;
    if (options.udpRequested !== undefined) this.udpRequested = options.udpRequested;
    if (options.udpConnected !== undefined) this.udpConnected = options.udpConnected;
  }

  resetStream(generation: number): void {
    this.lastGeneration = generation;
    this.lastSequence = 0;
  }

  recordFrameReceived(input: {
    sequence: number;
    streamGeneration: number;
    bytes: number;
    width: number;
    height: number;
    codec: "h264" | "vp8";
    nowMs: number;
  }): void {
    if (input.streamGeneration !== this.lastGeneration) {
      this.lastGeneration = input.streamGeneration;
      this.lastSequence = 0;
    }
    if (this.lastSequence > 0 && input.sequence > this.lastSequence + 1) {
      this.droppedFrames += input.sequence - this.lastSequence - 1;
    }
    if (input.sequence > this.lastSequence) {
      this.lastSequence = input.sequence;
    }
    this.width = input.width;
    this.height = input.height;
    this.codec = input.codec;
    this.receivedSamples.push({ at: input.nowMs, bytes: input.bytes });
    this.prune(input.nowMs);
  }

  recordFrameSkipped(count = 1): void {
    if (count > 0) this.skippedFrames += count;
  }

  recordFrameRendered(input: {
    nowMs: number;
    latencyMs?: number;
  }): void {
    const latency = input.latencyMs !== undefined && Number.isFinite(input.latencyMs) && input.latencyMs >= 0
      ? Math.round(input.latencyMs)
      : undefined;
    this.renderedSamples.push({ at: input.nowMs, bytes: 0, ...(latency !== undefined ? { latencyMs: latency } : {}) });
    if (latency !== undefined) {
      this.latencyRing.push(latency);
      if (this.latencyRing.length > MAX_LATENCY_SAMPLES) this.latencyRing.shift();
    }
    this.prune(input.nowMs);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - WINDOW_MS;
    while (this.receivedSamples.length > 0 && this.receivedSamples[0]!.at < cutoff) {
      this.receivedSamples.shift();
    }
    while (this.renderedSamples.length > 0 && this.renderedSamples[0]!.at < cutoff) {
      this.renderedSamples.shift();
    }
  }

  snapshot(nowMs: number): ScreenPerformanceSnapshot {
    this.prune(nowMs);
    const totalBytes = this.receivedSamples.reduce((sum, s) => sum + s.bytes, 0);
    const bitrateKbps = Math.round((totalBytes * 8) / 1000);
    const fps = this.renderedSamples.length;
    const latestLatency = this.latencyRing.length > 0 ? this.latencyRing[this.latencyRing.length - 1]! : null;
    let p95LatencyMs: number | null = null;
    if (this.latencyRing.length > 0) {
      const sorted = [...this.latencyRing].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
      p95LatencyMs = sorted[idx]!;
    }
    return {
      fps,
      latencyMs: latestLatency,
      p95LatencyMs,
      bitrateKbps,
      width: this.width,
      height: this.height,
      codec: this.codec,
      droppedFrames: this.droppedFrames,
      skippedFrames: this.skippedFrames,
      route: this.route,
      udpRequested: this.udpRequested,
      udpConnected: this.udpConnected,
      sampleCount: this.latencyRing.length,
      updatedAt: nowMs,
    };
  }
}

export interface FakeNetworkProfile {
  name: string;
  route: ScreenRouteKind;
  transport: "tcp" | "udp";
  baseRttMs: number;
  jitterMs: number;
  packetLossRate: number;
  bandwidthKbps: number;
}

export interface FakeNetworkSimulationResult {
  profile: FakeNetworkProfile;
  framesSent: number;
  framesRendered: number;
  avgFps: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  droppedFrames: number;
  skippedFrames: number;
  effectiveBitrateKbps: number;
}

/**
 * Deterministic fake-network simulator for verifying Phase 1 telemetry & flow control
 * under configurable RTT, jitter, packet loss, and bandwidth ceilings.
 * Models TCP head-of-line retransmission stalls vs. UDP loss-tolerant delivery.
 */
export function simulateScreenNetwork(
  profile: FakeNetworkProfile,
  options: { targetFps?: number; durationSec?: number; frameBytes?: number; width?: number; height?: number } = {},
): FakeNetworkSimulationResult {
  const targetFps = options.targetFps ?? 60;
  const durationSec = options.durationSec ?? 2;
  const frameBytes = options.frameBytes ?? 14_000;
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const totalFrames = targetFps * durationSec;
  const intervalMs = 1000 / targetFps;
  const tracker = new ScreenMetricsTracker();
  tracker.setRoute(profile.route, {
    udpRequested: profile.transport === "udp",
    udpConnected: profile.transport === "udp",
  });

  // Deterministic pseudo-random generator (LCG) so tests are 100% reproducible.
  let seed = 1337;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let bytesInSecond = 0;
  let secondStart = 0;
  let holStallUntilMs = 0;
  let rendered = 0;
  let latencySum = 0;
  let totalBytesSent = 0;
  const maxBytesPerSec = (profile.bandwidthKbps * 1000) / 8;

  for (let i = 1; i <= totalFrames; i++) {
    const captureMs = Math.round((i - 1) * intervalMs);
    if (captureMs - secondStart >= 1000) {
      secondStart = captureMs;
      bytesInSecond = 0;
    }

    // Bandwidth gate: skip frame when pacing budget is exhausted.
    if (bytesInSecond + frameBytes > maxBytesPerSec) {
      tracker.recordFrameSkipped(1);
      continue;
    }
    bytesInSecond += frameBytes;
    totalBytesSent += frameBytes;

    const lost = nextRand() < profile.packetLossRate;
    const jitter = Math.round(nextRand() * profile.jitterMs);
    const oneWay = Math.round(profile.baseRttMs / 2) + jitter;
    const wireSerializeMs = Math.round((frameBytes * 8) / Math.max(1, profile.bandwidthKbps));
    const decodeMs = 4;

    if (profile.transport === "udp" && lost) {
      // UDP drops the single lost frame without stalling subsequent frames.
      continue;
    }

    let arriveMs = captureMs + oneWay + wireSerializeMs;
    if (profile.transport === "tcp") {
      if (lost) {
        // TCP retransmits after ~1.5x RTT, causing head-of-line blocking for queued frames.
        const retransmitFinish = arriveMs + Math.round(profile.baseRttMs * 1.5);
        holStallUntilMs = Math.max(holStallUntilMs, retransmitFinish);
      }
      if (arriveMs < holStallUntilMs) {
        arriveMs = holStallUntilMs;
      }
    }

    const displayMs = arriveMs + decodeMs;
    const e2eLatency = displayMs - captureMs;
    tracker.recordFrameReceived({
      sequence: i,
      streamGeneration: 1,
      bytes: frameBytes,
      width,
      height,
      codec: "h264",
      nowMs: displayMs,
    });
    tracker.recordFrameRendered({ nowMs: displayMs, latencyMs: e2eLatency });
    rendered++;
    latencySum += e2eLatency;
  }

  const snap = tracker.snapshot(Math.round(totalFrames * intervalMs) + profile.baseRttMs + 20);
  return {
    profile,
    framesSent: totalFrames,
    framesRendered: rendered,
    avgFps: Math.round((rendered / durationSec) * 10) / 10,
    avgLatencyMs: rendered > 0 ? Math.round(latencySum / rendered) : 0,
    p95LatencyMs: snap.p95LatencyMs ?? 0,
    droppedFrames: snap.droppedFrames,
    skippedFrames: snap.skippedFrames,
    effectiveBitrateKbps: Math.round((totalBytesSent * 8) / (durationSec * 1000)),
  };
}
