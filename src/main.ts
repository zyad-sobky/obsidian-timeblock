import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	debounce,
	moment,
} from "obsidian";
import { TimeblockStore } from "./store";
import { LOGS_FOLDER } from "./parse";
import { CalendarService } from "./calendar";
import {
	TaskNameModal,
	TimelineView,
	VIEW_TYPE_TIMELINE,
} from "./timeline-view";
import { TasksView, VIEW_TYPE_TASKS } from "./tasks-view";

export interface TimeblocksSettings {
	dayStartHour: number;
	dayEndHour: number;
	snapMinutes: number;
	/** iCal feed URLs (e.g. Google "secret address"), one per line */
	icsUrls: string;
	calendarRefreshMinutes: number;
	/** Google OAuth (user's own Cloud project, desktop-app client) */
	googleClientId: string;
	googleClientSecret: string;
	googleRefreshToken: string;
	/** comma-separated calendar IDs; empty = "primary" */
	googleCalendarIds: string;
	/** write today's meetings into the daily note as 📅 entries */
	importMeetings: boolean;
	/** keep a generated ## Retro summary section in the daily note */
	autoRetro: boolean;
	/** default duration for "start now" blocks */
	defaultBlockMinutes: number;
	/** default duration for "break now" blocks */
	defaultBreakMinutes: number;
	/** how block drags are interpreted: edit the plan vs record the actual */
	dragMode: "plan" | "track";
	/** show the "Previous days" leftover-tasks section expanded */
	showLeftovers: boolean;
	/** how many days back to scan for leftover reminders */
	leftoverLookbackDays: number;
}

const DEFAULT_SETTINGS: TimeblocksSettings = {
	dayStartHour: 8,
	dayEndHour: 20,
	snapMinutes: 15,
	icsUrls: "",
	calendarRefreshMinutes: 10,
	googleClientId: "",
	googleClientSecret: "",
	googleRefreshToken: "",
	googleCalendarIds: "primary",
	importMeetings: true,
	autoRetro: true,
	defaultBlockMinutes: 30,
	defaultBreakMinutes: 15,
	dragMode: "track",
	showLeftovers: false,
	leftoverLookbackDays: 14,
};

export default class TimeblocksPlugin extends Plugin {
	settings: TimeblocksSettings = DEFAULT_SETTINGS;
	store!: TimeblockStore;
	calendar!: CalendarService;

	/** Debounced so typing a URL in settings doesn't fetch per keystroke. */
	refreshCalendarSoon = debounce(() => void this.calendar.refresh(), 2000, true);

