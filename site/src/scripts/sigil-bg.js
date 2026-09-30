/*
 * The sigil void: the site's ground, the same composition the Abject desktop
 * paints behind its windows. An eclipse disc in the hand's red with a living
 * corona and a slit pupil, a diagonal bar, a red wedge, a brass square,
 * tendrils rising from below, a faint construction grid and print grain,
 * and a few motes of living light. Every layer is a watermark, so the page
 * stays the subject.
 *
 * Cheap by construction: the ground, grid, rules and grain render once into
 * an offscreen layer (rebuilt on resize); the moving parts redraw at about
 * 8 fps, pause while the tab is hidden, and hold still under reduced motion.
 * The eclipse rides the scroll a little, so the page has depth.
 */
(function () {
  const canvas = document.getElementById('sigil-bg');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const staticLayer = document.createElement('canvas');
  const P = { ground: '#06070a', ink: '#e7e1ce', hand: '#d32f22', living: '#5be5a0', brass: '#c9a45c' };
  const MUTE = {
    grid: 0.022, rules: 0.06, disc: 0.075, corona: 0.15, pupil: 0.07,
    bar: 0.03, wedge: 0.06, tendril: 0.045, brass: 0.11,
  };
  const FRAME_MS = 125;
  const DEG = Math.PI / 180;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w = 0, h = 0, dpr = 1, lastTs = 0, animId = 0, paused = false, spin = 0;
  const start = performance.now();
  let motes = [];

  function seedMotes() {
    const count = w < 700 ? 14 : 26;
    motes = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 0.8 + Math.random() * 1.7, vy: 4 + Math.random() * 9,
      drift: 6 + Math.random() * 14, phase: Math.random() * Math.PI * 2,
      a: 0.05 + Math.random() * 0.15,
    }));
  }

  function buildStatic() {
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
    const s = staticLayer.getContext('2d');
    s.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.fillStyle = P.ground;
    s.fillRect(0, 0, w, h);
    s.strokeStyle = P.ink;
    s.globalAlpha = MUTE.grid;
    s.lineWidth = 1;
    s.beginPath();
    for (let x = 0.5; x < w; x += 64) { s.moveTo(x, 0); s.lineTo(x, h); }
    for (let y = 0.5; y < h; y += 64) { s.moveTo(0, y); s.lineTo(w, y); }
    s.stroke();
    s.globalAlpha = MUTE.rules;
    s.lineWidth = 2;
    s.beginPath();
    s.moveTo(w * 0.06, h * 0.12); s.lineTo(w * 0.46, h * 0.12);
    s.moveTo(w * 0.9, h * 0.6); s.lineTo(w * 0.9, h * 0.95);
    s.stroke();
    s.globalAlpha = 1;
    const grain = document.createElement('canvas');
    grain.width = grain.height = 96;
    const g = grain.getContext('2d');
    g.fillStyle = P.ink;
    for (let i = 0; i < 260; i++) {
      g.globalAlpha = 0.01 + Math.random() * 0.03;
      g.fillRect(Math.random() * 96, Math.random() * 96, 1, 1);
    }
    const pattern = s.createPattern(grain, 'repeat');
    if (pattern) { s.fillStyle = pattern; s.fillRect(0, 0, w, h); }
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    buildStatic();
    seedMotes();
    draw(performance.now(), 0);
  }

  function bar(px, py, angle, thickness, length) {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.fillRect(-length / 2, -thickness / 2, length, thickness);
    ctx.restore();
  }

  function draw(ts, dt) {
    const t = reduceMotion ? 0 : (ts - start) / 1000;
    const s = Math.min(w, h);
    // The eclipse sinks as the page scrolls (a slow parallax, capped).
    const scrollMax = Math.max(1, document.documentElement.scrollHeight - h);
    const scrollT = Math.min(1, window.scrollY / scrollMax);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = w * 0.8;
    const cy = h * (0.3 + scrollT * 0.28);
    const r = s * 0.42;
    ctx.globalAlpha = MUTE.disc;
    ctx.fillStyle = P.hand;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    const a = spin * 2 * Math.PI / 240;
    ctx.globalAlpha = MUTE.corona;
    ctx.strokeStyle = P.living;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.06, a + 0.3, a + Math.PI * 2 - 0.3); ctx.stroke();
    ctx.fillStyle = P.living;
    const n = s * 0.018;
    ctx.fillRect(cx + Math.cos(a) * r * 1.06 - n / 2, cy + Math.sin(a) * r * 1.06 - n / 2, n, n);
    ctx.globalAlpha = MUTE.pupil;
    ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.07, r * 0.36, 0, 0, Math.PI * 2); ctx.fill();

    const sway = Math.sin(t * 2 * Math.PI / 60);
    ctx.globalAlpha = MUTE.bar;
    ctx.fillStyle = P.ink;
    bar(w * 0.4, h * 0.64, (-24 + sway * 1.2) * DEG, s * 0.07, Math.hypot(w, h) * 1.4);
    ctx.globalAlpha = MUTE.wedge;
    ctx.fillStyle = P.hand;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.8); ctx.lineTo(w * 0.32, h * 0.855); ctx.lineTo(0, h * 0.94);
    ctx.closePath(); ctx.fill();

    ctx.globalAlpha = MUTE.brass;
    ctx.fillStyle = P.brass;
    ctx.save();
    ctx.translate(w * 0.14, h * 0.24);
    ctx.rotate(-24 * DEG);
    ctx.fillRect(-s * 0.03, -s * 0.03, s * 0.06, s * 0.06);
    ctx.restore();

    ctx.globalAlpha = MUTE.tendril;
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const bx = w * (0.22 + i * 0.27);
      const sw = Math.sin(t * 0.12 + i * 1.7) * s * 0.06;
      ctx.beginPath();
      ctx.moveTo(bx, h + 10);
      ctx.bezierCurveTo(bx + sw, h * 0.78, bx - sw * 1.4, h * 0.62, bx + sw * 0.6, h * (0.46 + i * 0.05));
      ctx.stroke();
    }

    ctx.fillStyle = P.living;
    for (const m of motes) {
      if (!reduceMotion) {
        m.y -= m.vy * dt;
        if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
      }
      const x = m.x + Math.sin(t * 0.3 + m.phase) * m.drift;
      ctx.globalAlpha = m.a * (0.7 + 0.3 * Math.sin(t * 0.8 + m.phase));
      ctx.beginPath(); ctx.arc(x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(ts) {
    if (paused) return;
    if (ts - lastTs >= FRAME_MS) {
      const dt = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0;
      lastTs = ts;
      spin += dt;
      draw(ts, dt);
    }
    if (reduceMotion) return;
    animId = requestAnimationFrame(frame);
  }

  function kick() {
    cancelAnimationFrame(animId);
    lastTs = 0;
    animId = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  // Under reduced motion the loop holds still; scrolling redraws once.
  window.addEventListener('scroll', () => { if (reduceMotion) draw(performance.now(), 0); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (paused) cancelAnimationFrame(animId); else kick();
  });
  resize();
  kick();
})();
