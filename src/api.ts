import type { WheelData } from './types';

export async function saveWheel(wheel: WheelData): Promise<string> {
  const res = await fetch('/api/wheels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wheel),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

export async function loadWheel(id: string): Promise<WheelData | null> {
  const res = await fetch(`/api/wheels/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return (await res.json()) as WheelData;
}

/** Downscale + recompress in the browser, upload, return the hosted URL. */
export async function uploadImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const MAX = 1200;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85));
  if (!blob) throw new Error('image encode failed');
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp' },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  return url;
}
