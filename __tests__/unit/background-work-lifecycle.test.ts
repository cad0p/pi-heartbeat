import { BACKGROUND_WORK_REGISTRY_KEY, listBackgroundWorkProviders, snapshotBackgroundWork } from "@cad0p/pi-background-work";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../src/timer-manager.js";
import { activation, listedWork, resetBackgroundWork, resetSessions, sentContents } from "./reload-harness.js";

const PROVIDER = "pi-heartbeat";

function providerNamed(): unknown {
	return listBackgroundWorkProviders().find((provider) => provider.name === PROVIDER);
}

/** Make an entry unreadable by the provider (pending must be an array). Its dispose still works without a heartbeat. */
function corrupt(key: string): void {
	const entry = registry().get(key);
	if (!entry) {
		throw new Error(`no entry for ${key}`);
	}
	Reflect.set(entry, "pending", 5);
}

describe("background work: registration and corrupt state", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetBackgroundWork();
	});

	afterEach(() => {
		resetSessions();
		vi.useRealTimers();
	});

	it("(6) startup registers once; reload replaces; quit does not remove the provider", () => {
		const first = activation();
		first.start("startup");
		const registered = providerNamed();
		expect(registered).toBeDefined();

		const second = activation();
		second.start("startup");
		expect(providerNamed()).toBe(registered);

		first.shutdown("quit");
		expect(providerNamed()).toBe(registered);

		second.shutdown("reload");
		const reloaded = activation(second.key);
		reloaded.start("reload");
		expect(providerNamed()).not.toBe(registered);
	});

	it("(7) listing never throws when an entry is corrupt", async () => {
		const broken = activation();
		const healthy = activation();
		broken.start("startup");
		healthy.start("startup");
		await healthy.setTimer(60, "x", "ok");
		corrupt(broken.key);

		expect(() => snapshotBackgroundWork([broken.key, healthy.key])).not.toThrow();
	});

	it("(10) a malformed foreign provider does not stop binding, timers or registration", async () => {
		Reflect.set(globalThis, Symbol.for(BACKGROUND_WORK_REGISTRY_KEY), {
			version: 1,
			providers: new Map([["foreign", { name: "other" }]]),
		});
		expect(() => listBackgroundWorkProviders()).toThrow();
		const act = activation();

		expect(() => act.start("startup")).not.toThrow();
		expect(registry().has(act.key)).toBe(true);
		// The public list throws in this state, so read the raw registry to see pi-heartbeat's registration.
		const slot = Reflect.get(globalThis, Symbol.for(BACKGROUND_WORK_REGISTRY_KEY)) as { providers: Map<string, unknown> };
		expect(slot.providers.has(PROVIDER)).toBe(true);

		await act.setTimer(10, "x");
		vi.advanceTimersByTime(10_000);
		expect(sentContents(act)).toEqual([expect.stringContaining("fired (after 10s): x")]);
	});

	it("(11) a corrupt entry is skipped; other sessions are still listed", async () => {
		const broken = activation();
		const first = activation();
		const second = activation();
		broken.start("startup");
		first.start("startup");
		second.start("startup");
		await broken.setTimer(60, "x", "lost");
		await first.setTimer(60, "y", "one");
		await second.setTimer(60, "z", "two");
		corrupt(broken.key);

		expect(listedWork(broken.key)).toEqual([]);
		expect(listedWork(first.key)).toEqual(["timer:one"]);
		expect(listedWork(second.key)).toEqual(["timer:two"]);
	});
});
