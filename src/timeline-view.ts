import { App, ItemView, Modal, WorkspaceLeaf, moment, setIcon } from "obsidian";
import { isBreakTask } from "./retro";
import type TimeblocksPlugin from "./main";
import { TimeblockStore } from "./store";
import {
	MeetingEntry,
	TimeRange,
	Timeblock,
	displayTaskText,
	formatTime,
	serializeBlockHeading,
	serializeMeetingHeading,
} from "./parse";

export const VIEW_TYPE_TIMELINE = "timeblocks-timeline";

const PX_PER_MIN = 1;

type DragState =
	| { mode: "create"; anchor: number; el: HTMLElement }
	| {
			mode: "move";
			index: number;
			grabOffset: number;
			orig: TimeRange;
			cur: TimeRange;
			el: HTMLElement;
	  }
	| {
			mode: "resize";
			target: "block" | "meeting";
			index: number;
			edge: "start" | "end";
			orig: TimeRange;
			cur: TimeRange;
			el: HTMLElement;
	  };

export class TimelineView extends ItemView {
	private plugin: TimeblocksPlugin;
	private store: TimeblockStore;

	private scrollEl: HTMLElement | null = null;
	private gridEl!: HTMLElement;
	private contentAreaEl!: HTMLElement;
	private nowLineEl: HTMLElement | null = null;
	private popoverEl: HTMLElement | null = null;
	private syncEl: HTMLElement | null = null;

	private renderStart = 0;
	private renderEnd = 1440;
	private drag: DragState | null = null;
	private pendingRender = false;
	private resetScroll = true;
	private suppressMeetingClick = false;

	constructor(leaf: WorkspaceLeaf, plugin: TimeblocksPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = plugin.store;
	}

	getViewType() {
		return VIEW_TYPE_TIMELINE;
	}
	getDisplayText() {
		return "Timeblocks";
	}
	getIcon() {
		return "calendar-clock";
	}

	async onOpen() {
		this.registerEvent(
			this.store.on("changed", () => {
				if (this.drag) {
					this.pendingRender = true;
					return;
				}
				this.render();
			})
		);
		this.registerEvent(
			this.store.on("date-changed", () => {
				this.resetScroll = true;
			})
		);
		this.registerEvent(
			this.store.on("block-selection-changed", () =>
				this.updateSelectionClasses()
			)
		);
		this.registerEvent(
			this.plugin.calendar.on("calendar-changed", () => {
				if (this.drag) {
					this.pendingRender = true;
					return;
				}
				this.render();
			})
		);
		this.registerDomEvent(document, "keydown", (e) => {
			if (e.key !== "Escape") return;
			if (this.drag) this.cancelDrag();
			else this.closePopover();
		});
		this.registerDomEvent(document, "pointerdown", (e) => {
			const target = e.target as HTMLElement;
			if (
				this.popoverEl &&
				!this.popoverEl.contains(target) &&
				!target.closest(".tb-block") &&
				!target.closest(".tb-meeting-entry")
			) {
				this.closePopover();
			}
		});
		this.registerInterval(
			window.setInterval(() => {
				this.updateNowLine();
				this.updateSyncStatus();
			}, 60_000)
		);
		this.render();
	}

	private snap(): number {
		return Math.max(1, this.plugin.settings.snapMinutes);
	}

	// ---------------------------------------------------------------- render

