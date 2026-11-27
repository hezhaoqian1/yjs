import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as delta from 'lib0/delta'
import {
  assertInvariant,
  deepEqualValues,
  equalBytes,
  verifyConvergence,
  verifyDocInvariants
} from './invariants.js'

const NET_ORIGIN = 'rt-fuzzer-net'
const WORDS = [
  'hello ',
  'world',
  'CRDT ',
  'rich-text ',
  'format ',
  'undo',
  'merge ',
  'sync',
  'foo ',
  'bar ',
  'alpha ',
  'beta',
  '  ',
  'x',
  'yz',
  'αβ ',
  '— '
]

/**
 * @typedef {Record<string, string | number | boolean | Record<string, string | number | boolean> | null>} RichFormat
 */

/** @type {Array<RichFormat>} */
const INLINE_FORMATS = [
  { bold: true },
  { bold: null },
  { italic: true },
  { italic: null },
  { underline: true },
  { underline: null },
  { strike: true },
  { strike: null },
  { code: true },
  { code: null },
  { link: 'https://yjs.dev/docs' },
  { link: { href: 'https://yjs.dev', target: '_blank' } },
  { link: { href: 'https://example.org', target: '_self' } },
  { link: null },
  { comment: { id: 'c1', author: 'alice' } },
  { comment: { id: 'c2', author: 'bob' } },
  { comment: null },
  { color: '#c00' },
  { color: '#08c' },
  { color: '#0a5' },
  { color: null },
  { bg: '#ff0' },
  { bg: null },
  { bold: true, italic: true },
  { bold: true, comment: { id: 'c1', author: 'alice' } },
  { bold: true, underline: true, color: '#c00' },
  { bold: null, italic: null, link: null, comment: null }
]

/**
 * Return a deeply frozen copy of a RichFormat object (stresses BUG-RT-1 immutability).
 *
 * @param {RichFormat} fmt
 * @return {Readonly<RichFormat>}
 */
const freezeFormat = fmt => {
  /** @type {RichFormat} */
  const copy = {}
  const keys = Object.keys(fmt)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = fmt[k]
    if (v !== null && typeof v === 'object') {
      copy[k] = Object.freeze({ ...v })
    } else {
      copy[k] = v
    }
  }
  return Object.freeze(copy)
}

/** @type {Array<RichFormat>} */
const BLOCK_FORMATS = [
  { heading: 1 },
  { heading: 2 },
  { heading: 3 },
  { heading: null },
  { list: 'bullet' },
  { list: 'ordered' },
  { list: null },
  { 'code-block': true },
  { 'code-block': null },
  { blockquote: true },
  { blockquote: null },
  { align: 'center' },
  { align: null }
]

/**
 * @typedef {'low' | 'medium' | 'high' | 'extreme'} Intensity
 */

/**
 * @typedef {{
 *   runs: number,
 *   ops: number,
 *   clients: number
 * }} IntensityPreset
 */

/** @type {Record<Intensity, IntensityPreset>} */
const PRESETS = {
  low: { runs: 2, ops: 60, clients: 8 },
  medium: { runs: 4, ops: 100, clients: 10 },
  high: { runs: 12, ops: 200, clients: 14 },
  extreme: { runs: 32, ops: 300, clients: 18 }
}

/**
 * @typedef {{
 *   name: string,
 *   gcMode: 'mixed' | 'all-on' | 'all-off',
 *   undoRatio: number,
 *   hotRatio: number,
 *   hotWindow: number,
 *   v2Ratio: number,
 *   convertRatio: number,
 *   dupRate: number,
 *   partitionProb: number,
 *   clearProb: number,
 *   embedWeight: number
 * }} RichTextScenario
 */

/** @type {Array<RichTextScenario>} */
const SCENARIOS = [
  {
    name: 'hot-paragraph-mixed-gc-undo',
    gcMode: 'mixed',
    undoRatio: 0.5,
    hotRatio: 0.65,
    hotWindow: 40,
    v2Ratio: 0.5,
    convertRatio: 0.25,
    dupRate: 0.25,
    partitionProb: 0.12,
    clearProb: 0.04,
    embedWeight: 0.12
  },
  {
    name: 'heavy-formatting-gc-on-undo',
    gcMode: 'all-on',
    undoRatio: 0.6,
    hotRatio: 0.7,
    hotWindow: 36,
    v2Ratio: 0.55,
    convertRatio: 0.2,
    dupRate: 0.3,
    partitionProb: 0.14,
    clearProb: 0.07,
    embedWeight: 0.1
  },
  {
    name: 'v1-v2-convert-partitions-gc-off',
    gcMode: 'all-off',
    undoRatio: 0.4,
    hotRatio: 0.6,
    hotWindow: 44,
    v2Ratio: 0.65,
    convertRatio: 0.5,
    dupRate: 0.28,
    partitionProb: 0.16,
    clearProb: 0.05,
    embedWeight: 0.12
  },
  {
    name: 'extreme-contention-embeds-newlines',
    gcMode: 'mixed',
    undoRatio: 0.5,
    hotRatio: 0.75,
    hotWindow: 32,
    v2Ratio: 0.5,
    convertRatio: 0.35,
    dupRate: 0.35,
    partitionProb: 0.15,
    clearProb: 0.06,
    embedWeight: 0.22
  }
]

/**
 * @typedef {{
 *   index: number,
 *   doc: Y.Doc,
 *   ytext: Y.Node,
 *   um: Y.UndoManager | null,
 *   liveDelta: delta.DeltaAny | null,
 *   replayed: delta.DeltaBuilderAny | null,
 *   online: boolean,
 *   cluster: number,
 *   inbox: Array<{ fmt: 'v1' | 'v2', data: Uint8Array<ArrayBuffer> }>,
 *   histV1: Array<Uint8Array<ArrayBuffer>>,
 *   histV2: Array<Uint8Array<ArrayBuffer>>
 * }} RichPeer
 */

