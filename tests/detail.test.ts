import { describe, expect, it } from "vitest";

import {
  conventionalHeadingLevel,
  extractDetailBlocks,
  notesOf,
  qwen3CoderNextPacketIsReady,
  taskPacketFieldRange,
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

describe("ordered Qwen packet structure", () => {
  const fields = [
    "- **Readiness:**\n  - Packet status: READY",
    "- **Objective:** Record the orbit.",
    "- **Why:** Observations need a timestamp.",
    "- **Scope:** One observation function.",
    "- **Starting point:** The existing orbit module.",
    "- **Decisions already made:** Preserve UTC.",
    "- **Decision authority:** Local names only.",
    "- **Contract:** Return the observation time.",
    "- **Change required:** Add the bounded timestamp.",
    "- **Invariants:** Existing observation order stays stable.",
    "- **Non-goals:** No new telescope controls.",
    "- **Acceptance:** The timestamp is deterministic.",
    "- **Verify:** Run the orbit fixture.",
    "- **Escalate, do not assume, if:** The orbit module moved.",
    "- **Handoff:** Report changed symbols and proof.",
  ].join("\n");
  const marker = "#### Qwen3-Coder-Next packet";
  const packet = `### ORB-020 - Timestamp the observation\n\n${marker}\n\n${fields}`;

  it("selects the exact ordered range between unrelated legacy fields", () => {
    const markdown = packet.replace(marker, `- **Scope:** Original scope.\n\n${marker}`) +
      "\n- **Evidence:** Earlier observation.\n";
    const block = blocksOf(markdown)[0]!;
    expect(taskPacketFieldRange(block.fields)).toEqual({ start: 1, end: 15 });
    expect(qwen3CoderNextPacketIsReady(block)).toBe(true);
    expect(block.fields[0]?.items).toEqual(["Original scope."]);
    expect(block.fields.at(-1)?.items).toEqual(["Earlier observation."]);
  });

  it("recognizes the existing standalone-label packet form", () => {
    const markdown = packet.replace(marker, "**Qwen3-Coder-Next packet**")
      .replaceAll(/- \*\*([^*]+):\*\* ?([^\n]*)/g, "\n**$1**\n$2");
    expect(qwen3CoderNextPacketIsReady(blocksOf(markdown)[0]!)).toBe(true);
  });

  it("recognizes the Qwen3.8-Flash-Next packet heading", () => {
    const markdown = packet.replace(marker, "#### Qwen3.8-Flash-Next packet");
    expect(qwen3CoderNextPacketIsReady(blocksOf(markdown)[0]!)).toBe(true);
  });

  it.each([
    "#### Qwen3.8-Flash-Next packet\n\n#### Qwen3-Coder-Next packet",
    "#### Qwen3.8-Flash-Next packet\n\n#### Qwen3.8-Flash-Next packet",
    "#### Qwen3.8-Flash-Next readiness packet",
    "#### Qwen3.8-Flash-Next task packet",
    "#### Qwen3.8-Flash-Next packet - extra",
    "#### Qwen3.8-Flash packet",
  ])("rejects ambiguous or incomplete Qwen3.8 markers: %s", (replacement) => {
    expect(qwen3CoderNextPacketIsReady(blocksOf(packet.replace(marker, replacement))[0]!)).toBe(false);
  });

  const flashMarker = "#### Qwen3.8-Flash-Next packet";
  const flashPacket = packet.replace(marker, flashMarker);

  it("recognizes the Qwen3.8-Flash-Next standalone-label packet form", () => {
    const markdown = packet.replace(marker, "**Qwen3.8-Flash-Next packet**")
      .replaceAll(/- \*\*([^*]+):\*\* ?([^\n]*)/g, "\n**$1**\n$2");
    expect(qwen3CoderNextPacketIsReady(blocksOf(markdown)[0]!)).toBe(true);
  });

  it.each([
    ["generic heading beside Qwen3.8", `${flashMarker}\n\n#### Qwen task packet`],
    ["generic label beside Qwen3.8", `${flashMarker}\n\n**Qwen packet**`],
    ["case-folded Qwen3.8", "#### qwen3.8-flash-next packet"],
    ["Qwen3.8 heading and label", `${flashMarker}\n\n**Qwen3.8-Flash-Next packet**`],
    ["prefixed Qwen3.8", "#### Draft Qwen3.8-Flash-Next packet"],
    ["double-spaced Qwen3.8", "#### Qwen3.8-Flash-Next  packet"],
  ])("rejects the Qwen3.8 %s marker", (_label, replacement) => {
    expect(qwen3CoderNextPacketIsReady(blocksOf(packet.replace(marker, replacement!))[0]!)).toBe(false);
  });

  it.each([
    ["nonliteral status", flashPacket.replace("Packet status: READY", "Packet status: READY.")],
    ["duplicate status", flashPacket.replace("Packet status: READY", "Packet status: READY\n  - Packet status: BLOCKED_BY_SPEC")],
    ["lowercase sole status", flashPacket.replace("Packet status: READY", "packet status: READY")],
    ["misplaced status", flashPacket.replace("Packet status: READY", "Awaiting evidence").replace("Record the orbit.", "Packet status: READY")],
    ["blocked status", flashPacket.replace("Packet status: READY", "Packet status: BLOCKED_BY_SPEC")],
    ["missing field", flashPacket.replace("- **Why:** Observations need a timestamp.\n", "")],
    ["reordered fields", flashPacket.replace("- **Objective:** Record the orbit.\n- **Why:** Observations need a timestamp.",
      "- **Why:** Observations need a timestamp.\n- **Objective:** Record the orbit.")],
    ["duplicate field", flashPacket.replace("- **Objective:** Record the orbit.", "- **Objective:** Record the orbit.\n- **Objective:** Another objective.")],
    ["duplicate field ranges", `${flashPacket}\n${fields}`],
  ])("rejects a Qwen3.8 packet with %s", (_label, markdown) => {
    expect(markdown).toContain(flashMarker);
    expect(qwen3CoderNextPacketIsReady(blocksOf(markdown!)[0]!)).toBe(false);
  });

  it("returns the same Qwen3.8 result without changing frozen input", () => {
    const block = blocksOf(flashPacket)[0]!;
    const before = JSON.stringify(block);
    for (const field of block.fields) { Object.freeze(field.items); Object.freeze(field); }
    Object.freeze(block.fields); Object.freeze(block.prose); Object.freeze(block);
    expect(qwen3CoderNextPacketIsReady(block)).toBe(true);
    expect(qwen3CoderNextPacketIsReady(block)).toBe(true);
    expect(JSON.stringify(block)).toBe(before);
  });

  it.each([
    ["generic marker", packet.replace(marker, "#### Qwen task packet")],
    ["missing marker", packet.replace(marker, "#### Implementation notes")],
    ["duplicate explicit marker", packet.replace(marker, `${marker}\n\n${marker}`)],
    ["mixed markers", packet.replace(marker, `${marker}\n\n#### Qwen task packet`)],
    ["nonliteral status", packet.replace("Packet status: READY", "Packet status: READY.")],
    ["duplicate status", packet.replace("Packet status: READY", "Packet status: READY\n  - Packet status: BLOCKED_BY_SPEC")],
    ["mixed-case duplicate status", packet.replace("Packet status: READY", "Packet status: READY\n  - packet status: BLOCKED_BY_SPEC")],
    ["lowercase sole status", packet.replace("Packet status: READY", "packet status: READY")],
    ["misplaced status", packet.replace("Packet status: READY", "Awaiting evidence").replace("Record the orbit.", "Packet status: READY")],
    ["missing field", packet.replace("- **Why:** Observations need a timestamp.\n", "")],
    ["reordered fields", packet.replace("- **Objective:** Record the orbit.\n- **Why:** Observations need a timestamp.",
      "- **Why:** Observations need a timestamp.\n- **Objective:** Record the orbit.")],
    ["duplicate field", packet.replace("- **Objective:** Record the orbit.", "- **Objective:** Record the orbit.\n- **Objective:** Another objective.")],
    ["duplicate field ranges", `${packet}\n${fields}`],
    ["ready stub", `### ORB-020 - Stub\n\n${marker}\n\n- **Readiness:** Packet status: READY\n- **Handoff:** Report.`],
  ])("rejects %s", (_label, markdown) => {
    expect(qwen3CoderNextPacketIsReady(blocksOf(markdown!)[0]!)).toBe(false);
  });

  it("keeps fenced packet examples inert and present", () => {
    const fenced = `\n\n\`\`\`markdown\n${marker}\n${fields}\n\`\`\``;
    const block = blocksOf(`### ORB-020 - Example${fenced}`)[0]!;
    expect(taskPacketFieldRange(block.fields)).toBeNull();
    expect(qwen3CoderNextPacketIsReady(block)).toBe(false);
    expect(block.prose).toEqual([fenced.trim()]);
    const real = blocksOf(packet + fenced)[0]!;
    expect(qwen3CoderNextPacketIsReady(real)).toBe(true);
    expect(real.prose.at(-1)).toBe(fenced.trim());
  });

  it("keeps deeper task packets out of their parent's ordinary prose", () => {
    const markdown = `### ORB-019 - Parent\n\n#### Evidence\n\nParent evidence.\n\n${packet.replace("### ORB-020", "#### ORB-020").replace(marker, `#${marker}`)}`;
    const [parent, child] = blocksOf(markdown);
    expect(parent?.prose).toEqual(["#### Evidence", "Parent evidence."]);
    expect(parent?.fields).toEqual([]);
    expect(parent?.endLine).toBe(5);
    expect(qwen3CoderNextPacketIsReady(parent!)).toBe(false);
    expect(qwen3CoderNextPacketIsReady(child!)).toBe(true);
  });

  it.each(["\n", "\n\n", "\n```markdown\n"])("ignores commented packets after %j", (separator) => {
    const markdown = `### ORB-019 - Example\n\n<!--${separator}${packet}\n\n-->`;
    const blocks = blocksOf(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.fields).toEqual([]);
    expect(qwen3CoderNextPacketIsReady(blocks[0]!)).toBe(false);
    expect(blocks[0]?.endLine).toBe(markdown.split("\n").length);
  });

  it("ignores commented examples beside a real packet without hiding code literals", () => {
    const suffix = `\n\n<!--\n\n${marker}\n\n${fields}\n-->`;
    const real = blocksOf(packet + suffix)[0]!;
    expect(qwen3CoderNextPacketIsReady(real)).toBe(true);
    expect(real.fields).toEqual(blocksOf(packet)[0]?.fields);
    for (const literal of ["`<!-- literal -->`", "``<!-- ` literal -->``", "```text\n<!-- literal -->\n```", "`first\ntext <!-- literal -->\nlast`"]) {
      const block = blocksOf(`${packet}\n\n${literal}`)[0]!;
      expect(block.prose.at(-1)).toBe(literal.startsWith("```text") ? literal : literal.replaceAll("\n", " "));
      expect(qwen3CoderNextPacketIsReady(block)).toBe(true);
    }
  });

  it("returns the same result without changing frozen input", () => {
    const block = blocksOf(packet)[0]!;
    const before = JSON.stringify(block);
    for (const field of block.fields) { Object.freeze(field.items); Object.freeze(field); }
    Object.freeze(block.fields); Object.freeze(block.prose); Object.freeze(block);
    expect(qwen3CoderNextPacketIsReady(block)).toBe(true);
    expect(qwen3CoderNextPacketIsReady(block)).toBe(true);
    expect(taskPacketFieldRange(block.fields)).toEqual({ start: 0, end: 14 });
    expect(JSON.stringify(block)).toBe(before);
  });
});
