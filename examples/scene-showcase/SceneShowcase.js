({
  // ==========================================================================
  // MODEL: which station the stage shows, where the desktop companion lives,
  // and whether the guide panel rides its floating dock. this.data is the
  // durable part (it travels with a clone); window and node ids are live state.
  // ==========================================================================

  _stations() {
    return {
      materials: {
        label: 'MATERIALS', title: 'MATERIAL PRESETS',
        text: "One param dresses a shape: material: 'gold'. Spheres on the plinth and shapes on the floor wear built-in presets (plus one this showcase registers) under look: 'studio', with a soft shadow and contact AO. Click a shape to wobble it."
      },
      arcade: {
        label: 'ARCADE', title: 'NEON ARCADE',
        text: "look: 'neon' with bloom, additive neon lines for the floor grid and portal, neon 3D text, a hologram orb, and two GPU particle emitters (sparks and drifting embers)."
      },
      title: {
        label: 'TITLE', title: 'EXTRUDED TITLE',
        text: "kind: 'text' in gold and chrome under a sunset sky, with a soft shadow, depth of field and an instanced halo. The stage has a camera node: drag inside it to orbit, use the wheel to zoom."
      }
    };
  },

  _initData() {
    const d = this.data;
    if (!this._stations()[d.station]) d.station = 'materials';
    if (!(Array.isArray(d.companion) && d.companion.length === 3 && d.companion.every(function (n) { return typeof n === 'number' && isFinite(n); }))) d.companion = null;
    if (typeof d.ride !== 'boolean') d.ride = true;
    return d;
  },

  _checkInvariants() {
    const d = this._initData();
    this.invariant(!!this._stations()[d.station], 'the current station must be one of materials, arcade, title');
    this.invariant(!this._attached || !!this._hudId, 'only an open guide panel can ride the dock');
    this.invariant(!this._hudId || !!this._mainId, 'the guide panel only exists alongside the stage window');
    return true;
  },

  // Screen placement from the live display size (px, workspace coordinates).
  async _layout() {
    let W = 1440, H = 900;
    try {
      const info = await this.call(await this.dep('UIServer'), 'getDisplayInfo', {});
      if (info && info.width > 0 && info.height > 0) { W = info.width; H = info.height; }
    } catch (e) { /* keep the default */ }
    const left = 184, gap = 20, hudW = 360, hudH = 520;
    const mainW = Math.max(600, Math.min(980, W - left - hudW - gap * 2));
    const mainH = Math.max(480, Math.min(680, H - 150));
    const main = { x: left, y: 70, w: mainW, h: mainH };
    return { W: W, H: H, main: main, hud: this._hudPlace(W, H, main, hudW, hudH, gap) };
  },

  // The panel sits right of the stage (its real rect: the desktop may shift it
  // clear of the left rail), and the companion's home is just below the panel.
  _hudPlace(W, H, main, hudW, hudH, gap) {
    const cx = Math.round(Math.min(W - hudW / 2 - 12, main.x + main.w + gap + hudW / 2));
    const cy = Math.round(main.y + hudH / 2 + 6);
    return { cx: cx, cy: cy, w: hudW, h: hudH, home: [cx, Math.round(Math.min(H - 100, cy + hudH / 2 + 110)), 60] };
  },

  // ==========================================================================
  // VIEW: the stage window's stations (window scope), the desktop companion
  // and the dock the guide panel rides (world scope). Pure op builders.
  // ==========================================================================

  _adder(ops) {
    return function (id, kind, transform, params, parentId) {
      ops.push({ op: 'add', id: id, parentId: parentId || 'stage', kind: kind, transform: transform || {}, params: params || {} });
    };
  },

  _heading(add, title, hint) {
    const w = this._stageW || 980, h = this._stageH || 680;
    const x = -w / 2 + 26, y = -h / 2 + 36 + 30;
    add('heading', 'label', { position: [x, y, 0] }, { text: title, size: 18, color: '$textPrimary', background: '$windowBg', padding: 8, anchor: [0, 0.5] });
    add('hint', 'label', { position: [x, y + 34, 0] }, { text: hint, size: 12, color: '$textSecondary', background: '$windowBg', padding: 6, anchor: [0, 0.5] });
  },

  _materialsOps() {
    const ops = [], anims = [];
    const add = this._adder(ops);
    add('env', 'environment', null, { look: 'studio', exposure: 1.0, envIntensity: 1.35, ao: { radius: 28, intensity: 1 }, fxaa: true });
    add('sky', 'sky', null, { top: '#a7adb5', horizon: '#6b7079', bottom: '#26282d' });
    add('key', 'light', null, { lightType: 'directional', direction: [-0.45, 0.8, -0.45], color: '#fff4e6', intensity: 1.4, castShadow: true, shadow: { size: 2048, softness: 3 } });
    add('fill', 'light', null, { lightType: 'hemisphere', color: '#e6eef8', groundColor: '#3b342e', intensity: 0.5 });
    // A palette-coloured rim light from behind; range keeps it off the floor.
    add('rim', 'light', { position: [0, -160, -1050] }, { lightType: 'point', color: '$accent', intensity: 1.6, range: 1000 });
    add('floor', 'mesh', { position: [0, 250, -420], scale: [2000, 12, 1600] }, { primitive: 'box', color: '#2e3136', roughness: 0.8, metalness: 0 });
    add('plinth', 'mesh', { position: [0, 182, -470], scale: [Math.min(1060, (this._stageW || 980) + 60), 124, 190] }, { primitive: 'roundedBox', shape: { radius: 0.05 }, color: '#464a52', roughness: 0.55 });

    // Back row: classic finishes on spheres, resting on the plinth.
    const back = ['gold', 'chrome', 'copper', 'glass', 'ceramic', 'obsidian'];
    const sw = this._stageW || 980;
    const backStep = Math.min(160, (sw - 110) / 5.2), frontStep = Math.min(170, (sw - 200) / 5);
    for (let i = 0; i < back.length; i++) {
      const g = 'mat-' + i;
      add(g, 'group', { position: [(i - 2.5) * backStep, 65, -470] }, {});
      add(g + '-shape', 'mesh', { scale: 110 }, { primitive: 'sphere', material: back[i], interactive: true, cursor: 'pointer' }, g);
      add(g + '-tag', 'label', { position: [0, -74, 0] }, { text: back[i], size: 12, color: '$textPrimary', background: '$windowBg', padding: 5 }, g);
    }

    // Front row: the parametric primitives, each in another preset.
    const enamel = this._enamel ? 'showcaseEnamel' : 'plastic';
    const star = [[0, -0.5], [0.12, -0.15], [0.5, -0.15], [0.19, 0.07], [0.3, 0.45], [0, 0.22], [-0.3, 0.45], [-0.19, 0.07], [-0.5, -0.15], [-0.12, -0.15]];
    const knot = [];
    for (let k = 0; k < 96; k++) {
      const t = (k / 96) * Math.PI * 2;
      knot.push([(Math.sin(t) + 2 * Math.sin(2 * t)) / 6.5, (Math.cos(t) - 2 * Math.cos(2 * t)) / 6.5, -Math.sin(3 * t) / 6.5]);
    }
    const front = [
      { tag: enamel + ' capsule', half: 65, t: { scale: [70, 130, 70] }, p: { primitive: 'capsule', material: enamel } },
      { tag: 'toon roundedBox', half: 62, t: { scale: 92, rotation: [0.35, 0.6, 0] }, p: { primitive: 'roundedBox', shape: { radius: 0.18 }, material: 'toon' } },
      { tag: 'bone lathe', half: 70, t: { scale: [100, 140, 100] }, p: { primitive: 'lathe', shape: { points: [[0.001, 0.5], [0.3, 0.5], [0.36, 0.3], [0.2, 0.05], [0.14, -0.2], [0.26, -0.44], [0.28, -0.5]] }, material: 'bone' } },
      { tag: 'neon extrude', half: 62, t: { scale: 130 }, p: { primitive: 'extrude', shape: { outline: star, depth: 0.16, bevel: 0.02 }, material: 'neon' } },
      { tag: 'hologram torus', half: 58, t: { scale: 130, rotation: [1.15, 0, 0.3] }, p: { primitive: 'torus', material: 'hologram', color: '$accentTertiary', rimColor: '$accentTertiary' } },
      { tag: 'brushedMetal tube', half: 56, t: { scale: 120 }, p: { primitive: 'tube', shape: { path: knot, radius: 0.075, segments: 192, radialSegments: 14, closed: true }, material: 'brushedMetal' } }
    ];
    for (let i = 0; i < front.length; i++) {
      const f = front[i];
      const g = 'mat-' + (back.length + i);
      add(g, 'group', { position: [(i - 2.5) * frontStep, 244 - f.half, -40] }, {});
      const params = Object.assign({ interactive: true, cursor: 'pointer' }, f.p);
      add(g + '-shape', 'mesh', f.t, params, g);
      add(g + '-tag', 'label', { position: [0, -f.half - 20, 0] }, { text: f.tag, size: 12, color: '$textPrimary', background: '$windowBg', padding: 5 }, g);
    }
    anims.push({ op: 'animate', id: 'mat-10-shape', params: { preset: 'spin', axis: 'y', duration: 9000 } });
    anims.push({ op: 'animate', id: 'mat-11-shape', params: { preset: 'spin', axis: 'y', duration: 14000 } });
    this._heading(add, 'MATERIAL PRESETS', "params.material: 'gold'   environment look: 'studio'");
    return { ops: ops, anims: anims };
  },

  _arcadeOps() {
    const ops = [], anims = [];
    const add = this._adder(ops);
    add('env', 'environment', null, {
      look: 'neon', bloom: { threshold: 0.42, intensity: 1.25, quality: 'high' },
      fog: { color: '#12061f', near: 600, far: 3400 }, chromaticAberration: 1.2,
      grading: { saturation: 1.2, contrast: 1.1, vignette: 0.45 }
    });
    add('sky', 'sky', null, { top: '#05030d', horizon: '#3b0d4f', bottom: '#030208', stars: 0.6 });
    add('glowL', 'light', { position: [-420, -60, -250] }, { lightType: 'point', color: '#ff2bd6', intensity: 2.2 });
    add('glowR', 'light', { position: [420, -60, -250] }, { lightType: 'point', color: '#27e7ff', intensity: 2.2 });
    add('fill', 'light', null, { lightType: 'hemisphere', color: '#3a2a6a', groundColor: '#0a0612', intensity: 0.5 });
    add('floor', 'mesh', { position: [0, 250, -600], scale: [2400, 10, 2000] }, { primitive: 'box', color: '#08060d', metalness: 0.5, roughness: 0.3 });
    for (let i = -6; i <= 6; i++) {
      add('gx' + (i + 6), 'line', null, { points: [[i * 160, 244, 400], [i * 160, 244, -1600]], width: 2, color: '#ff2bd6', blend: 'additive' });
    }
    for (let j = 0; j < 12; j++) {
      const z = 400 - j * 170;
      add('gz' + j, 'line', null, { points: [[-1100, 244, z], [1100, 244, z]], width: 2, color: '#ff2bd6', blend: 'additive' });
    }
    // A setting synthwave sun, banded by strips of the night sky.
    add('sun', 'mesh', { position: [0, 120, -1850], scale: 820 }, { primitive: 'sphere', color: '#ff4d6d', shading: 'unlit', castShadow: false });
    const D = 1680, zs = -1850, zb = -1440, R = 410, cy = 120;
    const ss = D / (D - zs), sb = D / (D - zb);
    for (let b = 0; b < 4; b++) {
      const y = cy + 10 + b * 38;
      const half = Math.sqrt(Math.max(0, R * R - (y - cy) * (y - cy))) * ss / sb;
      add('band' + b, 'mesh', { position: [0, y * ss / sb, zb], scale: [half * 2, (5 + b * 4) * ss / sb, 2] }, { primitive: 'box', color: '#12061f', shading: 'unlit', castShadow: false });
    }
    const ring = function (r) {
      const pts = [];
      for (let k = 0; k < 72; k++) { const a = (k / 72) * Math.PI * 2; pts.push([Math.cos(a) * r, Math.sin(a) * r, 0]); }
      return pts;
    };
    add('portal', 'group', { position: [0, 10, -700] }, {});
    add('portalOuter', 'line', null, { points: ring(260), closed: true, width: 8, color: '#ff2bd6', blend: 'additive' }, 'portal');
    add('portalInner', 'line', null, { points: ring(226), closed: true, width: 4, color: '#27e7ff', blend: 'additive' }, 'portal');
    add('sign', 'text', { position: [0, -310, -560] }, { text: 'ARCADE', size: 120, depth: 18, bevel: 2, material: 'neon', color: '#27e7ff', emissive: '#27e7ff' });
    add('orb', 'mesh', { position: [-330, 70, -300], scale: 150 }, { primitive: 'icosphere', material: 'hologram', color: '#27e7ff', rimColor: '#27e7ff' });
    add('mirror', 'mesh', { position: [330, 110, -260], scale: 130 }, { primitive: 'sphere', material: 'chrome' });
    add('sparks', 'particles', { position: [0, 244, -700] }, {
      rate: 90, lifetime: 1400, speed: [140, 280], direction: [0, -1, 0], spread: 0.5, gravity: 420, drag: 0.15,
      size: [2, 4], sizeEnd: 0, color: '#ffd166', colorEnd: '#ff2bd6', maxParticles: 400
    });
    add('embers', 'particles', { position: [0, 120, -600] }, {
      rate: 50, lifetime: 5000, speed: [10, 40], direction: [0, -1, 0], spread: 0.7, turbulence: 60,
      emitterSize: [1600, 60, 900], size: [2, 5], color: '#27e7ff', colorEnd: '#ff2bd6', opacityEnd: 0, maxParticles: 400
    });
    anims.push({ op: 'animate', id: 'orb', params: { preset: 'float', duration: 5000 } });
    anims.push({ op: 'animate', id: 'mirror', params: { preset: 'bob', amplitude: 16, duration: 3200 } });
    anims.push({ op: 'animate', id: 'portal', params: { channel: 'rotation', keyframes: [{ t: 0, value: [0, -0.25, 0], easing: 'easeInOut' }, { t: 4000, value: [0, 0.25, 0], easing: 'easeInOut' }, { t: 8000, value: [0, -0.25, 0] }], loop: true } });
    this._heading(add, 'NEON ARCADE', "look: 'neon'   bloom   blend: 'additive'   particles");
    return { ops: ops, anims: anims };
  },

  _titleOps() {
    const ops = [], anims = [];
    const add = this._adder(ops);
    add('cam', 'camera', { position: [0, -200, 950] }, { target: [0, 0, 0], fov: 34, orbit: { minDistance: 450, maxDistance: 1800, minPitch: -0.1, maxPitch: 1.0, damping: 0.9 }, zoom: true });
    add('env', 'environment', null, {
      look: 'sunset', fog: { color: '#d9826a', near: 1600, far: 6000 }, ao: true, dof: { focus: 0, range: 520, aperture: 5 },
      grading: { temperature: 0.2, saturation: 1.15, contrast: 1.12, vignette: 0.35 }
    });
    add('sky', 'sky', null, { top: '#1d2257', horizon: '#ff7b47', bottom: '#1a0f1c', sun: { direction: [-0.78, -0.16, -0.6], color: '#ffb26a', size: 4 } });
    // The key travels away from the viewer (-z), so it lights the letters' faces.
    add('key', 'light', null, { lightType: 'directional', direction: [-0.35, 0.5, -0.8], color: '#ffe2bf', intensity: 1.7, castShadow: true, shadow: { size: 2048, softness: 2.5 } });
    add('fill', 'light', null, { lightType: 'hemisphere', color: '#9fb0ff', groundColor: '#3a1d2a', intensity: 0.45 });
    add('disc', 'mesh', { position: [0, 190, 0], scale: [1100, 20, 1100] }, { primitive: 'cylinder', material: 'obsidian', color: '#140d18', clearcoat: 0.6, envIntensity: 0.5 });
    add('titleGroup', 'group', {}, {});
    add('title', 'text', { position: [0, -40, 0] }, { text: 'ABJECTS', size: 130, depth: 34, bevel: 4, material: 'gold' }, 'titleGroup');
    add('subtitle', 'text', { position: [0, 80, 10] }, { text: 'EVERYTHING IS AN OBJECT', size: 34, depth: 6, bevel: 1, material: 'chrome' }, 'titleGroup');
    const inst = [];
    const palette = ['$accent', '$accentTertiary', '#e8e2d0'];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      inst.push({ position: [Math.cos(a) * 520, 150 + Math.sin(a * 3) * 18, Math.sin(a) * 520], scale: 16 + (i % 4) * 4, rotation: [a, a * 2, 0], color: palette[i % 3] });
    }
    add('halo', 'mesh', null, { primitive: 'box', color: '#ffffff', metalness: 0.6, roughness: 0.3, instances: inst });
    anims.push({ op: 'animate', id: 'halo', params: { preset: 'spin', axis: 'y', duration: 40000 } });
    anims.push({ op: 'animate', id: 'titleGroup', params: { preset: 'float', duration: 6000 } });
    return { ops: ops, anims: anims };
  },

  _companionOps(pos) {
    const ops = [];
    const add = function (id, kind, transform, params, parentId) {
      const op = { op: 'add', id: id, kind: kind, transform: transform || {}, params: params || {} };
      if (parentId) op.parentId = parentId;
      ops.push(op);
    };
    add('buddy', 'group', { position: pos }, { layer: 'stack', draggable: { inertia: true }, cursor: 'grab' });
    add('buddy-core', 'group', {}, {}, 'buddy');
    add('buddy-body', 'mesh', { scale: 86 }, { primitive: 'sphere', material: 'plastic', trail: { color: '$accentTertiary', width: 12, lifetime: 1400 } }, 'buddy-core');
    add('buddy-eye', 'group', { position: [0, -6, 36] }, {}, 'buddy-core');
    add('buddy-white', 'mesh', { scale: [42, 42, 14] }, { primitive: 'sphere', color: '#f3ecd8', roughness: 0.3 }, 'buddy-eye');
    add('buddy-ring', 'mesh', { position: [0, 0, 6], scale: 56 }, { primitive: 'ring', material: 'gold' }, 'buddy-eye');
    add('buddy-pupil', 'mesh', { position: [0, 0, 8], scale: [7, 28, 6] }, { primitive: 'capsule', color: '#0e0b14', roughness: 0.2 }, 'buddy-eye');
    add('buddy-tag', 'label', { position: [0, -74, 0] }, { text: 'DRAG ME', size: 12, color: '$textPrimary', background: '$windowBg', padding: 6 }, 'buddy');
    add('buddy-sparks', 'particles', {}, {
      burst: 36, burstKey: 0, rate: 0, lifetime: 900, speed: [90, 220], direction: [0, -1, 0], spread: 3.1,
      gravity: 260, size: [2, 5], sizeEnd: 0, color: '$accentTertiary', colorEnd: '$accent', maxParticles: 200
    }, 'buddy');
    ops.push({ op: 'animate', id: 'buddy-body', params: { preset: 'breathe' } });
    return ops;
  },

  _dockOps(hud) {
    return [
      { op: 'add', id: 'dock', kind: 'group', transform: { position: [hud.cx, hud.cy, 0] }, params: {} },
      { op: 'animate', id: 'dock', params: { channel: 'rotation', keyframes: [
        { t: 0, value: [0.04, -0.24, 0], easing: 'easeInOut' },
        { t: 5000, value: [-0.04, 0.24, 0], easing: 'easeInOut' },
        { t: 10000, value: [0.04, -0.24, 0] }
      ], loop: true } }
    ];
  },

  async _world(ops) {
    return this.call(await this.dep('UIServer'), 'scene', { world: true, ops: ops });
  },

  // ==========================================================================
  // USE CASES
  // ==========================================================================

  async show(msg) {
    const d = this._initData();
    const wm = await this.dep('WidgetManager');
    if (this._mainId) {
      try { await this.call(wm, 'raiseWindow', { windowId: this._mainId }); } catch (e) { /* already gone */ }
      return { windowId: this._mainId, hudId: this._hudId, station: d.station, reopened: true };
    }
    const L = await this._layout();
    this._L = L;
    // A preset of our own, usable by name from any abject while we live.
    this._enamel = false;
    try {
      await this.call(await this.dep('SceneLibrary'), 'registerMaterial', {
        name: 'showcaseEnamel',
        spec: { color: '$accentTertiary', metalness: 0, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.04 },
        description: 'Glossy enamel in the theme\'s tertiary accent (registered by the scene showcase)'
      });
      this._enamel = true;
    } catch (e) { /* the built-in plastic stands in */ }

    this._mainId = await this.call(wm, 'createWindowAbject', {
      title: 'Scene Showcase', rect: { x: L.main.x, y: L.main.y, w: L.main.w, h: L.main.h }, resizable: false, closable: true
    });
    this.ensure(!!this._mainId, 'the stage window must exist before a station can be shown');
    try {
      const r = await this.call(this._mainId, 'getRect', {});
      if (r && r.width > 0) L.hud = this._hudPlace(L.W, L.H, { x: r.x, y: r.y, w: r.width, h: r.height }, L.hud.w, L.hud.h, 20);
    } catch (e) { /* keep the planned spot */ }
    this._stageW = L.main.w;
    this._stageH = L.main.h;
    await this._openHud();

    const home = d.companion || L.hud.home;
    await this._world(this._companionOps(home));
    this._burst = 0;
    await this._showStation(d.station);
    this._checkInvariants();
    await this.changed('opened', { windowId: this._mainId, hudId: this._hudId });
    return { windowId: this._mainId, hudId: this._hudId, station: d.station };
  },

  async _openHud() {
    const L = this._L;
    const d = this._initData();
    const wm = await this.dep('WidgetManager');
    const h = L.hud;
    const hudId = await this.call(wm, 'createWindowAbject', {
      title: 'Showcase Guide', rect: { x: Math.round(h.cx - h.w / 2), y: Math.round(h.cy - h.h / 2), w: h.w, h: h.h }, resizable: false, closable: true
    });
    this._hudId = hudId;
    const root = await this.call(wm, 'createVBox', { windowId: hudId, margins: { top: 14, right: 14, bottom: 14, left: 14 }, spacing: 8 });
    const row = await this.call(wm, 'createHBox', { windowId: hudId, margins: { top: 0, right: 0, bottom: 0, left: 0 }, spacing: 6 });
    const st = this._stations();
    const made = await this.call(wm, 'create', { specs: [
      { type: 'label', windowId: hudId, text: 'SCENE SHOWCASE', style: { fontSize: 20, fontWeight: 'bold' } },
      { type: 'label', windowId: hudId, text: st[d.station].title, style: { fontSize: 14, fontWeight: 'bold' } },
      { type: 'label', windowId: hudId, text: st[d.station].text, style: { wordWrap: true, fontSize: 13 } },
      { type: 'button', windowId: hudId, text: st.materials.label },
      { type: 'button', windowId: hudId, text: st.arcade.label },
      { type: 'button', windowId: hudId, text: st.title.label },
      { type: 'button', windowId: hudId, text: 'SUMMON COMPANION' },
      { type: 'button', windowId: hudId, text: d.ride ? 'RIDE THE DOCK: ON' : 'RIDE THE DOCK: OFF' },
      { type: 'button', windowId: hudId, text: 'SCENE INFO' },
      { type: 'label', windowId: hudId, text: 'The companion is a world object: drag it anywhere on the desktop. This panel is a window riding a turning world node.', style: { wordWrap: true, fontSize: 12 } }
    ] });
    const ids = made.widgetIds;
    this._w = {
      title: ids[0], stationTitle: ids[1], text: ids[2],
      materials: ids[3], arcade: ids[4], titleBtn: ids[5],
      summon: ids[6], ride: ids[7], info: ids[8], infoText: ids[9]
    };
    for (let i = 3; i <= 8; i++) await this.call(ids[i], 'addDependent', {});
    await this.call(row, 'addLayoutChildren', { children: [
      { widgetId: ids[3], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } },
      { widgetId: ids[4], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } },
      { widgetId: ids[5], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } }
    ] });
    await this.call(root, 'addLayoutChildren', { children: [
      { widgetId: ids[0], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 28 } },
      { widgetId: ids[1], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 20 } },
      { widgetId: ids[2], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 104 } },
      { widgetId: row, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } },
      { widgetId: ids[6], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } },
      { widgetId: ids[7], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } },
      { widgetId: ids[8], sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 32 } },
      { widgetId: ids[9], sizePolicy: { horizontal: 'expanding', vertical: 'expanding' } }
    ] });
    // A gold ring pops out past the panel's corner (clip: 'none').
    await this.call(hudId, 'scene', { ops: [
      { op: 'add', id: 'hud-ring', kind: 'mesh', transform: { position: [h.w / 2 - 8, -h.h / 2 + 8, 50], scale: 64 }, params: { primitive: 'ring', material: 'gold', clip: 'none' } },
      { op: 'animate', id: 'hud-ring', params: { preset: 'spin', axis: 'y', duration: 7000 } }
    ] });
    await this._world(this._dockOps(h));
    this._attached = false;
    if (d.ride) await this._attach(true);
    return hudId;
  },

  async _attach(on) {
    if (!this._hudId) return false;
    if (on) {
      await this.call(this._hudId, 'attachTo', { scope: 'world', nodeId: 'dock', offset: [0, 0, 0] });
    } else {
      await this.call(this._hudId, 'attachTo', { detach: true });
    }
    this._attached = !!on;
    return this._attached;
  },

  async _showStation(key) {
    const st = this._stations()[key];
    this.ensure(!!st, 'unknown station: ' + key);
    if (!this._mainId) return false;
    const built = key === 'materials' ? this._materialsOps() : key === 'arcade' ? this._arcadeOps() : this._titleOps();
    const ops = [
      { op: 'remove', id: 'stage' },
      { op: 'add', id: 'stage', kind: 'group', transform: {}, params: {} }
    ].concat(built.ops, built.anims);
    await this.call(this._mainId, 'scene', { ops: ops });
    this._station = key;
    if (this._w) {
      try {
        await this.call(this._w.stationTitle, 'update', { text: st.title });
        await this.call(this._w.text, 'update', { text: st.text });
      } catch (e) { /* the panel closed */ }
    }
    return true;
  },

  async hide(msg) {
    const wm = await this.dep('WidgetManager');
    // World nodes first: the panel lets go of its dock, then nothing of ours
    // is left on the desktop.
    if (this._hudId && this._attached) { try { await this._attach(false); } catch (e) { /* gone */ } }
    try { await this._world([{ op: 'remove', id: 'buddy' }, { op: 'remove', id: 'dock' }]); } catch (e) { /* gone */ }
    const ids = [this._hudId, this._mainId];
    this._hudId = null;
    this._mainId = null;
    this._w = null;
    this._attached = false;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i]) { try { await this.call(wm, 'destroyWindowAbject', { windowId: ids[i] }); } catch (e) { /* gone */ } }
    }
    if (this._enamel) {
      try { await this.call(await this.dep('SceneLibrary'), 'unregisterMaterial', { name: 'showcaseEnamel' }); } catch (e) { /* gone */ }
      this._enamel = false;
    }
    await this.changed('closed', {});
    this.ensure(!this._mainId && !this._hudId, 'hide leaves no showcase window open');
    return true;
  },

  async windowCloseRequested(msg) {
    const wid = msg && msg.payload ? msg.payload.windowId : null;
    if (wid && wid === this._hudId) {
      // Closing just the panel: let go of the dock and keep the stage.
      if (this._attached) { try { await this._attach(false); } catch (e) { /* gone */ } }
      const hudId = this._hudId;
      this._hudId = null;
      this._w = null;
      try { await this._world([{ op: 'remove', id: 'dock' }]); } catch (e) { /* gone */ }
      try { await this.call(await this.dep('WidgetManager'), 'destroyWindowAbject', { windowId: hudId }); } catch (e) { /* gone */ }
      return true;
    }
    await this.hide({});
    return true;
  },

  async setStation(msg) {
    const key = msg && msg.payload ? msg.payload.station : null;
    this.ensure(!!this._stations()[key], "setStation needs station: 'materials' | 'arcade' | 'title'");
    const d = this._initData();
    d.station = key;
    await this._showStation(key);
    await this.saveData();
    this._checkInvariants();
    return { station: key };
  },

  async summonCompanion(msg) {
    const L = this._L || await this._layout();
    const to = L.hud.home;
    await this._world([
      { op: 'animate', id: 'buddy', params: { channel: 'position', to: to, spring: { stiffness: 90, damping: 11 } } }
    ]);
    const d = this._initData();
    d.companion = to;
    await this.saveData();
    // The spring runs in the browser; once it settles, the retained copy
    // (what a reconnecting screen sees) moves there too.
    const self = this;
    setTimeout(function () {
      if (!self._mainId) return;
      self._world([{ op: 'update', id: 'buddy', transform: { position: to } }]).catch(function () {});
    }, 2200);
    return { position: to };
  },

  async toggleRide(msg) {
    const d = this._initData();
    const want = msg && msg.payload && typeof msg.payload.ride === 'boolean' ? msg.payload.ride : !this._attached;
    if (!this._hudId) return { ride: false };
    await this._attach(want);
    d.ride = want;
    await this.saveData();
    if (this._w) await this.call(this._w.ride, 'update', { text: want ? 'RIDE THE DOCK: ON' : 'RIDE THE DOCK: OFF' });
    this._checkInvariants();
    return { ride: want };
  },

  async sceneInfo(msg) {
    const p = await this.call(await this.dep('WidgetManager'), 'getSceneParams', {}, { timeout: 10000 });
    const c = p.capabilities || null, s = p.stats || null;
    let text = 'No screen answered, so GPU details are unknown.';
    if (c && s) {
      const fm = s.frameMs || {};
      const q = c.postQuality ? c.postQuality.name : 'n/a';
      text = (c.gpu ? c.gpu + '\n' : '') +
        (s.fps ? s.fps + ' fps, ' + fm.avg + ' ms avg, ' + fm.p95 + ' ms p95\n' : 'idle (nothing animating)\n') +
        s.drawCalls + ' draw calls, ' + s.triangles + ' triangles, ' + s.particles + ' particles\n' +
        'post quality: ' + q + ', textures ~' + s.textureMB + ' MB';
    }
    if (this._w) { try { await this.call(this._w.infoText, 'update', { text: text }); } catch (e) { /* closed */ } }
    return { capabilities: c, stats: s, text: text };
  },

  async getState(msg) {
    const d = this._initData();
    return {
      station: d.station, ride: this._attached === true, companion: d.companion,
      windowId: this._mainId || null, hudId: this._hudId || null,
      enamelRegistered: this._enamel === true
    };
  },

  // Widget clicks from the guide panel.
  async changed(msg) {
    const p = (msg && msg.payload) || {};
    if (p.aspect !== 'click' || !this._w) return false;
    const from = msg.routing ? msg.routing.from : null;
    const w = this._w;
    if (from === w.materials) return this.setStation({ payload: { station: 'materials' } });
    if (from === w.arcade) return this.setStation({ payload: { station: 'arcade' } });
    if (from === w.titleBtn) return this.setStation({ payload: { station: 'title' } });
    if (from === w.summon) return this.summonCompanion({});
    if (from === w.ride) return this.toggleRide({ payload: {} });
    if (from === w.info) return this.sceneInfo({});
    return false;
  },

  // Scene input: shapes on the stage, and the desktop companion.
  async nodeInput(msg) {
    const p = (msg && msg.payload) || {};
    const id = String(p.nodeId || '');
    if (id === 'buddy' || id.indexOf('buddy-') === 0) return this._companionInput(p);
    if (!this._mainId) return false;
    if (p.type === 'mousedown' && /^mat-\d+-shape$/.test(id)) {
      await this.call(this._mainId, 'scene', { ops: [{ op: 'animate', id: id, params: { preset: 'wobble' } }] });
      return true;
    }
    if (p.type === 'cameraChange') this._view = { position: p.position, target: p.target };
    return true;
  },

  async _companionInput(p) {
    if (p.type === 'dragStart') {
      this._dragging = true;
      await this._world([{ op: 'update', id: 'buddy-tag', params: { text: 'WHEE' } }]);
      return true;
    }
    if (p.type === 'dragEnd') {
      this._dragging = false;
      const d = this._initData();
      if (Array.isArray(p.position)) d.companion = p.position;
      await this._world([
        { op: 'update', id: 'buddy-tag', params: { text: 'DRAG ME' } },
        { op: 'animate', id: 'buddy-core', params: { preset: 'wobble' } }
      ]);
      await this.saveData();
      return true;
    }
    if (p.type === 'mouseup' && !this._dragging) {
      this._burst = (this._burst || 0) + 1;
      await this._world([
        { op: 'update', id: 'buddy-sparks', params: { burstKey: this._burst } },
        { op: 'animate', id: 'buddy-core', params: { preset: 'wobble' } }
      ]);
      return true;
    }
    return true;
  }
})
