import { describe, it, expect } from "vitest";
import { parseSleepSeconds } from "../../src/guards/sleep-interceptor.js";

describe("parseSleepSeconds", () => {
	describe("basic sleep commands", () => {
		it("detects sleep N", () => {
			expect(parseSleepSeconds("sleep 60")).toBe(60);
		});

		it("detects sleep with seconds suffix", () => {
			expect(parseSleepSeconds("sleep 30s")).toBe(30);
		});

		it("detects sleep with minutes suffix", () => {
			expect(parseSleepSeconds("sleep 2m")).toBe(120);
		});

		it("detects sleep with hours suffix", () => {
			expect(parseSleepSeconds("sleep 0.5h")).toBe(1800);
		});

		it("detects decimal seconds", () => {
			expect(parseSleepSeconds("sleep 1.5")).toBe(1.5);
		});
	});

	describe("sleep in compound commands", () => {
		it("detects sleep before &&", () => {
			expect(parseSleepSeconds("sleep 30 && curl localhost:3000")).toBe(30);
		});

		it("detects sleep before ;", () => {
			expect(parseSleepSeconds("sleep 10; echo done")).toBe(10);
		});

		it("detects sleep before |", () => {
			expect(parseSleepSeconds("sleep 5 | echo nope")).toBe(5);
		});

		it("detects sleep in the middle of a pipeline", () => {
			expect(parseSleepSeconds("echo start && sleep 60 && echo end")).toBe(60);
		});

		it("detects sleep in a while loop", () => {
			expect(parseSleepSeconds("while true; do curl localhost; sleep 30; done")).toBe(30);
		});
	});

	describe("multiple sleeps", () => {
		it("returns the maximum sleep value", () => {
			expect(parseSleepSeconds("sleep 5 && do_thing && sleep 60 && check")).toBe(60);
		});
	});

	describe("non-sleep commands", () => {
		it("returns null for commands without sleep", () => {
			expect(parseSleepSeconds("curl localhost:3000")).toBeNull();
		});

		it("returns null for empty command", () => {
			expect(parseSleepSeconds("")).toBeNull();
		});

		it("does not match sleep in variable/path names", () => {
			// 'sleepytime' doesn't match \bsleep\s+ pattern
			expect(parseSleepSeconds("echo sleepytime")).toBeNull();
		});
	});

	describe("threshold-relevant values", () => {
		it("detects short sleeps (will be allowed by interceptor)", () => {
			expect(parseSleepSeconds("sleep 3")).toBe(3);
		});

		it("detects exactly threshold sleep", () => {
			expect(parseSleepSeconds("sleep 5")).toBe(5);
		});

		it("detects above-threshold sleep", () => {
			expect(parseSleepSeconds("sleep 6")).toBe(6);
		});
	});
});
