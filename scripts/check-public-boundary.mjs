import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

if (process.argv.length > 3) {
  throw new Error("usage: node scripts/check-public-boundary.mjs [root]");
}
const root = path.resolve(process.argv[2] ?? process.cwd());
const ignoredDirectories = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const ignoredRootDirectories = new Set([".npm"]);
const binaryExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
]);
const forbidden = [
  { label: "private key", pattern: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/ },
  { label: "AWS access key", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}\b/ },
  {
    label: "GitHub stateless installation token",
    pattern: /\bghs_[0-9]+_[A-Za-z0-9._-]{20,}\b/,
  },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  {
    label: "GitLab token",
    pattern:
      /\b(?:glagent|glcbt|gldt|glffct|glft|glimt|gloas|glpat|glptt|glrt|glrtr|glsoat|glwt)-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "GitLab session cookie",
    pattern: /\b_gitlab_session=[^;\s]{20,}/,
  },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: "Stripe live credential", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/ },
  { label: "service API token", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { label: "npm authentication config", pattern: /(?:^|\n)\s*(?:_authToken|NODE_AUTH_TOKEN)\s*=/ },
  { label: "private package registry", pattern: /npm\.pkg\.github\.com/i },
  { label: "Unix home path", pattern: /(?:^|[\s"'`(])\/(?:home|Users)\/[^\s"'`)]+/ },
  { label: "Windows home path", pattern: /\b[A-Za-z]:\\Users\\[^\s"']+/ },
  { label: "file URI", pattern: /\bfile:\/\//i },
];

function forbiddenPath(file) {
  const name = path.basename(file);
  if (name === ".npmrc") return "npm configuration file";
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return "local environment file";
  }
  return null;
}

async function filesIn(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      ignoredDirectories.has(entry.name) ||
      (directory === root && ignoredRootDirectories.has(entry.name))
    ) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`public source contains a symbolic link: ${relative}`);
    }
    if (entry.isDirectory()) await filesIn(absolute, files);
    else if (entry.isFile() && !binaryExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(relative);
    }
  }
  return files;
}

const findings = [];
for (const file of await filesIn(root)) {
  const pathFinding = forbiddenPath(file);
  if (pathFinding) findings.push(`${file}: ${pathFinding}`);
  const text = await readFile(path.join(root, file), "utf8");
  for (const check of forbidden) {
    if (check.pattern.test(text)) findings.push(`${file}: ${check.label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Public boundary check failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Public boundary check passed.\n");
}
