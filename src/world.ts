import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const UP = new THREE.Vector3(0, 1, 0);
const ROAD_HALF = 3.2;

/** Camera rig keyframes, in the bus's own frame: side (right+), up, ahead (forward+). */
interface Key {
  p: number;
  side: number;
  up: number;
  ahead: number;
  lookSide: number;
  lookUp: number;
  lookAhead: number;
  fov: number;
}
const KEYS: Key[] = [
  { p: 0.0, side: 9.5, up: 3.3, ahead: 12.5, lookSide: 0, lookUp: 1.5, lookAhead: 0, fov: 34 },
  { p: 0.14, side: 8.5, up: 3.4, ahead: -11, lookSide: 0, lookUp: 1.6, lookAhead: 0, fov: 40 },
  { p: 0.3, side: 13, up: 2.4, ahead: 1.5, lookSide: 0, lookUp: 1.5, lookAhead: 0, fov: 38 },
  { p: 0.48, side: 3, up: 22, ahead: -8, lookSide: 0, lookUp: 0, lookAhead: 4, fov: 42 },
  { p: 0.66, side: -7.5, up: 1.6, ahead: 11, lookSide: 0, lookUp: 1.7, lookAhead: -1, fov: 40 },
  { p: 0.84, side: 11, up: 4.5, ahead: 12, lookSide: 0, lookUp: 2, lookAhead: 6, fov: 40 },
  { p: 1.0, side: 7, up: 8.5, ahead: -24, lookSide: 0, lookUp: 3.5, lookAhead: 9, fov: 44 },
];

interface Mood {
  p: number;
  sky: string;
  ground: string;
  sun: string;
  sunIntensity: number;
  hemi: number;
}
const MOODS: Mood[] = [
  { p: 0.0, sky: "#ffd9bd", ground: "#a9d68f", sun: "#ffc99a", sunIntensity: 2.4, hemi: 0.9 },
  { p: 0.3, sky: "#bfe4ff", ground: "#9fd18b", sun: "#fff4dd", sunIntensity: 3.0, hemi: 1.0 },
  { p: 0.62, sky: "#c9e9ff", ground: "#93c97f", sun: "#ffffff", sunIntensity: 3.1, hemi: 1.0 },
  { p: 0.82, sky: "#ffb98a", ground: "#8fb878", sun: "#ff9f5a", sunIntensity: 2.6, hemi: 0.8 },
  { p: 1.0, sky: "#26245f", ground: "#3d5a52", sun: "#7f86ff", sunIntensity: 0.9, hemi: 0.45 },
];

const smooth = (t: number) => t * t * (3 - 2 * t);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sideTexture(text: string, bg: string, fg: string) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = fg;
  g.font = "800 84px 'Bricolage Grotesque', Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

interface Stop {
  u: number;
  kids: THREE.Mesh[];
  ring: THREE.Mesh;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
  private curve: THREE.CatmullRomCurve3;
  private samples: THREE.Vector3[];
  private bus = new THREE.Group();
  private wheels: THREE.Mesh[] = [];
  private beacons: THREE.Mesh[] = [];
  private headlights: THREE.SpotLight[] = [];
  private headGlow!: THREE.MeshStandardMaterial;
  private sun = new THREE.DirectionalLight();
  private hemi = new THREE.HemisphereLight(0xffffff, 0x88aa77, 1);
  private ground: THREE.Mesh;
  private clouds: THREE.Group[] = [];
  private stops: Stop[] = [];
  private stars: THREE.Points;
  private school = new THREE.Group();

  private targetP = 0;
  private p = 0;
  private lastU = 0;
  private pointer = new THREE.Vector2();
  private clock = new THREE.Clock();
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private colA = new THREE.Color();
  private colB = new THREE.Color();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.scene.background = new THREE.Color("#ffd9bd");
    this.scene.fog = new THREE.Fog("#ffd9bd", 40, 150);

