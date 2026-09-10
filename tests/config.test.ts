import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import { afterEach, describe, expect, it } from "vitest";

import { boardConfigSchema, parseBoardConfig } from "../shared/config.ts";
import {
  RuntimeConfigError,
  assertSafeRepositoryDirectory,
  discoverPlanningDocuments,
  discoverWritablePlanningDocuments,
  loadBoardConfig,
  loadBoardRuntime,
  matchesPlanningDocumentPath,
} from "../server/runtime.ts";
import { loadBoard } from "../server/ledger/corpus.ts";
import { applyWrite, ForbiddenPathError } from "../server/ledger/write.ts";
import { demoRoot, disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];
const bundledValidator = readFile(new URL("../schema/config.schema.json", import.meta.url), "utf8")
  .then((text) => new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(text)));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function exampleConfig(): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(demoRoot, ".projects-board", "config.json"), "utf8"),
  );
}

async function planopsConfig(): Promise<string> {
  return readFile(path.join(demoRoot, "..", "planops-config.json"), "utf8");
}

async function configureVersionTwo(root: string, writable: readonly string[]) {
  const original = parseBoardConfig(await exampleConfig());
  const config = {
    ...original,
    version: 2,
    documents: { ...original.documents, writable },
  };
  await writeFile(path.join(root, ".projects-board", "config.json"), JSON.stringify(config));
  return config;
}

async function runtimeDocuments(runtime: Awaited<ReturnType<typeof loadBoardRuntime>>) {
  const documents = await discoverPlanningDocuments(runtime.repositoryRoot, runtime.config);
  const writable = await discoverWritablePlanningDocuments(
    runtime.repositoryRoot,
    runtime.config,
    documents,
  );
  return { documents, writable };
}

