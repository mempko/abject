/**
 * Abyss Background — Lovecraftian ambient animation for the desktop.
 *
 * Renders slowly drifting particles and faint tendril-like curves on a
 * fixed background canvas, evoking a deep-sea / eldritch void aesthetic.
 * Deliberately low-key so it doesn't compete with the UI.
 */

const ELDRITCH = { r: 57, g: 255, b: 142 };
const VOID_PURPLE = { r: 155, g: 89, b: 255 };
const ICHOR = { r: 255, g: 77, b: 106 };

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: typeof ELDRITCH;
  alpha: number;
  pulse: number;      // phase offset for breathing
  pulseSpeed: number;
}

interface Tendril {
  points: Array<{ x: number; y: number; vx: number; vy: number }>;
  color: typeof ELDRITCH;
  alpha: number;
  width: number;
}

const PARTICLE_COUNT = 40;
const TENDRIL_COUNT = 5;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickColor(): typeof ELDRITCH {
  const r = Math.random();
  if (r < 0.55) return ELDRITCH;
  if (r < 0.9) return VOID_PURPLE;
  return ICHOR;
}

function createParticle(w: number, h: number): Particle {
  return {
    x: rand(0, w),
    y: rand(0, h),
    vx: rand(-0.15, 0.15),
    vy: rand(-0.1, -0.02),  // drift upward like deep-sea bioluminescence
    radius: rand(0.5, 2.5),
    color: pickColor(),
    alpha: rand(0.05, 0.25),
    pulse: rand(0, Math.PI * 2),
    pulseSpeed: rand(0.003, 0.012),
  };
}

function createTendril(w: number, h: number): Tendril {
  const pointCount = Math.floor(rand(5, 9));
  const startX = rand(0, w);
  const startY = rand(h * 0.3, h);
  const points = [];

  let x = startX;
  let y = startY;
  for (let i = 0; i < pointCount; i++) {
    points.push({
      x,
      y,
      vx: rand(-0.3, 0.3),
      vy: rand(-0.4, -0.05),
    });
    x += rand(-80, 80);
    y += rand(-120, -30);
  }

  return {
    points,
    color: pickColor(),
    alpha: rand(0.015, 0.04),
    width: rand(0.5, 1.5),
  };
}

export interface AbyssBgControl {
  stop: () => void;
  setDescending: (descending: boolean) => void;
}

