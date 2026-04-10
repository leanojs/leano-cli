import fs from "fs";
import { loadConfig } from "./config.js";
import { createAgentServer } from "./server.js";
import { assertInsideRoot } from "./pathGuard.js";
import { SessionStore } from "./session.js";

function main(): void {
  const config = loadConfig();

  if (!fs.existsSync(config.rootDir) || !fs.statSync(config.rootDir).isDirectory()) {
    throw new Error(`AGENT_ROOT_DIR must exist and be a directory: ${config.rootDir}`);
  }

  // Early guard sanity-check to fail fast on invalid root setup.
  assertInsideRoot(config.rootDir, config.rootDir);

  const sessions = new SessionStore(
    config.sessionTtlMs,
    config.sessionIdleTimeoutMs,
  );
  const server = createAgentServer(config, sessions);
  server.listen(config.port, config.host, () => {
    // stderr log keeps stdout free for future machine-readable output.
    console.error(
      `[leano-agent] listening on http://${config.host}:${config.port} root=${config.rootDir}`,
    );
  });
}

main();
