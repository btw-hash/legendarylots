export type Mode = 'text' | 'image';

export interface ImageEntry {
  url: string;
  label?: string;
}

export interface WheelData {
  id?: string;
  name: string;
  mode: Mode;
  texts: string[];
  images: ImageEntry[];
}

/** What the wheel actually renders — one entry per sector. */
export interface Sector {
  label: string;
  imageUrl?: string;
  color: string;
}
