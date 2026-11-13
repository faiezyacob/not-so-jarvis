---
name: JARVIS
description: A local AI assistant dashboard built as a production call sheet.
colors:
  paper: "#f2ede3"
  paper-recessed: "#e8e2d4"
  surface: "#fbf8f1"
  ink: "#1a1a18"
  ink-secondary: "#4a4842"
  ink-tertiary: "#625d51"
  rule: "rgba(26, 26, 24, 0.24)"
  rule-soft: "rgba(26, 26, 24, 0.12)"
  row-active: "#e4ddca"
  stamp: "#b8342a"
  hold: "#7d6027"
  night-paper: "#171614"
  night-paper-recessed: "#100f0e"
  night-surface: "#1e1c19"
  night-ink: "#f2ebdd"
  night-ink-secondary: "#c2b9a8"
  night-ink-tertiary: "#8b8375"
  night-rule: "rgba(242, 235, 221, 0.13)"
  night-rule-soft: "rgba(242, 235, 221, 0.07)"
  night-rule-heavy: "#a49b8a"
  night-row-active: "#262320"
  night-stamp: "#e2564a"
  night-hold: "#c9a15c"
typography:
  display:
    fontFamily: "Barlow Condensed, Barlow, Segoe UI, sans-serif"
    fontSize: "27px"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "0.005em"
  headline:
    fontFamily: "Barlow Condensed, Barlow, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.15
  title:
    fontFamily: "Barlow Condensed, Barlow, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.02em"
  body:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.62
  label:
    fontFamily: "Barlow Condensed, Barlow, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.16em"
  reading:
    fontFamily: "Barlow Condensed, Barlow, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "0.01em"
components:
  composer-send:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    padding: "0"
    size: "40px"
  composer-send-hover:
    backgroundColor: "{colors.stamp}"
    textColor: "{colors.paper}"
  composer-input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "10px 12px"
    typography: "{typography.body}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    padding: "6px 9px"
    typography: "{typography.label}"
  rail-row-active:
    backgroundColor: "{colors.row-active}"
    textColor: "{colors.ink}"
  day-sheet-stamp:
    backgroundColor: "transparent"
    textColor: "{colors.stamp}"
    padding: "4px 11px"
    typography: "{typography.label}"
---

# Design System: JARVIS

## Overview

**Creative North Star: "The Production Call Sheet"**

JARVIS is a working document, not an app shell with widgets attached. The screen is ruled like a day sheet: a wordmark bar, a column of today's rolls, one sheet header that stamps the session's state and lists its live figures, the log itself, and a column of machine readings. Density comes from rules and alignment rather than from cards, and the only saturated colour in the system is the one that marks something live or wrong.

The world is paper and ink, in two grounds. By day the sheet is bone stock with iron-black rules; at night the same sheet is a warm near-black with the ink lifted to cream. Both grounds are first-class: the theme switch is a real preference persisted per browser, with the operating system's setting as the default, never a hard-coded side.

Type does the period work. Barlow sets everything read in sentences; Barlow Condensed sets headings, field labels, roll numbers, status stamps and every figure, all with tabular numerals so columns line up across rows the way they do on a real sheet.

**Key Characteristics:**
- Ruled rows and a two-weight rule system instead of containers and cards.
- One stamp vermilion, reserved for state: live work, attention, the single live label.
- Bone paper by day, warm near-black at night, both maintained.
- Condensed display and labels over tabular figures, body text in a humanist grotesque.
- Square corners throughout the shell; no shadow at rest, shadow only on things that float.
- Self-hosted faces, no network font request, because the product is local-only.

## Colors

A paper-and-ink palette: three neutrals per ground, two rules, and exactly one saturated colour.

### Primary

