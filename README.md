# Timeblocks

Minimal timeblocking for daily notes: a day-timeline view (right sidebar) plus a task picker (left sidebar). Blocks are stored as plain markdown in the daily note itself.

## Usage

- Click the **calendar-clock ribbon icon** (or run "Timeblocks: Open timeblock views").
- **Left sidebar**: click an open `- [ ]` task from today's `## Tasks` section (`## Reminders` in older notes still works), or type an ad-hoc task and press Enter. A collapsible **Previous days (N)** section lists unchecked reminders from earlier daily notes (lookback configurable, default 14 days) — per task text the most recent occurrence wins, so anything checked off on a later day is hidden, and tasks already in today's note are excluded.
- Each task row has a **checkbox** that checks off the original `- [ ]` reminder in whichever note it lives (today's or a previous day's). **Double-click** a row to open that note with the cursor on the reminder line. The block popover also offers "✓ Mark task done" when the block's task matches an open reminder.
- Leftover rows show two hover buttons: **move to today** (appends `- [ ] task` to today's `## Tasks` and rewrites the original to `- [>] task (moved to [[<today's note>]])` — a clickable trail of where it went) and **archive** (rewrites the reminder to `- [-]`, cancelled — closed without claiming it was done). Both edits are in the original notes and hand-reversible; `[>]` and `[-]` count as closed, so the task leaves the leftovers list. The `(moved to …)` annotation is ignored when matching task text, so dedupe keeps working.
- **Right sidebar**: drag vertically on the timeline to create a block for the selected task (a modal asks for a name if nothing is selected). Drag a block to move it, drag its top/bottom edge to resize, hover → `×` to delete. `‹`/`›` navigate days; click the date to jump to today.
- A **Plan / Track toggle** under the header decides what a block drag means (persisted): **Plan** — you're still estimating, planned and revised move together, any ghost collapses; **Track** — the drag records the actual, and the original plan is preserved as a dashed ghost for retrospectives. Meetings ignore the mode (their plan is the calendar's; edge-drags always record actuals).

## Notes on blocks

- **Click** a block → popover with its notes (markdown textarea; Save or Cmd+Enter). Blocks with notes show a • dot.
- **Double-click** a block → opens the daily note at that block's entry.
- The **left sidebar** shows a notes editor for the selected block.

## Storage format

Each block is an H5 entry at the top of the existing `# Logs` section, same idiom as the `➢` log entries; notes are the entry body:

```markdown
# Logs

##### ⏱ *09:00-10:30* · Design review
- found an edge case

##### ⏱ *11:15-12:00* · gap analysis (planned 09:00-10:30)

##### ➢ *10:00 am* · Catching up
```

- No `(planned …)` suffix → the block was never adjusted (planned == revised); with the suffix, the leading range is the current/revised time and the suffix is the original estimate.
- Block entries stay grouped and sorted by start time at the top of `# Logs`; `➢` entries below are never touched (code fences in note bodies are handled).
- The `# Logs` heading is never removed, even when the last block is deleted.
- The old one-line format (`- 10:15-11:00 task`) is still parsed and auto-upgraded to entries on the next write.
- Stray free text directly under `# Logs` is preserved but re-ordered after the block entries on write; hand-editing times/notes is safe.

## Calendar meetings (read-only)

The timeline can overlay meetings from two sources (either or both):

1. **iCal feed URLs** (e.g. Google's "Secret address in iCal format", if your
   org allows it): paste one URL per line in settings. Google caches these
   feeds, so changes can lag. Recurrence/exceptions/timezones handled by the
   bundled ical.js.
2. **Google Calendar API (OAuth)** — works when Workspace admins disable the
   secret address. One-time setup: own Google Cloud project → enable Calendar
   API → OAuth consent screen (Internal) → OAuth client (Desktop app) → paste
   client ID/secret into settings → "Sign in with Google" (loopback redirect,
   PKCE, `calendar.readonly` scope only). Tokens live in the plugin's
   `data.json`. Calendar IDs setting defaults to `primary`. Sign-in requires
   the desktop app; results are fetched per viewed day and cached.

By default ("Add meetings to today's log"), today's meetings are written into
the daily note as `##### 📅 *11:00-11:30* · Standup` entries sorted among the
⏱ blocks — click one on the timeline to take meeting notes (same popover /
sidebar / double-click-to-open as blocks; no delete — the sync would re-add
it). Times auto-update when a meeting moves; entries are never auto-deleted.
Meetings are **resizable on the timeline** (drag their top/bottom edge) to
record how long they actually ran: the first adjustment freezes the
calendar's time into a `(booked 14:00-15:00)` suffix (shown as a dashed
ghost), the adjusted range is what renders and counts in the retro, and the
sync never overwrites it — it matches adjusted meetings by their booked time
and only updates the suffix if the meeting moves in the calendar. Resizing
back to the exact booked time drops the suffix. A meeting removed from the
calendar gets **marked cancelled** instead: title
struck through (`~~title~~`) in the note and on the timeline, notes kept,
excluded from retro meeting totals, un-cancelled automatically if the meeting
reappears. Cancellation is only ever marked after a verifiably successful
fetch — a failed sync can't strike anything through. Separately, the meeting
popover has a **"Not attending"** toggle for a *local* skip: the entry gets
`~~title~~ (skipped)` — struck through and excluded from retro totals like a
cancellation, but purely an Obsidian-side note; the Google Calendar event is
untouched and sync never clears the flag (toggle "Attending" to undo). Sync writes only on
actual change. Meetings not materialized (other days, or
with the toggle off) render as an inert striped overlay — not clickable, and
dragging over them to create a timeblock works normally. All-day events are
skipped. Refresh interval is configurable; "Refresh now" forces it. A footer
line on the timeline shows when the viewed day's meetings were last synced —
click it to force a refresh.

## Quick actions

- **Start selected task now** (▶ in the timeline header, or command palette):
  creates a block at the current minute for the selected task (modal if none),
  default 30 min. Any block still running is trimmed to end now — its planned
  time is preserved, so the retro shows the real vs estimated duration.
- **Start a break now** (☕ / command): same, but creates a `#break` block
  (default 15 min). Breaks are styled gray-hatched and counted separately.

## Day retro (automated)

With "Auto day retro" on (default), a generated `## Retro` section is kept at
the end of the daily note and regenerated on every change: focus time vs
planned (with % accuracy), meeting and break totals, and a per-block
planned/actual/Δ table. `#break` blocks are excluded from focus totals and
the table. The section is fully derived — hand edits inside the callout are
overwritten; content below it survives. Manual command: "Update day retro".

## Settings

Day start/end hour (timeline auto-expands past them if blocks exist outside),
snap minutes, hour height (vertical zoom — also adjustable via the timeline's
zoom buttons), iCal feed URLs, and calendar refresh interval.

## Development

```
npm install
npm run dev    # watch build
npm run build  # type-check + production build
```

Reload Obsidian (Cmd+R) after builds to pick up changes.
