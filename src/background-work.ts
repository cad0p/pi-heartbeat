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
import { registry, type SessionEntry, TIMER_ID_MAX_LENGTH, TIMER_ID_PATTERN } from "./timer-manager.js";

const PROVIDER_NAME = "pi-heartbeat";
/** The package rejects a provider listing more items than this. */
const MAX_ITEMS = 10_000;
const TIMER_ID = new RegExp(TIMER_ID_PATTERN);

function entryItemIds(entry: SessionEntry): string[] {
	const ids: string[] = [];
	for (const id of entry.timers.keys()) {
		// An id from older code that fails validation would make every snapshot throw, so skip it.
		if (id.length <= TIMER_ID_MAX_LENGTH && TIMER_ID.test(id)) {
			ids.push(`timer:${id}`);
		}
	}
	if (entry.heartbeat) {
		ids.push(`heartbeat:${entry.heartbeat.state.id}`);
	}
	// Fired during a reload gap and not yet delivered: the wake is still on its way.
	for (const [index, queued] of entry.pending.entries()) {
		ids.push(`pending:${queued.seq ?? index}`);
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

/**
 * Registers the provider once per process. A reload replaces the existing registration; any other
 * session start registers only when no pi-heartbeat provider is present. The disposer is never
 * called: other sessions in the process still need the provider.
 */
export function registerProvider(reason: string): void {
	try {
		if (reason !== "reload" && listBackgroundWorkProviders().some((provider) => provider.name === PROVIDER_NAME)) {
			return;
		}
		registerBackgroundWorkProvider({ name: PROVIDER_NAME, listActiveWork: listArmedWork });
	} catch {
		// A malformed provider from another extension must not break session binding.
	}
}
