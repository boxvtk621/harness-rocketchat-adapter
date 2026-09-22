// Controlled provider substitute for Web acceptance. Never accepts real credentials.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const nodeId = '33333333-3333-4333-8333-333333333333';
const bootId = randomUUID();
const state = { schemaId: 'harness-provider-auth-v1', nodeId, revision: 1, state: 'unauthenticated', checkedAt: new Date().toISOString(), reasonCode: null,
  capabilities: { methods: ['device_code', 'secret'], canCheck: true, canLogout: true }, operation: null };
const receipts = new Map();
function complete(status, operationId = state.operation?.operationId) {
  if (!state.operation || state.operation.operationId !== operationId || state.operation.status !== 'pending') return;
  state.operation = { ...state.operation, status, updatedAt: new Date().toISOString(), userCode: null, verificationUrl: null,
    reasonCode: status === 'failed' ? 'invalid_secret' : status === 'expired' ? 'timeout' : null };
  if (status === 'succeeded') state.state = 'authenticated';
  state.checkedAt = new Date().toISOString(); state.revision++;
}
https.createServer({ key: readFileSync('/run/secrets/harness_server_key'), cert: readFileSync('/run/config/harness_server_cert') }, async (req, res) => {
  const url = new URL(req.url, 'https://auth-fixture');
  const path = url.pathname.replace(/^\/fixture/, '');
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  let body = {};
  try { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 32768) throw Error(); } if (raw) body = JSON.parse(raw); }
  catch { return send(400, { code: 'invalid_request' }); }
  if (path === '/control' && req.method === 'POST') { complete(body.status, body.operationId ?? state.operation?.operationId); return send(200, { ok: true }); }
  if (path === '/v1/identity') return send(200, { protocolVersion: 1, schemaId: 'harness-wire-v2', nodeId });
  if (path === '/health/live') return send(200, { status: 'live' });
  if (path === '/health/ready') return send(200, { readiness: state.state === 'authenticated' ? 'ready' : 'blocked' });
  if (path === '/v1/executor/heartbeat') return send(200, { nodeId, bootId, observedAt: new Date().toISOString(), health: 'live', readiness: state.state === 'authenticated' ? 'ready' : 'blocked', capacity: 1 });
  if (path.endsWith('/snapshot')) return send(200, { protocolVersion: 1, schemaId: 'harness-wire-v2', nodeId, node: { occupancy: 'idle' } });
  if (!path.startsWith('/v1/provider-auth')) return send(404, { code: 'not_found' });
  if ((req.method === 'GET' ? url.searchParams.get('nodeId') : body.nodeId) !== nodeId) return send(404, { code: 'node_mismatch' });
  if (req.method === 'GET') return send(200, state);
  if (receipts.has(body.commandId)) return send(200, state);
  if (path.endsWith('/operations')) {
    if (state.operation?.status === 'pending') return send(409, { code: 'pending_operation' });
    if (!state.capabilities.methods.includes(body.method)) return send(422, { code: 'unsupported_method' });
    const now = new Date().toISOString();
    state.operation = { operationId: randomUUID(), commandId: body.commandId, method: body.method, status: 'pending', createdAt: now, updatedAt: now, reasonCode: null,
      verificationUrl: body.method === 'device_code' ? 'https://example.test/activate' : null,
      userCode: body.method === 'device_code' ? 'TEST-CODE' : null, expiresAt: null, timeoutAt: new Date(Date.now() + 600000).toISOString() };
    state.revision++;
    const operationId = state.operation.operationId;
    if (body.method === 'secret') setTimeout(() => complete(body.secret === 'synthetic-valid' ? 'succeeded' : 'failed', operationId), 500);
  } else if (path.endsWith('/cancel')) complete('cancelled');
  else if (path.endsWith('/logout')) { state.state = 'unauthenticated'; state.operation = null; state.revision++; }
  else if (path.endsWith('/check')) { state.checkedAt = new Date().toISOString(); state.revision++; }
  else return send(404, { code: 'not_found' });
  receipts.set(body.commandId, true);
  send(200, state);
}).listen(8443, '0.0.0.0');
