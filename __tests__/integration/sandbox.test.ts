/**
 * Sandbox install test — verifies the published package loads correctly in a
 * clean npm install environment (npm pack → install → DefaultResourceLoader).
 */

import { describe, it, expect } from "vitest";
import { verifySandboxInstall } from "@marcfargas/pi-test-harness";

describe("sandbox install", () => {
	it(
		"loads extension and tools without errors",
		async () => {
			const result = await verifySandboxInstall({
				packageDir: ".",
				expect: {
					extensions: 1,
					tools: ["timer", "heartbeat"],
					// Note: verifySandboxInstall does not process pi.skills from the
					// installed package manifest — only pi.extensions is resolved.
					// Skills therefore show as 0 in sandbox mode.
				},
			});

			// No extension load errors
			expect(result.loaded.extensionErrors).toEqual([]);

			// One extension loaded
			expect(result.loaded.extensions).toBe(1);

			// Both tools present
			expect(result.loaded.tools).toContain("timer");
			expect(result.loaded.tools).toContain("heartbeat");

			// Skills are not discoverable in sandbox mode (harness limitation):
			// DefaultResourceLoader receives no skill paths from the package manifest.
			expect(result.loaded.skills).toBe(0);
		},
		120_000, // npm pack + install can be slow
	);
});
