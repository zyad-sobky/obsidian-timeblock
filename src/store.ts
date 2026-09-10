import { App, Events, Notice, TFile, debounce, moment } from "obsidian";
import type { Moment } from "moment";
import type TimeblocksPlugin from "./main";
import { buildRetroLines, replaceRetroSection } from "./retro";
import {
	LOGS_FOLDER,
	Leftover,
	SectionItem,
	TimeRange,
	Timeblock,
	computeLeftovers,
	extractReminderStates,
	extractReminders,
	extractTimeblocks,
	addReminderToTasks,
	findReminderLineIndex,
	setReminderState,
	normalizeItems,
	replaceTimeblocksSection,
	upsertMeetings,
} from "./parse";

/** Stable-ish identity for a block/meeting item across re-parses. */
function itemKey(item: SectionItem | undefined): string | null {
	if (!item) return null;
	if (item.kind === "block") {
		const b = item.block;
		return `b|${b.revised.start}-${b.revised.end}|${b.task}`;
	}
	if (item.kind === "meeting") {
		const m = item.meeting;
		return `m|${m.range.start}-${m.range.end}|${m.title}`;
	}
	return null;
}

/** What the notes editors need, for either a block or a meeting. */
export interface NotesTarget {
	kind: "block" | "meeting";
	label: string;
	range: TimeRange;
	notes: string[];
}

/**
 * Single source of truth shared by both views. Emits:
 *  - "date-changed"            the viewed day changed
 *  - "changed"                 blocks/reminders/file state changed
 *  - "selection-changed"       the task selected in the tasks view changed
 *  - "block-selection-changed" the block selected on the timeline changed
 */
export class TimeblockStore extends Events {
	app: App;
	date: Moment;
	file: TFile | null = null;
	items: SectionItem[] = [];
	reminders: string[] = [];
	/** unchecked reminders from previous days (deduped, newest first) */
	leftovers: Leftover[] = [];
	selectedTask: string | null = null;
	/**
	 * True while the viewed day was set to "today" — lets the midnight
	 * rollover advance the view without hijacking deliberate navigation
	 * to other days.
	 */
	followsToday = true;
	/** Selected block, tracked by content key so it survives re-parses. */
	private selectedBlockKey: string | null = null;

	scheduleReload = debounce(() => void this.reload(), 500, true);

	constructor(private plugin: TimeblocksPlugin) {
		super();
		this.app = plugin.app;
		this.date = moment().locale("en");
	}

	setDate(d: Moment) {
		this.date = d.clone().locale("en");
		this.followsToday = this.date.isSame(moment(), "day");
		this.selectBlock(null);
		this.trigger("date-changed");
		this.refresh();
	}

	/** Re-resolve the daily note for the current date and reload. */
	refresh() {
		this.file = this.resolveFile();
		void this.reload();
	}

	private resolveFile(): TFile | null {
		return this.resolveFileFor(this.date);
	}

