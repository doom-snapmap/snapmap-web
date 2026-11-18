/* Content-addressed storage of the mod store: packs, unit archives and serving plans.
 *
 * A pack is an R2 object holding blobs (mods_registry_store.js). An uploaded unit archive is kept as
 * it is as a pack: each stored entry's bytes follow its ZIP local header, so a blob's bytes are a
 * range of the object. A blob uploaded in parts is a pack of one, with no header.
 *
 * GET /mods/unit/<hash>/archive answers a ZIP the store writes for the unit: unit.json (the
 * manifest's exact bytes) first, then every file the manifest lists at its path, stored, then the
 * central directory and end records (the product's modzip.c form, the one the upload check reads,
 * with ZIP64 records where a value needs them). The headers come from the manifest and the blobs'
 * sizes and CRC-32s; the files' bytes are pack ranges. A serving plan lists the archive in order as
 * [object, at, length] (pack bytes) and [null, at, length] (bytes of the written headers), and a GET
 * pipes the ranges it asks for to the response without the Worker touching the files' bytes. */

const M32 = 0xffffffff, M16 = 0xffff;
const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50, SIG_ZIP64_LOCATOR = 0x07064b50;

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* A new object's key: pack/<unit>/<random> (an uploaded archive), blob/<sha>/<random> (a blob in
 * parts), manifest/<unit>/<random> (a manifest over MANIFEST_INLINE). */
export function newObjectKey(kind, hash) {
  return kind + '/' + hash + '/' + randomHex(16);
}

/* ---------------- CRC-32 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n] >>> 8) ^ t[t[(k - 1) * 256 + n] & 0xff];
  return t;
})();

/* The running CRC-32 (IEEE, as ZIP has it) of bytes passed in order: crc = crc32(bytes, crc). Start
 * with 0; the result is an unsigned 32-bit number. Slicing by eight. */
export function crc32(bytes, crc = 0) {
  let c = ~crc;
  let i = 0;
  const n = bytes.length, t = CRC_TABLE;
  for (; i + 8 <= n; i += 8) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = t[1792 + (c & 0xff)] ^ t[1536 + ((c >>> 8) & 0xff)] ^ t[1280 + ((c >>> 16) & 0xff)] ^ t[1024 + (c >>> 24)] ^
      t[768 + bytes[i + 4]] ^ t[512 + bytes[i + 5]] ^ t[256 + bytes[i + 6]] ^ t[bytes[i + 7]];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/* ---------------- the unit archive ---------------- */

class Bytes {
  constructor() { this.parts = []; this.length = 0; }
  u8(v) { this.push(Uint8Array.of(v & 0xff)); }
  u16(v) { this.push(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff)); }
  u32(v) { this.push(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)); }
  u64(v) { this.u32(v % 0x100000000); this.u32(Math.floor(v / 0x100000000)); }
  push(bytes) { this.parts.push(bytes); this.length += bytes.byteLength; }
  bytes() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.byteLength; }
    return out;
  }
}

const NAME_ENCODER = new TextEncoder();

/* The archive of a unit: `manifest` (its exact bytes), `files` ([{ path, sha256, size }] in the
 * manifest's order) and `blobs` (sha -> { object, at, size, crc }: where each blob's bytes are).
 * Returns { size, plan, raw } or null when a blob has no location. Several files may hold one blob. */
