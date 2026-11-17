import "./style.css";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
$("#yr").textContent = String(new Date().getFullYear());

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

// ---- smooth scroll, wired into GSAP's ticker
const lenis = new Lenis({ lerp: reduced ? 1 : 0.09, smoothWheel: !reduced });
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((t) => lenis.raf(t * 1000));
gsap.ticker.lagSmoothing(0);

document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href")!;
    const target = id === "#top" ? 0 : document.querySelector<HTMLElement>(id);
    if (target === null) return;
    e.preventDefault();
    lenis.scrollTo(target as number | HTMLElement, { duration: 1.6 });
  });
});

// ---- 3D world (falls back to a plain gradient if WebGL is unavailable)
async function startWorld() {
  const canvas = $<HTMLCanvasElement>("#world");
  try {
    const { World } = await import("./world");
    const world = new World(canvas);
    if (import.meta.env.DEV) (window as unknown as { __world: unknown }).__world = world;
    ScrollTrigger.create({
      trigger: document.body,
      start: 0,
      end: "bottom bottom",
      onUpdate: (self) => world.setProgress(self.progress),
    });
  } catch (err) {
    console.warn("WebGL unavailable, using fallback background", err);
    canvas.remove();
    document.body.style.background = "linear-gradient(180deg,#ffd9bd,#bfe4ff 45%,#ffb98a 80%,#26245f)";
    document.body.style.backgroundAttachment = "fixed";
  }
}
void startWorld();

// ---- top progress bar
gsap.to(".progress i", { scaleX: 1, ease: "none", scrollTrigger: { trigger: document.body, start: 0, end: "bottom bottom", scrub: 0.3 } });

// ---- hero intro: split headline into masked words
const h1 = $<HTMLElement>("[data-split]");
const words = h1.textContent!.trim().split(/\s+/);
h1.innerHTML = words.map((w) => `<span class="w"><span>${w}</span></span>`).join(" ");
if (!reduced) {
  const intro = gsap.timeline({ defaults: { ease: "power4.out" }, delay: 0.25 });
  intro
    .from(".nav", { y: -60, opacity: 0, duration: 0.9 })
    .from("h1 .w > span", { yPercent: 115, rotate: 4, duration: 1.1, stagger: 0.07 }, "-=0.5")
    .from("[data-hero]", { y: 26, opacity: 0, duration: 0.9, stagger: 0.1 }, "-=0.8")
    .from(".scroll-cue", { opacity: 0, y: 14, duration: 0.8 }, "-=0.4");
}

// ---- generic scroll reveals
if (!reduced) {
  gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
    gsap.from(el, {
      y: 70,
      opacity: 0,
      scale: 0.97,
      duration: 1,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 88%", toggleActions: "play none none reverse" },
    });
  });
  gsap.from(".float", {
    y: 40,
    opacity: 0,
    stagger: 0.25,
    duration: 0.9,
    ease: "back.out(1.6)",
    scrollTrigger: { trigger: ".phone", start: "top 70%", toggleActions: "play none none reverse" },
  });
  gsap.to(".f1", { y: -18, duration: 2.4, yoyo: true, repeat: -1, ease: "sine.inOut" });
  gsap.to(".f2", { y: 16, duration: 2.9, yoyo: true, repeat: -1, ease: "sine.inOut" });
  gsap.to(".phone", {
    rotate: -3,
    ease: "none",
    scrollTrigger: { trigger: "#tracking", start: "top bottom", end: "bottom top", scrub: true },
  });
}

// ---- phone: the bus dot, ETA and bar follow the scroll through the tracking section
{
  const route = $<SVGPathElement>("#route");
  const dot = $<SVGGElement>("#busDot");
  const done = $<SVGPathElement>("#routeDone");
  const bar = $<HTMLElement>("#phBar");
  const eta = $<HTMLElement>("#eta");
  const left = $<HTMLElement>("#stopsLeft");
  const chip = $<HTMLElement>("#phChip");
  const len = route.getTotalLength();
  const set = (p: number) => {
    const pt = route.getPointAtLength(len * p);
    dot.setAttribute("transform", `translate(${pt.x} ${pt.y})`);
    done.style.strokeDashoffset = String(1 - p);
    bar.style.transform = `scaleX(${p})`;
    const mins = Math.max(0, Math.round(12 * (1 - p)));
    eta.textContent = mins === 0 ? "Now" : String(mins);
    const stops = p > 0.92 ? 0 : p > 0.62 ? 1 : p > 0.3 ? 2 : 3;
    left.textContent = stops === 0 ? "The bus is at your stop" : `${stops} stop${stops === 1 ? "" : "s"} to go`;
    chip.textContent = p > 0.92 ? "Arriving now" : p > 0.62 ? "Almost there" : "On the way";
    chip.className = "ph-chip " + (p > 0.92 ? "ph-chip-done" : p > 0.62 ? "ph-chip-warn" : "ph-chip-ok");
  };
  set(0);
  ScrollTrigger.create({
    trigger: "#tracking",
    start: "top 75%",
    end: "bottom 35%",
    onUpdate: (self) => set(self.progress),
  });
}

// ---- stat counters
document.querySelectorAll<HTMLElement>("[data-count]").forEach((el) => {
  const end = Number(el.dataset.count);
  const suffix = el.dataset.suffix ?? "";
  const o = { v: 0 };
  ScrollTrigger.create({
    trigger: el,
    start: "top 90%",
    once: true,
    onEnter: () =>
      gsap.to(o, {
        v: end,
        duration: reduced ? 0.01 : 1.6,
        ease: "power2.out",
        onUpdate: () => (el.textContent = Math.round(o.v) + suffix),
      }),
  });
});

// ---- card tilt + magnetic buttons (pointer devices only)
if (!reduced && window.matchMedia("(hover: hover)").matches) {
  document.querySelectorAll<HTMLElement>(".tilt").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      gsap.to(el, { rotateY: x * 9, rotateX: -y * 9, y: -6, transformPerspective: 900, duration: 0.4, ease: "power2.out" });
    });
    el.addEventListener("pointerleave", () => gsap.to(el, { rotateY: 0, rotateX: 0, y: 0, duration: 0.7, ease: "elastic.out(1,0.6)" }));
  });
  document.querySelectorAll<HTMLElement>(".magnetic").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      gsap.to(el, { x: (e.clientX - r.left - r.width / 2) * 0.3, y: (e.clientY - r.top - r.height / 2) * 0.4, duration: 0.3 });
    });
    el.addEventListener("pointerleave", () => gsap.to(el, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1,0.5)" }));
  });
}
