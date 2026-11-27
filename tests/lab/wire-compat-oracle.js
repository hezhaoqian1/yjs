import { createHash } from 'node:crypto'
import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as delta from 'lib0/delta'
import {
  assertInvariant,
  compareStructStores,
  deepEqualValues,
  equalBytes,
  InvariantError,
  verifyConvergence,
  verifyDocInvariants
} from './invariants.js'

/**
 * Compute hex SHA-256 digest of a byte buffer for exact cross-commit wire fingerprinting.
 *
 * @param {Uint8Array} buf
 * @return {string}
 */
const sha256Hex = buf => createHash('sha256').update(buf).digest('hex')

/**
 * @typedef {Record<string, string | number | boolean | null>} FormatRecord
 */

/** @type {Array<FormatRecord>} */
const ORACLE_FORMATS = [
  { bold: true },
  { bold: null },
  { italic: true },
  { italic: null },
  { color: '#c00' },
  { color: null }
]

/**
 * Assert byte-for-byte equivalence of incremental and full V1/V2 wire updates + StructStore
 * between two Docs running the exact same logical edits.
 *
 * @param {Y.Doc} docA
 * @param {Y.Doc} docB
 * @param {Array<Uint8Array<ArrayBuffer>>} v1A
 * @param {Array<Uint8Array<ArrayBuffer>>} v1B
 * @param {Array<Uint8Array<ArrayBuffer>>} v2A
 * @param {Array<Uint8Array<ArrayBuffer>>} v2B
 * @param {string} label
 */
const assertByteIdenticalDocs = (docA, docB, v1A, v1B, v2A, v2B, label) => {
  verifyDocInvariants(docA, { expectNoPending: true, label: `${label}:A` })
  verifyDocInvariants(docB, { expectNoPending: true, label: `${label}:B` })

  assertInvariant(
    v1A.length === v1B.length,
    `${label}: incremental V1 update count mismatch (${v1A.length} !== ${v1B.length})`
  )
  for (let i = 0; i < v1A.length; i++) {
    assertInvariant(
      equalBytes(v1A[i], v1B[i]),
      `${label}: incremental V1 update[${i}] byte mismatch (${v1A[i].byteLength}B vs ${v1B[i].byteLength}B)`
    )
  }

  assertInvariant(
    v2A.length === v2B.length,
    `${label}: incremental V2 update count mismatch (${v2A.length} !== ${v2B.length})`
  )
  for (let i = 0; i < v2A.length; i++) {
    assertInvariant(
      equalBytes(v2A[i], v2B[i]),
      `${label}: incremental V2 update[${i}] byte mismatch (${v2A[i].byteLength}B vs ${v2B[i].byteLength}B)`
    )
  }

  const svA = Y.encodeStateVector(docA)
  const svB = Y.encodeStateVector(docB)
  assertInvariant(equalBytes(svA, svB), `${label}: StateVector byte mismatch`)

  const fullV1A = Y.encodeStateAsUpdate(docA)
  const fullV1B = Y.encodeStateAsUpdate(docB)
  assertInvariant(
    equalBytes(fullV1A, fullV1B),
    `${label}: encodeStateAsUpdate (V1) byte mismatch (${fullV1A.byteLength}B vs ${fullV1B.byteLength}B)`
  )

  const fullV2A = Y.encodeStateAsUpdateV2(docA)
  const fullV2B = Y.encodeStateAsUpdateV2(docB)
  assertInvariant(
    equalBytes(fullV2A, fullV2B),
    `${label}: encodeStateAsUpdateV2 (V2) byte mismatch (${fullV2A.byteLength}B vs ${fullV2B.byteLength}B)`
  )

  compareStructStores(docA.store, docB.store, `${label}:A`, `${label}:B`)
}

/**
 * Suite 1: `_searchMarker` fast-path vs canonical linear scan (`_searchMarker = null`).
 * Proves that `_searchMarker`-accelerated random edits produce 100% byte-for-byte
 * identical V1 & V2 wire updates across plain text, rich formatted text, and multi-client sync.
 *
 * @param {number} seed
 * @param {Record<string, string>} digests
 */