    const pts = [
      [0, 0],
      [9, -26],
      [-7, -56],
      [10, -92],
      [-9, -128],
      [4, -160],
      [0, -190],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    this.samples = this.curve.getSpacedPoints(480);

    this.ground = this.buildGround();
    this.buildRoad();
    this.buildScenery();
    this.buildStops();
    this.buildSchool();
    this.buildBus();
    this.buildClouds();
    this.stars = this.buildStars();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 34;
    sc.bottom = -34;
    sc.near = 1;
    sc.far = 120;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    window.addEventListener("resize", this.resize);
    window.addEventListener("pointermove", (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    });
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  /** Jump straight to the target progress (no easing) — used for testing and reduced motion. */
  snap() {
    this.p = this.targetP;
  }

  setProgress(p: number) {
    this.targetP = THREE.MathUtils.clamp(p, 0, 1);
  }

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // push the subject to the right on wide screens so the hero copy has room on the left
    if (w > 960) this.camera.setViewOffset(w, h, -w * 0.17, 0, w, h);
    else this.camera.setViewOffset(w, h, 0, -h * 0.24, w, h);
    this.camera.updateProjectionMatrix();
  };

  // ---------------------------------------------------------------- scenery

  private buildGround() {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(700, 700),
      new THREE.MeshStandardMaterial({ color: "#a9d68f", roughness: 1 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, -0.06, -95);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  private ribbon(from: number, to: number, left: number, right: number, y: number, material: THREE.Material) {
    const pos: number[] = [];
    const idx: number[] = [];
    const n = this.samples.length;
    for (let i = from; i <= to && i < n; i++) {
      const a = this.samples[Math.max(0, i - 1)]!;
      const b = this.samples[Math.min(n - 1, i + 1)]!;
      const t = this.tmpA.copy(b).sub(a).normalize();
      const r = this.tmpB.crossVectors(t, UP).normalize();
      const c = this.samples[i]!;
      pos.push(c.x + r.x * left, y, c.z + r.z * left, c.x + r.x * right, y, c.z + r.z * right);
      const k = (i - from) * 2;
      if (i < to && i < n - 1) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  private buildRoad() {
    const n = this.samples.length - 1;
    this.ribbon(0, n, -ROAD_HALF - 1.6, ROAD_HALF + 1.6, 0.0, new THREE.MeshStandardMaterial({ color: "#e9e4d8", roughness: 1 }));
    this.ribbon(0, n, -ROAD_HALF, ROAD_HALF, 0.02, new THREE.MeshStandardMaterial({ color: "#3a3d4a", roughness: 0.92 }));
    const white = new THREE.MeshStandardMaterial({ color: "#f5f5f0", roughness: 0.9 });
    this.ribbon(0, n, -ROAD_HALF + 0.3, -ROAD_HALF + 0.42, 0.03, white);
    this.ribbon(0, n, ROAD_HALF - 0.42, ROAD_HALF - 0.3, 0.03, white);
    const yellow = new THREE.MeshStandardMaterial({ color: "#ffc21a", roughness: 0.8 });
    for (let i = 0; i < n - 4; i += 9) this.ribbon(i, i + 4, -0.1, 0.1, 0.035, yellow);
  }

  private nearRoad(x: number, z: number, min: number) {
    for (let i = 0; i < this.samples.length; i += 2) {
      const s = this.samples[i]!;
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz < min * min) return true;
    }
    return false;
  }

  private buildScenery() {
    const rnd = mulberry32(7);
    const houses: { x: number; z: number; w: number; h: number; d: number; ry: number; color: THREE.Color; roof: THREE.Color }[] = [];
    const trees: { x: number; z: number; s: number }[] = [];
    const palette = ["#ffe0c2", "#ffd0d0", "#d6ecff", "#fff0b8", "#e4d9ff", "#d8f3dc"].map((c) => new THREE.Color(c));
    const roofs = ["#e76f51", "#6c63ff", "#ef476f", "#118ab2", "#f4a261"].map((c) => new THREE.Color(c));

    for (let i = 0; i < 1400 && (houses.length < 70 || trees.length < 260); i++) {
      const z = 14 - rnd() * 215;
      const x = (rnd() - 0.5) * 120;
      if (this.nearRoad(x, z, 8)) continue;
      const nearish = this.nearRoad(x, z, 22);
      if (rnd() < 0.3 && nearish && !this.nearRoad(x, z, 15) && houses.length < 70) {
        houses.push({
          x,
          z,
          w: 3 + rnd() * 2.5,
          h: 2.4 + rnd() * 2.2,
          d: 3 + rnd() * 2.5,
          ry: rnd() * Math.PI,
          color: palette[Math.floor(rnd() * palette.length)]!,
          roof: roofs[Math.floor(rnd() * roofs.length)]!,
        });
      } else if (trees.length < 260) {
        trees.push({ x, z, s: 0.8 + rnd() * 1.2 });
      }
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.85 }), houses.length);
    const tops = new THREE.InstancedMesh(new THREE.ConeGeometry(0.78, 0.7, 4), new THREE.MeshStandardMaterial({ roughness: 0.8 }), houses.length);
    houses.forEach((h, i) => {
      e.set(0, h.ry, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(h.x, h.h / 2, h.z), q, new THREE.Vector3(h.w, h.h, h.d));
      bodies.setMatrixAt(i, m);
      bodies.setColorAt(i, h.color);
      e.set(0, h.ry + Math.PI / 4, 0);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(h.x, h.h + h.w * 0.3, h.z), q, new THREE.Vector3(h.w * 1.32, h.w * 0.9, h.d * 1.32));
      tops.setMatrixAt(i, m);
      tops.setColorAt(i, h.roof);
    });
    bodies.castShadow = bodies.receiveShadow = true;
    tops.castShadow = true;
    this.scene.add(bodies, tops);

    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 1, 6), new THREE.MeshStandardMaterial({ color: "#7a5230", roughness: 1 }), trees.length);
    const leaves = new THREE.InstancedMesh(new THREE.ConeGeometry(0.95, 2.2, 7), new THREE.MeshStandardMaterial({ roughness: 0.9 }), trees.length);
    const greens = ["#3f9d57", "#4caf6a", "#2f8a4b", "#62b86f"].map((c) => new THREE.Color(c));
    trees.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, 0.5 * t.s, t.z), q.identity(), new THREE.Vector3(t.s, t.s, t.s));
      trunks.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(t.x, 1.9 * t.s, t.z), q.identity(), new THREE.Vector3(t.s, t.s, t.s));
      leaves.setMatrixAt(i, m);
      leaves.setColorAt(i, greens[i % greens.length]!);
    });
    trunks.castShadow = leaves.castShadow = true;
    this.scene.add(trunks, leaves);
  }

  private buildStops() {
    const rnd = mulberry32(21);
    const kidColors = ["#ef476f", "#118ab2", "#06d6a0", "#ffd166", "#8338ec", "#fb5607"];
    for (const u of [0.2, 0.43, 0.67]) {
      const c = this.curve.getPointAt(u);
      const t = this.curve.getTangentAt(u);
      const r = new THREE.Vector3().crossVectors(t, UP).normalize();
      const base = c.clone().addScaledVector(r, ROAD_HALF + 2.3);

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.8, 8), new THREE.MeshStandardMaterial({ color: "#555a6e" }));
      pole.position.copy(base).setY(1.4);
      const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.08, 8), new THREE.MeshStandardMaterial({ color: "#ffc21a", emissive: "#ffb000", emissiveIntensity: 0.3 }));
      sign.geometry.rotateX(Math.PI / 2);
      sign.rotation.y = Math.atan2(-t.x, -t.z);
      sign.position.copy(base).setY(2.7);
      pole.castShadow = sign.castShadow = true;

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.7, 40),
        new THREE.MeshBasicMaterial({ color: "#6c63ff", transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(base).addScaledVector(r, -0.4).setY(0.05);
      this.beacons.push(ring);

      const kids: THREE.Mesh[] = [];
      for (let k = 0; k < 3; k++) {
        const kid = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.24, 0.62, 4, 10),
          new THREE.MeshStandardMaterial({ color: kidColors[Math.floor(rnd() * kidColors.length)], roughness: 0.6 }),
        );
        kid.position.copy(base).addScaledVector(t, (k - 1) * 0.85).addScaledVector(r, -0.9 + rnd() * 0.4).setY(0.55);
        kid.castShadow = true;
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), new THREE.MeshStandardMaterial({ color: "#ffd9b0", roughness: 0.7 }));
        head.position.y = 0.58;
        kid.add(head);
        this.scene.add(kid);
        kids.push(kid);
      }
      this.scene.add(pole, sign, ring);
      this.stops.push({ u, kids, ring });
    }
  }

  private buildSchool() {
    const end = this.curve.getPointAt(1);
    const t = this.curve.getTangentAt(1);
    const mat = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
    const body = new THREE.Mesh(new RoundedBoxGeometry(22, 8, 9, 3, 0.25), mat("#ff8a65"));
    body.position.y = 4;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(23, 0.7, 10), mat("#5b4fe0"));
    roof.position.y = 8.3;
    const door = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4, 0.3), mat("#3d2c8d"));
    door.position.set(0, 2, 4.6);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), mat("#ffb08f"));
    tower.position.set(0, 10.5, 0);
    const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(4, 3.2, 4), mat("#5b4fe0"));
    towerRoof.position.set(0, 14.6, 0);
    towerRoof.rotation.y = Math.PI / 4;
    const clock = new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), new THREE.MeshStandardMaterial({ color: "#fff8e1", emissive: "#fff0b3", emissiveIntensity: 0.4 }));
    clock.position.set(0, 10.8, 2.55);
    const winMat = new THREE.MeshStandardMaterial({ color: "#a8ddff", emissive: "#ffe9a8", emissiveIntensity: 0.0, roughness: 0.2 });
    this.school.userData.windowMat = winMat;
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      for (const y of [2.6, 5.8]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.8, 0.2), winMat);
        w.position.set(i * 2.8, y, 4.55);
        this.school.add(w);
      }
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), new THREE.MeshBasicMaterial({ map: sideTexture("SUNRISE SCHOOL", "#fff8e1", "#3d2c8d") }));
    sign.position.set(0, 6.7, 4.62);
    for (const o of [body, roof, door, tower, towerRoof]) o.castShadow = o.receiveShadow = true;
    this.school.add(body, roof, door, tower, towerRoof, clock, sign);
    this.school.position.copy(end).addScaledVector(t, 13);
    this.school.lookAt(this.school.position.clone().addScaledVector(t, -10));
    this.scene.add(this.school);
  }

  private buildClouds() {
    const rnd = mulberry32(99);
    const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, flatShading: true, transparent: true, opacity: 0.95 });
    for (let i = 0; i < 16; i++) {
      const g = new THREE.Group();
      const parts = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < parts; k++) {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(2 + rnd() * 2, 1), mat);
        s.position.set(k * 3 - parts * 1.5, rnd() * 1.2, rnd() * 2);
        s.scale.y = 0.6;
        g.add(s);
      }
      g.position.set((rnd() - 0.5) * 220, 26 + rnd() * 16, -rnd() * 200);
      this.scene.add(g);
      this.clouds.push(g);
    }
  }

  private buildStars() {
    const rnd = mulberry32(5);
    const arr: number[] = [];
    for (let i = 0; i < 500; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 150 + rnd() * 60;
      arr.push(Math.cos(a) * r, 40 + rnd() * 90, -95 + Math.sin(a) * r);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: "#ffffff", size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }));
    this.scene.add(pts);
    return pts;
  }

  // -------------------------------------------------------------------- bus

  private buildBus() {
    const yellow = new THREE.MeshStandardMaterial({ color: "#ffc21a", roughness: 0.38, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: "#1c1b2e", roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: "#7fb7e6", roughness: 0.08, metalness: 0.4, emissive: "#16324d", emissiveIntensity: 0.25 });

    // forward is +Z
    const body = new THREE.Mesh(new RoundedBoxGeometry(2.7, 2.1, 6.4, 5, 0.28), yellow);
    body.position.set(0, 1.75, -0.7);
    const hood = new THREE.Mesh(new RoundedBoxGeometry(2.5, 1.2, 1.9, 5, 0.22), yellow);
    hood.position.set(0, 1.25, 3.55);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.12, 6.45), dark);
    stripe.position.set(0, 1.3, -0.7);
    const stripe2 = stripe.clone();
    stripe2.position.y = 2.3;
    const bumper = new THREE.Mesh(new RoundedBoxGeometry(2.6, 0.32, 0.5, 3, 0.1), dark);
    bumper.position.set(0, 0.75, 4.5);
    const bumperB = bumper.clone();
    bumperB.position.z = -3.95;
    const roof = new THREE.Mesh(new RoundedBoxGeometry(2.5, 0.2, 6.1, 3, 0.08), new THREE.MeshStandardMaterial({ color: "#fff1b8", roughness: 0.5 }));
    roof.position.set(0, 2.88, -0.7);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.95, 0.08), glass);
    windshield.position.set(0, 2.2, 2.52);
    this.bus.add(body, hood, stripe, stripe2, bumper, bumperB, roof, windshield);

    for (let i = 0; i < 6; i++) {
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.78, 0.82), glass);
        w.position.set(s * 1.36, 2.2, -3.1 + i * 1.02);
        this.bus.add(w);
      }
    }
    for (const s of [-1, 1]) {
      const tex = sideTexture("SCHOOL BUS", "#ffc21a", "#1c1b2e");
      const label = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.5), new THREE.MeshBasicMaterial({ map: tex }));
      label.position.set(s * 1.37, 1.72, -0.7);
      label.rotation.y = s * Math.PI / 2;
      this.bus.add(label);
    }

    // front grille + headlights
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 0.08), dark);
    grille.position.set(0, 1.15, 4.52);
    this.bus.add(grille);
    this.headGlow = new THREE.MeshStandardMaterial({ color: "#fffbe6", emissive: "#fff0a8", emissiveIntensity: 0.2 });
    for (const s of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), this.headGlow);
      lamp.position.set(s * 0.95, 1.4, 4.48);
      this.bus.add(lamp);
      const spot = new THREE.SpotLight("#fff2c0", 0, 40, 0.45, 0.6, 1.2);
      spot.position.set(s * 0.95, 1.4, 4.4);
      spot.target.position.set(s * 0.95, 0.6, 18);
      this.bus.add(spot, spot.target);
      this.headlights.push(spot);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.08), new THREE.MeshStandardMaterial({ color: "#ff3b3b", emissive: "#ff1a1a", emissiveIntensity: 0.8 }));
      tail.position.set(s * 1.0, 1.35, -3.93);
      this.bus.add(tail);
      const warn = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 12), new THREE.MeshStandardMaterial({ color: "#ff9f1a", emissive: "#ff8a00", emissiveIntensity: 0.9 }));
      warn.position.set(s * 0.9, 2.95, 2.4);
      this.bus.add(warn);
    }

    // stop arm
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 8), new THREE.MeshStandardMaterial({ color: "#e63946", roughness: 0.5 }));
    arm.rotation.z = Math.PI / 2;
    arm.position.set(1.62, 2.0, 1.9);
    arm.rotation.y = 0;
    this.bus.add(arm);

    // wheels
    const wheelGeo = new THREE.CylinderGeometry(0.58, 0.58, 0.42, 20);
    wheelGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.44, 12);
    hubGeo.rotateZ(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({ color: "#c9ccd8", metalness: 0.7, roughness: 0.3 });
    for (const [x, z] of [
      [-1.2, 2.9],
      [1.2, 2.9],
      [-1.2, -2.5],
      [1.2, -2.5],
    ] as const) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.position.set(x, 0.58, z);
      const hub = new THREE.Mesh(hubGeo, hubMat);
      w.add(hub);
      const lug = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.5), hubMat);
      w.add(lug);
      this.bus.add(w);
      this.wheels.push(w);
    }

    this.bus.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.scene.add(this.bus);
  }

  // ------------------------------------------------------------------- loop

  private lerpMood(p: number) {
    let i = 0;
    while (i < MOODS.length - 2 && p > MOODS[i + 1]!.p) i++;
    const a = MOODS[i]!;
    const b = MOODS[i + 1]!;
    const t = smooth(THREE.MathUtils.clamp((p - a.p) / (b.p - a.p), 0, 1));
    return { a, b, t };
  }

  private applyMood(p: number) {
    const { a, b, t } = this.lerpMood(p);
    this.colA.set(a.sky).lerp(this.colB.set(b.sky), t);
    (this.scene.background as THREE.Color).copy(this.colA);
    (this.scene.fog as THREE.Fog).color.copy(this.colA);
    this.colA.set(a.ground).lerp(this.colB.set(b.ground), t);
    (this.ground.material as THREE.MeshStandardMaterial).color.copy(this.colA);
    this.hemi.groundColor.copy(this.colA);
    this.hemi.color.set(a.sky).lerp(this.colB.set(b.sky), t).lerp(this.colB.set("#ffffff"), 0.4);
    this.sun.color.set(a.sun).lerp(this.colB.set(b.sun), t);
    this.sun.intensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t);
    this.hemi.intensity = THREE.MathUtils.lerp(a.hemi, b.hemi, t);

    const night = smooth(THREE.MathUtils.clamp((p - 0.78) / 0.22, 0, 1));
    (this.stars.material as THREE.PointsMaterial).opacity = night * 0.9;
    for (const l of this.headlights) l.intensity = night * 260;
    this.headGlow.emissiveIntensity = 0.2 + night * 2.2;
    (this.school.userData.windowMat as THREE.MeshStandardMaterial).emissiveIntensity = night * 1.4;
  }

  private cameraRig(p: number, busPos: THREE.Vector3, tangent: THREE.Vector3, right: THREE.Vector3) {
    let i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1]!.p) i++;
    const a = KEYS[i]!;
    const b = KEYS[i + 1]!;
    const t = smooth(THREE.MathUtils.clamp((p - a.p) / (b.p - a.p), 0, 1));
    const L = (x: number, y: number) => x + (y - x) * t;
    // portrait screens: back the camera off so the bus fits the narrow frame
    const k = THREE.MathUtils.clamp(0.95 / this.camera.aspect, 1, 2.1);
    const pos = this.tmpA
      .copy(busPos)
      .addScaledVector(right, L(a.side, b.side) * k)
      .addScaledVector(tangent, L(a.ahead, b.ahead) * k);
    pos.y = L(a.up, b.up) * (1 + (k - 1) * 0.6);
    const look = this.tmpC
      .copy(busPos)
      .addScaledVector(right, L(a.lookSide, b.lookSide))
      .addScaledVector(tangent, L(a.lookAhead, b.lookAhead));
    look.y = L(a.lookUp, b.lookUp);
    pos.x += this.pointer.x * 0.9;
    pos.y += -this.pointer.y * 0.5;
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    const fov = L(a.fov, b.fov);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private tick = () => {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const time = this.clock.elapsedTime;
    this.p += (this.targetP - this.p) * (1 - Math.exp(-rawDt * (this.reducedMotion ? 30 : 5)));
    const p = this.p;

    const u = THREE.MathUtils.lerp(0.012, 0.965, p);
    const pos = this.curve.getPointAt(u);
    const tangent = this.curve.getTangentAt(u).setY(0).normalize();
    const right = this.tmpB.crossVectors(tangent, UP).normalize().clone();

    this.bus.position.copy(pos);
    this.bus.position.y = Math.sin(time * 9) * 0.012 + Math.sin(time * 3.1) * 0.01;
    this.bus.lookAt(pos.x + tangent.x, this.bus.position.y, pos.z + tangent.z);
    this.bus.rotateZ(Math.sin(time * 2.2) * 0.004);

    const travelled = (u - this.lastU) * this.curve.getLength();
    this.lastU = u;
    for (const w of this.wheels) w.rotation.x += travelled / 0.58;

    this.sun.position.set(pos.x - 26, 36, pos.z - 14);
    this.sun.target.position.copy(pos);
    this.sun.target.updateMatrixWorld();

    for (const s of this.stops) {
      const gone = u > s.u - 0.012;
      for (const [i, k] of s.kids.entries()) {
        const target = gone ? 0.001 : 1;
        const sc = k.scale.x + (target - k.scale.x) * (1 - Math.exp(-dt * (4 + i)));
        k.scale.setScalar(sc);
        k.position.y = 0.55 * sc + (gone ? 0 : Math.abs(Math.sin(time * 4 + i * 1.7)) * 0.08);
        k.visible = sc > 0.02;
      }
      const m = s.ring.material as THREE.MeshBasicMaterial;
      m.opacity = gone ? Math.max(0, m.opacity - dt) : 0.45 + Math.sin(time * 3) * 0.25;
      s.ring.scale.setScalar(1 + (Math.sin(time * 3) * 0.5 + 0.5) * 0.18);
    }

    for (const c of this.clouds) {
      c.position.x += dt * 0.8;
      if (c.position.x > 130) c.position.x = -130;
    }

    this.applyMood(p);
    this.cameraRig(p, pos, tangent, right);
    this.renderer.render(this.scene, this.camera);
  };
}
