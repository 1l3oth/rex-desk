---
name: Rex Desk
description: A dense, dark-first developer workspace for watching and steering several agent runs side by side.
colors:
  bg: "#f6f8fa"
  panel: "#ffffff"
  raised: "#f6f8fa"
  sunken: "#f6f8fa"
  line: "#d0d7de"
  line-soft: "#e3e8ed"
  ink: "#1f2328"
  muted: "#59636e"
  faint: "#6e7781"
  accent: "#0969da"
  accent-ink: "#ffffff"
  accent-soft: "#ddf4ff"
  amber: "#9a6700"
  amber-soft: "#fff8c5"
  amber-line: "#e3c45a"
  green: "#1a7f37"
  green-soft: "#dafbe1"
  red: "#cf222e"
  red-soft: "#ffebe9"
  violet: "#8250df"
  violet-soft: "#fbefff"
  hover: "#eef1f4"
  selected: "#ddf4ff"
  control-hover: "#afb8c1"
  status-bg: "#0969da"
  status-ink: "#ffffff"
  status-need: "#fff8c5"
  selection: "#b6e3ff"
  bg-dark: "#16181d"
  panel-dark: "#1c1f25"
  raised-dark: "#23272e"
  sunken-dark: "#121418"
  line-dark: "#2c313a"
  line-soft-dark: "#252931"
  ink-dark: "#e6e8eb"
  muted-dark: "#9aa3b1"
  faint-dark: "#7d8592"
  accent-dark: "#4c8dff"
  accent-soft-dark: "rgba(76,141,255,.15)"
  amber-dark: "#e5a100"
  amber-soft-dark: "rgba(229,161,0,.12)"
  amber-line-dark: "rgba(229,161,0,.45)"
  green-dark: "#3fb950"
  green-soft-dark: "rgba(63,185,80,.13)"
  red-dark: "#f85149"
  red-soft-dark: "rgba(248,81,73,.13)"
  violet-dark: "#b392f0"
  violet-soft-dark: "rgba(179,146,240,.14)"
  hover-dark: "#252a32"
  selected-dark: "#1f2b3d"
  control-hover-dark: "#4a5260"
  status-bg-dark: "#1b3260"
  status-ink-dark: "#dbe7ff"
  status-need-dark: "#ffd166"
  selection-dark: "#2b4c7e"
typography:
  title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Malgun Gothic, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  headline:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Malgun Gothic, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Malgun Gothic, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  meta:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Malgun Gothic, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, Malgun Gothic, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.06em"
  mono:
    fontFamily: "Cascadia Code, Cascadia Mono, Consolas, SFMono-Regular, Malgun Gothic, monospace"
    fontSize: "11px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "5px"
  md: "6px"
  lg: "8px"
  dialog: "10px"
  pill: "9px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  row: "10px"
  gutter: "12px"
  lg: "16px"
  page: "20px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
  button-small:
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "24px"
  input:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
    height: "28px"
  segmented-switch:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-switch-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xs}"
    height: "20px"
  tag:
    backgroundColor: "{colors.line-soft}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "18px"
  tag-working:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  tag-waiting:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
  tag-done:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
  tag-failed:
    backgroundColor: "{colors.red-soft}"
    textColor: "{colors.red}"
  activity-bar:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.faint}"
    width: "48px"
  sidebar:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    width: "300px"
  issue-row:
    backgroundColor: "transparent"
    typography: "{typography.body}"
    padding: "0 12px 0 10px"
    height: "30px"
  issue-row-selected:
    backgroundColor: "{colors.selected}"
  run-tab:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.muted}"
    height: "34px"
  run-tab-active:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
  pane-head:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.muted}"
    typography: "{typography.headline}"
    padding: "0 6px 0 12px"
    height: "34px"
  tool-call:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "24px"
  decision-approval:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.ink}"
    rounded: "7px"
    padding: "10px 12px"
  status-bar:
    backgroundColor: "{colors.status-bg}"
    textColor: "{colors.status-ink}"
    typography: "{typography.meta}"
    padding: "0 10px"
    height: "22px"
