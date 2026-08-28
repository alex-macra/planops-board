import { describe, expect, it } from "vitest";

import { extractDetailBlocks } from "../server/ledger/detail.ts";
import { isStoryId, storyOf, type Story } from "../server/ledger/stories.ts";
import { DEFAULT_WORKFLOW } from "../shared/config.ts";
import type { Task } from "../src/api.ts";
import { storyProgressLabel, storyView } from "../src/stories.ts";

function blockOf(markdown: string) {
  return extractDetailBlocks(markdown.split("\n"), "plans/fixture.md")[0]!;
}

const STORY = [
  "### ORB-S01 - Visitors identify a constellation",
  "",
  "- **Kind:** story",
  "- **Role:** curious visitor",
  "- **Outcome:** I can identify a constellation from its shape",
  "- **So that:** I understand what I see in the fictional sky",
  "- **Demo:** Select a shape and reveal its name.",
  "- **Delivered by:** `ORB-001`, `ORB-002`",
].join("\n");

function task(id: string, partial: Partial<Task> = {}): Task {
  return {
    id,
    file: "plans/fixture.md",
    epic: "Fictional fixture",
    section: null,
    title: id,
    line: 1,
    status: "Ready",
    statusBase: "Ready",
    statusQualifier: "",
    statusValid: true,
    priority: "P1",
    owners: [],
    repositories: [],
    project: "observatory",
    projects: ["observatory"],
    dependencies: [],
    dependencyResidue: [],
    outcome: "",
    raw: {},
    statusCell: null,
    priorityCell: null,
    outcomeCell: null,
    readiness: "startable",
    ...partial,
  };
}

function fixtureStory(taskIds: readonly string[]): Story {
  return {
    id: "ORB-S01",
    file: "plans/fixture.md",
    epic: "Fictional fixture",
    title: "Visitors identify a constellation",
    kind: "story",
    role: "curious visitor",
    outcome: "I can identify a constellation",
    soThat: "I understand the sky",
    demo: null,
    taskIds,
    headingLine: 1,
  };
}

describe("story parsing", () => {
  it("recognizes only the narrow story ID shape", () => {
    expect(isStoryId("ORB-S01")).toBe(true);
    expect(isStoryId("ORB-001")).toBe(false);
    expect(isStoryId("ORB-S001")).toBe(false);
  });

  it("reads the story sentence and member rows", () => {
    expect(storyOf(blockOf(STORY), "Fictional fixture")).toMatchObject({
      kind: "story",
      role: "curious visitor",
      taskIds: ["ORB-001", "ORB-002"],
    });
  });

  it("drops a role from an enabler", () => {
    const enabler = STORY.replace("- **Kind:** story", "- **Kind:** enabler");
    expect(storyOf(blockOf(enabler), "Fictional fixture")?.role).toBeNull();
  });

  it("does not construct a story without its sentence fields", () => {
    expect(storyOf(blockOf(STORY.replace(/- \*\*Outcome:\*\*.*\n/, "")), "Fixture")).toBeNull();
  });
});

describe("derived story state", () => {
  it("ships only when every named member is complete", () => {
    const members = new Map([
      ["ORB-001", task("ORB-001", { statusBase: "Complete", readiness: null })],
      ["ORB-002", task("ORB-002", { statusBase: "Complete", readiness: null })],
    ]);
    expect(storyView(fixtureStory([...members.keys()]), members, DEFAULT_WORKFLOW).state).toBe("shipped");
    expect(
      storyView(fixtureStory([...members.keys(), "ORB-999"]), members, DEFAULT_WORKFLOW).state,
    ).not.toBe("shipped");
  });

  it("chooses the highest-priority startable member", () => {
    const members = new Map([
      ["ORB-001", task("ORB-001", { priority: "P2" })],
      ["ORB-002", task("ORB-002", { priority: "P0" })],
    ]);
    expect(storyView(fixtureStory([...members.keys()]), members, DEFAULT_WORKFLOW).next).toEqual({
      kind: "start",
      taskId: "ORB-002",
    });
  });

  it("reports completed and active progress", () => {
    const members = new Map([
      ["ORB-001", task("ORB-001", { statusBase: "Complete", readiness: null })],
      ["ORB-002", task("ORB-002", { statusBase: "In progress", readiness: "startable" })],
    ]);
    const view = storyView(fixtureStory([...members.keys()]), members, DEFAULT_WORKFLOW);
    expect(view.state).toBe("in-flight");
    expect(storyProgressLabel(view)).toBe("1 of 2 complete");
  });
});
