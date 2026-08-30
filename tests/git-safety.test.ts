import { createHash } from "node:crypto";
import { unlinkSync, watch, writeFileSync } from "node:fs";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { handleApi } from "../server/api.ts";
import {
  commitPlanningChanges as commitPlanningChangesWithPreview,
  type CommitOptions,
  type CommitRequest,
  GitError,
  gitStatus,
} from "../server/git.ts";
import { sanitizedGitEnvironment } from "../server/git-command.ts";
import { taskHistory } from "../server/history.ts";
import { acquireLedgerLock, lockPathFor } from "../server/ledger/lock.ts";
import { loadBoardRuntime, type BoardRuntime } from "../server/runtime.ts";
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

async function commitPlanningChanges(
  runtime: BoardRuntime,
  request: Omit<CommitRequest, "expectedCommitPreviewToken">,
  options: CommitOptions = {},
) {
  const preview = await gitStatus(runtime);
  return commitPlanningChangesWithPreview(
    runtime,
    { ...request, expectedCommitPreviewToken: preview.commitPreviewToken },
    options,
  );
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
      commitEnabled: true,
      changedPlanningFiles: ["plans/moon-garden.md"],
      otherChangedFiles: ["README.md"],
    });
    const response = await handleApi(runtime, "GET", "/api/git/status", undefined);
    expect(response.body).not.toHaveProperty("sourceHead");
    expect(response.body).not.toHaveProperty("worktreeDigest");
  });

  it("refuses a stale commit preview before changing the branch or index", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "add", "README.md");
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");
    await writeFile(path.join(root, "field-notes.txt"), "Unrelated fictional notes.\n");

    const response = await handleApi(runtime, "POST", "/api/git/commit", {
      taskIds: [],
      message: "Update fictional plan",
      branch: "plan/stale-preview",
      expectedCommitPreviewToken: preview.commitPreviewToken,
    });

    expect(response).toMatchObject({
      status: 409,
      body: { kind: "conflict", error: expect.stringMatching(/updated commit preview/) },
    });
    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(root, "diff", "--cached", "--name-only")).toBe("README.md");
  });

  it("invalidates the commit preview when excluded staging state changes", async () => {
    const { root, runtime } = await changedRuntime();
    const unstaged = await gitStatus(runtime);

    await git(root, "add", "README.md");
    const staged = await gitStatus(runtime);

    expect(staged.changedPlanningFiles).toEqual(unstaged.changedPlanningFiles);
    expect(staged.otherChangedFiles).toEqual(unstaged.otherChangedFiles);
    expect(staged.commitPreviewToken).not.toBe(unstaged.commitPreviewToken);
  });

  it("invalidates the commit preview when included bytes change with the same Git status", async () => {
    const { root, runtime } = await changedRuntime();
    const first = await gitStatus(runtime);
    await appendFile(path.join(root, "plans", "moon-garden.md"), "Another fictional note.\n");
    const second = await gitStatus(runtime);

    expect(second.changedPlanningFiles).toEqual(first.changedPlanningFiles);
    expect(second.otherChangedFiles).toEqual(first.otherChangedFiles);
    expect(second.commitPreviewToken).not.toBe(first.commitPreviewToken);
  });

  it("invalidates the commit preview when a staged blob changes with the same Git status", async () => {
    const { root, runtime } = await changedRuntime();
    await git(root, "add", "README.md");
    const first = await gitStatus(runtime);
    await appendFile(path.join(root, "README.md"), "Another excluded staged note.\n");
    await git(root, "add", "README.md");
    const second = await gitStatus(runtime);

    expect(second.changedPlanningFiles).toEqual(first.changedPlanningFiles);
    expect(second.otherChangedFiles).toEqual(first.otherChangedFiles);
    expect(second.commitPreviewToken).not.toBe(first.commitPreviewToken);
  });

  it("rejects bytes captured between equal preview snapshots", async () => {
    const { root, runtime } = await changedRuntime();
    const relativePath = "plans/moon-garden.md";
    const absolutePath = path.join(root, relativePath);
    const acceptedText = await readFile(absolutePath, "utf8");
    const transientText = `${acceptedText}\nTransient fictional capture.\n`;
    const transientOid = createHash("sha1")
      .update(`blob ${Buffer.byteLength(transientText)}\0`)
      .update(transientText)
      .digest("hex");
    const objectDirectory = path.join(root, ".git", "objects", transientOid.slice(0, 2));
    await mkdir(objectDirectory, { recursive: true });
    const repositoryToken = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const candidatePrefix = `planops-board-commit-${repositoryToken}-`;
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");
    let changed = false;
    let restored = false;
    const candidateWatcher = watch(tmpdir(), (_event, name) => {
      if (changed || !String(name).startsWith(candidatePrefix)) return;
      changed = true;
      writeFileSync(absolutePath, transientText);
    });
    const objectWatcher = watch(objectDirectory, () => {
      if (!changed || restored) return;
      restored = true;
      writeFileSync(absolutePath, acceptedText);
    });

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Must reject transient fictional bytes",
        branch: "plan/no-transient-capture",
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/working tree changed while capturing the commit/);
    } finally {
      candidateWatcher.close();
      objectWatcher.close();
      if (changed && !restored) await writeFile(absolutePath, acceptedText);
    }

    expect(changed).toBe(true);
    expect(restored).toBe(true);
    expect(await readFile(absolutePath, "utf8")).toBe(acceptedText);
    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("preserves a staged-only planning change when the worktree matches HEAD", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const relativePath = "plans/moon-garden.md";
    const absolutePath = path.join(root, relativePath);
    const original = await readFile(absolutePath, "utf8");
    await writeFile(absolutePath, `${original}\nStaged fictional note.\n`);
    await git(root, "add", relativePath);
    await writeFile(absolutePath, original);
    const preview = await gitStatus(runtime);
    const stagedBefore = await git(root, "diff", "--cached", "--", relativePath);
    const headBefore = await git(root, "rev-parse", "HEAD");

    await expect(commitPlanningChangesWithPreview(runtime, {
      message: "Must not create an empty commit",
      branch: "plan/no-empty-commit",
      expectedCommitPreviewToken: preview.commitPreviewToken,
    })).rejects.toThrow(/no planning document changes/);

    expect(await git(root, "rev-parse", "HEAD")).toBe(headBefore);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(root, "diff", "--cached", "--", relativePath)).toBe(stagedBefore);
  });

  it("refuses to commit while a merge conflict is in progress", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const relativePath = "plans/moon-garden.md";
    const absolutePath = path.join(root, relativePath);
    const original = await readFile(absolutePath, "utf8");
    const originalNote = "The empty-state wording still needs a final review.";
    await git(root, "checkout", "-b", "fictional-side");
    await writeFile(absolutePath, original.replace(originalNote, "The side branch reviewed the empty state."));
    await git(root, "add", relativePath);
    await git(root, "commit", "-m", "Edit fictional side branch");
    await git(root, "checkout", "main");
    await writeFile(absolutePath, original.replace(originalNote, "The main branch reviewed the empty state."));
    await git(root, "add", relativePath);
    await git(root, "commit", "-m", "Edit fictional main branch");
    await expect(git(root, "merge", "fictional-side")).rejects.toThrow();
    const runtime = await loadBoardRuntime({ repo: root });
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");

    await expect(commitPlanningChangesWithPreview(runtime, {
      message: "Must not bypass the merge conflict",
      branch: "plan/no-conflict-commit",
      expectedCommitPreviewToken: preview.commitPreviewToken,
    })).rejects.toThrow(/index has conflicts|operation is in progress/);

    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(root, "ls-files", "--unmerged")).not.toBe("");
  });

  it("commits the captured regular file when its path becomes a symlink during branch install", async () => {
    const { root, runtime } = await changedRuntime();
    const relativePath = "plans/moon-garden.md";
    const absolutePath = path.join(root, relativePath);
    const preview = await gitStatus(runtime);
    let finishSwap = (): void => undefined;
    let failSwap = (_error: unknown): void => undefined;
    let swapTimer: ReturnType<typeof setTimeout> | undefined;
    const swapFinished = new Promise<void>((resolve, reject) => {
      finishSwap = resolve;
      failSwap = reject;
      swapTimer = setTimeout(() => reject(new Error("the branch switch did not trigger the swap")), 2_000);
    });
    let swapped = false;
    const watcher = watch(path.join(root, ".git"), (_event, name) => {
      if (String(name) !== "HEAD" || swapped) return;
      swapped = true;
      void unlink(absolutePath)
        .then(() => symlink("../README.md", absolutePath))
        .then(finishSwap, failSwap);
    });

    try {
      await commitPlanningChangesWithPreview(runtime, {
        message: "Commit captured fictional plan",
        branch: "plan/captured-regular-file",
        expectedCommitPreviewToken: preview.commitPreviewToken,
      });
      await swapFinished;
    } finally {
      if (swapTimer) clearTimeout(swapTimer);
      watcher.close();
    }

    expect(swapped).toBe(true);
    expect((await git(root, "ls-tree", "HEAD", "--", relativePath))).toMatch(/^100644 /);
    expect(await git(root, "show", `HEAD:./${relativePath}`)).toContain("Fictional follow-up.");
    expect((await lstat(absolutePath)).isSymbolicLink()).toBe(true);
  });

  it("does not recurse when a captured deletion becomes a directory during branch install", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const runtime = await loadBoardRuntime({ repo: root });
    const relativePath = "plans/moon-garden.md";
    const absolutePath = path.join(root, relativePath);
    await unlink(absolutePath);
    const preview = await gitStatus(runtime);
    let finishSwap = (): void => undefined;
    let failSwap = (_error: unknown): void => undefined;
    let swapTimer: ReturnType<typeof setTimeout> | undefined;
    const swapFinished = new Promise<void>((resolve, reject) => {
      finishSwap = resolve;
      failSwap = reject;
      swapTimer = setTimeout(() => reject(new Error("the branch switch did not trigger the swap")), 2_000);
    });
    const watcher = watch(path.join(root, ".git"), (_event, name) => {
      if (String(name) !== "HEAD") return;
      watcher.close();
      void mkdir(absolutePath)
        .then(() => writeFile(path.join(absolutePath, "excluded.txt"), "Excluded fictional note.\n"))
        .then(finishSwap, failSwap);
    });

    try {
      await commitPlanningChangesWithPreview(runtime, {
        message: "Remove captured fictional plan",
        branch: "plan/captured-deletion",
        expectedCommitPreviewToken: preview.commitPreviewToken,
      });
      await swapFinished;
    } finally {
      if (swapTimer) clearTimeout(swapTimer);
      watcher.close();
    }

    expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD", "--", relativePath)).toBe("");
    await expect(readFile(path.join(absolutePath, "excluded.txt"), "utf8"))
      .resolves.toBe("Excluded fictional note.\n");
  });

  it("rejects a selected file that would replace an excluded tracked directory", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const selectedPath = "plans/star-map.md";
    const excludedPath = `${selectedPath}/field-notes.txt`;
    const selectedText = [
      "# Star Map plan",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      "| `STM-001` | P2 | Ready | None | Chart the fictional night garden. |",
      "",
    ].join("\n");
    await mkdir(path.join(root, selectedPath));
    await writeFile(path.join(root, excludedPath), "Fictional field notes.\n");
    await git(root, "add", excludedPath);
    await git(root, "commit", "-m", "Add fictional field notes");
    await unlink(path.join(root, excludedPath));
    await rmdir(path.join(root, selectedPath));
    await writeFile(path.join(root, selectedPath), selectedText);
    const runtime = await loadBoardRuntime({ repo: root });
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");
    const indexBefore = await git(root, "ls-files", "--stage", "-z");

    await expect(commitPlanningChangesWithPreview(runtime, {
      message: "Must not replace excluded history",
      branch: "plan/no-head-directory-file-conflict",
      expectedCommitPreviewToken: preview.commitPreviewToken,
    })).rejects.toThrow(/candidate commit would change excluded path/);

    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(root, "ls-files", "--stage", "-z")).toBe(indexBefore);
    await expect(lstat(path.join(root, ".git", "index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a selected file that conflicts with an excluded staged descendant", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const selectedPath = "plans/glasshouse.md";
    const excludedPath = `${selectedPath}/draft.txt`;
    await mkdir(path.join(root, selectedPath));
    await writeFile(path.join(root, excludedPath), "Excluded staged draft.\n");
    await git(root, "add", excludedPath);
    const excludedEntry = await git(root, "ls-files", "--stage", "--", excludedPath);
    await unlink(path.join(root, excludedPath));
    await rmdir(path.join(root, selectedPath));
    await writeFile(path.join(root, selectedPath), [
      "# Glasshouse plan",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      "| `GLA-001` | P2 | Ready | None | Open the fictional glasshouse. |",
      "",
    ].join("\n"));
    const runtime = await loadBoardRuntime({ repo: root });
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");

    await expect(commitPlanningChangesWithPreview(runtime, {
      message: "Must preserve the excluded staged draft",
      branch: "plan/no-staged-directory-file-conflict",
      expectedCommitPreviewToken: preview.commitPreviewToken,
    })).rejects.toThrow(/conflicts with excluded staged path/);

    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(root, "ls-files", "--stage", "--", excludedPath)).toBe(excludedEntry);
    await expect(lstat(path.join(root, ".git", "index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves an excluded staged descendant when committing a selected deletion", async () => {
    const root = await disposableDemo();
    roots.push(root);
    const selectedPath = "plans/temporary-studio.md";
    const excludedPath = `${selectedPath}/private-draft.txt`;
    await writeFile(path.join(root, selectedPath), [
      "# Temporary Studio plan",
      "",
      "| ID | Priority | Status | Dependencies | Required outcome |",
      "|---|---:|---|---|---|",
      "| `TMP-001` | P2 | Ready | None | Open the fictional studio. |",
      "",
    ].join("\n"));
    await git(root, "add", selectedPath);
    await git(root, "commit", "-m", "Add fictional temporary studio");
    await unlink(path.join(root, selectedPath));
    await mkdir(path.join(root, selectedPath));
    await writeFile(path.join(root, excludedPath), "Excluded staged private draft.\n");
    await git(root, "add", excludedPath);
    const excludedEntry = await git(root, "ls-files", "--stage", "--", excludedPath);
    await unlink(path.join(root, excludedPath));
    await rmdir(path.join(root, selectedPath));
    const runtime = await loadBoardRuntime({ repo: root });

    const result = await commitPlanningChanges(runtime, {
      message: "Remove fictional temporary studio",
      branch: "plan/remove-temporary-studio",
    });

    expect(result.files).toContain(selectedPath);
    expect(await git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"))
      .toBe(`D\t${selectedPath}`);
    expect(await git(root, "ls-files", "--stage", "--", excludedPath)).toBe(excludedEntry);
    expect(await git(root, "diff", "--cached", "--name-only", "--", excludedPath))
      .toBe(excludedPath);
    await expect(git(root, "show", `HEAD:./${excludedPath}`)).rejects.toThrow();
  });

  it("refuses a commit when the real Git index is missing", async () => {
    const { root, runtime } = await changedRuntime();
    await unlink(path.join(root, ".git", "index"));
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");

    await expect(commitPlanningChangesWithPreview(runtime, {
      message: "Must not recreate a missing index",
      branch: "plan/no-missing-index",
      expectedCommitPreviewToken: preview.commitPreviewToken,
    })).rejects.toThrow(/could not read the Git index/);

    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await expect(lstat(path.join(root, ".git", "index"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(root, ".git", "index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
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

  it("keeps Git text normalization semantics for captured Markdown", async () => {
    const root = await disposableDemo();
    roots.push(root);
    await writeFile(path.join(root, ".gitattributes"), "*.md text eol=lf\n");
    await git(root, "add", ".gitattributes");
    await git(root, "commit", "-m", "Normalize fictional Markdown");
    const relativePath = "plans/moon-garden.md";
    const absolutePath = path.join(root, relativePath);
    const original = await readFile(absolutePath, "utf8");
    await writeFile(
      absolutePath,
      `${original}\nFictional normalized note.\n`.replaceAll("\n", "\r\n"),
    );
    const runtime = await loadBoardRuntime({ repo: root });

    await commitPlanningChanges(runtime, {
      message: "Commit normalized fictional Markdown",
      branch: "plan/normalized-markdown",
    });

    expect((await git(root, "show", `HEAD:./${relativePath}`))).not.toContain("\r");
    expect((await gitStatus(runtime)).changedPlanningFiles).toEqual([]);
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

  it("does not change refs or the index when another Git operation holds the index lock", async () => {
    const { root, runtime } = await changedRuntime();
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const indexLockPath = path.join(root, ".git", "index.lock");
    await writeFile(indexLockPath, "Fictional lock holder.\n");

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Must wait for the Git index lock",
        branch: "plan/index-already-locked",
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/index is locked/);

      expect(await git(root, "rev-parse", "HEAD")).toBe(head);
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
      expect(await readFile(indexLockPath, "utf8")).toBe("Fictional lock holder.\n");
    } finally {
      await unlink(indexLockPath);
    }
  });

  it("does not remove or publish a replacement for its acquired Git index lock", async () => {
    const { root, runtime } = await changedRuntime();
    const preview = await gitStatus(runtime);
    const head = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const indexLockPath = path.join(root, ".git", "index.lock");
    const replacement = "Replacement fictional lock holder.\n";
    let finishReplacement = (): void => undefined;
    let failReplacement = (_error: unknown): void => undefined;
    const replacementFinished = new Promise<void>((resolve, reject) => {
      finishReplacement = resolve;
      failReplacement = reject;
    });
    let replacementTimer: ReturnType<typeof setTimeout> | undefined;
    let replaced = false;
    const watcher = watch(path.join(root, ".git"), (_event, name) => {
      if (!String(name).startsWith("planops-board-index-") || replaced) return;
      replaced = true;
      void unlink(indexLockPath)
        .then(() => writeFile(indexLockPath, replacement))
        .then(finishReplacement, failReplacement);
    });
    replacementTimer = setTimeout(
      () => failReplacement(new Error("the prepared-index directory did not trigger replacement")),
      2_000,
    );

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Must retain replacement lock ownership",
        branch: "plan/no-replaced-index-lock",
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/ownership of the Git index lock was lost/);
      await replacementFinished;

      expect(await git(root, "rev-parse", "HEAD")).toBe(head);
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
      expect(await readFile(indexLockPath, "utf8")).toBe(replacement);
    } finally {
      if (replacementTimer) clearTimeout(replacementTimer);
      watcher.close();
      await unlink(indexLockPath).catch(() => undefined);
    }
  });

  it("retains the new branch when the original branch disappears during rollback", async () => {
    const { root, runtime } = await changedRuntime();
    const preview = await gitStatus(runtime);
    const originalHead = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const indexLockPath = path.join(root, ".git", "index.lock");
    const originalRefPath = path.join(root, ".git", "refs", "heads", "main");
    const replacement = "Replacement lock after fictional branch switch.\n";
    const targetBranch = "plan/preserve-safe-head";
    let finishReplacement = (): void => undefined;
    let failReplacement = (_error: unknown): void => undefined;
    const replacementFinished = new Promise<void>((resolve, reject) => {
      finishReplacement = resolve;
      failReplacement = reject;
    });
    const replacementTimer = setTimeout(
      () => failReplacement(new Error("the HEAD switch did not trigger replacement")),
      2_000,
    );
    let replaced = false;
    const watcher = watch(path.join(root, ".git"), (_event, name) => {
      if (String(name) !== "HEAD" || replaced) return;
      replaced = true;
      try {
        unlinkSync(originalRefPath);
        unlinkSync(indexLockPath);
        writeFileSync(indexLockPath, replacement);
        finishReplacement();
      } catch (error) {
        failReplacement(error);
      }
    });

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Preserve a resolvable fictional branch",
        branch: targetBranch,
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/commit installation and rollback failed/);
      await replacementFinished;

      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(targetBranch);
      const targetHead = await git(root, "rev-parse", `refs/heads/${targetBranch}`);
      expect(await git(root, "rev-parse", "HEAD")).toBe(targetHead);
      expect(targetHead).not.toBe(originalHead);
      await expect(git(root, "rev-parse", "--verify", "refs/heads/main")).rejects.toThrow();
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
      expect(await readFile(indexLockPath, "utf8")).toBe(replacement);
    } finally {
      clearTimeout(replacementTimer);
      watcher.close();
      await unlink(indexLockPath).catch(() => undefined);
    }
  });

  it("restores the exact source when the new branch ref disappears during rollback", async () => {
    const { root, runtime } = await changedRuntime();
    const preview = await gitStatus(runtime);
    const originalHead = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const indexLockPath = path.join(root, ".git", "index.lock");
    const targetBranch = "plan/recreate-safe-head";
    const targetRefPath = path.join(root, ".git", "refs", "heads", ...targetBranch.split("/"));
    const replacement = "Replacement lock after fictional target removal.\n";
    let finishReplacement = (): void => undefined;
    let failReplacement = (_error: unknown): void => undefined;
    const replacementFinished = new Promise<void>((resolve, reject) => {
      finishReplacement = resolve;
      failReplacement = reject;
    });
    const replacementTimer = setTimeout(
      () => failReplacement(new Error("the HEAD switch did not trigger target removal")),
      2_000,
    );
    let replaced = false;
    const watcher = watch(path.join(root, ".git"), (_event, name) => {
      if (String(name) !== "HEAD" || replaced) return;
      replaced = true;
      try {
        unlinkSync(targetRefPath);
        unlinkSync(indexLockPath);
        writeFileSync(indexLockPath, replacement);
        finishReplacement();
      } catch (error) {
        failReplacement(error);
      }
    });

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Recreate a resolvable fictional branch",
        branch: targetBranch,
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/commit installation and rollback failed/);
      await replacementFinished;

      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(await git(root, "rev-parse", "HEAD")).toBe(originalHead);
      await expect(git(root, "rev-parse", `refs/heads/${targetBranch}`)).rejects.toThrow();
      expect(await git(root, "rev-parse", "refs/heads/main")).toBe(originalHead);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
      expect(await readFile(indexLockPath, "utf8")).toBe(replacement);
    } finally {
      clearTimeout(replacementTimer);
      watcher.close();
      await unlink(indexLockPath).catch(() => undefined);
    }
  });

  it("detaches HEAD without overwriting a concurrent non-commit target ref", async () => {
    const { root, runtime } = await changedRuntime();
    const blobSourcePath = path.join(root, "fictional-blob-source.txt");
    await writeFile(blobSourcePath, "Concurrent fictional blob value.\n");
    const blobOid = await git(root, "hash-object", "-w", "--", blobSourcePath);
    await unlink(blobSourcePath);
    const preview = await gitStatus(runtime);
    const originalHead = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const indexLockPath = path.join(root, ".git", "index.lock");
    const sourceRefPath = path.join(root, ".git", "refs", "heads", "main");
    const targetBranch = "plan/detach-safe-head";
    const targetRefPath = path.join(root, ".git", "refs", "heads", ...targetBranch.split("/"));
    const replacement = "Replacement lock beside concurrent fictional blob ref.\n";
    let finishReplacement = (): void => undefined;
    let failReplacement = (_error: unknown): void => undefined;
    const replacementFinished = new Promise<void>((resolve, reject) => {
      finishReplacement = resolve;
      failReplacement = reject;
    });
    const replacementTimer = setTimeout(
      () => failReplacement(new Error("the HEAD switch did not trigger invalid-ref recovery")),
      2_000,
    );
    let replaced = false;
    const watcher = watch(path.join(root, ".git"), (_event, name) => {
      if (String(name) !== "HEAD" || replaced) return;
      replaced = true;
      try {
        unlinkSync(sourceRefPath);
        writeFileSync(targetRefPath, `${blobOid}\n`);
        unlinkSync(indexLockPath);
        writeFileSync(indexLockPath, replacement);
        finishReplacement();
      } catch (error) {
        failReplacement(error);
      }
    });

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Detach to a resolvable fictional commit",
        branch: targetBranch,
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/commit installation and rollback failed/);
      await replacementFinished;

      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      const recoveredHead = await git(root, "rev-parse", "HEAD");
      expect(recoveredHead).not.toBe(originalHead);
      expect(await git(root, "cat-file", "-t", recoveredHead)).toBe("commit");
      expect(await git(root, "rev-parse", `refs/heads/${targetBranch}`)).toBe(blobOid);
      await expect(git(root, "rev-parse", `refs/heads/${targetBranch}^{commit}`)).rejects.toThrow();
      await expect(git(root, "rev-parse", "--verify", "refs/heads/main")).rejects.toThrow();
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
      expect(await readFile(indexLockPath, "utf8")).toBe(replacement);
    } finally {
      clearTimeout(replacementTimer);
      watcher.close();
      await unlink(indexLockPath).catch(() => undefined);
    }
  });

  it("recreates an existing branch at the accepted commit when rollback finds it missing", async () => {
    const { root, runtime } = await changedRuntime();
    const branch = "fictional-work";
    await git(root, "checkout", "-b", branch);
    const preview = await gitStatus(runtime);
    const acceptedHead = await git(root, "rev-parse", "HEAD");
    const indexBefore = await readFile(path.join(root, ".git", "index"));
    const indexLockPath = path.join(root, ".git", "index.lock");
    const branchRefPath = path.join(root, ".git", "refs", "heads", branch);
    const replacement = "Replacement lock after fictional existing branch removal.\n";
    let finishReplacement = (): void => undefined;
    let failReplacement = (_error: unknown): void => undefined;
    const replacementFinished = new Promise<void>((resolve, reject) => {
      finishReplacement = resolve;
      failReplacement = reject;
    });
    const replacementTimer = setTimeout(
      () => failReplacement(new Error("the existing branch update did not trigger removal")),
      2_000,
    );
    let replaced = false;
    const watcher = watch(path.dirname(branchRefPath), (_event, name) => {
      if (String(name) !== branch || replaced) return;
      replaced = true;
      try {
        unlinkSync(branchRefPath);
        unlinkSync(indexLockPath);
        writeFileSync(indexLockPath, replacement);
        finishReplacement();
      } catch (error) {
        failReplacement(error);
      }
    });

    try {
      await expect(commitPlanningChangesWithPreview(runtime, {
        message: "Recover a resolvable fictional existing branch",
        expectedCommitPreviewToken: preview.commitPreviewToken,
      })).rejects.toThrow(/commit installation and rollback failed/);
      await replacementFinished;

      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      expect(await git(root, "rev-parse", "HEAD")).toBe(acceptedHead);
      expect(await git(root, "rev-parse", `refs/heads/${branch}`)).toBe(acceptedHead);
      expect(await readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
      expect(await readFile(indexLockPath, "utf8")).toBe(replacement);
    } finally {
      clearTimeout(replacementTimer);
      watcher.close();
      await unlink(indexLockPath).catch(() => undefined);
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
    await expect(gitStatus(runtime)).resolves.toMatchObject({ commitEnabled: false });
    await expect(
      commitPlanningChanges(runtime, {
        message: "Update fictional plan",
        branch: "plan/disabled",
      }),
    ).rejects.toThrow(/disabled/);
  });
});
