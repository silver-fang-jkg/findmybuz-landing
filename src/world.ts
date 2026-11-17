import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

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
const STOP_US = [0.2, 0.43, 0.67];
/** The stop where a child visibly boards (the middle one). */
const BOARD_STOP = 1;
/** Bus stops this far before the stop sign, so its front door lines up with the kids. */
const STOP_LEAD = 0.0095;
const DOOR_Z = 1.55;
const DOOR_OUT = 1.3 + 0.4;

/** Camera keyframes; the door close-up sits in the middle of the boarding window. */
function buildKeys(pa: number, pb: number): Key[] {
  const mid = (pa + pb) / 2;
  const keys: Key[] = [
    { p: 0.0, side: 9.5, up: 3.3, ahead: 12.5, lookSide: 0, lookUp: 1.5, lookAhead: 0, fov: 34 },
    { p: Math.min(0.1, pa * 0.4), side: 8.5, up: 3.4, ahead: -11, lookSide: 0, lookUp: 1.6, lookAhead: 0, fov: 40 },
    { p: pa * 0.8, side: 13, up: 2.4, ahead: 1.5, lookSide: 0, lookUp: 1.5, lookAhead: 0, fov: 38 },
    // door close-up: camera ahead-right of the bus, looking at the sidewalk crowd and the door
    { p: mid, side: 9.2, up: 2.6, ahead: 7.5, lookSide: 2.6, lookUp: 1.2, lookAhead: 1.5, fov: 38 },
    { p: pb + (1 - pb) * 0.25, side: 3, up: 22, ahead: -8, lookSide: 0, lookUp: 0, lookAhead: 4, fov: 42 },
    { p: pb + (1 - pb) * 0.55, side: -7.5, up: 1.6, ahead: 11, lookSide: 0, lookUp: 1.7, lookAhead: -1, fov: 40 },
    { p: pb + (1 - pb) * 0.8, side: 11, up: 4.5, ahead: 12, lookSide: 0, lookUp: 2, lookAhead: 6, fov: 40 },
    { p: 1.0, side: 7, up: 8.5, ahead: -24, lookSide: 0, lookUp: 3.5, lookAhead: 9, fov: 44 },
  ];
  // keep p strictly increasing
  const out: Key[] = [];
  for (const k of keys) if (!out.length || k.p > out[out.length - 1]!.p + 0.015) out.push(k);
  return out;
}