const runSearchMarkerOracle = (seed, digests) => {
  const gen = prng.create(seed)
  const words = ['a', 'bc', 'def', 'ghij', 'klmno', ' ', '\n']

  // 1a. Plain text random-position insert/delete/push/unshift (both gc:true and gc:false)
  for (const gc of [true, false]) {
    const docFast = new Y.Doc({ gc })
    const docRef = new Y.Doc({ gc })
    docFast.clientID = 101
    docRef.clientID = 101
    const tFast = docFast.get('text')
    const tRef = docRef.get('text')
    tRef._searchMarker = null // Force pure canonical linear scan on reference doc

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Fast = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Ref = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Fast = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Ref = []
    docFast.on('update', u => v1Fast.push(u))
    docRef.on('update', u => v1Ref.push(u))
    docFast.on('updateV2', u => v2Fast.push(u))
    docRef.on('updateV2', u => v2Ref.push(u))

    try {
      const ops = 800
      for (let i = 0; i < ops; i++) {
        const curLen = tFast.length
        const roll = prng.uint32(gen, 0, 99)
        if (curLen > 0 && roll < 30) {
          const pos = prng.uint32(gen, 0, curLen - 1)
          const delLen = math.min(prng.uint32(gen, 1, 6), curLen - pos)
          tFast.delete(pos, delLen)
          tRef.delete(pos, delLen)
        } else if (roll < 42) {
          const s = prng.oneOf(gen, words)
          tFast.push(s)
          tRef.push(s)
        } else if (roll < 52) {
          const s = prng.oneOf(gen, words)
          tFast.unshift(s)
          tRef.unshift(s)
        } else {
          const pos = prng.uint32(gen, 0, curLen)
          const s = prng.oneOf(gen, words)
          tFast.insert(pos, s)
          tRef.insert(pos, s)
        }
        // Exercise random-access get/slice on docFast to populate & churn _searchMarker
        if (tFast.length > 1 && i % 7 === 0) {
          const idx = prng.uint32(gen, 0, tFast.length - 1)
          assertInvariant(tFast.get(idx) === tRef.get(idx), `1a(gc=${gc}) step ${i}: get(${idx}) mismatch`)
        }
        if (i % 200 === 199) {
          verifyDocInvariants(docFast, { expectNoPending: true, label: `1a(gc=${gc}):step${i}` })
        }
      }
      assertByteIdenticalDocs(docFast, docRef, v1Fast, v1Ref, v2Fast, v2Ref, `searchMarker-plain(gc=${gc})`)
      assertInvariant(tFast.toString() === tRef.toString(), `1a(gc=${gc}): toString mismatch`)
      if (gc) {
        digests.text_random_plain_v1 = sha256Hex(Y.encodeStateAsUpdate(docFast))
        digests.text_random_plain_v2 = sha256Hex(Y.encodeStateAsUpdateV2(docFast))
      }
    } finally {
      docFast.destroy()
      docRef.destroy()
    }
  }

  // 1b. Rich formatted text (insert with format, format range, delete, multi-op applyDelta, embeds)
  {
    const docFast = new Y.Doc({ gc: false })
    const docRef = new Y.Doc({ gc: false })
    docFast.clientID = 102
    docRef.clientID = 102
    const tFast = docFast.get('text')
    const tRef = docRef.get('text')
    tRef._searchMarker = null

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Fast = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Ref = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Fast = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Ref = []
    docFast.on('update', u => v1Fast.push(u))
    docRef.on('update', u => v1Ref.push(u))
    docFast.on('updateV2', u => v2Fast.push(u))
    docRef.on('updateV2', u => v2Ref.push(u))

    try {
      for (let i = 0; i < 400; i++) {
        const curLen = tFast.length
        const kind = prng.uint32(gen, 0, 4)
        if (curLen === 0 || kind === 0) {
          const pos = prng.uint32(gen, 0, curLen)
          const str = prng.oneOf(gen, words)
          const fmt = prng.bool(gen) ? prng.oneOf(gen, ORACLE_FORMATS) : undefined
          if (fmt !== undefined) {
            tFast.insert(pos, str, fmt)
            tRef.insert(pos, str, fmt)
          } else {
            tFast.insert(pos, str)
            tRef.insert(pos, str)
          }
        } else if (kind === 1) {
          const pos = prng.uint32(gen, 0, curLen - 1)
          const span = math.min(prng.uint32(gen, 1, 5), curLen - pos)
          const fmt = prng.oneOf(gen, ORACLE_FORMATS)
          tFast.format(pos, span, fmt)
          tRef.format(pos, span, fmt)
        } else if (kind === 2) {
          const pos = prng.uint32(gen, 0, curLen - 1)
          const span = math.min(prng.uint32(gen, 1, 4), curLen - pos)
          tFast.delete(pos, span)
          tRef.delete(pos, span)
        } else if (kind === 3) {
          const pos = prng.uint32(gen, 0, math.max(0, curLen - 1))
          const d = delta.create().retain(pos).insert(prng.oneOf(gen, words), { bold: true })
          if (pos < curLen) {
            d.retain(math.min(2, curLen - pos), { italic: true })
          }
          tFast.applyDelta(d)
          tRef.applyDelta(d)
        } else {
          const pos = prng.uint32(gen, 0, curLen)
          const d = delta.create(delta.$deltaAny).retain(pos).insert([{ widget: i }])
          tFast.applyDelta(d)
          tRef.applyDelta(d)
        }
        if (tFast.length > 1 && i % 5 === 0) {
          tFast.get(prng.uint32(gen, 0, tFast.length - 1))
        }
      }
      assertByteIdenticalDocs(docFast, docRef, v1Fast, v1Ref, v2Fast, v2Ref, 'searchMarker-formatted')
      assertInvariant(tFast.toDeltaDeep().equals(tRef.toDeltaDeep()), '1b: formatted toDeltaDeep mismatch')
      digests.text_random_formatted_v1 = sha256Hex(Y.encodeStateAsUpdate(docFast))
      digests.text_random_formatted_v2 = sha256Hex(Y.encodeStateAsUpdateV2(docFast))
    } finally {
      docFast.destroy()
      docRef.destroy()
    }
  }

  // 1c. Multi-client interleaved remote updates + local random edits (exercises remote marker invalidation)
  {
    const docFast = new Y.Doc({ gc: true })
    const docRef = new Y.Doc({ gc: true })
    const remote = new Y.Doc({ gc: true })
    docFast.clientID = 103
    docRef.clientID = 103
    remote.clientID = 203
    docRef.get('text')._searchMarker = null

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Fast = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Ref = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Fast = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Ref = []
    docFast.on('update', u => v1Fast.push(u))
    docRef.on('update', u => v1Ref.push(u))
    docFast.on('updateV2', u => v2Fast.push(u))
    docRef.on('updateV2', u => v2Ref.push(u))

    try {
      for (let i = 0; i < 300; i++) {
        if (i % 5 === 0) {
          // Remote client edits and pushes V1 or V2 update to both docFast and docRef
          const rt = remote.get('text')
          const pos = prng.uint32(gen, 0, rt.length)
          rt.insert(pos, prng.oneOf(gen, words))
          const sv = Y.encodeStateVector(docFast)
          if (prng.bool(gen)) {
            const u = Y.encodeStateAsUpdate(remote, sv)
            Y.applyUpdate(docFast, u)
            Y.applyUpdate(docRef, u)
          } else {
            const u2 = Y.encodeStateAsUpdateV2(remote, sv)
            Y.applyUpdateV2(docFast, u2)
            Y.applyUpdateV2(docRef, u2)
          }
        } else {
          const tf = docFast.get('text')
          const tr = docRef.get('text')
          const curLen = tf.length
          if (curLen > 0 && prng.uint32(gen, 0, 2) === 0) {
            const pos = prng.uint32(gen, 0, curLen - 1)
            const delLen = math.min(prng.uint32(gen, 1, 4), curLen - pos)
            tf.delete(pos, delLen)
            tr.delete(pos, delLen)
          } else {
            const pos = prng.uint32(gen, 0, curLen)
            const s = prng.oneOf(gen, words)
            tf.insert(pos, s)
            tr.insert(pos, s)
          }
          if (tf.length > 0) tf.get(prng.uint32(gen, 0, tf.length - 1))
          if (i % 15 === 0) {
            Y.applyUpdate(remote, Y.encodeStateAsUpdate(docFast, Y.encodeStateVector(remote)))
          }
        }
      }
      assertByteIdenticalDocs(docFast, docRef, v1Fast, v1Ref, v2Fast, v2Ref, 'searchMarker-multi-client')
    } finally {
      docFast.destroy()
      docRef.destroy()
      remote.destroy()
    }
  }
}

/**
 * Suite 2: Direct `YNode` API (`insert`, `delete`, `push`, `unshift`, `format`) vs canonical `applyDelta`.
 * Proves any fast-path that bypasses `delta.create()` inside `YNode` methods produces
 * 100% byte-identical V1 & V2 wire bytes, identical `YNode.delta` live cache, and identical
 * behavior when a custom `AttributionsRenderer` is attached.
 *
 * @param {number} seed
 * @param {Record<string, string>} digests
 */
