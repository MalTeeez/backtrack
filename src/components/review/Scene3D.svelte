<script lang="ts">
  /**
   * The 3D scene of Review (docs/review-plan.md, stage 6) draws with three.js and camera-controls. It shows the terrain
   * with the map tiles on it, and the sighting positions of the shot with their camera frustums (the current one shows
   * the video). It also shows the fitted flight with the shell positions and the sight lines, the impact and the gun.
   * The camera follows the point of action at the time of the player from an elevated oblique view. It pulls back to
   * the gun while the shell is in the high part of its flight. A move of the view detaches it, and "Follow again"
   * takes it back.
   *
   * The scene coordinates are x east, y up and z south (three.js), in meters from the crater, so the numbers stay small.
   */
  import * as THREE from 'three';
  import CameraControls from 'camera-controls';
  import { onMount } from 'svelte';
  import { ICONS } from '../../lib/icons.ts';
  import { cameraAxes } from '../../lib/solver/camera.ts';
  import { impactTime, value } from '../../lib/solver/field.ts';
  import { GAME_UNIT_M } from '../../lib/solver/sightings.ts';
  import { frameCameraAt } from '../../lib/state/sections.ts';
  import { currentShot, clipMap, project, ui } from '../../lib/state/project.svelte.ts';
  import { player, video } from '../../lib/state/player.svelte.ts';
  import { drawTiles, mapInfo } from '../../lib/map/tiles.svelte.ts';
  import { Terrain } from '../../lib/terrain/terrain.ts';
  import type { ProjectResult } from '../../lib/solver/result.ts';
  import type { MapId, Vec3 } from '../../lib/solver/types.ts';

  CameraControls.install({ THREE });
  let { result, time }: { result: ProjectResult | null; time: number } = $props();

  const shot = $derived(currentShot());
  const clipId = $derived(shot.clipId ?? ui.clipId);
  const r = $derived(result?.shots.find((x) => x.shotId === shot.id && x.fit && x.C) ?? null);
  const impactT = $derived.by(() => { const i = clipId ? value(shot.impact[clipId]) : undefined; return i ? impactTime(i) : null; });
  const sec = $derived(clipId ? project.clips[clipId]?.sections?.find((s) => s.shotId === shot.id) : undefined);

  let box: HTMLDivElement, canvas: HTMLCanvasElement;
  let following = $state(true);
  // the labels over the canvas, placed each frame
  let gunLabel = $state<{ x: number; y: number; inside: boolean; angle: number } | null>(null);
  let focusRing = $state<{ x: number; y: number } | null>(null);

  // the world meters of the solve to scene coordinates, around the crater
  const origin = () => r?.C ?? ([0, 0, 0] as Vec3);
  const S = (p: Vec3) => { const o = origin(); return new THREE.Vector3(p[0] - o[0], p[2] - o[2], -(p[1] - o[1])); };

  let renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, controls: CameraControls;
  const dynamic = new THREE.Group(), ground = new THREE.Group();
  let frustum: THREE.Group | null = null, frustumImage: THREE.Mesh | null = null;

  /**
   * The point of action at a time. It is the shell on the fitted flight, the crater after the impact, or the gun before
   * the launch.
   */
  function actionAt(t: number): { p: Vec3; phase: 'launch' | 'flight' | 'high' | 'impact' } | null {
    if (!r?.flight || impactT == null) return null;
    const tau = impactT - t, f = r.flight;
    if (tau <= 0) return { p: r.C!, phase: 'impact' };
    if (tau >= f[0].tau) return { p: f[0].P, phase: 'launch' };
    const k = f.findIndex((q) => q.tau <= tau), a = f[k - 1], b = f[k], u = (a.tau - tau) / (a.tau - b.tau);
    const p: Vec3 = [a.P[0] + (b.P[0] - a.P[0]) * u, a.P[1] + (b.P[1] - a.P[1]) * u, a.P[2] + (b.P[2] - a.P[2]) * u];
    // the high part of the flight lies farther from the crater than a quarter of the range
    const far = Math.hypot(p[0] - r.C![0], p[1] - r.C![1]) > (r.gun?.range ?? 0) / 4;
    return { p, phase: far ? 'high' : 'flight' };
  }

  /** The follow view at a time. It looks over the sighting positions and the impact, or pulls back to the gun. */
  function followView(t: number): { pos: THREE.Vector3; target: THREE.Vector3 } | null {
    if (!r) return null;
    const a = actionAt(t), obs = r.observers[0] ?? r.C!, crater = r.C!;
    const toGun = r.gun ? Math.atan2(r.gun.x - crater[0], r.gun.y - crater[1]) : 0;
    if (a?.phase === 'high' || a?.phase === 'launch') {
      // a side view of the whole arc, from the middle between crater and gun
      const mid = S([(crater[0] + r.gun!.x) / 2, (crater[1] + r.gun!.y) / 2, crater[2] + 150]), dist = (r.gun!.range || 1000) * 1.05;
      const side = toGun + Math.PI / 2;
      return { target: mid, pos: mid.clone().add(new THREE.Vector3(Math.sin(side) * dist * 0.9, dist * 0.45, -Math.cos(side) * dist * 0.9)) };
    }
    // the area of the sighting positions and the impact, looked at from behind the positions, raised by about 36 deg
    // the view keeps to the positions and the impact, and leans toward the shell as it comes close
    const focus = a ? S(a.p) : S(crater), ground0 = S(obs).lerp(S(crater), 0.5), near = ground0.distanceTo(focus);
    const target = ground0.clone().lerp(focus, near < 250 ? 0.35 : 0.1);
    const span = Math.max(70, S(obs).distanceTo(S(crater)) * 2.2, near < 250 ? near * 1.2 : 0);
    const yaw = toGun + Math.PI + 0.5; // behind the positions, turned a little so the arc shows its side
    const dist = span * 1.3;
    return { target, pos: target.clone().add(new THREE.Vector3(Math.sin(yaw) * dist * 0.8, dist * 0.6, -Math.cos(yaw) * dist * 0.8)) };
  }

  /**
   * Builds the objects that follow the solve: the flight, the shell positions, the sight lines, the sighting positions,
   * the crater and the gun.
   */
  function build() {
    dynamic.clear();
    frustum = frustumImage = null;
    if (!r) return;
    const line = (pts: Vec3[], color: number, opacity = 1, width = 1) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(S));
      const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, linewidth: width });
      dynamic.add(new THREE.Line(g, m));
    };
    if (r.flight) line(r.flight.map((q) => q.P), 0xe8704f);
    const ss = [...(r.sightings ?? [])].sort((a, b) => b.tau - a.tau);
    // the shell positions and the sighting positions as points of a fixed size on screen, and the sight lines
    const points = (ps: Vec3[], color: number, size: number) => {
      const g = new THREE.BufferGeometry().setFromPoints(ps.map(S));
      dynamic.add(new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false })));
    };
    points(ss.map((s) => s.P), 0xe1b06e, 7);
    for (const s of ss) line([s.O, s.P], 0x5db87a, 0.35);
    // the walk through the sighting positions
    const spots: Vec3[] = [];
    for (const s of ss) if (!spots.some((q) => Math.hypot(q[0] - s.O[0], q[1] - s.O[1]) < 1)) spots.push(s.O);
    if (spots.length > 1) line(spots, 0x6a9fcc, 1);
    points(spots, 0x6a9fcc, 9);
    // the crater is a ring on the ground
    const ring = new THREE.Mesh(new THREE.RingGeometry(3, 4, 32), new THREE.MeshBasicMaterial({ color: 0xe8993a, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(S(r.C!)).add(new THREE.Vector3(0, 0.3, 0));
    dynamic.add(ring);
    if (r.gun) {
      const gz = r.ground?.gun ?? r.C![2];
      const g = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe8704f }));
      g.position.copy(S([r.gun.x, r.gun.y, gz + 4]));
      dynamic.add(g);
    }
    // the frustum of the frame on screen, with its edges and the video on its far side
    frustum = new THREE.Group();
    const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xebe7e4 }));
    frustum.add(edges);
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    frustumImage = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
    frustum.add(frustumImage);
    dynamic.add(frustum);
  }

  /** Puts the frustum at the sighting position of the frame on screen, turned to its camera. */
  function placeFrustum(t: number) {
    if (!frustum || !frustumImage || !r?.sightings?.length || impactT == null) return;
    const near = [...r.sightings].sort((a, b) => Math.abs(impactT - a.tau - t) - Math.abs(impactT - b.tau - t))[0];
    const s = project.sightings.find((x) => x.id === near.id);
    const cam = sec ? frameCameraAt(sec, t) : null;
    const h = cam?.h.value ?? (s && value(s.heading)), p = cam?.p.value ?? (s && value(s.pitch)), rl = cam?.r.value ?? (s && value(s.roll)) ?? 0;
    if (h == null || p == null) { frustum.visible = false; return; }
    frustum.visible = true;
    const { R, U, F } = cameraAxes(h, p, rl), st = project.settings, aspect = video.videoWidth / Math.max(1, video.videoHeight) || 16 / 9;
    const tx = Math.tan(((st.fovAxis === 'h' ? st.fovDeg : st.fovDeg * aspect) * Math.PI) / 360), ty = tx / aspect, d = 6;
    const O = near.O, c = (a: number, b: number): Vec3 => [0, 1, 2].map((i) => O[i] + d * (F[i] + a * tx * R[i] + b * ty * U[i])) as Vec3;
    const cs = [c(-1, 1), c(1, 1), c(1, -1), c(-1, -1)].map(S), o = S(O);
    (frustum.children[0] as THREE.LineSegments).geometry.setFromPoints([o, cs[0], o, cs[1], o, cs[2], o, cs[3], cs[0], cs[1], cs[1], cs[2], cs[2], cs[3], cs[3], cs[0]]);
    const g = frustumImage.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(cs.flatMap((v) => [v.x, v.y, v.z]), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setIndex([0, 3, 1, 1, 3, 2]);
  }

  // the terrain around the scene, with the map tiles as its texture. It is fine near the positions and coarse out to the
  // gun.
  let terrains = new Map<MapId, Promise<Terrain | null>>(), groundKey = '';
  async function buildGround() {
    const map = clipMap(clipId);
    const key = `${map}:${r?.C?.map((v) => v.toFixed(0))}:${r?.gun?.x.toFixed(0)}:${r?.gun?.y.toFixed(0)}`;
    if (!r || key === groundKey) return;
    groundKey = key;
    ground.clear();
    const t = map ? await (terrains.get(map) ?? terrains.set(map, Terrain.open(new URL(`${import.meta.env.BASE_URL}local-data/terrain/${map}/`, location.origin).href)).get(map)!) : null;
    const info = map ? await mapInfo(map) : null;
    const C = r.C!, gun = r.gun ? [r.gun.x, r.gun.y] : [C[0], C[1]];
    const patch = async (cx: number, cy: number, half: number, step: number, lift: number) => {
      const n = Math.round((2 * half) / step) + 1;
      if (t) await t.preload((cx - half) / GAME_UNIT_M, (cy - half) / GAME_UNIT_M, (cx + half) / GAME_UNIT_M, (cy + half) / GAME_UNIT_M);
      const geo = new THREE.PlaneGeometry(2 * half, 2 * half, n - 1, n - 1);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute, o = origin();
      for (let i = 0; i < pos.count; i++) {
        const x = cx + pos.getX(i), y = cy - pos.getZ(i);
        const z = t?.heightNow(x / GAME_UNIT_M, y / GAME_UNIT_M) ?? C[2];
        pos.setXYZ(i, x - o[0], z - o[2] - lift, -(y - o[1]));
      }
      geo.computeVertexNormals();
      // the texture is a canvas with the tiles of the patch drawn on it
      const size = 2048, cnv = document.createElement('canvas');
      cnv.width = cnv.height = size;
      const g = cnv.getContext('2d')!;
      g.fillStyle = '#56644a'; g.fillRect(0, 0, size, size);
      const tex = new THREE.CanvasTexture(cnv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const draw = () => {
        if (!map || !info) return;
        const s = size / (2 * half * 1) * GAME_UNIT_M;
        drawTiles(g, map, info, { toPx: (gx, gy) => [(gx * GAME_UNIT_M - (cx - half)) * (size / (2 * half)), ((cy + half) - gy * GAME_UNIT_M) * (size / (2 * half))], pxPerUnit: s, width: size, height: size }, () => { draw(); tex.needsUpdate = true; dirty = true; }, 1);
        tex.needsUpdate = true;
      };
      draw();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
      ground.add(mesh);
    };
    const mid = [(C[0] + gun[0]) / 2, (C[1] + gun[1]) / 2], far = Math.max(600, Math.hypot(gun[0] - C[0], gun[1] - C[1]) / 2 + 500);
    await patch(mid[0], mid[1], far, 40, 1.5); // the coarse patch lies a little lower, so the fine one shows over it
    await patch(C[0], C[1], 300, 3, 0);
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);
    scene.fog = new THREE.Fog(0x0b0f14, 2500, 9000);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3f33, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(300, 500, 200);
    scene.add(sun, ground, dynamic);
    camera = new THREE.PerspectiveCamera(50, 1, 0.5, 20000);
    camera.position.set(100, 100, 100);
    controls = new CameraControls(camera, canvas);
    controls.smoothTime = 0.25;
    controls.draggingSmoothTime = 0.08;
    controls.dollyToCursor = true;
    // a move of the user detaches the view
    controls.addEventListener('controlstart', () => (following = false));
    const ro = new ResizeObserver(() => {
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    });
    ro.observe(box);
    const clock = new THREE.Clock();
    let raf = 0, last = 0;
    // The scene draws when the view moves or something in it changed. Once a second it draws anyway, for a map tile
    // that came in late.
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const moved = controls.update(clock.getDelta());
      if (!moved && !dirty && now - last < 1000) return;
      dirty = false;
      last = now;
      renderer.render(scene, camera);
      place();
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); };
  });

  /** Places the labels over the canvas: the gun (or an arrow at the edge toward it) and the point of action. */
  function place() {
    const W = box.clientWidth, H = box.clientHeight;
    const proj = (v: THREE.Vector3) => { const q = v.clone().project(camera); return { x: (q.x + 1) / 2 * W, y: (1 - q.y) / 2 * H, front: q.z < 1 }; };
    if (r?.gun) {
      const g = proj(S([r.gun.x, r.gun.y, (r.ground?.gun ?? r.C![2]) + 4]));
      const inside = g.front && g.x > 10 && g.x < W - 10 && g.y > 10 && g.y < H - 10;
      let x = g.x, y = g.y, angle = 0;
      if (!inside) {
        const dx = (g.front ? g.x : W - g.x) - W / 2, dy = (g.front ? g.y : H - g.y) - H / 2, k = Math.min((W / 2 - 28) / Math.abs(dx || 1e-6), (H / 2 - 20) / Math.abs(dy || 1e-6));
        x = W / 2 + dx * k; y = H / 2 + dy * k; angle = Math.atan2(dy, dx);
      }
      gunLabel = { x, y, inside, angle };
    } else gunLabel = null;
    const a = actionAt(time);
    const f = a && proj(S(a.p));
    focusRing = f && f.front ? { x: f.x, y: f.y } : null;
  }

  // the scene rebuilds when the solve changes. The view follows and the frustum turns when the time changes.
  // Whether the scene changed since it last drew (see the loop).
  let dirty = true;
  $effect(() => { void r; if (scene) { build(); buildGround(); placeFrustum(time); dirty = true; } });
  $effect(() => {
    const t = time;
    void player.frame;
    if (!controls) return;
    placeFrustum(t);
    dirty = true;
    if (following) { const v = followView(t); if (v) controls.setLookAt(v.pos.x, v.pos.y, v.pos.z, v.target.x, v.target.y, v.target.z, true); }
  });
  function followAgain() {
    following = true;
    const v = followView(time);
    if (v) controls.setLookAt(v.pos.x, v.pos.y, v.pos.z, v.target.x, v.target.y, v.target.z, true);
  }
  const phaseText = $derived.by(() => { const a = actionAt(time); return !a ? '' : a.phase === 'impact' ? 'the impact' : a.phase === 'launch' ? 'the launch' : 'the shell'; });
