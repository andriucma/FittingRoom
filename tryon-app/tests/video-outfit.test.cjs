const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const outfit = loadTs('src/lib/outfit.ts');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const media = loadTs('src/lib/server/ffmpeg.ts', { './config': { config: { ffmpeg, ffprobe } } });
const top = { id: 1, title: 'Cotton tee', productType: 'T-Shirts', category: 'top' };
const bottom = { id: 2, title: 'Relaxed pants', productType: 'Pants', category: 'bottom' };

test('one garment per nonoverlapping body slot, including mislabeled one-pieces and sets', () => {
  assert.equal(outfit.outfitError(top, bottom), null);
  assert.match(outfit.outfitError(top, { ...bottom, id: 1 }), /same product/);
  assert.match(outfit.outfitError(bottom, top), /upper slot/);
  for (const title of ['Summer dress', 'Denim overalls', 'Matching set', 'Tracksuit', 'Set of 2 tees', 'Two-piece outfit']) {
    assert.notEqual(outfit.outfitError({ ...top, title }, bottom), null, title);
  }
  assert.equal(outfit.garmentSlot({ ...top, title: 'Dress shirt' }), 'top');
  assert.equal(outfit.garmentSlot({ ...bottom, title: 'Dress pants' }), 'bottom');
  assert.equal(outfit.garmentPrompt({ ...bottom, title: 'Cable knit pants' }), 'pants');
});

test('pairing suggestions explain color and silhouette preferences without blocking valid outfits', () => {
  const selected = { color: 'pink', fit: 'oversized', storeId: 1 };
  const neutral = outfit.pairingScore({ color: 'black', fit: 'slim', storeId: 1 }, selected);
  const busy = outfit.pairingScore({ color: 'multicolor', fit: 'na', storeId: 2 }, selected);
  assert.ok(neutral.score > busy.score);
  assert.match(neutral.reason, /neutral/);
});

const available = spawnSync(ffmpeg, ['-version']).status === 0 && spawnSync(ffprobe, ['-version']).status === 0;
test('fractional, short, off-zero, and long recordings encode exact Gemini duration and frame counts', { skip: !available, timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fittingroom-duration-'));
  try {
    for (const [duration, start, end, expected] of [[6.208, 0, 7, 7], [6.208, 1.1, 6.208, 6], [1.2, 0, 1.2, 3], [19.12, 0, 19.12, 15], [7, 0, 7, 7]]) {
      const source = path.join(dir, `source-${duration}.mp4`);
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=160x284:r=125', '-t', String(duration), '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
      const before = await readFile(source);
      const output = path.join(dir, `output-${duration}-${start}.mp4`);
      const result = await media.trimWholeSeconds(source, start, end, output);
      assert.equal(result.seconds, expected);
      assert.equal(result.start, start, 'Preserve the beginning of the full turn, including long recordings');
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=duration,nb_read_frames,width,height', '-of', 'json', output], { encoding: 'utf8' })).streams[0];
      assert.equal(Number(probe.duration), expected);
      assert.equal(Number(probe.nb_read_frames), expected * 30);
      assert.equal(probe.width, 720); assert.equal(probe.height, 1280);
      assert.deepEqual(await readFile(source), before);
      await media.assertOmniDuration(output, expected);
    }
    const source = path.join(dir, 'source-6.208.mp4');
    await assert.rejects(media.assertOmniDuration(source, 7), /preparation failed/);
    const longerAudio = path.join(dir, 'audio-longer-than-video.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '7', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', longerAudio]);
    await assert.rejects(media.assertOmniDuration(longerAudio, 7), /preparation failed/);
    await assert.rejects(media.trimWholeSeconds(source, 10, 11, path.join(dir, 'invalid.mp4')), /no usable video/);
    await assert.rejects(media.trimWholeSeconds(source, 0, NaN, path.join(dir, 'invalid.mp4')), /Invalid video interval/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
