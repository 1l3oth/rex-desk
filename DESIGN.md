---
name: "Rex Desk"
description: "A compact local QA workspace with explicit decisions and reviewable evidence."
colors:
  rail: "#173c46"
  rail-text: "#e2eef0"
  ground: "#f3f6f6"
  surface: "#fff"
  ink: "#20353d"
  muted: "#5d6e75"
  line: "#dbe4e6"
  accent: "#226b79"
  accent-soft: "#e2eff0"
  amber: "#8b550b"
  amber-soft: "#fff2d8"
  red: "#a33c41"
  red-soft: "#fbe8e9"
  green: "#28704a"
  green-soft: "#e7f2eb"
  status-neutral: "#edf1f2"
  status-neutral-ink: "#50646c"
  status-working-ink: "#21606d"
  row-selected: "#edf5f6"
  row-hover: "#f3f8f8"
  row-selected-hover: "#e7f1f3"
  primary-hover: "#245663"
  navigation-hover: "#244c57"
  navigation-active: "#315b66"
  dark-rail: "#122e37"
  dark-ground: "#101b20"
  dark-surface: "#18262c"
  dark-ink: "#e1eaed"
  dark-muted: "#abbbc0"
  dark-line: "#35474f"
  dark-accent: "#91c7d1"
  dark-primary: "#9bcbd3"
  dark-primary-ink: "#11282d"
typography:
  headline:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "27px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.4
  section-title:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "19px"
    lineHeight: 1.35
    letterSpacing: "-.015em"
  body:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  issue-title:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
  metadata:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "11px"
    lineHeight: 1.5
  state-label:
    fontFamily: "\"Segoe UI Variable\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "10px"
    lineHeight: 1.5
  code:
    fontFamily: "Consolas,\"SFMono-Regular\",monospace"
    fontSize: "12px"
    lineHeight: 1.5
rounded:
  tag: "4px"
  field: "5px"
  control: "6px"
  column: "7px"
  surface: "8px"
  dialog: "10px"
spacing:
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "16": "16px"
  "18": "18px"
  "20": "20px"
  "22": "22px"
  "23": "23px"
  "24": "24px"
  "30": "30px"
  "36": "36px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-small:
    rounded: "{rounded.control}"
    padding: "4px 8px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "9px 10px"
  navigation-active:
    backgroundColor: "{colors.navigation-active}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  tag:
    backgroundColor: "{colors.status-neutral}"
    textColor: "{colors.status-neutral-ink}"
    rounded: "{rounded.tag}"
    padding: "2px 7px"
  tag-working:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.status-working-ink}"
  tag-attention:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
  tag-review:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
  tag-failure:
    backgroundColor: "{colors.red-soft}"
    textColor: "{colors.red}"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
    padding: "22px"
  issue-row-selected:
    backgroundColor: "{colors.row-selected}"
    padding: "17px 17px 16px"
  decision:
    backgroundColor: "#fbfdfd"
    rounded: "{rounded.surface}"
    padding: "18px"
  tab-active:
    textColor: "{colors.accent}"
    padding: "13px 0 11px"
  setup-step:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
    padding: "16px 20px"
  setup-step-done-mark:
    backgroundColor: "{colors.green-soft}"
    textColor: "{colors.green}"
    size: "28px"
  setup-progress:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.tag}"
    height: "6px"
    width: "96px"
  picker-list:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "4px"
  picker-option-active:
    backgroundColor: "{colors.row-selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.tag}"
    padding: "7px 9px"
  issue-image-tile:
    rounded: "{rounded.control}"
  callout:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.amber}"
    rounded: "{rounded.control}"
    padding: "11px 13px"
---

# Design System: Rex Desk

## Overview

**Creative North Star: "The QA Acceptance Sheet"**

Rex Desk uses a familiar application shell to keep issues, human decisions, and verification evidence readable in one working space. Deep petrol navigation anchors a pale blue-gray ground; white work areas carry compact rows, restrained headings, and explicit state labels.

The visual language is code-led and utilitarian. Borders and small tonal shifts separate information, while semantic colors identify work, attention, review, and failure. Monospace is reserved for identifiers and technical evidence; application headings use the same workhorse sans family as the controls.

**Key Characteristics:**
- Compact rows with a clear issue-title and metadata hierarchy.
- Flat white work surfaces on a cool working ground.
- Separately labeled tracker and agent states.
- Decisions retain their originating issue and run.
- Evidence is presented with its verification checklist.
- Setup is a live checklist of real settings, not a one-time wizard.
- Light and dark themes share one token set; the browser remembers the choice.

