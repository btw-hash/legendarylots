import type { WheelData } from './types';

export async function saveWheel(
  wheel: WheelData,
  editToken?: string
): Promise<{ id: string; editToken: string; rev: number }> {
  const res = await fetch('/api/wheels', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(editToken ? { 'x-edit-token': editToken } : {}),
    },
    body: JSON.stringify(wheel),
  });
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  return (await res.json()) as { id: string; editToken: string; rev: number };
}

export interface WheelSummary {
  id: string;
  label: string;
  mode: string;
  count: number;
}

export async function deleteWheel(id: string, editToken?: string): Promise<void> {
  await fetch(`/api/wheels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: editToken ? { 'x-edit-token': editToken } : {},
  });
}

/** Guest contribution — submit a text or image to the host's moderation queue. */
export async function submitPending(
  id: string,
  payload: { label?: string; imageUrl?: string; name?: string }
): Promise<boolean> {
  const res = await fetch(`/api/wheels/${encodeURIComponent(id)}/pending`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

/** Host resolves a pending item (drop it from the queue after approve/reject). */
export async function resolvePending(id: string, pid: string, editToken?: string): Promise<void> {
  await fetch(`/api/wheels/${encodeURIComponent(id)}/pending/${encodeURIComponent(pid)}/resolve`, {
    method: 'POST',
    headers: editToken ? { 'x-edit-token': editToken } : {},
  });
}

export async function loadWheel(id: string): Promise<WheelData | null> {
  const res = await fetch(`/api/wheels/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return (await res.json()) as WheelData;
}

/** Downscale + recompress in the browser, upload, return the hosted URL.
 *  Decodes via <img> (broad format support + applies EXIF orientation) and caps the
 *  size modestly so the mobile CPU webp-encode + upload stay quick. Falls back to
 *  JPEG/PNG on browsers whose toBlob can't produce webp. */
export async function uploadImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) throw new Error('image decode failed');

    const MAX = 900; // a wheel sector never needs more; smaller = faster encode + upload
    const scale = Math.min(1, MAX / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);

    const encode = (type: string) => new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.82));
    const blob =
      (await encode('image/webp')) || (await encode('image/jpeg')) || (await encode('image/png'));
    if (!blob) throw new Error('image encode failed');

    const res = await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return ((await res.json()) as { url: string }).url;
  } finally {
    URL.revokeObjectURL(url);
  }
}
