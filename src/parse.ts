/**
 * Pure parsing/serialization for the timeblock entries in the `# Logs`
 * section and the `## Reminders` checkboxes. No Obsidian imports —
 * testable with plain node.
 *
 * Each timeblock is an H5 entry (same idiom as the user's `➢` log
 * entries) with the block's notes as its body:
 *
 *   ##### ⏱ *10:15-11:00* · Design review (planned 10:00-10:45)
 *   - found an edge case
 *   - waiting on review
 *
 * The body runs until the next heading. Blocks are kept as a sorted
 * group at the top of `# Logs`; the `➢` entries below are never touched.
 * The legacy one-line format (`- 10:15-11:00 task`) is still parsed and
 * upgraded to entries on the next write.
 */

export interface TimeRange {
	/** minutes since midnight */
	start: number;
	end: number;
}

export interface Timeblock {
	task: string;
	planned: TimeRange;
	revised: TimeRange;
	/** raw markdown body lines, verbatim */
	notes: string[];
}

export interface MeetingEntry {
	title: string;
	/** actual time (what renders); user-adjustable */
	range: TimeRange;
	/** raw markdown body lines, verbatim */
	notes: string[];
	/** removed from the calendar after being materialized; kept + struck through */
	cancelled: boolean;
	/**
	 * Local "not attending" decision: struck through like cancelled, but
	 * the meeting still exists on the calendar and sync never clears it.
	 */
	skipped: boolean;
	/**
	 * The calendar's time, present once the user has adjusted the range.
	 * Sync matches against this and never overwrites an adjusted range.
	 */
	booked?: TimeRange;
}

export type SectionItem =
	| { kind: "block"; block: Timeblock }
	| { kind: "meeting"; meeting: MeetingEntry }
	| { kind: "raw"; text: string };

export const TIMEBLOCKS_HEADING = "# Logs";
/** Current heading first; "## Reminders" kept so pre-rename notes still work. */
export const TASKS_HEADINGS = ["## Tasks", "## Reminders"];
export const LOGS_FOLDER = "1. Logs";

