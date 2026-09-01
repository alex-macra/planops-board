import Ajv2020 from "ajv/dist/2020.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import agentQuerySchema from "../schema/agent-query-v1.schema.json";
import { agentQueryEnvelopeSchema } from "../shared/agent-query.ts";
import { DATA_QUALITY_ISSUE_KINDS } from "../shared/data-quality.ts";
import { selectStaleTasks, selectStartableTasks } from "../shared/task-selectors.ts";
import { toBoardResponse } from "../server/board-response.ts";
import { runAgentQuery } from "../server/agent-query.ts";
import { forgetHistory } from "../server/history.ts";
import { buildBoard, type SourceDocument } from "../server/ledger/model.ts";
import { loadBoardRuntime, type BoardRuntime } from "../server/runtime.ts";
import { resolveSourceIdentity } from "../server/source-identity.ts";
import { disposableDemo, git, removeDisposableDemo } from "./fixture.ts";

const engineRoot = path.resolve(import.meta.dirname, "..");
const validateEnvelope = new Ajv2020({ allErrors: true, strict: true }).compile(agentQuerySchema);

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, ["cli/planops-board.ts", ...args], {
    cwd: engineRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

async function repositorySnapshot(root: string): Promise<unknown> {
  const markdown = (await git(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.md",
  )).split("\n").filter(Boolean);
  const indexPath = await git(root, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const status = await git(
    root,
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  return {
    files: await Promise.all(markdown.map(async (file) => ({
      file,
      bytes: (await readFile(path.join(root, file))).toString("base64"),
    }))),
    index: (await readFile(indexPath)).toString("base64"),
    refs: await git(root, "for-each-ref", "--format=%(refname)%00%(objectname)"),
    head: await git(root, "rev-parse", "HEAD"),
    headRef: await git(root, "rev-parse", "--symbolic-full-name", "HEAD"),
    status,
  };
}

function addUnknownFieldAt(value: unknown, pathParts: readonly (string | number)[]): unknown {
  const clone: unknown = structuredClone(value);
  let cursor = clone;
  for (const part of pathParts) {
    if (typeof cursor !== "object" || cursor === null) throw new Error("fixture path is not an object");
    if (Array.isArray(cursor)) {
      if (typeof part !== "number") throw new Error("fixture array path is not numeric");
      cursor = cursor[part];
    } else {
      cursor = (cursor as Record<string, unknown>)[String(part)];
    }
  }
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
    throw new Error("fixture target is not an object");
  }
  (cursor as Record<string, unknown>)["unexpected"] = true;
  return clone;
}

function selectorBoard() {
  const source: SourceDocument = {
    path: "plans/ranking.md",
    sha256: "a".repeat(64),
    text: [
      "# Ranking fixture",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      "| `RANK-001` | P2 | Ready | None | First root. |",
      "| `RANK-002` | P1 | Ready | `RANK-001` | First dependant. |",
      "| `RANK-003` | P0 | Ready | `RANK-002` | Transitive dependant. |",
      "| `RANK-004` | P3 | Ready | None | Second root. |",
      "| `RANK-005` | P0 | Ready | `RANK-004` | Second dependant. |",
      "| `RANK-006` | P1 | Ready | None | Priority tie breaker. |",
      "| `RANK-007` | P2 | Ready | None | Identifier tie breaker A. |",
      "| `RANK-008` | P2 | Ready | None | Identifier tie breaker B. |",
      "",
    ].join("\n"),
  };
  return toBoardResponse(buildBoard(
    [source],
    new Set(),
    [],
    "2026-08-20T12:00:00.000Z",
    {
      statusOrder: ["Ready", "In progress", "Blocked", "Complete"],
      activeStatuses: ["Ready", "In progress"],
      blockedStatuses: ["Blocked"],
      closedStatuses: ["Complete"],
      dependencySatisfiedStatuses: ["Complete"],
      priorityOrder: ["P0", "P1", "P2", "P3"],
    },
  ));
}

describe("agent query contract", () => {
  let repositoryRoot = "";
  let runtime: BoardRuntime;

  beforeAll(async () => {
    repositoryRoot = await disposableDemo();
    runtime = await loadBoardRuntime({ repo: repositoryRoot, engineRoot });
  });

  afterAll(async () => {
    await removeDisposableDemo(repositoryRoot);
  });

  test("startable returns the ranked bounded task contract", async () => {
    const result = await runAgentQuery(runtime, "startable", new Date("2026-08-28T12:00:00.000Z"));

    expect(validateEnvelope(result), JSON.stringify(validateEnvelope.errors)).toBe(true);
    expect(result).toMatchObject({
      contractVersion: 1,
      ok: true,
      command: "query.startable",
      source: {
        ref: "refs/heads/main",
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        corpusRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      data: { total: 2 },
    });
    if (result.command !== "query.startable") throw new Error("unexpected command");
    expect(result.data.items.map((item) => item.id)).toEqual(["MGA-002", "SOV-002"]);
    expect(result.data.items[0]).toMatchObject({
      documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      readiness: "startable",
      readinessReasons: [
        "Every dependency has a configured satisfied status and no unchecked gate remains.",
      ],
      fanOut: 0,
    });
    expect(result.data.items[0]).not.toHaveProperty("raw");
    expect(result.data.items[0]).not.toHaveProperty("statusCell");
  });

  test("startable ordering uses transitive fan-out, configured priority, then task ID", () => {
    const board = selectorBoard();

    expect(selectStartableTasks(board).map(({ task, fanOut }) => [task.id, fanOut])).toEqual([
      ["RANK-001", 2],
      ["RANK-004", 1],
      ["RANK-006", 0],
      ["RANK-007", 0],
      ["RANK-008", 0],
    ]);
  });

  test("stale matches the shared seven-day selector", async () => {
    const result = await runAgentQuery(runtime, "stale", new Date("2026-08-28T12:00:00.000Z"));

    expect(validateEnvelope(result), JSON.stringify(validateEnvelope.errors)).toBe(true);
    if (result.command !== "query.stale") throw new Error("unexpected command");
    expect(result.data).toMatchObject({ asOfDate: "2026-08-28", thresholdDays: 7, total: 4 });
    expect(result.data.items.map((item) => item.id)).toEqual([
      "MGA-002",
      "MGA-003",
      "SHB-002",
      "SOV-002",
    ]);
    expect(result.data.items.every((item) => item.ageDays === 8)).toBe(true);
  });

  test("stale includes exactly seven days and excludes anything newer", () => {
    const board = selectorBoard();
    const result = selectStaleTasks(board, {
      "RANK-001": {
        date: "2026-08-21T12:00:00.000Z",
        sha: null,
        subject: null,
      },
      "RANK-004": {
        date: "2026-08-21T12:00:00.001Z",
        sha: null,
        subject: null,
      },
    }, new Date("2026-08-28T12:00:00.000Z"));

    expect(result.map(({ task, ageDays }) => [task.id, ageDays])).toEqual([["RANK-001", 7]]);
  });

  test("issues are serialized in stable model order", async () => {
    const result = await runAgentQuery(runtime, "issues", new Date("2026-08-28T12:00:00.000Z"));

    expect(validateEnvelope(result), JSON.stringify(validateEnvelope.errors)).toBe(true);
    if (result.command !== "query.issues") throw new Error("unexpected command");
    expect(result.data.items).toEqual(
      [...result.data.items].sort((left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.taskId.localeCompare(right.taskId) ||
        left.detail.localeCompare(right.detail),
      ),
    );
    expect(result.data.total).toBeGreaterThan(0);
  });

  test("issues report malformed rows with locale-independent ordering and revision", async () => {
    const malformedRoot = await disposableDemo();
    try {
      const ledger = (heading: string): string => [
        `# ${heading}`,
        "",
        "| ID | Priority | Status | Dependencies | Required outcome |",
        "|---|---:|---|---|---|",
        "| `LOC-001` | P1 | Mystery | `LOC-999` | Expose a typed issue. |",
        "",
      ].join("\n");
      await writeFile(path.join(malformedRoot, "plans", "zebra.md"), ledger("Zebra"), "utf8");
      await writeFile(path.join(malformedRoot, "plans", "äpple.md"), ledger("Apple"), "utf8");
      await git(malformedRoot, "add", "plans/zebra.md", "plans/äpple.md");
      await git(malformedRoot, "commit", "-m", "Add malformed locale fixtures");
      const args = ["query", "issues", "--repo", malformedRoot, "--json"];

      const english = await runCli(args, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
      const swedish = await runCli(args, { LANG: "sv_SE.UTF-8", LC_ALL: "sv_SE.UTF-8" });

      expect(english.code).toBe(0);
      expect(swedish.code).toBe(0);
      expect(JSON.parse(english.stdout)).toEqual(JSON.parse(swedish.stdout));
      const payload = agentQueryEnvelopeSchema.parse(JSON.parse(english.stdout));
      if (!payload.ok || payload.command !== "query.issues") throw new Error("unexpected command");
      expect(payload.data.items
        .filter((item) => item.taskId === "LOC-001")
        .map((item) => [item.kind, item.file, item.line, item.taskId]))
        .toEqual([
          ["dangling-dependency", "plans/zebra.md", 5, "LOC-001"],
          ["dangling-dependency", "plans/äpple.md", 5, "LOC-001"],
          ["duplicate-task-id", "plans/zebra.md", 5, "LOC-001"],
          ["duplicate-task-id", "plans/äpple.md", 5, "LOC-001"],
          ["unknown-status", "plans/zebra.md", 5, "LOC-001"],
          ["unknown-status", "plans/äpple.md", 5, "LOC-001"],
        ]);
    } finally {
      await removeDisposableDemo(malformedRoot);
    }
  });

  test("checked-in fixtures agree across JSON Schema and runtime Zod", async () => {
    for (const name of ["startable", "stale", "issues", "failure"]) {
      const fixture = JSON.parse(await readFile(
        path.join(engineRoot, "tests", "fixtures", "agent-query-v1", `${name}.json`),
        "utf8",
      )) as unknown;
      expect(validateEnvelope(fixture), JSON.stringify(validateEnvelope.errors)).toBe(true);
      expect(agentQueryEnvelopeSchema.safeParse(fixture).success).toBe(true);

      const withUnknownField = { ...(fixture as Record<string, unknown>), unexpected: true };
      expect(validateEnvelope(withUnknownField)).toBe(false);
      expect(agentQueryEnvelopeSchema.safeParse(withUnknownField).success).toBe(false);
    }
  });

  test("the checked JSON Schema pins every runtime issue kind", () => {
    expect(agentQuerySchema.$defs.issue.properties.kind.enum).toEqual(DATA_QUALITY_ISSUE_KINDS);
  });

  test("JSON Schema and Zod both reject unsafe integers", async () => {
    const fixture = JSON.parse(await readFile(
      path.join(engineRoot, "tests", "fixtures", "agent-query-v1", "startable.json"),
      "utf8",
    )) as { data: { total: number } };
    fixture.data.total = Number.MAX_SAFE_INTEGER + 1;

    expect(validateEnvelope(fixture)).toBe(false);
    expect(agentQueryEnvelopeSchema.safeParse(fixture).success).toBe(false);
  });

  test("JSON Schema and Zod both reject impossible Git SHA lengths", async () => {
    const fixture = JSON.parse(await readFile(
      path.join(engineRoot, "tests", "fixtures", "agent-query-v1", "startable.json"),
      "utf8",
    )) as { source: { sha: string } };
    fixture.source.sha = "a".repeat(41);

    expect(validateEnvelope(fixture)).toBe(false);
    expect(agentQueryEnvelopeSchema.safeParse(fixture).success).toBe(false);
  });

  test("corpus revision binds workflow and project semantics", async () => {
    const boundRoot = await disposableDemo();
    try {
      const baseRuntime = await loadBoardRuntime({ repo: boundRoot, engineRoot });
      const base = await runAgentQuery(baseRuntime, "startable");
      const configPath = path.join(boundRoot, ".projects-board", "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        workflow: { activeStatuses: string[] };
      };
      const activeStatuses = [...config.workflow.activeStatuses];
      config.workflow.activeStatuses = config.workflow.activeStatuses.filter((status) => status !== "Ready");
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const workflowRuntime = await loadBoardRuntime({ repo: boundRoot, engineRoot });
      const workflowChanged = await runAgentQuery(workflowRuntime, "startable");

      expect(workflowChanged.source.sha).toBe(base.source.sha);
      expect(workflowChanged.source.corpusRevision).not.toBe(base.source.corpusRevision);
      if (base.command !== "query.startable" || workflowChanged.command !== "query.startable") {
        throw new Error("unexpected command");
      }
      expect(workflowChanged.data.items).not.toEqual(base.data.items);

      config.workflow.activeStatuses = activeStatuses;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const projectsPath = path.join(boundRoot, ".projects-board", "projects.json");
      const projects = JSON.parse(await readFile(projectsPath, "utf8")) as Array<{ id: string }>;
      if (!projects[0]) throw new Error("project fixture is empty");
      projects[0].id = "moon-garden-renamed";
      await writeFile(projectsPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
      const projectsRuntime = await loadBoardRuntime({ repo: boundRoot, engineRoot });
      const projectsChanged = await runAgentQuery(projectsRuntime, "startable");

      expect(projectsChanged.source.sha).toBe(base.source.sha);
      expect(projectsChanged.source.corpusRevision).not.toBe(base.source.corpusRevision);
      if (projectsChanged.command !== "query.startable") throw new Error("unexpected command");
      expect(projectsChanged.data.items).not.toEqual(base.data.items);
    } finally {
      await removeDisposableDemo(boundRoot);
    }
  });

  test.each([
    ["source", "startable", ["source"]],
    ["data", "startable", ["data"]],
    ["task item", "startable", ["data", "items", 0]],
    ["dependency", "stale", ["data", "items", 0, "dependencies", 0]],
    ["failure error", "failure", ["error"]],
  ])("rejects an unknown field inside %s in both schemas", async (_label, name, parts) => {
    const fixture: unknown = JSON.parse(await readFile(
      path.join(engineRoot, "tests", "fixtures", "agent-query-v1", `${name}.json`),
      "utf8",
    ));
    const mutated = addUnknownFieldAt(fixture, parts);

    expect(validateEnvelope(mutated)).toBe(false);
    expect(agentQueryEnvelopeSchema.safeParse(mutated).success).toBe(false);
  });

  test("CLI queries emit one schema-valid JSON document", async () => {
    const result = await runCli(["query", "startable", "--repo", repositoryRoot, "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload: unknown = JSON.parse(result.stdout);
    expect(validateEnvelope(payload), JSON.stringify(validateEnvelope.errors)).toBe(true);
  });

  test("JSON argument failures use the stable invalid-request exit", async () => {
    const result = await runCli(["query", "unknown", "--repo", repositoryRoot, "--json"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(validateEnvelope(payload), JSON.stringify(validateEnvelope.errors)).toBe(true);
    expect(payload).toMatchObject({
      contractVersion: 1,
      ok: false,
      command: "query.unknown",
      error: { code: "invalid_request" },
    });
  });

  test.each([
    ["duplicate JSON flag", ["query", "startable", "--repo", "REPO", "--json", "--json"]],
    ["duplicate repository", ["query", "startable", "--repo", "REPO", "--repo", "REPO", "--json"]],
    ["duplicate config", [
      "query",
      "startable",
      "--repo",
      "REPO",
      "--config",
      ".projects-board/config.json",
      "--config",
      ".projects-board/config.json",
      "--json",
    ]],
    ["server-only validator flag", [
      "query",
      "issues",
      "--repo",
      "REPO",
      "--allow-external-validator",
      "--json",
    ]],
    ["server-only port flag", ["query", "stale", "--repo", "REPO", "--port", "5176", "--json"]],
  ])("rejects %s with exit 2 and one strict JSON failure", async (_label, template) => {
    const args = template.map((part) => part === "REPO" ? repositoryRoot : part);
    const result = await runCli(args);

    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload: unknown = JSON.parse(result.stdout);
    expect(validateEnvelope(payload), JSON.stringify(validateEnvelope.errors)).toBe(true);
    expect(agentQueryEnvelopeSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  test("detached HEAD is reported as the exact source ref", async () => {
    const detachedRoot = await disposableDemo();
    try {
      await git(detachedRoot, "checkout", "--detach");
      const head = await git(detachedRoot, "rev-parse", "HEAD");
      const result = await runCli(["query", "startable", "--repo", detachedRoot, "--json"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ source: { ref: "HEAD", sha: head } });
    } finally {
      await removeDisposableDemo(detachedRoot);
    }
  });

  test("source identity retries when a branch advances between reads", async () => {
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    const refs = [
      "refs/heads/main",
      "refs/heads/main",
      "refs/heads/main",
      "refs/heads/main",
    ];
    const shas = [oldSha, newSha, newSha, newSha];

    await expect(resolveSourceIdentity(
      async () => refs.shift() ?? "refs/heads/main",
      async () => shas.shift() ?? newSha,
    )).resolves.toEqual({ ref: "refs/heads/main", sha: newSha });
  });

  test("queries never execute configured Git clean filters", async () => {
    const filteredRoot = await disposableDemo();
    try {
      await writeFile(path.join(filteredRoot, ".gitattributes"), "plans/*.md filter=planops\n", "utf8");
      await git(filteredRoot, "add", ".gitattributes");
      await git(filteredRoot, "commit", "-m", "Attribute fictional ledgers");
      const gitDirectory = path.resolve(filteredRoot, await git(filteredRoot, "rev-parse", "--git-dir"));
      const marker = path.join(gitDirectory, "planops-filter-called");
      const filterScript = path.join(gitDirectory, "planops-filter-probe.mjs");
      await writeFile(filterScript, [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(marker)}, 'called');`,
        "process.stdin.pipe(process.stdout);",
        "",
      ].join("\n"), "utf8");
      await git(filteredRoot, "config", "filter.planops.clean", `${process.execPath} ${filterScript}`);
      await git(filteredRoot, "config", "filter.planops.required", "true");
      const ledgerPath = path.join(filteredRoot, "plans", "moon-garden.md");
      await writeFile(ledgerPath, `${await readFile(ledgerPath, "utf8")}\n`, "utf8");

      for (const query of ["startable", "stale", "issues"] as const) {
        const result = await runCli(["query", query, "--repo", filteredRoot, "--json"]);
        expect(result.code).toBe(0);
      }
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeDisposableDemo(filteredRoot);
    }
  });

  test("stale history is scoped by file and excludes same-file duplicate IDs", async () => {
    const duplicateRoot = await disposableDemo();
    try {
      const signalPath = path.join(duplicateRoot, "plans", "signal-harbor.md");
      const signal = await readFile(signalPath, "utf8");
      await writeFile(signalPath, signal.replace(
        "| `SHB-003` | P2 | Complete | None | harbor operations | Document the recovery drill for a missed signal. |",
        [
          "| `SHB-003` | P2 | Complete | None | harbor operations | Document the recovery drill for a missed signal. |",
          "| `MGA-002` | P1 | Ready | None | `signal-harbor-web` | Duplicate cross-file row. |",
        ].join("\n"),
      ), "utf8");
      forgetHistory();
      const crossFileRuntime = await loadBoardRuntime({ repo: duplicateRoot, engineRoot });
      const crossFile = await runAgentQuery(
        crossFileRuntime,
        "stale",
        new Date("2026-08-28T12:00:00.000Z"),
      );
      if (crossFile.command !== "query.stale") throw new Error("unexpected command");
      expect(crossFile.data.items.filter((item) => item.id === "MGA-002").map((item) => item.file))
        .toEqual(["plans/moon-garden.md"]);

      const moonPath = path.join(duplicateRoot, "plans", "moon-garden.md");
      const moon = await readFile(moonPath, "utf8");
      await writeFile(moonPath, moon.replace(
        "| `MGA-003` | P1 | In progress | `MGA-001@copy-approved` | `moon-garden-ui` | Explain each plant's care cycle in plain language. |",
        [
          "| `MGA-003` | P1 | In progress | `MGA-001@copy-approved` | `moon-garden-ui` | Explain each plant's care cycle in plain language. |",
          "| `MGA-002` | P1 | Ready | None | `moon-garden-ui` | Duplicate same-file row. |",
        ].join("\n"),
      ), "utf8");
      forgetHistory();
      const sameFileRuntime = await loadBoardRuntime({ repo: duplicateRoot, engineRoot });
      const sameFile = await runAgentQuery(
        sameFileRuntime,
        "stale",
        new Date("2026-08-28T12:00:00.000Z"),
      );
      if (sameFile.command !== "query.stale") throw new Error("unexpected command");
      expect(sameFile.data.items.filter((item) => item.id === "MGA-002")).toEqual([]);
    } finally {
      forgetHistory();
      await removeDisposableDemo(duplicateRoot);
    }
  });

  test("all query commands leave repository bytes and Git state unchanged", async () => {
    for (const query of ["startable", "stale", "issues"] as const) {
      const before = await repositorySnapshot(repositoryRoot);
      const result = await runCli(["query", query, "--repo", repositoryRoot, "--json"]);
      expect(result.code).toBe(0);
      expect(await repositorySnapshot(repositoryRoot)).toEqual(before);
    }
  });
});
