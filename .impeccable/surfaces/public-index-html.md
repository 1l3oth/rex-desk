---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/style.css","public/app.js"]
---

# Dashboard

Mode: Operate. Target: public/index.html, public/app.js, public/style.css.

Confirmed by the user (2026-10-24): less space and smaller type than the first build; a creative but working view; several runs and issues open at once because they do many things at a time. They chose the category standard on the decision page and named GitHub (dark) and Raycast as the products it sits alongside; that craft level is the bar. Kanban stays as a second view of issues. Claude Code is the default, with per-run switching and concurrent Codex support. Credentials and source identifiers are edited in Settings.

## Direction contract

THESIS: One developer conducting many agents needs every live run visible at once. The workspace is an editor-shaped split view of runs, not a page per run, and refuses the spacious one-thing-at-a-time admin dashboard.

OWN-WORLD: A dense dark developer tool at GitHub-dark and Raycast craft: near-black shell, one-step-lighter panels, 1px hairlines, a single blue accent, amber reserved for anything waiting on the person, green and red for outcomes. System UI type at 12px body and 11px metadata, Cascadia/Consolas only for IDs, branches, tool names and output. Light theme mirrors it.

STORY: Select issues in the sidebar, analyze, and watch the main agent and every worker side by side; approve or answer inside the pane that asks; open evidence and draft PRs from the same split view.

FIRST VIEWPORT: 48px activity bar (Workspace, Issues, Board, Needs you, Evidence, Setup, Settings with counts); 300px sidebar switching between the runs list and the issue list (filters, Analyze, focused-issue preview); main area with a tab strip of open runs and a layout switch (single, split, grid of up to four); panes each show header, branch line, live transcript, inline approvals and a reply/steer footer; 22px status bar with machine, Turso sync, workers and Needs-you count.

FORM: The category standard, played straight (canon card), sitting alongside GitHub dark and Raycast. Signature interaction: open any run into a pane and keep several updating live at once, with approvals answered in place. seed:56d6c21c30334e3c.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Verification scope

The synthetic acceptance test drives settings, source sync, list and board, questions, agent dispatch, a real Git worktree, a real regression command, and recorded browser assertions, and checks desktop and mobile overflow. No live credentials or model calls are used.