## Colors

The palette is cool, restrained, and functional. The frontmatter records the implementation's reusable color values; contextual button and row state colors remain separate from semantic status colors.

### Primary

- **Deep Petrol (`rail`)** anchors navigation and primary actions; pale rail text keeps the navigation distinct from the work area.
- **Working Teal (`accent`)** marks links, active tabs, caret color, checkbox accents, and keyboard focus. Its soft companion supports working-state tags.

### Secondary

- **Attention Amber (`amber`, `amber-soft`)** identifies queued work, requests awaiting a person, missing evidence, and notices.
- **Review Green (`green`, `green-soft`)** identifies ready-for-review, PR-created, and finished agent tags and passing checks. The text label determines the specific meaning.
- **Failure Red (`red`, `red-soft`)** identifies failed and interrupted tags and error text.

### Neutral

- **Cool Ground (`ground`)** surrounds the white work surfaces (`surface`).
- **Blue Charcoal (`ink`)** carries primary text; **Slate (`muted`)** carries supporting metadata.
- **Cool Divider (`line`)** separates panes, rows, tabs, and form sections.
- **Neutral Status (`status-neutral`, `status-neutral-ink`)** is the fallback tag treatment, including unmapped tracker values and agent states without a semantic override.
- Selected, hover, and selected-hover rows each have their own pale tone. Navigation uses separate petrol hover and persistent active fills.

**The State Pair Rule.** Keep tracker status and local agent state separately labeled wherever both are shown. A finished agent is not a resolved tracker issue.

Source-service identity uses the implemented Morningmate violet and Flow blue letter marks. Those source marks are identifiers, not additional application action colors.

### Dark theme

`html[data-theme=dark]` redefines every custom property; components never branch on theme. The ground deepens to petrol-black (`dark-ground`), work surfaces lift one step (`dark-surface`), and text, lines, and accents lighten (`dark-ink`, `dark-muted`, `dark-line`, `dark-accent`). Primary actions invert to a pale petrol fill with dark ink (`dark-primary`, `dark-primary-ink`). Semantic tints keep their meaning with darker soft fills and lighter text. `theme.js` resolves *Follow system*, *Light*, or *Dark* before first paint and stores the preference per browser. Browser chrome follows through `color-scheme`, the select arrow token (`--select-arrow`), selection, caret, and scrollbars.

## Typography

**Body and heading font:** the implementation's Segoe UI Variable / Segoe UI system sans stack, recorded in the frontmatter. **Technical font:** the Consolas / SFMono-Regular monospace stack.

The hierarchy is compact rather than promotional. No separate display role is established. Normal control text inherits the body font; headings and issue titles add weight without changing families.

- **Headline:** page heading; contracts to 24px at the 900px breakpoint.
- **Title:** selected-issue heading; becomes 18px from the 1150px breakpoint, then returns to 20px in the stacked mobile layout.
- **Section title:** general section and empty-state headings. Panels use a smaller 17px heading.
- **Body:** application baseline. Descriptions and messages use 13px text with a spacious 1.8 line height.
- **Issue title:** semibold compact list title; board titles use 12px with a 1.55 line height.
- **Label / metadata / state label:** progressively smaller controls and supporting context. State-pair captions and provenance details use the smallest role; keep essential issue titles at their stronger role.
- **Code:** branch names, identifiers, request details, and technical output. Journal output is 11px. Long technical strings can wrap anywhere.

Settings descriptions have a 65ch maximum width. Issue descriptions preserve whitespace, read at a 75ch measure with a 1.75 line height, and grow with the page instead of scrolling inside a box. Comments use 13px text at 1.7; tracker activity uses 12px muted text. Times display in 24-hour `HH:mm` and tracker dates as `YYYY-MM-DD HH:mm`, regardless of system locale.

## Layout

The desktop shell combines a sticky, viewport-height navigation rail (208px) with the remaining flexible work area. A workspace bar (62px) sits above content constrained to a 1700px maximum width, with default content padding of 28px 30px 36px. The recurring gaps and padding steps in the frontmatter are observed values, not a mathematical scale.

The list/detail work area is one bordered surface with an internal divider: columns use `minmax(380px, 1.12fr)` and `minmax(330px, 1fr)`, with a minimum height of `calc(100dvh - 240px)`. Detail bodies use 22px 23px padding; list rows use 17px 17px 16px. The five-column board uses a 13px gap, minimum 200px columns, and horizontal scrolling. Evidence tiles use auto-fill columns with a 290px minimum and an 18px gap.

