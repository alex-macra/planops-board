# Contributing

PlanOps Board requires Node.js 24 or newer and Git.

## Setup

```bash
npm ci
npx playwright install chromium
```

## Checks

```bash
npm run verify
npm run test:e2e -- --project=chromium
npm run test:lighthouse
npm audit --audit-level=high
```

## Test data

Examples, fixtures, tests, comments, and documentation must remain fictional.
Do not add private plans, names, task IDs, paths, credentials, or customer data.

Tests that write must copy `examples/demo-repo` to a temporary directory and
initialize that copy as a disposable Git repository. Never edit the tracked demo.

## Pull requests

Open pull requests and issues on
[GitHub](https://github.com/alex-macra/planops-board).
