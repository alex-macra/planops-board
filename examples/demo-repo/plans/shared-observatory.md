# Shared Observatory plan

## Status vocabulary

| Status | Meaning |
|---|---|
| `Ready` | The task can start when its dependencies are satisfied. |
| `In progress` | Work has started. |
| `Blocked` | Work cannot move until the stated constraint changes. |
| `Complete` | The required outcome is delivered. |
| `Exploring` | The task is intentionally outside the configured workflow. |

## Capability ledger

| ID | Priority | Status | Dependencies | Repository / owner | Required outcome |
|---|---:|---|---|---|---|
| `SOV-001` | P1 | Complete | None | `observatory-kit` | Share one timestamp format across every dashboard. |
| `SOV-002` | P1 | Ready | `SOV-001` | `moon-garden-ui`; `signal-harbor-web` | Render the same activity indicator in both products. |
| `SOV-003` | P3 | Exploring | None | observatory maintainers | Compare two approaches to offline event retention. |

## Enablers

### SOV-S01 - Shared activity language

- **Kind:** enabler
- **Outcome:** every product describes recent activity consistently
- **So that:** teams can reuse one tested interaction pattern
- **Demo:** Open both fictional products and compare their activity indicators.
- **Delivered by:** `SOV-001`, `SOV-002`

## Task details

### SOV-001 - Standardize timestamps

- **Scope:** Export one formatter with explicit locale input.
- **Acceptance criteria:** Fixed-clock tests cover recent and older activity.

### SOV-002 - Share the activity indicator

- **Scope:** Build a product-neutral component using the shared formatter.
- **Acceptance criteria:** Both owners render the component without local forks.

### SOV-003 - Explore offline retention

- **Scope:** Compare bounded memory and append-only file storage.
- **Acceptance criteria:** Record the tradeoff without selecting an approach.