Setup uses one column capped at 880px, with its heading, progress, and Recheck aligned to the step list. Settings use a 160px section navigation beside a content column capped at 820px, separated by 36px. Standard field rows have two equal columns; the status-mapping row has three. Run detail uses a flexible main panel beside a 300px proof panel.

Responsive rules follow the shipped cascade:

- **At 1600px and wider:** list/detail columns become equal fractions, with 450px and 400px minima.
- **At 1150px and narrower:** rail becomes 175px; content uses 24px 20px padding; list/detail columns have 290px minima; detail padding tightens to 18px. Settings navigation becomes 125px with a 20px gap; run sidebar becomes 270px.
- **At 900px and narrower:** rail becomes 66px with icon-only navigation and no brand text or rail footer. Content uses 23px 18px padding. Run detail and settings become single-column; settings navigation becomes a horizontally scrollable row. Run timestamps disappear.
- **At 700px and narrower:** the shell becomes a block with 65px bottom padding; navigation becomes a fixed 60px bottom bar with icons and labels. The workspace bar becomes 49px and content uses 21px 13px padding. Issue list and selected detail stack; an unselected detail pane is hidden. Heading actions occupy their own row; field groups collapse to one column. The board retains five 250px columns with horizontal scrolling. The settings save area sits 60px above the bottom edge, and toast placement shifts above navigation.

## Elevation & Depth

Ordinary work areas are flat, with white surfaces, cool dividing lines, and tonal row selection. The selected List/Kanban switch has a subtle shadow. Toasts and dialogs use larger, diffuse shadows to signal temporary overlays; the modal backdrop dims the workspace.

### Shadow Vocabulary

- **Selected view:** `0 1px 2px #24414c12`.
- **Toast:** `0 6px 25px #152c3a22`.
- **Dialog:** `0 20px 80px #173c4633`, with a `#18343d55` backdrop.
- **Picker list:** `0 10px 30px #173c4626`; in the dark theme `0 10px 30px #0b171c99`, because the light shadow disappears on a dark ground.

**The Flat Work Surface Rule.** Use borders and tonal separation for ordinary work surfaces. The small selected-view shadow and the toast and modal shadows have specific state and overlay roles.

## Shapes

Small rounded rectangles organize the interface. Tags and tiny switch segments use the tag radius; fields use their slightly larger field radius; buttons, navigation items, and board task cards use the control radius. Larger work surfaces, panels, settings cards, evidence cards, and decision forms share the surface radius. Board columns and the toast use the column radius; dialogs use the largest recorded radius.

Setup step marks and the loading spinner are circles. Most structural boundaries are 1px strokes. The active detail tab uses a 2px bottom line, and interactive controls receive a 2px accent focus outline offset by 3px. Small circular dots indicate local health or workflow position; the diamond priority mark is a distinct, compact metadata cue. These small symbols do not establish a decorative illustration system.

## Components

### Buttons

Compact, labeled controls with optional outlined SVG icons. Default buttons use a white fill, cool border, 550 weight, and a 36px minimum height. Primary buttons use petrol with white text; quiet buttons use transparent backgrounds and muted text. Small controls use a 29px minimum height. Danger controls change text to the failure color. Hover adjusts fill and border; disabled buttons use 0.45 opacity and a not-allowed cursor. Keyboard focus retains the shared accent outline. There is no custom pressed transform.

### Inputs / Fields

Visible labels sit above white, bordered fields with compact rounding, 9px 10px padding, and a 38px minimum height. Helper text is muted. Textareas can resize vertically, begin at 85px minimum height, and use a 1.6 line height. Search is a separate unboxed field within the pane toolbar. Error text appears beside forms; the source does not define an error-border variant for fields.

### Navigation and Tabs

Rail items pair a stroke SVG icon with a label; active items retain a filled background and `aria-current="page"`. Counts use small inset badges. Hover has a distinct petrol fill. The responsive icon rail and bottom bar follow Layout. Detail tabs are text controls with muted defaults and an accent underline plus semibold text when selected; tab state uses `aria-selected`.

### Chips / Tags

Compact status rectangles pair text with a semantic tint. Running and working use teal; waiting, needs-evidence, and queued use amber; ready-for-review, published, and finished use green; failed and interrupted use red. Other values retain the neutral fallback. Tracker and agent tags are grouped with visible captions and can wrap. Tags have no invented hover or click behavior.

### Cards / Containers

Panels, settings cards, and evidence cards share a white fill, thin divider border, and surface radius. Internal padding is contextual: panels 22px, settings and evidence cards 20px, decisions 18px. Board tasks use smaller control corners, a white fill, 13px padding, and a border-color hover transition. Ordinary containers do not lift on hover.