- **Stamp Vermilion** (#b8342a light / #e2564a night): the system's only saturated colour. It marks the sheet's state stamp while live, a running job, the active roll's number, the blocked chat-model pill, the weather error, and the send button at hover. It is never used for decoration, fills, body text, or routine speaker labels.

### Neutral

- **Bone Stock** (#f2ede3): the day ground; every page surface starts here.
- **Recessed Stock** (#e8e2d4): the widget column and any inset panel that must sit behind the page without a border.
- **Form Surface** (#fbf8f1): the composer input, the active roll row, and popovers that lift off the page.
- **Iron Ink** (#1a1a18): body copy, headings, the heavy section rule.
- **Secondary Ink** (#4a4842): labels, metadata, user turns, quiet controls.
- **Tertiary Ink** (#625d51): field names, timestamps, placeholders, disabled text.
- **Heavy Rule** (`#1a1a18` light / `#a49b8a` night): the sheet's structural edges, 2–3px. At night it is set in stone rather than cream, so the edge carries its weight as mass instead of glare.
- **Fine Rule** (`rgba(26, 26, 24, 0.24)` light / `rgba(242, 235, 221, 0.13)` night): separators between rows and cells.
- **Hairline Rule** (`rgba(26, 26, 24, 0.12)` light / `rgba(242, 235, 221, 0.07)` night): the last division, used between log entries.
- **Held Ochre** (#7d6027 light / #c9a15c night): queued and on-hold states, the only second state colour, never a decorative accent.

### Named Rules

**The One Stamp Rule.** Vermilion occupies a single job per screen: it says *this is live*. If two things on one screen need it, one of them is decoration. It never colours a large area, a background, or body text.

**The Two-Weight Rule.** Structure is announced with the heavy rule and subdivided with the fine one. There are no third weights, no dashed rules, and no double borders. Weights are optical, not literal: on the night ground every rule sits a step below the lifted cream, because light-on-dark blooms and turns a 1px hairline into a wire and a 3px rule into a lit bar. Night structure is a fold in the paper, never a light bar.

## Typography

**Display Font:** Barlow Condensed (self-hosted woff2, 500/600/700)
**Body Font:** Barlow (self-hosted woff2, 400/500/600/700)
**Code Font:** Cascadia Mono / Consolas for code blocks only

**Character:** A condensed grotesque doing the shouting and a humanist grotesque doing the talking. The pair reads as printed production paperwork at a glance and as ordinary, comfortable software at reading length.

### Hierarchy

- **Display** (700, 27px, 1.08): the sheet's roll title; clamps to two lines, never truncates mid-phrase.
- **Headline** (600, 24px, 1.15): the empty sheet's title and any block heading inside the sheet.
- **Title** (600, 14px, 1.2, +0.02em): field values, popover rows, compact headings.
- **Body** (400, 15px, 1.62): the conversation log. Measure stays inside the chat column (1020px, 1180px above 1920px), never full-bleed.
- **Label** (700, 11px, +0.16em, uppercase): field names, role labels, rail header, state stamps, button captions. Never below 11px.
- **Reading** (600, 26px, 1.1): live machine figures (CPU, RAM, VRAM percentages). Figures are tabular everywhere in the system.

### Named Rules

**The Tabular Rule.** Every number in the shell is set tabular, so a column of figures reads as a column. Proportional numerals are a defect.

**The Eleven-Pixel Floor.** Functional text never drops below 11px, however condensed the face. Where a label feels too large, tighten the tracking, not the size.

## Layout

A three-column frame under a fixed 44px wordmark bar. The rail is 224px (196px under 1024px), the chat column flexes between them and caps at 1020px (1180px above 1920px), and the widget column is 304px (264px under 1024px). The chat column owns its own header block and composer, so the log scrolls between two fixed rules.

The sheet header is a ruled block, not a bar: title and stamp on one baseline, then a four-cell figure row divided by fine vertical rules. Cells are equal-width, each with an uppercase label above a condensed value.

Density is created by rules and alignment: rows are separated by a hairline, cells by a fine rule, sections by a heavy rule. Padding inside rows is 9–12px; block padding is 16px; the composer and rails use 12–16px. Nothing is wrapped in a card.

Below 768px the frame becomes one column: the wordmark bar keeps its logo, theme and settings on the first row and drops the studio strip to a second row, the roll rail becomes a horizontal strip of 78px that scrolls the open roll into view, and the figure row folds to two columns.

The four production surfaces — UGC Studio, Creator Studio, Character Swap and Companions — are full-height **sheets**, not modals with card grids: one header rule, a scrolling body, and a pinned commit bar. Creator Studio is `min(1200px, 100%) × min(94vh, 1000px)`, UGC `min(900px, 100%) × min(94vh, 940px)`, Character Swap `min(1580px, 100%) × min(96vh, 1080px)`. They sit on a paper scrim (`rgba(var(--paper-rgb), 0.96)`), carry a single 1px heavy rule, and scroll their body only — the header and commit bar never move.

## Elevation & Depth

The shell is flat. Depth is conveyed by rule weight and tone: recessed stock behind the widget column, form surface for anything that lifts (composer, active row, popovers). No element in the shell carries a shadow at rest.

### Shadow Vocabulary

- **Floating panel** (`0 18px 40px rgba(0, 0, 0, 0.18)`): popovers and menus that genuinely sit above the page.
- **Scrolled log edge** (`inset 0 10px 10px -10px rgba(var(--ink-rgb), 0.35)` light / `rgba(0, 0, 0, 0.6)` night): a single inset cue that the log continues above its rule; the only inset shadow in the system. At night it is a shadow the sheet casts on the log, never cream emitted onto it.

### Named Rules

**The Flat-By-Default Rule.** If an element is not physically above the page, it has no shadow. Elevation is not a decoration budget.

## Shapes

Square. The shell's buttons, inputs, rows, fields, images and popovers all use a 0 radius; the only curves in the system are the circular state dots and the product's circular mark. Borders are 1px, rules 1–3px; there is no outline-only or dashed treatment anywhere.

The one rotated element in the system is the state stamp on the sheet header, tilted −3.5° with a faint ink wash, which reads as a rubber stamp on the page rather than a UI badge.

## Components

### Buttons

- **Shape:** square (0 radius).
- **Primary:** the composer's send control is iron ink filled with paper text at 40×40px; it turns stamp vermilion on hover. It is the only filled control in the shell.
- **Quiet:** the header's studio triggers and the composer's tool buttons are transparent with a 1px rule on the controls, ink text, and a tinted ink wash on hover.
- **Hover / Focus:** colour and background shift at 0.14s ease-out; focus is a 2px solid ink outline at 2px offset, never a glow.

### Chips

- **Style:** suggestion and asset-action controls are ruled rectangles, 11px condensed uppercase, no fill.
- **State:** hover raises the border to full ink and tints the background; the icon takes the stamp colour only on hover.

### Cards / Containers

- **Corner Style:** none; there are no cards in the shell.
- **Background:** rows sit on the page ground; the active row takes the row-active tone; floating panels take the form surface.
- **Shadow Strategy:** flat at rest (see Elevation).
- **Border:** one fine rule between rows, one heavy rule between sections.
- **Internal Padding:** 9–14px.

### Inputs / Fields

- **Style:** form surface, 1px fine rule, square, 14px body face, tertiary placeholder.
- **Focus:** border goes to full ink; no glow.
- **Disabled:** the tertiary ink and no border change.
- **Blocked state:** the composer's model pill turns vermilion (dot, label and border) when no chat model is selected, because that is the one condition that stops the next turn.

### Navigation

- **Style:** the rail is a list of rolls numbered `01…` in condensed figures, each row separated by a hairline. The active row takes the row-active tone, its number turns vermilion, and its title moves to ink at 500 weight. The rail header is an 11px uppercase label with a square add button.
- **Mobile:** the same list becomes a horizontal strip; action icons are hidden until the row is active.

### Sheet Header (signature)

The one component that defines the world: title + rotated state stamp on one baseline, a four-cell figure row beneath, and a 3px heavy rule closing the block. The stamp is outlined, uppercase, 12.5px condensed at −3.5° with a 4% ink wash, and switches to vermilion when the sheet is live and to held ochre when queued.

### Studio Sheet

The production surfaces reuse the shell's grammar at full height.

- **Frame:** 1px heavy rule, square corners, paper ground, one floating shadow (`0 18px 48px rgba(var(--ink-rgb), 0.18)` light, `rgba(0,0,0,0.55)` night) because a sheet does sit above the page.
- **Header:** 2px heavy rule beneath, 27px condensed title, one sentence of context, no kicker or eyebrow.
- **Body:** the only scrolling region; sections divided by fine rules, section labels at 11px condensed / +0.16em.
- **Commit bar:** pinned at the foot above a 2px heavy rule, never inside the scroll.
- **Focus:** the sheet takes focus on open, Tab is trapped only while focus is inside, and focus returns to the trigger on close (`public/js/studio-shell.js`).

### Commit Bar

- **Primary:** iron ink filled, 42px tall, 12px condensed uppercase at +0.16em; hover goes to stamp vermilion.
- **Disabled:** transparent with a fine rule and tertiary ink; the reason is stated in words beside it, never colour alone.
- **Status:** 12px ink-2 text on the same row, left of the action, so progress and the action read as one line.

### Step Rail

Five equal cells on recessed stock, divided by hairlines, each an 11px condensed number over an 11px uppercase label. The current step takes the paper ground and full ink; clicking a cell scrolls its section into view and focuses its first control.

## Do's and Don'ts

### Do:

- **Do** build density from rules: a hairline between rows, a fine rule between cells, a heavy rule between sections.
- **Do** keep the stamp colour to one job per screen: live or attention.
- **Do** set every figure tabular, and every label at 11px or above.
- **Do** keep both grounds authored; check any new component on bone and on near-black before calling it done.
- **Do** self-host any new face and add its licence beside it; the product makes no network font request.
- **Do** let the log keep its left gutter of times and role labels; it is what makes the transcript read as a sheet.
- **Do** build a studio surface as a sheet: one header rule, one scrolling body, one pinned commit bar, and `StudioShell.open/close` for focus.
- **Do** state a disabled or failed action in words beside it; colour alone never carries the outcome.

### Don't:

- **Don't** introduce cards, rounded corners, or drop shadows for depth inside the shell.
- **Don't** use the stamp colour for decoration, illustration, or emphasis that is not a state.
- **Don't** set functional text below 11px, and don't reach for a smaller size to fit a label.
- **Don't** use monospace as a stand-in for "technical"; figures are condensed and tabular.
- **Don't** use emoji or unicode glyphs as an icon system in the shell.
- **Don't** add a coloured left border to a row, card, or callout as an accent.
- **Don't** let a commit action live at the end of a scrolling column; it belongs in the pinned bar.
- **Don't** put a gradient, glow, rounded card or eyebrow label inside a studio sheet.
