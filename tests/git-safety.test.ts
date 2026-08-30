import { appendFile, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleApi } from "../server/api.ts";
import {
  commitPlanningChanges,
  GitError,
  gitStatus,
} from "../server/git.ts";
import { sanitizedGitEnvironment } from "../server/git-command.ts";
import { taskHistory } from "../server/history.ts";
import { acquireLedgerLock, lockPathFor } from "../server/ledger/lock.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { disposableDemo, git, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function changedRuntime() {
  const root = await disposableDemo();
  roots.push(root);
  await appendFile(path.join(root, "plans", "moon-garden.md"), "\nFictional follow-up.\n");
  await appendFile(path.join(root, "README.md"), "\nUnrelated local note.\n");
  return { root, runtime: await loadBoardRuntime({ repo: root }) };
}

async function withGitRedirects<T>(operation: () => Promise<T>): Promise<T> {
  const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const redirect = path.join(path.sep, "missing-planops-board-repository");
  for (const name of names) process.env[name] = redirect;
  try {
    return await operation();
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("Git boundaries", () => {
  it("keeps the writer-lock namespace stable across engine upgrades", () => {
    expect(path.basename(lockPathFor(path.join(path.sep, "fictional", "planops"))))
      .toMatch(/^projects-board-ledger-[0-9a-f]{16}\.lock$/);
  });

  it("separates discovered planning changes from unrelated work", async () => {
    const { runtime } = await changedRuntime();
    const status = await gitStatus(runtime);
    expect(status).toMatchObject({
      branch: "main",
      onProtectedBranch: true,
      changedPlanningFiles: ["plans/moon-garden.md"],
      otherChangedFiles: ["README.md"],
    });
  });

  it("removes inherited Git control variables", () => {
    expect(sanitizedGitEnvironment({
      PATH: "safe-bin",
      GIT_DIR: "foreign",
      git_work_tree: "also-foreign",
    })).toEqual({ PATH: "safe-bin" });
  });

  it("loads the configured repository despite inherited Git redirects", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await withGitRedirects(() => loadBoardRuntime({ repo: root }));
    expect(runtime.repositoryRoot).toBe(root);
  });

  it("reads Git status despite inherited Git redirects", async () => {
    const { runtime } = await changedRuntime();
    const status = await withGitRedirects(() => gitStatus(runtime));
    expect(status.branch).toBe("main");
  });

  it("reads task history despite inherited Git redirects", async () => {
    const { runtime } = await changedRuntime();
    const history = await withGitRedirects(() => taskHistory(runtime, "plans/moon-garden.md", "MGA-002"));
    expect(history.entries.length).toBeGreaterThan(0);
  });

  it("refuses to commit on a configured protected branch", async () => {
    const { runtime } = await changedRuntime();
    await expect(
      commitPlanningChanges(runtime, { message: "Update fictional plan" }),
    ).rejects.toBeInstanceOf(GitError);
  });

  it("commits only discovered planning files on a new branch", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "add", "README.md");
    const result = await commitPlanningChanges(runtime, {
      message: "Update fictional plan",
      branch: "plan/fictional-edit",
    });
    expect(result.branch).toBe("plan/fictional-edit");
    expect(result.files).toEqual(["plans/moon-garden.md"]);
    expect(await git(root, "show", "--pretty=format:", "--name-only", "HEAD")).toBe(
      "plans/moon-garden.md",
    );
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("README.md");
  });

  it("commits both sides of a tracked planning document rename", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const source = "plans/moon-garden.md";
    const target = "plans/moon-garden-renamed.md";
    await rename(path.join(root, source), path.join(root, target));
    await git(root, "add", "--", source, target);

    const result = await commitPlanningChanges(runtime, {
      message: "Rename fictional plan",
      branch: "plan/rename-ledger",
    });

    expect(result.files).toEqual([target, source].sort());
    expect(await git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "HEAD"))
      .toBe(`R100\t${source}\t${target}`);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("commits a newly discovered untracked planning document", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const relativePath = "plans/aurora-workshop.md";
    await writeFile(path.join(root, relativePath), [
      "# Aurora Workshop plan",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      "| `AUR-001` | P2 | Ready | None | Open the fictional workshop. |",
      "",
    ].join("\n"));

    const result = await commitPlanningChanges(runtime, {
      message: "Add fictional plan",
      branch: "plan/add-ledger",
    });

    expect(result.files).toEqual([relativePath]);
    expect(await git(root, "show", "--pretty=format:", "--name-only", "HEAD")).toBe(relativePath);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("treats configured file names as literal Git pathspecs", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const configPath = path.join(root, ".projects-board", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.documents = { include: ["*/*.md"], exclude: ["other/**"] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await mkdir(path.join(root, "other"));
    await writeFile(path.join(root, "other", "trigger.md"), "# Unrelated fictional record\n");
    await git(root, "add", ".projects-board/config.json", "other/trigger.md");
    await git(root, "commit", "-m", "Prepare literal path fixture");
    const relativePath = ":(glob)**/trigger.md";
    await mkdir(path.join(root, ":(glob)**"));
    await writeFile(path.join(root, relativePath), "# Literal fictional plan\n");
    await appendFile(path.join(root, "other", "trigger.md"), "Unrelated local edit.\n");
    const runtime = await loadBoardRuntime({ repo: root });

    const result = await commitPlanningChanges(runtime, {
      message: "Add literal fictional plan",
      branch: "plan/literal-path",
    });

    expect(result.files).toEqual([relativePath]);
    expect(await git(root, "show", "--pretty=format:", "--name-only", "HEAD")).toBe(relativePath);
    expect(await git(root, "status", "--porcelain")).toContain("other/trigger.md");
  });

  it("commits deletion of the final configured planning document", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const configPath = path.join(root, ".projects-board", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.documents = { include: ["plans/moon-garden.md"], exclude: [] };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await git(root, "add", ".projects-board/config.json");
    await git(root, "commit", "-m", "Narrow fictional ledger scope");
    const runtime = await loadBoardRuntime({ repo: root });
    const relativePath = "plans/moon-garden.md";
    await unlink(path.join(root, relativePath));
    await git(root, "add", "--", relativePath);

    const result = await commitPlanningChanges(runtime, {
      message: "Remove fictional plan",
      branch: "plan/remove-ledger",
    });

    expect(result.files).toEqual([relativePath]);
    expect(await git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"))
      .toBe(`D\t${relativePath}`);
    expect(await git(root, "status", "--porcelain")).toBe("");
  });

  it("does not classify a tracked symlink as a planning document", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const relativePath = "plans/linked-ledger.md";
    await symlink("moon-garden.md", path.join(root, relativePath));
    await git(root, "add", relativePath);

    const status = await gitStatus(runtime);

    expect(status.changedPlanningFiles).not.toContain(relativePath);
    expect(status.otherChangedFiles).toContain(relativePath);
  });

  it("does not commit a planning document replaced by a symlink", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const relativePath = "plans/moon-garden.md";
    await unlink(path.join(root, relativePath));
    await symlink("../README.md", path.join(root, relativePath));

    const status = await gitStatus(runtime);

    expect(status.changedPlanningFiles).not.toContain(relativePath);
    expect(status.otherChangedFiles).toContain(relativePath);
    await expect(commitPlanningChanges(runtime, {
      message: "Unsafe fictional type change",
      branch: "plan/must-not-stage-symlink",
    })).rejects.toThrow(/no planning document changes/);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("does not admit an absent path whose committed mode is a symlink", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const relativePath = "plans/historical-link.md";
    const absolutePath = path.join(root, relativePath);
    await symlink("../README.md", absolutePath);
    await git(root, "add", relativePath);
    await git(root, "commit", "-m", "Add fictional linked record");
    await unlink(absolutePath);
    await writeFile(absolutePath, "# Temporary fictional record\n");
    await git(root, "add", relativePath);
    await unlink(absolutePath);
    const runtime = await loadBoardRuntime({ repo: root });

    const status = await gitStatus(runtime);

    expect(status.changedPlanningFiles).not.toContain(relativePath);
    expect(status.otherChangedFiles).toContain(relativePath);
    await expect(commitPlanningChanges(runtime, {
      message: "Unsafe fictional mode change",
      branch: "plan/must-not-stage-mode-change",
    })).rejects.toThrow(/no planning document changes/);
  });

  it("does not execute a repository pre-commit hook", async () => {
    const { root, runtime } = await changedRuntime();
    await writeFile(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 91\n", {
      mode: 0o755,
    });
    await expect(commitPlanningChanges(runtime, {
      message: "Update fictional plan",
      branch: "plan/no-commit-hook",
    })).resolves.toMatchObject({ branch: "plan/no-commit-hook" });
  });

  it("does not execute a repository post-checkout hook", async () => {
    const { root, runtime } = await changedRuntime();
    await writeFile(path.join(root, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 92\n", {
      mode: 0o755,
    });
    await expect(commitPlanningChanges(runtime, {
      message: "Update fictional plan",
      branch: "plan/no-checkout-hook",
    })).resolves.toMatchObject({ branch: "plan/no-checkout-hook" });
  });

  it("disables commit signing for an explicit board commit", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "config", "commit.gpgSign", "true");
    await git(root, "config", "gpg.program", path.join(path.sep, "missing-planops-board-gpg"));
    await expect(commitPlanningChanges(runtime, {
      message: "Update fictional plan",
      branch: "plan/no-signing",
    })).resolves.toMatchObject({ branch: "plan/no-signing" });
  });

  it("waits for the ledger lock before validating or staging", async () => {
    const { runtime } = await changedRuntime();
    const lock = await acquireLedgerLock(runtime.repositoryRoot);
    try {
      await expect(commitPlanningChanges(
        runtime,
        { message: "Update fictional plan", branch: "plan/locked" },
        { lock: { timeoutMs: 20, pollMs: 5 } },
      )).rejects.toThrow(/lock/);
    } finally {
      await lock.release();
    }
  });

  it("validates planning documents before creating a branch", async () => {
    const { root, runtime } = await changedRuntime();
    const file = path.join(root, "plans", "moon-garden.md");
    const text = await readFile(file, "utf8");
    await writeFile(file, text.replace("| P1 | Ready |", "| P1 | Vanished |"));
    await expect(commitPlanningChanges(runtime, {
      message: "Update invalid fictional plan",
      branch: "plan/must-not-exist",
    })).rejects.toThrow(/invalid planning documents/);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
  });

  it("reports detached HEAD explicitly", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "checkout", "--detach");
    await expect(gitStatus(runtime)).resolves.toMatchObject({ branch: "HEAD", detached: true });
  });

  it("reports HEAD as the detached session source", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "checkout", "--detach");
    const response = await handleApi(runtime, "GET", "/api/session", undefined);
    expect(response.body).toMatchObject({ sourceRef: "HEAD" });
  });

  it("refuses a detached HEAD commit without a new branch", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "checkout", "--detach");
    await expect(
      commitPlanningChanges(runtime, { message: "Update fictional plan" }),
    ).rejects.toThrow(/detached HEAD/);
  });

  it("creates a branch before committing from detached HEAD", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "checkout", "--detach");
    await expect(commitPlanningChanges(runtime, {
      message: "Update fictional plan",
      branch: "plan/from-detached",
    })).resolves.toMatchObject({ branch: "plan/from-detached" });
  });

  it("never pushes the branch created for an explicit commit", async () => {
    const { root, runtime } = await changedRuntime();
    const remote = path.join(path.dirname(root), "remote.git");
    await git(path.dirname(root), "init", "--bare", remote);
    await git(root, "remote", "add", "origin", remote);
    await git(root, "push", "-u", "origin", "main");
    const remoteMainBefore = await git(root, "ls-remote", "origin", "refs/heads/main");
    await commitPlanningChanges(runtime, {
      message: "Update fictional plan",
      branch: "plan/local-only",
    });
    expect(await git(root, "ls-remote", "origin", "refs/heads/plan/local-only")).toBe("");
    expect(await git(root, "ls-remote", "origin", "refs/heads/main")).toBe(remoteMainBefore);
  });

  it("honors a config that disables commits", async () => {
    const { root } = await changedRuntime();
    const configPath = path.join(root, ".projects-board", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.git.commitEnabled = false;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const runtime = await loadBoardRuntime({ repo: root });
    await expect(
      commitPlanningChanges(runtime, {
        message: "Update fictional plan",
        branch: "plan/disabled",
      }),
    ).rejects.toThrow(/disabled/);
  });
});
