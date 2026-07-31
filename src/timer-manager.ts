/**
 * TimerManager — Centralized timer/heartbeat state management.
 *
 * Handles one-shot timers and periodic heartbeats.
 * Fires messages via pi.sendMessage({ triggerTurn: true }) to wake the agent.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { acquireBackgroundWork } from "./background-work.js";

export interface ActiveTimer {
	id: string;
	seconds: number;
	message: string;
	createdAt: string;
}

export interface HeartbeatState {
	id: number;
	intervalSeconds: number;
	message: string;
	tick: number;
	createdAt: string;
}

export class TimerManager {
	private timers = new Map<string, NodeJS.Timeout>();
	private timerCounter = 0;
	private heartbeatInterval: NodeJS.Timeout | undefined;
	private heartbeatState: HeartbeatState | undefined;
	private heartbeatIdCounter = 0;
	// Release functions for background-work tokens, so completion notifiers
	// (see background-work.ts) can wait for pending timers/heartbeats.
	private timerTokens = new Map<string, () => void>();
	private heartbeatToken: (() => void) | undefined;

	constructor(private pi: ExtensionAPI) {}

	// ── One-shot timers ─────────────────────────────────────────────

	setTimer(seconds: number, message: string, id?: string): string {
		const timerId = id ?? `timer-${++this.timerCounter}`;

		// Cancel existing timer with same ID
		this.cancelTimer(timerId);

		const release = acquireBackgroundWork(`pi-heartbeat:timer:${timerId}`);

		const timeout = setTimeout(() => {
			this.timers.delete(timerId);
			this.timerTokens.delete(timerId);

			try {
				this.pi.sendMessage(
					{
						customType: "heartbeat-timer",
						content: `⏰ Timer [${timerId}] fired (after ${seconds}s): ${message}`,
						display: true,
						details: {
							type: "timer",
							timerId,
							seconds,
							message,
							firedAt: new Date().toISOString(),
						},
					},
					{ triggerTurn: true },
				);
			} catch {
				// The extension ctx is stale (session replaced/reloaded) or the
				// session is shutting down. sendMessage will never succeed on
				// this ctx, so there's nothing useful to do. The timer has
				// already been removed from `this.timers` above. Swallow to
				// prevent an uncaughtException that would kill the pi process.
			} finally {
				// The wake has been handed off (or abandoned on a stale ctx);
				// either way this timer no longer counts as pending work.
				release();
			}
		}, seconds * 1000);

		this.timers.set(timerId, timeout);
		this.timerTokens.set(timerId, release);
		return timerId;
	}

	cancelTimer(id: string): boolean {
		const timeout = this.timers.get(id);
		if (timeout) {
			clearTimeout(timeout);
			this.timers.delete(id);
			const release = this.timerTokens.get(id);
			this.timerTokens.delete(id);
			release?.();
			return true;
		}
		return false;
	}

	getActiveTimerIds(): string[] {
		return [...this.timers.keys()];
	}

	// ── Heartbeat (periodic) ────────────────────────────────────────

	startHeartbeat(intervalSeconds: number, message: string): HeartbeatState {
		this.stopHeartbeat();

		this.heartbeatIdCounter++;
		const currentId = this.heartbeatIdCounter;

		this.heartbeatState = {
			id: currentId,
			intervalSeconds,
			message,
			tick: 0,
			createdAt: new Date().toISOString(),
		};

		const state = this.heartbeatState;

		this.heartbeatToken = acquireBackgroundWork("pi-heartbeat:heartbeat");

		this.heartbeatInterval = setInterval(() => {
			state.tick++;

			try {
				this.pi.sendMessage(
					{
						customType: "heartbeat-ping",
						content: `💓 Heartbeat #${currentId} tick ${state.tick} (every ${intervalSeconds}s): ${message}`,
						display: true,
						details: {
							type: "heartbeat",
							heartbeatId: currentId,
							tick: state.tick,
							intervalSeconds,
							message,
							firedAt: new Date().toISOString(),
						},
					},
					{ triggerTurn: true },
				);
			} catch {
				// The extension ctx is stale (session replaced/reloaded) or the
				// session is shutting down. Stop the interval so we don't keep
				// throwing on every tick — a zombie interval that wastes CPU
				// and risks crashing the process via uncaughtException.
				this.stopHeartbeat();
			}
		}, intervalSeconds * 1000);

		return { ...state };
	}

	stopHeartbeat(): HeartbeatState | undefined {
		const state = this.heartbeatState;
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = undefined;
			this.heartbeatState = undefined;
		}
		const release = this.heartbeatToken;
		this.heartbeatToken = undefined;
		release?.();
		return state;
	}

	getHeartbeatState(): HeartbeatState | undefined {
		return this.heartbeatState ? { ...this.heartbeatState } : undefined;
	}

	isHeartbeatActive(): boolean {
		return this.heartbeatInterval !== undefined;
	}

	// ── Cleanup ─────────────────────────────────────────────────────

	clearAll(): void {
		for (const [, t] of this.timers) {
			clearTimeout(t);
		}
		this.timers.clear();
		for (const [, release] of this.timerTokens) {
			release();
		}
		this.timerTokens.clear();
		this.stopHeartbeat();
	}
}