	private resolveFileFor(date: Moment): TFile | null {
		const exact = `${LOGS_FOLDER}/${date.format("YYYY-MM-DD-ddd")}.md`;
		const af = this.app.vault.getAbstractFileByPath(exact);
		if (af instanceof TFile) return af;
		// Legacy notes: "1. Logs/5-25/2025-05-18-Monday.md" or bare "YYYY-MM-DD".
		const dayStr = date.format("YYYY-MM-DD");
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(LOGS_FOLDER + "/")) continue;
			if (f.basename === dayStr || f.basename.startsWith(dayStr + "-")) return f;
		}
		return null;
	}

	async reload() {
		let excludeTexts = new Set<string>();
		if (!this.file) {
			this.items = [];
			this.reminders = [];
		} else {
			const content = await this.app.vault.cachedRead(this.file);
			this.items = extractTimeblocks(content);
			this.reminders = extractReminders(content);
			excludeTexts = new Set(
				extractReminderStates(content).map((r) => r.text)
			);
		}
		this.leftovers = await this.loadLeftovers(excludeTexts);
		if (this.selectedBlockKey !== null && this.selectedBlockIndex === null) {
			this.selectedBlockKey = null;
			this.trigger("block-selection-changed");
		}
		this.trigger("changed");
	}

	/**
	 * Scans daily notes in the lookback window before the viewed day and
	 * collects reminders whose latest occurrence is still unchecked.
	 */
	private async loadLeftovers(excludeTexts: Set<string>): Promise<Leftover[]> {
		const lookback = Math.max(
			1,
			this.plugin.settings.leftoverLookbackDays
		);
		const viewed = this.date.clone().startOf("day");
		const minDate = viewed.clone().subtract(lookback, "days");
		const candidates: { file: TFile; day: Moment }[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(LOGS_FOLDER + "/")) continue;
			const dateStr = f.basename.slice(0, 10);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
			const day = moment(dateStr, "YYYY-MM-DD", true);
			if (!day.isValid()) continue;
			if (!day.isBefore(viewed) || day.isBefore(minDate)) continue;
			candidates.push({ file: f, day });
		}
		candidates.sort((a, b) => a.day.valueOf() - b.day.valueOf());
		const days: {
			from: string;
			path: string;
			reminders: { text: string; done: boolean }[];
		}[] = [];
		for (const c of candidates) {
			try {
				const content = await this.app.vault.cachedRead(c.file);
				days.push({
					from: c.day.locale("en").format("MMM D"),
					path: c.file.path,
					reminders: extractReminderStates(content),
				});
			} catch {
				// unreadable note — skip it
			}
		}
		return computeLeftovers(days, excludeTexts);
	}

	blockAt(index: number): Timeblock | null {
		const item = this.items[index];
		return item && item.kind === "block" ? item.block : null;
	}

	notesTargetAt(index: number): NotesTarget | null {
		const item = this.items[index];
		if (!item) return null;
		if (item.kind === "block") {
			return {
				kind: "block",
				label: item.block.task,
				range: item.block.revised,
				notes: item.block.notes,
			};
		}
		if (item.kind === "meeting") {
			return {
				kind: "meeting",
				label: item.meeting.title,
				range: item.meeting.range,
				notes: item.meeting.notes,
			};
		}
		return null;
	}

	get selectedBlockIndex(): number | null {
		if (this.selectedBlockKey === null) return null;
		const idx = this.items.findIndex(
			(it) => itemKey(it) === this.selectedBlockKey
		);
		return idx >= 0 ? idx : null;
	}

	selectBlock(index: number | null) {
		const key = index !== null ? itemKey(this.items[index]) : null;
		if (key === this.selectedBlockKey) return;
		this.selectedBlockKey = key;
		this.trigger("block-selection-changed");
	}

	async createBlock(range: TimeRange, task: string) {
		if (!this.file) return;
		this.items.push({
			kind: "block",
			block: {
				task,
				planned: { ...range },
				revised: { ...range },
				notes: [],
			},
		});
		await this.commit();
	}

	/** Track-mode move/resize: updates revised only — planned is preserved. */
	async updateRevised(index: number, range: TimeRange) {
		const item = this.items[index];
		if (!item || item.kind !== "block") return;
		const wasSelected = itemKey(item) === this.selectedBlockKey;
		item.block.revised = { ...range };
		if (wasSelected) this.selectedBlockKey = itemKey(item);
		await this.commit();
	}

	/**
	 * Plan-mode move/resize: this is still the estimate, so planned and
	 * revised move together and any existing ghost collapses.
	 */
	async updatePlan(index: number, range: TimeRange) {
		const item = this.items[index];
		if (!item || item.kind !== "block") return;
		const wasSelected = itemKey(item) === this.selectedBlockKey;
		item.block.planned = { ...range };
		item.block.revised = { ...range };
		if (wasSelected) this.selectedBlockKey = itemKey(item);
		await this.commit();
	}

	/**
	 * User adjustment of a meeting's actual time. The calendar's time is
	 * frozen into `booked` on first adjustment (so sync can still match the
	 * meeting and won't overwrite the range); adjusting back to the booked
	 * time exactly drops the suffix.
	 */
	async updateMeetingRange(index: number, range: TimeRange) {
		const item = this.items[index];
		if (!item || item.kind !== "meeting") return;
		const m = item.meeting;
		const wasSelected = itemKey(item) === this.selectedBlockKey;
		const booked = m.booked ?? { ...m.range };
		if (booked.start === range.start && booked.end === range.end) {
			delete m.booked;
		} else {
			m.booked = booked;
		}
		m.range = { ...range };
		if (wasSelected) this.selectedBlockKey = itemKey(item);
		await this.commit();
	}

	/** Local "not attending" toggle — the calendar is not touched. */
	async toggleMeetingSkipped(index: number) {
		const item = this.items[index];
		if (!item || item.kind !== "meeting") return;
		item.meeting.skipped = !item.meeting.skipped;
		await this.commit();
	}

	async setNotes(index: number, notes: string[]) {
		const item = this.items[index];
		if (!item || item.kind === "raw") return;
		const clean = [...notes];
		while (clean.length > 0 && !clean[clean.length - 1].trim()) clean.pop();
		if (item.kind === "block") item.block.notes = clean;
		else item.meeting.notes = clean;
		await this.commit();
	}

	async deleteBlock(index: number) {
		const item = this.items[index];
		if (!item || item.kind !== "block") return;
		if (itemKey(item) === this.selectedBlockKey) this.selectBlock(null);
		this.items.splice(index, 1);
		await this.commit();
	}

	/**
	 * Upserts today's calendar meetings as 📅 entries; writes only on
	 * change. Pass markCancellations only when the fetch verifiably
	 * succeeded — entries absent from it are then struck through.
	 */
	async syncMeetings(
		meetings: { title: string; start: number; end: number }[],
		markCancellations = false
	) {
		if (!this.file) return;
		if (!upsertMeetings(this.items, meetings, markCancellations)) return;
		await this.commit();
	}

	setSelectedTask(task: string | null) {
		this.selectedTask = task;
		this.trigger("selection-changed");
	}

	/** The note holding this task's open reminder: today's, or a leftover's. */
	reminderFileFor(text: string): TFile | null {
		if (this.file && this.reminders.includes(text)) return this.file;
		const leftover = this.leftovers.find((l) => l.text === text);
		if (!leftover) return null;
		const af = this.app.vault.getAbstractFileByPath(leftover.path);
		return af instanceof TFile ? af : null;
	}

	hasOpenReminder(text: string): boolean {
		return this.reminderFileFor(text) !== null;
	}

	private async writeReminderState(
		text: string,
		marker: "x" | "-"
	): Promise<boolean> {
		const file = this.reminderFileFor(text);
		if (!file) {
			new Notice(`No open task found for: ${text}`);
			return false;
		}
		let changed = false;
		await this.app.vault.process(file, (content) => {
			const out = setReminderState(content, text, marker);
			if (out !== null) {
				changed = true;
				return out;
			}
			return content;
		});
		// Leftover files aren't watched by the modify handler — reload directly.
		void this.reload();
		return changed;
	}

	/** Checks off the original `- [ ]` reminder wherever it lives. */
	async markReminderDone(text: string): Promise<boolean> {
		const changed = await this.writeReminderState(text, "x");
		if (changed) new Notice(`Marked done: ${text}`);
		return changed;
	}

	/** Archives the reminder in place: `- [ ]` becomes `- [-]` (cancelled). */
	async archiveReminder(text: string): Promise<boolean> {
		const changed = await this.writeReminderState(text, "-");
		if (changed) new Notice(`Archived: ${text}`);
		return changed;
	}

	/**
	 * Moves a leftover into today's note: appends `- [ ] text` to today's
	 * ## Tasks and marks the original `- [>]` (forwarded).
	 */
	async moveReminderToToday(text: string) {
		const source = this.reminderFileFor(text);
		if (!source) {
			new Notice(`No open task found for: ${text}`);
			return;
		}
		const todayFile = this.resolveFileFor(moment().locale("en"));
		if (!todayFile) {
			new Notice("No daily note for today yet — create it first.");
			return;
		}
		if (source.path === todayFile.path) {
			new Notice("That task is already in today's note.");
			return;
		}
		let added = false;
		await this.app.vault.process(todayFile, (content) => {
			const out = addReminderToTasks(content, text);
			if (out !== null) {
				added = true;
				return out;
			}
			return content;
		});
		if (!added) {
			new Notice("Today's note has no ## Tasks section.");
			return;
		}
		await this.app.vault.process(source, (content) => {
			const annotation = `(moved to [[${todayFile.basename}]])`;
			return setReminderState(content, text, ">", annotation) ?? content;
		});
		void this.reload();
		new Notice(`Moved to today: ${text}`);
	}

	/** Opens the note containing this reminder, cursor on its line. */
	async openReminderInNote(text: string) {
		const file = this.reminderFileFor(text);
		if (!file) return;
		const content = await this.app.vault.cachedRead(file);
		const line = findReminderLineIndex(content, text);
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line: Math.max(line, 0) } });
	}

	/**
	 * Quick action: creates a block starting at the current minute (exact,
	 * not snapped — actuals should be truthful). Any block still running is
	 * trimmed to end now, mirroring the log-line convention where a new
	 * entry ends the previous one. Jumps the views to today first.
	 */
	async startNow(task: string, durationMinutes: number) {
		const today = moment().locale("en");
		if (!this.date.isSame(today, "day")) {
			this.date = today;
			this.followsToday = true;
			this.trigger("date-changed");
			this.file = this.resolveFile();
			await this.reload();
		}
		if (!this.file) {
			new Notice("No daily note for today yet — create it first.");
			return;
		}
		const start = today.hours() * 60 + today.minutes();
		const end = Math.min(start + Math.max(1, durationMinutes), 1440);
		if (end <= start) return;
		for (const item of this.items) {
			if (item.kind !== "block") continue;
			const r = item.block.revised;
			if (r.start < start && r.end > start) {
				item.block.revised = { ...r, end: start };
			}
		}
		this.items.push({
			kind: "block",
			block: {
				task,
				planned: { start, end },
				revised: { start, end },
				notes: [],
			},
		});
		await this.commit();
	}

	/** Rewrites the note's derived sections (e.g. after toggling settings). */
	async refreshDerived() {
		if (!this.file) return;
		await this.commit();
	}

	private async commit() {
		// Keep in-memory order identical to the serialized order so that
		// item indexes stay valid between the write and the debounced reload.
		this.items = normalizeItems(this.items);
		if (this.file) {
			await this.app.vault.process(this.file, (content) => {
				let out = replaceTimeblocksSection(content, this.items);
				if (this.plugin.settings.autoRetro) {
					out = replaceRetroSection(out, buildRetroLines(this.items));
				}
				return out;
			});
		}
		this.trigger("changed");
	}
}
