# DIY Cloudflare Tunnel Route & Relay Evaluation

TaroBird supports connecting your own **Cloudflare Tunnel (`cloudflared`)** alongside **LAN (`Direct`)**, **Tailscale**, and self-hosted **VPS** routes—at zero server cost to you and without TaroBird hosting or proxying your traffic.

## How It Works (Security & Identity)

TaroBird's `Direct`, `Tailscale`, and `VPS` (TLS-passthrough) routes continue to enforce **strict leaf-certificate pinning** via `/api/tls-identity` (and invite-scoped CA anchors when applicable). Nothing is weakened on those routes.

Because Cloudflare Tunnel terminates outer TLS at Cloudflare's edge (serving a Cloudflare WebPKI certificate rather than the Hub's local leaf certificate), `Cloudflare` routes use an explicit, fail-closed edge trust path:

1. **System WebPKI HTTPS only**: Native clients (macOS/Windows Rust transport, iOS `HubTLS`, Android `HubTls`, Electron) verify the outer TLS 1.2/1.3 certificate and hostname strictly against the OS root store. Custom `certificateAuthority` overrides and insecure fallbacks are rejected for `Cloudflare` routes.
2. **Origin-bound Host Ed25519 proof (`/api/edge-identity`)**:
   - The Hub only serves `/api/edge-identity?nonce=<nonce>&origin=<origin>` to requests arriving on a **real loopback socket** (`127.0.0.1` / `::1`) and **only** for HTTPS origins explicitly authorized by the Host owner (saved in Host Cloudflare settings, active local Quick Tunnel, or `TAROBOT_CLOUDFLARE_ORIGINS`).
   - The Hub signs `["tarocub/edge-identity/v1", publicKey, nonce, origin]` with its Ed25519 identity key. An arbitrary third-party terminating proxy cannot obtain or replay a valid proof for another domain.
   - Every WebSocket session still performs full mutual Ed25519 challenge-response authentication (`serverProof` + `deviceProof`).
3. **Loopback proxy source isolation**:
   - Requests arriving over loopback with proxy headers (`CF-Ray`, `CF-Connecting-IP`, `X-Forwarded-For`, `Forwarded`) are never granted `"trusted"` loopback rate-limit buckets, and spoofable client IP headers are never trusted for authentication or rate-limit bypasses.

## Phase 1: DIY `cloudflared` Setup

Open **Settings → Connection status & routes → DIY Cloudflare Tunnel** on the Host computer:

### Option A: Named Tunnel (Recommended for daily use)

Use your own free Cloudflare account and domain (free tier supports up to 1,000 tunnels per account and optional Cloudflare Access):

```bash
cloudflared tunnel --protocol http2 run --url http://127.0.0.1:<hub-port> <your-tunnel-name>
```

Then add your `https://hub.example.com` origin under **Authorized Cloudflare HTTPS origins**, save, and share the QR code or add it on your phone/other computers.

### Option B: Quick Tunnel (Zero-account testing)

```bash
cloudflared tunnel --protocol http2 --url http://127.0.0.1:<hub-port>
```

Or click **Start Quick Tunnel** in the Host settings panel when `cloudflared` is installed.

> **Quick Tunnel limits**: `*.trycloudflare.com` URLs change whenever `cloudflared` restarts, are capped at 200 concurrent in-flight requests, and do not support Server-Sent Events (SSE).

### Mainland China & Firewall Guidance

- **Use `--protocol http2` (TCP/443)**: Cloudflare's default QUIC transport (UDP/7844) is frequently throttled or blocked on Chinese ISPs and restrictive corporate networks. TaroBird defaults to recommending `--protocol http2`.
- **Honest latency expectations**: Free Cloudflare routes traverse overseas Anycast PoPs (typically adding ~150–350 ms RTT from mainland China). They work well for chat, Bot control, notifications, and CLI workflows. For high-fps Remote Screen streaming, keep LAN, Tailscale P2P, or a nearby self-hosted VPS configured—TaroBird prefers lower-latency direct routes whenever reachable.

---

## Phase 2 Evaluation: Self-Deployed Cloudflare Workers + Durable Objects E2EE Relay

| Dimension | DIY `cloudflared` Tunnel (Phase 1, shipped) | DIY Workers + Durable Objects E2EE Relay (Phase 2 option) |
| --- | --- | --- |
| **User setup** | Install `cloudflared`; zero-account Quick Tunnel or free Named Tunnel | Requires Cloudflare account + `wrangler deploy` of an open-source Worker/DO template |
| **Transport** | Direct HTTP/WebSocket tunnel from Cloudflare Edge to Hub loopback | Hub maintains outbound WebSocket to user's Durable Object; clients connect to same DO |
| **TLS & E2EE boundary** | Edge terminates outer TLS; TaroBird authenticates Host/device with Ed25519 + origin-bound proof | Must add an outer E2EE envelope (e.g. Noise / X25519 + AEAD) so the Worker/DO forwards only opaque ciphertext |
| **Free-tier limits** | Named Tunnels: up to 1,000 tunnels, generous bandwidth, no request-unit billing | Workers Free: 100k requests/day; Durable Objects WebSocket Hibernation requires paid Workers plan for production volume |
| **Remote Screen video** | Usable for fallback only; prefer LAN/Tailscale/VPS | **Out of scope** — never proxy high-bitrate screen video through Workers/DO |
| **Best fit** | Immediate zero-cost remote access for all HTTP/WS features & attachments | Lightweight mobile-companion E2EE control/chat/notifications when `cloudflared` cannot run |

**Recommendation**: Phase 1 (`cloudflared` DIY route with `--protocol http2` and origin-bound `/api/edge-identity`) solves the immediate user need (#98 / #103) with zero billing tier friction, full attachment/streaming compatibility, and no extra E2EE framing layer. If pursued later, Phase 2 should ship as an optional MIT-licensed `wrangler deploy` template strictly scoped to opaque E2EE chat/control/notification frames (excluding Remote Screen media).

## References

- `pingdotgg/t3code` (MIT) — `cloudflared` loopback tunnel lifecycle, UDP/7844 QUIC vs. HTTP/2 troubleshooting, and route prioritization concepts.
- `stablyai/orca` (MIT) — lightweight Workers + Durable Objects WebSocket relay concepts for mobile companion E2EE traffic.
