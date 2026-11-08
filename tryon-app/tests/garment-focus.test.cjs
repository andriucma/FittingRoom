const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const loadTs = require('./load-ts.cjs');
const outfit = loadTs('src/lib/outfit.ts');

test('UI highlights and generation references have distinct paths, share cache, and never modify the original', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'fittingroom-focus-'));
  try {
    const source = path.join(dir, 'source.jpg'); await fs.writeFile(source, 'original product photo');
    const image = { index: 0, file: source, view: 'front' };
    const product = { id: 1, title: 'Cotton tee', productType: 'T-Shirt', images: [image] };
    let calls = 0;
    const focus = loadTs('src/lib/server/garmentFocus.ts', {
      '@/lib/outfit': outfit,
      './catalog': { getCatalogProduct: () => ({ ...product, category: 'top' }) },
      './shopify': { importProduct: async () => product, referenceViews: () => ({ front: source }) },
      './storage': { fileUrl: p => `/files/${path.basename(p)}`, readJson: async p => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }, writeJson: async (p, data) => fs.writeFile(p, JSON.stringify(data)) },
      './localModels': { localModels: { focusGarment: async (file, prompt, out) => {
        calls++; await fs.mkdir(out, { recursive: true });
        const result = { prompt, score: .98, focus: path.join(out, 'focus.png'), mask: path.join(out, 'mask.png'), reference: path.join(out, 'reference.png') };
        await Promise.all([result.focus, result.mask, result.reference].map(p => fs.writeFile(p, 'derived image'))); return result;
      } } },
    });
    const [preview, refs] = await Promise.all([focus.focusProductPhoto(1), focus.isolatedReferenceViews(product)]);
    assert.equal(calls, 1); assert.ok(preview.focusUrl.endsWith('/focus.png')); assert.ok(refs.views.front.endsWith('/reference.png'));
    assert.notEqual(refs.views.front, source); assert.ok(!JSON.stringify(preview).includes('reference.png'));
    await focus.focusProductPhoto(1); assert.equal(calls, 1);
    assert.equal(await fs.readFile(source, 'utf8'), 'original product photo');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
