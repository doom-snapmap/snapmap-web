/* Content-addressed storage of the mod store: skeletons, packs, serving plans and the packer.
 *
 * A build's archive is stored ZIP entries end to end, then its central directory and end
 * records (the product's modzip.c form, which the upload check enforces). Its skeleton keeps
 * the archive's own bytes that are not file contents (each entry's local header, then the
 * central directory and end records) and which blob (file contents, by SHA-256) each entry
 * holds. With the blobs, the skeleton gives back the uploaded archive byte for byte, so its
 * size, every CRC and every offset are the uploader's own.
 *
 * A pack is an R2 object holding blobs (pack/<32 hex>). The packer moves the blobs of a staged
 * build (checked and served from its archive) that the store does not hold yet into new packs,
 * about PACK_TARGET bytes each, reading the archive once in a few ranged reads, and then the
 * archive is deleted. Each blob is written with the ZIP local header it had in the archive that
 * brought it, so a build whose entries have those same headers (every later build of the same
 * mod, every part of it a map names) is served from a few long ranges of its packs; a build that
 * holds the same bytes under another name gets its own header from its skeleton around them.
 * A blob the store holds already is never stored again.
 *
 * A build's serving plan, made when it is packed, lists those ranges in order: [object, at,
 * length] for bytes of a pack, [null, at, length] for bytes of its skeleton. A GET pipes them
 * to the response without touching the bytes. */

export const PACK_TARGET = 16 * 1024 * 1024;
const GAP_MAX = 8 * 1024 * 1024;            // a gap of held blobs larger than this starts a new read
const SKELETON_MAGIC = 0x53504d53;          // "SMPS"
const SKELETON_VERSION = 1;

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexOf(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function newPackKey() {
  return 'pack/' + randomHex(16);
}

/* ---------------- skeletons ---------------- */

/* entries: [{ name, sha, size, at (the local header's offset), header (its bytes) }] in archive
 * order; tail: the bytes from the central directory to the end; leftOut: for part of a build,
 * the requests of the build it was cut from that it does not carry. */
export function encodeSkeleton(size, entries, tail, leftOut = null) {
  let raw = 0;
  const list = entries.map(e => {
    const row = [e.name, e.sha, e.size, e.at, e.header.byteLength, raw];
    raw += e.header.byteLength;
    return row;
  });
  const last = entries[entries.length - 1];
  const cdStart = last ? last.at + last.header.byteLength + last.size : 0;
  const doc = { v: SKELETON_VERSION, size, entries: list, tail: [cdStart, raw, tail.byteLength] };
  if (leftOut) doc.leftOut = leftOut;
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const out = new Uint8Array(12 + json.byteLength + raw + tail.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, SKELETON_MAGIC, true);
  view.setUint32(4, SKELETON_VERSION, true);
  view.setUint32(8, json.byteLength, true);
  out.set(json, 12);
  let at = 12 + json.byteLength;
  for (const e of entries) { out.set(e.header, at); at += e.header.byteLength; }
  out.set(tail, at);
  return out;
}

/* The skeleton's raw bytes (headers, then the tail) without reading its entries: what a GET needs. */
export function skeletonRaw(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SKELETON_MAGIC || view.getUint32(4, true) !== SKELETON_VERSION) return null;
  const length = view.getUint32(8, true);
  return 12 + length <= bytes.byteLength ? bytes.subarray(12 + length) : null;
}

/* { size, entries: [{ name, sha, size, at, headerLength, rawAt }], tail: { at, rawAt, length },
 * leftOut, raw } or null when the bytes are not a skeleton. */
export function decodeSkeleton(bytes) {
  const raw = skeletonRaw(bytes);
  if (!raw) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  let doc;
  try { doc = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))); } catch { return null; }
  const entries = doc.entries.map(([name, sha, size, at, headerLength, rawAt]) => ({ name, sha, size, at, headerLength, rawAt }));
  return { size: doc.size, entries, tail: { at: doc.tail[0], rawAt: doc.tail[1], length: doc.tail[2] }, leftOut: doc.leftOut || null, raw };
}

/* Skeletons are immutable under their key, so an isolate keeps a few, as bytes. */
const skeletonCache = new Map();

