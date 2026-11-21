import { expect, it } from "vitest";
import { numberedForkTitle } from "../src/client-protocol/conversation-history.js";
it("numbers a default fork title only when the same title is taken", () => {
  expect(numberedForkTitle("Source · 分叉", [])).toBe("Source · 分叉");
  expect(numberedForkTitle("Source · 分叉", ["Source · 分叉"])).toBe("Source · 分叉 2");
  expect(numberedForkTitle("Source · 分叉", ["Source · 分叉", "Source · 分叉 2", "Source · 分叉 4"])).toBe("Source · 分叉 3");
  expect(numberedForkTitle("Source · Fork", ["Other · Fork"])).toBe("Source · Fork");
  const long = "x".repeat(256);
  expect(numberedForkTitle(long, [long]).length).toBeLessThanOrEqual(256);
  expect(numberedForkTitle(long, [long])).toMatch(/ 2$/);
});
