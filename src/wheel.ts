import type { Sector } from './types';
import { tick } from './audio';

const TAU = Math.PI * 2;

/** Sector fill palette — warm festival colors that sit inside the wood/gold brand. */
export const PALETTE = [
  '#C8912B',
  '#2C6BC4',
  '#B33A2B',
  '#3E7D46',
  '#7A4FA8',
  '#D96F2E',
  '#25808A',
  '#B54F7C',
  '#8C8F3A',
  '#4A5FC1',
];

const RIM_FRAC = 0.085;
const HUB_FRAC = 0.16;

export class Wheel {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sectors: Sector[] = [];
  private baked: HTMLCanvasElement | null = null;
  private images = new Map<string, HTMLImageElement>();
  private hubLogo: HTMLImageElement;
  private rotation = Math.random() * TAU;
  private spinning = false;
  private raf = 0;
  private lastIdx = -1;
  private wobbleAt = -1e9;
  private cssSize = 0;
  private bakeGen = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.hubLogo = new Image();
    this.hubLogo.src = '/logo.png';
    this.hubLogo.onload = () => this.render();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
  }

  get isSpinning(): boolean {
    return this.spinning;
  }

  get count(): number {
    return this.sectors.length;
  }

  setSectors(sectors: Sector[]): void {
    this.sectors = sectors;
    void this.bake();
  }

  private resize(): void {
    const parent = this.canvas.parentElement!;
    const size = Math.floor(Math.min(parent.clientWidth, parent.clientHeight));
    if (size <= 0 || size === this.cssSize) return;
    this.cssSize = size;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    void this.bake();
  }

  /** Which sector sits under client point (for hover preview). Null outside the sector ring. */
  hitTest(clientX: number, clientY: number): number | null {
    const n = this.sectors.length;
    if (!n) return null;
    const rect = this.canvas.getBoundingClientRect();
    const c = rect.width / 2;
    const dx = clientX - rect.left - c;
    const dy = clientY - rect.top - c;
    const R = c * 0.98;
    const dist = Math.hypot(dx, dy);
    if (dist < R * HUB_FRAC * 1.15 || dist > R * (1 - RIM_FRAC)) return null;
    const local = norm(Math.atan2(dy, dx) - this.rotation + Math.PI / 2);
    return Math.floor((local / TAU) * n) % n;
  }

  /** Index currently under the top pointer. */
  private pointerIndex(): number {
    const n = this.sectors.length;
    return n ? Math.floor((norm(-this.rotation) / TAU) * n) % n : -1;
  }

  spin(): Promise<number> {
    return new Promise((resolve) => {
      if (this.spinning || this.sectors.length < 2) {
        resolve(-1);
        return;
      }
      this.spinning = true;
      const from = this.rotation;
      const delta = TAU * (5 + Math.random() * 3) + Math.random() * TAU;
      const dur = 4600 + Math.random() * 1800;
      const t0 = performance.now();
      this.lastIdx = this.pointerIndex();

      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / dur);
        this.rotation = norm(from + delta * (1 - (1 - t) ** 4));
        const idx = this.pointerIndex();
        if (idx !== this.lastIdx) {
          this.lastIdx = idx;
          this.wobbleAt = now;
          tick();
        }
        this.render(now);
        if (t < 1) {
          this.raf = requestAnimationFrame(step);
        } else {
          this.spinning = false;
          resolve(this.pointerIndex());
        }
      };
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(step);
    });
  }

  /** Pre-render the whole rotating part once; per-frame we only rotate the baked bitmap. */
  private async bake(): Promise<void> {
    const gen = ++this.bakeGen;
    const n = this.sectors.length;
    const size = this.canvas.width;
    if (!size) return;

    const withImages = this.sectors.filter((s) => s.imageUrl);
    await Promise.all(withImages.map((s) => this.loadImage(s.imageUrl!)));
    if (gen !== this.bakeGen) return; // superseded by a newer bake

    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const ctx = off.getContext('2d')!;
    const c = size / 2;
    const R = c * 0.98;
    const rimInner = R * (1 - RIM_FRAC);
    const hubR = R * HUB_FRAC;
    const step = n ? TAU / n : TAU;

    // Wooden rim.
    const rimGrad = ctx.createRadialGradient(c, c, rimInner, c, c, R);
    rimGrad.addColorStop(0, '#4A2410');
    rimGrad.addColorStop(0.45, '#6B3A1B');
    rimGrad.addColorStop(1, '#3A1C0C');
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.fillStyle = rimGrad;
    ctx.fill();

    // Sectors.
    for (let i = 0; i < n; i++) {
      const a0 = i * step - Math.PI / 2;
      const a1 = a0 + step;
      const s = this.sectors[i];
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, rimInner, a0, a1);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.clip();

      const img = s.imageUrl ? this.images.get(s.imageUrl) : undefined;
      if (img && img.complete && img.naturalWidth) {
        drawCoverInWedge(ctx, img, c, rimInner, hubR, a0, a1);
      } else if (!s.imageUrl) {
        // Subtle radial shading for depth on color sectors.
        const g = ctx.createRadialGradient(c, c, hubR, c, c, rimInner);
        g.addColorStop(0, 'rgba(255,255,255,0.10)');
        g.addColorStop(1, 'rgba(0,0,0,0.18)');
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.restore();

      // Separator.
      ctx.save();
      ctx.strokeStyle = 'rgba(20,10,4,0.85)';
      ctx.lineWidth = Math.max(1.5, size * 0.0022);
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a0) * hubR, c + Math.sin(a0) * hubR);
      ctx.lineTo(c + Math.cos(a0) * rimInner, c + Math.sin(a0) * rimInner);
      ctx.stroke();
      ctx.restore();
    }

    // Text labels (text mode sectors only).
    const dpr = size / this.cssSize;
    for (let i = 0; i < n; i++) {
      const s = this.sectors[i];
      if (s.imageUrl) continue;
      const mid = (i + 0.5) * step - Math.PI / 2;
      const fontPx = Math.max(12, Math.min(26, (this.cssSize / Math.max(6, n)) * 0.42)) * dpr;
      // Labels bake into wheel-local coords and always read center→out (same as
      // spinthewheel.io): after a spin the wheel rests at an arbitrary angle, so
      // no static flip can keep every label upright — this is the genre norm.
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(mid);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${fontPx}px "Alegreya Sans", sans-serif`;
      ctx.fillStyle = '#FFF7E6';
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 3 * dpr;
      const maxW = rimInner - hubR * 1.5;
      ctx.fillText(truncate(ctx, s.label, maxW), rimInner - 10 * dpr, 0);
      ctx.restore();
    }

    // Rim edges + studs (like the logo's gold dots).
    ctx.lineWidth = Math.max(2, size * 0.004);
    ctx.strokeStyle = '#E0A82E';
    ctx.beginPath();
    ctx.arc(c, c, rimInner, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, R - ctx.lineWidth / 2, 0, TAU);
    ctx.stroke();

    const studs = n >= 2 && n <= 24 ? n : 16;
    const studR = (R + rimInner) / 2;
    for (let i = 0; i < studs; i++) {
      const a = (i / studs) * TAU - Math.PI / 2;
      const x = c + Math.cos(a) * studR;
      const y = c + Math.sin(a) * studR;
      const r = Math.max(3, size * 0.008);
      const g = ctx.createRadialGradient(x - r / 3, y - r / 3, r / 4, x, y, r);
      g.addColorStop(0, '#FFE58A');
      g.addColorStop(1, '#B9862B');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
    }

    this.baked = off;
    this.render();
  }

  private loadImage(url: string): Promise<void> {
    const existing = this.images.get(url);
    if (existing?.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const img = existing ?? new Image();
      if (!existing) {
        img.src = url;
        this.images.set(url, img);
      }
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
  }

  render(now = performance.now()): void {
    const { ctx, canvas } = this;
    const size = canvas.width;
    if (!size) return;
    const c = size / 2;
    const R = c * 0.98;
    ctx.clearRect(0, 0, size, size);

    if (this.sectors.length === 0) {
      this.drawEmpty(ctx, c, R);
    } else if (this.baked) {
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(this.rotation);
      ctx.drawImage(this.baked, -c, -c);
      ctx.restore();
    }

    this.drawHub(ctx, c, R);
    this.drawPointer(ctx, c, R, now);
  }

  private drawEmpty(ctx: CanvasRenderingContext2D, c: number, R: number): void {
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R * (1 - RIM_FRAC), 0, TAU);
    ctx.fillStyle = 'rgba(27,60,110,0.35)';
    ctx.fill();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = 'rgba(224,168,46,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  private drawHub(ctx: CanvasRenderingContext2D, c: number, R: number): void {
    const hubR = R * HUB_FRAC;
    ctx.save();
    // Blue felt disc under the logo, matching the emblem.
    ctx.beginPath();
    ctx.arc(c, c, hubR, 0, TAU);
    ctx.fillStyle = '#1B57A6';
    ctx.fill();
    ctx.lineWidth = Math.max(2.5, R * 0.012);
    ctx.strokeStyle = '#E0A82E';
    ctx.stroke();
    if (this.hubLogo.complete && this.hubLogo.naturalWidth) {
      const d = hubR * 2 * 0.98;
      ctx.beginPath();
      ctx.arc(c, c, hubR * 0.98, 0, TAU);
      ctx.clip();
      ctx.drawImage(this.hubLogo, c - d / 2, c - d / 2, d, d);
    }
    ctx.restore();
  }

  private drawPointer(ctx: CanvasRenderingContext2D, c: number, R: number, now: number): void {
    const dt = (now - this.wobbleAt) / 1000;
    const wobble = dt < 0.5 ? Math.sin(dt * 42) * Math.exp(-dt * 9) * 0.22 : 0;
    const w = R * 0.085;
    const h = R * 0.16;
    ctx.save();
    ctx.translate(c, c - R + h * 0.28);
    ctx.rotate(wobble);
    ctx.beginPath();
    ctx.moveTo(0, h * 0.72);
    ctx.quadraticCurveTo(w, -h * 0.1, 0, -h * 0.28);
    ctx.quadraticCurveTo(-w, -h * 0.1, 0, h * 0.72);
    const g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, '#FFE58A');
    g.addColorStop(1, '#C8912B');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#2A1206';
    ctx.lineWidth = Math.max(2, R * 0.012);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function norm(a: number): number {
  return ((a % TAU) + TAU) % TAU;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** Cover-fit an image into a wedge between hubR..rimInner across [a0..a1]. */
function drawCoverInWedge(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  c: number,
  rimInner: number,
  hubR: number,
  a0: number,
  a1: number
): void {
  // Bounding box of the wedge region (sampled along both arcs).
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const SAMPLES = 14;
  for (let i = 0; i <= SAMPLES; i++) {
    const a = a0 + ((a1 - a0) * i) / SAMPLES;
    for (const r of [hubR, rimInner]) {
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  const scale = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, minX + (bw - dw) / 2, minY + (bh - dh) / 2, dw, dh);
}
