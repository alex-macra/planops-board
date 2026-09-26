import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  lockInstallScriptNames,
  packageNameFromLocation,
  reviewInstalledInstallScripts,
  type PackageLockFile,
} from "../scripts/dependency-install-scripts.ts";

const root = path.resolve(import.meta.dirname, "..");

const candidateLock: PackageLockFile = {
  packages: {
    "": { version: "0.1.0" },
    "node_modules/lantern-native": { version: "1.2.0", hasInstallScript: true },
    "node_modules/@orchard/kiln": { version: "3.0.0", hasInstallScript: true },
    "node_modules/quiet-helper": { version: "2.0.0" },
    "node_modules/fsevents": { version: "2.3.2", hasInstallScript: true, os: ["darwin"] },
    "node_modules/tool/node_modules/fsevents": { version: "2.3.3", hasInstallScript: true, os: ["darwin"] },
  },
};

describe("dependency install scripts", () => {
  test("a resolved version newer than the lock is allowed by name and marked as differing", () => {
    const review = reviewInstalledInstallScripts(
      candidateLock,
      { packages: { "node_modules/lantern-native": { version: "1.3.1", hasInstallScript: true } } },
      "linux",
    );

    expect(review.entries).toEqual([
      { name: "lantern-native", version: "1.3.1", lockVersions: ["1.2.0"], differsFromLock: true },
    ]);
    expect(review.outside).toEqual([]);
  });

  test("an equal resolved version is marked as matching the lock", () => {
    const review = reviewInstalledInstallScripts(
      candidateLock,
      { packages: { "node_modules/@orchard/kiln": { version: "3.0.0", hasInstallScript: true } } },
      "linux",
    );

    expect(review.entries).toEqual([
      { name: "@orchard/kiln", version: "3.0.0", lockVersions: ["3.0.0"], differsFromLock: false },
    ]);
    expect(review.outside).toEqual([]);
  });

  test("an installed install-script package outside the lock name set is reported as outside", () => {
    const review = reviewInstalledInstallScripts(
      candidateLock,
      {
        packages: {
          "node_modules/lantern-native": { version: "1.2.0", hasInstallScript: true },
          "node_modules/quiet-helper": { version: "2.1.0", hasInstallScript: true },
          "node_modules/stray-binary": { version: "0.4.0", hasInstallScript: true },
        },
      },
      "linux",
    );

    expect(review.outside).toEqual(["quiet-helper@2.1.0", "stray-binary@0.4.0"]);
    expect(review.entries.find((entry) => entry.name === "stray-binary")).toEqual({
      name: "stray-binary",
      version: "0.4.0",
      lockVersions: [],
      differsFromLock: true,
    });
  });

  test("an aliased install-script package is judged by its real name, not its install location", () => {
    const review = reviewInstalledInstallScripts(
      candidateLock,
      {
        packages: {
          "node_modules/tool/node_modules/lantern-native": {
            name: "impostor-native",
            version: "9.9.9",
            hasInstallScript: true,
          },
          "node_modules/kiln-alias": { name: "@orchard/kiln", version: "3.0.0", hasInstallScript: true },
        },
      },
      "linux",
    );

    expect(review.entries).toEqual([
      { name: "@orchard/kiln", version: "3.0.0", lockVersions: ["3.0.0"], differsFromLock: false },
      { name: "impostor-native", version: "9.9.9", lockVersions: [], differsFromLock: true },
    ]);
    expect(review.outside).toEqual(["impostor-native@9.9.9"]);
  });

  test("a darwin-only entry is excluded on linux and included on darwin", () => {
    expect([...lockInstallScriptNames(candidateLock, "linux").keys()]).toEqual(["@orchard/kiln", "lantern-native"]);
    expect(lockInstallScriptNames(candidateLock, "darwin").get("fsevents")).toEqual(["2.3.2", "2.3.3"]);

    const negated: PackageLockFile = {
      packages: { "node_modules/watcher": { version: "1.0.0", hasInstallScript: true, os: ["!linux"] } },
    };
    expect(lockInstallScriptNames(negated, "linux").has("watcher")).toBe(false);
    expect(lockInstallScriptNames(negated, "darwin").has("watcher")).toBe(true);

    const review = reviewInstalledInstallScripts(
      candidateLock,
      { packages: { "node_modules/fsevents": { version: "2.3.2", hasInstallScript: true } } },
      "linux",
    );
    expect(review.outside).toEqual(["fsevents@2.3.2"]);
  });

  test("a nested scoped location resolves to the scoped package name", () => {
    expect(packageNameFromLocation("node_modules/a/node_modules/@scope/b")).toBe("@scope/b");
    expect(packageNameFromLocation("")).toBeUndefined();

    const lock: PackageLockFile = {
      packages: { "node_modules/a/node_modules/@scope/b": { version: "1.0.0", hasInstallScript: true } },
    };
    expect([...lockInstallScriptNames(lock, "linux")]).toEqual([["@scope/b", ["1.0.0"]]]);
  });

  test("the candidate package-lock.json on linux yields exactly @swc/core and esbuild", async () => {
    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as PackageLockFile;

    expect([...lockInstallScriptNames(lock, "linux").keys()]).toEqual(["@swc/core", "esbuild"]);
  });
});
