// PTY test: pasting multi-line text must become ONE message (not N sends).
const pty = (await import("file:///C:/Users/KANYE/node_modules/node-pty/lib/index.js")).default;
const key = process.env.DCLI_TEST_KEY ?? "";
const child = pty.spawn(
  process.execPath,
  ["E:/DSharness/bin/dcli.js"],
  {
    name: "xterm-256color", cols: 100, rows: 30, cwd: "E:/DSharness",
    env: { ...process.env, DSH_HOME: "E:/DSharness/.test-home", NO_COLOR: "1", DEEPSEEK_API_KEY: key },
  }
);
let out = "";
child.onData((d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (needle, ms) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (out.includes(needle)) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("timeout: " + needle)); }
    }, 100);
  });

try {
  await waitFor("❯", 25000);
  await sleep(400);
  const mark = out.length;
  const paste = "Count the lines in my message and reply with only the number:\nline one\nline two\nline three";
  child.write(paste);
  await sleep(800);
  child.write("\r"); // manual Enter
  await sleep(20000); // wait for a model turn to happen
  console.log("=== FULL OUTPUT AFTER PASTE+ENTER (marked) ===");
  console.log(JSON.stringify(out.slice(mark)));
  child.write("/quit\r");
  await sleep(500);
} catch (e) {
  console.log("ERROR:", e.message);
  try { child.kill(); } catch {}
}
process.exit(0);
