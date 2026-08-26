import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { ingestMealPhoto } from '../../src/server/meals/photo-ingest';

function image(input: { width: number; height: number; format: 'jpeg' | 'webp'; metadata?: boolean }): Promise<Buffer> {
  let pipeline = sharp({
    create: { width: input.width, height: input.height, channels: 3, background: { r: 50, g: 100, b: 150 } },
  });
  if (input.metadata) {
    pipeline = pipeline.withMetadata({ exif: { IFD0: { Artist: 'private-location' } } });
  }
  return input.format === 'jpeg' ? pipeline.jpeg().toBuffer() : pipeline.webp().toBuffer();
}

test('rejects bytes that are not jpeg or webp', async () => {
  await assert.rejects(ingestMealPhoto(Buffer.from('not-an-image')), /photo/i);
});

test('accepts a small decoded JPEG and does not write files', async () => {
  const ingested = await ingestMealPhoto(await image({ width: 16, height: 16, format: 'jpeg' }));
  assert.equal(ingested.mime, 'image/jpeg');
  assert.ok(ingested.bytes.length > 0);
});

test('strips JPEG metadata before the image reaches a vision provider', async () => {
  const original = await image({ width: 16, height: 16, format: 'jpeg', metadata: true });
  assert.equal(original.includes(Buffer.from('Exif')), true);
  const ingested = await ingestMealPhoto(original);
  assert.equal(ingested.bytes.includes(Buffer.from('Exif')), false);
});

test('strips WebP metadata before the image reaches a vision provider', async () => {
  const original = await image({ width: 16, height: 16, format: 'webp', metadata: true });
  assert.equal(original.includes(Buffer.from('EXIF')), true);
  const ingested = await ingestMealPhoto(original);
  assert.equal(ingested.mime, 'image/webp');
  assert.equal(ingested.bytes.includes(Buffer.from('EXIF')), false);
});

test('rejects a decoded WebP whose long edge exceeds 2048 pixels', async () => {
  const oversized = await image({ width: 2049, height: 16, format: 'webp' });
  await assert.rejects(ingestMealPhoto(oversized), /long edge/i);
});

test('rejects a decoded image above four million pixels', async () => {
  const oversized = await image({ width: 2000, height: 2001, format: 'jpeg' });
  await assert.rejects(ingestMealPhoto(oversized), /pixels/i);
});

test('rejects a truncated image carrying EXIF instead of passing original bytes through', async () => {
  const original = await image({ width: 64, height: 64, format: 'jpeg', metadata: true });
  const truncated = original.subarray(0, Math.min(original.length - 1, 96));
  assert.equal(truncated.includes(Buffer.from('Exif')), true);
  await assert.rejects(ingestMealPhoto(truncated), /photo|jpeg|invalid/i);
});
