# Option B — Portfolio lens

Projects anchor navigation across Now, Roadmap, Rollup, Board, Backlog, and Dependencies. The explorer shows task and readiness counts; each project menu opens its Roadmap, Board, or Dependencies.

The September 14 refinement makes task actions consistent across views, explains paused filters, and opens the dependency graph without a reader covering it. This remains candidate B in [draft PR #5](https://github.com/alex-macra/planops-board/pull/5).

## Walkthrough

1. Select a project in the explorer. Its full scope opens; text, epic, status, and other task filters from the previous project are cleared. Browser Back restores the previous scope and filters.
2. Switch views using the tabs or title actions. Task filters stay in the URL. Now, Roadmap, and Rollup show a **Task filters are paused** notice, with removable chips, **View filtered tasks**, and **Clear task filters**.
3. Open a task's **…** menu in Now, Backlog, or Board. The same actions open details, show dependencies, or find the task in Backlog. Board also retains its guarded status moves.
4. Choose **Show dependencies**. The graph opens with the task highlighted and its selection in `#view=graph&focus=MGA-002`. Selecting another node updates the highlight. **Open task details** opens the reader; closing it returns to the graph selection.
5. Use the selected graph task's menu to **Find in backlog**. An unrelated project scope is cleared so the destination task remains visible. A selected task with no edges still appears in the graph.
6. On mobile, open a card menu near the screen edge. The menu flips or shifts into the viewport; arrow keys navigate, Escape returns focus, and Tab continues past the trigger.

The project explorer becomes a horizontal strip on narrow screens. Menus and readers share the portfolio theme in light and dark mode.

## Artifacts

- Six views: [Now](now.png) · [Roadmap](roadmap.png) · [Rollup](rollup.png) · [Board](board.png) · [Backlog](backlog.png) · [Dependencies](dependencies.png)
- Task actions: [Now menu](now-menu.png) · [Board menu](board-menu.png) · [Backlog menu](backlog-menu.png) · [Dark menu](dark-menu.png)
- Transitions: [Paused filters](paused-filters.png) · [Backlog from a card](backlog-from-card.png) · [Task reader](task-detail.png) · [Focused graph](dependencies-focused.png)
- Mobile: [Now at 390px](mobile-now.png) · [Board menu at 320px](mobile-menu.png)
- [Browser verification](verification.json) · [Accessibility scans](accessibility.json)

## Validation

- `npm run verify`: typecheck, 631 tests, 53 parity tests, production build, public boundary, and dependency licenses passed.
- `BOARD_E2E_PORT=5199 npm run test:e2e -- --project=chromium`: 20 passed, including guarded edit/undo/commit, reader focus, all six views, new navigation journeys, and mobile menu bounds.
- All 16 review captures passed WCAG-tagged axe scans, with no browser errors or API mutations. Captures use the disposable fictional demo; the JSON files record states and mobile menu bounds.

## Worktrees and preview

Candidate B lives in `tooling/planops-board-ux-portfolio` on `ux/portfolio-lens`. A remains in `tooling/planops-board-ux-focus`; C remains in `tooling/planops-board-ux-command`. The local comparison gallery is `tooling/planops-board-ux-review/index.html`.

From the B worktree, run `BOARD_E2E_PORT=5199 node --import tsx e2e/serve.ts`, then open `http://127.0.0.1:5199`. This creates a disposable demo repository and removes it when the server is stopped.

Tradeoff: a long project list needs more space and navigation attention than a task-first flow. The project explorer remains the next area to assess against a larger portfolio.
