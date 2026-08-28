# Moon Garden launch plan

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
| `MGA-001` | P0 | Complete; field notes pending | None | `moon-garden-api` | Publish a stable catalogue of lunar plants. |
| `MGA-002` | P1 | Ready | `MGA-001` | `moon-garden-ui` | Let visitors filter plants by light level. |
| `MGA-003` | P1 | In progress | `MGA-001@copy-approved` | `moon-garden-ui` | Explain each plant's care cycle in plain language. |

## Stories

### MGA-S01 - Visitors find a suitable lunar plant

- **Kind:** story
- **Role:** first-time gardener
- **Outcome:** I can narrow the catalogue to plants that fit my habitat
- **So that:** I choose something I can keep healthy
- **Demo:** Select a light level and see only matching plants.
- **Delivered by:** `MGA-001`, `MGA-002`, `MGA-003`

## Task details

### MGA-001 - Publish the plant catalogue

- **Scope:** Define the seed catalogue and its public fields.
- **Acceptance criteria:** Every entry has a unique name and a light range.
- **Evidence:** A local validation run accepts the catalogue.

### MGA-002 - Add catalogue filters

- **Scope:** Add a keyboard-operable light-level filter.
- **Acceptance criteria:** Clearing the filter restores the full catalogue.
- **Note (2026-08-20):** The empty-state wording still needs a final review.

### MGA-003 - Write care guidance

- **Scope:** Add concise guidance without changing catalogue identifiers.
- **Acceptance criteria:** Guidance remains readable at narrow widths.