	private render() {
		this.pendingRender = false;
		this.closePopover();
		const savedScroll =
			!this.resetScroll && this.scrollEl ? this.scrollEl.scrollTop : null;

		const root = this.contentEl;
		root.empty();
		root.addClass("tb-timeline");
		this.nowLineEl = null;
		this.scrollEl = null;

		// Header: ‹ date ›
		const header = root.createDiv("tb-header");
		const prev = header.createEl("button", { text: "‹", cls: "tb-nav" });
		const label = header.createDiv({
			cls: "tb-date",
			text: this.store.date.format("ddd, MMM D"),
		});
		label.setAttr("aria-label", "Go to today");
		const next = header.createEl("button", { text: "›", cls: "tb-nav" });
		prev.addEventListener("click", () =>
			this.store.setDate(this.store.date.clone().subtract(1, "day"))
		);
		next.addEventListener("click", () =>
			this.store.setDate(this.store.date.clone().add(1, "day"))
		);
		label.addEventListener("click", () => this.store.setDate(moment()));

		const startBtn = header.createEl("button", { cls: "tb-nav tb-action" });
		setIcon(startBtn, "play");
		startBtn.setAttr("aria-label", "Start selected task now");
		startBtn.addEventListener("click", () => this.plugin.startTaskNow());
		const breakBtn = header.createEl("button", { cls: "tb-nav tb-action" });
		setIcon(breakBtn, "coffee");
		breakBtn.setAttr("aria-label", "Start a break now");
		breakBtn.addEventListener("click", () => this.plugin.startBreakNow());

		// Plan/Track: what a block drag means. Plan = still estimating
		// (planned + revised move together, no ghost); Track = recording
		// the actual (plan preserved as a ghost).
		const modeBar = root.createDiv("tb-modebar");
		modeBar.createSpan({ cls: "tb-modebar-label", text: "Drag edits:" });
		const modes: ["plan" | "track", string, string][] = [
			["plan", "Plan", "Drags re-plan the block (no ghost)"],
			["track", "Track", "Drags record the actual (plan kept as ghost)"],
		];
		for (const [mode, label, tip] of modes) {
			const btn = modeBar.createEl("button", {
				text: label,
				cls: "tb-mode-btn",
			});
			btn.setAttr("aria-label", tip);
			btn.toggleClass("is-active", this.plugin.settings.dragMode === mode);
			btn.addEventListener("click", () => {
				if (this.plugin.settings.dragMode === mode) return;
				this.plugin.settings.dragMode = mode;
				void this.plugin.saveSettings(); // triggers a re-render
			});
		}

		if (!this.store.file) {
			root.createDiv({
				cls: "tb-empty",
				text: `No daily note for ${this.store.date.format("YYYY-MM-DD-ddd")}.`,
			});
			return;
		}

		const blocks: { block: Timeblock; index: number }[] = [];
		const meetingItems: { meeting: MeetingEntry; index: number }[] = [];
		this.store.items.forEach((item, index) => {
			if (item.kind === "block") blocks.push({ block: item.block, index });
			else if (item.kind === "meeting")
				meetingItems.push({ meeting: item.meeting, index });
		});

		// Async: fetches this day from Google if missing/stale, then emits
		// calendar-changed, which re-renders with the meetings included.
		this.plugin.calendar.ensureDay(this.store.date);
		// Calendar overlay: only meetings not already materialized as 📅
		// entries in the note (those render as interactive entries instead).
		const overlay = this.plugin.calendar
			.meetingsForDay(this.store.date)
			.filter(
				(m) =>
					!meetingItems.some(
						(e) =>
							e.meeting.title === m.title &&
							e.meeting.range.start === m.start
					)
			);

		// Visible range: settings hours, expanded to whole hours covering
		// all blocks and meetings.
		let startMin = this.plugin.settings.dayStartHour * 60;
		let endMin = this.plugin.settings.dayEndHour * 60;
		for (const { block } of blocks) {
			for (const r of [block.planned, block.revised]) {
				startMin = Math.min(startMin, Math.floor(r.start / 60) * 60);
				endMin = Math.max(endMin, Math.ceil(r.end / 60) * 60);
			}
		}
		for (const m of overlay) {
			startMin = Math.min(startMin, Math.floor(m.start / 60) * 60);
			endMin = Math.max(endMin, Math.ceil(m.end / 60) * 60);
		}
		for (const { meeting } of meetingItems) {
			startMin = Math.min(startMin, Math.floor(meeting.range.start / 60) * 60);
			endMin = Math.max(endMin, Math.ceil(meeting.range.end / 60) * 60);
		}
		this.renderStart = startMin;
		this.renderEnd = endMin;

		this.scrollEl = root.createDiv("tb-scroll");
		const grid = this.scrollEl.createDiv("tb-grid");
		this.gridEl = grid;
		grid.style.height = `${(endMin - startMin) * PX_PER_MIN}px`;

		for (let m = startMin; m <= endMin; m += 60) {
			const y = (m - startMin) * PX_PER_MIN;
			const line = grid.createDiv("tb-hourline");
			line.style.top = `${y}px`;
			if (m < endMin) {
				const lbl = grid.createDiv({
					cls: "tb-hourlabel",
					text: hourLabel(m),
				});
				lbl.style.top = `${y}px`;
			}
		}

		this.contentAreaEl = grid.createDiv("tb-content");

		const selectedIndex = this.store.selectedBlockIndex;

		// Calendar-only meetings: inert background layer under the blocks.
		// They don't capture pointer events, so dragging over them works.
		for (const m of overlay) {
			const el = this.contentAreaEl.createDiv("tb-meeting");
			this.positionEl(el, m.start, m.end);
			el.createDiv({ cls: "tb-meeting-title", text: m.title });
			if (m.end - m.start >= 30) {
				el.createDiv({
					cls: "tb-meeting-time",
					text: `${formatTime(m.start)}–${formatTime(m.end)}`,
				});
			}
		}

		// Materialized 📅 entries: same look, but clickable for notes and
		// resizable to record actual vs booked duration.
		for (const { meeting, index } of meetingItems) {
			const adjusted =
				meeting.booked &&
				(meeting.booked.start !== meeting.range.start ||
					meeting.booked.end !== meeting.range.end);
			if (adjusted && meeting.booked) {
				const ghost = this.contentAreaEl.createDiv("tb-ghost");
				this.positionEl(ghost, meeting.booked.start, meeting.booked.end);
				if (meeting.booked.end - meeting.booked.start >= 20) {
					ghost.createDiv({
						cls: "tb-ghost-label",
						text: `booked ${formatTime(meeting.booked.start)}–${formatTime(meeting.booked.end)}`,
					});
				}
			}
			const el = this.contentAreaEl.createDiv(
				"tb-meeting tb-meeting-entry"
			);
			el.dataset.index = String(index);
			el.toggleClass("is-cancelled", meeting.cancelled || meeting.skipped);
			el.toggleClass("is-selected", index === selectedIndex);
			this.positionEl(el, meeting.range.start, meeting.range.end);
			el.createDiv("tb-handle tb-handle-top");
			const titleLine = el.createDiv("tb-meeting-title");
			if (meeting.notes.length > 0) {
				titleLine.createSpan({ cls: "tb-note-dot", text: "•" });
			}
			titleLine.createSpan({ text: meeting.title });
			if (meeting.range.end - meeting.range.start >= 30) {
				el.createDiv({
					cls: "tb-meeting-time",
					text: `${formatTime(meeting.range.start)}–${formatTime(meeting.range.end)}`,
				});
			}
			el.createDiv("tb-handle tb-handle-bottom");
			el.addEventListener("click", () => {
				if (this.suppressMeetingClick) return;
				this.store.selectBlock(index);
				this.openPopover(index, el);
			});
			el.addEventListener("dblclick", () => {
				this.closePopover();
				void this.openInNote(index);
			});
		}
		const lanes = computeLanes(blocks.map((b) => b.block.revised));
		blocks.forEach(({ block, index }, i) => {
			const moved =
				block.planned.start !== block.revised.start ||
				block.planned.end !== block.revised.end;
			if (moved) {
				const ghost = this.contentAreaEl.createDiv("tb-ghost");
				this.positionEl(ghost, block.planned.start, block.planned.end);
				if (block.planned.end - block.planned.start >= 20) {
					ghost.createDiv({
						cls: "tb-ghost-label",
						text: `planned ${formatTime(block.planned.start)}–${formatTime(block.planned.end)}`,
					});
				}
			}

			const el = this.contentAreaEl.createDiv("tb-block");
			el.dataset.index = String(index);
			el.toggleClass("tb-break", isBreakTask(block.task));
			el.toggleClass("is-selected", index === selectedIndex);
			this.positionEl(el, block.revised.start, block.revised.end);
			const { lane, laneCount } = lanes[i];
			el.style.left = `${(lane / laneCount) * 100}%`;
			el.style.width = `calc(${100 / laneCount}% - 4px)`;

			el.createDiv("tb-handle tb-handle-top");
			const body = el.createDiv("tb-block-body");
			const taskLine = body.createDiv("tb-block-task");
			if (block.notes.length > 0) {
				taskLine.createSpan({ cls: "tb-note-dot", text: "•" });
			}
			taskLine.createSpan({ text: displayTaskText(block.task) });
			body.createDiv({
				cls: "tb-block-time",
				text: `${formatTime(block.revised.start)}–${formatTime(block.revised.end)}`,
			});
			el.createDiv("tb-handle tb-handle-bottom");

			const del = el.createDiv({ cls: "tb-delete", text: "×" });
			del.setAttr("aria-label", "Delete block");
			del.addEventListener("click", (ev) => {
				ev.stopPropagation();
				void this.store.deleteBlock(index);
			});
			el.addEventListener("dblclick", () => {
				this.closePopover();
				void this.openInNote(index);
			});
		});

		if (this.store.date.isSame(moment(), "day")) {
			this.nowLineEl = grid.createDiv("tb-nowline");
			this.updateNowLine();
		}

		grid.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		grid.addEventListener("pointermove", (e) => this.onPointerMove(e));
		grid.addEventListener("pointerup", (e) => this.onPointerUp(e));
		grid.addEventListener("pointercancel", () => this.cancelDrag());

		if (this.plugin.calendar.hasSources) {
			this.syncEl = root.createDiv("tb-sync-status");
			this.syncEl.setAttr("aria-label", "Refresh meetings now");
			this.syncEl.addEventListener("click", () => {
				this.syncEl?.setText("⟳ Syncing…");
				this.plugin.calendar.forceRefreshDay(this.store.date);
			});
			this.updateSyncStatus();
		} else {
			this.syncEl = null;
		}

		if (savedScroll !== null) {
			this.scrollEl.scrollTop = savedScroll;
		} else {
			this.resetScroll = false;
			const nowMin = currentMinutes();
			const target = this.store.date.isSame(moment(), "day")
				? (nowMin - this.renderStart) * PX_PER_MIN - 120
				: 0;
			this.scrollEl.scrollTop = Math.max(0, target);
		}
	}

