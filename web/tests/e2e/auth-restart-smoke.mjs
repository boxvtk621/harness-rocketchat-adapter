import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
assert.equal(process.env.ACCEPTANCE_ISOLATED, 'true');
assert.match(process.env.COMPOSE_PROJECT_NAME ?? '', /^hl306-/);
const mode = process.argv[2]; assert.ok(['before', 'after'].includes(mode));
const ca = await readFile('/run/config/harness_server_cert');
const file = (process.env.OUTPUT_DIR ?? '/output') + '/auth-restart-before.json';
const invalidSecret = 'hl306-invalid-credential-for-restart-test';
async function request(host, path, data) {
  return new Promise((resolve, reject) => {
    const req = https.request('https://' + host + ':8443' + path, { ca, method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => {
        try { assert.ok([200, 202].includes(res.statusCode)); resolve(JSON.parse(raw)); } catch { reject(Error('Invalid Harness response (details suppressed).')); }
      });
    });
    req.on('error', () => reject(Error('Harness unavailable (details suppressed).')));
    req.setTimeout(20000, () => req.destroy(Error('Harness request timeout.')));
    req.end(data ? JSON.stringify(data) : undefined);
  });
}
async function read(host, nodeId) {
  for (let i=0; i<60; i++) { try { return await request(host, '/v1/provider-auth?nodeId=' + nodeId); } catch { await new Promise(r => setTimeout(r, 1000)); } }
  throw Error('Harness did not recover.');
}
const nodes = [{ host:'cursor-harness', nodeId:'11111111-1111-4111-8111-111111111111' },{ host:'codex-harness', nodeId:'22222222-2222-4222-8222-222222222222' }];
try {
  const before = mode === 'after' ? JSON.parse(await readFile(file, 'utf8')) : [];
  const results = [];
  for (const node of nodes) {
    let current = await read(node.host, node.nodeId);
    if (mode === 'before' && current.capabilities.methods.includes('secret')) {
      const commandId = randomUUID();
      await request(node.host, '/v1/provider-auth/operations', { nodeId: node.nodeId, commandId, method: 'secret', secret: invalidSecret });
      for (let i = 0; i < 60; i++) {
        current = await read(node.host, node.nodeId);
        if (current.operation?.commandId === commandId && current.operation.status !== 'pending') break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.equal(current.operation?.commandId, commandId);
      assert.equal(current.operation?.status, 'failed', 'invalid sentinel must create a terminal failed receipt');
    }
    assert.notEqual(current.state, 'authenticated'); assert.notEqual(current.operation?.status, 'pending');
    const safe = { ...node, state: current.state, operationId: current.operation?.operationId ?? null,
      commandId: current.operation?.commandId ?? null, status: current.operation?.status ?? null, method: current.operation?.method ?? null };
    if (mode === 'after') {
      const original = before.find(x => x.host === node.host);
      assert.equal(safe.operationId, original.operationId); assert.equal(safe.status, original.status);
      if (original.operationId) {
        const replay = await request(node.host, '/v1/provider-auth/operations', { nodeId: node.nodeId, commandId: original.commandId, method: original.method,
          ...(original.method === 'secret' ? { secret: invalidSecret } : {}) });
        assert.equal(replay.operation.operationId, original.operationId); assert.equal(replay.operation.status, original.status);
        assert.equal(replay.operation.userCode, null); assert.equal(replay.operation.verificationUrl, null);
      }
    }
    results.push(safe);
  }
  await writeFile(mode === 'before' ? file : file.replace('before','after'), JSON.stringify(results,null,2));
  console.log('PASS: ' + mode + ' container recreation auth ledger/operation readback; no completed provider login.');
} catch { console.error('FAIL: auth ledger recreation smoke (sensitive details suppressed).'); process.exitCode=1; }
