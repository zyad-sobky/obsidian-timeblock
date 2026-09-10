import { Events, requestUrl } from "obsidian";
import type { Moment } from "moment";
import type ICAL from "ical.js";
import type TimeblocksPlugin from "./main";
import { Meeting, occurrencesForDay, parseIcsEvents } from "./ics";
import { GoogleCalendarClient } from "./gcal";

/**
 * Read-only meeting sources for the timeline: iCal feed URLs and/or the
 * Google Calendar API. ICS feeds are cached whole and expanded per day;
 * Google results are cached per day. Emits "calendar-changed" whenever
 * fresh data lands.
 */
export class CalendarService extends Events {
	google: GoogleCalendarClient;

	private icsEvents: ICAL.Event[] = [];
	private gcalCache = new Map<string, { meetings: Meeting[]; fetched: number }>();
	private gcalInFlight = new Set<string>();
	lastFetched: number | null = null;
	private icsInFlight = false;

	constructor(private plugin: TimeblocksPlugin) {
		super();
		this.google = new GoogleCalendarClient(plugin);
	}

	private get icsUrls(): string[] {
		return this.plugin.settings.icsUrls
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
	}

	get hasSources(): boolean {
		return this.icsUrls.length > 0 || this.google.connected;
	}

	/**
	 * Re-fetch ICS feeds and nudge the views. Google data refreshes lazily
	 * per rendered day via ensureDay's TTL — the cache is not cleared here,
	 * so meetings never flicker out while a refetch is in flight.
	 */
	async refresh() {
		this.lastFetched = Date.now();
		if (!this.icsInFlight) {
			const urls = this.icsUrls;
			if (urls.length === 0) {
				this.icsEvents = [];
			} else {
				this.icsInFlight = true;
				try {
					const all: ICAL.Event[] = [];
					for (const url of urls) {
						try {
							const res = await requestUrl({ url });
							all.push(...parseIcsEvents(res.text));
						} catch (e) {
							console.warn("timeblocks: calendar feed fetch failed", url, e);
						}
					}
					this.icsEvents = all;
				} finally {
					this.icsInFlight = false;
				}
			}
		}
		// Re-render; the timeline's ensureDay call refetches stale Google days.
		this.trigger("calendar-changed");
	}

	/**
	 * When the viewed day's meetings were last fetched: the Google per-day
	 * cache timestamp if present, else the last ICS feed refresh.
	 */
	lastSyncFor(date: Moment): number | null {
		const key = dayKey(date.clone().startOf("day").valueOf());
		const cached = this.gcalCache.get(key);
		if (cached) return cached.fetched;
		return this.lastFetched;
	}

	/**
	 * True when this day's meeting list comes from a verifiably successful
	 * fetch — the only condition under which absence may mean "cancelled".
	 */
	hasFreshDataFor(date: Moment): boolean {
		if (this.google.connected) {
			return this.gcalCache.has(
				dayKey(date.clone().startOf("day").valueOf())
			);
		}
		return this.icsUrls.length > 0 && this.lastFetched !== null;
	}

	/** Drops the day's cache and refetches everything immediately. */
	forceRefreshDay(date: Moment) {
		this.gcalCache.delete(dayKey(date.clone().startOf("day").valueOf()));
		void this.refresh();
	}

	/** Synchronous read from caches — what the timeline renders. */
	meetingsForDay(date: Moment): Meeting[] {
		const dayStartMs = date.clone().startOf("day").valueOf();
		const out: Meeting[] = [];
		if (this.icsEvents.length > 0) {
			out.push(...occurrencesForDay(this.icsEvents, dayStartMs));
		}
		const cached = this.gcalCache.get(dayKey(dayStartMs));
		if (cached) out.push(...cached.meetings);
		out.sort((a, b) => a.start - b.start || a.end - b.end);
		return out;
	}

	/**
	 * Kicks off a Google fetch for the day if its cache is missing or stale.
	 * Fire-and-forget: emits "calendar-changed" when data arrives.
	 */
	ensureDay(date: Moment) {
		if (!this.google.connected) return;
		const dayStartMs = date.clone().startOf("day").valueOf();
		const key = dayKey(dayStartMs);
		const ttlMs =
			Math.max(1, this.plugin.settings.calendarRefreshMinutes) * 60_000;
		const cached = this.gcalCache.get(key);
		if (cached && Date.now() - cached.fetched < ttlMs) return;
		if (this.gcalInFlight.has(key)) return;
		this.gcalInFlight.add(key);
		this.google
			.meetingsForDay(dayStartMs)
			.then((meetings) => {
				this.gcalCache.set(key, { meetings, fetched: Date.now() });
				this.trigger("calendar-changed");
			})
			.catch((e) =>
				console.warn("timeblocks: Google Calendar fetch failed", e)
			)
			.finally(() => this.gcalInFlight.delete(key));
	}
}

function dayKey(dayStartMs: number): string {
	return String(dayStartMs);
}
