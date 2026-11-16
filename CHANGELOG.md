# Changelog

Notable changes to PlanOps Board. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no tagged releases yet,
so merged work is grouped by month.

## Unreleased

### Changed

- Documented task subtasks, inline Roadmap authoring, and `--allow-external-validator` in the README.

## 2026-11

### Security

- Resolved npm audit advisories for Zod, undici, fast-uri, and Puppeteer's browser protocol dependencies (#15).

## 2026-10

### Added

- Typed subtasks parsed from a task's `Subtasks` checklist, with a `subtask-malformed` data-quality issue and the agent query schema updated to match (#12).
- Inline Roadmap authoring: create stories, tasks, and subtasks, change status, and toggle subtask checkboxes through guarded writes (#13).
- Browser acceptance journey for Roadmap authoring, with accessibility scans of open forms at desktop and 320px (#14).
- Delivery summary v1 data on Now and in task details (#9).
- Server-enforced `--read-only` mode with `--tracking-ref` freshness against the last fetched revision (#9).
- Keyboard Backlog reordering and a collapsible project rail (#9).

### Fixed

- Malformed subtask lines with a wrong parent, a blank title, or only an owner are reported instead of attached (#14).
- Task controls stay visible while an inline Roadmap form is open (#14).

### Security

- Updated fast-uri and undici to clear audit advisories (#8).
- Updated vitest and @vitest/mocker (#4).

## 2026-09

### Added

- Packaged the compiled `planops-board` CLI and built UI for npm install (#7).
- Portfolio navigation: project search in the explorer, scoped Roadmap, Board, and Dependencies views, shared task menus, and a focusable dependency graph (#5).
- Accepted Qwen3.8-Flash-Next packet headings alongside the legacy heading (#6).
- Separate tracker, packet, and dispatch readiness in the task reader, and held readiness filters in Board, Backlog, and Dependencies (#7).
- Roadmap and execution readiness views (#3).
- Trust-first agent query CLI: `query startable`, `query stale`, and `query issues` (#2).

### Fixed

- Kept Now task menus and focus steady when history loads late (#7).

### Security

- Refused guarded writes through swapped planning directories (#7).

## Earlier

Older changes, including the initial release on 2026-08-28, are in the
[Git history](https://github.com/alex-macra/planops-board/commits/main).
