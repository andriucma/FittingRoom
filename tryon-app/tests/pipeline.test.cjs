const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const outfit = loadTs('src/lib/outfit.ts');
const listing = id => ({ id, title: id === 1 ? 'Cotton tee' : 'Relaxed pants', productType: id === 1 ? 'T-Shirt' : 'Pants', category: id === 1 ? 'top' : 'bottom', color: 'black', fit: 'regular', storeId: 1 });

function harness({ failGemini = false, failFrame = false, failComparison = false } = {}) {
  const saved = new Map(), calls = [];
  let resolveTerminal, terminal;
  const reset = () => { terminal = new Promise(r => resolveTerminal = r); };
  reset();
  const angles = { selected: [0, 90, 180].map((angle, index) => ({ index, est_deg: angle, file: `/frames/${index}.jpg` })), track: [{ angle_deg: 0, t: 0 }, { angle_deg: 345, t: 6.208 }], fps: 30, total_rotation_deg: 345, direction: 'right' };
  const runner = loadTs('src/lib/server/runs.ts', {
    './catalog': { getCatalogProduct: listing }, '@/lib/outfit': outfit,
    './storage': { paths: { runs: '/runs' }, isSafeId: () => true, newId: () => 'test', ensureDir: async p => p, fileUrl: p => p,
      readJson: async p => p.endsWith('angles.json') ? angles : saved.get(p),
      writeJson: async (p, r) => { saved.set(p, structuredClone(r)); if (['error', 'done'].includes(r.status)) resolveTerminal(structuredClone(r)); } },
    './videos': { getVideo: async () => ({ file: '/source.mp4' }), cachedAngles: async () => angles },
    './shopify': { importProduct: async id => ({ ...listing(id), kind: id === 1 ? 'top' : 'bottom' }) },
    './garmentFocus': { isolatedReferenceViews: async p => { calls.push(['isolate', p.id]); return { noun: p.id === 1 ? 't-shirt' : 'pants', views: { front: `/garments/${p.id}/reference.png` } }; } },
    './localModels': { localModels: { synchronizeVideos: async () => { calls.push(['sync']); if (failComparison) { failComparison = false; throw Error('Local comparison failed'); } return { duration: 7, method: 'pose-dtw' }; }, normalizeFraming: async (frames, out) => { calls.push(['sam']); return { outputs: frames.map((_, i) => `${out}/${i}.png`), spread_pct: { height: { before: 8, after: .2 } }, seconds: 1 }; } } },
    './ffmpeg': { framesToVideo: async () => {}, sideBySide: async () => {}, trimWholeSeconds: async () => ({ seconds: 7 }) },
    './tryon': { backgroundPlate: async () => ({ file: '/plate.png', costUsd: 0 }),
      planFrame: (a, t, b) => ({ refs: [t.views.front, b.views.front], prompt: 'outfit', views: [] }),
      pool: async (items, n, fn) => Promise.allSettled(items.map(fn)),
      editImage: async args => { calls.push(['edit', args]); if (failFrame && args.images[0] === '/frames/1.jpg') { failFrame = false; throw Error('Frame failed'); } return { costUsd: .07, seconds: 1 }; } },
    './omni': { omniPrompt: () => '', omniEdit: async args => { calls.push(['omni', args]); if (failGemini) { failGemini = false; throw Error('Gemini temporary failure'); } return { costUsd: .3, seconds: 1 }; } },
  });
  const input = { videoId: 'v1', top: 1, bottom: 2, background: 'original', stepDeg: 30, model: 'test', quality: 'medium', omni: { enabled: true, resolution: '720p' } };
  return { runner, input, calls, reset, finish: async () => { const result = await terminal; await new Promise(r => setImmediate(r)); return result; } };
}

test('only isolated garment references enter image edits; Gemini retry preserves completed frames', async () => {
  const h = harness({ failGemini: true });
  await h.runner.startRun(h.input); const first = await h.finish();
  assert.equal(first.status, 'error'); assert.equal(first.steps.omni.status, 'error');
  for (const [, edit] of h.calls.filter(c => c[0] === 'edit')) {
    assert.ok(edit.images.slice(1).every(p => p.endsWith('/reference.png')));
    assert.ok(!edit.images.some(p => p.endsWith('/focus.png')));
  }
  h.reset(); await h.runner.resumeRun('test'); const resumed = await h.finish();
  assert.equal(resumed.status, 'done');
  assert.equal(h.calls.filter(c => c[0] === 'edit').length, 3);
  assert.equal(h.calls.filter(c => c[0] === 'isolate').length, 2);
  assert.equal(h.calls.filter(c => c[0] === 'sam').length, 1);
  assert.ok(h.calls.find(c => c[0] === 'omni')[1].refs.every(p => p.includes('/aligned/')));
});

test('partial image failure prevents incomplete video; retry generates only the missing frame', async () => {
  const h = harness({ failFrame: true }); await h.runner.startRun(h.input); const first = await h.finish();
  assert.equal(first.status, 'error'); assert.equal(first.steps.tryon.status, 'error');
  assert.equal(h.calls.filter(c => c[0] === 'omni').length, 0);
  h.reset(); await h.runner.resumeRun('test'); const resumed = await h.finish();
  assert.equal(resumed.status, 'done'); assert.equal(h.calls.filter(c => c[0] === 'edit').length, 4);
});

test('catalog suggestions exclude overlapping sets and retain requested kind/department/store filters', async () => {
  const candidates = [
    { ...listing(2), department: 'unisex', storeId: 1, image: '/pants.jpg' },
    { ...listing(3), title: 'Matching set', category: 'bottom', productType: 'Set' },
    { ...listing(4), category: 'top', productType: 'T-Shirt' },
  ];
  let filters;
  const api = loadTs('src/app/api/products/route.ts', { '@/lib/server/catalog': { getCatalogProduct: id => id === 1 ? listing(1) : null, searchCatalog: opts => { filters = opts; return candidates; } }, '@/lib/outfit': outfit });
  const response = await api.GET({ nextUrl: new URL('http://localhost/api/products?kind=bottom&department=womens&store=2&pairWith=1') });
  const body = await response.json();
  assert.equal(filters.department, 'womens'); assert.equal(filters.storeId, 2);
  assert.equal(body.suggestions.length, 1); assert.equal(body.suggestions[0].id, 2);
  assert.equal(body.products.length, 0); assert.ok(body.suggestions[0].matchReason);
});


test('comparison failure preserves the paid Gemini output and retries only local synchronization', async () => {
  const h = harness({ failComparison: true });
  await h.runner.startRun(h.input); const first = await h.finish();
  assert.equal(first.status, 'error'); assert.ok(first.outputs.omni); assert.equal(first.cost.geminiUsd, .3);
  h.reset(); await h.runner.resumeRun('test'); const result = await h.finish();
  assert.equal(result.status, 'done'); assert.ok(result.outputs.omniCompare);
  assert.equal(h.calls.filter(c => c[0] === 'omni').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'sync').length, 2);
  assert.equal(result.cost.geminiUsd, .3);
});
