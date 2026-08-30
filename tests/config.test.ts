import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseBoardConfig } from "../shared/config.ts";
import {
  RuntimeConfigError,
  assertSafeRepositoryDirectory,
  discoverPlanningDocuments,
  loadBoardConfig,
  loadBoardRuntime,
  matchesPlanningDocumentPath,
} from "../server/runtime.ts";
import { loadBoard } from "../server/ledger/corpus.ts";
import { demoRoot, disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

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

describe("configuration", () => {
  it("accepts the bundled fictional configuration", async () => {
    const config = parseBoardConfig(await exampleConfig());
    expect(config.version).toBe(1);
    expect(config.documents.include).toEqual(["plans/**/*.md"]);
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
