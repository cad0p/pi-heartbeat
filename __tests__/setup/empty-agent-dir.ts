/**
 * Keep the developer's own background-work policy out of the suite.
 *
 * A test's project directory rarely has a `.pi/background-work.json`, so the lookup falls through to
 * the agent directory, where a policy set for real sessions (say `{"maxBackgroundWait": 1}`) would
 * refuse waits the tests use and fail them for a reason that is not in the code. Point that lookup
 * at an empty directory for every test file; a test that wants a policy writes one under its cwd.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "pi-heartbeat-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
