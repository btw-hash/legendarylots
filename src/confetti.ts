/** Lightweight canvas confetti — brand palette, no dependencies. */

const COLORS = ['#F5C33B', '#E0A82E', '#2C6BC4', '#B33A2B', '#F2E4C4', '#7FB3E8'];

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  shape: 'rect' | 'circle';
}

export function burstConfetti(): void {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-layer';
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const pieces: Piece[] = [];
  for (let i = 0; i < 160; i++) {
    const fromLeft = i % 2 === 0;
    pieces.push({
      x: fromLeft ? -10 : innerWidth + 10,
      y: innerHeight * (0.25 + Math.random() * 0.3),
      vx: (fromLeft ? 1 : -1) * (4 + Math.random() * 7),
      vy: -(6 + Math.random() * 7),
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.35,
      w: 6 + Math.random() * 7,
      h: 4 + Math.random() * 6,
      color: COLORS[i % COLORS.length],
      shape: Math.random() < 0.25 ? 'circle' : 'rect',
    });
  }

  const t0 = performance.now();
  const DUR = 2600;
  function frame(now: number) {
    const t = now - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const fade = t > DUR - 500 ? Math.max(0, (DUR - t) / 500) : 1;
    ctx.globalAlpha = fade;
    for (const p of pieces) {
      p.vy += 0.22;
      p.vx *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (t < DUR) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}
