import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { buildDesignSandbox, designAssets } from "../design-assets.js";
import { emptySlides, applyDesignFiles, designTextFile, decodeDesignFile, validateDesignDocument } from "../src/workbench-design.js";
import { DesignSession } from "../src/workbench-design-session.js";
import { locateComment } from "../src/workbench-design-comments.js";
import { importPptxToSlides } from "../src/workbench-slides-pptx-import.js";

function makeMinimalPng(): Uint8Array {
  // Valid 1x1 transparent PNG
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

function makeSamplePptx(): Uint8Array {
  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`;

  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`;

  const slide1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="102A43"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="10363200" cy="1371600"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p>
            <a:pPr algn="l"/>
            <a:r><a:rPr sz="4800" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Q4 Product Roadmap</a:t></a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Bullets"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="914400" y="2514600"/><a:ext cx="6000000" cy="2400000"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="D9E2EC"/></a:solidFill></a:rPr><a:t>Launch Workbench Presentation</a:t></a:r></a:p>
          <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="D9E2EC"/></a:solidFill></a:rPr><a:t>Support PPTX Import &amp; Export</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="4" name="Logo" descr="Brand mark"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rIdImg1"/></p:blipFill>
        <p:spPr><a:xfrm><a:off x="8000000" y="2400000"/><a:ext cx="2400000" cy="1800000"/></a:xfrm></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`;

  const slide1Rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
  <Relationship Id="rIdNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`;

  const notes1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>Remind audience about Apache-2.0 migration.</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:notes>`;

  const slide2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:graphicFrame>
        <p:xfrm><a:off x="914400" y="1200000"/><a:ext cx="10000000" cy="3000000"/></p:xfrm>
        <a:graphic><a:graphicData><a:tbl>
          <a:tr h="600000">
            <a:tc><a:txBody><a:p><a:r><a:t>Milestone</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>Status</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
          <a:tr h="600000">
            <a:tc><a:txBody><a:p><a:r><a:t>Editor Upgrade</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>Complete</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
        </a:tbl></a:graphicData></a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`;

  return zipSync({
    "ppt/presentation.xml": strToU8(presentationXml),
    "ppt/_rels/presentation.xml.rels": strToU8(presentationRels),
    "ppt/slides/slide1.xml": strToU8(slide1Xml),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(slide1Rels),
    "ppt/notesSlides/notesSlide1.xml": strToU8(notes1Xml),
    "ppt/slides/slide2.xml": strToU8(slide2Xml),
    "ppt/media/image1.png": makeMinimalPng(),
  });
}

describe("Workbench Presentation (#90): Apache-2.0 slides editor, PPTX import, comments, history", () => {
  it("imports a multi-slide .pptx into a valid Workbench Presentation with text, bullets, image assets, table, and notes", () => {
    const doc = importPptxToSlides(makeSamplePptx(), { id: "deck_imported", title: "Q4 Roadmap" });
    expect(doc.format).toBe("slides");
    validateDesignDocument(doc);

    const deckJson = JSON.parse(new TextDecoder().decode(decodeDesignFile(doc.files["project/deck.json"])));
    expect(deckJson.v).toBe(4);
    expect(deckJson.title).toBe("Q4 Roadmap");
    expect(deckJson.order).toEqual(["slide-1", "slide-2"]);

    const slide1 = new TextDecoder().decode(decodeDesignFile(doc.files["project/slides/slide-1.html"]));
    expect(slide1).toContain("Q4 Product Roadmap");
    expect(slide1).toContain("Launch Workbench Presentation");
    expect(slide1).toContain("Support PPTX Import &amp; Export");
    expect(slide1).toContain("#102A43");
    expect(slide1).toContain("<aside>");
    expect(slide1).toContain("Remind audience about Apache-2.0 migration.");
    expect(slide1).toMatch(/\/_blob\/[a-f0-9]{32}/);

    const assetKeys = Object.keys(doc.files).filter(k => k.startsWith("project/assets/"));
    expect(assetKeys.length).toBe(1);

    const slide2 = new TextDecoder().decode(decodeDesignFile(doc.files["project/slides/slide-2.html"]));
    expect(slide2).toContain("<table");
    expect(slide2).toContain("Milestone");
    expect(slide2).toContain("Editor Upgrade");
  });

  it("handles concurrent revisions with CAS conflict rejection and Bot read/write receipts", async () => {
    let stored = emptySlides("deck_cas", "CAS Deck");
    const session = new DesignSession(
      stored,
      async () => stored,
      async (expected, next) => {
        if (stored.revision !== expected) throw new Error("design_revision_conflict");
        stored = next;
      },
      () => {},
      { user: () => ({ id: "owner", name: "Owner" }), title: () => "CAS Deck" },
    );

    const read1 = await session.read({});
    expect(read1.revision).toBe(0);

    // Bot publishes a new slide atomically
    const deckJson = JSON.parse(new TextDecoder().decode(decodeDesignFile(stored.files["project/deck.json"])));
    deckJson.order.push("agenda");
    const published = await session.publish("req_1", 0, {
      files: {
        "project/deck.json": { content: JSON.stringify(deckJson), contentType: "application/json" },
        "project/slides/agenda.html": { content: '<section id="agenda"><h2>Agenda</h2></section>', contentType: "text/html" },
      },
    }, () => {}, { kind: "bot", id: "b1", name: "Assistant" });
    expect(published.revision).toBe(1);

    // Stale expectedRevision fails with conflict
    await expect(session.publish("req_2", 0, {
      files: { "project/slides/agenda.html": { content: '<section id="agenda"><h2>Stale</h2></section>', contentType: "text/html" } },
    }, () => {}, { kind: "bot", id: "b1", name: "Assistant" })).rejects.toThrow("design_revision_conflict");

    // Replayed requestId with identical payload returns idempotent receipt
    const replay = await session.publish("req_1", 0, {
      files: {
        "project/deck.json": { content: JSON.stringify(deckJson), contentType: "application/json" },
        "project/slides/agenda.html": { content: '<section id="agenda"><h2>Agenda</h2></section>', contentType: "text/html" },
      },
    }, () => {}, { kind: "bot", id: "b1", name: "Assistant" });
    expect(replay.revision).toBe(1);

    // File-level CAS via applyDesignFiles rejects stale ifMatch
    const { base64, contentType } = designTextFile('<section id="agenda"><h2>Race</h2></section>', "text/html");
    expect(() => applyDesignFiles(stored, {
      "project/slides/agenda.html": { base64, contentType, ifMatch: "0".repeat(64) },
    })).toThrow("design_revision_conflict");
  });

  it("locates Open Artifact JSON slide comment anchors accurately", () => {
    const doc = emptySlides("deck_comments", "Comments Deck");
    const loc = locateComment({ label: "Slide 1 › Title", detail: undefined, anchor: JSON.stringify({ slide: "cover", el: "h1" }) } as never, doc);
    expect(loc.file).toBe("project/slides/cover.html");
    expect(loc.slideId).toBe("cover");
  });

  it("replaces client/vendor/baoyu-slides with Apache-2.0 client/vendor/workbench-slides and verifies hashes", () => {
    expect(existsSync(new URL("../vendor/baoyu-slides", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../skills/baoyu-ppt", import.meta.url))).toBe(false);
    const root = new URL("../vendor/workbench-slides/", import.meta.url);
    expect(existsSync(new URL("LICENSE", root))).toBe(true);
    expect(existsSync(new URL("NOTICE", root))).toBe(true);
    const upstream = JSON.parse(readFileSync(new URL("UPSTREAM.json", root), "utf8"));
    expect(upstream.license).toBe("Apache-2.0");
    expect(upstream.repository).toBe("https://github.com/JimLiu/open-artifact");
    expect(upstream.commit).toMatch(/^[a-f0-9]{40}$/);
    for (const [name, expected] of Object.entries<string>(upstream.files)) {
      const actual = createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex");
      expect(actual).toBe(expected);
    }

    const html = buildDesignSandbox("slides");
    expect(html).toContain("openartifact");
    expect(html).not.toContain("__baoyuSave");

    const files: string[] = [];
    const hook = designAssets().generateBundle!;
    const generate = typeof hook === "function" ? hook : hook.handler;
    generate.call({ emitFile: (file: { fileName: string }) => files.push(file.fileName) } as never, {} as never, {}, false);
    expect(files).toContain("licenses/workbench-slides/LICENSE");
    expect(files).toContain("licenses/workbench-slides/NOTICE");
    expect(files).toContain("licenses/workbench-slides/UPSTREAM.json");
    expect(files.some(name => name.includes("baoyu-slides"))).toBe(false);
  }, 30_000);
});