const HEADING_OR_HR_RE = /^(#{1,6}\s|---\s*$)/;
const BLOCK_HEADING_RE =
	/^#####\s*⏱️?\s*\*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\*\s*·\s*(.+?)(?:\s+\(planned (\d{1,2}:\d{2})-(\d{1,2}:\d{2})\))?\s*$/;
const LEGACY_BLOCK_RE =
	/^- (\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(.+?)(?:\s+\(planned (\d{1,2}:\d{2})-(\d{1,2}:\d{2})\))?\s*$/;
const MEETING_HEADING_RE =
	/^#####\s*📅\s*\*(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\*\s*·\s*(.+?)(?:\s+\((skipped)\))?(?:\s+\(booked (\d{1,2}:\d{2})-(\d{1,2}:\d{2})\))?\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
// Anchored to column 0: indented checkboxes are subtasks of the task above
// and must not surface as tasks of their own.
const REMINDER_RE = /^- \[ \]\s+(.+?)\s*$/;
const REMINDER_ANY_RE = /^- \[( |x|X|-|>)\]\s+(.+?)\s*$/;
const INDENTED_CONTENT_RE = /^[ \t]+\S/;
const MOVED_SUFFIX_RE = /\s*\(moved to .*?\)$/;

export function parseTime(s: string): number | null {
	const [h, m] = s.split(":").map((n) => parseInt(n, 10));
	if (isNaN(h) || isNaN(m) || m >= 60) return null;
	const total = h * 60 + m;
	return total >= 0 && total <= 1440 ? total : null;
}

/** For compact UI labels: `[[Target|alias]]` → `alias`, `[[Target]]` → `Target`. */
export function displayTaskText(text: string): string {
	return text.replace(
		/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
		(_, target: string, alias?: string) => alias ?? target
	);
}

export function formatTime(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseRange(startStr: string, endStr: string): TimeRange | null {
	const start = parseTime(startStr);
	const end = parseTime(endStr);
	if (start === null || end === null || end <= start) return null;
	return { start, end };
}

function frontmatterEndIndex(lines: string[]): number {
	if (lines[0]?.trim() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t === "---" || t === "...") return i + 1;
	}
	return 0;
}

function findHeadingIndex(lines: string[], heading: string): number {
	for (let i = frontmatterEndIndex(lines); i < lines.length; i++) {
		if (lines[i].trim() === heading) return i;
	}
	return -1;
}

function findTasksHeadingIndex(lines: string[]): number {
	for (const heading of TASKS_HEADINGS) {
		const idx = findHeadingIndex(lines, heading);
		if (idx >= 0) return idx;
	}
	return -1;
}

/** Builds a Timeblock from a regex match: [_, revStart, revEnd, task, plStart?, plEnd?] */
function makeBlock(m: RegExpExecArray): Timeblock | null {
	const revised = parseRange(m[1], m[2]);
	if (!revised) return null;
	let planned: TimeRange;
	if (m[4] && m[5]) {
		const p = parseRange(m[4], m[5]);
		if (!p) return null;
		planned = p;
	} else {
		planned = { ...revised };
	}
	return { task: m[3], planned, revised, notes: [] };
}

export function parseBlockHeadingLine(line: string): Timeblock | null {
	const m = BLOCK_HEADING_RE.exec(line);
	return m ? makeBlock(m) : null;
}

export function serializeMeetingHeading(meeting: MeetingEntry): string {
	const struck = meeting.cancelled || meeting.skipped;
	const title = struck ? `~~${meeting.title}~~` : meeting.title;
	let out = `##### 📅 *${formatTime(meeting.range.start)}-${formatTime(meeting.range.end)}* · ${title}`;
	if (meeting.skipped) out += " (skipped)";
	const b = meeting.booked;
	if (b && (b.start !== meeting.range.start || b.end !== meeting.range.end)) {
		out += ` (booked ${formatTime(b.start)}-${formatTime(b.end)})`;
	}
	return out;
}

export function serializeBlockHeading(block: Timeblock): string {
	const { task, planned, revised } = block;
	const base = `##### ⏱ *${formatTime(revised.start)}-${formatTime(revised.end)}* · ${task}`;
	const unmoved =
		planned.start === revised.start && planned.end === revised.end;
	return unmoved
		? base
		: `${base} (planned ${formatTime(planned.start)}-${formatTime(planned.end)})`;
}

function trimTrailingBlanks(lines: string[]) {
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
}

/**
 * Scans the plugin-managed region: from `from` until the first heading or
 * `---` that is not a ⏱ block heading (i.e. the first `➢` entry or the
 * next section), tracking code fences so `# comments` inside fenced blocks
 * in notes don't terminate the region.
 */
export function parseLogsRegion(
	lines: string[],
	from: number
): { items: SectionItem[]; endIdx: number } {
	const items: SectionItem[] = [];
	let curNotes: string[] | null = null;
	let seenEntry = false;
	let inFence = false;
	let i = from;

	const finalize = () => {
		if (curNotes) trimTrailingBlanks(curNotes);
		curNotes = null;
	};
	const pushLine = (line: string) => {
		if (curNotes) curNotes.push(line);
		else if (line.trim()) items.push({ kind: "raw", text: line });
	};

	for (; i < lines.length; i++) {
		const line = lines[i];

		if (inFence) {
			pushLine(line);
			if (FENCE_RE.test(line)) inFence = false;
			continue;
		}

		const bm = BLOCK_HEADING_RE.exec(line);
		if (bm) {
			const block = makeBlock(bm);
			if (block) {
				finalize();
				items.push({ kind: "block", block });
				curNotes = block.notes;
				seenEntry = true;
				continue;
			}
			// ⏱-looking line with invalid times: keep it, don't lose data
			pushLine(line);
			continue;
		}

		const mm = MEETING_HEADING_RE.exec(line);
		if (mm) {
			const range = parseRange(mm[1], mm[2]);
			const skipped = !!mm[4];
			const booked = mm[5] && mm[6] ? parseRange(mm[5], mm[6]) : null;
			const bookedInvalid = !!(mm[5] && mm[6]) && !booked;
			if (range && !bookedInvalid) {
				finalize();
				let title = mm[3];
				let struck = false;
				const struckMatch = /^~~(.+)~~$/.exec(title);
				if (struckMatch) {
					struck = true;
					title = struckMatch[1];
				}
				// A skipped entry's strikethrough is explained by "skipped";
				// treating it as cancelled too would fight the sync forever.
				const meeting: MeetingEntry = {
					title,
					range,
					notes: [],
					cancelled: struck && !skipped,
					skipped,
				};
				if (booked) meeting.booked = booked;
				items.push({ kind: "meeting", meeting });
				curNotes = meeting.notes;
				seenEntry = true;
				continue;
			}
			pushLine(line);
			continue;
		}

		if (HEADING_OR_HR_RE.test(line)) break;

		if (!seenEntry) {
			const lm = LEGACY_BLOCK_RE.exec(line);
			if (lm) {
				const block = makeBlock(lm);
				if (block) {
					finalize();
					items.push({ kind: "block", block });
					curNotes = block.notes;
					continue;
				}
			}
		}

		if (FENCE_RE.test(line)) inFence = true;
		pushLine(line);
	}
	finalize();
	return { items, endIdx: i };
}

export function extractTimeblocks(content: string): SectionItem[] {
	const lines = content.split("\n");
	const headingIdx = findHeadingIndex(lines, TIMEBLOCKS_HEADING);
	if (headingIdx < 0) return [];
	return parseLogsRegion(lines, headingIdx + 1).items;
}

export function extractReminders(content: string): string[] {
	const lines = content.split("\n");
	const headingIdx = findTasksHeadingIndex(lines);
	if (headingIdx < 0) return [];
	const out: string[] = [];
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (HEADING_OR_HR_RE.test(lines[i])) break;
		const m = REMINDER_RE.exec(lines[i]);
		if (m) out.push(m[1]);
	}
	return out;
}

/** All checkbox items in ## Reminders, with their checked state. */
export function extractReminderStates(
	content: string
): { text: string; done: boolean }[] {
	const lines = content.split("\n");
	const headingIdx = findTasksHeadingIndex(lines);
	if (headingIdx < 0) return [];
	const out: { text: string; done: boolean }[] = [];
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (HEADING_OR_HR_RE.test(lines[i])) break;
		const m = REMINDER_ANY_RE.exec(lines[i]);
		if (m) {
			// Strip the "(moved to …)" annotation so a forwarded line still
			// matches its task text for latest-occurrence deduplication.
			out.push({
				text: m[2].replace(MOVED_SUFFIX_RE, ""),
				done: m[1] !== " ",
			});
		}
	}
	return out;
}