	private updateSelectionClasses() {
		if (!this.contentAreaEl || !this.contentAreaEl.isConnected) return;
		const selected = this.store.selectedBlockIndex;
		this.contentAreaEl
			.querySelectorAll<HTMLElement>(".tb-block, .tb-meeting-entry")
			.forEach((el) => {
				el.toggleClass("is-selected", Number(el.dataset.index) === selected);
			});
	}

	private positionEl(el: HTMLElement, start: number, end: number) {
		el.style.top = `${(start - this.renderStart) * PX_PER_MIN}px`;
		el.style.height = `${(end - start) * PX_PER_MIN}px`;
	}

	private updateSyncStatus() {
		if (!this.syncEl || !this.syncEl.isConnected) return;
		const ts = this.plugin.calendar.lastSyncFor(this.store.date);
		if (ts === null) {
			this.syncEl.setText("⟳ Meetings: not synced yet — click to sync");
			return;
		}
		const mins = Math.floor((Date.now() - ts) / 60_000);
		const ago =
			mins < 1 ? "just now" : mins === 1 ? "1 min ago" : `${mins} mins ago`;
		this.syncEl.setText(`⟳ Meetings synced ${ago}`);
	}

	private updateNowLine() {
		if (!this.nowLineEl) return;
		const min = currentMinutes();
		if (min < this.renderStart || min > this.renderEnd) {
			this.nowLineEl.hide();
			return;
		}
		this.nowLineEl.show();
		this.nowLineEl.style.top = `${(min - this.renderStart) * PX_PER_MIN}px`;
	}

