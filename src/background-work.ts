/**
 * Background-work provider: reports a session's armed timers, running heartbeat and
 * reload-gap queue to @cad0p/pi-background-work, so consumers such as bg_wait see them.
 */

import {
	type BackgroundWorkItem,
	type BackgroundWorkListContext,
	listBackgroundWorkProviders,
	registerBackgroundWorkProvider,
} from "@cad0p/pi-background-work";
import { MAX_LISTABLE_TIMER_ID_LENGTH, registry, type SessionEntry } from "./timer-manager.js";

const PROVIDER_NAME = "pi-heartbeat";
/** The package rejects a provider listing more items than this. */
const MAX_ITEMS = 10_000;

/**
 * Mirrors validateString in @cad0p/pi-background-work for the item `timer:<id>`: non-empty, no NUL,
 * at most MAX_LISTABLE_TIMER_ID_LENGTH units (so the prefixed item fits the package's 256-unit budget).
 * Edge whitespace is checked on the raw id, since the "timer:" prefix would hide it from the package.
 * Control characters are rejected as the timer tool's schema does.
 */
function isListableTimerId(id: string): boolean {
	return (
		id.length > 0 &&
		id.trim() === id &&
		id.length <= MAX_LISTABLE_TIMER_ID_LENGTH &&
		![...id].some((char) => char.charCodeAt(0) < 0x20 || char === "\x7f")
	);
}

function entryItemIds(entry: SessionEntry): string[] {
	const ids: string[] = [];
	for (const id of entry.timers.keys()) {
		// An id from older code that fails validation would make every snapshot throw, so skip it.
		if (isListableTimerId(id)) {
			ids.push(`timer:${id}`);
		}
	}
	if (entry.heartbeat) {
		ids.push(`heartbeat:${entry.heartbeat.state.id}`);
	}
	// Fired during a reload gap and not yet delivered: the wake is still on its way.
	for (const [index, queued] of entry.pending.entries()) {
		// Entries queued before seq existed have no stable id; the legacy form cannot equal a numeric seq.
		ids.push(queued.seq === undefined ? `pending:legacy-${index}` : `pending:${queued.seq}`);
	}
	return ids;
}

/** Lists the work of every session whose identity forms include the requested one. Never throws. */
export function listArmedWork(context?: BackgroundWorkListContext): BackgroundWorkItem[] {
	const items: BackgroundWorkItem[] = [];
	try {
		for (const [key, entry] of registry()) {
			try {
				if (entry.version === 1 && context?.sessionIds.includes(key)) {
					items.push(...entryItemIds(entry).map((id) => ({ id, sessionId: key })));
				}
			} catch {
				// One corrupt entry must not blank every other session's work.
			}
		}
	} catch {
		// Registry unreadable: report what was collected.
	}
	return items.slice(0, MAX_ITEMS);
}

function providerPresent(): boolean {
	try {
		return listBackgroundWorkProviders().some((provider) => provider.name === PROVIDER_NAME);
	} catch {
		// A malformed provider from another extension makes the list throw. Treat that as absent so registration still runs.
		// Each non-reload start then re-registers; harmless, since a same-name registration replaces the old one.
		return false;
	}
}

/**
 * Registers the provider once per process. A reload replaces the existing registration; any other
 * session start registers only when no pi-heartbeat provider is present. The disposer is never
 * called: other sessions in the process still need the provider.
 */
export function registerProvider(reason: string): void {
	if (reason !== "reload" && providerPresent()) {
		return;
	}
	try {
		registerBackgroundWorkProvider({ name: PROVIDER_NAME, listActiveWork: listArmedWork });
	} catch {
		// A malformed provider from another extension must not break session binding.
	}
}