describe("configuration", () => {
  it("accepts the bundled fictional configuration", async () => {
    const config = parseBoardConfig(await exampleConfig());
    expect(config.version).toBe(1);
    expect(config.documents.include).toEqual(["plans/**/*.md"]);
  });

  it("loads version two with an explicit writable subset", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const config = await configureVersionTwo(root, ["plans/moon-*.md"]);
    expect(parseBoardConfig(config).version).toBe(2);
    const before = await readFile(path.join(root, ".projects-board", "config.json"));
    const runtime = await loadBoardRuntime({ repo: root });
    const discovered = await runtimeDocuments(runtime);
    expect(runtime.config.version).toBe(2);
    expect(discovered.documents).toHaveLength(3);
    expect(discovered.writable).toEqual(new Set(["plans/moon-garden.md"]));
    expect(await readFile(path.join(root, ".projects-board", "config.json"))).toEqual(before);
  });

  it.each([
    ["empty list", [], true],
    ["literal path", ["tracking.md"], true],
    ["recursive glob", ["plans/**/*.md"], true],
    ["overlapping globs", ["plans/*.md", "plans/moon-garden.md"], true],
    ["interior spaces", ["plans/moon garden.md"], true],
    ["uppercase extension", ["plans/*.MD"], true],
    ["dot prefix", ["./plans/*.md"], false],
    ["dot segment", ["plans/./*.md"], false],
    ["NUL", ["plans/\0.md"], false],
    ["leading whitespace", [" plans/*.md"], false],
    ["trailing whitespace", ["plans/*.md "], false],
    ["leading Unicode whitespace", ["\u00a0plans/*.md"], false],
    ["trailing Unicode whitespace", ["plans/*.md\ufeff"], false],
    ["duplicate", ["plans/*.md", "plans/*.md"], false],
    ["trim-equivalent duplicate", ["plans/*.md", " plans/*.md"], false],
    ["dot-equivalent duplicate", ["plans/*.md", "plans/./*.md"], false],
    ["traversal", ["plans/../*.md"], false],
    ["absolute path", ["/plans/*.md"], false],
    ["Windows drive", ["C:/plans/*.md"], false],
    ["backslash", ["plans\\*.md"], false],
    ["duplicate slash", ["plans//*.md"], false],
    ["question wildcard", ["plans/?.md"], false],
    ["character class", ["plans/[a-z].md"], false],
    ["brace expansion", ["plans/{moon,star}.md"], false],
    ["extglob", ["plans/@(moon).md"], false],
    ["negation", ["!plans/*.md"], false],
    ["non-Markdown", ["plans/*.txt"], false],
    ["newline", ["plans/\nmoon.md"], false],
    ["tab", ["plans/\tmoon.md"], false],
    ["line separator", ["plans/\u2028moon.md"], false],
    ["empty pattern", [""], false],
    ["extension without a basename", [".md"], false],
    ["wrong array type", "plans/*.md", false],
  ] as const)("keeps writable validators in agreement for %s", async (_label, writable, accepted) => {
    const original = parseBoardConfig(await exampleConfig());
    const config = { ...original, version: 2, documents: { ...original.documents, writable } };
    const before = JSON.stringify(config);
    expect((await bundledValidator)(config)).toBe(accepted);
    const parsed = boardConfigSchema.safeParse(config);
    expect(parsed.success).toBe(accepted);
    expect(JSON.stringify(config)).toBe(before);
    if (parsed.success) expect(parsed.data).toEqual(config);
  });

  it("deduplicates valid writable overlaps without expanding the selected files", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await configureVersionTwo(root, ["plans/moon-*.md", "plans/moon-garden.md"]);
    const runtime = await loadBoardRuntime({ repo: root });
    expect((await runtimeDocuments(runtime)).writable).toEqual(new Set(["plans/moon-garden.md"]));
  });

  it.each([{ writable: [] }, { writable: ["future/**/*.md"] }])("allows an entirely empty writable set $writable", async ({ writable }) => {
    const root = await disposableDemo();
    roots.push(root);
    await configureVersionTwo(root, writable);
    const runtime = await loadBoardRuntime({ repo: root });
    const discovered = await runtimeDocuments(runtime);
    expect(discovered.documents).toHaveLength(3);
    expect(discovered.writable.size).toBe(0);
  });

  it("rejects a partly unmatched writable declaration", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await configureVersionTwo(root, ["plans/moon-garden.md", "future/**/*.md"]);
    await expect(loadBoardRuntime({ repo: root })).rejects.toThrow(/writable.*did not match/);
  });

  it.each(["README.md", "archive/old-plan.md"])("rejects writable files outside readable scope: %s", async (file) => {
    const root = await disposableDemo();
    roots.push(root);
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "# Reference\n");
    await configureVersionTwo(root, [file]);
    await expect(loadBoardRuntime({ repo: root })).rejects.toThrow(/outside.*readable/);
  });

  it("refuses writes to a readable document excluded from version two write scope", async () => {
    const root = await disposableDemo("work/demo");
    roots.push(root);
    await configureVersionTwo(root, ["plans/shared-observatory.md"]);
    const runtime = await loadBoardRuntime({ repo: root });
    const board = await loadBoard(runtime);
    const task = board.tasks.find((entry) => entry.id === "MGA-002")!;
    const document = board.documents.find((entry) => entry.path === task.file)!;
    const before = await readFile(path.join(root, task.file));
    await expect(applyWrite(runtime, {
      file: task.file,
      baseSha256: document.sha256,
      edits: [{ ...task.statusCell!, expected: "Ready", value: "In progress" }],
    })).rejects.toBeInstanceOf(ForbiddenPathError);
    expect(await readFile(path.join(root, task.file))).toEqual(before);
  });

  it("rejects a symlink in the writable scope", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await symlink("moon-garden.md", path.join(root, "plans", "linked.md"));
    await configureVersionTwo(root, ["plans/linked.md"]);
    await expect(loadBoardRuntime({ repo: root })).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it.each([
    { version: 2, documents: { include: ["plans/**/*.md"] } },
    { version: 1, documents: { include: ["plans/**/*.md"], writable: [] } },
    { version: 3, documents: { include: ["plans/**/*.md"], writable: [] } },
    { version: 2, documents: { include: ["plans/**/*.md"], writable: "plans/**/*.md" } },
    { version: 2, documents: { include: ["plans/**/*.md"], writable: [], extra: true } },
  ])("rejects an invalid version/write-scope shape %j", async (shape) => {
    const root = await disposableDemo();
    roots.push(root);
    const config = { ...parseBoardConfig(await exampleConfig()), ...shape };
    expect(() => parseBoardConfig(config)).toThrow();
    await writeFile(path.join(root, ".projects-board", "config.json"), JSON.stringify(config));
    await expect(loadBoardConfig(root)).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it.each([
    "/plans/**/*.md", "../plans/**/*.md", "plans/../secret.md", "plans\\*.md",
    "{plans,/tmp}/**/*.md", "plans/[.][.]/secret.md", "plans/**/*.txt", "plans/\0.md",
  ])("rejects unsafe writable pattern %s", async (pattern) => {
    const root = await disposableDemo();
    roots.push(root);
    const config = await configureVersionTwo(root, [pattern]);
    expect(() => parseBoardConfig(config)).toThrow();
    await expect(loadBoardConfig(root)).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("rejects unknown fields", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const config = { ...(await exampleConfig() as object), surprise: true };
    await writeFile(
      path.join(root, ".projects-board", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await expect(loadBoardConfig(root)).rejects.toThrow(/additional properties/);
  });

  it("defaults an omitted exclusion list", async () => {
    const config = await exampleConfig() as Record<string, unknown>;
    const documents = { ...(config.documents as Record<string, unknown>) };
    delete documents.exclude;
    config.documents = documents;
    expect(parseBoardConfig(config).documents.exclude).toEqual([]);
  });

  it("rejects invalid workflow relationships", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const config = await exampleConfig() as Record<string, unknown>;
    config.workflow = {
      ...(config.workflow as object),
      activeStatuses: ["Complete"],
    };
    await writeFile(
      path.join(root, ".projects-board", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await expect(loadBoardConfig(root)).rejects.toThrow(/cannot also be blocked or closed/);
  });

  it.each([
    "/plans/**/*.md",
    "../plans/**/*.md",
    "{plans,/tmp}/**/*.md",
    "plans/[.][.]/private.md",
    "plans/***/private.md",
    "plans/**/*.txt",
  ])(
    "rejects unsafe document pattern %s",
    async (include) => {
      const root = await disposableDemo();
      roots.push(root);
      const config = await exampleConfig() as Record<string, unknown>;
      config.documents = { include: [include], exclude: [] };
      await writeFile(
        path.join(root, ".projects-board", "config.json"),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      await expect(loadBoardConfig(root)).rejects.toBeInstanceOf(RuntimeConfigError);
    },
  );

  it("discovers only configured Markdown outside the archive", async () => {
    const config = parseBoardConfig(await exampleConfig());
    await expect(discoverPlanningDocuments(demoRoot, config)).resolves.toEqual([
      "plans/moon-garden.md",
      "plans/shared-observatory.md",
      "plans/signal-harbor.md",
    ]);
  });

  it.each([
    ["plans/moon-garden.md", true],
    ["plans/nested/comet-map.md", true],
    ["plans/archive/retired.md", false],
    ["plans/.hidden.md", false],
    ["README.md", false],
    ["../plans/private.md", false],
  ])("matches configured Git path %s as %s", async (relativePath, expected) => {
    const config = parseBoardConfig(await exampleConfig());
    expect(matchesPlanningDocumentPath(relativePath, config)).toBe(expected);
  });

  it("loads active and done ledgers from the planops template", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await mkdir(path.join(root, "tasks", "active"), { recursive: true });
    await mkdir(path.join(root, "tasks", "done"), { recursive: true });
    await writeFile(
      path.join(root, "tasks", "active", "current.md"),
      "# Current\n\n| ID | Status |\n| --- | --- |\n| CUR-001 | Ready |\n",
    );
    await writeFile(
      path.join(root, "tasks", "done", "complete.md"),
      "# Complete\n\n| ID | Status |\n| --- | --- |\n| DON-001 | Complete |\n",
    );
    await writeFile(path.join(root, ".projects-board", "config.json"), await planopsConfig());

    const runtime = await loadBoardRuntime({ repo: root });
    const board = await loadBoard(runtime, "2026-08-27T00:00:00.000Z");

    expect(board.documents.map((document) => document.path)).toEqual([
      "tasks/active/current.md",
      "tasks/done/complete.md",
    ]);
    expect(board.tasks.map(({ id, file }) => ({ id, file }))).toEqual([
      { id: "CUR-001", file: "tasks/active/current.md" },
      { id: "DON-001", file: "tasks/done/complete.md" },
    ]);
  });

  it("rejects a symlinked config", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const directory = path.join(root, ".projects-board");
    await rename(path.join(directory, "config.json"), path.join(directory, "config-real.json"));
    await symlink("config-real.json", path.join(directory, "config.json"));
    await expect(loadBoardConfig(root)).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("rejects an absolute config path even when it is inside the repository", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const configPath = path.join(root, ".projects-board", "config.json");
    await expect(loadBoardConfig(root, configPath)).rejects.toThrow(/repository-relative/);
  });

  it("rejects a configured symlinked document", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await symlink("moon-garden.md", path.join(root, "plans", "linked.md"));
    const raw = await exampleConfig() as Record<string, unknown>;
    raw.documents = { include: ["plans/linked.md"], exclude: [] };
    const config = parseBoardConfig(raw);
    await expect(discoverPlanningDocuments(root, config)).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("rejects a symlinked watcher directory", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await symlink("plans", path.join(root, "linked-plans"));
    await expect(assertSafeRepositoryDirectory(root, "linked-plans"))
      .rejects.toThrow(/symbolic links/);
  });

  it("loads a canonical Git runtime and applies the CLI port override", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: path.join(root, "plans"), port: 6200 });
    expect(runtime.repositoryRoot).toBe(root);
    expect(runtime.port).toBe(6200);
    await expect(discoverPlanningDocuments(root, runtime.config)).resolves.toEqual([
      "plans/moon-garden.md",
      "plans/shared-observatory.md",
      "plans/signal-harbor.md",
    ]);
  });

  it("rejects unsafe paths in the optional project map", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await writeFile(
      path.join(root, ".projects-board", "projects.json"),
      `${JSON.stringify([
        {
          id: "unsafe-project",
          label: "Unsafe Project",
          scope: "product",
          repositories: [],
          filePrefixes: ["../plans/private.md"],
        },
      ])}\n`,
    );
    await expect(loadBoardRuntime({ repo: root })).rejects.toThrow(/filePrefixes/);
  });

  it("does not enable the validator hook without explicit permission", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await writeFile(path.join(root, ".projects-board", "validate"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const runtime = await loadBoardRuntime({ repo: root });
    expect(runtime.externalValidator).toBeNull();
  });
});
