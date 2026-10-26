/**
 * Harness for reload-survival tests. An Activation is one activate() call (one
 * pi instance). A reload is `shutdown("reload")` on the old activation followed
 * by `start("reload")` on a fresh one bound to the same session key.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import activate from "../../src/index.js";

export type SentMessage = { customType: string; content: string };

type Handler = (event: { reason: string }, ctx: unknown) => unknown;
type ToolDef = {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};
type CommandDef = { handler: (args: string, ctx: unknown) => Promise<void> };
type RegistryEntry = { version: number; dispose(): void };

export interface Activation {
	key: string;
	sendMessage: ReturnType<typeof vi.fn<(message: SentMessage, options?: unknown) => void>>;
	start(reason: string): void;
	shutdown(reason: string): void;
	setTimer(seconds: number, message: string, id?: string): Promise<unknown>;
	startHeartbeat(intervalSeconds: number, message: string): Promise<unknown>;
	stopHeartbeat(): Promise<unknown>;
	cancel(args: string): Promise<void>;
}

const SESSIONS = Symbol.for("pi-heartbeat.sessions");

export function sessionRegistry(): Map<string, RegistryEntry> {
	const host = globalThis as unknown as Record<symbol, Map<string, RegistryEntry> | undefined>;
	host[SESSIONS] ??= new Map();
	return host[SESSIONS];
}

/** Dispose every armed session and empty the registry. Call in afterEach. */
export function resetSessions(): void {
	const sessions = sessionRegistry();
	for (const entry of sessions.values()) {
		entry.dispose();
	}
	sessions.clear();
}

export function activation(key: string = randomUUID()): Activation {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDef>();
	const commands = new Map<string, CommandDef>();
	const sendMessage = vi.fn<(message: SentMessage, options?: unknown) => void>();

	const pi = {
		sendMessage,
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

	const ctx = { sessionManager: { getSessionId: () => key }, ui: { notify: vi.fn() } };
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

	return {
		key,
		sendMessage,
		start: (reason) => fire("session_start", reason),
		shutdown: (reason) => fire("session_shutdown", reason),
		setTimer: (seconds, message, id) => call("timer", { seconds, message, id }),
		startHeartbeat: (interval_seconds, message) =>
			call("heartbeat", { action: "start", interval_seconds, message }),
		stopHeartbeat: () => call("heartbeat", { action: "stop" }),
		cancel: async (args) => {
			await commands.get("cancel-timer")?.handler(args, ctx);
		},
	};
}

export function sentContents(act: Activation): string[] {
	return act.sendMessage.mock.calls.map(([message]) => message.content);
}
