# Signal Harbor reliability plan

## Status vocabulary

| Status | Meaning |
|---|---|
| `Ready` | The task can start when its dependencies are satisfied. |
| `In progress` | Work has started. |
| `Blocked` | Work cannot move until the stated constraint changes. |
| `Complete` | The required outcome is delivered. |

## Delivery ledger

| ID | Priority | Status | Dependencies | Repository / owner | Required outcome |
|---|---:|---|---|---|---|
| `SHB-001` | P0 | Blocked; awaiting simulator | None | `signal-harbor-worker` | Replay beacon traffic without contacting a live device. |
| `SHB-002` | P1 | Ready | `SHB-001` | `signal-harbor-web` | Show the most recent beacon health check. |
| `SHB-003` | P2 | Complete | None | harbor operations | Document the recovery drill for a missed signal. |

## Stories

### SHB-S01 - Operators can diagnose a silent beacon

- **Kind:** story
- **Role:** harbor operator
- **Outcome:** I can see why a beacon stopped reporting
- **So that:** I choose the right recovery step
- **Demo:** Replay a missed signal and open its health explanation.
- **Delivered by:** `SHB-001`, `SHB-002`, `SHB-003`

## Task details

### SHB-001 - Build a beacon simulator

- **Scope:** Reproduce successful, delayed, and missing beacon messages locally.
- **Acceptance criteria:** The simulator never opens an external connection.

### SHB-002 - Display beacon health

- **Scope:** Present the last signal time and the current explanation.
- **Acceptance criteria:** A keyboard user can reach every health detail.

### SHB-003 - Document the recovery drill

The drill starts from a fictional missed signal and ends after the operator
records the chosen recovery step.
