import { expect, it } from "vitest";
import { addCodexWebSources, renderCodexWebCitations } from "../src/runtime/codex-web-citations.js";

it("keeps an IPv6 literal host usable while escaping brackets in the path and query", () => {
  const sources = addCodexWebSources(undefined, [{ refId: "turn0search0", url: "https://[2001:db8::1]:8443/a?b=[c]" }]);
  expect(sources?.turn0search0?.url).toBe("https://[2001:db8::1]:8443/a?b=%5Bc%5D");
  const text = renderCodexWebCitations("See citeturn0search0.", "en", { sources });
  expect(text).toContain("(<https://[2001:db8::1]:8443/a?b=%5Bc%5D>)");
  expect(text).not.toContain("Source link unavailable");
});