const runDirectVsApplyDeltaOracle = (seed, digests) => {
  const gen = prng.create(seed + 1000)

  // 2a. Plain + formatted text & array direct methods vs canonical applyDelta
  {
    const docDirect = new Y.Doc({ gc: false })
    const docDelta = new Y.Doc({ gc: false })
    docDirect.clientID = 301
    docDelta.clientID = 301

    const tDirect = docDirect.get('text')
    const tDelta = docDelta.get('text')
    const aDirect = docDirect.get('array')
    const aDelta = docDelta.get('array')
    // Activate maintained live `.delta` caches on both docs to verify fingerprint-memo parity
    const tCacheDirect = tDirect.delta
    const tCacheDelta = tDelta.delta
    const aCacheDirect = aDirect.delta
    const aCacheDelta = aDelta.delta

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Delta = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Delta = []
    docDirect.on('update', u => v1Direct.push(u))
    docDelta.on('update', u => v1Delta.push(u))
    docDirect.on('updateV2', u => v2Direct.push(u))
    docDelta.on('updateV2', u => v2Delta.push(u))

    try {
      // Zero-length edge cases (must be identical no-ops)
      tDirect.insert(0, '')
      tDelta.applyDelta(delta.create().retain(0).insert('').done())
      tDirect.delete(0, 0)
      tDelta.applyDelta(delta.create().retain(0).delete(0).done())
      aDirect.insert(0, [])
      aDelta.applyDelta(delta.create(delta.$deltaAny).retain(0).insert([]).done())
      aDirect.delete(0, 0)
      aDelta.applyDelta(delta.create().retain(0).delete(0).done())

      for (let i = 0; i < 400; i++) {
        // Text step
        const tLen = tDirect.length
        const tOp = prng.uint32(gen, 0, 4)
        if (tLen === 0 || tOp === 0) {
          const pos = prng.uint32(gen, 0, tLen)
          const s = `s${i % 17}`
          tDirect.insert(pos, s)
          tDelta.applyDelta(delta.create().retain(pos).insert(s).done())
        } else if (tOp === 1) {
          const pos = prng.uint32(gen, 0, tLen)
          const s = `f${i % 9}`
          const fmt = prng.oneOf(gen, ORACLE_FORMATS)
          tDirect.insert(pos, s, fmt)
          tDelta.applyDelta(delta.create().retain(pos).insert(s, fmt).done())
        } else if (tOp === 2) {
          const pos = prng.uint32(gen, 0, tLen - 1)
          const span = math.min(prng.uint32(gen, 1, 4), tLen - pos)
          const fmt = prng.oneOf(gen, ORACLE_FORMATS)
          tDirect.format(pos, span, fmt)
          tDelta.applyDelta(delta.create().retain(pos).retain(span, fmt).done())
        } else if (tOp === 3) {
          const s = `p${i % 11}`
          tDirect.push(s)
          tDelta.applyDelta(delta.create().retain(tLen).insert(s).done())
        } else {
          const pos = prng.uint32(gen, 0, tLen - 1)
          const span = math.min(prng.uint32(gen, 1, 3), tLen - pos)
          tDirect.delete(pos, span)
          tDelta.applyDelta(delta.create().retain(pos).delete(span).done())
        }

        // Array step (primitives, objects, binary, nested Y.Node)
        const aLen = aDirect.length
        const aOp = prng.uint32(gen, 0, 3)
        if (aLen === 0 || aOp === 0) {
          const pos = prng.uint32(gen, 0, aLen)
          /** @type {Array<string | number | Uint8Array<ArrayBuffer> | Record<string, number>>} */
          const elems = i % 7 === 0
            ? [new Uint8Array([i & 255, (i + 1) & 255])]
            : i % 11 === 0
              ? [{ idx: i }]
              : [i, `v${i % 5}`]
          aDirect.insert(pos, elems)
          aDelta.applyDelta(delta.create(delta.$deltaAny).retain(pos).insert(elems).done())
        } else if (aOp === 1) {
          aDirect.push([i])
          aDelta.applyDelta(delta.create(delta.$deltaAny).retain(aLen).insert([i]).done())
        } else if (aOp === 2) {
          const pos = prng.uint32(gen, 0, aLen)
          const n1 = new Y.Node('item')
          const n2 = new Y.Node('item')
          aDirect.insert(pos, [n1])
          aDelta.applyDelta(delta.create(delta.$deltaAny).retain(pos).insert([n2]).done())
        } else {
          const pos = prng.uint32(gen, 0, aLen - 1)
          const span = math.min(prng.uint32(gen, 1, 2), aLen - pos)
          aDirect.delete(pos, span)
          aDelta.applyDelta(delta.create().retain(pos).delete(span).done())
        }
      }

      assertByteIdenticalDocs(docDirect, docDelta, v1Direct, v1Delta, v2Direct, v2Delta, 'direct-vs-applyDelta')
      digests.direct_vs_applyDelta_v1 = sha256Hex(Y.encodeStateAsUpdate(docDirect))
      digests.direct_vs_applyDelta_v2 = sha256Hex(Y.encodeStateAsUpdateV2(docDirect))
      assertInvariant(tCacheDirect.equals(tCacheDelta), '2a: text live .delta cache diverged')
      assertInvariant(tCacheDirect.equals(tDirect.toDeltaDeep()), '2a: text live .delta cache drifted from toDeltaDeep()')
      assertInvariant(aCacheDirect.equals(aCacheDelta), '2a: array live .delta cache diverged')
      assertInvariant(aCacheDirect.equals(aDirect.toDeltaDeep()), '2a: array live .delta cache drifted from toDeltaDeep()')
    } finally {
      docDirect.destroy()
      docDelta.destroy()
    }
  }

  // 2b. Custom AttributionsRenderer active: direct insert/delete must still match applyDelta byte-for-byte
  {
    const docDirect = new Y.Doc({ gc: false })
    const docDelta = new Y.Doc({ gc: false })
    docDirect.clientID = 302
    docDelta.clientID = 302
    docDirect.get('text').insert(0, 'abcdef')
    docDelta.get('text').insert(0, 'abcdef')
    docDirect.get('text').delete(2, 2) // delete 'cd'
    docDelta.get('text').delete(2, 2)

    const cidsDirect = Y.createContentIdsFromDoc(docDirect, true)
    const cidsDelta = Y.createContentIdsFromDoc(docDelta, true)
    const rendDirect = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: cidsDirect.inserts })
    const rendDelta = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: cidsDelta.inserts })
    docDirect.get('text').useRenderer(rendDirect)
    docDelta.get('text').useRenderer(rendDelta)

    try {
      // With restored deleted 'cd', visible length under renderer is 6 ('abcdef')
      docDirect.get('text').insert(3, 'Z')
      docDelta.get('text').applyDelta(delta.create().retain(3).insert('Z').done())
      docDirect.get('text').format(1, 2, { bold: true })
      docDelta.get('text').applyDelta(delta.create().retain(1).retain(2, { bold: true }).done())
      docDirect.get('text').delete(1, 2)
      docDelta.get('text').applyDelta(delta.create().retain(1).delete(2).done())

      assertInvariant(
        equalBytes(Y.encodeStateAsUpdate(docDirect), Y.encodeStateAsUpdate(docDelta)),
        '2b: custom renderer direct vs applyDelta V1 byte mismatch'
      )
      assertInvariant(
        equalBytes(Y.encodeStateAsUpdateV2(docDirect), Y.encodeStateAsUpdateV2(docDelta)),
        '2b: custom renderer direct vs applyDelta V2 byte mismatch'
      )
      compareStructStores(docDirect.store, docDelta.store, '2b:direct', '2b:delta')
    } finally {
      rendDirect.destroy()
      rendDelta.destroy()
      docDirect.destroy()
      docDelta.destroy()
    }
  }

  // 2c. Plain -> formatted transition (_hasFormatting: false -> true) on the same Y.Node
  {
    const docDirect = new Y.Doc({ gc: false })
    const docDelta = new Y.Doc({ gc: false })
    docDirect.clientID = 303
    docDelta.clientID = 303
    const tDirect = docDirect.get('text')
    const tDelta = docDelta.get('text')
    const liveDirect = tDirect.delta
    const liveDelta = tDelta.delta

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Delta = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Delta = []
    docDirect.on('update', u => v1Direct.push(u))
    docDelta.on('update', u => v1Delta.push(u))
    docDirect.on('updateV2', u => v2Direct.push(u))
    docDelta.on('updateV2', u => v2Delta.push(u))

    try {
      // Phase 1: strictly unformatted plain text edits
      for (let i = 0; i < 120; i++) {
        const len = tDirect.length
        if (len > 0 && i % 4 === 0) {
          const pos = prng.uint32(gen, 0, len - 1)
          const span = math.min(prng.uint32(gen, 1, 3), len - pos)
          tDirect.delete(pos, span)
          tDelta.applyDelta(delta.create().retain(pos).delete(span).done())
        } else if (i % 5 === 0) {
          const s = `u${i}`
          tDirect.unshift(s)
          tDelta.applyDelta(delta.create().insert(s).done())
        } else {
          const pos = prng.uint32(gen, 0, len)
          const s = `p${i % 13}`
          tDirect.insert(pos, s)
          tDelta.applyDelta(delta.create().retain(pos).insert(s).done())
        }
      }
      assertByteIdenticalDocs(docDirect, docDelta, v1Direct, v1Delta, v2Direct, v2Delta, '2c:pre-format')

      // Phase 2: introduce formatting mid-stream (transitions plain -> formatted)
      const mid = math.floor(tDirect.length / 2)
      tDirect.format(math.max(0, mid - 3), math.min(6, tDirect.length), { bold: true })
      tDelta.applyDelta(delta.create().retain(math.max(0, mid - 3)).retain(math.min(6, tDelta.length), { bold: true }).done())
      tDirect.insert(mid, 'BOLD', { italic: true })
      tDelta.applyDelta(delta.create().retain(mid).insert('BOLD', { italic: true }).done())

      // Phase 3: interleaved unformatted + formatted + delete edits after transition
      for (let i = 0; i < 120; i++) {
        const len = tDirect.length
        const op = prng.uint32(gen, 0, 3)
        if (len === 0 || op === 0) {
          const pos = prng.uint32(gen, 0, len)
          const s = `x${i % 7}`
          tDirect.insert(pos, s)
          tDelta.applyDelta(delta.create().retain(pos).insert(s).done())
        } else if (op === 1) {
          const pos = prng.uint32(gen, 0, len)
          const fmt = prng.oneOf(gen, ORACLE_FORMATS)
          tDirect.insert(pos, 'f', fmt)
          tDelta.applyDelta(delta.create().retain(pos).insert('f', fmt).done())
        } else if (op === 2) {
          const pos = prng.uint32(gen, 0, len - 1)
          const span = math.min(prng.uint32(gen, 1, 4), len - pos)
          const fmt = prng.oneOf(gen, ORACLE_FORMATS)
          tDirect.format(pos, span, fmt)
          tDelta.applyDelta(delta.create().retain(pos).retain(span, fmt).done())
        } else {
          const pos = prng.uint32(gen, 0, len - 1)
          const span = math.min(prng.uint32(gen, 1, 3), len - pos)
          tDirect.delete(pos, span)
          tDelta.applyDelta(delta.create().retain(pos).delete(span).done())
        }
      }
      assertByteIdenticalDocs(docDirect, docDelta, v1Direct, v1Delta, v2Direct, v2Delta, '2c:post-format')
      assertInvariant(liveDirect.equals(liveDelta), '2c: live .delta diverged across format transition')
      assertInvariant(liveDirect.equals(tDirect.toDeltaDeep()), '2c: live .delta drifted from toDeltaDeep()')
    } finally {
      docDirect.destroy()
      docDelta.destroy()
    }
  }

  // 2d. Preliminary (unintegrated) Y.Node direct methods vs applyDelta, then integration
  {
    const docDirect = new Y.Doc({ gc: false })
    const docDelta = new Y.Doc({ gc: false })
    docDirect.clientID = 304
    docDelta.clientID = 304

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Delta = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Delta = []
    docDirect.on('update', u => v1Direct.push(u))
    docDelta.on('update', u => v1Delta.push(u))
    docDirect.on('updateV2', u => v2Direct.push(u))
    docDelta.on('updateV2', u => v2Delta.push(u))

    try {
      const pTextDirect = new Y.Node('p')
      const pTextDelta = new Y.Node('p')
      // Unintegrated text edits (doc === null; avoid .push which reads unintegrated .length=0)
      pTextDirect.insert(0, 'world')
      pTextDelta.applyDelta(delta.create().insert('world').done())
      pTextDirect.unshift('hello ')
      pTextDelta.applyDelta(delta.create().insert('hello ').done())
      pTextDirect.insert(11, '!')
      pTextDelta.applyDelta(delta.create().retain(11).insert('!').done())
      pTextDirect.format(0, 5, { bold: true })
      pTextDelta.applyDelta(delta.create().retain(5, { bold: true }).done())
      pTextDirect.delete(5, 1)
      pTextDelta.applyDelta(delta.create().retain(5).delete(1).done())
      pTextDirect.setAttr('lang', 'en')
      pTextDelta.applyDelta(delta.create().setAttr('lang', 'en').done())
      pTextDirect.setAttr('tmp', 1)
      pTextDelta.applyDelta(delta.create().setAttr('tmp', 1).done())
      pTextDirect.deleteAttr('tmp')
      pTextDelta.applyDelta(delta.create().deleteAttr('tmp').done())

      // Unintegrated array edits (doc === null)
      const pArrDirect = new Y.Node()
      const pArrDelta = new Y.Node()
      pArrDirect.insert(0, [1, 2, 3])
      pArrDelta.applyDelta(delta.create(delta.$deltaAny).insert([1, 2, 3]).done())
      pArrDirect.insert(3, [4, 5])
      pArrDelta.applyDelta(delta.create(delta.$deltaAny).retain(3).insert([4, 5]).done())
      pArrDirect.delete(1, 2)
      pArrDelta.applyDelta(delta.create().retain(1).delete(2).done())

      // Integrate both preliminary nodes into their Docs and run post-integration edits
      docDirect.get('array').insert(0, [pTextDirect, pArrDirect])
      docDelta.get('array').applyDelta(delta.create(delta.$deltaAny).insert([pTextDelta, pArrDelta]).done())

      pTextDirect.insert(2, 'X')
      pTextDelta.applyDelta(delta.create().retain(2).insert('X').done())
      pArrDirect.push([99])
      pArrDelta.applyDelta(delta.create(delta.$deltaAny).retain(pArrDelta.length).insert([99]).done())

      assertByteIdenticalDocs(docDirect, docDelta, v1Direct, v1Delta, v2Direct, v2Delta, '2d:preliminary-node')
    } finally {
      docDirect.destroy()
      docDelta.destroy()
    }
  }

  // 2e. Deleted Y.Node (both invisible default renderer & restored under custom AttributionsRenderer)
  {
    const docDirect = new Y.Doc({ gc: false })
    const docDelta = new Y.Doc({ gc: false })
    docDirect.clientID = 305
    docDelta.clientID = 305

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Delta = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Delta = []
    docDirect.on('update', u => v1Direct.push(u))
    docDelta.on('update', u => v1Delta.push(u))
    docDirect.on('updateV2', u => v2Direct.push(u))
    docDelta.on('updateV2', u => v2Delta.push(u))

    const childDirect = new Y.Node('div')
    const childDelta = new Y.Node('div')
    docDirect.get('array').insert(0, [childDirect])
    docDelta.get('array').insert(0, [childDelta])
    childDirect.insert(0, 'hello')
    childDelta.insert(0, 'hello')
    childDirect.setAttr('k', 'v')
    childDelta.setAttr('k', 'v')

    // Delete both children from their parent arrays
    docDirect.get('array').delete(0, 1)
    docDelta.get('array').delete(0, 1)

    const cidsDirect = Y.createContentIdsFromDoc(docDirect, true)
    const cidsDelta = Y.createContentIdsFromDoc(docDelta, true)
    const rendDirect = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: cidsDirect.inserts })
    const rendDelta = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: cidsDelta.inserts })

    try {
      const v1CountBefore = v1Direct.length
      // Invisible deleted node (default renderer): must be exact no-ops
      childDirect.insert(0, 'nope')
      childDelta.applyDelta(delta.create().insert('nope').done())
      childDirect.delete(0, 2)
      childDelta.applyDelta(delta.create().delete(2).done())
      childDirect.format(0, 2, { bold: true })
      childDelta.applyDelta(delta.create().retain(2, { bold: true }).done())
      childDirect.push('!')
      childDelta.applyDelta(delta.create().retain(5).insert('!').done())
      childDirect.setAttr('k', 'mutated')
      childDelta.applyDelta(delta.create().setAttr('k', 'mutated').done())

      // Deleted but rendered node (restoring AttributionsRenderer): must NOT mutate doc either
      childDirect.useRenderer(rendDirect)
      childDelta.useRenderer(rendDelta)
      childDirect.insert(2, 'Z')
      childDelta.applyDelta(delta.create().retain(2).insert('Z').done())
      childDirect.delete(1, 2)
      childDelta.applyDelta(delta.create().retain(1).delete(2).done())
      childDirect.format(0, 3, { italic: true })
      childDelta.applyDelta(delta.create().retain(3, { italic: true }).done())

      assertInvariant(
        v1Direct.length === v1CountBefore && v1Delta.length === v1CountBefore,
        `2e: edits on deleted Y.Node unexpectedly emitted updates (direct=${v1Direct.length - v1CountBefore}, delta=${v1Delta.length - v1CountBefore})`
      )
      assertByteIdenticalDocs(docDirect, docDelta, v1Direct, v1Delta, v2Direct, v2Delta, '2e:deleted-node')
    } finally {
      rendDirect.destroy()
      rendDelta.destroy()
      docDirect.destroy()
      docDelta.destroy()
    }
  }

  // 2f. Subdocs (Y.Doc) inserted into arrays (direct insert/push vs applyDelta)
  {
    const docDirect = new Y.Doc({ gc: false })
    const docDelta = new Y.Doc({ gc: false })
    docDirect.clientID = 306
    docDelta.clientID = 306

    const sub1A = new Y.Doc({ guid: 'oracle-subdoc-1', meta: { tag: 'v14' }, autoLoad: false })
    const sub1B = new Y.Doc({ guid: 'oracle-subdoc-1', meta: { tag: 'v14' }, autoLoad: false })
    const sub2A = new Y.Doc({ guid: 'oracle-subdoc-2', gc: false, autoLoad: true })
    const sub2B = new Y.Doc({ guid: 'oracle-subdoc-2', gc: false, autoLoad: true })

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Delta = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Direct = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Delta = []
    docDirect.on('update', u => v1Direct.push(u))
    docDelta.on('update', u => v1Delta.push(u))
    docDirect.on('updateV2', u => v2Direct.push(u))
    docDelta.on('updateV2', u => v2Delta.push(u))

    try {
      const aDirect = docDirect.get('array')
      const aDelta = docDelta.get('array')
      aDirect.insert(0, [sub1A])
      aDelta.applyDelta(delta.create(delta.$deltaAny).retain(0).insert([sub1B]).done())
      aDirect.push([1, sub2A, 'tail'])
      aDelta.applyDelta(delta.create(delta.$deltaAny).retain(aDelta.length).insert([1, sub2B, 'tail']).done())
      aDirect.delete(0, 1)
      aDelta.applyDelta(delta.create().retain(0).delete(1).done())

      assertByteIdenticalDocs(docDirect, docDelta, v1Direct, v1Delta, v2Direct, v2Delta, '2f:subdocs-in-array')
    } finally {
      sub1A.destroy()
      sub1B.destroy()
      sub2A.destroy()
      sub2B.destroy()
      docDirect.destroy()
      docDelta.destroy()
    }
  }
}

