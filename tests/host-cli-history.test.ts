import { expect, it, vi } from "vitest";
import { runHistoryCommand } from "../src/host-cli/history.js";
import { HOST_CLI_HELP } from "../src/host-cli/cli.js";
const operation = { requestId: "request", operationId: "operation", state: "unknown", sourceRevision: "revision", reason: "uncertain" };
it("uses the shared owner API and keeps unknown status a GET", async () => {
  const request = vi.fn(async () => operation), client = { request, supports: () => true };
  expect(await runHistoryCommand(client as any, "fork", "chat", { bot: "bot", revision: "revision", requestId: "request" })).toEqual(operation);
  expect(request.mock.calls[0]).toEqual(["/api/conversations/chat/history/operations", "POST", { botId: "bot", requestId: "request", expectedRevision: "revision", action: { kind: "fork", scope: "whole" } }]);
  await runHistoryCommand(client as any, "status", "chat", { bot: "bot", requestId: "request" });
  expect(request.mock.calls[1]).toEqual(["/api/conversations/chat/history/operations/request?botId=bot"]);
  await runHistoryCommand(client as any, "reconcile", "chat", { bot: "bot", action: "fork", revision: "revision", requestId: "request" });
  expect(request.mock.calls[2]).toEqual(["/api/conversations/chat/history/operations/request/reconcile", "POST", { botId: "bot", requestId: "request", expectedRevision: "revision", action: { kind: "fork", scope: "whole" } }]);
  expect(HOST_CLI_HELP).toContain("history status");
});
it("rejects missing explicit operation identity and old Hosts before sending", async () => {
  const request = vi.fn(), client = { request, supports: () => true };
  await expect(runHistoryCommand(client as any, "rewind", "chat", { bot: "bot", anchor: "anchor" })).rejects.toThrow("--request-id");
  await expect(runHistoryCommand({ ...client, supports: () => false } as any, "snapshot", "chat", { bot: "bot" })).rejects.toThrow("更新主机");
  expect(request).not.toHaveBeenCalled();
});
