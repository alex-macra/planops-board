import { appendFile, readFile, writeFile } from "node:fs/promises";
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
