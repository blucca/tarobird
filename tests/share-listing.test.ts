import { expect, it } from "vitest";
import { readSharedListing } from "../client/src/share-controller.js";

const good = (id: string, text: string) => ({ id, createdAt: 1_800_000_000_000, text, files: [] });
const A = "884b9026-9029-4a6b-ad36-cd40b6f9a241", B = "5a6c0c1e-7d1b-4c7e-8f3a-2b9d6e4f1a20", BROKEN = "0d1f0a52-3b0e-4d6c-9a57-1f2e3d4c5b6a";

it("shows the records it can read and leaves out the one it cannot", () => {
  const listing = readSharedListing([good(A, "first"), { id: BROKEN, createdAt: "yesterday", text: 7 }, good(B, "second")]);
  expect(listing.items.map(item => item.text)).toEqual(["first", "second"]);
});

it("still lists the id of a record it cannot read, so nothing saved for it is treated as finished", () => {
  const listing = readSharedListing([good(A, "first"), { id: BROKEN, createdAt: "yesterday", text: 7 }, null, "text", { text: "no id" }]);
  expect(listing.ids).toEqual([A, BROKEN]);
  expect(listing.items.map(item => item.id)).toEqual([A]);
});

it("an empty listing and a listing of only unreadable records both show nothing", () => {
  expect(readSharedListing([])).toEqual({ items: [], ids: [] });
  expect(readSharedListing([{ id: BROKEN }]).items).toEqual([]);
});
