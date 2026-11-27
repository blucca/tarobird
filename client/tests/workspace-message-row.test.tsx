import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "../src/connection.js";

vi.mock("../src/Avatar.js", () => ({ Avatar: () => null }));
vi.mock("../src/BackgroundTaskGroup.js", () => ({ BackgroundTaskGroup: () => null }));
vi.mock("../src/ConversationMessageContent.js", () => ({ ConversationMessageContent: () => null }));
vi.mock("../src/ConversationHistoryDialog.js", () => ({ HistoryExclusion: () => null }));
vi.mock("../src/DispatchTickets.js", () => ({ DispatchNotice: () => null }));
vi.mock("../src/Content.js", () => ({ GoogleExport: () => null }));
vi.mock("../src/UserReplyStatus.js", () => ({ UserReplyStatus: () => null }));
vi.mock("../src/widget-compose.js", () => ({ WidgetComposeProvider: ({ children }: { children: unknown }) => children }));

import { WorkspaceMessageRow, type WorkspaceMessageRowProps } from "../src/WorkspaceMessageRow.js";

function renderAuthor(overrides: Partial<WorkspaceMessageRowProps> & { message?: Partial<Message> }): string {
  const { message: messagePatch, ...propOverrides } = overrides;
  const message: Message = {
    id: "m1",
    conversationId: "c1",
    authorId: "bot_aaa111",
    authorType: "bot",
    blocks: [{ type: "text", text: "hello" }],
    status: "complete",
    version: 1,
    createdAt: Date.now(),
    ...messagePatch,
  };
  const props: WorkspaceMessageRowProps = {
    message,
    index: 0,
    start: 0,
    measureRef: () => {},
    connection: {} as HubConnection,
    locale: "zh",
    localDay: 20261127,
    phone: false,
    compactTime: false,
    live: true,
    isGroup: false,
    archived: false,
    groupSending: false,
    retryBlocked: false,
    canRetryMessage: false,
    isTicketNoticeRow: false,
    copiedHere: false,
    focusedHere: false,
    deletionActive: false,
    deletionSelected: false,
    authorLabel: "TaroBird",
    scheduledName: "Bot",
    referenceAvailable: true,
    labels: new Map(),
    widgetOwner: "owner",
    widgetActive: true,
    widgetScope: "scope",
    onLocate: () => {},
    onWidgetCompose: () => false,
    onPreparePlainText: () => {},
    onCopy: () => {},
    onQuote: () => {},
    onForward: () => {},
    onRetry: () => {},
    onOpenSheet: () => {},
    onDeletionToggle: () => {},
    onDeletionClose: () => {},
    ...propOverrides,
  };
  const html = renderToStaticMarkup(<WorkspaceMessageRow {...props} />);
  const match = html.match(/<div class="message-meta"><strong>(.*?)<\/strong>/);
  return match?.[1] ?? "";
}

describe("WorkspaceMessageRow author header precedence", () => {
  it("prefers disambiguated botLabel over raw botName for duplicate-name bots", () => {
    expect(
      renderAuthor({
        authorLabel: "研究助手 · aaa111",
        botLabel: "研究助手 · aaa111",
        botName: "研究助手",
      }),
    ).toBe("研究助手 · aaa111");
  });

  it("prefers deleted-bot botLabel over raw botName", () => {
    expect(
      renderAuthor({
        authorLabel: "旧助手（已删除）",
        botLabel: "旧助手（已删除）",
        botName: "旧助手",
      }),
    ).toBe("旧助手（已删除）");
  });

  it("keeps message.botSource.botName highest precedence and falls back to botName then authorLabel", () => {
    expect(
      renderAuthor({
        message: { botSource: { hostId: "h1", hostName: "macmini", botId: "b1", botName: "远程助手", requestId: "req_1", hops: 1 } },
        authorLabel: "研究助手 · aaa111",
        botLabel: "研究助手 · aaa111",
        botName: "研究助手",
      }),
    ).toBe("远程助手");

    expect(
      renderAuthor({
        authorLabel: "TaroBird",
        botLabel: undefined,
        botName: "仅目录名",
      }),
    ).toBe("仅目录名");

    expect(
      renderAuthor({
        message: { authorType: "user", authorId: "u1" },
        authorLabel: "我",
        botLabel: undefined,
        botName: undefined,
      }),
    ).toBe("我");
  });
});
