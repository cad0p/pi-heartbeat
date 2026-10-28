/**
 * Harness for reload-survival tests. An Activation is one activate() call (one
 * pi instance). A reload is `shutdown("reload")` on the old activation followed
 * by `start("reload")` on a fresh one bound to the same session key.
 *
 * Each session key owns a journal: the custom entries this extension appends, in order, root->leaf.
 * It outlives an activation the way a session file does, so a restart reads what the previous process
 * wrote, and `crash()` can leave it with owners that are no longer alive.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_WORK_REGISTRY_KEY, snapshotBackgroundWork } from "@cad0p/pi-background-work";
import type { TSchema } from "@sinclair/typebox";
import { vi } from "vitest";
import activate from "../../src/index.js";
import { type PersistOwner, currentOwner } from "../../src/process-identity.js";
import { HEARTBEAT_STATE_ENTRY, type TimerStateRecord } from "../../src/session-state.js";

export type SentMessage = { customType: string; content: string; details?: Record<string, unknown> };
/** One entry of a session's journal, shaped as pi's `CustomEntry` and returned by `getBranch()`. */
export type JournalEntry = { type: "custom"; customType: string; data?: unknown };

type Handler = (event: { reason: string }, ctx: unknown) => unknown;
type ToolDef = {
	name: string;
	parameters: TSchema;
	execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};
type CommandDef = { handler: (args: string, ctx: unknown) => Promise<void> };
type RegistryEntry = { version: number; dispose(): void };

export interface Activation {
	key: string;
	sendMessage: ReturnType<typeof vi.fn<(message: SentMessage, options?: unknown) => void>>;
	appendEntry: ReturnType<typeof vi.fn<(customType: string, data?: unknown) => void>>;
	start(reason: string): void;
	shutdown(reason: string): void;
	setTimer(seconds: number, message: string, id?: string): Promise<unknown>;
	startHeartbeat(intervalSeconds: number, message: string): Promise<unknown>;
	stopHeartbeat(): Promise<unknown>;
	cancel(args: string): Promise<void>;
	toolSchema(name: string): TSchema;
}

const SESSIONS = Symbol.for("pi-heartbeat.sessions");

/** Every activation this harness created, so resetSessions() can shut them all down. */
const ACTIVATIONS: Activation[] = [];
/** One journal per session key, root->leaf, exactly what `getBranch()` hands the extension. */
const JOURNALS = new Map<string, JournalEntry[]>();

/** The custom entries appended to this key's session, in order. Never cleared: a session file is not either. */
export function journal(key: string): JournalEntry[] {
	let entries = JOURNALS.get(key);
	if (entries === undefined) {
		entries = [];
		JOURNALS.set(key, entries);
	}
	return entries;
}

/** The `pi-heartbeat.state` records this key's log holds, in order. */
export function stateRecords(key: string): TimerStateRecord[] {
	return journal(key)
		.filter((entry) => entry.customType === HEARTBEAT_STATE_ENTRY)
		.map((entry) => entry.data as TimerStateRecord);
}

/** The operations of this key's log, for asserting order without spelling out every field. */
export function stateOps(key: string): string[] {
	return stateRecords(key).map((record) => (record.op === "heartbeat" ? `heartbeat:${record.action}` : record.op));
}

export function sessionRegistry(): Map<string, RegistryEntry> {
	const host = globalThis as unknown as Record<symbol, Map<string, RegistryEntry> | undefined>;
	host[SESSIONS] ??= new Map();
	return host[SESSIONS];
}

/**
 * Shut down every activation this harness created and empty the registry. Call in afterEach.
 *
 * A standalone copy (a second activation on a key that is already live) is not in the registry: its entry is
 * created inside TimerManager.bind()->attach() and never registered, so disposing the registry alone left its
 * timers running into later tests. shutdown("quit") disposes that activation's entry — a shared, adopted entry
 * included — which is why teardown runs after a test's assertions; only the registry slot is ownership-checked.
 */
