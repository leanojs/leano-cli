import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";
import type { AgentConfig } from "./config.js";
import { SessionStore } from "./session.js";
import { scanFiles } from "./scan.js";
import {
  resolveAgentPath,
  streamFileToResponse,
  writeAtomicReplace,
  writeToSessionTemp,
} from "./stream.js";

type RateBucket = { count: number; resetAt: number };
const ipBuckets = new Map<string, RateBucket>();

function json(
  res: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function isAuthorized(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const value = req.headers.authorization;
  if (!value) return false;
  return value === `Bearer ${token}`;
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid JSON body");
  }
  return parsed as Record<string, unknown>;
}

function parseSessionId(req: http.IncomingMessage): string | null {
  const v = req.headers["x-session-id"];
  if (typeof v !== "string" || v.length === 0) return null;
  return v;
}

function parsePagination(body: Record<string, unknown>): { offset: number; limit: number } {
  const rawOffset = body.offset;
  const rawLimit = body.limit;

  const offset =
    typeof rawOffset === "number" && Number.isFinite(rawOffset) && rawOffset >= 0
      ? Math.floor(rawOffset)
      : 0;

  const limitCandidate =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : 1000;

  const limit = Math.min(limitCandidate, 5000);
  return { offset, limit };
}

function isRateLimited(req: http.IncomingMessage, config: AgentConfig): boolean {
  const ip = req.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const existing = ipBuckets.get(ip);
  if (!existing || now >= existing.resetAt) {
    ipBuckets.set(ip, {
      count: 1,
      resetAt: now + config.rateLimitWindowMs,
    });
    return false;
  }
  existing.count += 1;
  return existing.count > config.rateLimitMaxRequests;
}

