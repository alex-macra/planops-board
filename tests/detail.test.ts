import { describe, expect, it } from "vitest";

import {
  conventionalHeadingLevel,
  extractDetailBlocks,
  notesOf,
} from "../server/ledger/detail.ts";

function blocksOf(markdown: string) {
  return extractDetailBlocks(markdown.split("\n"), "plans/fixture.md");
}

function field(markdown: string, id: string, label: string) {
  return blocksOf(markdown)
    .find((block) => block.id === id)!
    .fields.find((entry) => entry.label === label);
}

describe("task detail parsing", () => {
  it("reads a labelled bullet and wrapped continuation", () => {
    const markdown = [
      "### ORB-001 - Calibrate the telescope",
      "",
      "- **Scope:** Record the first calibration and preserve the",
      "  original observation time.",
      "- **Acceptance:** A fixed-clock check passes.",
    ].join("\n");
    expect(blocksOf(markdown)[0]).toMatchObject({
      id: "ORB-001",
      title: "Calibrate the telescope",
      headingLevel: 3,
      headingLine: 1,
    });
    expect(field(markdown, "ORB-001", "Scope")?.items).toEqual([
      "Record the first calibration and preserve the original observation time.",
    ]);
    expect(field(markdown, "ORB-001", "Acceptance criteria")?.rawLabel).toBe("Acceptance");
  });

  it("reads a standalone label followed by bullets", () => {
    const markdown = [
      "### ORB-002 - Compare lenses",
      "",
      "**Acceptance criteria**",
      "",
      "- Compare equal focal lengths.",
      "- Record the chosen lens.",
    ].join("\n");
    expect(field(markdown, "ORB-002", "Acceptance criteria")?.items).toEqual([
      "Compare equal focal lengths.",
      "Record the chosen lens.",
    ]);
  });

  it("keeps prose paragraphs and fenced blocks intact", () => {
    const markdown = [
      "### ORB-003 - Draw the orbit",
      "",
      "Describe the path in",
      "plain language.",
      "",
      "```text",
      "near -> far",
      "```",
    ].join("\n");
    expect(blocksOf(markdown)[0]?.prose).toEqual([
      "Describe the path in plain language.",
      "```text\nnear -> far\n```",
    ]);
  });

  it("keeps indented bold bullets inside their parent field", () => {
    const markdown = [
      "### ORB-004 - Pick a mount",
      "",
      "- **Options:**",
      "  - **Tripod.** Portable and steady.",
      "  - **Pier.** Fixed and rigid.",
    ].join("\n");
    expect(blocksOf(markdown)[0]?.fields.map((entry) => entry.label)).toEqual(["Options"]);
    expect(field(markdown, "ORB-004", "Options")?.items).toEqual([
      "**Tripod.** Portable and steady.",
      "**Pier.** Fixed and rigid.",
    ]);
  });

  it("splits a date from a note label", () => {
    const markdown = [
      "### ORB-005 - Record a note",
      "",
      "- **Note (2026-08-20):** Clouds delayed the fictional observation.",
    ].join("\n");
    const block = blocksOf(markdown)[0]!;
    expect(notesOf(block)[0]).toMatchObject({
      label: "Note",
      rawLabel: "Note (2026-08-20)",
      date: "2026-08-20",
    });
  });

  it("recognizes only headings anchored by an ID", () => {
    expect(blocksOf("### `ORB-006` - Backticked ID")[0]).toMatchObject({ id: "ORB-006" });
    expect(blocksOf("## Decisions for ORB-006")).toEqual([]);
  });

  it("ends a block at the next heading of equal depth", () => {
    const markdown = [
      "### ORB-007 - First",
      "",
      "First body.",
      "",
      "#### Evidence",
      "",
      "Nested body.",
      "",
      "### ORB-008 - Second",
      "",
      "Second body.",
    ].join("\n");
    const [first, second] = blocksOf(markdown);
    expect(first?.endLine).toBe(7);
    expect(first?.prose).toContain("Nested body.");
    expect(second?.id).toBe("ORB-008");
  });

  it("extracts unique references and links", () => {
    const markdown = [
      "### ORB-009 - Link observations",
      "",
      "Compare `ORB-001` with `ORB-001` and [the guide](./guide.md).",
    ].join("\n");
    expect(blocksOf(markdown)[0]).toMatchObject({
      references: ["ORB-001"],
      links: [{ label: "the guide", href: "./guide.md" }],
    });
  });

  it("chooses the most common heading depth for new blocks", () => {
    const markdown = [
      "### ORB-010 - One",
      "",
      "### ORB-011 - Two",
      "",
      "## ORB-012 - Three",
    ].join("\n");
    expect(conventionalHeadingLevel(blocksOf(markdown))).toBe(3);
  });
});
