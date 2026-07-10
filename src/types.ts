export type Mode = 'text' | 'image';

export interface ImageEntry {
  /** Absent = a plain text-only sector added inside the image wheel. */
  url?: string;
  label?: string;
}

export interface WheelData {
  id?: string;
  name: string;
  mode: Mode;
  texts: string[];
  images: ImageEntry[];
  /** Winners that were pulled off the wheel — kept, not deleted. */
  played: PlayedEntry[];
  /** Guest submissions awaiting host approval (server-managed). */
  pending?: PendingEntry[];
  /** GET-only: whether the wheel has an owner (edit token) → others are read-only. */
  protected?: boolean;
  /** Server-maintained monotonic revision — devices poll it to pull changes. */
  rev?: number;
}

export interface PendingEntry {
  pid: string;
  label?: string;
  imageUrl?: string;
  /** Optional guest display name, shown with the variant during moderation. */
  name?: string;
  at?: string;
}

export interface PlayedEntry {
  label: string;
  imageUrl?: string;
  mode: Mode;
}

/** What the wheel actually renders — one entry per sector. */
export interface Sector {
  label: string;
  imageUrl?: string;
  color: string;
}
