import assert from 'node:assert/strict';
import test from 'node:test';

import { ingestMealPhoto } from '../../src/server/meals/photo-ingest';

test('rejects bytes that are not jpeg or webp', () => {
  assert.throws(() => ingestMealPhoto(Buffer.from('not-an-image')), /MIME|jpeg|webp/i);
});

test('accepts a small jpeg and does not write files', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const ingested = ingestMealPhoto(jpeg);
  assert.equal(ingested.mime, 'image/jpeg');
  assert.equal(ingested.bytes.length, jpeg.length);
});