	// --------------------------------------------------------------- popover

	private closePopover() {
		this.popoverEl?.remove();
		this.popoverEl = null;
	}

	private openPopover(index: number, blockEl: HTMLElement) {
		this.closePopover();
		const target = this.store.notesTargetAt(index);
		if (!target) return;
		const block = this.store.blockAt(index);

		const pop = this.contentEl.createDiv("tb-popover");
		this.popoverEl = pop;

		pop.createDiv({
			cls: "tb-popover-title",
			text:
				(target.kind === "meeting" ? "📅 " : "") +
				displayTaskText(target.label),
		});
		const moved =
			block &&
			(block.planned.start !== block.revised.start ||
				block.planned.end !== block.revised.end);
		const item = this.store.items[index];
		const cancelled =
			item?.kind === "meeting" && item.meeting.cancelled;
		const booked =
			item?.kind === "meeting" ? item.meeting.booked : undefined;
		pop.createDiv({
			cls: "tb-popover-meta",
			text:
				`${formatTime(target.range.start)}–${formatTime(target.range.end)}` +
				(block && moved
					? ` · planned ${formatTime(block.planned.start)}–${formatTime(block.planned.end)}`
					: "") +
				(booked
					? ` · booked ${formatTime(booked.start)}–${formatTime(booked.end)}`
					: "") +
				(cancelled ? " · cancelled" : "") +
				(item?.kind === "meeting" && item.meeting.skipped
					? " · not attending"
					: ""),
		});

		const textarea = pop.createEl("textarea", {
			cls: "tb-notes-input",
			placeholder: "Notes (markdown)…",
		});
		textarea.value = target.notes.join("\n");
		textarea.rows = 4;

		const save = () => {
			void this.store.setNotes(index, textarea.value.split("\n"));
		};
		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
		});

		const buttons = pop.createDiv("tb-popover-buttons");
		const saveBtn = buttons.createEl("button", {
			text: "Save",
			cls: "mod-cta",
		});
		saveBtn.addEventListener("click", save);
		const openBtn = buttons.createEl("button", { text: "Open in note" });
		openBtn.addEventListener("click", () => {
			this.closePopover();
			void this.openInNote(index);
		});
		if (target.kind === "meeting" && item?.kind === "meeting") {
			const skipBtn = buttons.createEl("button", {
				text: item.meeting.skipped ? "Attending" : "Not attending",
			});
			skipBtn.setAttr(
				"aria-label",
				"Local only — the Google Calendar event is not changed"
			);
			skipBtn.addEventListener("click", () => {
				this.closePopover();
				void this.store.toggleMeetingSkipped(index);
			});
		}
		if (target.kind === "block") {
			if (this.store.hasOpenReminder(target.label)) {
				const doneBtn = buttons.createEl("button", {
					text: "✓ Mark task done",
				});
				doneBtn.addEventListener("click", () => {
					this.closePopover();
					void this.store.markReminderDone(target.label);
				});
			}
			const delBtn = buttons.createEl("button", {
				text: "Delete",
				cls: "tb-danger",
			});
			delBtn.addEventListener("click", () => {
				this.closePopover();
				void this.store.deleteBlock(index);
			});
		}

		// Position under the block, clamped inside the view.
		const rootRect = this.contentEl.getBoundingClientRect();
		const blockRect = blockEl.getBoundingClientRect();
		const top = Math.min(
			Math.max(blockRect.bottom - rootRect.top + 4, 44),
			rootRect.height - 200
		);
		pop.style.top = `${top}px`;

		window.setTimeout(() => textarea.focus(), 0);
	}

	/** Open the daily note in the main pane, cursor on this item's entry. */
	private async openInNote(index: number) {
		const file = this.store.file;
		const item = this.store.items[index];
		if (!file || !item || item.kind === "raw") return;
		const content = await this.app.vault.cachedRead(file);
		const lines = content.split("\n");
		const headingLine = (
			item.kind === "block"
				? serializeBlockHeading(item.block)
				: serializeMeetingHeading(item.meeting)
		).trim();
		let line = lines.findIndex((l) => l.trim() === headingLine);
		if (line < 0) line = lines.findIndex((l) => l.trim() === "# Logs");
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, {
			eState: { line: Math.max(line, 0) },
		});
	}

	// ------------------------------------------------------------------ drag

	private yToMin(e: PointerEvent): number {
		const rect = this.gridEl.getBoundingClientRect();
		const raw = (e.clientY - rect.top) / PX_PER_MIN + this.renderStart;
		const snapped = Math.round(raw / this.snap()) * this.snap();
		return Math.min(Math.max(snapped, this.renderStart), this.renderEnd);
	}

	private onPointerDown(e: PointerEvent) {
		if (e.button !== 0 || this.drag || !this.store.file) return;
		const target = e.target as HTMLElement;
		if (target.closest(".tb-delete")) return;

		// Meetings: resizable via their handles (recording actual vs booked
		// time); the body stays click-only (notes popover), never movable.
		const meetingEl = target.closest<HTMLElement>(".tb-meeting-entry");
		if (meetingEl) {
			const handle = target.closest<HTMLElement>(".tb-handle");
			if (!handle) return;
			const index = Number(meetingEl.dataset.index);
			const item = this.store.items[index];
			if (!item || item.kind !== "meeting") return;
			const orig = { ...item.meeting.range };
			this.drag = {
				mode: "resize",
				target: "meeting",
				index,
				edge: handle.classList.contains("tb-handle-top") ? "start" : "end",
				orig,
				cur: { ...orig },
				el: meetingEl,
			};
			meetingEl.addClass("is-dragging");
			this.gridEl.setPointerCapture(e.pointerId);
			e.preventDefault();
			return;
		}

		const min = this.yToMin(e);
		const blockEl = target.closest<HTMLElement>(".tb-block");

		if (blockEl) {
			const index = Number(blockEl.dataset.index);
			const block = this.store.blockAt(index);
			if (!block) return;
			const orig = { ...block.revised };
			const handle = target.closest<HTMLElement>(".tb-handle");
			if (handle) {
				this.drag = {
					mode: "resize",
					target: "block",
					index,
					edge: handle.classList.contains("tb-handle-top") ? "start" : "end",
					orig,
					cur: { ...orig },
					el: blockEl,
				};
			} else {
				this.drag = {
					mode: "move",
					index,
					grabOffset: min - orig.start,
					orig,
					cur: { ...orig },
					el: blockEl,
				};
			}
			blockEl.addClass("is-dragging");
		} else {
			const el = this.contentAreaEl.createDiv("tb-draft");
			this.positionEl(el, min, min);
			this.drag = { mode: "create", anchor: min, el };
		}
		this.gridEl.setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	private onPointerMove(e: PointerEvent) {
		const d = this.drag;
		if (!d) return;
		const min = this.yToMin(e);

		if (d.mode === "create") {
			const start = Math.min(d.anchor, min);
			const end = Math.max(d.anchor, min);
			this.positionEl(d.el, start, end);
		} else if (d.mode === "move") {
			const dur = d.orig.end - d.orig.start;
			let start =
				Math.round((min - d.grabOffset) / this.snap()) * this.snap();
			start = Math.min(
				Math.max(start, this.renderStart),
				this.renderEnd - dur
			);
			d.cur = { start, end: start + dur };
			this.positionEl(d.el, d.cur.start, d.cur.end);
		} else {
			const cur = { ...d.cur };
			if (d.edge === "start") {
				cur.start = Math.min(min, d.orig.end - this.snap());
			} else {
				cur.end = Math.max(min, d.orig.start + this.snap());
			}
			d.cur = cur;
			this.positionEl(d.el, cur.start, cur.end);
		}
	}

	private onPointerUp(e: PointerEvent) {
		const d = this.drag;
		this.drag = null;
		if (!d) return;

		if (d.mode === "create") {
			d.el.remove();
			const min = this.yToMin(e);
			const start = Math.min(d.anchor, min);
			const end = Math.max(d.anchor, min);
			if (end - start >= this.snap()) {
				const range = { start, end };
				const task = this.store.selectedTask;
				if (task) {
					void this.store.createBlock(range, task);
				} else {
					new TaskNameModal(this.app, (name) =>
						void this.store.createBlock(range, name)
					).open();
				}
			}
			if (this.pendingRender) this.render();
			return;
		}

		d.el.removeClass("is-dragging");
		const changed = d.cur.start !== d.orig.start || d.cur.end !== d.orig.end;
		if (d.mode === "resize" && d.target === "meeting") {
			// The entry's click listener fires after pointerup — swallow it
			// so resizing doesn't also pop the notes popover.
			this.suppressMeetingClick = true;
			window.setTimeout(() => (this.suppressMeetingClick = false), 150);
		}
		if (changed) {
			if (d.mode === "resize" && d.target === "meeting") {
				void this.store.updateMeetingRange(d.index, d.cur);
			} else if (this.plugin.settings.dragMode === "plan") {
				void this.store.updatePlan(d.index, d.cur);
			} else {
				void this.store.updateRevised(d.index, d.cur);
			}
			return; // commit triggers a re-render
		}
		if (this.pendingRender) {
			this.render();
			return;
		}
		if (d.mode === "move") {
			// A click, not a drag: select the block and show its notes.
			this.store.selectBlock(d.index);
			this.openPopover(d.index, d.el);
		}
	}

	private cancelDrag() {
		const d = this.drag;
		this.drag = null;
		if (!d) return;
		if (d.mode === "create") d.el.remove();
		this.render();
	}
}