/**
 * Suite 3: `ContentAny` / `ContentJSON` CoW `mergeWith` wire-equivalence & anti-aliasing oracle (PR #3b).
 *
 * @param {number} seed
 * @param {Record<string, string>} digests
 */
const runContentAnyCowOracle = (seed, digests) => {
  const gen = prng.create(seed + 2000)

  // 3a. Sequential push wire oracle (1,500 pushes vs reference doc & roundtrip)
  {
    const docPush = new Y.Doc({ gc: false })
    const docRef = new Y.Doc({ gc: false })
    docPush.clientID = 401
    docRef.clientID = 401
    const aPush = docPush.get('array')
    const aRef = docRef.get('array')
    const liveDelta = aPush.delta

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Push = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v1Ref = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Push = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const v2Ref = []
    docPush.on('update', u => v1Push.push(u))
    docRef.on('update', u => v1Ref.push(u))
    docPush.on('updateV2', u => v2Push.push(u))
    docRef.on('updateV2', u => v2Ref.push(u))

    try {
      const n = 1500
      for (let i = 0; i < n; i++) {
        const val = i % 5 === 0
          ? { k: i }
          : i % 7 === 0
            ? [i, i + 1]
            : i % 11 === 0
              ? null
              : i
        aPush.push([val])
        aRef.applyDelta(delta.create(delta.$deltaAny).retain(aRef.length).insert([val]).done())
      }
      assertByteIdenticalDocs(docPush, docRef, v1Push, v1Ref, v2Push, v2Ref, 'contentAny-seq-push')
      digests.array_seq_push_v1 = sha256Hex(Y.encodeStateAsUpdate(docPush))
      digests.array_seq_push_v2 = sha256Hex(Y.encodeStateAsUpdateV2(docPush))
      assertInvariant(aPush.length === n, `3a: expected length ${n}, got ${aPush.length}`)
      assertInvariant(liveDelta.equals(aPush.toDeltaDeep()), '3a: live .delta cache drifted after 1500 seq pushes')
    } finally {
      docPush.destroy()
      docRef.destroy()
    }
  }

  // 3b. Copy-then-merge anti-aliasing check (catches unsafe in-place push after ContentAny.copy())
  {
    const doc = new Y.Doc({ gc: false })
    doc.clientID = 402
    const arr = doc.get('array')
    try {
      arr.push([1, 2])
      const item = arr._start
      if (item === null) throw new InvariantError('3b: expected start item')
      const copied = item.content.copy()
      const copiedSnapshot = JSON.stringify(copied.getContent())
      // Subsequent sequential pushes trigger Item.mergeWith -> ContentAny.mergeWith
      arr.push([3])
      arr.push([4, 5])
      const copiedAfter = JSON.stringify(copied.getContent())
      assertInvariant(
        copiedAfter === copiedSnapshot,
        `3b: ContentAny.mergeWith mutated aliased copy() array! before=${copiedSnapshot}, after=${copiedAfter}`
      )
      const arrCmp = deepEqualValues(arr.toArray(), [1, 2, 3, 4, 5], '3b.toArray')
      assertInvariant(arrCmp.equal, `3b: array mismatch (${arrCmp.reason})`)
      verifyDocInvariants(doc, { expectNoPending: true, label: '3b:copy-then-merge' })
    } finally {
      doc.destroy()
    }
  }

  // 3c. Splice-then-merge anti-aliasing check
  {
    const doc = new Y.Doc({ gc: false })
    doc.clientID = 403
    const arr = doc.get('array')
    try {
      arr.push([10, 20, 30, 40])
      const item = arr._start
      if (item === null) throw new InvariantError('3c: expected start item')
      const copied = item.content.copy()
      const snapBefore = JSON.stringify(copied.getContent())
      arr.delete(1, 1) // splits [10,20,30,40] via splice
      arr.push([50]) // merges [50] into trailing [30,40]
      assertInvariant(
        JSON.stringify(copied.getContent()) === snapBefore,
        `3c: splice+mergeWith mutated aliased copy() (${JSON.stringify(copied.getContent())} !== ${snapBefore})`
      )
      const arrCmp = deepEqualValues(arr.toArray(), [10, 30, 40, 50], '3c.toArray')
      assertInvariant(arrCmp.equal, `3c: array mismatch (${arrCmp.reason})`)
      verifyDocInvariants(doc, { expectNoPending: true, label: '3c:splice-then-merge' })
    } finally {
      doc.destroy()
    }
  }

  // 3d. UndoManager + sequential push + delete + undo/redo wire sync check
  {
    const doc1 = new Y.Doc({ gc: false })
    const doc2 = new Y.Doc({ gc: false })
    /** @type {Y.Doc | null} */
    let doc3 = null
    doc1.clientID = 404
    doc2.clientID = 405
    const arr1 = doc1.get('array')
    const um = new Y.UndoManager(arr1, { captureTimeout: 0 })
    try {
      for (let i = 0; i < 60; i++) {
        if (i > 5 && i % 9 === 0 && arr1.length > 1) {
          arr1.delete(prng.uint32(gen, 0, arr1.length - 1), 1)
        } else if (i % 13 === 0 && um.canUndo()) {
          um.undo()
        } else if (i % 17 === 0 && um.canRedo()) {
          um.redo()
        } else {
          arr1.push([{ seq: i }])
        }
        um.stopCapturing()
      }
      const u1 = Y.encodeStateAsUpdate(doc1)
      const u2 = Y.encodeStateAsUpdateV2(doc1)
      Y.applyUpdate(doc2, u1)
      doc3 = new Y.Doc({ gc: false })
      Y.applyUpdateV2(doc3, u2)
      verifyConvergence([doc1, doc2, doc3], ['array'], { checkRoundtrip: true })
    } finally {
      um.destroy()
      doc3?.destroy()
      doc1.destroy()
      doc2.destroy()
    }
  }

  // 3e. Frozen array resilience (simulates NODE_ENV=development deepFreeze on ContentAny.arr!)
  {
    const doc = new Y.Doc({ gc: false })
    doc.clientID = 406
    const arr = doc.get('array')
    try {
      arr.push([1])
      const item = arr._start
      if (item === null) throw new InvariantError('3e: expected start item')
      if (item.content instanceof Y.ContentAny) {
        Object.freeze(item.content.arr)
      }
      // Must NOT throw TypeError: Cannot add property 1, object is not extensible
      arr.push([2])
      arr.push([3])
      const arrCmp = deepEqualValues(arr.toArray(), [1, 2, 3], '3e.toArray')
      assertInvariant(arrCmp.equal, `3e: frozen ContentAny.arr merge failed (${arrCmp.reason})`)
      verifyDocInvariants(doc, { expectNoPending: true, label: '3e:frozen-contentAny' })
    } finally {
      doc.destroy()
    }
  }

  // 3f. Caller-array mutation isolation (bidirectional: caller mutation vs ContentAny.mergeWith)
  {
    const doc = new Y.Doc({ gc: false })
    doc.clientID = 407
    const arr = doc.get('array')
    try {
      const callerA = [10, 20]
      const callerB = [30, 40]
      arr.push(callerA)
      arr.insert(2, callerB)
      // In non-dev mode caller arrays are mutable; verify mutating them cannot corrupt YNode state
      if (!Object.isFrozen(callerA)) {
        callerA.push(999)
        callerA[0] = -1
      }
      if (!Object.isFrozen(callerB)) {
        callerB.push(888)
        callerB[0] = -2
      }
      const snapA = JSON.stringify(callerA)
      const snapB = JSON.stringify(callerB)
      // Trigger ContentAny.mergeWith via subsequent push; must NOT mutate callerA or callerB
      arr.push([50])
      assertInvariant(
        JSON.stringify(callerA) === snapA && JSON.stringify(callerB) === snapB,
        `3f: ContentAny.mergeWith mutated caller input array (A=${JSON.stringify(callerA)} vs ${snapA}, B=${JSON.stringify(callerB)} vs ${snapB})`
      )
      const arrCmp = deepEqualValues(arr.toArray(), [10, 20, 30, 40, 50], '3f.toArray')
      assertInvariant(arrCmp.equal, `3f: caller-array isolation failed (${arrCmp.reason})`)
      verifyDocInvariants(doc, { expectNoPending: true, label: '3f:caller-array-isolation' })
    } finally {
      doc.destroy()
    }
  }

  // 3g. ContentJSON copy-then-merge, splice-then-merge, and frozen-array resilience
  {
    const cj = new Y.ContentJSON([1, 'a'])
    const copy1 = cj.copy()
    const snap1 = JSON.stringify(copy1.getContent())
    cj.mergeWith(new Y.ContentJSON([2, 'b']))
    assertInvariant(
      JSON.stringify(copy1.getContent()) === snap1,
      `3g: ContentJSON.mergeWith mutated aliased copy() (${JSON.stringify(copy1.getContent())} !== ${snap1})`
    )
    const cmp1 = deepEqualValues(cj.getContent(), [1, 'a', 2, 'b'], '3g.merged')
    assertInvariant(cmp1.equal, `3g: ContentJSON merged mismatch (${cmp1.reason})`)

    const copy2 = cj.copy()
    const snap2 = JSON.stringify(copy2.getContent())
    const right = cj.splice(2)
    right.mergeWith(new Y.ContentJSON([3]))
    assertInvariant(
      JSON.stringify(copy2.getContent()) === snap2,
      `3g: ContentJSON splice+mergeWith mutated aliased copy() (${JSON.stringify(copy2.getContent())} !== ${snap2})`
    )
    const cmpRight = deepEqualValues(right.getContent(), [2, 'b', 3], '3g.right')
    assertInvariant(cmpRight.equal, `3g: ContentJSON right mismatch (${cmpRight.reason})`)

    const frozen = new Y.ContentJSON([7])
    Object.freeze(frozen.arr)
    frozen.mergeWith(new Y.ContentJSON([8, 9]))
    const cmpFrozen = deepEqualValues(frozen.getContent(), [7, 8, 9], '3g.frozen')
    assertInvariant(cmpFrozen.equal, `3g: frozen ContentJSON mergeWith failed (${cmpFrozen.reason})`)
  }
}

