import { chmod, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDirectory = path.join(root, "bin");
const outfile = path.join(outputDirectory, "planops-board.js");
const shebang = "#!/usr/bin/env node";

await rm(outputDirectory, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "cli", "planops-board.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  logLevel: "warning",
});
await chmod(outfile, 0o755);

const lines = (await readFile(outfile, "utf8")).split("\n");
if (lines[0] !== shebang) {
  throw new Error(`the packaged CLI must start with ${shebang}`);
}
if (lines.filter((line) => line.startsWith("#!")).length !== 1) {
  throw new Error("the packaged CLI must contain exactly one shebang line");
}
process.stdout.write(`Built ${path.relative(root, outfile)}\n`);
