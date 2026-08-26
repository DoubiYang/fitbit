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

test('strips JPEG EXIF metadata before the image reaches a vision provider', () => {
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02]);
  const jfif = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const ingested = ingestMealPhoto(Buffer.concat([Buffer.from([0xff, 0xd8]), exif, jfif]));
  assert.equal(ingested.bytes.includes(Buffer.from('Exif')), false);
  assert.equal(ingested.bytes.subarray(0, 4).toString('hex'), 'ffd8ffe0');
});

test('strips a WebP EXIF chunk before the image reaches a vision provider', () => {
  const header = Buffer.from('RIFF\x18\x00\x00\x00WEBP', 'binary');
  const vp8 = Buffer.from('VP8 \x00\x00\x00\x00', 'binary');
  const exif = Buffer.from('EXIF\x04\x00\x00\x00gps!', 'binary');
  const ingested = ingestMealPhoto(Buffer.concat([header, vp8, exif]));
  assert.equal(ingested.bytes.includes(Buffer.from('EXIF')), false);
  assert.equal(ingested.bytes.readUInt32LE(4), ingested.bytes.length - 8);
});