interface Mood {
  p: number;
  sky: string;
  ground: string;
  sun: string;
  sunIntensity: number;
  hemi: number;
}
const MOODS: Mood[] = [
  { p: 0.0, sky: "#06322d", ground: "#0d4a40", sun: "#fff0a0", sunIntensity: 2.2, hemi: 0.85 },
  { p: 0.3, sky: "#0b4a41", ground: "#14614f", sun: "#fff6c2", sunIntensity: 2.8, hemi: 1.0 },
  { p: 0.62, sky: "#116356", ground: "#1b7660", sun: "#ffffff", sunIntensity: 3.0, hemi: 1.0 },
  { p: 0.82, sky: "#0a3a33", ground: "#124c42", sun: "#ffe066", sunIntensity: 2.4, hemi: 0.8 },
  { p: 1.0, sky: "#00110f", ground: "#06241f", sun: "#9cffe0", sunIntensity: 0.9, hemi: 0.45 },
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
  if (bg !== "transparent") {
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
  }
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
  private wavers: { pivot: THREE.Group; phase: number; lean: number }[] = [];
  private kids: { group: THREE.Group; phase: number }[] = [];
  private boarding = { pa: 0.38, pb: 0.46 };
  private keys: Key[] = buildKeys(0.38, 0.46);
  private houseWindowMat!: THREE.MeshStandardMaterial;
  private doorLeaves: { a: THREE.Group; b: THREE.Group } | null = null;
  private flashers: { mat: THREE.MeshStandardMaterial; phase: number }[] = [];
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

    // soft studio reflections so the bus paint and glass actually look glossy
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;

    this.scene.background = new THREE.Color("#06322d");
    this.scene.fog = new THREE.Fog("#06322d", 40, 150);

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

  private locked = false;

  /** Dev helper: freeze the scene at progress p, ignoring scroll. */
  jump(p: number) {
    this.locked = true;
    this.targetP = this.p = p;
  }

  /** Scroll range (0..1) during which the bus is parked at the middle stop and the kids board. */
  setBoarding(pa: number, pb: number) {
    if (!(pb > pa + 0.01)) return;
    this.boarding = { pa, pb };
    this.keys = buildKeys(pa, pb);
  }

  /** Scroll progress -> position along the route: the bus eases into the middle stop, waits, then pulls away. */
  private pToU(p: number) {
    const { pa, pb } = this.boarding;
    const u0 = 0.012;
    const u1 = 0.965;
    const us = STOP_US[BOARD_STOP]! - STOP_LEAD;
    if (p <= pa) return u0 + (us - u0) * (1 - Math.pow(1 - p / pa, 1.8));
    if (p <= pb) return us;
    const t = (p - pb) / (1 - pb);
    return us + (u1 - us) * (0.4 * t + 0.6 * smooth(t));
  }

  setProgress(p: number) {
    if (this.locked) return;
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
      new THREE.MeshStandardMaterial({ color: "#0d4a40", roughness: 1 }),
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
    this.ribbon(0, n, -ROAD_HALF - 1.6, ROAD_HALF + 1.6, 0.0, new THREE.MeshStandardMaterial({ color: "#7fa898", roughness: 1 }));
    this.ribbon(0, n, -ROAD_HALF, ROAD_HALF, 0.02, new THREE.MeshStandardMaterial({ color: "#0f1f21", roughness: 0.92 }));
    const white = new THREE.MeshStandardMaterial({ color: "#f5f5f0", roughness: 0.9 });
    this.ribbon(0, n, -ROAD_HALF + 0.3, -ROAD_HALF + 0.42, 0.03, white);
    this.ribbon(0, n, ROAD_HALF - 0.42, ROAD_HALF - 0.3, 0.03, white);
    const yellow = new THREE.MeshStandardMaterial({ color: "#ffe600", roughness: 0.8 });
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
    const palette = ["#f6efdc", "#e3f3ea", "#fff1a8", "#cfe8dc", "#fbf7ee", "#f1dfc2"].map((c) => new THREE.Color(c));
    const roofs = ["#0b4d41", "#e6c800", "#14705e", "#c9564a", "#2a2f3a", "#0b4d41"].map((c) => new THREE.Color(c));

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

    // front doors + two windows per house; the windows light up at night
    const doorMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: "#7a4a2b", roughness: 0.8 }), houses.length);
    this.houseWindowMat = new THREE.MeshStandardMaterial({ color: "#a9d8ee", emissive: "#ffe066", emissiveIntensity: 0, roughness: 0.25 });
    const winMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.houseWindowMat, houses.length * 2);
    const off = new THREE.Vector3();
    houses.forEach((h, i) => {
      e.set(0, h.ry, 0);
      q.setFromEuler(e);
      off.set(0, 0.62, h.d / 2 + 0.03).applyQuaternion(q);
      m.compose(new THREE.Vector3(h.x + off.x, off.y, h.z + off.z), q, new THREE.Vector3(0.7, 1.24, 0.08));
      doorMesh.setMatrixAt(i, m);
      for (const [k, side] of [-1, 1].entries()) {
        off.set(side * h.w * 0.3, h.h * 0.62, h.d / 2 + 0.03).applyQuaternion(q);
        m.compose(new THREE.Vector3(h.x + off.x, off.y, h.z + off.z), q, new THREE.Vector3(Math.min(0.9, h.w * 0.2), Math.min(0.9, h.h * 0.28), 0.08));
        winMesh.setMatrixAt(i * 2 + k, m);
      }
    });
    this.scene.add(doorMesh, winMesh);

    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 1, 6), new THREE.MeshStandardMaterial({ color: "#7a5230", roughness: 1 }), trees.length);
    const leaves = new THREE.InstancedMesh(new THREE.ConeGeometry(0.95, 2.2, 7), new THREE.MeshStandardMaterial({ roughness: 0.9 }), trees.length);
    const greens = ["#1f8a5b", "#27a06b", "#16784f", "#34b27a"].map((c) => new THREE.Color(c));
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
    for (const u of STOP_US) {
      const c = this.curve.getPointAt(u);
      const t = this.curve.getTangentAt(u);
      const r = new THREE.Vector3().crossVectors(t, UP).normalize();
      const base = c.clone().addScaledVector(r, ROAD_HALF + 2.3);

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.8, 8), new THREE.MeshStandardMaterial({ color: "#555a6e" }));
      pole.position.copy(base).setY(1.4);
      const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.08, 8), new THREE.MeshStandardMaterial({ color: "#ffe600", emissive: "#ffd400", emissiveIntensity: 0.3 }));
      sign.geometry.rotateX(Math.PI / 2);
      sign.rotation.y = Math.atan2(-t.x, -t.z);
      sign.position.copy(base).setY(2.7);
      pole.castShadow = sign.castShadow = true;

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.7, 40),
        new THREE.MeshBasicMaterial({ color: "#ffe600", transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(base).addScaledVector(r, -0.4).setY(0.05);
      this.beacons.push(ring);

      const kids: THREE.Mesh[] = [];
      const skins = ["#f6c7a1", "#e0a47a", "#c58c5f", "#8d5a3b", "#ffd9b0"];
      for (let k = 0; k < 6; k++) {
        const shirt = new THREE.MeshStandardMaterial({ color: kidColors[Math.floor(rnd() * kidColors.length)], roughness: 0.6 });
        const kid = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.62, 4, 10), shirt);
        const row = k % 2;
        kid.position
          .copy(base)
          .addScaledVector(t, (Math.floor(k / 2) - 1) * 0.85 + row * 0.3)
          .addScaledVector(r, -0.7 - row * 0.9 + rnd() * 0.3)
          .setY(0.55);
        kid.rotation.y = Math.atan2(-r.x, -r.z); // face the road
        kid.userData.faceY = kid.rotation.y;
        kid.userData.start = kid.position.clone();
        kid.castShadow = true;
        const skin = new THREE.MeshStandardMaterial({ color: skins[Math.floor(rnd() * skins.length)], roughness: 0.7 });
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), skin);
        head.position.y = 0.58;
        const pack = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.46, 0.18, 2, 0.05), new THREE.MeshStandardMaterial({ color: kidColors[(k + 2) % kidColors.length], roughness: 0.7 }));
        pack.position.set(0, 0.05, -0.27);
        kid.add(head, pack);
        // a waving arm for most of them
        if (k !== 3) {
          const pivot = new THREE.Group();
          pivot.position.set(0.27, 0.3, 0.02);
          const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.3, 4, 8), shirt);
          arm.position.y = 0.2;
          const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), skin);
          hand.position.y = 0.42;
          pivot.add(arm, hand);
          kid.add(pivot);
          this.wavers.push({ pivot, phase: rnd() * Math.PI * 2, lean: -0.45 });
        }
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
    const body = new THREE.Mesh(new RoundedBoxGeometry(22, 8, 9, 3, 0.25), mat("#f4ead2"));
    body.position.y = 4;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(23, 0.7, 10), mat("#0b4d41"));
    roof.position.y = 8.3;
    const door = new THREE.Mesh(new THREE.BoxGeometry(3.2, 4, 0.3), mat("#ffe600"));
    door.position.set(0, 2, 4.6);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), mat("#efe2c0"));
    tower.position.set(0, 10.5, 0);
    const towerRoof = new THREE.Mesh(new THREE.ConeGeometry(4, 3.2, 4), mat("#0b4d41"));
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
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1), new THREE.MeshBasicMaterial({ map: sideTexture("SCHOOL", "#ffe600", "#00211e") }));
    sign.position.set(0, 6.7, 4.62);
    // details: yellow trim band, entrance steps + portico, flagpole with a yellow flag
    const trim = new THREE.Mesh(new THREE.BoxGeometry(22.4, 0.3, 9.4), mat("#ffe600"));
    trim.position.y = 7.8;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(22.4, 0.6, 9.4), mat("#8b9a92"));
    plinth.position.y = 0.3;
    const steps = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 2.2), mat("#9aa8a0"));
    steps.position.set(0, 0.25, 5.4);
    const portico = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 2.6), mat("#0b4d41"));
    portico.position.set(0, 4.6, 5.2);
    for (const px of [-2.7, 2.7]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 4.4, 12), mat("#fff8e6"));
      pillar.position.set(px, 2.4, 6.3);
      pillar.castShadow = true;
      this.school.add(pillar);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 7, 8), mat("#cfd6d2"));
    pole.position.set(10.5, 3.5, 6.2);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1), new THREE.MeshStandardMaterial({ color: "#ffe600", side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(11.4, 6.4, 6.2);
    this.school.add(trim, plinth, steps, portico, pole, flag);
    for (const o of [body, roof, door, tower, towerRoof, portico]) o.castShadow = o.receiveShadow = true;
    this.school.add(body, roof, door, tower, towerRoof, clock, sign);
    this.school.position.copy(end).addScaledVector(t, 13);
    this.school.lookAt(this.school.position.clone().addScaledVector(t, -10));
    this.scene.add(this.school);
  }

  private buildClouds() {
    const rnd = mulberry32(99);
    const mat = new THREE.MeshStandardMaterial({ color: "#d8fff0", roughness: 1, flatShading: true, transparent: true, opacity: 0.5 });
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
    const W = 2.6; // body width (x)
    const yellowMat = new THREE.MeshPhysicalMaterial({ color: "#ffdc00", roughness: 0.32, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.12 });
    const black = new THREE.MeshStandardMaterial({ color: "#16161d", roughness: 0.55, metalness: 0.2 });
    const chrome = new THREE.MeshStandardMaterial({ color: "#d9dce6", roughness: 0.18, metalness: 1 });
    const rubber = new THREE.MeshStandardMaterial({ color: "#15151a", roughness: 0.95 });
    // see-through glass: the interior (seats, driver) shows through the windows and windshield
    const glass = new THREE.MeshPhysicalMaterial({
      color: "#a9c8e4",
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const seatMat = new THREE.MeshStandardMaterial({ color: "#8a5a34", roughness: 0.8 });
    const floorMat = new THREE.MeshStandardMaterial({ color: "#3a3a46", roughness: 0.9 });

    // --- hollow body: two thin side panels (with real window holes) + roof, rear wall, floor and hood.
    const WINDOW_Z = (i: number) => -3.25 + i * 0.98;
    const profile = (rightSide: boolean) => {
      const s = new THREE.Shape();
      s.moveTo(-4.0, 0.62);
      s.lineTo(-4.0, 2.85);
      s.quadraticCurveTo(-4.0, 3.2, -3.62, 3.2); // rounded rear-top corner
      s.lineTo(1.75, 3.2);
      s.quadraticCurveTo(2.05, 3.2, 2.12, 2.9); // windshield header
      s.lineTo(2.34, 2.0); // raked windshield
      s.quadraticCurveTo(2.38, 1.9, 2.55, 1.9);
      s.lineTo(4.05, 1.82); // hood
      s.quadraticCurveTo(4.38, 1.8, 4.4, 1.5);
      s.lineTo(4.4, 0.62);
      s.closePath();
      for (let i = 0; i < 6; i++) {
        if (rightSide && i === 5) continue; // the passenger door takes this bay
        const z = WINDOW_Z(i);
        const hole = new THREE.Path();
        hole.moveTo(z - 0.4, 2.0);
        hole.lineTo(z - 0.4, 2.86);
        hole.lineTo(z + 0.4, 2.86);
        hole.lineTo(z + 0.4, 2.0);
        hole.closePath();
        s.holes.push(hole);
      }
      if (rightSide) {
        // doorway: z 1.15..1.95, from just above the step to the window line
        const door = new THREE.Path();
        door.moveTo(DOOR_Z - 0.4, 0.95);
        door.lineTo(DOOR_Z - 0.4, 2.86);
        door.lineTo(DOOR_Z + 0.4, 2.86);
        door.lineTo(DOOR_Z + 0.4, 0.95);
        door.closePath();
        s.holes.push(door);
      }
      return s;
    };
    const extrudeOpts = { depth: 0.08, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3, curveSegments: 14 };
    const panelGeoLeft = new THREE.ExtrudeGeometry(profile(false), extrudeOpts);
    const panelGeoRight = new THREE.ExtrudeGeometry(profile(true), extrudeOpts);
    panelGeoLeft.rotateY(-Math.PI / 2); // shape x -> +z, extrude z -> -x
    panelGeoRight.rotateY(-Math.PI / 2);
    for (const sd of [-1, 1]) {
      const panel = new THREE.Mesh(sd === -1 ? panelGeoRight : panelGeoLeft, yellowMat);
      panel.position.x = sd === 1 ? W / 2 + 0.03 : -W / 2 + 0.11; // the extrusion runs toward -x
      this.bus.add(panel);
    }
    const roof = new THREE.Mesh(new RoundedBoxGeometry(W + 0.04, 0.16, 5.95, 3, 0.07), yellowMat);
    roof.position.set(0, 3.13, -1.1);
    const rear = new THREE.Mesh(new RoundedBoxGeometry(W, 2.5, 0.12, 3, 0.05), yellowMat);
    rear.position.set(0, 1.85, -3.96);
    const rearWin = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.6), black);
    rearWin.position.set(0, 2.5, -4.03);
    rearWin.rotation.y = Math.PI;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.08, 6.4), floorMat);
    floor.position.set(0, 0.82, -0.8);
    const hood = new THREE.Mesh(new RoundedBoxGeometry(W - 0.02, 1.3, 2.2, 4, 0.14), yellowMat);
    hood.position.set(0, 1.22, 3.3);
    const cowl = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 1.1, 0.4), yellowMat); // closes the gap under the windshield
    cowl.position.set(0, 1.4, 2.35);
    this.bus.add(roof, rear, rearWin, floor, hood, cowl);

    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.32, 8.6), black);
    chassis.position.set(0, 0.5, 0.2);
    this.bus.add(chassis);

    // --- side details (both sides)
    const lenMid = 6.3;
    for (const sd of [-1, 1]) {
      const x = sd * (W / 2 + 0.07);
      // black rub rails
      for (const y of [1.18, 1.36, 1.86]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, lenMid), black);
        rail.position.set(x, y, -0.85);
        this.bus.add(rail);
      }
      // window row: black frame around each hole + transparent glass
      for (let i = 0; i < 6; i++) {
        if (sd === -1 && i === 5) continue; // door bay
        const z = WINDOW_Z(i);
        for (const [fy, fh, fz, fw] of [
          [1.98, 0.05, z, 0.9],
          [2.88, 0.05, z, 0.9],
          [2.43, 0.92, z - 0.43, 0.05],
          [2.43, 0.92, z + 0.43, 0.05],
        ] as const) {
          const fr = new THREE.Mesh(new THREE.BoxGeometry(0.07, fh, fw), black);
          fr.position.set(x - sd * 0.02, fy, fz);
          this.bus.add(fr);
        }
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.86), glass);
        pane.rotation.y = sd * Math.PI / 2;
        pane.position.set(sd * (W / 2 + 0.02), 2.43, z);
        this.bus.add(pane);
        const split = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.8), black);
        split.position.set(x - sd * 0.02, 2.43, z);
        this.bus.add(split);
      }
      // wheel wells
      for (const wz of [2.95, -2.5]) {
        const well = new THREE.Mesh(new THREE.CircleGeometry(0.86, 28), black);
        well.rotation.y = sd * Math.PI / 2;
        well.position.set(sd * (W / 2 + 0.04), 0.66, wz);
        this.bus.add(well);
      }
      // mirrors
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.05), black);
      arm.position.set(sd * 1.5, 2.55, 2.45);
      const mirror = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.5, 0.28, 2, 0.04), black);
      mirror.position.set(sd * 1.68, 2.45, 2.45);
      this.bus.add(arm, mirror);
      // "SCHOOL BUS" lettering under the windows
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(4.6, 0.46),
        new THREE.MeshBasicMaterial({ map: sideTexture("SCHOOL BUS", "transparent", "#16161d"), transparent: true, polygonOffset: true, polygonOffsetFactor: -2 }),
      );
      label.position.set(sd * (W / 2 + 0.065), 1.68, -0.85);
      label.rotation.y = sd * Math.PI / 2;
      this.bus.add(label);
    }

    // passenger door (right side, -x): frame posts, header, glass and a step
    {
      const dx = -(W / 2 + 0.08);
      for (const dz of [-0.4, 0.4]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.95, 0.08), black);
        post.position.set(dx, 1.85, DOOR_Z + dz);
        this.bus.add(post);
      }
      const header = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.88), black);
      header.position.set(dx, 2.84, DOOR_Z);
      const step = new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.07, 0.8, 2, 0.03), black);
      step.position.set(dx - 0.14, 0.92, DOOR_Z);
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 8), chrome);
      rail.position.set(dx - 0.1, 1.6, DOOR_Z + 0.5);
      this.bus.add(header, step, rail);

      // two bi-fold leaves, hinged at the posts, that swing outward while the kids climb on
      const leaf = (hingeZ: number, dir: 1 | -1) => {
        const pivot = new THREE.Group();
        pivot.position.set(-W / 2 + 0.04, 0, hingeZ);
        const lower = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.8, 0.38), yellowMat);
        lower.position.set(0, 1.35, dir * 0.2);
        const top = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.4), black);
        top.position.set(0, 2.83, dir * 0.2);
        const mid = top.clone();
        mid.position.y = 1.78;
        const glassPane = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.98), glass);
        glassPane.rotation.y = -Math.PI / 2;
        glassPane.position.set(-0.03, 2.3, dir * 0.2);
        pivot.add(lower, top, mid, glassPane);
        for (const ez of [0.02, 0.38]) {
          const edge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.06, 0.04), black);
          edge.position.set(0, 2.3, dir * ez);
          pivot.add(edge);
        }
        pivot.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        this.bus.add(pivot);
        return pivot;
      };
      this.doorLeaves = { a: leaf(DOOR_Z - 0.4, 1), b: leaf(DOOR_Z + 0.4, -1) };
    }

    // stop-sign arm (driver side, +x)
    const arm = new THREE.Mesh(new THREE.CircleGeometry(0.34, 8), new THREE.MeshStandardMaterial({ color: "#d62828", roughness: 0.5 }));
    arm.rotation.y = Math.PI / 2;
    arm.position.set(W / 2 + 0.1, 1.72, 1.55);
    const armRim = new THREE.Mesh(new THREE.RingGeometry(0.27, 0.31, 8), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
    armRim.rotation.y = Math.PI / 2;
    armRim.position.set(W / 2 + 0.105, 1.72, 1.55);
    this.bus.add(arm, armRim);

    // --- windshield: an open raked glass pane (no body behind it) with pillars and a header
    const rake = -Math.atan2(2.34 - 2.12, 2.95 - 2.0); // the raked line leans back as it rises
    const glassLen = Math.hypot(2.95 - 2.0, 2.34 - 2.12);
    const wsMid = new THREE.Vector3(0, (2.95 + 2.0) / 2, (2.34 + 2.12) / 2 + 0.02);
    const windshieldGlass = glass.clone();
    windshieldGlass.opacity = 0.1;
    const windshield = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, glassLen), windshieldGlass);
    windshield.position.copy(wsMid);
    windshield.rotation.x = rake;
    this.bus.add(windshield);
    for (const sd of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.1, glassLen + 0.1, 0.1), yellowMat);
      pillar.position.set(sd * (W / 2 - 0.06), wsMid.y, wsMid.z);
      pillar.rotation.x = rake;
      this.bus.add(pillar);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(W - 0.1, 0.14, 0.18), yellowMat);
    header.position.set(0, 2.97, 2.12);
    this.bus.add(header);
    const dash = new THREE.Mesh(new RoundedBoxGeometry(W - 0.3, 0.3, 0.55, 2, 0.06), black);
    dash.position.set(0, 1.98, 2.0);
    this.bus.add(dash);

    // --- interior: seats + students + driver
    const kidRnd = mulberry32(314);
    const kidShirts = ["#ef476f", "#06d6a0", "#118ab2", "#ffd166", "#8338ec", "#fb5607", "#ffffff"];
    const kidSkins = ["#f6c7a1", "#e0a47a", "#c58c5f", "#8d5a3b", "#f1b98f"];
    const kidHair = ["#2b1b12", "#5a3a22", "#111111", "#c98f3d", "#7a2e1d"];
    for (let i = 0; i < 6; i++) {
      const z = WINDOW_Z(i);
      for (const sx of [-0.62, 0.62]) {
        const base = new THREE.Mesh(new RoundedBoxGeometry(0.92, 0.14, 0.52, 2, 0.04), seatMat);
        base.position.set(sx, 1.22, z - 0.05);
        const back = new THREE.Mesh(new RoundedBoxGeometry(0.92, 0.62, 0.1, 2, 0.04), seatMat);
        back.position.set(sx, 1.62, z - 0.34);
        this.bus.add(base, back);

        // students: up to two per bench, random shirts and hair, bobbing along with the ride
        for (const dx of [-0.23, 0.23]) {
          if (kidRnd() < 0.3) continue;
          const kid = new THREE.Group();
          const body = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.17, 0.28, 4, 10),
            new THREE.MeshStandardMaterial({ color: kidShirts[Math.floor(kidRnd() * kidShirts.length)], roughness: 0.7 }),
          );
          body.position.y = 1.88;
          const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 14), new THREE.MeshStandardMaterial({ color: kidSkins[Math.floor(kidRnd() * kidSkins.length)], roughness: 0.7 }));
          head.position.y = 2.28;
          const hair = new THREE.Mesh(
            new THREE.SphereGeometry(0.18, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
            new THREE.MeshStandardMaterial({ color: kidHair[Math.floor(kidRnd() * kidHair.length)], roughness: 0.9 }),
          );
          hair.position.y = 2.3;
          for (const ex of [-0.06, 0.06]) {
            const eye = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), black);
            eye.position.set(ex, 2.29, 0.15);
            kid.add(eye);
          }
          kid.add(body, head, hair);
          if (Math.sign(dx) === Math.sign(sx) && kidRnd() < 0.6) {
            const sgn = Math.sign(sx);
            const pivot = new THREE.Group();
            pivot.position.set(sgn * 0.19, 1.98, 0);
            const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.22, 4, 8), body.material);
            arm.position.y = 0.14;
            const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), head.material);
            hand.position.y = 0.3;
            pivot.add(arm, hand);
            kid.add(pivot);
            this.wavers.push({ pivot, phase: kidRnd() * Math.PI * 2, lean: -sgn * 0.35 });
          }
          kid.position.set(sx + dx, 0, z - 0.2);
          this.bus.add(kid);
          this.kids.push({ group: kid, phase: kidRnd() * Math.PI * 2 });
        }
      }
    }
    const driver = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: "#f1b98f", roughness: 0.7 });
    const shirt = new THREE.MeshStandardMaterial({ color: "#4f46e5", roughness: 0.7 });
    const cap = new THREE.MeshStandardMaterial({ color: "#1f2a44", roughness: 0.7 });
    const dSeat = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.14, 0.6, 2, 0.04), seatMat);
    dSeat.position.set(0, 1.25, 0);
    const dBack = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.7, 0.1, 2, 0.04), seatMat);
    dBack.position.set(0, 1.65, -0.32);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.42, 6, 14), shirt);
    torso.position.set(0, 1.72, -0.05);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 20), skin);
    head.position.set(0, 2.2, 0.0);
    const capTop = new THREE.Mesh(new THREE.SphereGeometry(0.235, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    capTop.position.set(0, 2.24, 0);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 20, 1, false, -Math.PI / 2, Math.PI), cap);
    brim.position.set(0, 2.25, 0.2);
    brim.scale.set(1, 1, 1.0);
    brim.rotation.y = Math.PI / 2;
    for (const ex of [-0.08, 0.08]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), black);
      eye.position.set(ex, 2.21, 0.2);
      driver.add(eye);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 6, 14, Math.PI), black);
    smile.position.set(0, 2.14, 0.205);
    smile.rotation.z = Math.PI;
    for (const ax of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.5, 4, 10), shirt);
      arm.position.set(ax * 0.27, 1.78, 0.28);
      arm.rotation.x = Math.PI / 2 - 0.35;
      driver.add(arm);
    }
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 8, 24), black);
    wheel.position.set(0, 1.85, 0.72);
    wheel.rotation.x = -1.0;
    driver.add(dSeat, dBack, torso, head, capTop, brim, smile, wheel);
    driver.scale.setScalar(1.25); // a little oversized so he reads from the hero shot
    driver.position.set(0.62, -0.31, 1.1); // driver sits on the left (+x when facing +z)
    this.bus.add(driver);

    // --- front end
    const grille = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.78, 0.1, 3, 0.05), black);
    grille.position.set(0, 1.1, 4.42);
    this.bus.add(grille);
    for (let i = 0; i < 5; i++) {
      const slat = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.03, 0.04), chrome);
      slat.position.set(0, 0.84 + i * 0.13, 4.49);
      this.bus.add(slat);
    }
    this.headGlow = new THREE.MeshStandardMaterial({ color: "#fffbe6", emissive: "#fff0a8", emissiveIntensity: 0.25, roughness: 0.2 });
    const bumperF = new THREE.Mesh(new RoundedBoxGeometry(2.7, 0.3, 0.42, 3, 0.1), black);
    bumperF.position.set(0, 0.74, 4.5);
    const bumperR = bumperF.clone();
    bumperR.position.z = -4.1;
    this.bus.add(bumperF, bumperR);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), new THREE.MeshBasicMaterial({ map: sideTexture("SB 2047", "#fffdf0", "#16161d") }));
    plate.position.set(0, 0.98, 4.5);
    plate.rotation.y = 0;
    plate.position.z = 4.43;
    this.bus.add(plate);

    for (const sd of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.04, 10, 24), chrome);
      rim.position.set(sd * 0.95, 1.38, 4.42);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 18), this.headGlow);
      lamp.scale.z = 0.4;
      lamp.position.set(sd * 0.95, 1.38, 4.42);
      this.bus.add(rim, lamp);
      const spot = new THREE.SpotLight("#fff2c0", 0, 40, 0.45, 0.6, 1.2);
      spot.position.set(sd * 0.95, 1.38, 4.4);
      spot.target.position.set(sd * 0.95, 0.4, 18);
      this.bus.add(spot, spot.target);
      this.headlights.push(spot);

      const signal = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.14, 0.08, 2, 0.03), new THREE.MeshStandardMaterial({ color: "#ff9f1a", emissive: "#ff8a00", emissiveIntensity: 0.5 }));
      signal.position.set(sd * 1.15, 1.1, 4.44);
      this.bus.add(signal);

      const tail = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.5, 0.08, 2, 0.03), new THREE.MeshStandardMaterial({ color: "#ff3030", emissive: "#ff1a1a", emissiveIntensity: 0.7 }));
      tail.position.set(sd * 1.05, 1.55, -4.16);
      this.bus.add(tail);

      // roof warning lights: amber outside, red inside, front and rear — they flash
      for (const [zz, inner, outer] of [[1.95, 0.62, 1.05], [-3.9, 0.62, 1.05]] as const) {
        for (const [xx, color] of [[sd * inner, "#ff2a2a"], [sd * outer, "#ffa31a"]] as const) {
          const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 });
          const light = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.07, 14), mat);
          light.rotation.x = Math.PI / 2;
          light.position.set(xx, 3.02, zz + (zz > 0 ? 0.06 : -0.06));
          this.bus.add(light);
          this.flashers.push({ mat, phase: color === "#ff2a2a" ? 0 : 1 });
        }
      }
    }

    // roof hatch + stripe
    const hatch = new THREE.Mesh(new RoundedBoxGeometry(0.8, 0.12, 0.8, 2, 0.04), yellowMat);
    hatch.position.set(0, 3.3, -1.4);
    this.bus.add(hatch);

    // --- wheels
    const tireGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.42, 28);
    tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.44, 20);
    rimGeo.rotateZ(Math.PI / 2);
    const capGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.46, 12);
    capGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [
      [-1.22, 2.95],
      [1.22, 2.95],
      [-1.22, -2.5],
      [1.22, -2.5],
    ] as const) {
      const w = new THREE.Mesh(tireGeo, rubber);
      w.position.set(x, 0.62, z);
      w.add(new THREE.Mesh(rimGeo, chrome), new THREE.Mesh(capGeo, black));
      for (let k = 0; k < 8; k++) {
        const lug = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), black);
        const a = (k / 8) * Math.PI * 2;
        lug.position.set(Math.sign(x) * 0.23, Math.cos(a) * 0.24, Math.sin(a) * 0.24);
        w.add(lug);
      }
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
    this.houseWindowMat.emissiveIntensity = night * 1.3;
  }

  private cameraRig(p: number, busPos: THREE.Vector3, tangent: THREE.Vector3, right: THREE.Vector3) {
    let i = 0;
    const KEYS = this.keys;
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

  /**
   * The middle stop's crowd boards one by one while the bus is parked. Driven purely by scroll progress,
   * so scrubbing back and forth plays it forwards and backwards.
   */
  private boardKids(s: Stop, p: number, busPos: THREE.Vector3, tangent: THREE.Vector3, right: THREE.Vector3, time: number) {
    const { pa, pb } = this.boarding;
    const span = pb - pa;
    const door = this.tmpC.copy(busPos).addScaledVector(right, DOOR_OUT).addScaledVector(tangent, DOOR_Z);
    // nearest to the door boards first
    const order = s.kids
      .map((k, i) => ({ i, d: (k.userData.start as THREE.Vector3).distanceToSquared(door) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.i);
    const dir = new THREE.Vector3();
    for (const [i, k] of s.kids.entries()) {
      const start = k.userData.start as THREE.Vector3;
      const slot = order.indexOf(i);
      const t0 = pa + span * (0.05 + slot * 0.11);
      const q = THREE.MathUtils.clamp((p - t0) / (span * 0.3), 0, 1);
      if (q >= 1) {
        k.visible = false;
        continue;
      }
      k.visible = true;
      const e = smooth(q);
      k.position.lerpVectors(start, door, e);
      const walking = q > 0 && q < 1;
      // a small hop per step while walking, idle bounce while waiting
      k.position.y = 0.55 + (walking ? Math.abs(Math.sin(q * Math.PI * 7)) * 0.12 : Math.abs(Math.sin(time * 4 + i * 1.7)) * 0.08);
      if (walking) {
        dir.subVectors(door, start);
        k.rotation.y = Math.atan2(dir.x, dir.z);
      } else {
        k.rotation.y = k.userData.faceY as number;
      }
      // step through the door: shrink away over the last stretch
      k.scale.setScalar(1 - smooth(THREE.MathUtils.clamp((q - 0.82) / 0.18, 0, 1)));
    }
    const m = s.ring.material as THREE.MeshBasicMaterial;
    m.opacity = p > pb ? Math.max(0, m.opacity - 0.05) : 0.45 + Math.sin(time * 3) * 0.25;
    s.ring.scale.setScalar(1 + (Math.sin(time * 3) * 0.5 + 0.5) * 0.18);
  }

  private tick = () => {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const time = this.clock.elapsedTime;
    this.p += (this.targetP - this.p) * (1 - Math.exp(-rawDt * (this.reducedMotion ? 30 : 5)));
    const p = this.p;

    const u = this.pToU(p);
    const pos = this.curve.getPointAt(u);
    const tangent = this.curve.getTangentAt(u).setY(0).normalize();
    const right = this.tmpB.crossVectors(tangent, UP).normalize().clone();

    this.bus.position.copy(pos);
    this.bus.position.y = Math.sin(time * 9) * 0.012 + Math.sin(time * 3.1) * 0.01;
    this.bus.lookAt(pos.x + tangent.x, this.bus.position.y, pos.z + tangent.z);
    this.bus.rotateZ(Math.sin(time * 2.2) * 0.004);

    const travelled = (u - this.lastU) * this.curve.getLength();
    this.lastU = u;
    for (const w of this.wheels) w.rotation.x += travelled / 0.62;

    this.sun.position.set(pos.x - 26, 36, pos.z - 14);
    this.sun.target.position.copy(pos);
    this.sun.target.updateMatrixWorld();

    if (this.doorLeaves) {
      const { pa, pb } = this.boarding;
      const span = pb - pa;
      const ramp = (a: number, b: number) => smooth(THREE.MathUtils.clamp((p - a) / (b - a), 0, 1));
      // open as the bus settles at the stop, stay open while the kids climb on, close before it pulls away
      const open = ramp(pa, pa + span * 0.07) * (1 - ramp(pa + span * 0.91, pb));
      this.doorLeaves.a.rotation.y = -open * Math.PI * 0.47;
      this.doorLeaves.b.rotation.y = open * Math.PI * 0.47;
    }
    for (const [si, s] of this.stops.entries()) {
      if (si === BOARD_STOP) {
        this.boardKids(s, p, pos, tangent, right, time);
        continue;
      }
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

    for (const w of this.wavers) w.pivot.rotation.z = w.lean + Math.sin(time * 8 + w.phase) * 0.4 * Math.sign(w.lean || 1) * -1;
    for (const k of this.kids) {
      k.group.position.y = Math.max(0, Math.sin(time * 5 + k.phase)) * 0.025;
      k.group.rotation.z = Math.sin(time * 1.7 + k.phase) * 0.05;
    }
    for (const f of this.flashers) f.mat.emissiveIntensity = (Math.floor(time * 2.4) % 2 === f.phase ? 1.8 : 0.15);
    this.applyMood(p);
    this.cameraRig(p, pos, tangent, right);
    this.renderer.render(this.scene, this.camera);
  };
}
