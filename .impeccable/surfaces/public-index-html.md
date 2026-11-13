---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# Chat shell + dashboard chrome

## Scope and mode

Operate. The dashboard shell: header, conversation rail, chat column (day-sheet header, log, composer) and the widget column, plus the token layer every other panel inherits. Light and dark are both authored, with a real theme switch persisted per browser.

## Audience, job, action, constraints

One technical operator on their own machine, mid-render, glancing between a long job and the prompt they are iterating. The job: know what the machine is doing, keep the conversation going, and change the asset without restating the brief. The action: send a turn, or read the day's state. Constraints: fully local (self-hosted fonts, no CDN), zero npm dependencies, no build step, guest sessions untouched, every existing control keeps working.

## Chosen direction

Production Call Sheet. A ruled day sheet: condensed grotesque headings, tabular figures, bone paper and warm near-black, one stamp vermilion reserved for live state. The memorable moment: the day-sheet header that stamps the session's state and lists its live facts in four ruled fields.

## Unresolved

None that block the build.

## Direction contract

THESIS: The screen is the day's call sheet, one ruled document that says what the machine is doing and what came out of it, rather than a chat window with widgets bolted on.

OWN-WORLD: Bone paper and warm near-black; ink rules in two weights; a single stamp vermilion reserved for live and attention states; Barlow for text with Barlow Condensed for headings, labels and figures, all tabular; density built from ruled rows, never from cards.

STORY: The operator sees the running job, the current roll and its state at one glance, then writes the next turn, and nothing else competes for that first look.

FIRST VIEWPORT: a 44px wordmark bar; a 220px "today's calls" rail; the chat column opening with a 30px condensed roll title, a rotated state stamp and a four-field ruled row (model, queue, elapsed, frames); the log beneath it with times in a left gutter; a 300px widget column of ruled machine blocks; the composer pinned at the foot under a two-pixel rule.

FORM: Production Call Sheet, position 1 of the ordered list (the pick card). SEED REFERENCE seed:29b1d4b5cd9af1e2

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
