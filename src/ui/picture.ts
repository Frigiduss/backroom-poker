// Turns a picture picked from the device into a small square JPEG for the player's badge. Doing
// this in the browser means what's uploaded is always a freshly drawn image with nothing else in
// it (no location or camera details), whatever the original file was.
import { PICTURE_MAX_BYTES, PICTURE_PICK_MAX_BYTES, PICTURE_SIZE } from '../accounts';

const toBlob = (c: HTMLCanvasElement, quality: number) =>
  new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', quality));

export async function shrinkPicture(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(file.type)) throw new Error('Pick a photo or picture (PNG, JPEG, WebP or GIF).');
  if (file.size > PICTURE_PICK_MAX_BYTES) throw new Error('That picture is too big. Pick one under 15 MB.');
  let img: ImageBitmap;
  try {
    img = await createImageBitmap(file);
  } catch {
    throw new Error('That file couldn\'t be read as a picture.');
  }
  const side = Math.min(img.width, img.height);
  if (side < 16) throw new Error('That picture is too small.');
  const c = document.createElement('canvas');
  c.width = c.height = PICTURE_SIZE;
  const g = c.getContext('2d');
  if (!g) throw new Error('This browser can\'t prepare pictures.');
  g.fillStyle = '#1b2a22';
  g.fillRect(0, 0, PICTURE_SIZE, PICTURE_SIZE);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
  img.close();
  for (const q of [0.86, 0.7, 0.5]) {
    const blob = await toBlob(c, q);
    if (blob && blob.type === 'image/jpeg' && blob.size <= PICTURE_MAX_BYTES) return blob;
  }
  throw new Error('That picture couldn\'t be made small enough. Try another.');
}
