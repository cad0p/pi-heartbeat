import { describe, it, expect } from "vitest";
import {
	getTrailingSleepSeconds,
	segmentSleepSeconds,
} from "../../src/guards/sleep-interceptor.js";

describe("getTrailingSleepSeconds", () => {
	describe("sole sleep commands", () => {
		it("'sleep 60' → 60", () => {
			expect(getTrailingSleepSeconds("sleep 60")).toBe(60);
		});

		it("'sleep 2m' → 120", () => {
			expect(getTrailingSleepSeconds("sleep 2m")).toBe(120);
		});

		it("'sleep 0.5h' → 1800", () => {
			expect(getTrailingSleepSeconds("sleep 0.5h")).toBe(1800);
		});

		it("'sleep 30s' → 30", () => {
			expect(getTrailingSleepSeconds("sleep 30s")).toBe(30);
		});

		it("'sleep 1.5' → 1.5", () => {
			expect(getTrailingSleepSeconds("sleep 1.5")).toBe(1.5);
		});
	});

	describe("sleep IS the last segment (should detect)", () => {
		it("'build && sleep 60' → 60 (sleep IS last)", () => {
			expect(getTrailingSleepSeconds("build && sleep 60")).toBe(60);
		});

		it("'curl something; sleep 30' → 30 (sleep IS last)", () => {
			expect(getTrailingSleepSeconds("curl something; sleep 30")).toBe(30);
		});

		it("'npm test || sleep 60' → 60 (sleep IS last)", () => {
			expect(getTrailingSleepSeconds("npm test || sleep 60")).toBe(60);
		});

		it("'build && test && sleep 60' → 60 (sleep IS last)", () => {
			expect(getTrailingSleepSeconds("build && test && sleep 60")).toBe(60);
		});
	});

	describe("sleep is NOT the last segment (should return null)", () => {
		it("'sleep 60 && curl something' → null (sleep NOT last)", () => {
			expect(getTrailingSleepSeconds("sleep 60 && curl something")).toBeNull();
		});

		it("'sleep 60 && echo done' → null (sleep NOT last)", () => {
			expect(getTrailingSleepSeconds("sleep 60 && echo done")).toBeNull();
		});

		it("'echo start && sleep 60 && echo end' → null (sleep in middle)", () => {
			expect(getTrailingSleepSeconds("echo start && sleep 60 && echo end")).toBeNull();
		});
	});

	describe("non-sleep commands", () => {
		it("'curl localhost' → null", () => {
			expect(getTrailingSleepSeconds("curl localhost")).toBeNull();
		});

		it("'' → null", () => {
			expect(getTrailingSleepSeconds("")).toBeNull();
		});

		it("'echo sleepytime' → null", () => {
			expect(getTrailingSleepSeconds("echo sleepytime")).toBeNull();
		});
	});

	describe("threshold-relevant values", () => {
		it("'sleep 3' → 3 (short, below threshold but still detected)", () => {
			expect(getTrailingSleepSeconds("sleep 3")).toBe(3);
		});

		it("'sleep 5' → 5 (at threshold)", () => {
			expect(getTrailingSleepSeconds("sleep 5")).toBe(5);
		});

		it("'sleep 6' → 6 (above threshold)", () => {
			expect(getTrailingSleepSeconds("sleep 6")).toBe(6);
		});
	});
});

describe("segmentSleepSeconds", () => {
	it("'sleep 60' → 60", () => {
		expect(segmentSleepSeconds("sleep 60")).toBe(60);
	});

	it("'sleep 2m' → 120", () => {
		expect(segmentSleepSeconds("sleep 2m")).toBe(120);
	});

	it("'  sleep 30s  ' → 30 (whitespace OK)", () => {
		expect(segmentSleepSeconds("  sleep 30s  ")).toBe(30);
	});

	it("'sleep 60 && curl' → null (has operator, not sole sleep)", () => {
		expect(segmentSleepSeconds("sleep 60 && curl")).toBeNull();
	});

	it("'curl localhost' → null", () => {
		expect(segmentSleepSeconds("curl localhost")).toBeNull();
	});

	it("'sleep' → null (no duration)", () => {
		expect(segmentSleepSeconds("sleep")).toBeNull();
	});
});
