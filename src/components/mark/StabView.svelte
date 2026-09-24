<script lang="ts">
  /**
   * The stabilized view (automation plan section 5.4): the frame on screen warped into the reference camera of the
   * detection, with WebGL, so the world stands still and the shell moves as the solver sees it. Overlays: the shell
   * track of the section with the mark of this frame, the vertical lines of the pitch, and where the shell lands.
   */
  import { focalPx } from '../../lib/solver/camera.ts';
  import { toRef } from '../../lib/vision/rotation.ts';
  import { sameFrame } from '../../lib/video/frames.ts';
  import type { Section } from '../../lib/solver/types.ts';
  import { project } from '../../lib/state/project.svelte.ts';

  let { video, frame, time, section }: { video: HTMLVideoElement; frame: number; time: number; section: Section | undefined } = $props();

  let box = $state<HTMLDivElement>(), gl: WebGL2RenderingContext | null = null, prog: WebGLProgram | null = null, texture: WebGLTexture | null = null;
  let canvas = $state<HTMLCanvasElement>(), over = $state<HTMLCanvasElement>();
  let boxW = $state(0), boxH = $state(0);
  const size = $derived.by(() => {
    const w = video.videoWidth || 16, h = video.videoHeight || 9, s = Math.min(boxW / w, boxH / h) || 0;
    return { w: Math.floor(w * s), h: Math.floor(h * s) };
  });
  const K = $derived.by(() => {
    const w = video.videoWidth, h = video.videoHeight, st = project.settings;
    return { f: w ? focalPx(w, h, st.fovDeg, st.fovAxis) : 1, cx: w / 2 - 0.5, cy: h / 2 - 0.5 };
  });
  const R = $derived(section?.frames.find((f) => sameFrame(f.t, time))?.R ?? null);

  const VS = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = (p + 1.0) * 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
  // the reference pixel of this fragment, through H into the frame, and the video there
  const FS = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 color;
  uniform sampler2D video; uniform mat3 H; uniform vec2 size;
  void main() {
    vec3 q = H * vec3(uv * size, 1.0);
    vec2 s = q.xy / q.z / size;
    if (q.z <= 0.0 || s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) { color = vec4(0.08, 0.08, 0.08, 1.0); return; }
    color = texture(video, s);
  }`;

  function setup(c: HTMLCanvasElement) {
    gl = c.getContext('webgl2', { preserveDrawingBuffer: false });
    if (!gl) return;
    const sh = (type: number, src: string) => { const s = gl!.createShader(type)!; gl!.shaderSource(s, src); gl!.compileShader(s); return s; };
    prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return () => { gl = null; };
  }

  // each new picture: the warp, then the overlay in reference pixels
  $effect(() => {
    void frame;
    const w = video.videoWidth, h = video.videoHeight;
    if (!gl || !prog || !canvas || !over || !w || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [canvas, over]) { if (c.width !== Math.round(size.w * dpr)) { c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr); } }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(prog);
    if (video.readyState >= 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    // without a rotation for this frame, the frame as it is
    const Hm = R ? invert(toRef(K, R)) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'H'), false, [Hm[0], Hm[3], Hm[6], Hm[1], Hm[4], Hm[7], Hm[2], Hm[5], Hm[8]]);
    gl.uniform2f(gl.getUniformLocation(prog, 'size'), w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const g = over.getContext('2d')!, s = (size.w / w) * dpr;
    g.clearRect(0, 0, over.width, over.height);
    if (!section) return;
    g.lineWidth = 1.5 * dpr;
    g.strokeStyle = 'rgba(106, 159, 204, 0.8)';
    for (const [x1, y1, x2, y2] of section.lines) { g.beginPath(); g.moveTo(x1 * s, y1 * s); g.lineTo(x2 * s, y2 * s); g.stroke(); }
    g.strokeStyle = 'rgba(95, 212, 196, 0.9)';
    g.beginPath();
    section.marks.forEach((m, k) => (k ? g.lineTo(m.rx * s, m.ry * s) : g.moveTo(m.rx * s, m.ry * s)));
    g.stroke();
    for (const m of section.marks) {
      const here = sameFrame(m.t, time);
      g.fillStyle = here ? '#ffffff' : 'rgba(95, 212, 196, 0.9)';
      g.beginPath(); g.arc(m.rx * s, m.ry * s, (here ? 4 : 2.5) * dpr, 0, 7); g.fill();
    }
    const at = section.impact.at;
    if (at) {
      g.strokeStyle = '#e5484d'; g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(at.x * s, at.y * s, 10 * dpr, 0, 7); g.stroke();
    }
  });

  function invert(m: number[]): number[] {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
</script>

<div class="relative flex h-full w-full items-center justify-center bg-stage" bind:this={box} bind:clientWidth={boxW} bind:clientHeight={boxH} data-testid="stab-view">
  <div class="relative" style="width:{size.w}px; height:{size.h}px">
    <canvas bind:this={canvas} class="absolute inset-0 h-full w-full" {@attach setup}></canvas>
    <canvas bind:this={over} class="pointer-events-none absolute inset-0 h-full w-full"></canvas>
  </div>
  <span class="pointer-events-none absolute left-2 top-2 border border-line bg-panel px-1.5 text-[11px] text-muted">
    {#if !section}Stabilized: no detection for this shot yet{:else if !R}Stabilized: this frame has no rotation{:else}Stabilized to {section.ref.toFixed(3)} s{/if}
  </span>
</div>
