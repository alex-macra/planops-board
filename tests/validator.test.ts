import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  StructuralValidationError,
  validateBoardRuntime,
} from "../server/ledger/validate.ts";
import { loadBoardRuntime } from "../server/runtime.ts";
import { disposableDemo, removeDisposableDemo } from "./fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeDisposableDemo));
});

async function runtimeWithReplacement(before: string, after: string) {
  const root = await disposableDemo();
  roots.push(root);
  const file = path.join(root, "plans", "moon-garden.md");
  const original = await readFile(file, "utf8");
  expect(original).toContain(before);
  await writeFile(file, original.replace(before, after));
  return loadBoardRuntime({ repo: root });
}

describe("bundled validator", () => {
  it("rejects duplicate task IDs", async () => {
    const runtime = await runtimeWithReplacement("MGA-003", "MGA-002");
    await expect(validateBoardRuntime(runtime)).rejects.toBeInstanceOf(StructuralValidationError);
  });

  it("rejects a status outside the document vocabulary", async () => {
    const runtime = await runtimeWithReplacement("| P1 | Ready |", "| P1 | Vanished |");
    await expect(validateBoardRuntime(runtime)).rejects.toMatchObject({
      details: expect.arrayContaining([expect.stringContaining("Vanished")]),
    });
  });

  it("rejects a priority outside configured order", async () => {
    const runtime = await runtimeWithReplacement("| P1 | In progress |", "| PX | In progress |");
    await expect(validateBoardRuntime(runtime)).rejects.toMatchObject({
      details: expect.arrayContaining([expect.stringContaining("PX")]),
    });
  });
});