export function unitArchive(manifest, files, blobs) {
  const raw = new Bytes();
  const plan = [];
  const push = (object, at, length) => {
    if (!length) return;
    const last = plan[plan.length - 1];
    if (last && last[0] === object && last[1] + last[2] === at) last[2] += length;
    else plan.push([object, at, length]);
  };
  const entries = [{ name: 'unit.json', size: manifest.byteLength, crc: crc32(manifest), inline: manifest }];
  for (const f of files) {
    const loc = blobs[f.sha256];
    if (!loc || loc.size !== f.size) return null;
    entries.push({ name: f.path, size: f.size, crc: loc.crc, loc });
  }
  let offset = 0;
  for (const e of entries) {
    const name = NAME_ENCODER.encode(e.name);
    const big = e.size >= M32;
    const h = new Bytes();
    h.u32(SIG_LOCAL); h.u16(big ? 45 : 20); h.u16(0); h.u16(0); h.u16(0); h.u16(0);
    h.u32(e.crc); h.u32(big ? M32 : e.size); h.u32(big ? M32 : e.size);
    h.u16(name.byteLength); h.u16(big ? 20 : 0);
    h.push(name);
    if (big) { h.u16(1); h.u16(16); h.u64(e.size); h.u64(e.size); }
    const header = h.bytes();
    e.offset = offset;
    e.nameBytes = name;
    const rawAt = raw.length;
    raw.push(header);
    push(null, rawAt, header.byteLength);
    if (e.inline) { const at = raw.length; raw.push(e.inline); push(null, at, e.inline.byteLength); }
    else push(e.loc.object, e.loc.at, e.size);
    offset += header.byteLength + e.size;
  }
  const cdOffset = offset;
  const cdStart = raw.length;
  for (const e of entries) {
    const mu = e.size >= M32, mo = e.offset >= M32;
    const extra = (mu ? 16 : 0) + (mo ? 8 : 0);
    const c = new Bytes();
    c.u32(SIG_CENTRAL); c.u16(mu || mo ? 45 : 20); c.u16(mu || mo ? 45 : 20); c.u16(0); c.u16(0); c.u16(0); c.u16(0);
    c.u32(e.crc); c.u32(mu ? M32 : e.size); c.u32(mu ? M32 : e.size);
    c.u16(e.nameBytes.byteLength); c.u16(extra ? extra + 4 : 0); c.u16(0); c.u16(0); c.u16(0); c.u32(0);
    c.u32(mo ? M32 : e.offset);
    c.push(e.nameBytes);
    if (extra) { c.u16(1); c.u16(extra); if (mu) { c.u64(e.size); c.u64(e.size); } if (mo) c.u64(e.offset); }
    raw.push(c.bytes());
  }
  const cdSize = raw.length - cdStart;
  const n = entries.length;
  const z64 = n >= M16 || cdSize >= M32 || cdOffset >= M32;
  const t = new Bytes();
  if (z64) {
    const at = cdOffset + cdSize;
    t.u32(SIG_ZIP64_END); t.u64(44); t.u16(45); t.u16(45); t.u32(0); t.u32(0); t.u64(n); t.u64(n); t.u64(cdSize); t.u64(cdOffset);
    t.u32(SIG_ZIP64_LOCATOR); t.u32(0); t.u64(at); t.u32(1);
  }
  t.u32(SIG_END); t.u16(0); t.u16(0);
  t.u16(n >= M16 ? M16 : n); t.u16(n >= M16 ? M16 : n);
  t.u32(cdSize >= M32 ? M32 : cdSize); t.u32(cdOffset >= M32 ? M32 : cdOffset); t.u16(0);
  raw.push(t.bytes());
  push(null, cdStart, raw.length - cdStart);
  const bytes = raw.bytes();
  return { size: plan.reduce((s, p) => s + p[2], 0), plan, raw: bytes };
}

/* ---------------- serving plans ---------------- */

/* Bytes [from, to) of a plan, as a stream of known length: written bytes from `raw`, pack ranges
 * piped (the runtime moves those bytes itself), reading `window` ranges ahead. onMissing(object) is
 * called, and the stream fails, when a pack is gone. */
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

/* Deletes objects the registry queued and forgets them; what fails stays queued. */
export async function deleteNow(env, reg, objects) {
  const keys = (objects || []).filter(Boolean);
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    await env.MODS.delete(batch);
    reg.forgetDead(batch);
  }
}

/* Empties the delete queue until the deadline. */
export async function drainDead(env, reg, deadline) {
  for (;;) {
    const dead = reg.deadObjects(1000);
    if (!dead.length || Date.now() > deadline) break;
    await deleteNow(env, reg, dead);
  }
}
