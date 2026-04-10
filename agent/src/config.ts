import path from "path";

export interface AgentConfig {
  host: string;
  port: number;
  rootDir: string;
  authToken?: string;
  sessionTtlMs: number;
  sessionIdleTimeoutMs: number;
  maxJsonBodyBytes: number;
  maxWriteBytes: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
}

function parsePort(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const port = Number.parseInt(input, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid AGENT_PORT "${input}"`);
  }
  return port;
}

function parseDurationMs(
  input: string | undefined,
  fallback: number,
  label: string,
): number {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value < 1000) {
    throw new Error(`Invalid ${label} "${input}" (must be >= 1000 ms)`);
  }
  return value;
}

function parsePositiveInt(input: string | undefined, fallback: number, label: string): number {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`Invalid ${label} "${input}" (must be >= 1)`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const rootDirInput = env.AGENT_ROOT_DIR ?? ".";
  const rootDir = path.resolve(rootDirInput);

  return {
    host: env.AGENT_HOST ?? "127.0.0.1",
    port: parsePort(env.AGENT_PORT, 4310),
    rootDir,
    authToken: env.AGENT_AUTH_TOKEN,
    sessionTtlMs: parseDurationMs(env.AGENT_SESSION_TTL_MS, 30 * 60 * 1000, "AGENT_SESSION_TTL_MS"),
    sessionIdleTimeoutMs: parseDurationMs(
      env.AGENT_SESSION_IDLE_TIMEOUT_MS,
      5 * 60 * 1000,
      "AGENT_SESSION_IDLE_TIMEOUT_MS",
    ),
    maxJsonBodyBytes: parsePositiveInt(env.AGENT_MAX_JSON_BODY_BYTES, 64 * 1024, "AGENT_MAX_JSON_BODY_BYTES"),
    maxWriteBytes: parsePositiveInt(env.AGENT_MAX_WRITE_BYTES, 50 * 1024 * 1024, "AGENT_MAX_WRITE_BYTES"),
    rateLimitWindowMs: parseDurationMs(env.AGENT_RATE_LIMIT_WINDOW_MS, 60 * 1000, "AGENT_RATE_LIMIT_WINDOW_MS"),
    rateLimitMaxRequests: parsePositiveInt(env.AGENT_RATE_LIMIT_MAX_REQUESTS, 120, "AGENT_RATE_LIMIT_MAX_REQUESTS"),
  };
}
