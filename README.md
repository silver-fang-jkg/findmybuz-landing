# FindMyBuz — landing page

Scroll-driven 3D landing page for the School Bus Tracking app.

- **Vite + TypeScript**
- **three.js** — procedural low-poly bus, road, town and school (no model files); the bus drives the route as you scroll, the sky runs dawn → day → sunset → night, and the camera moves between keyframes.
- **GSAP + ScrollTrigger** — headline reveal, section reveals, parallax, counters, tilt cards, magnetic buttons.
- **Lenis** — smooth scrolling.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build -> dist/
```

## Notes
- Falls back to a CSS gradient if WebGL is unavailable; respects `prefers-reduced-motion`.
- The 3D scene lives in `src/world.ts` (camera keyframes in `KEYS`, time-of-day in `MOODS`).
- To swap the procedural bus for a Meshy-generated model, export a `.glb` and load it with `GLTFLoader` in `buildBus()`; the scene expects the bus to face +Z.
- The "Talk to us" button points at a placeholder address (`hello@example.com`) — replace it in `index.html`.