/**
 * Suite 4: Exact V1 <-> V2 wire roundtrip bijection & mergeUpdates canonical equivalence.
 *
 * @param {number} seed
 * @param {Record<string, string>} digests
 */
const runWireBijectionOracle = (seed, digests) => {
  const gen = prng.create(seed + 3000)
  const doc1 = new Y.Doc({ gc: true })
  const doc2 = new Y.Doc({ gc: true })
  /** @type {Array<Y.Doc>} */
  const extraDocs = []
  /** @param {Y.Doc} d */
  const own = d => {
    extraDocs.push(d)
    return d
  }
  doc1.clientID = 501
  doc2.clientID = 502
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updatesV1 = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updatesV2 = []

  const track = /** @param {Y.Doc} d */ d => {
    d.on('update', u => updatesV1.push(u))
    d.on('updateV2', u => updatesV2.push(u))
  }
  track(doc1)
  track(doc2)

  try {
    // Populate all shared types + rich content kinds across 2 concurrent clients
    doc1.get('text').insert(0, 'Hello ', { bold: true })
    doc1.get('text').insert(6, 'World', { italic: true })
    doc1.get('text').applyDelta(delta.create(delta.$deltaAny).retain(5).insert([{ embed: { id: 7 } }]))
    doc1.get('array').insert(0, [1, 'two', true, null, { nested: [3, 4] }, new Uint8Array([9, 8, 7])])
    const nested = new Y.Node()
    doc1.get('array').insert(2, [nested])
    nested.insert(0, ['inner'])
    doc1.get('map').setAttr('k1', 'v1')
    doc1.get('map').setAttr('k1', 'v2')
    doc1.get('map').setAttr('bin', new Uint8Array([42, 43]))
    const div = new Y.Node('div')
    doc1.get('xml').insert(0, [div])
    div.setAttr('id', 'main')
    div.insert(0, 'xml-text')

    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    doc2.get('text').insert(0, 'Pre:')
    doc2.get('text').delete(5, 3)
    doc2.get('array').delete(0, 1)
    doc2.get('map').deleteAttr('k1')
    doc2.get('map').setAttr('k2', { ok: true })
    doc1.get('text').format(0, 4, { color: '#090' })

    // Full bidirectional sync
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)))
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)))

    const u1 = Y.encodeStateAsUpdate(doc1)
    const u2 = Y.encodeStateAsUpdateV2(doc1)
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(doc2)), '4: converged peers V1 bytes differ')
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(doc2)), '4: converged peers V2 bytes differ')

    // Re-encode roundtrip idempotency (encode -> fresh apply -> re-encode must be byte-identical!)
    const rt1 = own(new Y.Doc({ gc: true }))
    Y.applyUpdate(rt1, u1)
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(rt1)), '4: V1 encode->apply->encode not byte-identical')
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(rt1)), '4: V1->apply->encodeV2 not byte-identical to V2')

    const rt2 = own(new Y.Doc({ gc: true }))
    Y.applyUpdateV2(rt2, u2)
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(rt2)), '4: V2 encode->apply->encode not byte-identical')
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(rt2)), '4: V2->apply->encodeV1 not byte-identical to V1')

    // V1 <-> V2 format conversion byte-identity after apply
    const c12 = own(new Y.Doc({ gc: true }))
    Y.applyUpdateV2(c12, Y.convertUpdateFormatV1ToV2(u1))
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(c12)), '4: V1->V2 converted doc V1 bytes differ')
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(c12)), '4: V1->V2 converted doc V2 bytes differ')

    const c21 = own(new Y.Doc({ gc: true }))
    Y.applyUpdate(c21, Y.convertUpdateFormatV2ToV1(u2))
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(c21)), '4: V2->V1 converted doc V1 bytes differ')
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(c21)), '4: V2->V1 converted doc V2 bytes differ')

    // Shuffled + duplicate-injected mergeUpdates V1 & V2 must produce byte-identical converged docs
    const shufV1 = updatesV1.slice()
    const shufV2 = updatesV2.slice()
    for (let i = shufV1.length - 1; i > 0; i--) {
      const j = prng.uint32(gen, 0, i)
      const tmp = shufV1[i]
      shufV1[i] = shufV1[j]
      shufV1[j] = tmp
    }
    for (let i = shufV2.length - 1; i > 0; i--) {
      const j = prng.uint32(gen, 0, i)
      const tmp = shufV2[i]
      shufV2[i] = shufV2[j]
      shufV2[j] = tmp
    }
    shufV1.push(updatesV1[0], updatesV1[updatesV1.length - 1])
    shufV2.push(updatesV2[0], updatesV2[updatesV2.length - 1])

    const m1 = own(new Y.Doc({ gc: true }))
    Y.applyUpdate(m1, Y.mergeUpdates(shufV1))
    const m2 = own(new Y.Doc({ gc: true }))
    Y.applyUpdateV2(m2, Y.mergeUpdatesV2(shufV2))

    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(m1)), '4: mergeUpdates(shuffled+dup) V1 wire bytes differ')
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(m2)), '4: mergeUpdatesV2(shuffled+dup) V2 wire bytes differ')
    verifyConvergence([doc1, doc2, rt1, rt2, c12, c21, m1, m2], ['text', 'array', 'map', 'xml'], { checkRoundtrip: false })

    // DiffUpdate vs encodeStateAsUpdate(doc, partialSV) wire equivalence
    const partial = own(new Y.Doc({ gc: true }))
    Y.applyUpdate(partial, updatesV1[0])
    const partialSV = Y.encodeStateVector(partial)

    const dEnc1 = own(Y.cloneDoc(partial, { gc: true }))
    Y.applyUpdate(dEnc1, Y.encodeStateAsUpdate(doc1, partialSV))
    const dDiff1 = own(Y.cloneDoc(partial, { gc: true }))
    Y.applyUpdate(dDiff1, Y.diffUpdate(u1, partialSV))
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(dEnc1)), '4: encodeStateAsUpdate(sv) V1 mismatch')
    assertInvariant(equalBytes(u1, Y.encodeStateAsUpdate(dDiff1)), '4: diffUpdate V1 mismatch')

    const dEnc2 = own(Y.cloneDoc(partial, { gc: true }))
    Y.applyUpdateV2(dEnc2, Y.encodeStateAsUpdateV2(doc1, partialSV))
    const dDiff2 = own(Y.cloneDoc(partial, { gc: true }))
    Y.applyUpdateV2(dDiff2, Y.diffUpdateV2(u2, partialSV))
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(dEnc2)), '4: encodeStateAsUpdateV2(sv) V2 mismatch')
    assertInvariant(equalBytes(u2, Y.encodeStateAsUpdateV2(dDiff2)), '4: diffUpdateV2 V2 mismatch')

    digests.multi_client_canonical_v1 = sha256Hex(u1)
    digests.multi_client_canonical_v2 = sha256Hex(u2)
  } finally {
    for (let i = 0; i < extraDocs.length; i++) {
      extraDocs[i].destroy()
    }
    doc1.destroy()
    doc2.destroy()
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20260404
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/wire-compat-oracle.js [--seed N] [--json]')
      process.exit(0)
    }
  }
  return { seed, json }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const t0 = performance.now()
  /** @type {Record<string, string>} */
  const digests = {}

  /** @type {Array<{ name: string, fn: () => void }>} */
  const suites = [
    { name: 'searchMarker-vs-noMarker-random-text', fn: () => runSearchMarkerOracle(args.seed, digests) },
    { name: 'direct-api-vs-applyDelta-wire-equiv', fn: () => runDirectVsApplyDeltaOracle(args.seed, digests) },
    { name: 'contentAny-cow-merge-and-aliasing', fn: () => runContentAnyCowOracle(args.seed, digests) },
    { name: 'v1-v2-wire-bijection-and-merge-diff', fn: () => runWireBijectionOracle(args.seed, digests) }
  ]

  /** @type {Array<{ name: string, passed: boolean, ms: number, error: string | null }>} */
  const results = []
  let failed = 0

  if (!args.json) {
    console.log(`=== Yjs v14 Byte-for-Byte V1/V2 Wire-Compatibility Oracle (seed=${args.seed}) ===`)
  }

  for (let i = 0; i < suites.length; i++) {
    const s = suites[i]
    const st0 = performance.now()
    try {
      s.fn()
      const ms = performance.now() - st0
      results.push({ name: s.name, passed: true, ms, error: null })
      if (!args.json) {
        console.log(`  [PASS] ${s.name.padEnd(40)} (${ms.toFixed(1)}ms)`)
      }
    } catch (err) {
      failed++
      const ms = performance.now() - st0
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ name: s.name, passed: false, ms, error: msg })
      if (!args.json) {
        console.error(`  [FAIL] ${s.name.padEnd(40)} (${ms.toFixed(1)}ms)`)
        console.error(`         -> ${msg}`)
      }
    }
  }

  const totalMs = performance.now() - t0
  if (args.json) {
    console.log(JSON.stringify({ seed: args.seed, passed: suites.length - failed, failed, totalMs, results, digests }, null, 2))
  } else {
    console.log('\n--- Deterministic Wire SHA-256 Fingerprints (compare pre/post optimization!) ---')
    for (const [k, v] of Object.entries(digests)) {
      console.log(`  ${k.padEnd(28)} ${v}`)
    }
    console.log(`\n=== Summary: ${suites.length - failed} passed, ${failed} failed in ${totalMs.toFixed(1)}ms ===`)
  }

  if (failed > 0) {
    process.exit(1)
  }
}
