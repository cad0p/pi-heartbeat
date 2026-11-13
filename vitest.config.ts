import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["__tests__/unit/**/*.test.ts"],
		setupFiles: ["__tests__/setup/empty-agent-dir.ts"],
	},
});