</script>

<div class="scene" bind:this={box} data-testid="scene">
  <canvas bind:this={canvas}></canvas>
  {#if !r}
    <p class="msg">The scene shows once the shot has a result.</p>
  {:else}
    {#if focusRing}<span class="ring" class:free={!following} style="left:{focusRing.x}px; top:{focusRing.y}px"></span>{/if}
    {#if gunLabel}
      {#if gunLabel.inside}<span class="gun" style="left:{gunLabel.x + 10}px; top:{gunLabel.y - 18}px">Gun, {r.gun?.range.toFixed(0)} m</span>
      {:else}
        <span class="arrow" style="left:{gunLabel.x}px; top:{gunLabel.y}px; rotate:{gunLabel.angle}rad"></span>
        <span class="gun" style="left:{Math.max(4, gunLabel.x - 50)}px; top:{gunLabel.y + (gunLabel.y > 40 ? -26 : 12)}px">Gun, {r.gun?.range.toFixed(0)} m</span>
      {/if}
    {/if}
    {#if following}<span class="state">Following {phaseText}, {time.toFixed(2)} s</span>
    {:else}<button class="btn sm follow" onclick={followAgain} data-testid="follow-again"><ICONS.locate size={12} /> Follow again</button>{/if}
  {/if}
</div>

<style>
  .scene { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0b0f14; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
  .msg { position: absolute; inset: 0; margin: 0; display: grid; place-items: center; color: #9fa4ab; font-size: 12px; }
  .ring { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border: 2px solid #fff; border-radius: 50%; pointer-events: none; }
  .ring.free { border-style: dashed; opacity: 0.7; }
  .gun { position: absolute; padding: 1px 6px; font-size: 11px; color: #ebe7e4; background: #000000b0; white-space: nowrap; pointer-events: none; }
  .arrow { position: absolute; width: 0; height: 0; margin: -7px 0 0 -6px; border-left: 14px solid #e8704f; border-top: 7px solid transparent; border-bottom: 7px solid transparent; transform-origin: 6px 7px; pointer-events: none; }
  .state { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; font-size: 11px; color: #ebe7e4; background: #000000b0; pointer-events: none; }
  .follow { position: absolute; right: 8px; top: 8px; }
</style>
