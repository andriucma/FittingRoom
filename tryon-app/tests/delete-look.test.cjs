const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

test('deleting a look removes it from the library, preserves recordings and other looks, and serializes with resume', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fittingroom-delete-'));
  try {
    const storage = loadTs('src/lib/server/storage.ts', { './config': { config: { dataDir: root } } });
    for (const id of ['look-one', 'look-two']) {
      await storage.writeJson(path.join(root, 'runs', id, 'run.json'), { id, status: 'done', createdAt: '2026-11-07', frames: [], outputs: {} });
      await fs.writeFile(path.join(root, 'runs', id, 'generated.png'), 'outfit');
    }
    await storage.writeJson(path.join(root, 'videos', 'recording', 'video.json'), { name: 'Original recording' });
    let enter, release;
    const entered = new Promise(resolve => enter = resolve);
    const released = new Promise(resolve => release = resolve);
    const active = new Set(['still-creating']);
    const runs = loadTs('src/lib/server/runs.ts', {
      './storage': storage, './ffmpeg': {}, './localModels': {}, './omni': {}, './shopify': {}, './garmentFocus': {}, './tryon': {}, './videos': {}, './catalog': {}, '@/lib/outfit': {},
      'node:fs/promises': { ...fs, rename: async (...args) => { enter(); await released; return fs.rename(...args); } },
    }, { __activeRuns: active });
    assert.equal(await runs.deleteRun('../../videos'), 'missing');
    assert.equal(await runs.deleteRun('still-creating'), 'busy');
    assert.equal(await runs.deleteRun('absent'), 'missing');
    const pending = runs.deleteRun('look-one'); await entered;
    assert.equal(await runs.deleteRun('look-one'), 'busy');
    await assert.rejects(runs.resumeRun('look-one'), /already running/);
    release(); assert.equal(await pending, 'deleted');
    assert.equal(await runs.getRun('look-one'), null);
    assert.deepEqual(Array.from(await runs.listRuns(), r => r.id), ['look-two']);
    assert.equal(await runs.deleteRun('look-one'), 'missing');
    assert.equal(await fs.readFile(path.join(root, 'videos', 'recording', 'video.json'), 'utf8').then(JSON.parse).then(x => x.name), 'Original recording');
    const archived = await fs.readdir(path.join(root, 'deleted-looks'));
    assert.equal(archived.length, 1);
    assert.equal(await fs.readFile(path.join(root, 'deleted-looks', archived[0], 'generated.png'), 'utf8'), 'outfit');
    assert.equal(active.has('look-one'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('delete API handles success, duplicate removal, active generation, and storage failure', async () => {
  for (const [result, expected] of [['deleted', 204], ['missing', 204], ['busy', 409], ['error', 500]]) {
    const api = loadTs('src/app/api/runs/[id]/route.ts', { '@/lib/server/runs': { deleteRun: async () => { if (result === 'error') throw Error('disk failure'); return result; } } });
    const response = await api.DELETE(new Request('http://localhost/api/runs/look-one', { method: 'DELETE' }), { params: Promise.resolve({ id: 'look-one' }) });
    assert.equal(response.status, expected);
  }
});
