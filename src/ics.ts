/**
 * Pure ICS parsing and per-day occurrence expansion on top of ical.js.
 * No Obsidian imports — testable with plain node.
 */
import ICAL from "ical.js";

export interface Meeting {
	title: string;
	/** minutes since midnight of the viewed day, clamped to 0–1440 */
	start: number;
	end: number;
}

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;

/**
 * Parses an ICS feed into main VEVENTs with their recurrence exceptions
 * related, registering any VTIMEZONEs the feed carries.
 */
export function parseIcsEvents(text: string): ICAL.Event[] {
	const comp = new ICAL.Component(ICAL.parse(text));

	for (const vtz of comp.getAllSubcomponents("vtimezone")) {
		const tz = new ICAL.Timezone(vtz);
		if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) {
			ICAL.TimezoneService.register(tz);
		}
	}

	const mains: ICAL.Event[] = [];
	const exceptions: ICAL.Event[] = [];
	for (const v of comp.getAllSubcomponents("vevent")) {
		const e = new ICAL.Event(v);
		if (e.isRecurrenceException()) exceptions.push(e);
		else mains.push(e);
	}
	const byUid = new Map(mains.map((e) => [e.uid, e]));
	for (const ex of exceptions) byUid.get(ex.uid)?.relateException(ex);
	return mains;
}

function isCancelled(component: ICAL.Component): boolean {
	const status = component.getFirstPropertyValue("status");
	return typeof status === "string" && status.toUpperCase() === "CANCELLED";
}

function toMs(t: ICAL.Time): number {
	return t.toJSDate().getTime();
}

/**
 * Expands events into concrete meetings overlapping the local day starting
 * at `dayStartMs`, clamped to that day. All-day and cancelled events are
 * skipped — this feeds a work-hours timeline.
 */
export function occurrencesForDay(
	events: ICAL.Event[],
	dayStartMs: number
): Meeting[] {
	const dayEndMs = dayStartMs + MS_PER_DAY;
	const out: Meeting[] = [];

	const push = (title: string, startMs: number, endMs: number) => {
		if (endMs <= dayStartMs || startMs >= dayEndMs || endMs <= startMs) return;
		const clamp = (ms: number) =>
			Math.min(Math.max(Math.round((ms - dayStartMs) / MS_PER_MIN), 0), 1440);
		out.push({ title, start: clamp(startMs), end: clamp(endMs) });
	};

	for (const event of events) {
		try {
			expandEvent(event, dayStartMs, dayEndMs, push);
		} catch (e) {
			console.warn("timeblocks: failed to expand event", event.summary, e);
		}
	}
	out.sort((a, b) => a.start - b.start || a.end - b.end);
	return out;
}

function expandEvent(
	event: ICAL.Event,
	dayStartMs: number,
	dayEndMs: number,
	push: (title: string, startMs: number, endMs: number) => void
) {
	if (isCancelled(event.component)) return;
	if (!event.startDate || event.startDate.isDate) return; // all-day
	const title = (event.summary ?? "").trim() || "(untitled)";

	if (!event.isRecurring()) {
		push(title, toMs(event.startDate), toMs(event.endDate));
		return;
	}

	// NOTE: iterator(startTime) must NOT be used to skip ahead — ical.js
	// treats that argument as a replacement DTSTART, corrupting the
	// expansion. Iterate from the event's own start and skip cheaply.
	const iterator = event.iterator();
	let next: ICAL.Time | null;
	let guard = 0;
	while ((next = iterator.next()) && guard++ < 10000) {
		const occStartMs = toMs(next);
		if (occStartMs >= dayEndMs) break;
		// Far-past occurrences can't overlap the day; skip them without
		// building occurrence details. The 7-day margin keeps overnight
		// overlaps and recently-moved exceptions visible.
		if (occStartMs < dayStartMs - 7 * MS_PER_DAY) continue;
		let details: ReturnType<ICAL.Event["getOccurrenceDetails"]>;
		try {
			details = event.getOccurrenceDetails(next);
		} catch {
			continue;
		}
		if (isCancelled(details.item.component)) continue;
		if (details.startDate.isDate) continue;
		push(
			(details.item.summary ?? "").trim() || title,
			toMs(details.startDate),
			toMs(details.endDate)
		);
	}
}