// -------------------------------------------------------------------- utils

function currentMinutes(): number {
	const now = moment();
	return now.hours() * 60 + now.minutes();
}

function hourLabel(min: number): string {
	const h = Math.floor(min / 60) % 24;
	const display = ((h + 11) % 12) + 1;
	return `${display} ${h < 12 ? "AM" : "PM"}`;
}

/** Greedy lane assignment: overlapping blocks share the width of their cluster. */
export function computeLanes(
	ranges: TimeRange[]
): { lane: number; laneCount: number }[] {
	const order = ranges
		.map((_, i) => i)
		.sort(
			(a, b) =>
				ranges[a].start - ranges[b].start || ranges[a].end - ranges[b].end
		);
	const result = ranges.map(() => ({ lane: 0, laneCount: 1 }));

	let cluster: number[] = [];
	let laneEnds: number[] = [];
	let clusterEnd = -1;
	const flush = () => {
		for (const i of cluster) result[i].laneCount = laneEnds.length;
		cluster = [];
		laneEnds = [];
	};

	for (const i of order) {
		const r = ranges[i];
		if (cluster.length > 0 && r.start >= clusterEnd) flush();
		let lane = laneEnds.findIndex((end) => end <= r.start);
		if (lane === -1) {
			lane = laneEnds.length;
			laneEnds.push(r.end);
		} else {
			laneEnds[lane] = Math.max(laneEnds[lane], r.end);
		}
		result[i].lane = lane;
		cluster.push(i);
		clusterEnd = Math.max(clusterEnd, r.end);
	}
	flush();
	return result;
}

export class TaskNameModal extends Modal {
	private onSubmit: (name: string) => void;

	constructor(app: App, onSubmit: (name: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		this.titleEl.setText("Timeblock task");
		const input = this.contentEl.createEl("input", {
			type: "text",
			placeholder: "Task name",
		});
		input.style.width = "100%";
		const submit = () => {
			const value = input.value.trim();
			this.close();
			if (value) this.onSubmit(value);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		const buttons = this.contentEl.createDiv("modal-button-container");
		const create = buttons.createEl("button", {
			text: "Create",
			cls: "mod-cta",
		});
		create.addEventListener("click", submit);
		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
