import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { decodeStorageRecord } from "file:///C:/Users/KANYE/node_modules/@deepseek-ai/dsh-session/lib/index.js";

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

// Mirror of dsh-session-persistence-jsonl scanZstdFrames
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

const path = process.argv[2];
const buf = readFileSync(path);
console.log("compressed bytes:", buf.length);
const { frames, tornStart } = scanZstdFrames(buf);
console.log("frames:", frames.length, tornStart === undefined ? "" : `tornStart=${tornStart}`);

const parts = [];
for (const f of frames) {
  parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
}
const plain = Buffer.concat(parts);
console.log("decompressed bytes:", plain.length);
const text = plain.toString("utf8");
const lines = text.split("\n");
console.log("line count (incl. trailing empty):", lines.length);

let events = 0;
let issue = null;
const rows = [];
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (raw.length === 0) continue;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log(`line ${i + 1}: UNPARSABLE JSON`);
    continue;
  }
  let decoded;
  try {
    decoded = decodeStorageRecord(parsed);
  } catch (e) {
    console.log(`line ${i + 1}: decodeStorageRecord failed: ${e.message}`);
    continue;
  }
  let firstSeq = decoded[0]?.seq;
  let lastSeq = decoded[decoded.length - 1]?.seq;
  for (const ev of decoded) {
    if (ev.seq !== events) {
      if (issue === null) {
        issue = { line: i + 1, expected: events, got: ev.seq, rowFirstSeq: firstSeq, rowLastSeq: lastSeq, n: decoded.length, type: decoded[0]?.type };
      }
      continue;
    }
    events = ev.seq + 1;
  }
  if (i + 1 >= 21430 && i + 1 <= 21475) {
    rows.push({ line: i + 1, firstSeq, lastSeq, n: decoded.length, type: decoded[0]?.type });
  }
}

console.log("\n--- first seq issue (mirrors harness) ---");
console.log(JSON.stringify(issue, null, 2));

// find duplicate block boundaries by scanning for discontinuity then resumption
let prevLast = null;
let prevLine = 0;
let dupStart = null;
let dupEnd = null;
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (raw.length === 0) continue;
  let parsed, decoded;
  try { parsed = JSON.parse(raw); } catch { continue; }
  try { decoded = decodeStorageRecord(parsed); } catch { continue; }
  const first = decoded[0].seq;
  const last = decoded[decoded.length - 1].seq;
  if (prevLast !== null) {
    if (dupStart === null && first !== prevLast + 1) {
      dupStart = { line: i + 1, first, prevLast, prevLine };
    } else if (dupStart !== null && dupEnd === null && first === prevLast + 1) {
      dupEnd = { line: i + 1, first, prevLast, prevLine };
    }
  }
  prevLast = last;
  prevLine = i + 1;
}

console.log("\n--- duplicate block boundaries ---");
if (dupStart) console.log("block starts at line", dupStart.line, "seq", dupStart.first, "(prev line", dupStart.prevLine, "ended seq", dupStart.prevLast, ")");
if (dupEnd) console.log("contiguity resumes at line", dupEnd.line, "seq", dupEnd.first, "(prev line", dupEnd.prevLine, "ended seq", dupEnd.prevLast, ")");
else console.log("no resumption found — log ends inside the duplicated block");

console.log("\n--- rows around line 21449 ---");
console.log(JSON.stringify(rows, null, 1));

console.log("\n--- tail rows (last 15) ---");
const tail = [];
for (let i = lines.length - 1, c = 0; i >= 0 && c < 15; i--) {
  const raw = lines[i];
  if (raw.length === 0) continue;
  let decoded;
  try { decoded = decodeStorageRecord(JSON.parse(raw)); } catch { continue; }
  tail.unshift({ line: i + 1, first: decoded[0].seq, last: decoded[decoded.length - 1].seq, n: decoded.length, types: [...new Set(decoded.map((e) => e.type))].join(",") });
  c++;
}
console.log(JSON.stringify(tail, null, 1));

// event-type histogram over the whole file
const typeCount = new Map();
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (raw.length === 0) continue;
  try {
    const decoded = decodeStorageRecord(JSON.parse(raw));
    for (const e of decoded) typeCount.set(e.type, (typeCount.get(e.type) ?? 0) + 1);
  } catch {}
}
console.log("\n--- event-type histogram (decoded, all lines) ---");
console.log(JSON.stringify(Object.fromEntries([...typeCount.entries()].sort((a, b) => b[1] - a[1])), null, 1));

console.log("\nfinal events counter (valid prefix length):", events);