export interface Leftover {
	text: string;
	/** display date of the most recent occurrence, e.g. "Aug 12" */
	from: string;
	/** vault path of the note holding that occurrence */
	path: string;
}

/**
 * Computes leftover tasks from previous days: for each task text, the most
 * recent occurrence wins (days must be ordered oldest → newest); it is a
 * leftover only if that occurrence is unchecked and the text isn't already
 * in the current note. Newest leftovers first.
 */
export function computeLeftovers(
	days: {
		from: string;
		path: string;
		reminders: { text: string; done: boolean }[];
	}[],
	exclude: Set<string>
): Leftover[] {
	const latest = new Map<
		string,
		{ done: boolean; from: string; path: string; order: number }
	>();
	days.forEach((day, order) => {
		for (const r of day.reminders) {
			latest.set(r.text, {
				done: r.done,
				from: day.from,
				path: day.path,
				order,
			});
		}
	});
	const out: (Leftover & { order: number })[] = [];
	for (const [text, v] of latest) {
		if (!v.done && !exclude.has(text)) {
			out.push({ text, from: v.from, path: v.path, order: v.order });
		}
	}
	out.sort((a, b) => b.order - a.order);
	return out.map(({ text, from, path }) => ({ text, from, path }));
}

/**
 * Rewrites the unchecked reminder `- [ ] text` to the given state marker:
 * "x" (done), "-" (archived/cancelled) or ">" (moved forward). Returns the
 * new content, or null when no matching unchecked reminder exists.
 */
export function setReminderState(
	content: string,
	text: string,
	marker: "x" | "-" | ">",
	appendText?: string
): string | null {
	const lines = content.split("\n");
	const headingIdx = findTasksHeadingIndex(lines);
	if (headingIdx < 0) return null;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (HEADING_OR_HR_RE.test(lines[i])) break;
		const m = REMINDER_ANY_RE.exec(lines[i]);
		if (m && m[1] === " " && m[2] === text) {
			lines[i] = lines[i].replace("- [ ]", `- [${marker}]`);
			if (appendText) lines[i] = `${lines[i].trimEnd()} ${appendText}`;
			return lines.join("\n");
		}
	}
	return null;
}

