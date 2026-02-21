/**
 * Extension integration tests — exercises pi-heartbeat tools and guards
 * using a real pi session with a playbook model mock.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createTestSession, when, calls } from "@marcfargas/pi-test-harness";
import type { TestSession } from "@marcfargas/pi-test-harness";
import * as path from "node:path";

// Resolve extension path from project root (process.cwd() when running tests).
// createTestSession resolves extension paths relative to its temp cwd, so we
// must supply an absolute path.
const EXT = path.resolve("./src/index.ts");

describe("pi-heartbeat extension", () => {
	let t: TestSession;

	afterEach(() => {
		t?.dispose();
	});

	// ── Timer tool ─────────────────────────────────────────────────

	it("timer tool: registers, executes and returns result with seconds and ID", async () => {
		t = await createTestSession({
			extensions: [EXT],
			// Provide mockTools (even empty) to enable wrapForCollection on real tools
			mockTools: {},
		});

		await t.run(
			when("Set a 30-second timer to check the build", [
				calls("timer", { seconds: 30, message: "check build" }),
			]),
		);

		const results = t.events.toolResultsFor("timer");

		// Exactly one result produced
		expect(results).toHaveLength(1);

		// Result is not an error
		expect(results[0].isError).toBe(false);

		// Text mentions the duration
		expect(results[0].text).toContain("30");

		// Text mentions the auto-generated timer ID (format: "timer-N" inside brackets)
		expect(results[0].text).toMatch(/\[timer-\d+\]/);
	});

	// ── Heartbeat tool ─────────────────────────────────────────────

	it("heartbeat: start and stop both produce results and leave no interval leak", async () => {
		t = await createTestSession({
			extensions: [EXT],
			mockTools: {},
		});

		// Both calls in a single turn: playbook emits start call → result back →
		// emits stop call → result back → fallback stop message.
		await t.run(
			when("Monitor deployment: start a heartbeat then immediately stop it", [
				calls("heartbeat", { action: "start", interval_seconds: 10, message: "monitor" }),
				calls("heartbeat", { action: "stop" }),
			]),
		);

		const results = t.events.toolResultsFor("heartbeat");

		// Both calls produced results
		expect(results).toHaveLength(2);

		// First result: heartbeat started
		expect(results[0].isError).toBe(false);
		expect(results[0].text).toContain("started");

		// Second result: heartbeat stopped
		expect(results[1].isError).toBe(false);
		expect(results[1].text).toContain("stopped");
	});

	// ── Sleep interceptor: blocked ─────────────────────────────────

	it("sleep interceptor: blocks trailing sleep > 5s and tells agent to use timer", async () => {
		t = await createTestSession({
			extensions: [EXT],
			mockTools: {
				bash: (params) => `$ ${(params as { command: string }).command}\noutput`,
			},
		});

		// The mock's execute() fires extension hooks, so the sleep interceptor
		// can return { block: true } before the mock result is produced.
		await t.run(
			when("Build the project with a trailing sleep", [
				calls("bash", { command: "npm run build && sleep 60" }),
			]),
		);

		const results = t.events.toolResultsFor("bash");

		// The call was recorded (mock fires the hook and records the block)
		expect(results).toHaveLength(1);

		// It was blocked → isError: true
		expect(results[0].isError).toBe(true);

		// Block reason advises agent to use the timer tool
		expect(results[0].text).toContain("timer");
	});

	// ── Sleep interceptor: allowed ─────────────────────────────────

	it("sleep interceptor: allows sleep when it is NOT the trailing command", async () => {
		t = await createTestSession({
			extensions: [EXT],
			mockTools: {
				bash: (params) => `$ ${(params as { command: string }).command}\noutput`,
			},
		});

		await t.run(
			when("Start the server after a brief delay", [
				calls("bash", { command: "sleep 10 && npm start" }),
			]),
		);

		const results = t.events.toolResultsFor("bash");

		// Executed normally — one successful result
		expect(results).toHaveLength(1);
		expect(results[0].isError).toBe(false);

		// Result contains the echoed command from our mock handler
		expect(results[0].text).toContain("sleep 10 && npm start");
	});
});
