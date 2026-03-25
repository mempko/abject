/**
 * Abyss Background -- scroll-reactive ambient animation.
 *
 * Particles and tendrils grow denser and brighter as the user scrolls
 * deeper into the page, as though descending into a bioluminescent abyss.
 */

const ELDRITCH = { r: 57, g: 255, b: 142 };
const VOID_PURPLE = { r: 155, g: 89, b: 255 };
const ICHOR = { r: 255, g: 77, b: 106 };

// Pool sizes -- we allocate the max and reveal them with scroll
const MAX_PARTICLES = 240;
const MAX_TENDRILS = 30;

// At scroll 0% we show this fraction, at 100% we show all
const MIN_PARTICLE_FRAC = 0.33;  // ~40 particles at top (matches original client)
const MIN_TENDRIL_FRAC = 0.33;   // ~5 tendrils at top (matches original client)

// Alpha multiplier range (brightness increases with depth)
const MIN_ALPHA_MULT = 0.7;
const MAX_ALPHA_MULT = 1.0;

// Radius multiplier range (particles grow slightly with depth)
const MIN_RADIUS_MULT = 0.85;
const MAX_RADIUS_MULT = 1.0;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pickColor() {
  const r = Math.random();
  if (r < 0.55) return ELDRITCH;
  if (r < 0.9) return VOID_PURPLE;
  return ICHOR;
}

function createParticle(w, h) {
  return {
    x: rand(0, w),
    y: rand(0, h),
    vx: rand(-0.15, 0.15),
    vy: rand(-0.1, -0.02),
    radius: rand(0.5, 2.5),
    color: pickColor(),
    alpha: rand(0.05, 0.25),
    pulse: rand(0, Math.PI * 2),
    pulseSpeed: rand(0.003, 0.012),
  };
}

function createTendril(w, h) {
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

function startAbyssBg(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let animId = 0;
  let particles = [];
  let tendrils = [];
  let frame = 0;
  let depth = 0; // 0..1, driven by scroll

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init() {
    resize();
    particles = Array.from({ length: MAX_PARTICLES }, () => createParticle(w, h));
    tendrils = Array.from({ length: MAX_TENDRILS }, () => createTendril(w, h));
  }

  function updateScroll() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    depth = docHeight > 0 ? Math.min(1, scrollTop / docHeight) : 0;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function updateParticle(p) {
    p.x += p.vx;
    p.y += p.vy;
    p.pulse += p.pulseSpeed;

    if (p.x < -10) p.x = w + 10;
    if (p.x > w + 10) p.x = -10;
    if (p.y < -10) {
      p.y = h + 10;
      p.x = rand(0, w);
    }
  }

  function updateTendril(t) {
    for (const pt of t.points) {
      pt.x += Math.sin(frame * 0.002 + pt.y * 0.01) * 0.15;
      pt.y += pt.vy * 0.02;
    }
    if (t.points[t.points.length - 1].y < -100) {
      const newT = createTendril(w, h);
      t.points = newT.points;
      t.color = newT.color;
      t.alpha = newT.alpha;
    }
  }

  function drawParticle(p, alphaMult, radiusMult) {
    const breathe = 0.5 + 0.5 * Math.sin(p.pulse);
    const a = p.alpha * (0.4 + 0.6 * breathe) * alphaMult;
    const r = p.radius * radiusMult;
    const { r: cr, g: cg, b: cb } = p.color;

    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 6);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
    grad.addColorStop(0.3, `rgba(${cr},${cg},${cb},${a * 0.3})`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(${cr},${cg},${cb},${a * 1.5})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTendril(t, alphaMult) {
    if (t.points.length < 3) return;
    const { r, g, b } = t.color;

    ctx.strokeStyle = `rgba(${r},${g},${b},${t.alpha * alphaMult})`;
    ctx.lineWidth = t.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();

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

  function render() {
    frame++;
    updateScroll();
    ctx.clearRect(0, 0, w, h);

    // How many to draw based on depth
    const visibleParticles = Math.floor(lerp(MIN_PARTICLE_FRAC, 1, depth) * MAX_PARTICLES);
    const visibleTendrils = Math.floor(lerp(MIN_TENDRIL_FRAC, 1, depth) * MAX_TENDRILS);
    const alphaMult = lerp(MIN_ALPHA_MULT, MAX_ALPHA_MULT, depth);
    const radiusMult = lerp(MIN_RADIUS_MULT, MAX_RADIUS_MULT, depth);

    // Update all (so they stay in motion even when hidden)
    for (const t of tendrils) updateTendril(t);
    for (const p of particles) updateParticle(p);

    // Draw only the visible subset
    for (let i = 0; i < visibleTendrils; i++) {
      drawTendril(tendrils[i], alphaMult);
    }
    for (let i = 0; i < visibleParticles; i++) {
      drawParticle(particles[i], alphaMult, radiusMult);
    }

    animId = requestAnimationFrame(render);
  }

  init();
  window.addEventListener('resize', resize);
  animId = requestAnimationFrame(render);
}

// Initialize on DOM ready
const canvas = document.getElementById('abyss-bg');
if (canvas) startAbyssBg(canvas);
