import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanner = path.join(repositoryRoot, "scripts", "check-public-boundary.mjs");
const fixtures: string[] = [];

function scan(contents: string): { readonly ok: boolean; readonly output: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "planops-public-boundary-"));
  fixtures.push(root);
  writeFileSync(path.join(root, "fixture.txt"), contents, "utf8");
  const result = spawnSync(process.execPath, [scanner, root], { encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`,
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("public boundary secret patterns", () => {
  it("accepts ordinary public text", () => {
    expect(scan("Fictional PlanOps Board fixture\n")).toMatchObject({
      ok: true,
      output: "Public boundary check passed.\n",
    });
  });

  it.each([
    "glagent",
    "glcbt",
    "gldt",
    "glffct",
    "glft",
    "glimt",
    "gloas",
    "glpat",
    "glptt",
    "glrt",
    "glrtr",
    "glsoat",
    "glwt",
  ])("detects GitLab %s tokens", (prefix) => {
    const token = [prefix, "-", "A1b2C3d4E5f6G7h8I9j0"].join("");
    const result = scan(token);
    expect(result).toMatchObject({ ok: false });
    expect(result.output).toContain("GitLab token");
  });

  it("detects GitHub fine-grained access tokens", () => {
    const token = ["github", "_pat_", "11AA22bb33CC44dd55EE66ff77GG88hh"].join("");
    const result = scan(token);
    expect(result).toMatchObject({ ok: false });
    expect(result.output).toContain("GitHub fine-grained token");
  });

  it("detects GitHub stateless installation tokens", () => {
    const token = ["gh", "s_123456_", "eyJhbGciOiJSUzI1NiJ9.payload.signature"].join("");
    const result = scan(token);
    expect(result).toMatchObject({ ok: false });
    expect(result.output).toContain("GitHub stateless installation token");
  });

  it("detects GitLab session cookies", () => {
    const cookie = ["_gitlab", "_session=", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("");
    const result = scan(JSON.stringify({ cookie }));
    expect(result).toMatchObject({ ok: false });
    expect(result.output).toContain("GitLab session cookie");
  });

  it("detects Stripe live credentials", () => {
    const token = ["sk", "_live_", "1234567890abcdefghijklmnopqrstuv"].join("");
    const result = scan(token);
    expect(result).toMatchObject({ ok: false });
    expect(result.output).toContain("Stripe live credential");
  });
});
