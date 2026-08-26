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

function stripJpegExif(bytes: Buffer): Buffer {
  const chunks: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff || offset + 1 >= bytes.length) {
      chunks.push(bytes.subarray(offset));
      break;
    }
    let markerOffset = offset + 1;
    while (bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset];
    if (marker === undefined || marker === 0xda) {
      chunks.push(bytes.subarray(offset));
      break;
    }
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9) {
      chunks.push(bytes.subarray(offset, markerOffset + 1));
      offset = markerOffset + 1;
      continue;
    }
    if (markerOffset + 2 >= bytes.length) {
      chunks.push(bytes.subarray(offset));
      break;
    }
    const length = bytes.readUInt16BE(markerOffset + 1);
    const end = markerOffset + 1 + length;
    if (length < 2 || end > bytes.length) {
      chunks.push(bytes.subarray(offset));
      break;
    }
    const payloadStart = markerOffset + 3;
    const isExif = marker === 0xe1 && bytes.subarray(payloadStart, payloadStart + 6).equals(Buffer.from('Exif\0\0', 'binary'));
    if (!isExif) {
      chunks.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  return Buffer.concat(chunks);
}

function stripWebpExif(bytes: Buffer): Buffer {
  const chunks: Buffer[] = [bytes.subarray(0, 12)];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const paddedLength = chunkLength + (chunkLength % 2);
    const end = offset + 8 + paddedLength;
    if (end > bytes.length) {
      return bytes;
    }
    if (bytes.subarray(offset, offset + 4).toString('ascii') !== 'EXIF') {
      chunks.push(bytes.subarray(offset, end));
    }
    offset = end;
  }
  if (offset !== bytes.length) {
    return bytes;
  }
  const stripped = Buffer.concat(chunks);
  stripped.writeUInt32LE(stripped.length - 8, 4);
  return stripped;
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
  return { mime: jpeg ? 'image/jpeg' : 'image/webp', bytes: jpeg ? stripJpegExif(bytes) : stripWebpExif(bytes) };
}
