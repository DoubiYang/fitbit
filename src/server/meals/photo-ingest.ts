const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LONG_EDGE = 2048;

export type IngestedPhoto = {
  mime: 'image/jpeg' | 'image/webp';
  bytes: Buffer;
};

function jpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return undefined;
}

export function ingestMealPhoto(bytes: Buffer): IngestedPhoto {
  if (bytes.length > MAX_BYTES) {
    throw new Error('photo exceeds 4 MiB');
  }
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!jpeg && !webp) {
    throw new Error('photo must be jpeg or webp');
  }
  if (jpeg) {
    const size = jpegDimensions(bytes);
    if (size && Math.max(size.width, size.height) > MAX_LONG_EDGE) {
      throw new Error('photo long edge exceeds 2048');
    }
  }
  return { mime: jpeg ? 'image/jpeg' : 'image/webp', bytes };
}
