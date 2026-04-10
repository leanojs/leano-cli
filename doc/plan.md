# Leano Remote Phase 1 Plan (VPS Agent + CLI Only)

## Scope for now

This phase builds only:
- `leano-agent` on VPS
- `leano` CLI remote commands

Not in scope now:
- Browser plugin
- WordPress plugin
- Cloud worker billing/dashboard

## Product goal

From local machine, user connects securely to VPS, selects an allowed folder, streams files to local process for compression, streams results back, and can choose merge mode (replace originals) with safety checks.

Hard rules:
- No image persistence on local disk during transfer/compress path
- Agent never exposes paths outside configured root
- Authenticated + encrypted transport only
- Observable and resumable operations

---

## Architecture (Phase 1)

### Components
- **CLI (local)**: session control, scan request, stream download/upload, local compression pipeline, progress and analytics
- **Agent (VPS)**: file discovery under root, chunked stream read/write, authN/authZ, path policy, operation journal
- **Transport**: HTTPS + WebSocket (or HTTP/2 streaming) with short-lived tokens

### Data path
1. CLI authenticates with agent and opens session.
2. CLI asks agent for manifest (`path`, `size`, `mtime`, hash optional).
3. CLI selects files (all/filter/interactive in CLI only).
4. For each file: agent streams source -> CLI compresses in memory -> CLI streams output back.
5. Agent writes to temp target and atomically swaps when file succeeds.
6. CLI prints analytics and summary; optional merge/delete policy executes.

---

## Security model (baseline standard)

### Trust boundaries
- Server filesystem is sensitive.
- Network is untrusted.
- CLI host is trusted by operator.

### Controls
- **mTLS or token + TLS** (pick one for v1; mTLS preferred for VPS teams).
- **Single root jail**: every request path resolved by `realpath` and verified under root.
- **Least privilege**: run agent under non-root user, restricted directory perms.
- **Short-lived session tokens** bound to client identity and session id.
- **Rate limits** and max payload/chunk limits.
- **No plaintext secrets in logs**.
- **Audit log**: who connected, what folder, file counts, failures.

### Merge safety
- Write to `file.tmp.<session>` then `rename` atomic replace.
- Keep optional backup (`.bak`) policy configurable.
- On failure: source remains unchanged.

---

## Protocol v1 (simple and strict)

### Control API
- `POST /v1/session/open`
- `POST /v1/session/close`
- `POST /v1/scan`
- `POST /v1/commit` (finalize merge if required)
- `GET /v1/health`

### Stream API
- `GET /v1/file/read?path=...`
- `PUT /v1/file/write?path=...&mode=temp|replace`

### Required metadata
- `x-session-id`
- `x-file-id`
- `x-content-sha256` (optional in v1, mandatory in v2)
- `x-original-size`, `x-output-size`

### Error contract
- Stable JSON error schema: `code`, `message`, `retryable`, `file`
- CLI maps errors to exit codes

---

## Implementation phases (step-by-step)

## Step 1: Agent foundation
- Create `agent/` package (TypeScript, strict mode).
- Implement config file:
  - allowed root
  - bind host/port
  - auth mode
  - limits
- Implement `/health`.
- Implement path guard utility (`resolve + containment`).

**Done criteria**
- Agent starts as service.
- Health endpoint works.
- Path traversal attempts are rejected.

## Step 2: Auth + session lifecycle
- Add session open/close.
- Add token validation (or mTLS client cert validation).
- Session TTL + idle timeout.

**Done criteria**
- Unauthorized requests blocked.
- Expired sessions rejected.

## Step 3: Manifest and scanning
- Implement recursive scan under root.
- Return manifest with relative paths + size + mtime.
- Add server-side filters (`jpg/jpeg/png` first).

**Done criteria**
- CLI receives deterministic manifest.
- Large folders paginated/streamed safely.

## Step 4: Secure streaming read/write
- Implement file read stream endpoint.
- Implement write-to-temp endpoint.
- Atomic finalize for each file.

**Done criteria**
- 1k+ files transfer with no local persistence.
- Kill/restart mid-run does not corrupt originals.

## Step 5: CLI remote command set
- Add `leano remote connect`
- Add `leano remote scan`
- Add `leano remote optimize`
- Add `--dry-run`, `--json`, `--quiet`, `--concurrency`

**Done criteria**
- End-to-end remote optimize works with current local compressor.

## Step 6: Resume + analytics
- Persist operation journal (session + file state).
- Add resume from last successful file.
- Add final analytics (bytes before/after, failure reasons, timings).

**Done criteria**
- Network interruption can resume without redoing completed files.

## Step 7: Hardening + performance
- Tune chunk size and worker concurrency.
- Add backpressure controls.
- Add rate limiting and request limits.
- Add soak test (50k files scenario).

**Done criteria**
- Stable under long runs.
- No memory growth leaks.

---

## Standards checklist

- TypeScript strict, no `any` in public boundaries
- Structured logs with correlation ids
- Unit tests for:
  - path guard
  - session auth
  - atomic replace logic
- Integration tests:
  - CLI <-> agent happy path
  - interrupted stream recovery
  - malicious path attempts
- Security tests:
  - traversal, replay token, oversized payload
- CI gates:
  - lint
  - typecheck
  - tests

---

## Initial file/folder proposal

- `agent/src/server.ts`
- `agent/src/auth.ts`
- `agent/src/session.ts`
- `agent/src/scan.ts`
- `agent/src/stream.ts`
- `agent/src/pathGuard.ts`
- `agent/src/config.ts`
- `cli/src/remote/*.ts` (or keep in current `src/` with module split)

---

## First milestone to implement next (smallest valuable increment)

**Milestone A**
- Agent health endpoint
- Path guard utility
- Session open/close (token auth)
- CLI `remote connect` and `remote scan`

This gives secure connectivity and folder visibility before file streaming.