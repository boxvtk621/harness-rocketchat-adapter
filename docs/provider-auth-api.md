# Provider authorization API

Implemented for HL-306 revision 1. This is provider login; the private Harness API has no inbound caller authentication.

Harness extension schema: `harness-provider-auth-v1`. A single generic client uses these routes beneath the registered base URI (path prefix and base query are retained):

| Method | Route | Input |
| --- | --- | --- |
| GET | `/v1/provider-auth` | query `nodeId` |
| GET | `/v1/provider-auth/operations/{operationId}` | query `nodeId` |
| POST | `/v1/provider-auth/operations` | `{nodeId,commandId,method,secret?}` |
| POST | `/v1/provider-auth/check` | `{nodeId,commandId}` |
| POST | `/v1/provider-auth/operations/{operationId}/cancel` | `{nodeId,commandId}` |
| POST | `/v1/provider-auth/logout` | `{nodeId,commandId}` |

Identifiers are exact lowercase UUIDs. Commands are idempotent by command ID. Only one pending operation is allowed. A lost response does not justify a new command ID: read current state, or explicitly retry the same ID. The browser never automatically resends a secret; the operator must re-enter it for an explicit retry. Unknown JSON fields are rejected. Secret is required for `secret` and forbidden for `device_code`; blank input never clears credentials. Logout is a distinct command.

All successful routes return `{schemaId,nodeId,revision,state,checkedAt,reasonCode,capabilities,operation}`. Capabilities contain `methods` (enum array), `canCheck`, `canLogout`. Auth state is `unknown`, `unauthenticated`, `authenticated`, or `reauthentication_required`; it is separate from process health and attempt state. An operation contains `operationId,commandId,method,status,createdAt,updatedAt,reasonCode,verificationUrl,userCode,expiresAt,timeoutAt`. Attempt status is `pending`, `succeeded`, `failed`, `cancelled`, or `expired`. Provider expiry and the Harness's own timeout are separate nullable timestamps. Only pending device operations expose the HTTPS verification link and one-time user code.

Adapter routes mirror the suffix beneath `/api/connections/{connectionId}/provider-auth`. Every request additionally requires query `configEpoch`; reads require query `nodeId`, mutations carry `nodeId` in JSON. Adapter checks the observed node identity, connection epoch, and identity conflicts before dispatch and discards responses if the connection changes while waiting. Gateway only forwards the internal Adapter token; no Web JWT/cookie/internal token reaches Harness. Redirects are disabled. Incoming bodies and outgoing auth JSON are limited to 32 KiB; secret strings to 16 KiB. Responses use `Cache-Control: no-store`.

Errors contain only `{code}`. HTTP 400 invalid request, 404 missing node/operation or unsupported endpoint, 409 busy/pending/idempotency/connection conflict, 422 unsupported method, 503 provider temporarily unavailable. Unknown upstream error strings and payload fields are not reflected. Network failure is not evidence of revoked credentials.

`GET /api/session` exposes `canManageConnections`. Gateway requires realm role `connections.manage` for all provider-auth reads and commands and connection mutations. Ordinary authenticated observers retain public observations/projections but cannot obtain login codes or account data. Apply this role to authorized users when migrating an existing Keycloak realm; realm import only initializes a new realm. The isolated bootstrap provisions an operator with the role and an observer without it. Their randomly generated Web passwords are in ignored runtime files and are unrelated to provider credentials.

Adapter does not persist provider credentials, auth operation payloads, or codes in Mongo. Centrifugo publishes only node invalidation (connection ID and kind). Credentials are stored exclusively in private per-Harness provider volumes. Gateway has no database dependencies. The UI polls only the visible auth inspector, uses one request at a time, and restores state through API after reload/reconnect. Codes and credentials never enter browser storage.

## Local acceptance

Use `web/scripts/bootstrap.ps1` with a dedicated `hl306-*` project, unique ports, and explicit source worktrees. `web/compose.auth-test.yaml` adds a clearly identified synthetic provider Harness behind the real Adapter/Gateway; it is only for controlled acceptance. Its results never demonstrate a real provider login. `web/tests/e2e/auth-acceptance.mjs` exercises the UI, permissions, prefix URI, replay/conflicts, cancellation/expiry, lost ACK, polling and screenshots. No model invocation is part of these tests.

Run `web/scripts/accept-auth.ps1` for the complete isolated acceptance: controlled browser checks, actual unauthenticated Harness status and Codex device-code start/cancel, stack restart, Harness container recreation with the same volumes, persisted command replay, and the browser checks again. `-SkipBuild` is only for images already built from the current worktrees. The runner never completes provider login. Successful owner login and account persistence after that login remain a separate manual acceptance step.

The ordinary Compose services expose only Client and Keycloak on loopback. Harness services use the private `harness` network plus `provider-egress`, with no published ports. Each mounts its own `*-provider-auth` volume. Shared runtime, other worktrees and existing credentials must not be adopted.