---

# Design System: Rex Desk

## Overview

**Creative North Star: "The Conductor's Console"**

Rex Desk is an editor-shaped workspace, not a page-per-thing admin dashboard. One developer conducts many agents, so every live run can sit on screen at once: a 48px activity bar, a contextual 300px sidebar, a main area of side-by-side run panes, and a 22px status bar. It is the developer-tool category standard played straight, at the craft level of GitHub dark and Raycast: near-black shell, one-step-lighter panels, 1px hairlines, one blue accent, and state colors that mean exactly one thing each.

Density is the point. Body type is 12px, metadata 11px, rows are 30px, and controls are 24 to 28px tall. Depth comes from tonal steps and hairlines, never from cards floating on shadows. Dark is the first-class theme (the document `theme-color` is the dark shell); light mirrors it token for token, following the system preference unless the person chooses. Components read tokens and never branch on theme.

The previous "QA Acceptance Sheet" world (petrol rail, spacious 14px layout) is retired; nothing from it carries forward.

**Key Characteristics:**
- Four-zone shell: activity bar, contextual sidebar, main, status bar.
- Several runs visible at once in Single, Split or Grid pane layouts.
- 12px body, 11px metadata, system UI sans with Cascadia/Consolas mono for machine text.
- Tonal layering plus 1px hairlines; shadows only for floating overlays.
- One blue accent; amber reserved for whatever waits on the person.

## Colors

A cool neutral ramp (GitHub-family grays) carrying one blue accent and three outcome colors, each with a soft tint for fills.

### Primary
- **Signal Blue** (`accent`, dark `accent-dark`): the only interactive accent. Primary buttons, focus outlines and input focus borders, the active indicator bar in the activity bar, the 2px top inset on the active run tab and focused pane, selected row left borders, links, and the working state (running/starting tags and the live dot). Its tint (`accent-soft`) fills working tags, input focus rings and the run status strip.

### Secondary
- **Waiting Amber** (`amber`, `amber-soft`, `amber-line`): anything blocked on the person. Needs-you counts in the activity bar, waiting/queued tags, approval decisions, the 2px top inset on a pane that needs you, the active item border in the Needs you list, pending tool calls, notices and setup callouts. In the status bar it appears as `status-need`.

### Tertiary
- **Outcome Green** (`green`, `green-soft`): done. Ready-for-review, published and finished tags and dots, completed tool calls, passing checks, completed setup steps.
- **Failure Red** (`red`, `red-soft`): failed or interrupted runs, failed tool calls, danger buttons, error text, error toasts, high-priority marks.
- **Source Violet** (`violet`, `violet-soft`): identity color for one tracker source logo only. Not a state.

