import { Notice, Platform, requestUrl } from "obsidian";
import type TimeblocksPlugin from "./main";
import { Meeting } from "./ics";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MIN;

function randomString(length: number): string {
	const bytes = new Uint8Array(length);
	window.crypto.getRandomValues(bytes);
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await window.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier)
	);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Google Calendar via OAuth (desktop-app client + PKCE + loopback redirect).
 * The client ID/secret come from the user's own Google Cloud project; the
 * refresh token is stored in the plugin's data.json. Read-only scope.
 */
export class GoogleCalendarClient {
	private accessToken: string | null = null;
	private accessTokenExpiry = 0;

	constructor(private plugin: TimeblocksPlugin) {}

	get configured(): boolean {
		const s = this.plugin.settings;
		return !!(s.googleClientId.trim() && s.googleClientSecret.trim());
	}

	get connected(): boolean {
		return !!this.plugin.settings.googleRefreshToken;
	}

	/** Loopback OAuth flow: opens the browser, catches the redirect locally. */
	async signIn(): Promise<boolean> {
		if (!this.configured) {
			new Notice("Enter the Google client ID and secret first.");
			return false;
		}
		if (!Platform.isDesktop) {
			new Notice("Google sign-in needs the desktop app (it syncs afterwards).");
			return false;
		}
		const s = this.plugin.settings;
		const verifier = randomString(64);
		const challenge = await pkceChallenge(verifier);
		const state = randomString(24);

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const http = require("http") as typeof import("http");
		const server = http.createServer();
		try {
			const port: number = await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					const addr = server.address();
					if (addr && typeof addr === "object") resolve(addr.port);
					else reject(new Error("no port"));
				});
			});
			const redirectUri = `http://127.0.0.1:${port}`;

			const code: string = await new Promise((resolve, reject) => {
				const timeout = window.setTimeout(
					() => reject(new Error("Sign-in timed out after 3 minutes.")),
					180_000
				);
				server.on("request", (req, res) => {
					const u = new URL(req.url ?? "/", redirectUri);
					if (u.searchParams.get("state") !== state) {
						res.writeHead(400).end("State mismatch.");
						return;
					}
					res.writeHead(200, { "Content-Type": "text/html" }).end(
						"<html><body style='font-family:sans-serif'><h3>Timeblocks is connected ✅</h3>You can close this tab and return to Obsidian.</body></html>"
					);
					window.clearTimeout(timeout);
					const authCode = u.searchParams.get("code");
					if (authCode) resolve(authCode);
					else
						reject(
							new Error(u.searchParams.get("error") ?? "No code returned.")
						);
				});
				const params = new URLSearchParams({
					client_id: s.googleClientId.trim(),
					redirect_uri: redirectUri,
					response_type: "code",
					scope: SCOPE,
					access_type: "offline",
					prompt: "consent",
					code_challenge: challenge,
					code_challenge_method: "S256",
					state,
				});
				window.open(`${AUTH_URL}?${params.toString()}`);
			});

			const res = await requestUrl({
				url: TOKEN_URL,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: s.googleClientId.trim(),
					client_secret: s.googleClientSecret.trim(),
					code,
					code_verifier: verifier,
					grant_type: "authorization_code",
					redirect_uri: redirectUri,
				}).toString(),
			});
			const json = res.json;
			if (!json.refresh_token) {
				throw new Error("Google did not return a refresh token.");
			}
			s.googleRefreshToken = json.refresh_token;
			this.accessToken = json.access_token ?? null;
			this.accessTokenExpiry = Date.now() + (json.expires_in ?? 0) * 1000;
			await this.plugin.saveSettings();
			new Notice("Google Calendar connected.");
			return true;
		} catch (e) {
			console.warn("timeblocks: Google sign-in failed", e);
			new Notice(`Google sign-in failed: ${(e as Error).message}`);
			return false;
		} finally {
			server.close();
		}
	}

	async signOut() {
		const token = this.plugin.settings.googleRefreshToken;
		this.plugin.settings.googleRefreshToken = "";
		this.accessToken = null;
		await this.plugin.saveSettings();
		if (token) {
			try {
				await requestUrl({
					url: `${REVOKE_URL}?token=${encodeURIComponent(token)}`,
					method: "POST",
					throw: false,
				});
			} catch {
				// best-effort revoke
			}
		}
		new Notice("Google Calendar disconnected.");
	}

	private async getAccessToken(): Promise<string> {
		if (this.accessToken && Date.now() < this.accessTokenExpiry - 30_000) {
			return this.accessToken;
		}
		const s = this.plugin.settings;
		const res = await requestUrl({
			url: TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: s.googleClientId.trim(),
				client_secret: s.googleClientSecret.trim(),
				refresh_token: s.googleRefreshToken,
				grant_type: "refresh_token",
			}).toString(),
			throw: false,
		});
		if (res.status >= 400) {
			if (res.json?.error === "invalid_grant") {
				// Token revoked/expired — force a fresh sign-in.
				s.googleRefreshToken = "";
				await this.plugin.saveSettings();
				new Notice("Google sign-in expired — reconnect in Timeblocks settings.");
			}
			throw new Error(`token refresh failed (${res.status})`);
		}
		this.accessToken = res.json.access_token;
		this.accessTokenExpiry = Date.now() + (res.json.expires_in ?? 0) * 1000;
		return this.accessToken as string;
	}

	/** Fetches concrete (recurrence-expanded) meetings overlapping the day. */
	async meetingsForDay(dayStartMs: number): Promise<Meeting[]> {
		const token = await this.getAccessToken();
		const dayEndMs = dayStartMs + MS_PER_DAY;
		const calendarIds = this.plugin.settings.googleCalendarIds
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (calendarIds.length === 0) calendarIds.push("primary");

		const clampMin = (ms: number) =>
			Math.min(Math.max(Math.round((ms - dayStartMs) / MS_PER_MIN), 0), 1440);

		const out: Meeting[] = [];
		for (const calId of calendarIds) {
			const params = new URLSearchParams({
				timeMin: new Date(dayStartMs).toISOString(),
				timeMax: new Date(dayEndMs).toISOString(),
				singleEvents: "true",
				orderBy: "startTime",
				maxResults: "250",
			});
			const res = await requestUrl({
				url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params.toString()}`,
				headers: { Authorization: `Bearer ${token}` },
			});
			for (const item of res.json.items ?? []) {
				if (item.status === "cancelled") continue;
				const start = item.start?.dateTime;
				const end = item.end?.dateTime;
				if (!start || !end) continue; // all-day events have `date` instead
				const startMs = new Date(start).getTime();
				const endMs = new Date(end).getTime();
				if (endMs <= dayStartMs || startMs >= dayEndMs) continue;
				out.push({
					title: item.summary || "(untitled)",
					start: clampMin(startMs),
					end: clampMin(endMs),
				});
			}
		}
		out.sort((a, b) => a.start - b.start || a.end - b.end);
		return out;
	}
}