	async onload() {
		await this.loadSettings();
		this.store = new TimeblockStore(this);
		this.calendar = new CalendarService(this);

		this.registerView(
			VIEW_TYPE_TIMELINE,
			(leaf) => new TimelineView(leaf, this)
		);
		this.registerView(VIEW_TYPE_TASKS, (leaf) => new TasksView(leaf, this));

		this.addRibbonIcon("calendar-clock", "Open timeblocks", () =>
			void this.activateViews()
		);
		this.addCommand({
			id: "open-views",
			name: "Open timeblock views",
			callback: () => void this.activateViews(),
		});
		this.addCommand({
			id: "go-today",
			name: "Go to today",
			callback: () => this.store.setDate(moment()),
		});
		this.addCommand({
			id: "start-task-now",
			name: "Start selected task now",
			callback: () => this.startTaskNow(),
		});
		this.addCommand({
			id: "start-break-now",
			name: "Start a break now",
			callback: () => this.startBreakNow(),
		});
		this.addCommand({
			id: "update-retro",
			name: "Update day retro",
			callback: () => void this.store.refreshDerived(),
		});

		this.addSettingTab(new TimeblocksSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (f === this.store.file) this.store.scheduleReload();
			})
		);
		// Materialize today's meetings as 📅 entries in the daily note
		// whenever fresh calendar data lands. Upsert-only: syncMeetings
		// writes only when something actually changed, so this can't loop.
		this.registerEvent(
			this.calendar.on("calendar-changed", () => {
				if (!this.settings.importMeetings) return;
				if (!this.store.file) return;
				if (!this.store.date.isSame(moment(), "day")) return;
				void this.store.syncMeetings(
					this.calendar.meetingsForDay(this.store.date),
					this.calendar.hasFreshDataFor(this.store.date)
				);
			})
		);

		// Follow the daily note the user is working in: focusing a note in
		// "1. Logs" switches both views to that note's day.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !file.path.startsWith(LOGS_FOLDER + "/")) return;
				const dateStr = file.basename.slice(0, 10);
				if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
				const day = moment(dateStr, "YYYY-MM-DD", true);
				if (!day.isValid() || day.isSame(this.store.date, "day")) return;
				this.store.setDate(day);
			})
		);

		// Midnight rollover: while the view is on "today", advance it when
		// the day changes (checked each minute alongside the calendar timer).
		this.registerInterval(
			window.setInterval(() => {
				if (
					this.store.followsToday &&
					!this.store.date.isSame(moment(), "day")
				) {
					this.store.setDate(moment());
				}
			}, 60_000)
		);

		this.registerEvent(this.app.vault.on("rename", () => this.store.refresh()));
		this.registerEvent(
			this.app.vault.on("delete", (f) => {
				if (f === this.store.file) this.store.refresh();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			// Registered after layout-ready so the initial vault indexing
			// doesn't spam create events.
			this.registerEvent(
				this.app.vault.on("create", () => {
					if (!this.store.file) this.store.refresh();
				})
			);
			this.store.setDate(moment());
			if (this.calendar.hasSources) void this.calendar.refresh();
		});

		// Periodic calendar refresh; checks elapsed time each minute so the
		// interval setting takes effect without re-registration.
		this.registerInterval(
			window.setInterval(() => {
				if (!this.calendar.hasSources) return;
				const ms =
					Math.max(1, this.settings.calendarRefreshMinutes) * 60_000;
				if (
					this.calendar.lastFetched === null ||
					Date.now() - this.calendar.lastFetched >= ms
				) {
					void this.calendar.refresh();
				}
			}, 60_000)
		);
	}

	startTaskNow() {
		const task = this.store.selectedTask;
		if (task) {
			void this.store.startNow(task, this.settings.defaultBlockMinutes);
		} else {
			new TaskNameModal(this.app, (name) =>
				void this.store.startNow(name, this.settings.defaultBlockMinutes)
			).open();
		}
	}

	startBreakNow() {
		void this.store.startNow("#break", this.settings.defaultBreakMinutes);
	}

	async activateViews() {
		const { workspace } = this.app;
		const placements: [string, "left" | "right"][] = [
			[VIEW_TYPE_TASKS, "left"],
			[VIEW_TYPE_TIMELINE, "right"],
		];
		for (const [type, side] of placements) {
			let leaf: WorkspaceLeaf | null =
				workspace.getLeavesOfType(type)[0] ?? null;
			if (!leaf) {
				leaf =
					side === "right"
						? workspace.getRightLeaf(false)
						: workspace.getLeftLeaf(false);
				if (!leaf) continue;
				await leaf.setViewState({ type, active: false });
			}
			workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Re-render the views with the new hours/snap.
		this.store.trigger("changed");
	}
}

class TimeblocksSettingTab extends PluginSettingTab {
	plugin: TimeblocksPlugin;

	constructor(app: App, plugin: TimeblocksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		const numberSetting = (
			name: string,
			desc: string,
			get: () => number,
			set: (v: number) => void,
			min: number,
			max: number
		) => {
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text.setValue(String(get())).onChange(async (value) => {
						const n = parseInt(value, 10);
						if (isNaN(n) || n < min || n > max) return;
						set(n);
						await this.plugin.saveSettings();
					})
				);
		};

		numberSetting(
			"Day starts at",
			"First hour shown on the timeline (0–23). Expands automatically if blocks fall earlier.",
			() => this.plugin.settings.dayStartHour,
			(v) => (this.plugin.settings.dayStartHour = v),
			0,
			23
		);
		numberSetting(
			"Day ends at",
			"Last hour shown on the timeline (1–24). Expands automatically if blocks fall later.",
			() => this.plugin.settings.dayEndHour,
			(v) => (this.plugin.settings.dayEndHour = v),
			1,
			24
		);
		numberSetting(
			"Snap (minutes)",
			"Drag granularity for creating, moving and resizing blocks.",
			() => this.plugin.settings.snapMinutes,
			(v) => (this.plugin.settings.snapMinutes = v),
			1,
			60
		);

		new Setting(containerEl).setName("Quick actions & retro").setHeading();

