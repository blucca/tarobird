import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NetworkManager } from "../../src/NetworkManager.js";
import { runtimeHostId } from "../../src/host-registry.js";
import type { ConnectedHost } from "../../src/host-connections.js";
import type { NetworkView, SignedNetworkManifest } from "../../../src/client-protocol/private-network.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/porcelain-details.css";

// Issue #63: this desktop's own host coordinates the network and is stopped.
// The remote member is the only live connection; nothing leaves the page.
const key = (byte: number) => btoa(String.fromCharCode(48,42,48,5,6,3,43,101,112,3,33,0,...new Array(32).fill(byte)));
const localKey = key(1), remoteKey = key(2), offlineKey = key(3);
const membership: SignedNetworkManifest = { signature: "A".repeat(86) + "==", manifest: { v: 1, id: "network-fixture", name: "我的网络", authorityKey: localKey, genesisNonce: "g".repeat(43), revokedMembers: [], blockedBindings: [], revision: 2, devices: [], hosts: [
  { publicKey: localKey, name: "macmini", routes: [{ name: "Direct", url: "https://local.test" }], state: "active", revoked: false },
  { publicKey: remoteKey, name: "工作电脑", routes: [{ name: "Direct", url: "https://remote.test" }], state: "active", revoked: false },
  { publicKey: offlineKey, name: "离线工作机", routes: [{ name: "Direct", url: "https://offline.test" }], state: "active", revoked: false },
] } };
const network: NetworkView = { host: membership.manifest.hosts[1]!, membership, sync: "current", lastSyncedAt: Date.now() };
const remote = { identity: { routes: [{ name: "Direct", url: "https://remote.test" }], hubPublicKey: remoteKey, publicKey: key(5), deviceId: "device-remote", name: "Fixture" },
  state: { status: "online", networkAvailable: true, user: { id: "owner", role: "owner", name: "Owner" }, hostProfile: { name: "工作电脑", revision: 0 }, network },
  subscribe: () => () => {}, refreshNetwork: async () => network, confirmNetworkChange: async () => {}, resume() {}, http: async () => ({}) };
const host = (publicKey: string, name: string, index: number) => ({ id: runtimeHostId(publicKey), publicKey, name, registrationId: `fixture-${index}`, state: "ready", deviceId: `device-${index}`, databaseName: `fixture-${index}`, createdAt: index });
// A listed member saved on this device but without a connection keeps its
// existing presentation; only this desktop's stopped host is special-cased.
const entries = [{ host: host(localKey, "macmini", 0) }, { host: host(remoteKey, "工作电脑", 1), connection: remote }, { host: host(offlineKey, "离线工作机", 2) }] as unknown as ConnectedHost[];
const starts: number[] = [];
let release: (() => void) | undefined;
(window as unknown as { startFixture: unknown }).startFixture = { starts, release: () => release?.() };
function Fixture() {
  const [control, setControl] = useState({ busy: false, error: "" });
  const start = () => {
    starts.push(Date.now()); setControl({ busy: true, error: "" });
    void new Promise<void>(resolve => { release = resolve; }).then(() => setControl({ busy: false, error: "未启动：主机数据来自更新版本的 TaroBird。请先更新 App，再启动本机主机。数据未改动。" }));
  };
  return <NetworkManager entries={entries} localHostKey={localKey} localHostStart={{ ...control, start }} close={() => {}} addHost={() => {}} manageConnections={() => {}}/>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