export function startAbyssBg(canvas: HTMLCanvasElement): AbyssBgControl {
  const ctx = canvas.getContext('2d')!;
  let w = 0;
  let h = 0;
  let animId = 0;
  let particles: Particle[] = [];
  let tendrils: Tendril[] = [];
  let frame = 0;
  let descending = true;
  let descentSpeed = 1.0;  // 1.0 = full descent, 0.0 = ambient
  let paused = false;
  let lastRenderTs = 0;

  // Cache of pre-rendered particle-glow sprites keyed by color+radius bucket.
  // Creating a radialGradient every frame for 40 particles lights Firefox on
  // fire; blitting a pre-rendered sprite is ~40× cheaper.
  const glowCache = new Map<string, HTMLCanvasElement>();

  function getGlowSprite(color: typeof ELDRITCH, radius: number): HTMLCanvasElement {
    // Bucket radius to 0.5px steps so we reuse ~5 sprites across all particles.
    const rBucket = Math.round(radius * 2) / 2;
    const key = `${color.r},${color.g},${color.b}:${rBucket}`;
    const cached = glowCache.get(key);
    if (cached) return cached;

    const spriteR = rBucket * 6;
    const size = Math.ceil(spriteR * 2) + 2;
    const off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    const octx = off.getContext('2d')!;
    const cx = size / 2;
    const cy = size / 2;
    const { r, g, b } = color;
    const grad = octx.createRadialGradient(cx, cy, 0, cx, cy, spriteR);
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.3, `rgba(${r},${g},${b},0.3)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    octx.fillStyle = grad;
    octx.beginPath();
    octx.arc(cx, cy, spriteR, 0, Math.PI * 2);
    octx.fill();
    octx.fillStyle = `rgba(${r},${g},${b},1)`;
    octx.beginPath();
    octx.arc(cx, cy, rBucket, 0, Math.PI * 2);
    octx.fill();
    glowCache.set(key, off);
    return off;
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init(): void {
    resize();
    particles = Array.from({ length: PARTICLE_COUNT }, () => createParticle(w, h));
    tendrils = Array.from({ length: TENDRIL_COUNT }, () => createTendril(w, h));
  }

  function updateParticle(p: Particle): void {
    p.x += p.vx;
    // During descent, particles rush upward (we're falling past them)
    const descentBoost = descentSpeed * -2.5;
    p.y += p.vy + descentBoost;
    p.pulse += p.pulseSpeed;

    // Wrap around edges
    if (p.x < -10) p.x = w + 10;
    if (p.x > w + 10) p.x = -10;
    if (p.y < -10) {
      p.y = h + 10;
      p.x = rand(0, w);
    }
  }

  function updateTendril(t: Tendril): void {
    const descentBoost = descentSpeed * -1.5;
    for (const pt of t.points) {
      // Slow sinusoidal drift + descent rush
      pt.x += Math.sin(frame * 0.002 + pt.y * 0.01) * 0.15;
      pt.y += pt.vy * 0.02 + descentBoost;
    }
    // Slowly regenerate if drifted too far up
    if (t.points[t.points.length - 1].y < -100) {
      const newT = createTendril(w, h);
      t.points = newT.points;
      t.color = newT.color;
      t.alpha = newT.alpha;
    }
  }

  function drawParticle(p: Particle): void {
    const breathe = 0.5 + 0.5 * Math.sin(p.pulse);
    const a = p.alpha * (0.4 + 0.6 * breathe);

    const sprite = getGlowSprite(p.color, p.radius);
    const half = sprite.width / 2;
    ctx.globalAlpha = a;
    ctx.drawImage(sprite, p.x - half, p.y - half);
    ctx.globalAlpha = 1;
  }

  function drawTendril(t: Tendril): void {
    if (t.points.length < 3) return;
    const { r, g, b } = t.color;

    ctx.strokeStyle = `rgba(${r},${g},${b},${t.alpha})`;
    ctx.lineWidth = t.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

    // Draw smooth curve through points
    const pts = t.points;
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length - 1; i++) {
      const cpx = (pts[i].x + pts[i + 1].x) / 2;
      const cpy = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, cpx, cpy);
    }

    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }

  function render(ts: number): void {
    if (paused) return;

    // Throttle to 60fps while descending (needs to feel snappy) and to 20fps
    // in the ambient idle state. The drifting particles move so slowly that
    // 20fps is indistinguishable visually, and it cuts the render cost to 1/3.
    const idle = descentSpeed === 0;
    const minFrameMs = idle ? 50 : 16;
    if (ts - lastRenderTs < minFrameMs) {
      animId = requestAnimationFrame(render);
      return;
    }
    lastRenderTs = ts;

    frame++;

    if (!descending && descentSpeed > 0) {
      descentSpeed = Math.max(0, descentSpeed - 0.008);
    }

    ctx.clearRect(0, 0, w, h);

    for (const t of tendrils) {
      updateTendril(t);
      drawTendril(t);
    }

    for (const p of particles) {
      updateParticle(p);
      drawParticle(p);
    }

    animId = requestAnimationFrame(render);
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      paused = true;
      cancelAnimationFrame(animId);
    } else if (paused) {
      paused = false;
      lastRenderTs = 0;
      animId = requestAnimationFrame(render);
    }
  }

  init();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  animId = requestAnimationFrame(render);

  return {
    stop: () => {
      paused = true;
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
    setDescending: (d: boolean) => {
      descending = d;
      if (d) descentSpeed = 1.0;
    },
  };
}
