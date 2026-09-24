/**
 * Frame timing and size of capture test clips (docs/capture-test-plan.md, section 4).
 * bun scripts/capture-stats.ts <video files...>
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const std = (a: number[]) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

for (const path of process.argv.slice(2)) {
  const file = Bun.file(path);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const times: number[] = [];
  let keys = 0;
  const sink = new EncodedPacketSink(track);
  for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) { times.push(p.timestamp); if (p.type === 'key') keys++; }
  times.sort((a, b) => a - b);
  const dt = times.slice(1).map((t, i) => (t - times[i]) * 1000);
  const dur = times.at(-1)! - times[0];
  const med = median(dt);
  // frames in each whole second, to see if the rate drops while the view turns
  const perS = Array.from({ length: Math.floor(dur) }, (_, s) => times.filter((t) => t - times[0] >= s && t - times[0] < s + 1).length);
  console.log(`\n${path.split(/[\\/]/).slice(-2).join('/')}`);
  console.log(`  ${await track.getCodec()} ${track.displayWidth}x${track.displayHeight}, ${times.length} frames in ${dur.toFixed(2)} s = ${((times.length - 1) / dur).toFixed(1)} fps, ${keys} keyframes`);
  console.log(`  interval ms: median ${med.toFixed(1)}, std ${std(dt).toFixed(1)}, min ${Math.min(...dt).toFixed(1)}, max ${Math.max(...dt).toFixed(1)}, >1.5x median: ${dt.filter((d) => d > 1.5 * med).length}`);
  console.log(`  ${(file.size * 8 / dur / 1e6).toFixed(1)} Mbit/s`);
  console.log(`  frames per second: ${perS.join(' ')}`);
}
