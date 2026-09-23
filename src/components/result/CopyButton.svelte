<script lang="ts">
  let { text }: { text: string } = $props();
  let done = $state(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    done = true;
    setTimeout(() => (done = false), 1500);
  }
</script>

<button class="btn sm" onclick={copy} title="Copy the coordinates" aria-label="Copy the coordinates">{done ? 'Copied' : 'Copy'}</button>