/**
 * @typedef {{
 *   ops: number,
 *   msgs: number,
 *   dups: number,
 *   merges: number,
 *   diffs: number,
 *   conversions: number,
 *   undos: number,
 *   redos: number,
 *   clears: number,
 *   partitions: number,
 *   liveChecks: number,
 *   rendererChecks: number,
 *   maxSkips: number,
 *   maxPending: number
 * }} RichStats
 */

/**
 * Append to bounded ring buffer for failure traces.
 *
 * @param {Array<string>} trace
 * @param {string} msg
 */
const pushTrace = (trace, msg) => {
  trace.push(msg)
  if (trace.length > 24) trace.shift()
}

/**
 * Push an update into a bounded per-peer replay history buffer (O(1) memory at high ops).
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} hist
 * @param {Uint8Array<ArrayBuffer>} update
 */
const pushBoundedHist = (hist, update) => {
  if (hist.length >= 128) {
    hist.shift()
  }
  hist.push(update)
}

/**
 * Deterministic Fisher-Yates shuffle copy.
 *
 * @template T
 * @param {prng.PRNG} gen
 * @param {Array<T>} arr
 * @return {Array<T>}
 */
const shuffleCopy = (gen, arr) => {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = prng.uint32(gen, 0, i)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * Seed a realistic multi-paragraph rich-text document with inline marks, links, embeds, and headings.
 *
 * @param {Y.Doc} doc
 */
const seedInitialRichDocument = doc => {
  const t = doc.get('text')
  t.applyDelta(
    delta.create(delta.$deltaAny)
      .insert('The quick ', { bold: true })
      .insert('brown fox', { italic: true, color: '#c00' })
      .insert(' jumps over the lazy dog.')
      .insert('\n', { heading: 1 })
      .insert('Collaborative ', { underline: true })
      .insert('rich-text', { code: true })
      .insert(' editing tests ', { link: { href: 'https://yjs.dev', target: '_blank' } })
      .insert([{ mention: { id: 1, handle: '@alice' } }], { bold: true })
      .insert(' convergence.')
      .insert('\n', { list: 'bullet' })
      .insert('Undo, GC, and partitions', { comment: { id: 'c1', author: 'alice' } })
      .insert(' must converge identically.')
      .insert('\n')
      .done()
  )
}

/**
 * Pick a position biased heavily toward the hot paragraph window [0..hotWindow].
 *
 * @param {prng.PRNG} gen
 * @param {number} len
 * @param {number} hotRatio
 * @param {number} hotWindow
 * @param {boolean} inclusiveEnd
 * @return {number}
 */
const pickContendedPos = (gen, len, hotRatio, hotWindow, inclusiveEnd) => {
  const maxIdx = inclusiveEnd ? len : math.max(0, len - 1)
  if (maxIdx === 0) return 0
  if (prng.real53(gen) < hotRatio) {
    return prng.uint32(gen, 0, math.min(maxIdx, hotWindow))
  }
  return prng.uint32(gen, 0, maxIdx)
}

/**
 * Build a deterministic inline embed object.
 *
 * @param {prng.PRNG} gen
 * @param {number} step
 * @return {Record<string, unknown>}
 */
const randomEmbed = (gen, step) => {
  const kind = prng.uint32(gen, 0, 2)
  if (kind === 0) return { image: { src: `img_${step % 15}.png`, w: 240 + (step % 4) * 80 } }
  if (kind === 1) return { mention: { id: prng.uint32(gen, 1, 20), handle: `@u${prng.uint32(gen, 1, 20)}` } }
  return { hr: true, seq: step }
}

/**
 * Apply one realistic collaborative rich-text edit on a peer's Y.Text (`Y.Node`).
 *
 * @param {Y.Node} ytext
 * @param {prng.PRNG} gen
 * @param {RichTextScenario} scenario
 * @param {number} step
 * @return {string}
 */
const applyRichTextEdit = (ytext, gen, scenario, step) => {
  const len = ytext.length
  const r = prng.real53(gen)

  // 1. Formatted word/phrase burst insert (32%)
  if (len === 0 || r < 0.32) {
    const pos = pickContendedPos(gen, len, scenario.hotRatio, scenario.hotWindow, true)
    const burst = prng.bool(gen)
      ? prng.oneOf(gen, WORDS) + prng.oneOf(gen, WORDS)
      : prng.oneOf(gen, WORDS)
    if (prng.real53(gen) < 0.7) {
      const rawFmt = prng.oneOf(gen, INLINE_FORMATS)
      const fmt = prng.bool(gen) ? freezeFormat(rawFmt) : rawFmt
      ytext.insert(pos, burst, fmt)
      return `insFmt(${pos},"${burst.slice(0, 8)}")`
    }
    ytext.insert(pos, burst)
    return `ins(${pos},"${burst.slice(0, 8)}")`
  }

  // 2. Overlapping format / unformat range (24%)
  if (r < 0.56) {
    const pos = pickContendedPos(gen, len, scenario.hotRatio, scenario.hotWindow, false)
    const span = math.min(prng.uint32(gen, 1, 14), len - pos)
    const rawFmt = prng.oneOf(gen, INLINE_FORMATS)
    const fmt = prng.bool(gen) ? freezeFormat(rawFmt) : rawFmt
    ytext.format(pos, span, fmt)
    return `fmt(${pos},${span})`
  }

  // 3. Boundary-straddling delete (20%)
  if (r < 0.76) {
    const pos = pickContendedPos(gen, len, scenario.hotRatio, scenario.hotWindow, false)
    const span = math.min(prng.uint32(gen, 1, 12), len - pos)
    ytext.delete(pos, span)
    return `del(${pos},${span})`
  }

  // 4. Paragraph break (\n) with block attributes (8%)
  if (r < 0.84) {
    const pos = pickContendedPos(gen, len, scenario.hotRatio, scenario.hotWindow, true)
    const blockFmt = freezeFormat(prng.oneOf(gen, BLOCK_FORMATS))
    ytext.insert(pos, '\n', blockFmt)
    return `newline(${pos})`
  }

  // 5. Inline embed insertion (configured by embedWeight, ~10-22% of remaining)
  if (r < 0.84 + scenario.embedWeight * 0.5) {
    const pos = pickContendedPos(gen, len, scenario.hotRatio, scenario.hotWindow, true)
    const embed = randomEmbed(gen, step)
    const fmt = prng.bool(gen) ? freezeFormat(prng.oneOf(gen, INLINE_FORMATS)) : undefined
    const d = fmt !== undefined
      ? delta.create(delta.$deltaAny).retain(pos).insert([embed], fmt).done()
      : delta.create(delta.$deltaAny).retain(pos).insert([embed]).done()
    const beforeEmbed = d.toJSON()
    ytext.applyDelta(d)
    const embedImm = deepEqualValues(d.toJSON(), beforeEmbed, `step${step}.embedDeltaImm`)
    assertInvariant(embedImm.equal, `BUG-RT-1: applyDelta mutated finalized embed Delta (${embedImm.reason})`)
    return `embed(${pos})`
  }

  // 6. Compound atomic rich-text delta (delete + formatted insert + format retain in one tx)
  const pos = pickContendedPos(gen, len, scenario.hotRatio, scenario.hotWindow, false)
  const d = delta.create(delta.$deltaAny).retain(pos)
  const delLen = math.min(prng.uint32(gen, 1, 5), len - pos)
  if (delLen > 0 && prng.bool(gen)) {
    d.delete(delLen)
  }
  d.insert(prng.oneOf(gen, WORDS), freezeFormat(prng.oneOf(gen, INLINE_FORMATS)))
  const rem = len - pos - delLen
  if (rem > 0) {
    d.retain(math.min(prng.uint32(gen, 1, 6), rem), freezeFormat(prng.oneOf(gen, INLINE_FORMATS)))
  }
  const finalDelta = d.done()
  const beforeCompound = finalDelta.toJSON()
  ytext.applyDelta(finalDelta)
  const compImm = deepEqualValues(finalDelta.toJSON(), beforeCompound, `step${step}.compoundDeltaImm`)
  assertInvariant(compImm.equal, `BUG-RT-1: applyDelta mutated finalized compound Delta (${compImm.reason})`)
  return `compoundDelta(${pos})`
}

/**
 * Assert live `.delta` cache and `'delta'` event replay match fresh `toDeltaDeep()` exactly.
 *
 * @param {RichPeer} peer
 * @param {string} label
 */
const verifyLiveDeltaOracle = (peer, label) => {
  if (peer.liveDelta === null || peer.replayed === null) return
  const fresh = peer.ytext.toDeltaDeep()
  const freshObj = fresh.toJSON()
  const liveObj = peer.liveDelta.toJSON()
  const liveCmp = deepEqualValues(liveObj, freshObj, `${label}.p${peer.index}.live`)
  assertInvariant(
    peer.liveDelta.equals(fresh) && liveCmp.equal,
    `${label}: peer ${peer.index} live ytext.delta drifted from toDeltaDeep() (${liveCmp.reason ?? 'equals=false'})!\n  live:  ${JSON.stringify(liveObj).slice(0, 280)}\n  fresh: ${JSON.stringify(freshObj).slice(0, 280)}`
  )
  const repObj = peer.replayed.toJSON()
  const repCmp = deepEqualValues(repObj, freshObj, `${label}.p${peer.index}.replayed`)
  assertInvariant(
    peer.replayed.equals(fresh) && repCmp.equal,
    `${label}: peer ${peer.index} replayed 'delta' stream drifted from toDeltaDeep() (${repCmp.reason ?? 'equals=false'})!\n  replayed: ${JSON.stringify(repObj).slice(0, 280)}\n  fresh:    ${JSON.stringify(freshObj).slice(0, 280)}`
  )
}

/**
 * Run one deterministic collaborative rich-text fuzzing scenario across 8-20+ clients.
 *
 * @param {{
 *   seed: number,
 *   scenario: RichTextScenario,
 *   ops: number,
 *   numClients: number,
 *   trace: Array<string>
 * }} cfg
 * @return {RichStats}
 */
export const runRichTextScenario = ({ seed, scenario, ops, numClients, trace }) => {
  const gen = prng.create(seed)
  /** @type {RichStats} */
  const stats = {
    ops: 0,
    msgs: 0,
    dups: 0,
    merges: 0,
    diffs: 0,
    conversions: 0,
    undos: 0,
    redos: 0,
    clears: 0,
    partitions: 0,
    liveChecks: 0,
    rendererChecks: 0,
    maxSkips: 0,
    maxPending: 0
  }

  // Build deterministic initial seed document (gc:false) shared by all peers
  const seedDoc = new Y.Doc({ gc: false })
  seedDoc.clientID = 1
  seedInitialRichDocument(seedDoc)
  const initialUpdateV1 = Y.encodeStateAsUpdate(seedDoc)
  const initialUpdateV2 = Y.encodeStateAsUpdateV2(seedDoc)
  const initialCids = Y.createContentIdsFromDoc(seedDoc, false)
  const initialExpectedDelta = seedDoc.get('text').toDeltaDeep()

  /** @type {Array<RichPeer>} */
  const peers = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const uniqueV1 = [initialUpdateV1]
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const uniqueV2 = [initialUpdateV2]
  /** @type {Array<Y.Doc>} */
  const extraDocs = []
  /** @type {Array<Y.AbstractRenderer>} */
  const renderers = []
  /** @param {Y.Doc} d */
  const ownDoc = d => { extraDocs.push(d); return d }

  try {
    const undoCount = math.max(1, math.floor(numClients * scenario.undoRatio))
    for (let i = 0; i < numClients; i++) {
      const gc = scenario.gcMode === 'all-on'
        ? true
        : scenario.gcMode === 'all-off'
          ? false
          : (i % 2 === 1) // peer 0 gc:false, peer 1 gc:true in mixed mode!
      const doc = new Y.Doc({ gc })
      doc.clientID = 1000 + i * 37 + prng.uint32(gen, 0, 15)
      Y.applyUpdate(doc, initialUpdateV1, NET_ORIGIN)
      const ytext = doc.get('text')
      const um = i < undoCount ? new Y.UndoManager(ytext, { captureTimeout: 0 }) : null

      // Attach live `.delta` cache + `'delta'` event replay oracle on peer 0 & peer 1
      /** @type {delta.DeltaAny | null} */
      let liveDelta = null
      /** @type {delta.DeltaBuilderAny | null} */
      let replayed = null
      if (i < 2) {
        liveDelta = ytext.delta
        replayed = delta.create(delta.$deltaAny)
        replayed.isFinal = true
        replayed.apply(liveDelta)
        const rep = replayed
        ytext.on('delta', d => { rep.apply(d) })
      }

      /** @type {RichPeer} */
      const peer = {
        index: i,
        doc,
        ytext,
        um,
        liveDelta,
        replayed,
        online: true,
        cluster: 0,
        inbox: [],
        histV1: [initialUpdateV1],
        histV2: [initialUpdateV2]
      }
      peers.push(peer)

      doc.on('update', (u, origin) => {
        if (origin === NET_ORIGIN) return
        uniqueV1.push(u)
        if (!peer.online) return
        if (prng.real53(gen) >= scenario.v2Ratio) {
          for (let j = 0; j < peers.length; j++) {
            const dst = peers[j]
            if (dst.index !== peer.index && dst.online && dst.cluster === peer.cluster) {
              if (prng.real53(gen) < scenario.convertRatio) {
                dst.inbox.push({ fmt: 'v2', data: Y.convertUpdateFormatV1ToV2(u) })
                stats.conversions++
              } else {
                dst.inbox.push({ fmt: 'v1', data: u })
              }
            }
          }
        }
      })

      doc.on('updateV2', (u2, origin) => {
        if (origin === NET_ORIGIN) return
        uniqueV2.push(u2)
        if (!peer.online) return
        if (prng.real53(gen) < scenario.v2Ratio) {
          for (let j = 0; j < peers.length; j++) {
            const dst = peers[j]
            if (dst.index !== peer.index && dst.online && dst.cluster === peer.cluster) {
              if (prng.real53(gen) < scenario.convertRatio) {
                dst.inbox.push({ fmt: 'v1', data: Y.convertUpdateFormatV2ToV1(u2) })
                stats.conversions++
              } else {
                dst.inbox.push({ fmt: 'v2', data: u2 })
              }
            }
          }
        }
      })
    }

    /**
     * Deliver one out-of-order message or merged batch to a peer.
     *
     * @param {RichPeer} dst
     * @param {boolean} allowDup
     */
    const deliverOne = (dst, allowDup) => {
      if (dst.inbox.length === 0) return
      if (dst.inbox.length >= 2 && prng.uint32(gen, 0, 3) === 0) {
        const fmt = dst.inbox[prng.uint32(gen, 0, dst.inbox.length - 1)].fmt
        /** @type {Array<number>} */
        const matching = []
        for (let k = 0; k < dst.inbox.length && matching.length < 4; k++) {
          if (dst.inbox[k].fmt === fmt) matching.push(k)
        }
        if (matching.length >= 2) {
          /** @type {Array<Uint8Array<ArrayBuffer>>} */
          const batch = []
          for (let k = matching.length - 1; k >= 0; k--) {
            batch.push(dst.inbox[matching[k]].data)
            if (!allowDup || prng.real53(gen) >= scenario.dupRate) {
              dst.inbox.splice(matching[k], 1)
            } else {
              stats.dups++
            }
          }
          if (fmt === 'v1') {
            const merged = Y.mergeUpdates(batch)
            Y.applyUpdate(dst.doc, merged, NET_ORIGIN)
            pushBoundedHist(dst.histV1, merged)
          } else {
            const merged = Y.mergeUpdatesV2(batch)
            Y.applyUpdateV2(dst.doc, merged, NET_ORIGIN)
            pushBoundedHist(dst.histV2, merged)
          }
          stats.merges++
          stats.msgs++
          return
        }
      }
      // Out-of-order pick biased toward newest
      const idx = prng.real53(gen) < 0.65
        ? prng.uint32(gen, 0, dst.inbox.length - 1)
        : dst.inbox.length - 1
      const pkt = dst.inbox[idx]
      if (!allowDup || prng.real53(gen) >= scenario.dupRate) {
        dst.inbox.splice(idx, 1)
      } else {
        stats.dups++
      }
      if (pkt.fmt === 'v1') {
        Y.applyUpdate(dst.doc, pkt.data, NET_ORIGIN)
        pushBoundedHist(dst.histV1, pkt.data)
      } else {
        Y.applyUpdateV2(dst.doc, pkt.data, NET_ORIGIN)
        pushBoundedHist(dst.histV2, pkt.data)
      }
      stats.msgs++
    }

    /**
     * Pairwise SV diff sync (encodeStateAsUpdate/V2 or diffUpdate/V2).
     *
     * @param {RichPeer} src
     * @param {RichPeer} dst
     */
    const syncPair = (src, dst) => {
      const sv = Y.encodeStateVector(dst.doc)
      const mode = prng.uint32(gen, 0, 3)
      if (mode === 0) {
        Y.applyUpdate(dst.doc, Y.encodeStateAsUpdate(src.doc, sv), NET_ORIGIN)
      } else if (mode === 1) {
        Y.applyUpdateV2(dst.doc, Y.encodeStateAsUpdateV2(src.doc, sv), NET_ORIGIN)
      } else if (mode === 2) {
        Y.applyUpdate(dst.doc, Y.diffUpdate(Y.encodeStateAsUpdate(src.doc), sv), NET_ORIGIN)
      } else {
        Y.applyUpdateV2(dst.doc, Y.diffUpdateV2(Y.encodeStateAsUpdateV2(src.doc), sv), NET_ORIGIN)
      }
      stats.diffs++
    }

    // Main collaborative rich-text fuzzing loop
    for (let step = 0; step < ops; step++) {
      const peer = peers[prng.uint32(gen, 0, numClients - 1)]

      // 1. Interleaved UndoManager undo/redo/clear OR rich-text edit
      if (peer.um !== null && prng.real53(gen) < scenario.clearProb && (peer.um.canUndo() || peer.um.canRedo())) {
        if (peer.um.canRedo() && prng.real53(gen) < 0.7) {
          peer.um.clear(false, true)
          pushTrace(trace, `s${step}:p${peer.index}:umClearRedo`)
        } else {
          peer.um.clear(true, false)
          pushTrace(trace, `s${step}:p${peer.index}:umClearUndo`)
        }
        stats.clears++
      } else if (peer.um !== null && peer.um.canRedo() && prng.uint32(gen, 0, 2) === 0) {
        peer.um.redo()
        pushTrace(trace, `s${step}:p${peer.index}:redo`)
        stats.redos++
      } else if (peer.um !== null && peer.um.canUndo() && prng.uint32(gen, 0, 3) === 0) {
        peer.um.undo()
        pushTrace(trace, `s${step}:p${peer.index}:undo`)
        stats.undos++
      } else {
        const opDesc = applyRichTextEdit(peer.ytext, gen, scenario, step)
        pushTrace(trace, `s${step}:p${peer.index}:${opDesc}`)
        if (peer.um !== null && prng.bool(gen)) {
          peer.um.stopCapturing()
        }
      }
      stats.ops++

      // 2. Network partition / disconnect / heal events
      if (prng.real53(gen) < scenario.partitionProb) {
        const pOp = prng.uint32(gen, 0, 3)
        if (pOp === 0) {
          const clusters = prng.uint32(gen, 2, 3)
          for (let i = 0; i < numClients; i++) {
            peers[i].cluster = prng.uint32(gen, 0, clusters - 1)
          }
        } else if (pOp === 1) {
          const victim = peers[prng.uint32(gen, 0, numClients - 1)]
          victim.online = false
          victim.inbox.length = math.floor(victim.inbox.length / 2)
        } else if (pOp === 2) {
          const offline = peers.filter(p => !p.online)
          if (offline.length > 0) {
            prng.oneOf(gen, offline).online = true
          }
        } else {
          for (let i = 0; i < numClients; i++) {
            peers[i].online = true
            peers[i].cluster = 0
          }
        }
        stats.partitions++
      }

      // 3. Deliver 1..3 out-of-order messages
      const deliveries = prng.uint32(gen, 1, 3)
      for (let d = 0; d < deliveries; d++) {
        const ready = peers.filter(p => p.online && p.inbox.length > 0)
        if (ready.length === 0) break
        deliverOne(prng.oneOf(gen, ready), true)
      }

      // 4. Duplicate replay burst (exercises idempotency under active skips/pending)
      if (prng.real53(gen) < scenario.dupRate) {
        const dst = peers[prng.uint32(gen, 0, numClients - 1)]
        if (dst.histV1.length > 0 && prng.bool(gen)) {
          const oldU = prng.oneOf(gen, dst.histV1)
          const svBefore = Y.encodeStateVector(dst.doc)
          Y.applyUpdate(dst.doc, oldU, NET_ORIGIN)
          assertInvariant(
            equalBytes(svBefore, Y.encodeStateVector(dst.doc)),
            `${scenario.name}:step${step}:p${dst.index}: duplicate V1 replay altered StateVector`
          )
          stats.dups++
        } else if (dst.histV2.length > 0) {
          const oldU2 = prng.oneOf(gen, dst.histV2)
          const svBefore = Y.encodeStateVector(dst.doc)
          Y.applyUpdateV2(dst.doc, oldU2, NET_ORIGIN)
          assertInvariant(
            equalBytes(svBefore, Y.encodeStateVector(dst.doc)),
            `${scenario.name}:step${step}:p${dst.index}: duplicate V2 replay altered StateVector`
          )
          stats.dups++
        }
      }

      // 5. Occasional intra-cluster pairwise SV diff sync
      if (step % 11 === 0) {
        const a = peers[prng.uint32(gen, 0, numClients - 1)]
        const b = peers[prng.uint32(gen, 0, numClients - 1)]
        if (a !== b && a.online && b.online && a.cluster === b.cluster) {
          syncPair(a, b)
        }
      }

      // 6. Periodic mid-run live `.delta` + invariant verification
      if (step > 0 && step % 40 === 0) {
        for (let i = 0; i < numClients; i++) {
          const d = peers[i].doc
          if (d.store.skips.clients.size > stats.maxSkips) stats.maxSkips = d.store.skips.clients.size
          const pend = (d.store.pendingStructs ? 1 : 0) + (d.store.pendingDs ? 1 : 0)
          if (pend > stats.maxPending) stats.maxPending = pend
          verifyDocInvariants(d, { expectNoPending: false, label: `${scenario.name}:s${step}:p${i}` })
        }
        verifyLiveDeltaOracle(peers[0], `${scenario.name}:s${step}`)
        if (peers.length > 1) verifyLiveDeltaOracle(peers[1], `${scenario.name}:s${step}`)
        stats.liveChecks += 2
      }
    }

    // Final heal: reconnect all peers, drain remaining inboxes out-of-order, then full SV sync
    for (let i = 0; i < numClients; i++) {
      peers[i].online = true
      peers[i].cluster = 0
    }
    while (true) {
      const ready = peers.filter(p => p.inbox.length > 0)
      if (ready.length === 0) break
      deliverOne(prng.oneOf(gen, ready), false)
    }
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < numClients; i++) {
        syncPair(peers[i], peers[(i + 1) % numClients])
      }
      for (let i = 1; i < numClients; i++) {
        syncPair(peers[0], peers[i])
        syncPair(peers[i], peers[0])
      }
    }

    // Synthetic convergence docs via shuffled + duplicate-injected mergeUpdates / mergeUpdatesV2 / cloneDoc
    const baseGc = peers[0].doc.gc
    const shufV1 = shuffleCopy(gen, uniqueV1)
    for (let i = 0; i < math.min(8, uniqueV1.length); i++) shufV1.push(prng.oneOf(gen, uniqueV1))
    const mergedV1Doc = ownDoc(new Y.Doc({ gc: baseGc }))
    Y.applyUpdate(mergedV1Doc, Y.mergeUpdates(shufV1))

    const shufV2 = shuffleCopy(gen, uniqueV2)
    for (let i = 0; i < math.min(8, uniqueV2.length); i++) shufV2.push(prng.oneOf(gen, uniqueV2))
    const mergedV2Doc = ownDoc(new Y.Doc({ gc: baseGc }))
    Y.applyUpdateV2(mergedV2Doc, Y.mergeUpdatesV2(shufV2))

    const clonedDoc = ownDoc(Y.cloneDoc(peers[0].doc, { gc: baseGc }))

    // Verify live `.delta` & `'delta'` replay oracles on converged peer 0 & peer 1
    verifyLiveDeltaOracle(peers[0], `${scenario.name}:final`)
    if (peers.length > 1) verifyLiveDeltaOracle(peers[1], `${scenario.name}:final`)
    stats.liveChecks += 2

    // Strict post-sync rich-text assertions across ALL peers + synthetic docs:
    // 100% identical toString(), toDelta(), toDeltaDeep(), exact formatting runs, and full verifyConvergence
    const allDocs = [...peers.map(p => p.doc), mergedV1Doc, mergedV2Doc, clonedDoc]
    const refText = peers[0].ytext
    const refStr = refText.toString()
    const refDelta = refText.toDelta()
    const refDeltaObj = refDelta.toJSON()
    const refDeepObj = refText.toDeltaDeep().toJSON()
    for (let i = 1; i < allDocs.length; i++) {
      const t = allDocs[i].get('text')
      assertInvariant(
        t.toString() === refStr,
        `${scenario.name}: doc[${i}] toString() diverged from doc[0]`
      )
      const curDelta = t.toDelta()
      const deltaCmp = deepEqualValues(curDelta.toJSON(), refDeltaObj, `doc[${i}].toDelta`)
      assertInvariant(
        curDelta.equals(refDelta) && deltaCmp.equal,
        `${scenario.name}: doc[${i}] toDelta() formatting/text runs diverged from doc[0] (${deltaCmp.reason ?? 'equals=false'})`
      )
      const deepCmp = deepEqualValues(t.toDeltaDeep().toJSON(), refDeepObj, `doc[${i}].toDeltaDeep`)
      assertInvariant(
        deepCmp.equal,
        `${scenario.name}: doc[${i}] toDeltaDeep() diverged from doc[0] (${deepCmp.reason})`
      )
    }
    verifyConvergence(allDocs, ['text'], {
      compareStores: scenario.gcMode === 'mixed' ? false : null,
      checkRoundtrip: true
    })

    // AttributionsRenderer & DiffRenderer rich-text overlay checks (idempotency + frozen past-state)
    const gcOffPeer = peers.find(p => !p.doc.gc)
    if (gcOffPeer !== undefined) {
      const targetDoc = gcOffPeer.doc
      const targetText = targetDoc.get('text')
      // 1. Frozen past-state AttributionsRenderer must faithfully restore the initial rich-text document
      const pastRend = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: initialCids.inserts })
      renderers.push(pastRend)
      const past1 = targetText.toDeltaDeep({ renderer: pastRend })
      const past2 = targetText.toDeltaDeep({ renderer: pastRend })
      assertInvariant(
        past1.equals(past2),
        `${scenario.name}: AttributionsRenderer(past) toDeltaDeep() was not idempotent`
      )
      if (scenario.gcMode === 'all-off') {
        assertInvariant(
          past1.equals(initialExpectedDelta),
          `${scenario.name}: AttributionsRenderer(past) drifted from initial seeded rich-text document`
        )
      }

      // 2. Attribution overlay attributing peer 0's edits (insert & delete) must be strictly idempotent
      const fullIds = Y.createContentIdsFromDoc(targetDoc, true)
      const cmap = Y.createContentMap()
      const p0Client = peers[0].doc.clientID
      const p0Ins = fullIds.inserts.clients.get(p0Client)
      if (p0Ins !== undefined) {
        const ranges = p0Ins.getIds()
        for (let i = 0; i < ranges.length; i++) {
          cmap.inserts.add(p0Client, ranges[i].clock, ranges[i].len, [Y.createContentAttribute('insert', 'peer0')])
        }
      }
      const p0Del = fullIds.deletes.clients.get(p0Client)
      if (p0Del !== undefined) {
        const ranges = p0Del.getIds()
        for (let i = 0; i < ranges.length; i++) {
          cmap.deletes.add(p0Client, ranges[i].clock, ranges[i].len, [Y.createContentAttribute('delete', 'peer0')])
        }
      }
      const overlayRend = Y.createAttributionsRenderer(cmap)
      renderers.push(overlayRend)
      const ov1 = targetText.toDeltaDeep({ renderer: overlayRend })
      const ov2 = targetText.toDeltaDeep({ renderer: overlayRend })
      const ovCmp = deepEqualValues(ov1.toJSON(), ov2.toJSON(), 'overlay.idempotent')
      assertInvariant(
        ov1.equals(ov2) && ovCmp.equal,
        `${scenario.name}: AttributionsRenderer(overlay) toDeltaDeep() was not idempotent (${ovCmp.reason ?? 'equals=false'})`
      )

      // 3. DiffRenderer(seedDoc, targetDoc) strict idempotency on rich-text formatting + embeds
      const diffRend = Y.createDiffRenderer(seedDoc, targetDoc)
      renderers.push(diffRend)
      const df1 = targetText.toDeltaDeep({ renderer: diffRend })
      const df2 = targetText.toDeltaDeep({ renderer: diffRend })
      const dfCmp = deepEqualValues(df1.toJSON(), df2.toJSON(), 'diff.idempotent')
      assertInvariant(
        df1.equals(df2) && dfCmp.equal,
        `${scenario.name}: DiffRenderer(seedDoc, gcOffDoc) toDeltaDeep() was not idempotent (${dfCmp.reason ?? 'equals=false'})`
      )
      const ddd1 = Y.diffDocsToDelta(seedDoc, targetDoc, { renderer: diffRend })
      const ddd2 = Y.diffDocsToDelta(seedDoc, targetDoc, { renderer: diffRend })
      assertInvariant(
        ddd1.equals(ddd2),
        `${scenario.name}: diffDocsToDelta(seedDoc, gcOffDoc) was not idempotent`
      )

      // 4. Live AttributionsRenderer delete-of-attributed-text check (catches BUG-ATTR-STALE-INSERT!)
      const liveAttrDoc = ownDoc(Y.cloneDoc(targetDoc, { gc: false }))
      liveAttrDoc.clientID = 999999
      const liveAliveIds = Y.createContentIdsFromDoc(liveAttrDoc, false)
      const liveCmap = Y.createContentMap()
      const attrClients = [seedDoc.clientID, peers[0].doc.clientID]
      if (peers.length > 1) attrClients.push(peers[1].doc.clientID)
      for (let ci = 0; ci < attrClients.length; ci++) {
        const cid = attrClients[ci]
        const insRanges = liveAliveIds.inserts.clients.get(cid)
        if (insRanges !== undefined) {
          const ids = insRanges.getIds()
          for (let ri = 0; ri < ids.length; ri++) {
            liveCmap.inserts.add(cid, ids[ri].clock, ids[ri].len, [Y.createContentAttribute('insert', `u${ci}`)])
          }
        }
      }
      const liveAttrRend = Y.createAttributionsRenderer(liveCmap)
      renderers.push(liveAttrRend)
      const liveAttrText = liveAttrDoc.get('text')
      liveAttrText.useRenderer(liveAttrRend)
      const liveAttrDelta = liveAttrText.delta
      const liveAttrReplay = delta.create(delta.$deltaAny)
      liveAttrReplay.isFinal = true
      liveAttrReplay.apply(liveAttrDelta)
      liveAttrText.on('delta', d => { liveAttrReplay.apply(d) })

      for (let k = 0; k < 6; k++) {
        const curLen = liveAttrText.length
        if (k < 3 && curLen > 0) {
          const delPos = k === 0 ? 0 : prng.uint32(gen, 0, curLen - 1)
          const delSpan = math.min(prng.uint32(gen, 1, 6), curLen - delPos)
          liveAttrText.delete(delPos, delSpan)
        } else if (k === 3 || k === 4) {
          const insPos = curLen > 0 ? prng.uint32(gen, 0, curLen) : 0
          const objMark = freezeFormat(k === 3
            ? { link: { href: 'https://yjs.dev', target: '_blank' } }
            : { comment: { id: 'c1', author: 'alice' } })
          liveAttrText.insert(insPos, 'attr ', objMark)
        } else if (curLen > 0) {
          const fmtPos = prng.uint32(gen, 0, curLen - 1)
          const fmtSpan = math.min(prng.uint32(gen, 1, 5), curLen - fmtPos)
          liveAttrText.format(fmtPos, fmtSpan, freezeFormat(prng.oneOf(gen, INLINE_FORMATS)))
        }
        const freshAttr = liveAttrText.toDeltaDeep()
        const freshAttrObj = freshAttr.toJSON()
        const liveAttrObj = liveAttrDelta.toJSON()
        const attrLiveCmp = deepEqualValues(liveAttrObj, freshAttrObj, `${scenario.name}:liveAttr.step${k}`)
        assertInvariant(
          liveAttrDelta.equals(freshAttr) && attrLiveCmp.equal,
          `${scenario.name}: live AttributionsRenderer .delta drifted after edit #${k} (BUG-ATTR-STALE-INSERT: ${attrLiveCmp.reason ?? 'equals=false'})\n  live:  ${JSON.stringify(liveAttrObj).slice(0, 260)}\n  fresh: ${JSON.stringify(freshAttrObj).slice(0, 260)}`
        )
        const repAttrObj = liveAttrReplay.toJSON()
        const attrRepCmp = deepEqualValues(repAttrObj, freshAttrObj, `${scenario.name}:liveAttrReplay.step${k}`)
        assertInvariant(
          liveAttrReplay.equals(freshAttr) && attrRepCmp.equal,
          `${scenario.name}: live AttributionsRenderer 'delta' replay drifted after edit #${k} (${attrRepCmp.reason ?? 'equals=false'})`
        )
      }
      verifyDocInvariants(liveAttrDoc, { expectNoPending: true, label: `${scenario.name}:liveAttrDoc` })

      // 5. Object-valued mark cleanup check inside the converged CRDT list (catches BUG-RT-3!)
      const objMarkDoc = ownDoc(Y.cloneDoc(targetDoc, { gc: false }))
      objMarkDoc.clientID = 999998
      const objText = objMarkDoc.get('text')
      const insAt = math.min(5, objText.length)
      objText.insert(insAt, 'a', freezeFormat({ __objMark: { href: 'https://yjs.dev', tag: 1 } }))
      objText.insert(insAt + 1, 'b', freezeFormat({ __objMark: null }))
      objText.insert(insAt + 2, 'c', freezeFormat({ __objMark: { href: 'https://yjs.dev', tag: 1 } }))
      objText.delete(insAt + 1, 1)
      let aliveObjMarks = 0
      for (let item = objText._start; item !== null; item = item.right) {
        if (!item.deleted && item.content instanceof Y.ContentFormat && item.content.key === '__objMark') {
          aliveObjMarks++
        }
      }
      assertInvariant(
        aliveObjMarks === 2,
        `${scenario.name}: BUG-RT-3 object-mark cleanup left ${aliveObjMarks} alive ContentFormat items (expected 2)`
      )
      verifyDocInvariants(objMarkDoc, { expectNoPending: true, label: `${scenario.name}:objMarkDoc` })

      stats.rendererChecks += 5
    }

    const gcOnPeer = peers.find(p => p.doc.gc)
    if (gcOnPeer !== undefined) {
      const gcTarget = gcOnPeer.doc
      const diffRendGc = Y.createDiffRenderer(seedDoc, gcTarget)
      renderers.push(diffRendGc)
      const g1 = gcTarget.get('text').toDeltaDeep({ renderer: diffRendGc })
      const g2 = gcTarget.get('text').toDeltaDeep({ renderer: diffRendGc })
      const gCmp = deepEqualValues(g1.toJSON(), g2.toJSON(), 'diffGc.idempotent')
      assertInvariant(
        g1.equals(g2) && gCmp.equal,
        `${scenario.name}: DiffRenderer(seedDoc, gcOnDoc) toDeltaDeep() was not idempotent (${gCmp.reason ?? 'equals=false'})`
      )
      stats.rendererChecks++
    }

    return stats
  } finally {
    for (let i = 0; i < renderers.length; i++) {
      renderers[i].destroy()
    }
    for (let i = 0; i < extraDocs.length; i++) {
      extraDocs[i].destroy()
    }
    for (let i = 0; i < peers.length; i++) {
      peers[i].um?.destroy()
      peers[i].doc.destroy()
    }
    seedDoc.destroy()
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20260606
  /** @type {Intensity} */
  let intensity = 'medium'
  /** @type {number | null} */
  let runsOverride = null
  /** @type {number | null} */
  let opsOverride = null
  /** @type {number | null} */
  let clientsOverride = null
  /** @type {string | null} */
  let scenarioName = null
  let reportOnly = false
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--runs' && i + 1 < argv.length) {
      runsOverride = Number.parseInt(argv[++i], 10)
    } else if (arg === '--ops' && i + 1 < argv.length) {
      opsOverride = Number.parseInt(argv[++i], 10)
    } else if (arg === '--clients' && i + 1 < argv.length) {
      clientsOverride = Number.parseInt(argv[++i], 10)
    } else if (arg === '--scenario' && i + 1 < argv.length) {
      scenarioName = argv[++i]
    } else if (arg === '--intensity' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'low' || val === 'medium' || val === 'high' || val === 'extreme') {
        intensity = val
      } else {
        console.error(`Invalid --intensity "${val}" (expected low|medium|high|extreme)`)
        process.exit(2)
      }
    } else if (arg === '--report') {
      reportOnly = true
    } else if (arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/richtext-fuzzer.js [--seed N] [--runs N] [--ops N] [--clients N] [--intensity low|medium|high|extreme] [--scenario NAME] [--report] [--verbose]')
      process.exit(0)
    }
  }
  const preset = PRESETS[intensity]
  return {
    seed,
    intensity,
    runs: runsOverride ?? preset.runs,
    ops: opsOverride ?? preset.ops,
    clients: clientsOverride ?? preset.clients,
    scenarioName,
    reportOnly,
    verbose
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const selected = args.scenarioName !== null
    ? SCENARIOS.filter(s => s.name === args.scenarioName)
    : SCENARIOS
  if (selected.length === 0) {
    console.error(`Unknown scenario "${String(args.scenarioName)}". Valid: ${SCENARIOS.map(s => s.name).join(', ')}`)
    process.exit(2)
  }

  const t0 = performance.now()
  let passed = 0
  let failed = 0
  /** @type {Array<{ run: number, scenario: string, seed: number, error: string, repro: string, trace: Array<string> }>} */
  const failures = []

  console.log('=== Yjs v14 Realistic Collaborative Rich-Text Fuzzer ===')
  console.log(`baseSeed=${args.seed} intensity=${args.intensity} runs=${args.runs} clients=${args.clients} ops/run=${args.ops}`)

  for (let r = 0; r < args.runs; r++) {
    const scenario = selected[r % selected.length]
    const runSeed = args.seed + r * 31337
    /** @type {Array<string>} */
    const trace = []
    const rt0 = performance.now()
    try {
      const st = runRichTextScenario({
        seed: runSeed,
        scenario,
        ops: args.ops,
        numClients: args.clients,
        trace
      })
      const ms = (performance.now() - rt0).toFixed(1)
      passed++
      console.log(
        `[PASS] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} clients=${args.clients} gc=${scenario.gcMode} ` +
        `ops=${st.ops} undo/redo/clr=${st.undos}/${st.redos}/${st.clears} msgs=${st.msgs} dups=${st.dups} merges=${st.merges} ` +
        `live=${st.liveChecks} rend=${st.rendererChecks} skipsMax=${st.maxSkips} pendMax=${st.maxPending} time=${ms}ms`
      )
      if (args.verbose) {
        console.log(`       diffs=${st.diffs} conversions=${st.conversions} partitions=${st.partitions}`)
      }
    } catch (err) {
      failed++
      const ms = (performance.now() - rt0).toFixed(1)
      const msg = err instanceof Error ? err.message : String(err)
      const repro = `node ./tests/lab/richtext-fuzzer.js --seed ${runSeed} --runs 1 --scenario ${scenario.name} --clients ${args.clients} --ops ${args.ops}`
      failures.push({ run: r + 1, scenario: scenario.name, seed: runSeed, error: msg, repro, trace: trace.slice(-12) })
      console.error(`[FAIL] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} time=${ms}ms`)
      console.error(`       repro: ${repro}`)
      console.error(`       error: ${msg}`)
    }
  }

  if (failures.length > 0) {
    console.log('\n--- Rich-Text Fuzzer Failure Traces ---')
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i]
      console.log(`  [${i + 1}] run=${f.run} ${f.scenario} seed=${f.seed}`)
      console.log(`      repro: ${f.repro}`)
      console.log(`      trace: ${f.trace.join(' -> ')}`)
    }
  }

  console.log(`=== Summary: ${passed} passed, ${failed} failed in ${(performance.now() - t0).toFixed(1)}ms ===`)
  if (failed > 0 && !args.reportOnly) {
    process.exit(1)
  }
}
