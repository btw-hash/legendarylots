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
