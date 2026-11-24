import { describe, expect, it } from "vitest";
import { ScreenMetricsTracker, simulateScreenNetwork, type FakeNetworkProfile } from "../src/client-protocol/screen-metrics.js";
import { screenConfigureSchema, screenConfigureText, screenPolicySchema, screenStatusSchema } from "../src/client-protocol/remote-screen.js";

describe("Issue #80 Phase 1: Remote screen observability & opt-in UDP boost", () => {
  it("tracks FPS, capture-to-display latency (latest & p95), bitrate, resolution, and dropped/skipped frames", () => {
    const tracker = new ScreenMetricsTracker();
    tracker.setRoute("tcp_lan_direct", { udpRequested: false, udpConnected: false });

    // Deliver 10 frames in 500ms, skipping sequence #4 to simulate 1 dropped frame and recording 2 skipped frames.
    const sequences = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11];
    sequences.forEach((seq, idx) => {
      const now = 1000 + idx * 50;
      tracker.recordFrameReceived({
        sequence: seq,
        streamGeneration: 1,
        bytes: 12_500, // 100 kbits per frame -> 10 frames = 1000 kbps
        width: 1920,
        height: 1080,
        codec: "h264",
        nowMs: now,
      });
      tracker.recordFrameRendered({ nowMs: now, latencyMs: 18 + idx * 2 });
    });
    tracker.recordFrameSkipped(2);

    const snap = tracker.snapshot(1500);
    expect(snap.fps).toBe(10);
    expect(snap.bitrateKbps).toBe(1000);
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
    expect(snap.codec).toBe("h264");
    expect(snap.droppedFrames).toBe(1);
    expect(snap.skippedFrames).toBe(2);
    expect(snap.latencyMs).toBe(36);
    expect(snap.p95LatencyMs).toBeGreaterThanOrEqual(34);
    expect(snap.route).toBe("tcp_lan_direct");
    expect(snap.udpRequested).toBe(false);
    expect(snap.udpConnected).toBe(false);
  });

  it("simulates TCP vs UDP across LAN, VPS relay, Tailscale, and mobile 4G/5G with latency, loss, and bandwidth limits", () => {
    const pairs: Array<[FakeNetworkProfile, FakeNetworkProfile]> = [
      [
        { name: "LAN TCP", route: "tcp_lan_direct", transport: "tcp", baseRttMs: 4, jitterMs: 2, packetLossRate: 0, bandwidthKbps: 40_000 },
        { name: "LAN UDP", route: "udp_lan_direct", transport: "udp", baseRttMs: 4, jitterMs: 2, packetLossRate: 0, bandwidthKbps: 40_000 },
      ],
      [
        { name: "VPS Relay TCP", route: "tcp_vps_relay", transport: "tcp", baseRttMs: 45, jitterMs: 12, packetLossRate: 0.03, bandwidthKbps: 4_000 },
        { name: "VPS Relay UDP", route: "udp_vps_relay", transport: "udp", baseRttMs: 45, jitterMs: 12, packetLossRate: 0.03, bandwidthKbps: 8_000 },
      ],
      [
        { name: "Tailscale TCP", route: "tcp_tailscale", transport: "tcp", baseRttMs: 32, jitterMs: 8, packetLossRate: 0.02, bandwidthKbps: 4_000 },
        { name: "Tailscale UDP", route: "udp_tailscale_direct", transport: "udp", baseRttMs: 28, jitterMs: 6, packetLossRate: 0.02, bandwidthKbps: 10_000 },
      ],
      [
        { name: "Phone 4G/5G TCP", route: "tcp_vps_relay", transport: "tcp", baseRttMs: 75, jitterMs: 25, packetLossRate: 0.05, bandwidthKbps: 3_500 },
        { name: "Phone 4G/5G UDP", route: "udp_vps_relay", transport: "udp", baseRttMs: 70, jitterMs: 20, packetLossRate: 0.05, bandwidthKbps: 6_000 },
      ],
    ];

    for (const [tcpProfile, udpProfile] of pairs) {
      const tcpRes = simulateScreenNetwork(tcpProfile, { targetFps: 60, durationSec: 2, frameBytes: 12_000 });
      const udpRes = simulateScreenNetwork(udpProfile, { targetFps: 60, durationSec: 2, frameBytes: 12_000 });
      expect(tcpRes.framesRendered).toBeGreaterThan(0);
      expect(udpRes.framesRendered).toBeGreaterThan(0);
      if (tcpProfile.packetLossRate > 0) {
        // Under packet loss, TCP head-of-line blocking inflates p95 latency relative to UDP.
        expect(udpRes.p95LatencyMs).toBeLessThan(tcpRes.p95LatencyMs);
      }
    }
  });

  it("accepts opt-in udpBoost in screen policy/configure while preserving legacy signed command text when omitted", () => {
    const legacy = { operation: "screen.configure" as const, expectedRevision: 0, enabled: true, grants: [], requestId: "req_legacy_1" };
    expect(screenConfigureSchema.parse(legacy).udpBoost).toBeUndefined();
    const legacyText = screenConfigureText(legacy);
    expect(JSON.parse(legacyText)).toEqual(["tarobot/screen-configure/v1", 0, true, [], "req_legacy_1"]);

    const withUdp = { ...legacy, requestId: "req_udp_1", udpBoost: true };
    expect(screenConfigureSchema.parse(withUdp).udpBoost).toBe(true);
    expect(JSON.parse(screenConfigureText(withUdp))).toEqual(["tarobot/screen-configure/v1", 0, true, [], "req_udp_1", true]);

    const parsedPolicy = screenPolicySchema.parse({ revision: 1, enabled: true, grants: [], udpBoost: true });
    expect(parsedPolicy.udpBoost).toBe(true);

    const parsedStatus = screenStatusSchema.parse({
      supported: true,
      enabled: true,
      canManage: true,
      permission: "control",
      policy: parsedPolicy,
      desktop: null,
      sessions: [],
      serverTime: Date.now(),
      udpStatus: { enabled: true, state: "fallback_tcp", route: "tcp_default", reasonCode: "udp_transport_unavailable" },
    });
    expect(parsedStatus.udpStatus?.state).toBe("fallback_tcp");
  });
});
