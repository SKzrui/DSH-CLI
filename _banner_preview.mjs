// _banner_preview.mjs — animated whale banner preview v3 (temporary, not wired in)
// Design: body+tail static; water = droplets marching along a curved arc
// (rise from the blowhole, bend right, fall back down) — like a little fountain.
// Run live:    node _banner_preview.mjs            (animated, in a real terminal)
// Inspect:     node _banner_preview.mjs --gallery  (static frames, for review)
const VERSION = "0.1.6";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLUE = (s) => `\x1b[34m${s}\x1b[39m`;

// 4 spout lines above the body. Path points [line(0=top), col(0-based)] trace a
// ROUND parabola: gentle launch from the blowhole, flattening to a wide crown
// (4 points on the top line), then a gentle descent — no sharp peak.
const PATH = [
  [3, 7], [3, 8], [2, 9], [2, 10], [1, 11], [1, 12], [1, 13],
  [0, 14], [0, 15], [0, 16], [0, 17],
  [1, 18], [1, 19], [2, 20], [2, 21], [3, 22], [3, 23],
];

// 6 droplets per frame, evenly spaced on the loop, marching 3 steps per frame
// → 17 distinct frames, the arc stays full and round the whole time.
const FRAMES = PATH.map((_, k) => {
  const grid = ["", "", "", ""];
  const idxs = [k, k + 3, k + 6, k + 9, k + 12, k + 15]
    .map((i) => i % PATH.length)
    .sort((a, b) => PATH[a][1] - PATH[b][1]);
  for (const i of idxs) {
    const [r, c] = PATH[i];
    grid[r] = grid[r].padEnd(c, " ") + "o";
  }
  return grid;
});

// Original whale body (tail untouched).
const BODY = [
  '   ___:____     |"\\/"|',
  " ,'        `.    \\  /",
  " |  O        \\___/  |",
  "~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~",
];

const LABEL = `  dcli v${VERSION} — DeepSeek agent in your terminal`;

function frame(spout) {
  return [...spout, ...BODY, "", LABEL]; // 4+4+1+1 = 10 lines
}

// One full loop of the arc plus a few extra frames, then settle on a round
// static splash (wide crown, no sharp point).
const TIMELINE = [...FRAMES, ...FRAMES.slice(0, 3)];
const SETTLED = [
  "        o o o",
  "      o       o",
  "    o           o",
  "  o               o",
];

if (process.argv.includes("--gallery")) {
  for (let k = 0; k < FRAMES.length; k++) {
    console.log(`--- frame ${k} ---`);
    for (const l of frame(FRAMES[k])) console.log(BLUE(l));
    console.log();
  }
  console.log("--- settled ---");
  for (const l of frame(SETTLED)) console.log(BLUE(l));
  process.exit(0);
}

process.stdout.write("\x1b[?25l"); // hide cursor during animation
for (let i = 0; i < TIMELINE.length; i++) {
  if (i > 0) process.stdout.write("\x1b[10A\r"); // back up 10 lines and rewrite
  process.stdout.write(frame(TIMELINE[i]).map((l) => BLUE(l)).join("\n") + "\n");
  await sleep(120);
}
process.stdout.write("\x1b[?25h"); // restore cursor
console.log(); // one blank line after the banner, like today