export function markReminderDone(content: string, text: string): string | null {
	return setReminderState(content, text, "x");
}

/**
 * Appends `- [ ] text` to the ## Tasks section (after its last checkbox, or
 * right under the heading). Returns content unchanged when the text is
 * already present in any state, or null when the note has no Tasks heading.
 */
export function addReminderToTasks(content: string, text: string): string | null {
	const lines = content.split("\n");
	const headingIdx = findTasksHeadingIndex(lines);
	if (headingIdx < 0) return null;
	let insertAt = headingIdx + 1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (HEADING_OR_HR_RE.test(lines[i])) break;
		const m = REMINDER_ANY_RE.exec(lines[i]);
		if (m) {
			if (m[2] === text) return content;
			insertAt = i + 1;
		} else if (insertAt === i && INDENTED_CONTENT_RE.test(lines[i])) {
			// Indented subtasks/notes ride with the task above them — insert
			// after the whole group, not between a task and its children.
			insertAt = i + 1;
		}
	}
	lines.splice(insertAt, 0, `- [ ] ${text}`);
	return lines.join("\n");
}

/**
 * Line index of the reminder with this text (unchecked occurrences
 * preferred), or -1.
 */
export function findReminderLineIndex(content: string, text: string): number {
	const lines = content.split("\n");
	const headingIdx = findTasksHeadingIndex(lines);
	if (headingIdx < 0) return -1;
	let fallback = -1;
	for (let i = headingIdx + 1; i < lines.length; i++) {
		if (HEADING_OR_HR_RE.test(lines[i])) break;
		const m = REMINDER_ANY_RE.exec(lines[i]);
		if (m && m[2] === text) {
			if (m[1] === " ") return i;
			if (fallback < 0) fallback = i;
		}
	}
	return fallback;
}

function itemRange(item: SectionItem): TimeRange | null {
	if (item.kind === "block") return item.block.revised;
	if (item.kind === "meeting") return item.meeting.range;
	return null;
}

/**
 * Blocks and meetings sorted together by start time, unrecognized (raw)
 * lines preserved after.
 */
export function normalizeItems(items: SectionItem[]): SectionItem[] {
	const timed = items.filter((i) => i.kind !== "raw");
	timed.sort((a, b) => {
		const ra = itemRange(a) as TimeRange;
		const rb = itemRange(b) as TimeRange;
		return ra.start - rb.start || ra.end - rb.end;
	});
	const raws = items.filter((i) => i.kind === "raw");
	return [...timed, ...raws];
}

export function serializeItems(items: SectionItem[]): string[] {
	const normalized = normalizeItems(items);
	const out: string[] = [];
	const rawLines: string[] = [];
	for (const item of normalized) {
		if (item.kind === "raw") {
			rawLines.push(item.text);
		} else if (item.kind === "block") {
			out.push(serializeBlockHeading(item.block));
			out.push(...item.block.notes);
			out.push("");
		} else {
			out.push(serializeMeetingHeading(item.meeting));
			out.push(...item.meeting.notes);
			out.push("");
		}
	}
	if (rawLines.length > 0) {
		out.push(...rawLines);
		out.push("");
	}
	return out;
}

/**
 * Upserts calendar meetings into the item list (mutating it): matches
 * existing 📅 entries by title+start, then by title alone (a moved
 * meeting), updating times while preserving notes; inserts entries for new
 * meetings; un-cancels matched entries. Never deletes. When
 * `markCancellations` is true (i.e. the fetch verifiably succeeded),
 * entries absent from the calendar are marked cancelled — kept, with
 * notes, struck through. Returns whether anything changed.
 */
