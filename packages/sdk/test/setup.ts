import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point every test file at a throwaway home so default-on persistence/cleanup
// never touches the developer's real ~/.lite-agent.
process.env.LITE_AGENT_HOME = mkdtempSync(join(tmpdir(), "lite-home-"));
