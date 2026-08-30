import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env["BOARD_E2E_PORT"] ?? "5175");
if (!Number.isSafeInteger(e2ePort) || e2ePort < 1024 || e2ePort > 65_535) {
  throw new Error("BOARD_E2E_PORT must be a valid unprivileged TCP port");
}
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["GITHUB_ACTIONS"] === "true"
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : process.env["CI"]
      ? [["list"], ["html", { open: "never" }]]
      : [["list"]],
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node --import tsx e2e/serve.ts",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: { BOARD_E2E_PORT: String(e2ePort) },
  },
});