export function upsertMeetings(
	items: SectionItem[],
	calMeetings: { title: string; start: number; end: number }[],
	markCancellations = false
): boolean {
	let changed = false;
	const entries = items.filter(
		(i): i is { kind: "meeting"; meeting: MeetingEntry } =>
			i.kind === "meeting"
	);
	const unmatched = new Set(entries);
	const pending: { title: string; start: number; end: number }[] = [];

	const claim = (entry: { kind: "meeting"; meeting: MeetingEntry }) => {
		unmatched.delete(entry);
		if (entry.meeting.cancelled) {
			entry.meeting.cancelled = false; // meeting is back on the calendar
			changed = true;
		}
	};

	/** The entry's time on the calendar: `booked` once the user adjusted. */
	const calRange = (m: MeetingEntry): TimeRange => m.booked ?? m.range;

	/** Whitespace-insensitive title equality — defense against sources
	 * whose titles carry stray spaces the note round-trip would strip. */
	const sameTitle = (a: string, b: string) => a.trim() === b.trim();

	/**
	 * Applies the calendar's times: an adjusted entry keeps its user-set
	 * range and only tracks calendar changes in `booked`; an untouched
	 * entry follows the calendar directly.
	 */
	const applyCalTimes = (
		mm: MeetingEntry,
		m: { start: number; end: number }
	) => {
		if (mm.booked) {
			if (mm.booked.start !== m.start || mm.booked.end !== m.end) {
				mm.booked = { start: m.start, end: m.end };
				changed = true;
			}
			// calendar caught up with the adjustment → suffix no longer needed
			if (
				mm.booked.start === mm.range.start &&
				mm.booked.end === mm.range.end
			) {
				delete mm.booked;
				changed = true;
			}
		} else if (mm.range.start !== m.start || mm.range.end !== m.end) {
			mm.range = { start: m.start, end: m.end };
			changed = true;
		}
	};

	for (const m of calMeetings) {
		if (m.end <= m.start) continue;
		let found: { kind: "meeting"; meeting: MeetingEntry } | undefined;
		for (const e of unmatched) {
			if (
				sameTitle(e.meeting.title, m.title) &&
				calRange(e.meeting).start === m.start
			) {
				found = e;
				break;
			}
		}
		if (found) {
			claim(found);
			applyCalTimes(found.meeting, m);
		} else {
			pending.push(m);
		}
	}

	for (const m of pending) {
		let found: { kind: "meeting"; meeting: MeetingEntry } | undefined;
		for (const e of unmatched) {
			if (sameTitle(e.meeting.title, m.title)) {
				found = e;
				break;
			}
		}
		if (found) {
			claim(found);
			applyCalTimes(found.meeting, m);
		} else {
			items.push({
				kind: "meeting",
				meeting: {
					title: m.title.trim(),
					range: { start: m.start, end: m.end },
					notes: [],
					cancelled: false,
					skipped: false,
				},
			});
			changed = true;
		}
	}

	if (markCancellations) {
		for (const e of unmatched) {
			// Skipped entries already render struck through; marking them
			// cancelled would be lost on re-parse and re-flagged forever.
			if (!e.meeting.cancelled && !e.meeting.skipped) {
				e.meeting.cancelled = true;
				changed = true;
			}
		}
	}
	return changed;
}

/**
 * Replaces the plugin-managed region at the top of the `# Logs` section,
 * leaving the heading, the `➢` entries below, and every other line of the
 * note byte-identical. The heading itself is never removed.
 */
export function replaceTimeblocksSection(
	content: string,
	items: SectionItem[]
): string {
	const lines = content.split("\n");

	// Self-heal broken frontmatter: YAML frontmatter is only recognized when
	// `---` is the very first line, and stray blank lines above it (from
	// editor merge races / sync conflicts) break it. Blank lines at the top
	// of a note carry no meaning, so strip them whenever we write.
	let firstContent = 0;
	while (firstContent < lines.length && !lines[firstContent].trim()) {
		firstContent++;
	}
	if (firstContent > 0 && lines[firstContent]?.trim() === "---") {
		lines.splice(0, firstContent);
	}

	const body = serializeItems(items);
	const headingIdx = findHeadingIndex(lines, TIMEBLOCKS_HEADING);

	if (headingIdx >= 0) {
		const { endIdx } = parseLogsRegion(lines, headingIdx + 1);
		const region = body.length > 0 ? ["", ...body] : [""];
		lines.splice(headingIdx + 1, endIdx - (headingIdx + 1), ...region);
	} else {
		if (body.length === 0) return content;
		if (lines[lines.length - 1]?.trim() !== "") lines.push("");
		lines.push(TIMEBLOCKS_HEADING, "", ...body);
	}
	return lines.join("\n");
}
