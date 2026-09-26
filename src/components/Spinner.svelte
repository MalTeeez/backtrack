<script lang="ts">
  /**
   * The "snake" spinner of loading.dev (MIT, Jakub Krehel, https://loading.dev/spinners/snake), ported from its React
   * source. It draws an arc that stretches and shrinks as it circles, in the text color.
   */
  let { size = 16 }: { size?: number } = $props();
</script>

<svg class="snake" style="--size:{size}px" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <g class="spin">
    <circle class="dash" cx="12" cy="12" r="10" stroke="currentColor" stroke-linecap="round" stroke-width="2.5" />
  </g>
</svg>

<style>
  .snake { width: var(--size); height: var(--size); flex: none; vertical-align: -0.15em; }
  .spin { transform-origin: center; animation: rotate 1400ms linear infinite; }
  .dash { animation: stretch 1400ms ease-in-out infinite; }
  @keyframes rotate { to { transform: rotate(360deg); } }
  @keyframes stretch {
    0% { stroke-dasharray: 1 100; stroke-dashoffset: 0; }
    50% { stroke-dasharray: 45 100; stroke-dashoffset: -17; }
    100% { stroke-dasharray: 45 100; stroke-dashoffset: -62; }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin { animation: none; }
    .dash { stroke-dasharray: 18 100; animation: none; }
  }
</style>
