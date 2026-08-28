import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const packages = Object.entries(lock.packages ?? {}).filter(([entry]) => entry.startsWith("node_modules/"));
const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "EPL-2.0",
  "Unlicense",
]);

function licenseTokens(value) {
  return value
    .replaceAll(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const failures = [];
for (const [packagePath, metadata] of packages) {
  const value = typeof metadata.license === "string" ? metadata.license : "";
  const tokens = licenseTokens(value);
  if (tokens.length === 0 || tokens.some((token) => !allowed.has(token))) {
    failures.push(`${packagePath}: ${value || "missing license"}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`Dependency license check failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Dependency license check passed for ${packages.length} packages.\n`);
}
