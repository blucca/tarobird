import Foundation

final class ScreenEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [[String: Any]] = []
    private var closes: [String: Int] = [:]
    func append(_ event: [String: Any]) { lock.lock(); defer { lock.unlock() }; pending.append(event); if event["kind"] as? String == "close", let id = event["id"] as? String { closes[id, default: 0] += 1 } }
    func pop(_ id: String, _ kind: String) -> [String: Any]? { lock.lock(); defer { lock.unlock() }; guard let index = pending.firstIndex(where: { $0["id"] as? String == id && $0["kind"] as? String == kind }) else { return nil }; return pending.remove(at: index) }
    func count(_ id: String) -> Int { lock.lock(); defer { lock.unlock() }; return closes[id] ?? 0 }
}
final class ScreenFixture {
    let process = Process(), input = Pipe(), output = Pipe()
    var network: [String: Any] = [:]
    init(_ repo: String, _ scratch: String, _ script: [String] = ["client/android/audit/screen-fixture.mjs"]) throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node"] + script + [scratch]
        process.currentDirectoryURL = URL(fileURLWithPath: repo); process.standardInput = input; process.standardOutput = output
        try process.run(); network = try read()
    }
    private func read() throws -> [String: Any] {
        var bytes = Data()
        while let next = try output.fileHandleForReading.read(upToCount: 1), !next.isEmpty {
            if next[0] == 10 { return try JSONSerialization.jsonObject(with: bytes) as! [String: Any] }
            bytes.append(next); if bytes.count > 1048576 { throw HubNetworkError("fixture_response_limit") }
        }
        throw HubNetworkError("fixture_stopped")
    }
    func request(_ value: [String: Any]) throws -> [String: Any] {
        var bytes = try JSONSerialization.data(withJSONObject: value); bytes.append(10)
        try input.fileHandleForWriting.write(contentsOf: bytes); return try read()
    }
    func stop() { _ = try? request(["action": "stop"]); if process.isRunning { process.terminate() }; process.waitUntilExit() }
}
final class ScreenClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 0
    func read() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ value: TimeInterval) { lock.lock(); self.value = value; lock.unlock() }
}
@main struct HubScreenChecks {
    static var checks: [String: Bool] = [:]
    static func check(_ value: Bool, _ name: String) throws { guard value else { throw HubNetworkError("FAILED_" + name) }; checks[name] = true }
    static func reject(_ name: String, _ action: () async throws -> Void) async throws {
        do { try await action() } catch { checks[name] = true; return }; throw HubNetworkError("NOT_REJECTED_" + name)
    }
    static func call(_ manager: HubTransport, _ method: String, _ args: [String: Any] = [:]) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in manager.invoke(method, args) { continuation.resume(with: $0) } }
    }
    static func event(_ manager: HubTransport, _ log: ScreenEvents, _ id: String, _ kind: String, notify: Bool = true) async throws -> [String: Any] {
        let until = ProcessInfo.processInfo.systemUptime + 8
        while ProcessInfo.processInfo.systemUptime < until {
            if let value = log.pop(id, kind) { if !notify || manager.acceptScreenEvent(value) { return value } }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw HubNetworkError("event_timeout_" + kind)
    }
    static func join(_ control: Bool = false) -> [String: Any] {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        return ["session": ["id": UUID().uuidString, "generation": UUID().uuidString, "desktopId": "synthetic-desktop", "deviceId": "synthetic-device", "deviceName": "Synthetic viewer",
                            "display": ["id": "synthetic", "nativeId": "1", "name": "Synthetic", "revision": 1, "x": 0, "y": 0, "width": 64, "height": 64, "scale": 1, "rotation": 0], "controlAllowed": control, "state": "viewing", "createdAt": now],
                "controlTicket": try! HubTLS.nonce(), "mediaTicket": try! HubTLS.nonce(), "expiresAt": now + 30000, "serverTime": now, "quality": "smooth"]
    }
    static func sid(_ join: [String: Any]) -> String { (join["session"] as! [String: Any])["id"] as! String }
    static func command(_ join: [String: Any], _ type: String, _ extra: [String: Any] = [:]) -> [String: Any] {
        let session = join["session"] as! [String: Any]
        return extra.merging(["type": type, "sessionId": session["id"]!, "generation": session["generation"]!]) { _, right in right }
    }
    static func open(_ manager: HubTransport, _ log: ScreenEvents, _ fixture: ScreenFixture, _ document: String, _ join: [String: Any]) async throws -> String {
        _ = try fixture.request(["action": "register", "join": join])
        let id = try await call(manager, "allocate", ["document": document, "kind": "screen"])["value"] as! String
        _ = try await call(manager, "screenOpen", ["id": id, "network": fixture.network, "join": join])
        for _ in 0..<3 {
            let value = try await event(manager, log, id, "screen")
            try check(value["document"] as? String == document, "documentStamped")
            _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": value["deliverySequence"]!])
        }
        return id
    }
    static func peerClosed(_ fixture: ScreenFixture, _ join: [String: Any]) async throws {
        let until = ProcessInfo.processInfo.systemUptime + 5
        while ProcessInfo.processInfo.systemUptime < until {
            let peers = try fixture.request(["action": "stats"])["open"] as! [[String: Any]]
            if !peers.contains(where: { $0["id"] as? String == sid(join) }) { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw HubNetworkError("peer_remained_open")
    }
    static func closeReasons(_ fixture: ScreenFixture) async throws {
        let log = ScreenEvents()
        // Capture the same terminal event that crosses the plugin queue hop.
        let manager = HubTransport { log.append($0) }; defer { manager.reset(destroy: true) }
        manager.setScreenActive(true)
        let document = try await call(manager, "document")["value"] as! String
        let cases: [(Int, String, String?, String)] = [
            (4000, "screen_locked", nil, "closedStateAndBothSocketsKeepHostReason"),
            (4000, "screen_permission_revoked", "media", "mediaFirstKeepsHostReason"),
            (4000, "screen_display_changed", "control", "controlFirstKeepsHostReason"),
            (1000, "screen_locked", nil, "nonHostCloseCodeIsGeneric"),
            (4000, "screen_", nil, "emptyReasonSuffixIsGeneric"),
            (4000, "screen_locked\n", nil, "newlineReasonIsGeneric"),
            (4000, "screen_Locked", nil, "uppercaseReasonIsGeneric"),
            (4000, "screen_locked🔒", nil, "unicodeReasonIsGeneric"),
            (4000, "screen_" + String(repeating: "a", count: 58), nil, "oversizedReasonIsGeneric"),
            (4000, "screen_" + String(repeating: "a", count: 57), nil, "maximumBoundedReasonIsPreserved"),
            (4000, "session_expired", nil, "sessionExpiredIsPreserved"),
            (4000, "device_revoked", "media", "deviceRevokedIsPreserved"),
            (4000, "device_revoked_or_expired", "control", "deviceRevokedOrExpiredIsPreserved"),
            (4000, "session_expired\n", nil, "authReasonNewlineIsGeneric"),
            (4000, "session_expire", nil, "authReasonPrefixIsGeneric"),
            (4001, "session_expired", nil, "authReasonOtherCodeIsGeneric")
        ]
        for (code, reason, role, name) in cases {
            let value = join(), id = try await open(manager, log, fixture, document, value)
            var input: [String: Any] = ["action": "close-host", "id": sid(value), "code": code, "reason": reason]
            if let role = role { input["role"] = role }
            _ = try fixture.request(input)
            let terminal = try await event(manager, log, id, "close")
            let expected = name.hasSuffix("IsGeneric") ? "screen_socket_closed" : reason
            try check(terminal["reason"] as? String == expected, name)
            try await peerClosed(fixture, value)
            try await Task.sleep(nanoseconds: 50_000_000)
            try check(log.count(id) == 1, name + "SingleTerminal")
            if let queued = log.pop(id, "screen") { try check(!manager.acceptScreenEvent(queued), name + "NoRetiredStateReplay") }
        }
    }
    static func attachClock(_ fixture: ScreenFixture) async throws {
        let clock = ScreenClock(), log = ScreenEvents()
        let manager = HubTransport(screenNow: { clock.read() }) { log.append($0) }; defer { manager.reset(destroy: true) }
        manager.setScreenActive(true)
        let document = try await call(manager, "document")["value"] as! String, value = join()
        var registered = value; registered["fixtureMode"] = "no-attach"
        _ = try fixture.request(["action": "register", "join": registered])
        let id = try await call(manager, "allocate", ["document": document, "kind": "screen"])["value"] as! String
        let before = try fixture.request(["action": "stats"])["proofCount"] as! Int
        _ = try fixture.request(["action": "hold-proof", "hold": true])
        let opening = Task { try await call(manager, "screenOpen", ["id": id, "network": fixture.network, "join": value]) }
        for _ in 0..<100 {
            if (try fixture.request(["action": "stats"])["proofCount"] as! Int) > before { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        clock.set(5)
        _ = try fixture.request(["action": "release-proof"])
        _ = try await opening.value
        try await Task.sleep(nanoseconds: 350_000_000)
        try check(log.count(id) == 0, "slowRoutePreparationDoesNotConsumeAttachBudget")
        clock.set(9.9); try await Task.sleep(nanoseconds: 350_000_000)
        try check(log.count(id) == 0, "attachStillAllowedBeforeFiveSecondsFromResume")
        for role in ["control", "media"] { _ = try fixture.request(["action": "message", "id": sid(value), "role": role, "value": ["type": "attached", "sessionId": sid(value)]]) }
        let attached = try await event(manager, log, id, "screen")
        _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": attached["deliverySequence"]!])
        clock.set(10.1); try await Task.sleep(nanoseconds: 350_000_000)
        try check(log.count(id) == 0, "timelyAttachSurvivesElapsedAttachDeadline")
        _ = try await call(manager, "screenClose", ["id": id]); try await peerClosed(fixture, value)
        clock.set(20)
        let stalled = join(); var stalledRegistration = stalled; stalledRegistration["fixtureMode"] = "no-attach"
        _ = try fixture.request(["action": "register", "join": stalledRegistration])
        let stalledID = try await call(manager, "allocate", ["document": document, "kind": "screen"])["value"] as! String
        _ = try await call(manager, "screenOpen", ["id": stalledID, "network": fixture.network, "join": stalled])
        clock.set(25)
        let timeout = try await event(manager, log, stalledID, "close")
        try check(timeout["reason"] as? String == "screen_attach_timeout", "unattachedSessionStillTimesOutAtFiveSeconds")
        try await peerClosed(fixture, stalled)
    }
    // Released Hubs (1.5.1 and earlier) notify `state` inside attachViewer, so the
    // control socket can carry state before its own `attached` reply.
    static func state(_ join: [String: Any], _ value: String = "connecting", _ extra: [String: Any] = [:]) -> [String: Any] {
        var session = join["session"] as! [String: Any]; session["state"] = value
        return ["type": "state", "session": session, "serverTime": Int(Date().timeIntervalSince1970 * 1000), "controlPending": false, "streamGeneration": 1]
            .merging(extra) { _, right in right }
    }
    static func attached(_ join: [String: Any]) -> [String: Any] { ["type": "attached", "sessionId": sid(join)] }
    static let stream: [String: Any] = ["type": "stream", "streamGeneration": 1, "geometryRevision": 1, "codec": "h264", "codecString": "avc1.42c01e",
                                        "width": 64, "height": 64, "contentRect": ["x": 0, "y": 0, "width": 64, "height": 64]]
    static let lease: [String: Any] = ["id": String(repeating: "L", count: 43), "challenge": String(repeating: "C", count: 43),
                                       "expiresAt": Int(Date().timeIntervalSince1970 * 1000) + 600000, "challengeExpiresAt": Int(Date().timeIntervalSince1970 * 1000) + 600000]
    static func peer(_ fixture: ScreenFixture, _ join: [String: Any], _ role: String, _ value: [String: Any]) throws {
        _ = try fixture.request(["action": "message", "id": sid(join), "role": role, "value": value])
    }
    /// Both sockets have said hello; the peer has replied nothing yet.
    static func openUnattached(_ manager: HubTransport, _ fixture: ScreenFixture, _ document: String, _ join: [String: Any]) async throws -> String {
        var registered = join; registered["fixtureMode"] = "no-attach"
        _ = try fixture.request(["action": "register", "join": registered])
        let id = try await call(manager, "allocate", ["document": document, "kind": "screen"])["value"] as! String
        _ = try await call(manager, "screenOpen", ["id": id, "network": fixture.network, "join": join])
        let until = ProcessInfo.processInfo.systemUptime + 5
        while ProcessInfo.processInfo.systemUptime < until {
            let peers = try fixture.request(["action": "stats"])["open"] as! [[String: Any]]
            if peers.filter({ $0["id"] as? String == sid(join) }).count == 2 { return id }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw HubNetworkError("peer_hello_missing")
    }
    /// What the native session did with a peer sequence: the JSON it delivered
    /// (each acknowledged through the plugin gate) or its single terminal reason.
    static func outcome(_ manager: HubTransport, _ log: ScreenEvents, _ id: String, _ count: Int) async throws -> (String, [[String: Any]]) {
        var values: [[String: Any]] = [], settled: TimeInterval?
        let until = ProcessInfo.processInfo.systemUptime + 6
        while ProcessInfo.processInfo.systemUptime < until {
            if let terminal = log.pop(id, "close") {
                return ("closed:" + (terminal["reason"] as? String ?? "?") + (values.isEmpty ? "" : "+delivered"), values)
            }
            if let event = log.pop(id, "screen") {
                guard manager.acceptScreenEvent(event) else { continue }
                _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": event["deliverySequence"]!])
                values.append(event["value"] as! [String: Any])
                if values.count == count { settled = ProcessInfo.processInfo.systemUptime + 0.4 }
            }
            if let settled = settled, ProcessInfo.processInfo.systemUptime >= settled { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let types = values.map { $0["type"] as! String }
        return ("control=" + types.filter { $0 != "stream" }.joined(separator: ",") + ";media=" + types.filter { $0 == "stream" }.joined(separator: ","), values)
    }
    static func attachOrder(_ fixture: ScreenFixture) async throws {
        let log = ScreenEvents()
        let manager = HubTransport { log.append($0) }; defer { manager.reset(destroy: true) }
        manager.setScreenActive(true)
        let document = try await call(manager, "document")["value"] as! String
        typealias Step = (String, ([String: Any]) -> [String: Any])
        let early: Step = ("control", { state($0) }), attach: Step = ("control", attached)
        let ready: [Step] = [("media", attached), ("media", { _ in stream })]
        func earlyWith(_ session: [String: Any], _ extra: [String: Any] = [:]) -> Step {
            ("control", { join in state(join, "connecting", extra.merging(["session": (join["session"] as! [String: Any]).merging(session) { _, right in right }]) { _, right in right }) })
        }
        func repeated(_ step: Step, _ count: Int) -> [Step] { [Step](repeating: step, count: count) }
        let padded = earlyWith(["state": "connecting", "deviceName": String(repeating: "n", count: 9000)])
        let frameReady: Step = ("control", { join in ["type": "frame-ready", "sessionId": sid(join), "generation": (join["session"] as! [String: Any])["generation"]!,
                                                     "streamGeneration": 1, "frameSequence": 1, "expiresAt": 1] })
        var cases: [(String, [Step], Int, String)] = []
        cases.append(("realHubStateBeforeAttached", [early, attach] + ready, 3, "control=attached,state;media=stream"))
        cases.append(("mediaFirstThenEarlyState", ready + [early, attach], 3, "control=attached,state;media=stream"))
        cases.append(("twoEarlyStatesKeepArrivalOrder", [earlyWith(["state": "connecting"], ["serverTime": 1]), earlyWith(["state": "connecting"], ["serverTime": 2]), attach] + ready, 4,
                      "control=attached,state,state;media=stream"))
        cases.append(("fourEarlyStatesIsTheCountLimit", repeated(early, 4) + [attach] + ready, 6, "control=attached,state,state,state,state;media=stream"))
        cases.append(("fifthEarlyStateRejected", repeated(early, 5) + [attach] + ready, 7, "closed:screen_attach_invalid"))
        cases.append(("largeEarlyStateWithinByteLimit", [padded, attach] + ready, 3, "control=attached,state;media=stream"))
        cases.append(("earlyStatesOverByteLimitRejected", repeated(padded, 2) + [attach] + ready, 4, "closed:screen_attach_invalid"))
        cases.append(("earlyStateOtherSessionRejected", [earlyWith(["id": "other-session"]), attach] + ready, 3, "closed:screen_scope_invalid"))
        cases.append(("earlyStateOtherGenerationRejected", [earlyWith(["generation": "other-generation"]), attach] + ready, 3, "closed:screen_scope_invalid"))
        cases.append(("earlyStateOtherDesktopRejected", [earlyWith(["desktopId": "other-desktop"]), attach] + ready, 3, "closed:screen_scope_invalid"))
        cases.append(("earlyStateUnknownFieldRejected", [earlyWith([:], ["extra": true]), attach] + ready, 3, "closed:screen_protocol_invalid"))
        cases.append(("earlyFrameReadyStillRejected", [frameReady, attach] + ready, 3, "closed:screen_attach_invalid"))
        cases.append(("earlyMediaStreamStillRejected", [attach, ("media", { _ in stream }), ("media", attached)], 2, "closed:screen_attach_invalid"))
        cases.append(("earlyStateOnMediaRejected", [attach, ("media", { state($0) }), ("media", attached)], 2, "closed:screen_attach_invalid"))
        cases.append(("otherSessionAttachedAfterEarlyStateRejected", [early, ("control", { _ in ["type": "attached", "sessionId": "other-session"] })] + ready, 3, "closed:screen_attach_invalid"))
        var observed: [String: String] = [:]
        for (name, steps, count, expected) in cases {
            let value = join(), id = try await openUnattached(manager, fixture, document, value)
            for (role, make) in steps { try peer(fixture, value, role, make(value)) }
            let (seen, values) = try await outcome(manager, log, id, count); observed[name] = seen
            if seen == expected, name == "twoEarlyStatesKeepArrivalOrder" {
                observed[name] = seen + (values.compactMap { $0["type"] as? String == "state" ? $0["serverTime"] as? Int : nil } == [1, 2] ? "" : "+reordered")
            }
            if name == "realHubStateBeforeAttached", seen == expected {
                _ = try fixture.request(["action": "frame", "id": sid(value), "sequence": 1, "size": 64])
                let packet = try await event(manager, log, id, "binary")
                _ = try await call(manager, "screenRead", ["id": id, "deliverySequence": packet["deliverySequence"]!, "offset": 0, "maxBytes": 64])
                _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": packet["deliverySequence"]!])
                try check(log.count(id) == 0, "realHubOrderStillCarriesMedia")
            }
            if !seen.hasPrefix("closed:") { _ = try await call(manager, "screenClose", ["id": id]); _ = try await event(manager, log, id, "close") }
            try await peerClosed(fixture, value)
            try check(log.count(id) == 1, name + "SingleTerminal")
        }
        // The Host may close a session while attaching (service offline): its
        // closed state precedes the 4000 frame. The host reason must survive.
        let closing = join(), closingID = try await openUnattached(manager, fixture, document, closing)
        _ = try fixture.request(["action": "close-host", "id": sid(closing), "code": 4000, "reason": "screen_service_offline"])
        observed["earlyClosedStateKeepsHostReason"] = try await outcome(manager, log, closingID, 1).0
        try await peerClosed(fixture, closing)
        // A buffered state changes nothing before attached; afterwards it is the
        // same state message as on a new Hub, still bounded by controlAllowed.
        for (allowed, name, expectRenew) in [(true, "earlyControllingStateAppliesOnlyAfterAttached", true), (false, "viewOnlyEarlyControllingStateNeverGrants", false)] {
            let value = join(allowed), id = try await openUnattached(manager, fixture, document, value)
            let renew = command(value, "renew", ["leaseId": lease["id"]!, "challenge": lease["challenge"]!, "frameSequence": 1])
            try peer(fixture, value, "control", state(value, "controlling", ["lease": lease]))
            try await Task.sleep(nanoseconds: 300_000_000)
            var trace: [String] = []
            _ = try? await call(manager, "screenSend", ["id": id, "command": command(value, "input-focus", ["enabled": true])])
            do { _ = try await call(manager, "screenSend", ["id": id, "command": renew]); trace.append("renewBeforeAttached=sent") } catch { trace.append("renewBeforeAttached=denied") }
            try peer(fixture, value, "control", attached(value)); for (role, make) in ready { try peer(fixture, value, role, make(value)) }
            let (seen, _) = try await outcome(manager, log, id, 3); trace.append(seen)
            _ = try? await call(manager, "screenSend", ["id": id, "command": command(value, "input-focus", ["enabled": true])])
            do { _ = try await call(manager, "screenSend", ["id": id, "command": renew]); trace.append("renewAfterAttached=sent") } catch { trace.append("renewAfterAttached=denied") }
            if expectRenew {
                var renewed = 0
                for _ in 0..<200 {
                    renewed = (try fixture.request(["action": "stats"])["commands"] as! [[String: Any]]).filter { $0["id"] as? String == sid(value) && ($0["value"] as? [String: Any])?["type"] as? String == "renew" }.count
                    if renewed > 0 { try await Task.sleep(nanoseconds: 200_000_000); break }
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
                renewed = (try fixture.request(["action": "stats"])["commands"] as! [[String: Any]]).filter { $0["id"] as? String == sid(value) && ($0["value"] as? [String: Any])?["type"] as? String == "renew" }.count
                trace.append("hubRenewCount=\(renewed)")
            }
            observed[name] = trace.joined(separator: " ")
            if !seen.hasPrefix("closed:") { _ = try await call(manager, "screenClose", ["id": id]) }
            try await peerClosed(fixture, value)
        }
        // Early state never buys attach time.
        let clock = ScreenClock(), clockedLog = ScreenEvents()
        let clocked = HubTransport(screenNow: { clock.read() }) { clockedLog.append($0) }; defer { clocked.reset(destroy: true) }
        clocked.setScreenActive(true)
        let clockedDocument = try await call(clocked, "document")["value"] as! String, slow = join()
        let slowID = try await openUnattached(clocked, fixture, clockedDocument, slow)
        try peer(fixture, slow, "control", state(slow)); try peer(fixture, slow, "media", attached(slow))
        clock.set(4.9); try await Task.sleep(nanoseconds: 350_000_000)
        let closesBefore = clockedLog.count(slowID)
        clock.set(5); let timeout = try await event(clocked, clockedLog, slowID, "close")
        observed["earlyStateDoesNotExtendAttachDeadline"] = "before=\(closesBefore) at5s=\(timeout["reason"] as? String ?? "?")"
        try await peerClosed(fixture, slow)
        var expected = Dictionary(uniqueKeysWithValues: cases.map { ($0.0, $0.3) })
        expected["earlyClosedStateKeepsHostReason"] = "closed:screen_service_offline"
        expected["earlyControllingStateAppliesOnlyAfterAttached"] = "renewBeforeAttached=denied control=attached,state;media=stream renewAfterAttached=sent hubRenewCount=1"
        expected["viewOnlyEarlyControllingStateNeverGrants"] = "renewBeforeAttached=denied control=attached,state;media=stream renewAfterAttached=denied"
        expected["earlyStateDoesNotExtendAttachDeadline"] = "before=0 at5s=screen_attach_timeout"
        let report = try JSONSerialization.data(withJSONObject: ["observed": observed, "expected": expected], options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardError.write(report); FileHandle.standardError.write(Data("\n".utf8))
        for (name, value) in expected.sorted(by: { $0.key < $1.key }) { try check(observed[name] == value, "order_" + name) }
    }
    /// The native session against this checkout's real HubServer: the Hub's
    /// own control order (state before attached on released Hubs), real tickets,
    /// auth and RemoteScreenSockets; only the target service is synthetic.
    static func realHub(_ fixture: ScreenFixture) async throws {
        let log = ScreenEvents()
        let manager = HubTransport { log.append($0) }; defer { manager.reset(destroy: true) }
        manager.setScreenActive(true)
        let document = try await call(manager, "document")["value"] as! String
        var observed: [String: String] = [:], expected: [String: String] = [:]
        for round in 1...3 {
            let opened = try fixture.request(["action": "open"])
            guard let join = opened["join"] as? [String: Any] else { throw HubNetworkError("real_hub_open_" + (opened["error"] as? String ?? "failed")) }
            let id = try await call(manager, "allocate", ["document": document, "kind": "screen"])["value"] as! String
            _ = try await call(manager, "screenOpen", ["id": id, "network": fixture.network, "join": join])
            var control: [String] = [], stream = false, packet = false, reason: String?
            // JSON is drained (and acknowledged) before each packet check, so a
            // queued stream/state is never mistaken for a missing one.
            func drain() async throws {
                while let event = log.pop(id, "screen") {
                    guard manager.acceptScreenEvent(event) else { continue }
                    _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": event["deliverySequence"]!])
                    let type = (event["value"] as! [String: Any])["type"] as! String
                    if type == "stream" { stream = true } else { control.append(type) }
                }
            }
            let until = ProcessInfo.processInfo.systemUptime + 8
            while ProcessInfo.processInfo.systemUptime < until, !packet {
                if let terminal = log.pop(id, "close") { reason = terminal["reason"] as? String ?? "?"; break }
                try await drain()
                if let event = log.pop(id, "binary"), manager.acceptScreenEvent(event) {
                    let bytes = Data(base64Encoded: try await call(manager, "screenRead", ["id": id, "deliverySequence": event["deliverySequence"]!, "offset": 0, "maxBytes": 262144])["data"] as! String)!
                    _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": event["deliverySequence"]!])
                    packet = bytes.count == event["byteLength"] as? Int
                }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            if reason == nil { try await Task.sleep(nanoseconds: 300_000_000); try await drain() }
            observed["round\(round)"] = reason.map { "closed:" + $0 }
                ?? "firstControl=\(control.first ?? "-") state=\(control.contains("state")) stream=\(stream) frame=\(packet)"
            expected["round\(round)"] = "firstControl=attached state=true stream=true frame=true"
            if reason == nil {
                observed["round\(round)Healthy"] = log.count(id) == 0 ? "open" : "closed"; expected["round\(round)Healthy"] = "open"
                _ = try await call(manager, "screenClose", ["id": id]); _ = try await event(manager, log, id, "close")
            }
            var stop: String?
            for _ in 0..<200 {
                stop = (try fixture.request(["action": "stats"])["stops"] as? [String: String])?[sid(join)]
                if stop != nil { break }; try await Task.sleep(nanoseconds: 10_000_000)
            }
            observed["round\(round)HubStop"] = stop ?? "none"
        }
        let report = try JSONSerialization.data(withJSONObject: ["observed": observed, "expected": expected], options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardError.write(report); FileHandle.standardError.write(Data("\n".utf8))
        for (name, value) in expected.sorted(by: { $0.key < $1.key }) { try check(observed[name] == value, "realHub_" + name) }
    }
    static func frame(_ fixture: ScreenFixture, _ join: [String: Any], _ generation: Int, _ sequence: Int) throws {
        _ = try fixture.request(["action": "frame", "id": sid(join), "generation": generation, "sequence": sequence, "size": 4096])
    }
    /** Binary deliveries (accepted through the plugin gate, not read) until `count`, or the terminal close. */
    static func packets(_ manager: HubTransport, _ log: ScreenEvents, _ id: String, _ count: Int) async throws -> (packets: [[String: Any]], closed: String?) {
        var found: [[String: Any]] = []
        let until = ProcessInfo.processInfo.systemUptime + 5
        while found.count < count, ProcessInfo.processInfo.systemUptime < until {
            if let terminal = log.pop(id, "close") { return (found, terminal["reason"] as? String ?? "?") }
            if let packet = log.pop(id, "binary"), manager.acceptScreenEvent(packet) { found.append(packet); continue }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        if let terminal = log.pop(id, "close") { return (found, terminal["reason"] as? String ?? "?") }
        return (found, nil)
    }
    static func consume(_ manager: HubTransport, _ id: String, _ packet: [String: Any]) async throws {
        let size = packet["byteLength"] as! Int; var total = 0
        while total < size { total += Data(base64Encoded: try await call(manager, "screenRead", ["id": id, "deliverySequence": packet["deliverySequence"]!, "offset": total, "maxBytes": 262144])["data"] as! String)!.count }
        _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": packet["deliverySequence"]!])
    }
    /** A stream restart: the next generation's config on media, acknowledged as the page does. */
    static func restart(_ manager: HubTransport, _ log: ScreenEvents, _ fixture: ScreenFixture, _ join: [String: Any], _ id: String, _ generation: Int) async throws -> Int? {
        _ = try fixture.request(["action": "stream", "id": sid(join), "generation": generation])
        let config = try await event(manager, log, id, "screen")
        _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": config["deliverySequence"]!])
        return (config["value"] as? [String: Any])?["streamGeneration"] as? Int
    }
    /** A-5 (as Android's NativeScreenAudit.streamRestart). The target's three-frame credit window
     * belongs to one stream generation: a restart (start control, keyframe, resume) retires it and
     * the next generation may send three at once while the page still reads the old one's. */
    static func streamRestart(_ fixture: ScreenFixture) async throws {
        let log = ScreenEvents()
        let manager = HubTransport { log.append($0) }; defer { manager.reset(destroy: true) }
        manager.setScreenActive(true)
        let document = try await call(manager, "document")["value"] as! String
        var observed: [String: String] = [:]
        let value = join(true), id = try await open(manager, log, fixture, document, value)
        try frame(fixture, value, 1, 1); let old = try await packets(manager, log, id, 1)
        observed["restartConfigDelivered"] = String(describing: try await restart(manager, log, fixture, value, id, 2))
        for sequence in 1...3 { try frame(fixture, value, 2, sequence) }
        let fresh = try await packets(manager, log, id, 3)
        observed["restartWindowAdmittedBehindUnreadPacket"] = fresh.closed.map { "closed:" + $0 } ?? "admitted:\(fresh.packets.count)"
        if fresh.closed == nil {
            for packet in old.packets + fresh.packets { try await consume(manager, id, packet) }
            try await Task.sleep(nanoseconds: 300_000_000)
            observed["restartedSessionStaysOpen"] = log.count(id) == 0 ? "open" : "closed"
            for sequence in 4...6 { try frame(fixture, value, 2, sequence) }
            let window = try await packets(manager, log, id, 3)
            observed["generationWindowRefills"] = window.closed.map { "closed:" + $0 } ?? "admitted:\(window.packets.count)"
            try frame(fixture, value, 2, 7)
            observed["generationWindowStillBounded"] = try await packets(manager, log, id, 1).closed.map { "closed:" + $0 } ?? "admitted"
        }
        try await peerClosed(fixture, value)
        // Two restarts without reading: the total stays bounded at one current plus one superseded window.
        let chain = join(true), chainID = try await open(manager, log, fixture, document, chain)
        for sequence in 1...3 { try frame(fixture, chain, 1, sequence) }
        var stage = try await packets(manager, log, chainID, 3)
        if stage.closed == nil { _ = try await restart(manager, log, fixture, chain, chainID, 2); for sequence in 1...3 { try frame(fixture, chain, 2, sequence) }; stage = try await packets(manager, log, chainID, 3) }
        if stage.closed == nil { _ = try await restart(manager, log, fixture, chain, chainID, 3); try frame(fixture, chain, 3, 1); stage = try await packets(manager, log, chainID, 1) }
        observed["retainedPacketsStillBounded"] = stage.closed.map { "closed:" + $0 } ?? "admitted"
        try await peerClosed(fixture, chain)
        let expected = ["restartConfigDelivered": "Optional(2)", "restartWindowAdmittedBehindUnreadPacket": "admitted:3", "restartedSessionStaysOpen": "open",
                        "generationWindowRefills": "admitted:3", "generationWindowStillBounded": "closed:screen_viewer_congested",
                        "retainedPacketsStillBounded": "closed:screen_viewer_congested"]
        let report = try JSONSerialization.data(withJSONObject: ["observed": observed, "expected": expected], options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardError.write(report); FileHandle.standardError.write(Data("\n".utf8))
        for (name, value) in expected.sorted(by: { $0.key < $1.key }) { try check(observed[name] == value, "restart_" + name) }
    }
    static func refusal(_ manager: HubTransport, _ id: String, _ command: [String: Any]) async -> String {
        do { _ = try await call(manager, "screenSend", ["id": id, "command": command]); return "accepted" }
        catch { return (error as? HubNetworkError)?.code ?? String(describing: error) }
    }
    /** F-AND-3 (as Android's NativeScreenAudit.controlWithdrawn). Native applies a state on
     * arrival, so a renew or input the page sent before consuming "control ended" arrives late. */
    static func controlWithdrawn(_ fixture: ScreenFixture) async throws {
        let log = ScreenEvents()
        let manager = HubTransport { log.append($0) }; defer { manager.reset(destroy: true) }
        manager.setScreenActive(true)
        let document = try await call(manager, "document")["value"] as! String
        var observed: [String: String] = [:]
        let value = join(true), id = try await open(manager, log, fixture, document, value)
        _ = try fixture.request(["action": "control-state", "id": sid(value), "active": true])
        let granted = try await event(manager, log, id, "screen"); _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": granted["deliverySequence"]!])
        let renew = command(value, "renew", ["leaseId": String(repeating: "L", count: 43), "challenge": String(repeating: "C", count: 43), "frameSequence": 1])
        let input = command(value, "input", ["desktopId": "synthetic-desktop", "displayId": "synthetic", "displayRevision": 1, "leaseId": String(repeating: "L", count: 43), "sequence": 1,
                                             "frameSequence": 1, "expiresAt": Int(Date().timeIntervalSince1970 * 1000) + 1000, "event": ["kind": "move", "x": 0.5, "y": 0.5]])
        _ = try await call(manager, "screenSend", ["id": id, "command": command(value, "input-focus", ["enabled": true])])
        observed["renewWhileControlling"] = await refusal(manager, id, renew)
        // Withdrawn: native applies the state on arrival; the page has not consumed it yet.
        _ = try fixture.request(["action": "control-state", "id": sid(value), "active": false])
        let viewing = try await event(manager, log, id, "screen")
        observed["lateRenewRefusedAsControlEnded"] = await refusal(manager, id, renew)
        observed["lateInputRefusedAsControlEnded"] = await refusal(manager, id, input)
        var malformed = renew; malformed["challenge"] = "short"
        observed["malformedRenewStillProtocolError"] = await refusal(manager, id, malformed)
        var foreign = input; foreign["desktopId"] = "other"
        observed["foreignInputStillProtocolError"] = await refusal(manager, id, foreign)
        _ = try await call(manager, "screenAck", ["id": id, "deliverySequence": viewing["deliverySequence"]!])
        try await Task.sleep(nanoseconds: 300_000_000)
        observed["viewingSurvivesWithdrawnControl"] = log.count(id) == 0 ? "open" : "closed"
        var forwarded = (0, 0)
        for _ in 0..<100 {
            let commands = (try fixture.request(["action": "stats"])["commands"] as! [[String: Any]]).filter { $0["id"] as? String == sid(value) }.compactMap { ($0["value"] as? [String: Any])?["type"] as? String }
            forwarded = (commands.filter { $0 == "renew" }.count, commands.filter { $0 == "input" }.count)
            if forwarded.0 > 0 { break }; try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 200_000_000)
        let commands = (try fixture.request(["action": "stats"])["commands"] as! [[String: Any]]).filter { $0["id"] as? String == sid(value) }.compactMap { ($0["value"] as? [String: Any])?["type"] as? String }
        forwarded = (commands.filter { $0 == "renew" }.count, commands.filter { $0 == "input" }.count)
        observed["withdrawnControlForwardsNothing"] = "renews=\(forwarded.0) inputs=\(forwarded.1)"
        try frame(fixture, value, 1, 1); let flowing = try await packets(manager, log, id, 1)
        if flowing.closed == nil, let packet = flowing.packets.first { try await consume(manager, id, packet) }
        try await Task.sleep(nanoseconds: 200_000_000)
        observed["framesFlowAfterWithdrawnControl"] = flowing.closed == nil && log.count(id) == 0 ? "open" : "closed"
        _ = try await call(manager, "screenClose", ["id": id]); _ = try await event(manager, log, id, "close"); try await peerClosed(fixture, value)
        // screen_input_denied stays the controlled computer's own refusal (Accessibility, held
        // input); a view-only session asking for control is a protocol error, as on Android.
        let viewOnly = join(false), viewOnlyID = try await open(manager, log, fixture, document, viewOnly)
        observed["viewOnlyControlIsProtocolError"] = await refusal(manager, viewOnlyID, command(viewOnly, "control", ["frameSequence": 1]))
        _ = try await call(manager, "screenClose", ["id": viewOnlyID]); _ = try await event(manager, log, viewOnlyID, "close"); try await peerClosed(fixture, viewOnly)
        let expected = ["renewWhileControlling": "accepted", "lateRenewRefusedAsControlEnded": "screen_control_ended", "lateInputRefusedAsControlEnded": "screen_control_ended",
                        "malformedRenewStillProtocolError": "screen_command_invalid", "foreignInputStillProtocolError": "screen_command_invalid",
                        "viewingSurvivesWithdrawnControl": "open", "withdrawnControlForwardsNothing": "renews=1 inputs=0", "framesFlowAfterWithdrawnControl": "open",
                        "viewOnlyControlIsProtocolError": "screen_command_invalid"]
        let report = try JSONSerialization.data(withJSONObject: ["observed": observed, "expected": expected], options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardError.write(report); FileHandle.standardError.write(Data("\n".utf8))
        for (name, value) in expected.sorted(by: { $0.key < $1.key }) { try check(observed[name] == value, "withdrawn_" + name) }
    }
    static func main() async throws {
        let args = CommandLine.arguments
        if ProcessInfo.processInfo.environment["SCREEN_AUDIT_FOCUS"] == "real-hub" {
            let hub = try ScreenFixture(args[1], args[2], ["--import", "tsx", "tests/helpers/ios-screen-real-hub.ts"]); defer { hub.stop() }
            try await realHub(hub)
            let receipt: [String: Any] = ["surface": "Apple Foundation production source; this checkout's HubServer over pinned TLS; synthetic target frames only", "checks": checks]
            let bytes = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]); try bytes.write(to: URL(fileURLWithPath: args[3]))
            print(String(data: bytes, encoding: .utf8)!); return
        }
        let fixture = try ScreenFixture(args[1], args[2]); defer { fixture.stop() }
        if let focus = ProcessInfo.processInfo.environment["SCREEN_AUDIT_FOCUS"] {
            if focus == "close" { try await closeReasons(fixture) }
            else if focus == "clock" { try await attachClock(fixture) }
            else if focus == "order" { try await attachOrder(fixture) }
            else if focus == "restart" { try await streamRestart(fixture) }
            else if focus == "withdrawn" { try await controlWithdrawn(fixture) }
            else { throw HubNetworkError("unknown_screen_audit_focus") }
            let receipt: [String: Any] = ["surface": "Apple Foundation production source; real pinned TLS dual sockets; injected monotonic clock only", "checks": checks]
            let bytes = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]); try bytes.write(to: URL(fileURLWithPath: args[3]))
            print(String(data: bytes, encoding: .utf8)!); return
        }
        try await closeReasons(fixture); try await attachClock(fixture); try await attachOrder(fixture); try await streamRestart(fixture); try await controlWithdrawn(fixture)
        let log = ScreenEvents()
        // Event capture does not acknowledge automatically; the same delivery
        // gate used by the plugin is exercised explicitly for every event.
        let transport = HubTransport { log.append($0) }; defer { transport.reset(destroy: true) }
        var document = try await call(transport, "document")["value"] as! String
        try await reject("inactiveAllocationRejected") { _ = try await call(transport, "allocate", ["kind": "screen", "document": document]) }
        transport.setScreenActive(true)
        let good = join(), id = try await open(transport, log, fixture, document, good)
        try await Task.sleep(nanoseconds: 6_000_000_000)
        try check(log.count(id) == 0, "healthyIdleSessionSurvivesNativeResourceTimer")
        _ = try fixture.request(["action": "frame", "id": sid(good), "sequence": 1])
        let binary = try await event(transport, log, id, "binary"), n = binary["deliverySequence"]!
        try await reject("partialAckRejected") { _ = try await call(transport, "screenAck", ["id": id, "deliverySequence": n]) }
        try await reject("nonSequentialReadRejected") { _ = try await call(transport, "screenRead", ["id": id, "deliverySequence": n, "offset": 1, "maxBytes": 262144]) }
        try await reject("oversizeReadRejected") { _ = try await call(transport, "screenRead", ["id": id, "deliverySequence": n, "offset": 0, "maxBytes": 262145]) }
        let a = Data(base64Encoded: try await call(transport, "screenRead", ["id": id, "deliverySequence": n, "offset": 0, "maxBytes": 262144])["data"] as! String)!
        let b = Data(base64Encoded: try await call(transport, "screenRead", ["id": id, "deliverySequence": n, "offset": a.count, "maxBytes": 262144])["data"] as! String)!
        try check(a.count == 262144 && a.count + b.count == binary["byteLength"] as? Int && b.last == 97, "binaryReassembledExactly")
        _ = try await call(transport, "screenAck", ["id": id, "deliverySequence": n])
        try await reject("duplicateAckRejected") { _ = try await call(transport, "screenAck", ["id": id, "deliverySequence": n]) }
        try await reject("ackedPacketUnavailable") { _ = try await call(transport, "screenRead", ["id": id, "deliverySequence": n, "offset": 0, "maxBytes": 1]) }
        try await reject("viewOnlyControlRejected") { _ = try await call(transport, "screenSend", ["id": id, "command": command(good, "control", ["frameSequence": 1])]) }
        var stale = command(good, "keyframe"); stale["generation"] = "stale"
        try await reject("generationMismatchRejected") { _ = try await call(transport, "screenSend", ["id": id, "command": stale]) }
        _ = try await call(transport, "screenSend", ["id": id, "command": command(good, "keyframe")])
        _ = try await call(transport, "screenClose", ["id": id]); _ = try await call(transport, "screenClose", ["id": id])
        _ = try await event(transport, log, id, "close"); try await peerClosed(fixture, good)
        try check(log.count(id) == 1, "closeIdempotentAndSingleTerminal")
        let left = join(), right = join()
        let leftID = try await open(transport, log, fixture, document, left), rightID = try await open(transport, log, fixture, document, right)
        _ = try await call(transport, "screenClose", ["id": leftID]); try await peerClosed(fixture, left)
        _ = try fixture.request(["action": "frame", "id": sid(right), "sequence": 1, "size": 64])
        let siblingPacket = try await event(transport, log, rightID, "binary")
        _ = try await call(transport, "screenRead", ["id": rightID, "deliverySequence": siblingPacket["deliverySequence"]!, "offset": 0, "maxBytes": 64])
        _ = try await call(transport, "screenAck", ["id": rightID, "deliverySequence": siblingPacket["deliverySequence"]!])
        try check(log.count(rightID) == 0, "closingOneGroupPreservesAnotherNativeSession")
        _ = try await call(transport, "screenClose", ["id": rightID]); try await peerClosed(fixture, right)
        for mode in ["fourthPacket", "jsonOverflow", "siblingFailure", "malformed", "unackedTimeout"] {
            let value = join(), opened = try await open(transport, log, fixture, document, value)
            if mode == "jsonOverflow" { _ = try fixture.request(["action": "json-burst", "id": sid(value), "count": 9]) }
            else if mode == "siblingFailure" { _ = try fixture.request(["action": "close-media", "id": sid(value)]) }
            else { for sequence in 1...(mode == "fourthPacket" ? 4 : 1) { _ = try fixture.request(["action": "frame", "id": sid(value), "sequence": sequence, "malformed": mode == "malformed"]) } }
            _ = try await event(transport, log, opened, "close"); try await peerClosed(fixture, value)
            try check(log.count(opened) == 1, mode + "ClosesBothExactlyOnce")
            if let queued = log.pop(opened, "binary") { try check(!transport.acceptScreenEvent(queued), "retiredBinaryCallbackFiltered") }
            if let queued = log.pop(opened, "screen") { try check(!transport.acceptScreenEvent(queued), "retiredJSONCallbackFiltered") }
        }
        let focusJoin = join(true), focusID = try await open(transport, log, fixture, document, focusJoin)
        _ = try fixture.request(["action": "control-state", "id": sid(focusJoin), "active": true])
        let controlState = try await event(transport, log, focusID, "screen")
        _ = try await call(transport, "screenAck", ["id": focusID, "deliverySequence": controlState["deliverySequence"]!])
        let renew = command(focusJoin, "renew", ["leaseId": String(repeating: "L", count: 43), "challenge": String(repeating: "C", count: 43), "frameSequence": 1])
        try await reject("unfocusedRenewRejected") { _ = try await call(transport, "screenSend", ["id": focusID, "command": renew]) }
        _ = try await call(transport, "screenSend", ["id": focusID, "command": command(focusJoin, "input-focus", ["enabled": true])])
        _ = try await call(transport, "screenSend", ["id": focusID, "command": renew])
        _ = try await call(transport, "screenSend", ["id": focusID, "command": command(focusJoin, "input-focus", ["enabled": false])])
        try await reject("focusLossRejectsRenew") { _ = try await call(transport, "screenSend", ["id": focusID, "command": renew]) }
        _ = try await call(transport, "screenClose", ["id": focusID]); try await peerClosed(fixture, focusJoin)
        let chat = try await call(transport, "allocate", ["kind": "socket", "document": document])["value"] as! String
        _ = try await call(transport, "socketOpen", ["id": chat, "origin": fixture.network["url"]!, "hubKey": fixture.network["publicKey"]!, "certificateAuthority": fixture.network["certificateAuthority"]!])
        _ = try await event(transport, log, chat, "open")
        let bg = join(true), bgID = try await open(transport, log, fixture, document, bg)
        try await reject("alreadyQueuedSendRejectedAcrossBackgroundForeground") {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let latch = DispatchSemaphore(value: 0)
                transport.queue.async { latch.wait() }
                transport.invoke("screenSend", ["id": bgID, "command": command(bg, "keyframe")]) { continuation.resume(with: $0.map { _ in () }) }
                transport.setScreenActive(false); transport.setScreenActive(true); latch.signal()
            }
        }
        _ = try await event(transport, log, bgID, "close"); try await peerClosed(fixture, bg)
        try await reject("foregroundDoesNotReviveOldGroup") { _ = try await call(transport, "screenSend", ["id": bgID, "command": command(bg, "control", ["frameSequence": 1])]) }
        _ = try await call(transport, "socketSend", ["id": chat, "text": "synthetic-chat-after-background"])
        let echo = try await event(transport, log, chat, "message")
        try check(echo["data"] as? String == "synthetic-chat-after-background", "screenLifecyclePreservesSharedChatSocket")
        _ = try await call(transport, "socketAck", ["id": chat, "sequence": echo["sequence"]!])
        _ = try await call(transport, "cancel", ["id": chat])
        let reload = join(), reloadID = try await open(transport, log, fixture, document, reload)
        _ = try fixture.request(["action": "frame", "id": sid(reload), "sequence": 1])
        let pending = try await event(transport, log, reloadID, "binary", notify: false), old = document
        document = try await call(transport, "document")["value"] as! String
        try check(!transport.acceptScreenEvent(pending), "newDocumentRejectsQueuedCallback")
        try await reject("newDocumentRejectsOldPacket") { _ = try await call(transport, "screenRead", ["id": reloadID, "deliverySequence": pending["deliverySequence"]!, "offset": 0, "maxBytes": 1]) }
        try await reject("oldDocumentRejected") { _ = try await call(transport, "allocate", ["kind": "screen", "document": old]) }
        try await peerClosed(fixture, reload)
        let first = try await call(transport, "allocate", ["kind": "screen", "document": document])["value"] as! String
        let second = try await call(transport, "allocate", ["kind": "screen", "document": document])["value"] as! String
        try await reject("thirdGroupRejected") { _ = try await call(transport, "allocate", ["kind": "screen", "document": document]) }
        _ = try await call(transport, "screenClose", ["id": first]); _ = try await call(transport, "screenClose", ["id": second])
        let before = try fixture.request(["action": "stats"])["helloCount"] as! Int
        var bad = join(); bad["expiresAt"] = 0
        let invalid = try await call(transport, "allocate", ["kind": "screen", "document": document])["value"] as! String
        try await reject("expiredJoinRejectedBeforeNetwork") { _ = try await call(transport, "screenOpen", ["id": invalid, "network": fixture.network, "join": bad]) }
        var wrongKey = fixture.network; wrongKey["publicKey"] = "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        let untrusted = try await call(transport, "allocate", ["kind": "screen", "document": document])["value"] as! String
        try await reject("pairedKeyMismatchRejected") { _ = try await call(transport, "screenOpen", ["id": untrusted, "network": wrongKey, "join": join()]) }
        let pendingTransport = HubTransport { _ in }
        pendingTransport.setScreenActive(true)
        let pendingDoc = try await call(pendingTransport, "document")["value"] as! String
        let pendingID = try await call(pendingTransport, "allocate", ["kind": "screen", "document": pendingDoc])["value"] as! String
        let proofBefore = try fixture.request(["action": "stats"])["proofCount"] as! Int
        _ = try fixture.request(["action": "hold-proof", "hold": true])
        let opening = Task { try await call(pendingTransport, "screenOpen", ["id": pendingID, "network": fixture.network, "join": join()]) }
        for _ in 0..<100 {
            if (try fixture.request(["action": "stats"])["proofCount"] as! Int) > proofBefore { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        pendingTransport.setScreenActive(false)
        try await reject("backgroundCancelsPendingTLSOpen") { _ = try await opening.value }
        _ = try fixture.request(["action": "hold-proof", "hold": false])
        pendingTransport.setScreenActive(true)
        try await Task.sleep(nanoseconds: 100_000_000)
        pendingTransport.reset(destroy: true)
        let stats = try fixture.request(["action": "stats"])
        try check(stats["helloCount"] as? Int == before, "invalidJoinAndTrustSendNoTicket")
        try check((stats["paths"] as! [String]).allSatisfy { ["/screen/v1/control", "/screen/v1/media"].contains($0) }, "onlyFixedViewerRoutes")
        try check((stats["open"] as! [Any]).isEmpty, "allPeersClosed")
        let receipt: [String: Any] = ["surface": "Apple Foundation production source; real pinned TLS and dual WebSockets; synthetic frames only", "checks": checks]
        let bytes = try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted, .sortedKeys]); try bytes.write(to: URL(fileURLWithPath: args[3]))
        print(String(data: bytes, encoding: .utf8)!)
    }
}