### Issue Rows

Checkbox selection and issue opening are separate controls. A semibold title leads the row; source identity, monospace issue ID, priority, category, and captioned states sit beneath it. The selected row has a persistent pale fill, with a separate selected-hover tone. Metadata wraps rather than forcing the detail column wider.

### Decision Requests

Questions and approvals are structured forms. Each begins with a link to its originating issue/run, then a short run ID and provider, separated from the request by a divider. Approval variants use a warm pale fill and border; the request type uses semantic color. Details can scroll within a preformatted area. Explicit answer/approve, decline, and cancel controls appear beneath the fields. Origin links underline on hover and use the shared focus outline.

### Evidence and Activity

A checklist marks current-code tests, saved recording, and current-code browser assertions independently. Evidence uses actual image/video elements constrained to container width, plus open and download links. Checkmarks use green and missing checks use amber. The work journal is collapsed behind a disclosure control; detailed output scrolls inside a 420px maximum height.

### Setup Checklist

One bordered list of numbered steps. Each header button shows a circular mark (number, or a green check when done), the step title, a one-line summary computed from live settings, and a chevron that rotates when open. Only one step is open; the first unfinished required step opens by default. Optional steps carry a muted *Optional* label. Bodies hold a short muted explanation, a fact list (icon, name, mono detail), callouts, and actions. A native `<progress>` and an *n of m ready* count sit in the page heading and in the issue-list banner, which shows the next step until required setup is done.

### Searchable Picker

Long lists (employees, branches) use a combobox: a text field with a rotating chevron over a hidden input that carries the value and fires `change`. Typing filters by every word; arrows, Page Up/Down, Home/End move an active row (selected tint with a 1px accent outline); Enter chooses; Escape restores the chosen label. The selected row is semibold with a small accent dot. An empty state names the recovery. Short lists stay native `<select>`, drawn with the shared arrow.

### Issue Detail

Below the title, properties form an auto-fill grid of 150px minimum cells: a muted 11px label above a 12.5px value, covering tracker status, project, parent, group, reporter, created, due, every custom tracker field, category, and agent. Sections follow in reading order: Description (with Refresh), Screenshots as 4:3 tiles that never upscale small images and fall back to *Preview unavailable* with a link to the original, Attachments, and Comments with system updates collapsed into a disclosure. Loading and error states use the inline spinner and a retry action.

### Callouts, Disclosures, and Selects

Setup callouts use the attention tint with an icon, text, and one action; commands sit in a white code well beneath. Every `<details>` summary uses a drawn chevron that rotates 90° when open, never the browser triangle. Native selects use `appearance:none` and the theme's `--select-arrow`.

### Cloud Backup and Runtime Profiles

Cloud backup shows a state tag, then pending uploads, last upload, and workspace as a compact definition row; errors appear beneath as alert text. Runtime profiles sit in a bordered fieldset: each profile has a name, a product tag, and four short-code fields in one row that collapses to two and then one column.

### Feedback, Dialogs, and Motion

Notices place an icon beside text and a contextual action. Toasts appear at the lower edge, announce through a status live region, and use a red fill for errors. Dialogs are capped at 540px or the viewport minus 30px and carry the dedicated overlay shadow and backdrop. Busy icons rotate linearly over 1.4s; the inline spinner over 1s. Setup progress and chevrons ease over 0.15–0.4s. Toast entry uses 0.2s and page entry 0.25s with the recorded easing curve; board border changes use 0.15s. Reduced-motion preference removes animation and transitions.

## Do's and Don'ts

### Do:
- **Do** pair compact metadata with the stronger issue-title hierarchy.
- **Do** preserve visible Tracker and Agent labels when both states are present.
- **Do** keep the issue/run link and provider context with a decision request.
- **Do** retain the accent focus outline and the reduced-motion override.
- **Do** let long branch names, descriptions, and request details wrap or scroll within their own content areas; break file paths at separators.
- **Do** compute setup and status summaries from real settings and say what to do next.
- **Do** honor `[hidden]`: component display rules must never reveal filtered rows.

### Don't:
- **Don't** represent tracker completion with an agent-only state.
- **Don't** turn the overlay shadows into ordinary card elevation.
- **Don't** remove origin context from approval or question forms.
- **Don't** replace the horizontally scrolling Kanban board with compressed, unreadable columns.
- **Don't** show raw tracker payloads (`COMPS` JSON, escaped slashes) or broken image icons in issue content.
- **Don't** load remote images directly; tracker images go through the local task-image cache.
