import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/integration/**/*.test.ts"],
		testTimeout: 60_000, // sandbox install (npm pack + install) can be slow
	},
});
