/**
 * Derived day-retro summary: built from the parsed items and regenerated on
 * every write, so it can never go stale. Pure functions — no Obsidian
 * imports, testable with plain node.
 */
import { SectionItem, TimeRange, Timeblock, formatTime } from "./parse";

export const RETRO_HEADING = "## Retro";

export function isBreakTask(task: string): boolean {
	return /(^|\s)#break\b/i.test(task);
}

function minutes(r: TimeRange): number {
	return r.end - r.start;
}

function dur(mins: number): string {
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	if (h > 0 && m > 0) return `${h}h ${m}m`;
	if (h > 0) return `${h}h`;
	return `${m}m`;
}

function signedDur(mins: number): string {
	if (mins === 0) return "";
	return `${mins > 0 ? "+" : "−"}${dur(Math.abs(mins))}`;
}

function cell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

/** Returns the callout body lines, or null when there is nothing to report. */
export function buildRetroLines(items: SectionItem[]): string[] | null {
	const focus: Timeblock[] = [];
	const breaks: Timeblock[] = [];
	let meetingMins = 0;
	let meetingCount = 0;

	for (const item of items) {
		if (item.kind === "block") {
			(isBreakTask(item.block.task) ? breaks : focus).push(item.block);
		} else if (
			item.kind === "meeting" &&
			!item.meeting.cancelled &&
			!item.meeting.skipped
		) {
			meetingMins += minutes(item.meeting.range);
			meetingCount++;
		}
	}
	if (focus.length === 0 && breaks.length === 0 && meetingCount === 0) {
		return null;
	}

	const plannedMins = focus.reduce((s, b) => s + minutes(b.planned), 0);
	const actualMins = focus.reduce((s, b) => s + minutes(b.revised), 0);
	const breakMins = breaks.reduce((s, b) => s + minutes(b.revised), 0);

	const lines: string[] = ["> [!summary] Day retro"];

	if (focus.length > 0) {
		let line = `> **Focus**: ${dur(actualMins)} across ${focus.length} block${focus.length === 1 ? "" : "s"}`;
		if (plannedMins > 0 && plannedMins !== actualMins) {
			const pct = Math.round(((actualMins - plannedMins) / plannedMins) * 100);
			line += ` (planned ${dur(plannedMins)}, ${pct > 0 ? "+" : ""}${pct}%)`;
		} else if (plannedMins > 0) {
			line += ` (planned ${dur(plannedMins)}, on target)`;
		}
		lines.push(line);
	}

	const parts: string[] = [];
	if (meetingCount > 0) {
		parts.push(
			`**Meetings**: ${dur(meetingMins)} across ${meetingCount}`
		);
	}
	if (breaks.length > 0) {
		parts.push(`**Breaks**: ${dur(breakMins)} across ${breaks.length}`);
	}
	if (parts.length > 0) lines.push(`> ${parts.join(" · ")}`);

	if (focus.length > 0) {
		lines.push(">");
		lines.push("> | Task | Planned | Actual | Δ |");
		lines.push("> | --- | --- | --- | --- |");
		for (const b of focus) {
			const p = b.planned;
			const r = b.revised;
			lines.push(
				`> | ${cell(b.task)} | ${formatTime(p.start)}–${formatTime(p.end)} · ${dur(minutes(p))} | ${formatTime(r.start)}–${formatTime(r.end)} · ${dur(minutes(r))} | ${signedDur(minutes(r) - minutes(p))} |`
			);
		}
	}
	return lines;
}

/**
 * Replaces (or inserts/removes) the generated `## Retro` section: a `---`
 * divider, the heading, and the contiguous run of callout (`>`) and blank
 * lines after it — anything else a user writes below survives regeneration.
 * A blank line always precedes the divider so it can't turn the previous
 * paragraph into a setext heading.
 */
export function replaceRetroSection(
	content: string,
	lines: string[] | null
): string {
	const all = content.split("\n");
	let idx = -1;
	for (let i = 0; i < all.length; i++) {
		if (all[i].trim() === RETRO_HEADING) {
			idx = i;
			break;
		}
	}

	if (idx >= 0) {
		let j = idx + 1;
		while (j < all.length && (!all[j].trim() || all[j].startsWith(">"))) j++;
		// Treat an existing divider directly above (past blanks) as part of
		// the generated section, so regeneration stays idempotent.
		let start = idx;
		let k = idx - 1;
		while (k >= 0 && !all[k].trim()) k--;
		if (k >= 0 && all[k].trim() === "---") start = k;
		if (lines) {
			const section: string[] = [];
			if (start > 0 && all[start - 1].trim() !== "") section.push("");
			section.push("---", RETRO_HEADING, "", ...lines, "");
			all.splice(start, j - start, ...section);
		} else {
			all.splice(start, j - start);
		}
	} else if (lines) {
		if (all[all.length - 1]?.trim() !== "") all.push("");
		all.push("---", RETRO_HEADING, "", ...lines, "");
	}
	return all.join("\n");
}