		numberSetting(
			"Default block duration (minutes)",
			"Length of blocks created by 'Start selected task now'.",
			() => this.plugin.settings.defaultBlockMinutes,
			(v) => (this.plugin.settings.defaultBlockMinutes = v),
			5,
			240
		);
		numberSetting(
			"Default break duration (minutes)",
			"Length of blocks created by 'Start a break now'.",
			() => this.plugin.settings.defaultBreakMinutes,
			(v) => (this.plugin.settings.defaultBreakMinutes = v),
			5,
			120
		);
		numberSetting(
			"Leftover lookback (days)",
			"How many previous days to scan for unchecked reminders shown under 'Previous days' in the tasks sidebar.",
			() => this.plugin.settings.leftoverLookbackDays,
			(v) => (this.plugin.settings.leftoverLookbackDays = v),
			1,
			90
		);

		new Setting(containerEl)
			.setName("Auto day retro")
			.setDesc(
				"Keeps a generated ## Retro section (focus/meetings/breaks totals + estimate accuracy table) at the end of the daily note, updated on every change. The section is fully generated — hand edits inside it are overwritten."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoRetro)
					.onChange(async (value) => {
						this.plugin.settings.autoRetro = value;
						await this.plugin.saveSettings();
						if (value) void this.plugin.store.refreshDerived();
					})
			);

		new Setting(containerEl).setName("Calendar").setHeading();

		new Setting(containerEl)
			.setName("iCal feed URLs")
			.setDesc(
				"Read-only calendar feeds shown on the timeline, one URL per line. " +
					"For Google Calendar: Settings → your calendar → 'Secret address in iCal format'. " +
					"Note: the URL is stored in this plugin's data.json inside the vault."
			)
			.addTextArea((text) => {
				text.setPlaceholder("https://calendar.google.com/calendar/ical/…/basic.ics")
					.setValue(this.plugin.settings.icsUrls)
					.onChange(async (value) => {
						this.plugin.settings.icsUrls = value;
						await this.plugin.saveSettings();
						this.plugin.refreshCalendarSoon();
					});
				text.inputEl.rows = 3;
				text.inputEl.style.width = "100%";
			});

		numberSetting(
			"Calendar refresh (minutes)",
			"How often to re-fetch the feeds. Google caches the secret feed, so very low values don't gain much.",
			() => this.plugin.settings.calendarRefreshMinutes,
			(v) => (this.plugin.settings.calendarRefreshMinutes = v),
			1,
			240
		);

		new Setting(containerEl)
			.setName("Add meetings to today's log")
			.setDesc(
				"Writes today's meetings into the daily note as 📅 entries (sorted among your ⏱ blocks) so you can take notes under them. Times update if a meeting moves; entries are never auto-deleted. Off = meetings stay a visual overlay only."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.importMeetings)
					.onChange(async (value) => {
						this.plugin.settings.importMeetings = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Refresh now")
			.setDesc("Fetch the calendar feeds immediately.")
			.addButton((btn) =>
				btn.setButtonText("Refresh").onClick(() => {
					void this.plugin.calendar.refresh();
				})
			);

		new Setting(containerEl).setName("Google Calendar (OAuth)").setHeading();

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc(
				"From your own Google Cloud project (OAuth client, type 'Desktop app')."
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.googleClientId).onChange(
					async (value) => {
						this.plugin.settings.googleClientId = value;
						await this.plugin.saveSettings();
					}
				);
				text.inputEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Stored in this plugin's data.json inside the vault.")
			.addText((text) => {
				text.setValue(this.plugin.settings.googleClientSecret).onChange(
					async (value) => {
						this.plugin.settings.googleClientSecret = value;
						await this.plugin.saveSettings();
					}
				);
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
			});

		new Setting(containerEl)
			.setName("Calendar IDs")
			.setDesc(
				"Comma-separated. 'primary' is your main calendar; other IDs are under each calendar's settings in Google Calendar."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.googleCalendarIds)
					.setPlaceholder("primary")
					.onChange(async (value) => {
						this.plugin.settings.googleCalendarIds = value;
						await this.plugin.saveSettings();
					})
			);

		const google = this.plugin.calendar.google;
		new Setting(containerEl)
			.setName("Connection")
			.setDesc(
				google.connected
					? "Connected — meetings from Google Calendar show on the timeline."
					: "Not connected."
			)
			.addButton((btn) =>
				btn
					.setButtonText(google.connected ? "Sign out" : "Sign in with Google")
					.setCta()
					.onClick(async () => {
						if (google.connected) {
							await google.signOut();
						} else {
							const ok = await google.signIn();
							if (ok) void this.plugin.calendar.refresh();
						}
						this.display();
					})
			);
	}
}
