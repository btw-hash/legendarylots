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

/** Everything needed to re-verify a provably-fair spin after the fact. */
export interface FairProof {
  hash: string; // sha256(serverSeed), committed by the server before it saw clientSeed
  serverSeed: string;
  clientSeed: string;
  count: number;
  winner: number;
}

/**
 * Provably-fair outcome via commit-reveal: the server commits sha256(seed) first,
 * our entropy goes in second, so neither side can steer the result. Returns null on
 * any failure (offline, server error, or a hash mismatch = server tried to cheat) —
 * the caller falls back to a local random spin.
 */
export async function requestFairSpin(
  count: number
): Promise<{ index: number; frac: number; proof: FairProof } | null> {
  try {
    const commitRes = await fetch('/api/spin/commit', { method: 'POST' });
    if (!commitRes.ok) return null;
    const commit = (await commitRes.json()) as { nonce: string; hash: string };
    if (!commit?.nonce || !commit?.hash) return null;

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const clientSeed = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

    const revealRes = await fetch('/api/spin/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: commit.nonce, clientSeed, count }),
    });
    if (!revealRes.ok) return null;
    const reveal = (await revealRes.json()) as {
      serverSeed: string;
      winner: number;
      offsetFrac: number;
    };
    if (typeof reveal?.winner !== 'number' || typeof reveal?.serverSeed !== 'string') return null;

    // Honesty check: the revealed seed must hash to the pre-commit value.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(reveal.serverSeed)
    );
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== commit.hash) return null;

    return {
      index: reveal.winner,
      frac: typeof reveal.offsetFrac === 'number' ? reveal.offsetFrac : 0.5,
      proof: {
        hash: commit.hash,
        serverSeed: reveal.serverSeed,
        clientSeed,
        count,
        winner: reveal.winner,
      },
    };
  } catch {
    return null;
  }
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
