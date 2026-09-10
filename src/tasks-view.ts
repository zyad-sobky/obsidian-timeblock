import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon } from "obsidian";
import type TimeblocksPlugin from "./main";
import { TimeblockStore } from "./store";
import { displayTaskText, formatTime } from "./parse";

export const VIEW_TYPE_TASKS = "timeblocks-tasks";

export class TasksView extends ItemView {
	private plugin: TimeblocksPlugin;
	private store: TimeblockStore;
	private dateEl!: HTMLElement;
	private inputEl!: HTMLInputElement;
	private listEl!: HTMLElement;
	private leftoverEl!: HTMLElement;
	private hintEl!: HTMLElement;
	private blockSectionEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: TimeblocksPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.store = plugin.store;
	}

	getViewType() {
		return VIEW_TYPE_TASKS;
	}
	getDisplayText() {
		return "Timeblock tasks";
	}
	getIcon() {
		return "list-todo";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("tb-tasks");

		this.dateEl = root.createDiv("tb-tasks-date");
		const wrap = root.createDiv("tb-input-wrap");
		this.inputEl = wrap.createEl("input", {
			type: "text",
			placeholder: "Something else…",
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			const value = this.inputEl.value.trim();
			this.store.setSelectedTask(value || null);
		});

		this.listEl = root.createDiv("tb-tasks-list");
		this.leftoverEl = root.createDiv("tb-leftovers");
		this.hintEl = root.createDiv("tb-selection-hint");
		this.blockSectionEl = root.createDiv("tb-block-section");

		this.registerEvent(
			this.store.on("changed", () => {
				this.renderTasks();
				this.renderBlockSection();
			})
		);
		this.registerEvent(
			this.store.on("date-changed", () => {
				this.renderTasks();
				this.renderBlockSection();
			})
		);
		this.registerEvent(
			this.store.on("selection-changed", () => this.updateSelection())
		);
		this.registerEvent(
			this.store.on("block-selection-changed", () => this.renderBlockSection())
		);
		this.renderTasks();
		this.renderBlockSection();
	}

	private renderTasks() {
		this.dateEl.setText(this.store.date.format("ddd, MMM D"));
		this.listEl.empty();

		if (!this.store.file) {
			this.listEl.createDiv({
				cls: "tb-empty",
				text: "No daily note for this day.",
			});
		} else if (this.store.reminders.length === 0) {
			this.listEl.createDiv({
				cls: "tb-empty",
				text: "No open tasks in this note.",
			});
		} else {
			for (const text of this.store.reminders) {
				this.addTaskRow(this.listEl, text);
			}
		}
		this.renderLeftovers();
		this.updateSelection();
	}

	private addTaskRow(parent: HTMLElement, text: string, from?: string) {
		const row = parent.createDiv("tb-task-row");
		row.dataset.task = text;
		const checkbox = row.createEl("input", {
			type: "checkbox",
			cls: "tb-task-check",
		});
		checkbox.setAttr("aria-label", "Mark task done");
		checkbox.addEventListener("click", (e) => e.stopPropagation());
		checkbox.addEventListener("change", () => {
			checkbox.disabled = true;
			void this.store.markReminderDone(text);
		});
		const textSpan = row.createSpan({ cls: "tb-task-text" });
		void MarkdownRenderer.render(
			this.app,
			text,
			textSpan,
			this.store.file?.path ?? "",
			this
		);
		// Clicks on rendered internal links navigate; anywhere else selects.
		textSpan.addEventListener("click", (e) => {
			const link = (e.target as HTMLElement).closest("a.internal-link");
			if (!link) return;
			e.preventDefault();
			e.stopPropagation();
			const href =
				link.getAttribute("data-href") ?? link.getAttribute("href");
			if (href) {
				void this.app.workspace.openLinkText(
					href,
					this.store.file?.path ?? "",
					false
				);
			}
		});
		if (from) {
			row.createSpan({ cls: "tb-leftover-date", text: from });
			const moveBtn = row.createEl("button", { cls: "tb-task-archive" });
			setIcon(moveBtn, "calendar-plus");
			moveBtn.setAttr("aria-label", "Move to today (marks the original - [>])");
			moveBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.store.moveReminderToToday(text);
			});
			const archiveBtn = row.createEl("button", { cls: "tb-task-archive" });
			setIcon(archiveBtn, "archive");
			archiveBtn.setAttr("aria-label", "Archive (marks the reminder - [-])");
			archiveBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.store.archiveReminder(text);
			});
		}
		row.addEventListener("click", () => {
			this.store.setSelectedTask(
				this.store.selectedTask === text ? null : text
			);
		});
		row.addEventListener("dblclick", () => {
			void this.store.openReminderInNote(text);
		});
	}

	/** Collapsible "Previous days" section of unchecked older reminders. */
	private renderLeftovers() {
		this.leftoverEl.empty();
		const leftovers = this.store.leftovers;
		if (!this.store.file || leftovers.length === 0) return;

		const expanded = this.plugin.settings.showLeftovers;
		const header = this.leftoverEl.createDiv("tb-leftover-header");
		header.createSpan({
			cls: "tb-leftover-chevron",
			text: expanded ? "▾" : "▸",
		});
		header.createSpan({ text: `Previous days (${leftovers.length})` });
		header.addEventListener("click", () => {
			this.plugin.settings.showLeftovers = !expanded;
			void this.plugin.saveSettings();
			this.renderLeftovers();
			this.updateSelection();
		});

		if (!expanded) return;
		const list = this.leftoverEl.createDiv("tb-tasks-list");
		for (const l of leftovers) {
			this.addTaskRow(list, l.text, l.from);
		}
	}

	private updateSelection() {
		const selected = this.store.selectedTask;
		this.contentEl.querySelectorAll<HTMLElement>(".tb-task-row").forEach((el) => {
			el.toggleClass("is-selected", el.dataset.task === selected);
		});
		const isReminder =
			!!selected &&
			(this.store.reminders.includes(selected) ||
				this.store.leftovers.some((l) => l.text === selected));
		if (isReminder) this.inputEl.value = "";
		this.inputEl.toggleClass(
			"is-selected",
			!!selected && !isReminder && this.inputEl.value.trim() === selected
		);
		this.hintEl.setText(
			selected
				? `Drag on the timeline to block time for: ${displayTaskText(selected)}`
				: "Select a task (or type one), then drag on the timeline."
		);
	}

	/** Notes editor for the block selected on the timeline. */
	private renderBlockSection() {
		// Don't clobber the textarea while the user is typing in it.
		if (this.blockSectionEl.contains(document.activeElement)) return;

		this.blockSectionEl.empty();
		const index = this.store.selectedBlockIndex;
		if (index === null) return;
		const target = this.store.notesTargetAt(index);
		if (!target) return;

		this.blockSectionEl.createDiv({
			cls: "tb-block-section-title",
			text: target.kind === "meeting" ? "Selected meeting" : "Selected block",
		});
		this.blockSectionEl.createDiv({
			cls: "tb-block-section-meta",
			text: `${target.kind === "meeting" ? "📅 " : ""}${displayTaskText(target.label)} · ${formatTime(target.range.start)}–${formatTime(target.range.end)}`,
		});
		const textarea = this.blockSectionEl.createEl("textarea", {
			cls: "tb-notes-input",
			placeholder: "Notes (markdown)…",
		});
		textarea.value = target.notes.join("\n");
		textarea.rows = 5;

		const save = () => {
			void this.store.setNotes(index, textarea.value.split("\n"));
		};
		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				save();
				textarea.blur();
			}
		});
		const saveBtn = this.blockSectionEl.createEl("button", {
			text: "Save notes",
			cls: "mod-cta",
		});
		saveBtn.addEventListener("click", () => {
			save();
			textarea.blur();
		});
	}
}