### Neutral
- **Shell** (`bg` / `bg-dark` #16181d): app background, activity bar, run tab strip, page canvas.
- **Panel** (`panel` / `panel-dark`): sidebar, panes, detail pane, dialogs, cards. One step lighter than the shell in dark.
- **Raised** (`raised` / `raised-dark`): default button fill, issue preview, proof column, decisions, popover lists, toasts.
- **Sunken** (`sunken` / `sunken-dark`): inputs, segmented switch tracks, code blocks, tool-call rows.
- **Hairline** (`line`) and **Soft Hairline** (`line-soft`): structural borders vs. row and section dividers. The pane grid gap is the `line` color showing through a 1px gap.
- **Ink / Muted / Faint** (`ink`, `muted`, `faint`): primary text, secondary text, metadata and idle icons.
- **Hover / Selected / Control Hover**: row hover fill, selected row fill, control border on hover.
- **Status bar** (`status-bg`, `status-ink`): saturated blue band in light, deep navy (#1b3260) in dark.

### Named Rules
**The Amber Is Owed Rule.** Amber means "waiting on you" and nothing else. Never use it for decoration, warnings about the system, or emphasis.

**The One Meaning Rule.** Blue is working or interactive, green is done, red is failed. A color never carries two meanings on the same screen.

**The Token Mirror Rule.** Every color is a custom property defined twice, under `:root` (light) and `html[data-theme=dark]`. Components reference tokens only.

## Typography

**Body Font:** Segoe UI Variable Text (with Segoe UI, Malgun Gothic, -apple-system, system-ui)
**Mono Font:** Cascadia Code (with Cascadia Mono, Consolas, SFMono-Regular)

**Character:** The platform's own UI face at small sizes, set with tabular numerals everywhere, so the tool feels native and numbers align in rows and progress text. Mono is used only for machine text.

### Hierarchy
- **Title** (600, 15px, 1.35): page titles and the issue detail heading. The largest text in the product.
- **Section** (600, 13 to 14px): settings sections, dialogs and empty-state headings.
- **Headline** (600, 12.5px, 1.45): pane titles (500 weight muted until focused), decision headings, issue preview title, setup steps.
- **Body** (400, 12px, 1.5): rows, buttons, inputs, transcript text (1.6 line height in markdown). Long prose caps at 80 to 90ch.
- **Meta** (400, 11px): sublines, status bar, timestamps, row secondary lines, pane subline and footer (11.5px).
- **Label** (600, 10.5 to 11px, 0.06em, uppercase): sidebar pane headings, run group headings, the proof column heading and board column headings, in the VS Code sidebar-section manner.
- **Mono** (11px): issue numbers, branches, tool names in tool-call rows, code and tool output.

### Named Rules
**The Machine Text Rule.** Mono is for IDs, branches, tool names and output only. Never set prose, labels or headings in mono.

**The Fifteen Pixel Ceiling Rule.** No text exceeds 15px. Hierarchy comes from weight and color (ink vs. muted vs. faint), not size.

## Layout

**Shell.** A CSS grid of `48px | minmax(0,1fr)` columns, or `48px | --side-size | minmax(0,1fr)` when a sidebar is present (300px by default, dragged between 220px and the width that leaves the main area 360px), over `minmax(0,1fr) | 22px` rows at full `100dvh`. Only inner regions scroll.

**Activity bar.** 48px wide, 40px-tall icon buttons (19px icons), a 22px brand mark, a flexible spacer pushing Setup and Settings to the bottom, and count badges (amber for needs-you, quiet raised for plain counts).

**Sidebar.** Contextual per view. On the Agent runs view a 38px header carries a Runs | Issues segmented switch; Runs lists grouped runs, Issues lists assigned issues as one-line 30px rows (checkbox, mono number, ellipsized title, state dots) above an issue preview panel pinned to the bottom on the raised surface.

**Agent runs workspace.** A 34px tab strip of open runs (state dot, title, close button revealed on hover or when active; active tab takes the panel color with a 2px accent top inset) with tools on the right including the Single / Split / Grid layout switch. Below it the pane grid shows 1, 2, or up to 4 panes: rows are `minmax(0,1fr)`, two panes split into equal columns, three panes use a 2x2 grid with the first pane spanning both rows, four fill the 2x2. Panes are separated by a 1px gap over the `line` color.

**Pane anatomy.** Header (34px: state, title, provider, actions), subline (26px: branch in mono and right-aligned progress text such as "3 / 5 tool calls · 12m"), body (live transcript plus a proof column), footer composer (36px reply/steer input). The pane is a size container: below 720px the proof column stacks under the transcript (max 42% height, fade mask at the bottom); at 720px and up it becomes a fixed 260px right column. Below 420px the provider label hides.

**Needs you.** A list + detail split: 320px list of decision items (amber active border) beside a detail column capped at 900px.

**Spacing rhythm.** Small steps of 2, 4, 6, 8, 10, 12, 16 and 20px. Rows and toolbars use 12px horizontal gutters; content pages use 14 to 20px; gaps between controls are 6px.

**Responsive.**
- At 1100px the default sidebar narrows to 260px; a dragged width is kept.
- At 900px multi-pane grids collapse to one column with panes at a 420px minimum height and the workspace scrolls; the Needs you split stacks list above detail.
- At 700px the shell becomes a normal flowing page: the activity bar moves to a fixed 52px bottom bar with a top accent indicator, the status bar hides, panes get 70vh minimum height, and the toast clears the bottom bar.

## Elevation & Depth

Flat and tonal. Depth is expressed by stepping between shell, panel, raised and sunken surfaces and by 1px hairlines. Active and focused states use 2px inset accent bars (`inset 0 2px 0`) or 1px ring shadows (`0 0 0 1px var(--line)`), which are borders by another name, not lift. A real drop shadow appears only on things that float above the layout.

### Shadow Vocabulary
- **Overlay** (light `0 16px 48px rgba(31,35,40,.18)`, dark `0 20px 60px rgba(0,0,0,.55)`): dialogs, picker popovers, the toast.
- **Focus ring** (`0 0 0 2px var(--accent-soft)` with an accent border): focused inputs and the composer.
- **Live pulse** (`0 0 0 4px var(--accent-soft)` animated): the running state dot only.

### Named Rules
**The Flat Panel Rule.** Panes, cards, rows and the sidebar never carry drop shadows. If it does not float, it does not cast.

## Shapes

Small, tight corners: 4px for segment buttons and inline code, 5px for small controls, tool-call rows and code blocks, 6px for buttons, inputs and notices, 7px for decisions and popovers, 8px for cards, board columns and the Needs you split, 10px for dialogs. Tags are 18px-tall pills (9px radius); state dots are 7px circles. Shell regions (activity bar, sidebar, panes, tabs, status bar) are square-cornered and meet on hairlines. Icons are 16px line icons at 1.6 stroke, round caps and joins.

## Components

### Buttons
Compact and quiet; the accent appears only on the one primary action.
- **Shape:** gently squared (6px), 28px tall, 10px horizontal padding; small is 24px, 5px radius, 11.5px text.
- **Default:** raised fill, hairline border, ink text, 500 weight.
- **Primary:** accent fill and border, white text; hover brightens 8%.
- **Quiet:** transparent with muted text; hover fills with `hover`.
- **Danger:** default button with red text.
- **Hover / Focus:** background and border transition at 120ms; focus is a 2px accent outline at 1px offset. Disabled is 45% opacity.

### Segmented switch
Used for the sidebar Runs | Issues switch, list/board view, and the pane layout switch. A sunken track with 2px padding; 20px segments in muted 11px text; the active segment takes the raised fill, ink text and a 1px hairline ring. Layout segments show a tiny drawn glyph of one, two or four boxes.

### Tags and state dots
- **Tag:** 18px pill, 10.5px 500 text, neutral `line-soft` fill by default; working tags are accent on accent-soft, waiting amber on amber-soft, done green on green-soft, failed red on red-soft.
- **State dot:** 7px circle in the same state colors; running and starting pulse with a 1.8s accent-soft halo.

### Inputs / Fields
- **Style:** sunken fill, hairline border, 6px radius, 28px minimum height, 12px text; labels 11.5px 600; help text 11px muted.
- **Focus:** accent border plus a 2px accent-soft ring, no outline.
- **Error:** 11.5px red text below the field.
- **Search field:** 24px tall with a 13px leading icon; filter selects are 24px with a drawn chevron.

### Navigation
- **Activity bar:** faint icons, ink on hover and when active; the active item carries a 2px accent bar on its left edge (top edge on mobile).
- **Run tabs:** muted text, ink when shown; active tab on the panel color with a 2px accent top inset; close button hidden until hover.
- **Tabs (issue detail):** 32px tall, 2px accent underline and 600 weight when active.

### Issue row
One line, 30px: checkbox, mono number (38px minimum), ellipsized 12px title, state dots. Hover fills `hover`; selected fills `selected` with a 2px accent left border and 500-weight title.

### Agent run pane (signature)
The pane is the product's signature: several update live side by side. Square panel surface; header title is muted until the pane is focused (accent top inset) or needs you (amber top inset, 200ms transition). The transcript shows labeled messages (10.5px faint label, muted author, right-aligned time), a safe markdown subset (escaped first, then fenced code, inline code, bold, headings rendered as bold, and bullets as "•"), and tool-call rows: 24px sunken disclosures with a status icon (green done, amber pending, red failed), the tool name in mono ink, an ellipsized argument summary and a time; expanded results are mono, capped at 220px. Status lines are centered 10.5px text between hairlines. The proof column sits on the raised surface with an uppercase label heading. The footer composer is a 26px sunken input with accent focus.

### Resizer and split panels
A 6px invisible grip sits on the sidebar's right border; hover, focus, or dragging shows a 2px accent line, and the whole page takes the col-resize cursor while dragging. It is a focusable separator: arrows move 16px (64px with Shift), Home and End jump to the limits, Enter or a double-click restores the default. The issue detail switches between one tabbed panel, two side-by-side panels, and two stacked panels with a three-button segmented switch at the right of the reference row. Each split panel has its own 32px tab strip and scrolls on its own; a tab that is shown in the other panel is faint and swaps the panels when chosen. Panels are separated by a 5px divider column that draws a 1px `line` stroke and a 3px accent stroke on hover or focus; arrows move it 5%, and each panel keeps at least 220px across or 120px stacked. Dragging a tab more than 6px shows a raised chip with its name and a dashed accent drop zone on the half (single panel) or panel (split) it would land in, labelled with the result.

### Repository commands
A sunken box headed *Runs use* lists setup, preview, and tests as a 72px label column beside mono values, each with a faint *from …* source line (Settings, a file name, or the detected Tomcat template). Overrides sit in a collapsed disclosure whose empty fields show the automatic value as placeholder text.

### Orca terminal
Orca runs show the terminal's rendered screen above the transcript in a sunken disclosure: a terminal icon, *Orca terminal*, and a right-aligned Live or Ended state; the screen is 11px mono, wraps, scrolls after 46vh, and stays pinned to the bottom unless the reader scrolls up.

### Decisions
Inline in the pane that asks: raised box, hairline border, 7px radius, 10px 12px padding. Approvals switch to amber-soft fill with an amber-line border and amber icon. The context row links back to its run in accent text.

### Status bar
22px band across the full width on `status-bg` with 11px `status-ink` text: a green local-machine dot, sync state, worker count, and the needs-you count in `status-need` at 600 weight; trailing items are pushed right.

### Overlays
Dialogs are 520px max, 10px radius, panel fill, hairline border, overlay shadow over a dimmed backdrop. Toasts sit bottom-right on the raised surface and enter with a 250ms 6px rise.

## Do's and Don'ts

### Do:
- **Do** keep body text at 12px and metadata at 11px; reach for weight and ink/muted/faint before size.
- **Do** define every new color as a token in both `:root` and `html[data-theme=dark]`.
- **Do** separate regions with 1px `line` hairlines and rows with `line-soft`.
- **Do** mark the active or focused thing with a 2px accent bar (left edge for rows and activity items, top inset for tabs and panes).
- **Do** use amber, and only amber, for anything waiting on the person: counts, approvals, the needs-you pane inset.
- **Do** set IDs, branches, tool names and output in Cascadia/Consolas mono at 11px.
- **Do** let panes and lists ellipsize single lines rather than wrap in dense rows.
- **Do** use the `cubic-bezier(.16,1,.3,1)` ease for short state transitions (120 to 250ms) and honor reduced motion, which disables all animation and transition.

### Don't:
- **Don't** put drop shadows on panes, cards, rows or the sidebar; shadows belong to dialogs, popovers and toasts only.
- **Don't** use amber for decoration or system warnings, or blue for anything that is not interactive or working.
- **Don't** set text larger than 15px or build spacious hero-style layouts; this is a dense tool.
- **Don't** set prose or headings in mono.
- **Don't** branch component styles on theme; read tokens.
- **Don't** reintroduce the retired petrol rail or the spacious 14px acceptance-sheet layout.