export async function readSkeletonBytes(env, key) {
  if (skeletonCache.has(key)) return skeletonCache.get(key);
  const obj = await env.MODS.get(key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (!skeletonRaw(bytes)) return null;
  if (skeletonCache.size >= 16) skeletonCache.delete(skeletonCache.keys().next().value);
  skeletonCache.set(key, bytes);
  return bytes;
}

export async function readSkeleton(env, key) {
  const bytes = await readSkeletonBytes(env, key);
  return bytes ? decodeSkeleton(bytes) : null;
}

/* ---------------- serving plans ---------------- */

/* The plan of a packed build: `where` maps sha -> { object, at (the stored header's offset in
 * the pack), hlen, hdr (that header, hex) }. Ranges that follow each other in one object are one
 * range. Returns { plan, size } or null when a blob has no location. */
export function planOf(skel, where) {
  const plan = [];
  const push = (object, at, length) => {
    if (!length) return;
    const last = plan[plan.length - 1];
    if (last && last[0] === object && last[1] + last[2] === at) last[2] += length;
    else plan.push([object, at, length]);
  };
  for (const e of skel.entries) {
    const loc = where.get(e.sha);
    if (!loc) return null;
    const own = skel.raw.subarray(e.rawAt, e.rawAt + e.headerLength);
    if (loc.hlen === e.headerLength && loc.hdr === hexOf(own)) push(loc.object, loc.at, loc.hlen + e.size);
    else { push(null, e.rawAt, e.headerLength); push(loc.object, loc.at + loc.hlen, e.size); }
  }
  push(null, skel.tail.rawAt, skel.tail.length);
  return { plan, size: plan.reduce((n, p) => n + p[2], 0) };
}

/* Bytes [from, to) of a packed build, as a stream of known length: skeleton bytes written, pack
 * ranges piped (the runtime moves those bytes itself), reading `window` ranges ahead.
 * onMissing(object) is called, and the stream fails, when a pack is gone. */
export function planStream(env, plan, raw, from, to, onMissing, window = 3) {
  const parts = [];
  let pos = 0;
  for (const [object, at, length] of plan) {
    const a = Math.max(from, pos), b = Math.min(to, pos + length);
    if (a < b) parts.push({ object, at: at + (a - pos), length: b - a });
    pos += length;
  }
  const { readable, writable } = new FixedLengthStream(to - from);
  const fetchPart = p => p.object === null ? Promise.resolve(raw.subarray(p.at, p.at + p.length))
    : env.MODS.get(p.object, { range: { offset: p.at, length: p.length } }).then(obj => obj || { missing: p.object });
  (async () => {
    const ahead = [];
    let next = 0;
    const fill = () => { while (ahead.length < window && next < parts.length) { const f = fetchPart(parts[next++]); f.catch(() => {}); ahead.push(f); } };
    try {
      fill();
      while (ahead.length) {
        const got = await ahead.shift();
        fill();
        if (got instanceof Uint8Array) {
          const w = writable.getWriter();
          await w.write(got);
          w.releaseLock();
        } else if (got.missing) {
          await onMissing(got.missing);
          throw new Error('a stored pack is missing');
        } else {
          await got.body.pipeTo(writable, { preventClose: true });
        }
      }
      await writable.close();
    } catch (error) {
      try { await writable.abort(error); } catch { /* The reader has gone. */ }
      for (const f of ahead) f.then(o => o && o.body && o.body.cancel().catch(() => {}), () => {});
    }
  })();
  return readable;
}

/* ---------------- the packer ---------------- */

/* Keeps only the byte ranges `keep` ([offset, length], sorted, relative to the stream's start). */
function keeper(keep) {
  let pos = 0, k = 0;
  return new TransformStream({
    transform(chunk, controller) {
      const end = pos + chunk.byteLength;
      while (k < keep.length && pos < end) {
        const [off, len] = keep[k];
        const a = Math.max(off, pos), b = Math.min(off + len, end);
        if (a < b) controller.enqueue(chunk.subarray(a - pos, b - pos));
        if (off + len <= end) k++;
        else break;
      }
      pos = end;
    },
  });
}

/* Groups the blobs to write ({ at, length }: where their header and bytes lie in the archive,
 * sorted) into packs: each one read of the archive, about PACK_TARGET bytes, a large blob alone,
 * a new read past a large gap of blobs the store holds already. */
export function planPacks(blobs) {
  const packs = [];
  let cur = null;
  for (const b of blobs) {
    const big = b.length >= PACK_TARGET;
    if (!cur || big || cur.bytes >= PACK_TARGET || b.at - cur.end > GAP_MAX) {
      cur = { blobs: [], bytes: 0, start: b.at, end: b.at };
      packs.push(cur);
    }
    cur.blobs.push(b);
    cur.bytes += b.length;
    cur.end = b.at + b.length;
    if (big) cur = null;
  }
  return packs;
}

/* Packs one staged build. reg is the registry (synchronous store functions bound to the
 * Durable Object's storage). Returns 'packed', 'gone' (replaced or dropped meanwhile) or
 * 'broken' (its archive or skeleton is missing). */
export async function packOne(env, reg, staged) {
  const skel = await readSkeleton(env, staged.skeleton);
  if (!skel) { reg.markBroken(staged.hash, staged.skeleton); return 'broken'; }
  const first = new Map();
  for (const e of skel.entries) {
    if (first.has(e.sha)) continue;
    first.set(e.sha, { sha: e.sha, size: e.size, hlen: e.headerLength, at: e.at, length: e.headerLength + e.size,
      hdr: hexOf(skel.raw.subarray(e.rawAt, e.rawAt + e.headerLength)) });
  }
  const reserved = reg.reserveBlobs(staged.id, staged.skeleton, [...first.keys()]);
  if (!reserved) return 'gone';
  const todo = reserved.needed.map(sha => first.get(sha)).sort((a, b) => a.at - b.at);
  const written = [];
  for (const plan of planPacks(todo)) {
    const obj = await env.MODS.get(staged.archive, { range: { offset: plan.start, length: plan.end - plan.start } });
    if (!obj) {
      await env.MODS.delete(written.map(p => p.object));
      reg.markBroken(staged.hash, staged.archive);
      return 'broken';
    }
    const key = newPackKey();
    let at = 0;
    const blobs = plan.blobs.map(b => { const row = { sha: b.sha, size: b.size, at, hlen: b.hlen, hdr: b.hdr }; at += b.length; return row; });
    /* The bytes it keeps, end to end; when they are the whole range read (no blob the store holds
     * lies between them) the runtime pipes them straight into the pack. */
    const body = at === plan.end - plan.start ? obj.body : obj.body.pipeThrough(keeper(plan.blobs.map(b => [b.at - plan.start, b.length])));
    await env.MODS.put(key, body.pipeThrough(new FixedLengthStream(at)), { httpMetadata: { contentType: 'application/octet-stream' } });
    written.push({ object: key, size: at, blobs });
  }
  const done = reg.commitPacks(staged.id, staged.skeleton, written, skel);
  await deleteNow(env, reg, done.discard);
  return done.packed ? 'packed' : 'gone';
}

/* A packed build whose blobs moved (a repair): its plan made again from its skeleton. */
export async function replanOne(env, reg, build) {
  const skel = await readSkeleton(env, build.skeleton);
  if (!skel) { reg.markBroken(build.hash, build.skeleton); return 'broken'; }
  reg.replan(build.id, build.skeleton, skel);
  return 'replanned';
}

/* Deletes objects the registry queued and forgets them; what fails stays queued. */
export async function deleteNow(env, reg, objects) {
  const keys = (objects || []).filter(Boolean);
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await env.MODS.delete(batch);
    reg.forgetDead(batch);
  }
}

/* Packs staged builds and plans repaired ones until none is left or the deadline passes, then
 * empties the delete queue. Returns { packed, left }. */
export async function packStaged(env, reg, deadline) {
  let packed = 0;
  for (;;) {
    if (Date.now() > deadline) break;
    const replan = reg.nextReplan();
    if (replan) { await replanOne(env, reg, replan); continue; }
    const staged = reg.nextStaged();
    if (!staged) break;
    if ((await packOne(env, reg, staged)) === 'packed') packed++;
  }
  for (;;) {
    const dead = reg.deadObjects(1000);
    if (!dead.length || Date.now() > deadline) break;
    await deleteNow(env, reg, dead);
  }
  return { packed, left: reg.stagedCount() };
}