export function resetSessions(): void {
	for (const act of ACTIVATIONS.splice(0)) act.shutdown("quit");
	const sessions = sessionRegistry();
	for (const entry of sessions.values()) {
		entry.dispose();
	}
	sessions.clear();
}

/** An owner that no probe can find alive: dead pid, and a boot id no host reports. */
const DEAD_OWNER: PersistOwner = { pid: 999999, boot: "dead", start: "0", uptime: 0 };

function holdsOwner(value: unknown): value is { owner: PersistOwner } {
	return typeof value === "object" && value !== null && "owner" in value;
}

/**
 * A process death: no `session_shutdown`, so the `clear` a quit would write is not in the log.
 *
 * Teardown still has to release the in-memory timers, so it runs `resetSessions()` and then drops the
 * records those shutdowns appended, leaving the log exactly as the killed process left it. Every record
 * is then re-owned by a dead process, so a restart has to recover from the log alone.
 */
export function crash(key: string): void {
	const lengths = new Map([...JOURNALS].map(([name, entries]) => [name, entries.length]));
	resetSessions();
	for (const [name, entries] of JOURNALS) {
		entries.length = lengths.get(name) ?? 0;
	}
	for (const entry of journal(key)) {
		if (holdsOwner(entry.data)) {
			entry.data.owner = DEAD_OWNER;
		}
	}
}

/** A crash followed by a new process opening the same session. */
export function restart(key: string): Activation {
	crash(key);
	const act = activation(key);
	act.start("startup");
	return act;
}

/** The owner of a still-armed record this harness wrote, for a record that must read as alive. */
export function liveOwner(): PersistOwner {
	return currentOwner();
}

export function activation(key: string = randomUUID()): Activation {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDef>();
	const commands = new Map<string, CommandDef>();
	const sendMessage = vi.fn<(message: SentMessage, options?: unknown) => void>();
	const appendEntry = vi.fn<(customType: string, data?: unknown) => void>((customType, data) => {
		journal(key).push({ type: "custom", customType, data });
	});

	const pi = {
		sendMessage,
		appendEntry,
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: ToolDef) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, def: CommandDef) => {
			commands.set(name, def);
		},
	};
	activate(pi as unknown as ExtensionAPI);

	const ctx = {
		sessionManager: {
			getSessionId: () => key,
			getSessionFile: () => undefined,
			// Root->leaf, as pi returns it: an entry appended now is visible to the next call.
			getBranch: () => [...journal(key)],
		},
		ui: { notify: vi.fn() },
	};
	const fire = (event: string, reason: string) => {
		for (const handler of handlers.get(event) ?? []) {
			handler({ reason }, ctx);
		}
	};
	const call = (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		if (!tool) {
			throw new Error(`tool ${name} not registered`);
		}
		return tool.execute(name, params);
	};

	const act: Activation = {
		key,
		sendMessage,
		appendEntry,
		start: (reason) => fire("session_start", reason),
		shutdown: (reason) => fire("session_shutdown", reason),
		setTimer: (seconds, message, id) => call("timer", { seconds, message, id }),
		startHeartbeat: (interval_seconds, message) =>
			call("heartbeat", { action: "start", interval_seconds, message }),
		stopHeartbeat: () => call("heartbeat", { action: "stop" }),
		cancel: async (args) => {
			await commands.get("cancel-timer")?.handler(args, ctx);
		},
		toolSchema: (name) => {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`tool ${name} not registered`);
			}
			return tool.parameters;
		},
	};
	ACTIVATIONS.push(act);
	return act;
}

export function sentContents(act: Activation): string[] {
	return act.sendMessage.mock.calls.map(([message]) => message.content);
}

/** Ids the package's validating snapshot reports for one session. */
export function listedWork(key: string): string[] {
	return snapshotBackgroundWork([key]).items.map((item) => item.id);
}

/** Clear the package's process-wide provider registry. Call in beforeEach. */
export function resetBackgroundWork(): void {
	Reflect.deleteProperty(globalThis, Symbol.for(BACKGROUND_WORK_REGISTRY_KEY));
}