export function createAgentServer(
  config: AgentConfig,
  sessions: SessionStore,
): http.Server {
  return http.createServer(async (req, res) => {
    const requestUrl = req.url
      ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`)
      : null;

    if (!req.url || !req.method) {
      json(res, 400, { error: "Bad request" });
      return;
    }
    if (isRateLimited(req, config)) {
      json(res, 429, { error: "Rate limit exceeded" });
      return;
    }

    sessions.cleanupExpired();

    if (requestUrl?.pathname === "/v1/health" && req.method === "GET") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      json(res, 200, {
        ok: true,
        service: "leano-agent",
        ts: new Date().toISOString(),
      });
      return;
    }

    if (requestUrl?.pathname === "/v1/session/open" && req.method === "POST") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      const session = sessions.open();
      json(res, 200, {
        ok: true,
        sessionId: session.id,
        expiresAt: new Date(session.expiresAt).toISOString(),
        idleTimeoutMs: config.sessionIdleTimeoutMs,
      });
      return;
    }

    if (requestUrl?.pathname === "/v1/session/close" && req.method === "POST") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, config.maxJsonBodyBytes);
      } catch (err) {
        json(res, 400, {
          error: err instanceof Error ? err.message : "Invalid request body",
        });
        return;
      }

      const sessionId = body.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        json(res, 400, { error: "sessionId is required" });
        return;
      }

      const closed = sessions.close(sessionId);
      json(res, 200, { ok: true, closed });
      return;
    }

    if (requestUrl?.pathname === "/v1/scan" && req.method === "POST") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }

      const sessionId = parseSessionId(req);
      if (!sessionId) {
        json(res, 401, { error: "Missing x-session-id" });
        return;
      }

      const session = sessions.touch(sessionId);
      if (!session) {
        json(res, 401, { error: "Invalid or expired session" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, config.maxJsonBodyBytes);
      } catch (err) {
        json(res, 400, {
          error: err instanceof Error ? err.message : "Invalid request body",
        });
        return;
      }

      const targetDir =
        typeof body.targetDir === "string" && body.targetDir.length > 0
          ? body.targetDir
          : ".";
      const extensions =
        Array.isArray(body.extensions) && body.extensions.every((x) => typeof x === "string")
          ? (body.extensions as string[])
          : undefined;
      const { offset, limit } = parsePagination(body);

      try {
        const all = scanFiles(config.rootDir, targetDir, extensions);
        const page = all.slice(offset, offset + limit);
        json(res, 200, {
          ok: true,
          sessionId: session.id,
          total: all.length,
          offset,
          limit,
          hasMore: offset + page.length < all.length,
          items: page,
        });
      } catch (err) {
        json(res, 400, {
          error: err instanceof Error ? err.message : "Scan failed",
        });
      }
      return;
    }

    if (requestUrl?.pathname === "/v1/file/read" && req.method === "GET") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const sessionId = parseSessionId(req);
      if (!sessionId || !sessions.touch(sessionId)) {
        json(res, 401, { error: "Invalid or expired session" });
        return;
      }

      const relPath = requestUrl.searchParams.get("path");
      if (!relPath) {
        json(res, 400, { error: "Query parameter \"path\" is required" });
        return;
      }

      try {
        const absPath = resolveAgentPath(config.rootDir, relPath);
        await streamFileToResponse(absPath, res);
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : "Read failed" });
      }
      return;
    }

    if (requestUrl?.pathname === "/v1/file/write" && req.method === "PUT") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const sessionId = parseSessionId(req);
      if (!sessionId || !sessions.touch(sessionId)) {
        json(res, 401, { error: "Invalid or expired session" });
        return;
      }

      const relPath = requestUrl.searchParams.get("path");
      if (!relPath) {
        json(res, 400, { error: "Query parameter \"path\" is required" });
        return;
      }

      const mode = requestUrl.searchParams.get("mode") ?? "replace";
      if (mode !== "replace" && mode !== "temp") {
        json(res, 400, { error: "mode must be one of: replace, temp" });
        return;
      }

      try {
        const absPath = resolveAgentPath(config.rootDir, relPath);
        if (mode === "replace") {
          const result = await writeAtomicReplace(req, absPath, sessionId, config.maxWriteBytes);
          json(res, 200, {
            ok: true,
            mode,
            path: relPath,
            bytesWritten: result.bytesWritten,
          });
          return;
        }

        const result = await writeToSessionTemp(
          req,
          config.rootDir,
          relPath,
          sessionId,
          config.maxWriteBytes,
        );
        json(res, 200, {
          ok: true,
          mode,
          path: relPath,
          tempPath: result.tempPath,
          bytesWritten: result.bytesWritten,
        });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : "Write failed" });
      }
      return;
    }

    if (requestUrl?.pathname === "/v1/file/delete" && req.method === "DELETE") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const sessionId = parseSessionId(req);
      if (!sessionId || !sessions.touch(sessionId)) {
        json(res, 401, { error: "Invalid or expired session" });
        return;
      }

      const relPath = requestUrl.searchParams.get("path");
      if (!relPath) {
        json(res, 400, { error: "Query parameter \"path\" is required" });
        return;
      }

      try {
        const absPath = resolveAgentPath(config.rootDir, relPath);
        await fs.promises.unlink(absPath);
        json(res, 200, { ok: true, path: relPath, deleted: true });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : "Delete failed" });
      }
      return;
    }

    if (requestUrl?.pathname === "/v1/file/move" && req.method === "POST") {
      if (!isAuthorized(req, config.authToken)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const sessionId = parseSessionId(req);
      if (!sessionId || !sessions.touch(sessionId)) {
        json(res, 401, { error: "Invalid or expired session" });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req, config.maxJsonBodyBytes);
      } catch (err) {
        json(res, 400, {
          error: err instanceof Error ? err.message : "Invalid request body",
        });
        return;
      }

      const fromPath = typeof body.fromPath === "string" ? body.fromPath : "";
      const toPath = typeof body.toPath === "string" ? body.toPath : "";
      if (!fromPath || !toPath) {
        json(res, 400, { error: "fromPath and toPath are required" });
        return;
      }

      try {
        const fromAbs = resolveAgentPath(config.rootDir, fromPath);
        const toAbs = resolveAgentPath(config.rootDir, toPath);
        await fs.promises.mkdir(path.dirname(toAbs), { recursive: true });
        await fs.promises.rename(fromAbs, toAbs);
        json(res, 200, { ok: true, fromPath, toPath, moved: true });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : "Move failed" });
      }
      return;
    }

    json(res, 404, { error: "Not found" });
  });
}
