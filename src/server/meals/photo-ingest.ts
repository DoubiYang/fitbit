import sharp, { type Metadata } from 'sharp';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LONG_EDGE = 2048;
const MAX_PIXELS = 4_000_000;

export type IngestedPhoto = {
  mime: 'image/jpeg' | 'image/webp';
  bytes: Buffer;
};

function photoError(message: string): Error {
  return new Error(`photo ${message}`);
}

function asPhotoError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (/pixel limit|too many pixels/iu.test(message)) {
    return photoError('pixels exceed 4000000');
  }
  return photoError('is invalid');
}

export async function ingestMealPhoto(bytes: Buffer): Promise<IngestedPhoto> {
  if (bytes.length > MAX_BYTES) {
    throw photoError('exceeds 4 MiB');
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
  } catch (error) {
    throw asPhotoError(error);
  }
  if (metadata.format !== 'jpeg' && metadata.format !== 'webp') {
    throw photoError('must be jpeg or webp');
  }
  if (!metadata.width || !metadata.height) {
    throw photoError('is invalid');
  }
  if (Math.max(metadata.width, metadata.height) > MAX_LONG_EDGE) {
    throw photoError('long edge exceeds 2048');
  }
  if (metadata.width * metadata.height > MAX_PIXELS) {
    throw photoError('pixels exceed 4000000');
  }

  try {
    const decoder = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_PIXELS });
    const encoded = metadata.format === 'jpeg'
      ? await decoder.jpeg({ mozjpeg: true }).toBuffer()
      : await decoder.webp().toBuffer();
    return { mime: metadata.format === 'jpeg' ? 'image/jpeg' : 'image/webp', bytes: encoded };
  } catch (error) {
    throw asPhotoError(error);
  }
}
