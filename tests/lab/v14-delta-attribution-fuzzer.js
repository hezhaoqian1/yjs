import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as delta from 'lib0/delta'
import * as dpos from 'lib0/delta/position'
import {
  assertInvariant,
  deepEqualValues,
  equalBytes,
  verifyConvergence,
  verifyDocInvariants
} from './invariants.js'

const NETWORK_ORIGIN = 'v14-fuzzer-net'
const ATTR_KEYS = ['a0', 'a1', 'a2', 'a3', 'childAttr']
const NODE_TAGS = ['p', 'div', 'span', null]
const AUTHORS = ['alice', 'bob', 'carol', 'dave']

/**
 * @typedef {Record<string, string | number | boolean | null>} FormatMap
 */

/** @type {Array<FormatMap>} */
const FORMATS = [
  { bold: true },
  { bold: null },
  { italic: true },
  { italic: null },
  { color: '#c00' },
  { color: '#08c' },
  { color: null },
  { bold: true, italic: true }
]

/**
 * @typedef {'low' | 'medium' | 'high'} Intensity
 */

/**
 * @typedef {{
 *   defaultSeeds: number,
 *   s1Peers: number,
 *   s1Steps: number,
 *   s2Peers: number,
 *   s2Steps: number,
 *   s3Rounds: number,
 *   s4Peers: number,
 *   s4Steps: number
 * }} IntensityConfig
 */

/** @type {Record<Intensity, IntensityConfig>} */
const INTENSITY_CONFIG = {
  low: {
    defaultSeeds: 2,
    s1Peers: 4,
    s1Steps: 35,
    s2Peers: 3,
    s2Steps: 25,
    s3Rounds: 4,
    s4Peers: 4,
    s4Steps: 30
  },
  medium: {
    defaultSeeds: 4,
    s1Peers: 5,
    s1Steps: 60,
    s2Peers: 4,
    s2Steps: 40,
    s3Rounds: 6,
    s4Peers: 4,
    s4Steps: 45
  },
  high: {
    defaultSeeds: 8,
    s1Peers: 6,
    s1Steps: 120,
    s2Peers: 5,
    s2Steps: 75,
    s3Rounds: 12,
    s4Peers: 5,
    s4Steps: 80
  }
}

/**
 * Keep a bounded ring buffer of human-readable operation trace entries for failure diagnostics.
 *
 * @param {Array<string>} trace
 * @param {string} entry
 */
const pushTrace = (trace, entry) => {
  trace.push(entry)
  if (trace.length > 24) {
    trace.shift()
  }
}

/**
 * Generate a short deterministic alphanumeric text snippet.
 *
 * @param {prng.PRNG} gen
 * @param {number} maxLen
 * @return {string}
 */
const randSnippet = (gen, maxLen) => {
  const chars = 'abcdefghijklmno01234 '
  const len = prng.uint32(gen, 1, maxLen)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += chars[prng.uint32(gen, 0, chars.length - 1)]
  }
  return out
}

/**
 * Generate a deterministic scalar/object/binary value for ContentAny or map attributes.
 *
 * @param {prng.PRNG} gen
 * @return {string | number | boolean | null | Array<number> | Record<string, number> | Uint8Array<ArrayBuffer>}
 */
const randAnyValue = gen => {
  const kind = prng.uint32(gen, 0, 6)
  if (kind === 0) return prng.int32(gen, -500, 500)
  if (kind === 1) return `v_${prng.uint32(gen, 0, 99)}`
  if (kind === 2) return prng.bool(gen)
  if (kind === 3) return null
  if (kind === 4) return [prng.uint32(gen, 0, 20), prng.uint32(gen, 0, 20)]
  if (kind === 5) return { k: prng.uint32(gen, 0, 50) }
  return new Uint8Array([prng.uint32(gen, 0, 255), prng.uint32(gen, 0, 255)])
}

/**
 * Shuffle a copy of an array deterministically.
 *
 * @template T
 * @param {prng.PRNG} gen
 * @param {Array<T>} items
 * @return {Array<T>}
 */
const shuffleCopy = (gen, items) => {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = prng.uint32(gen, 0, i)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * Apply one randomized mutation to a unified Y.Node (text + formatting + ContentAny + nested Y.Node + map attrs).
 *
 * @param {Y.Node} node
 * @param {prng.PRNG} gen
 * @param {number} [depth]
 * @param {boolean} [allowModify]
 * @return {string}
 */
const mutateUnifiedNode = (node, gen, depth = 0, allowModify = true) => {
  const len = node.length
  const roll = prng.uint32(gen, 0, 99)

  // 0..17: text insert (plain or formatted)
  if (roll < 18) {
    const pos = prng.uint32(gen, 0, len)
    const txt = randSnippet(gen, 4)
    if (prng.bool(gen)) {
      const fmt = prng.oneOf(gen, FORMATS)
      node.insert(pos, txt, fmt)
      return `insertText(${pos},"${txt}",fmt)`
    }
    node.insert(pos, txt)
    return `insertText(${pos},"${txt}")`
  }

  // 18..29: format / unformat range
  if (roll < 30 && len > 0) {
    const pos = prng.uint32(gen, 0, len - 1)
    const span = math.min(prng.uint32(gen, 1, 5), len - pos)
    const fmt = prng.oneOf(gen, FORMATS)
    node.format(pos, span, fmt)
    return `format(${pos},${span})`
  }

  // 30..49: ContentAny sequential push (coalescing!) or random-index multi-element insert
  if (roll < 50) {
    const count = prng.uint32(gen, 1, 3)
    /** @type {Array<unknown>} */
    const vals = []
    for (let i = 0; i < count; i++) vals.push(randAnyValue(gen))
    if (prng.bool(gen)) {
      node.push(vals)
      return `pushAny(len=${count})`
    }
    const pos = prng.uint32(gen, 0, len)
    node.insert(pos, vals)
    return `insertAny(${pos},len=${count})`
  }

  // 50..64: delete 1..4 positions
  if (roll < 65 && len > 0) {
    const pos = prng.uint32(gen, 0, len - 1)
    const span = math.min(prng.uint32(gen, 1, 4), len - pos)
    node.delete(pos, span)
    return `delete(${pos},${span})`
  }

  // 65..78: nested Y.Node child insert or mutate existing child
  if (roll < 79 && depth < 2) {
    if (len > 0 && prng.bool(gen)) {
      const idx = prng.uint32(gen, 0, len - 1)
      const elem = node.get(idx)
      if (elem instanceof Y.Node) {
        if (allowModify && prng.uint32(gen, 0, 2) === 0) {
          // Exercise applyDelta modify op on child YNode
          const subDelta = elem.length > 0 && prng.bool(gen)
            ? delta.create(delta.$deltaAny).retain(0).delete(1).done()
            : delta.create(delta.$deltaAny).retain(elem.length).insert([randAnyValue(gen)]).done()
          node.applyDelta(delta.create(delta.$deltaAny).retain(idx).modify(subDelta).done())
          return `modifyChild(${idx})`
        }
        const subOp = mutateUnifiedNode(elem, gen, depth + 1)
        return `child[${idx}].${subOp}`
      }
    }
    const pos = prng.uint32(gen, 0, len)
    const tag = prng.oneOf(gen, NODE_TAGS)
    const child = new Y.Node(tag)
    node.insert(pos, [child])
    if (prng.bool(gen)) {
      child.insert(0, randSnippet(gen, 3))
    } else {
      child.push([randAnyValue(gen), randAnyValue(gen)])
    }
    child.setAttr('id', prng.uint32(gen, 1, 50))
    return `insertChild(${pos},tag=${String(tag)})`
  }

  // 79..91: setAttr (primitive, object, or nested Y.Node) or mutate nested attr Y.Node
  if (roll < 92) {
    const key = prng.oneOf(gen, ATTR_KEYS)
    if (key === 'childAttr' && depth < 2) {
      const existing = node.getAttr(key)
      if (existing instanceof Y.Node && prng.bool(gen)) {
        const subOp = mutateUnifiedNode(existing, gen, depth + 1)
        return `attr[childAttr].${subOp}`
      }
      const attrChild = new Y.Node('attrNode')
      node.setAttr(key, attrChild)
      attrChild.insert(0, randSnippet(gen, 3))
      attrChild.push([prng.uint32(gen, 0, 20)])
      return 'setAttr(childAttr,YNode)'
    }
    node.setAttr(key, randAnyValue(gen))
    return `setAttr(${key})`
  }

  // 92..99: deleteAttr
  const key = prng.oneOf(gen, ATTR_KEYS)
  if (node.hasAttr(key)) {
    node.deleteAttr(key)
    return `deleteAttr(${key})`
  }
  const pos = prng.uint32(gen, 0, len)
  node.insert(pos, randSnippet(gen, 2))
  return `insertTextFallback(${pos})`
}

/**
 * Apply one randomized rich-text mutation (formatted runs, unformat, embeds, delete).
 *
 * @param {Y.Node} ytext
 * @param {prng.PRNG} gen
 * @return {string}
 */
const mutateRichText = (ytext, gen) => {
  const len = ytext.length
  const kind = prng.uint32(gen, 0, 4)
  if (len === 0 || kind === 0) {
    const pos = prng.uint32(gen, 0, len)
    const str = randSnippet(gen, 4)
    const fmt = prng.bool(gen) ? prng.oneOf(gen, FORMATS) : undefined
    if (fmt !== undefined) {
      ytext.insert(pos, str, fmt)
    } else {
      ytext.insert(pos, str)
    }
    return `richInsert(${pos},"${str}")`
  }
  if (kind === 1) {
    const pos = prng.uint32(gen, 0, len - 1)
    const span = math.min(prng.uint32(gen, 1, 5), len - pos)
    ytext.format(pos, span, prng.oneOf(gen, FORMATS))
    return `richFormat(${pos},${span})`
  }
  if (kind === 2) {
    const pos = prng.uint32(gen, 0, len - 1)
    const span = math.min(prng.uint32(gen, 1, 4), len - pos)
    ytext.delete(pos, span)
    return `richDelete(${pos},${span})`
  }
  if (kind === 3) {
    const pos = prng.uint32(gen, 0, len)
    const d = delta.create(delta.$deltaAny).retain(pos).insert([{ widget: prng.uint32(gen, 1, 30) }]).done()
    ytext.applyDelta(d)
    return `richEmbed(${pos})`
  }
  const pos = prng.uint32(gen, 0, math.max(0, len - 1))
  const d = delta.create().retain(pos).insert(randSnippet(gen, 3), { bold: true })
  if (pos < len) {
    d.retain(math.min(2, len - pos), { italic: true })
  }
  ytext.applyDelta(d.done())
  return `richMultiDelta(${pos})`
}

/**
 * Assert live `.delta` cache and `'delta'` event replay match fresh `toDeltaDeep()` exactly.
 *
 * @param {Y.Node} node
 * @param {delta.DeltaAny} live
 * @param {delta.DeltaAny | null} replayed
 * @param {string} label
 */
const assertLiveDeltaMatchesFresh = (node, live, replayed, label) => {
  const fresh = node.toDeltaDeep()
  const freshObj = fresh.toJSON()
  const liveObj = live.toJSON()
  const liveCmp = deepEqualValues(liveObj, freshObj, `${label}.live`)
  assertInvariant(
    live.equals(fresh) && liveCmp.equal,
    `${label}: live node.delta drifted from toDeltaDeep() (${liveCmp.reason ?? 'equals=false'})!\n  live:  ${JSON.stringify(liveObj).slice(0, 300)}\n  fresh: ${JSON.stringify(freshObj).slice(0, 300)}`
  )
  if (replayed !== null) {
    const repObj = replayed.toJSON()
    const repCmp = deepEqualValues(repObj, freshObj, `${label}.replayed`)
    assertInvariant(
      replayed.equals(fresh) && repCmp.equal,
      `${label}: replayed 'delta' event stream drifted from toDeltaDeep() (${repCmp.reason ?? 'equals=false'})!\n  replayed: ${JSON.stringify(repObj).slice(0, 300)}\n  fresh:    ${JSON.stringify(freshObj).slice(0, 300)}`
    )
  }
}

/**
 * Suite 1: Differential Live-Delta vs Fresh-Delta Oracle.
 * Multi-client (4-6 peers, mixed gc:true/false, concurrent out-of-order updates + UndoManager)
 * mutating a unified YNode tree + rich text, verifying live `node.delta` AND replayed `'delta'`
 * events match fresh `node.toDeltaDeep()` after every batch and after full convergence.
 *
 * @param {number} seed
 * @param {IntensityConfig} cfg
 * @param {Array<string>} trace
 */
const runLiveDeltaOracle = (seed, cfg, trace) => {
  const gen = prng.create(seed)
  const numPeers = cfg.s1Peers

  /**
   * @typedef {{
   *   idx: number,
   *   doc: Y.Doc,
   *   root: Y.Node,
   *   rich: Y.Node,
   *   liveRoot: delta.DeltaAny,
   *   liveRich: delta.DeltaAny,
   *   repRoot: delta.DeltaBuilderAny,
   *   repRich: delta.DeltaBuilderAny,
   *   um: Y.UndoManager | null,
   *   inbox: Array<{ fmt: 'v1' | 'v2', data: Uint8Array<ArrayBuffer> }>
   * }} LivePeer
   */

  /** @type {Array<LivePeer>} */
  const peers = []

  try {
    for (let i = 0; i < numPeers; i++) {
      const doc = new Y.Doc({ gc: i % 2 === 0 })
      doc.clientID = 100 + i
      const root = doc.get('root')
      const rich = doc.get('rich')
      const liveRoot = root.delta
      const liveRich = rich.delta
      const repRoot = delta.create(delta.$deltaAny)
      repRoot.isFinal = true
      const repRich = delta.create(delta.$deltaAny)
      repRich.isFinal = true
      root.on('delta', d => { repRoot.apply(d) })
      rich.on('delta', d => { repRich.apply(d) })
      const um = i < 2 ? new Y.UndoManager([root, rich], { captureTimeout: 0 }) : null
      /** @type {LivePeer} */
      const peer = { idx: i, doc, root, rich, liveRoot, liveRich, repRoot, repRich, um, inbox: [] }
      peers.push(peer)

      doc.on('update', (u, origin) => {
        if (origin === NETWORK_ORIGIN) return
        if (prng.bool(gen)) {
          for (let j = 0; j < peers.length; j++) {
            if (j !== i) peers[j].inbox.push({ fmt: 'v1', data: u })
          }
        }
      })
      doc.on('updateV2', (u2, origin) => {
        if (origin === NETWORK_ORIGIN) return
        if (prng.bool(gen)) {
          for (let j = 0; j < peers.length; j++) {
            if (j !== i) peers[j].inbox.push({ fmt: 'v2', data: u2 })
          }
        }
      })
    }

    /**
     * Deliver one out-of-order message (or merged batch) to a peer.
     *
     * @param {LivePeer} target
     * @param {boolean} allowDup
     */
    const deliverOne = (target, allowDup) => {
      if (target.inbox.length === 0) return
      if (target.inbox.length >= 2 && prng.uint32(gen, 0, 3) === 0) {
        const fmt = target.inbox[0].fmt
        /** @type {Array<number>} */
        const idxs = []
        for (let k = 0; k < target.inbox.length && idxs.length < 3; k++) {
          if (target.inbox[k].fmt === fmt) idxs.push(k)
        }
        if (idxs.length >= 2) {
          /** @type {Array<Uint8Array<ArrayBuffer>>} */
          const batch = []
          for (let k = idxs.length - 1; k >= 0; k--) {
            batch.push(target.inbox[idxs[k]].data)
            if (!allowDup || prng.uint32(gen, 0, 4) !== 0) {
              target.inbox.splice(idxs[k], 1)
            }
          }
          if (fmt === 'v1') {
            Y.applyUpdate(target.doc, Y.mergeUpdates(batch), NETWORK_ORIGIN)
          } else {
            Y.applyUpdateV2(target.doc, Y.mergeUpdatesV2(batch), NETWORK_ORIGIN)
          }
          return
        }
      }
      const pick = prng.uint32(gen, 0, target.inbox.length - 1)
      const msg = target.inbox[pick]
      if (!allowDup || prng.uint32(gen, 0, 5) !== 0) {
        target.inbox.splice(pick, 1)
      }
      if (msg.fmt === 'v1') {
        Y.applyUpdate(target.doc, msg.data, NETWORK_ORIGIN)
      } else {
        Y.applyUpdateV2(target.doc, msg.data, NETWORK_ORIGIN)
      }
    }

    for (let step = 0; step < cfg.s1Steps; step++) {
      const p = peers[prng.uint32(gen, 0, numPeers - 1)]
      if (p.um !== null && p.um.redoStack.length > 0 && prng.uint32(gen, 0, 4) === 0) {
        p.um.redo()
        pushTrace(trace, `s${step}:p${p.idx}:redo`)
      } else if (p.um !== null && p.um.undoStack.length > 0 && prng.uint32(gen, 0, 4) === 0) {
        p.um.undo()
        pushTrace(trace, `s${step}:p${p.idx}:undo`)
      } else if (prng.uint32(gen, 0, 2) === 0) {
        const desc = mutateRichText(p.rich, gen)
        pushTrace(trace, `s${step}:p${p.idx}:rich:${desc}`)
        if (p.um !== null && prng.bool(gen)) p.um.stopCapturing()
      } else {
        const desc = mutateUnifiedNode(p.root, gen, 0)
        pushTrace(trace, `s${step}:p${p.idx}:root:${desc}`)
        if (p.um !== null && prng.bool(gen)) p.um.stopCapturing()
      }

      // Out-of-order deliveries
      const deliveries = prng.uint32(gen, 1, 3)
      for (let d = 0; d < deliveries; d++) {
        const target = peers[prng.uint32(gen, 0, numPeers - 1)]
        deliverOne(target, true)
      }

      // Periodic mid-run differential live-delta check on every peer
      if (step % 12 === 11) {
        for (let i = 0; i < numPeers; i++) {
          const peer = peers[i]
          verifyDocInvariants(peer.doc, { expectNoPending: false, label: `S1:step${step}:p${i}` })
          assertLiveDeltaMatchesFresh(peer.root, peer.liveRoot, peer.repRoot, `S1:step${step}:p${i}:root`)
          assertLiveDeltaMatchesFresh(peer.rich, peer.liveRich, peer.repRich, `S1:step${step}:p${i}:rich`)
        }
      }
    }

    // Drain inboxes and full SV sync across all peers
    for (let i = 0; i < numPeers; i++) {
      while (peers[i].inbox.length > 0) {
        deliverOne(peers[i], false)
      }
    }
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < numPeers; i++) {
        const next = peers[(i + 1) % numPeers]
        const sv = Y.encodeStateVector(next.doc)
        if (prng.bool(gen)) {
          Y.applyUpdate(next.doc, Y.encodeStateAsUpdate(peers[i].doc, sv), NETWORK_ORIGIN)
        } else {
          Y.applyUpdateV2(next.doc, Y.encodeStateAsUpdateV2(peers[i].doc, sv), NETWORK_ORIGIN)
        }
      }
      if (round >= 1) {
        const refCids = Y.createContentIdsFromDoc(peers[0].doc, true)
        let allSynced = peers[0].doc.store.pendingStructs === null && peers[0].doc.store.pendingDs === null
        for (let i = 1; allSynced && i < numPeers; i++) {
          const d = peers[i].doc
          if (
            d.store.pendingStructs !== null ||
            d.store.pendingDs !== null ||
            !Y.equalContentIds(refCids, Y.createContentIdsFromDoc(d, true))
          ) {
            allSynced = false
          }
        }
        if (allSynced) break
      }
    }

    // Final differential check on every peer + full convergence
    for (let i = 0; i < numPeers; i++) {
      const peer = peers[i]
      assertLiveDeltaMatchesFresh(peer.root, peer.liveRoot, peer.repRoot, `S1:final:p${i}:root`)
      assertLiveDeltaMatchesFresh(peer.rich, peer.liveRich, peer.repRich, `S1:final:p${i}:rich`)
    }
    verifyConvergence(peers.map(p => p.doc), ['root', 'rich'], { checkRoundtrip: true })
  } finally {
    for (let i = 0; i < peers.length; i++) {
      peers[i].um?.destroy()
      peers[i].doc.destroy()
    }
  }
}

/**
 * Suite 2: Attributed & Diff Renderer Differential Fuzzer.
 * Exercises AttributionsRenderer (overlay, frozen past-state, combined, useRenderer switches,
 * repeated render idempotency, live `.delta` vs `toDeltaDeep()`) AND DiffRenderer(prevDoc, nextDoc)
 * (split items, GC'd tombstones, overlapping format/insert/delete attributions, render idempotency,
 * diffDocsToDelta, and live suggestion edits).
 *
 * @param {number} seed
 * @param {IntensityConfig} cfg
 * @param {Array<string>} trace
 */
const runRendererFuzzer = (seed, cfg, trace) => {
  const gen = prng.create(seed + 10007)
  /** @type {Array<Y.Doc>} */
  const docs = []
  /** @type {Array<Y.AbstractRenderer>} */
  const renderers = []
  /** @param {Y.Doc} d */
  const ownDoc = d => { docs.push(d); return d }
  /**
   * @template {Y.AbstractRenderer} R
   * @param {R} r
   * @return {R}
   */
  const ownRend = r => { renderers.push(r); return r }

  try {
    // --- 2A: Multi-peer AttributionsRenderer overlay + frozen past-state + useRenderer switching ---
    const numPeers = cfg.s2Peers
    /** @type {Array<Y.Doc>} */
    const peers = []
    for (let i = 0; i < numPeers; i++) {
      const d = ownDoc(new Y.Doc({ gc: false }))
      d.clientID = 200 + i
      peers.push(d)
    }

    // Seed shared base content across peers
    peers[0].get('doc').insert(0, 'initial base text', { bold: true })
    peers[0].get('doc').push([1, 2, 3])
    peers[0].get('doc').setAttr('title', 'v1')
    const baseUpdate = Y.encodeStateAsUpdate(peers[0])
    for (let i = 1; i < numPeers; i++) {
      Y.applyUpdate(peers[i], baseUpdate)
    }

    const target = ownDoc(new Y.Doc({ gc: false }))
    target.clientID = 299
    Y.applyUpdate(target, baseUpdate)
    const pastCids = Y.createContentIdsFromDoc(target, false)
    const pastRenderedBefore = target.get('doc').toDeltaDeep()

    // Collect overlapping per-peer ContentIds into a ContentMap
    const cmap = Y.createContentMap()
    const halfSteps = math.max(8, math.floor(cfg.s2Steps / 2))
    for (let step = 0; step < halfSteps; step++) {
      const pIdx = prng.uint32(gen, 0, numPeers - 1)
      const pDoc = peers[pIdx]
      const beforeIds = Y.createContentIdsFromDoc(pDoc, true)
      const opDesc = prng.bool(gen)
        ? mutateUnifiedNode(pDoc.get('doc'), gen, 0)
        : mutateRichText(pDoc.get('doc'), gen)
      pushTrace(trace, `S2A:s${step}:p${pIdx}:${opDesc}`)
      const afterIds = Y.createContentIdsFromDoc(pDoc, true)
      const newIns = Y.diffIdSet(afterIds.inserts, beforeIds.inserts)
      const newDel = Y.diffIdSet(afterIds.deletes, beforeIds.deletes)
      const author = AUTHORS[pIdx % AUTHORS.length]
      const insAttr = [Y.createContentAttribute('insert', author)]
      const delAttr = [Y.createContentAttribute('delete', author)]
      newIns.forEach((r, client) => cmap.inserts.add(client, r.clock, r.len, insAttr))
      newDel.forEach((r, client) => cmap.deletes.add(client, r.clock, r.len, delAttr))

      // Sync randomly between peers
      if (step % 3 === 0) {
        const other = peers[prng.uint32(gen, 0, numPeers - 1)]
        if (other !== pDoc) {
          Y.applyUpdate(other, Y.encodeStateAsUpdate(pDoc, Y.encodeStateVector(other)))
        }
      }
    }

    // Round-trip ContentMap binary encoding before building renderers
    const cmapRoundtrip = Y.decodeContentMap(Y.encodeContentMap(cmap))
    for (let i = 0; i < numPeers; i++) {
      Y.applyUpdate(target, Y.encodeStateAsUpdate(peers[i], Y.encodeStateVector(target)))
    }
    verifyDocInvariants(target, { expectNoPending: true, label: 'S2A:target' })

    const rendOverlay = ownRend(Y.createAttributionsRenderer(cmapRoundtrip))
    const rendPast = ownRend(Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: pastCids.inserts }))
    const rendCombo = ownRend(Y.createAttributionsRenderer(cmapRoundtrip, { renderedContent: pastCids.inserts }))
    const targetNode = target.get('doc')

    // Strict render idempotency across all 3 AttributionsRenderer configurations
    /** @type {Array<{ name: string, r: Y.AbstractRenderer }>} */
    const rendList = [
      { name: 'overlay', r: rendOverlay },
      { name: 'past', r: rendPast },
      { name: 'combo', r: rendCombo }
    ]
    for (let i = 0; i < rendList.length; i++) {
      const { name, r } = rendList[i]
      const r1 = targetNode.toDeltaDeep({ renderer: r })
      const r2 = targetNode.toDeltaDeep({ renderer: r })
      const cmp = deepEqualValues(r1.toJSON(), r2.toJSON(), `S2A.${name}`)
      assertInvariant(
        r1.equals(r2) && cmp.equal,
        `S2A:${name}: toDeltaDeep({ renderer }) was NOT idempotent across two consecutive calls (${cmp.reason ?? 'equals=false'})!`
      )
    }

    // Frozen past-state renderer MUST equal the original captured state despite subsequent edits
    const pastRenderedAfter = targetNode.toDeltaDeep({ renderer: rendPast })
    assertInvariant(
      pastRenderedAfter.equals(pastRenderedBefore),
      `S2A:rendPast: frozen past-state renderer drifted from original captured state!\n  before: ${JSON.stringify(pastRenderedBefore.toJSON()).slice(0, 260)}\n  after:  ${JSON.stringify(pastRenderedAfter.toJSON()).slice(0, 260)}`
    )

    // useRenderer switching differential check: live `.delta` + `'delta'` event replay across switches
    const repSwitch = delta.create(delta.$deltaAny)
    repSwitch.isFinal = true
    repSwitch.apply(targetNode.delta)
    const switchListener = /** @param {delta.DeltaAny} d */ d => { repSwitch.apply(d) }
    targetNode.on('delta', switchListener)
    /** @type {Array<Y.AbstractRenderer | null>} */
    const switchSeq = [rendOverlay, rendPast, rendCombo, null]
    for (let i = 0; i < switchSeq.length; i++) {
      targetNode.useRenderer(switchSeq[i])
      assertLiveDeltaMatchesFresh(targetNode, targetNode.delta, repSwitch, `S2A:useRenderer[${i}]`)
    }
    targetNode.off('delta', switchListener)

    // Remote updates arriving while frozen past-state renderer is attached: view & cache must stay frozen!
    targetNode.useRenderer(rendPast)
    const livePast = targetNode.delta
    for (let i = 0; i < 10; i++) {
      const desc = mutateUnifiedNode(peers[0].get('doc'), gen, 0)
      pushTrace(trace, `S2A:pastRemoteEdit${i}:${desc}`)
      Y.applyUpdate(target, Y.encodeStateAsUpdate(peers[0], Y.encodeStateVector(target)))
    }
    assertLiveDeltaMatchesFresh(targetNode, livePast, null, 'S2A:live-under-rendPast')
    assertInvariant(
      targetNode.toDeltaDeep({ renderer: rendPast }).equals(pastRenderedBefore),
      'S2A:rendPast: frozen past-state view changed after subsequent remote edits!'
    )
    targetNode.useRenderer(null)

    // Live edits under attribution overlay renderer (non-base): compare live `.delta` vs `toDeltaDeep()`
    const overlayDoc = ownDoc(new Y.Doc({ gc: false }))
    overlayDoc.clientID = 298
    const overlayNode = overlayDoc.get('doc')
    overlayNode.insert(0, 'hello world')
    overlayNode.push([10, 20, 30])
    const overlayMap = Y.createContentMap()
    overlayMap.inserts.add(298, 0, 3, [Y.createContentAttribute('insert', 'alice')])
    const liveOverlayRend = ownRend(Y.createAttributionsRenderer(overlayMap))
    overlayNode.useRenderer(liveOverlayRend)
    const liveOverlayDelta = overlayNode.delta
    for (let i = 0; i < 12; i++) {
      const desc = mutateUnifiedNode(overlayNode, gen, 0, false)
      pushTrace(trace, `S2A:overlayEdit${i}:${desc}`)
    }
    assertLiveDeltaMatchesFresh(overlayNode, liveOverlayDelta, null, 'S2A:live-under-rendOverlay')

    // --- 2B: DiffRenderer(prevDoc, nextDoc) with split items, GC'd tombstones & repeated renders ---
    for (const nextGc of [false, true]) {
      const base = ownDoc(new Y.Doc({ gc: false }))
      base.clientID = 301
      base.get('doc').insert(0, 'abcdefghij', { bold: true })
      base.get('doc').push([1, 2, 3, 4, 5])
      base.get('doc').setAttr('k1', 'v1')
      const baseU = Y.encodeStateAsUpdate(base)

      const prevDoc = ownDoc(new Y.Doc({ gc: false }))
      prevDoc.clientID = 302
      Y.applyUpdate(prevDoc, baseU)
      // Deliberately insert inside existing runs on prevDoc to create split items vs nextDoc!
      prevDoc.get('doc').insert(2, 'P')
      prevDoc.get('doc').insert(7, 'Q')

      const nextDoc = ownDoc(new Y.Doc({ gc: nextGc }))
      nextDoc.clientID = 303
      Y.applyUpdate(nextDoc, baseU)
      for (let step = 0; step < math.max(8, math.floor(cfg.s2Steps / 2)); step++) {
        const desc = prng.bool(gen)
          ? mutateUnifiedNode(nextDoc.get('doc'), gen, 0)
          : mutateRichText(nextDoc.get('doc'), gen)
        pushTrace(trace, `S2B(gc=${nextGc}):s${step}:${desc}`)
      }

      const diffRend = ownRend(Y.createDiffRenderer(prevDoc, nextDoc))
      const nNode = nextDoc.get('doc')

      // Repeated toDeltaDeep({ renderer: diffRend }) MUST be strictly idempotent (catches R-2!)
      const d1 = nNode.toDeltaDeep({ renderer: diffRend })
      const d2 = nNode.toDeltaDeep({ renderer: diffRend })
      const dCmp = deepEqualValues(d1.toJSON(), d2.toJSON(), `S2B.gc${nextGc}.delta`)
      assertInvariant(
        d1.equals(d2) && dCmp.equal,
        `S2B(gc=${nextGc}): DiffRenderer toDeltaDeep() NOT idempotent across two calls (${dCmp.reason ?? 'equals=false'})!\n  1st: ${JSON.stringify(d1.toJSON()).slice(0, 260)}\n  2nd: ${JSON.stringify(d2.toJSON()).slice(0, 260)}`
      )

      // Repeated diffDocsToDelta MUST also be strictly idempotent
      const dd1 = Y.diffDocsToDelta(prevDoc, nextDoc, { renderer: diffRend })
      const dd2 = Y.diffDocsToDelta(prevDoc, nextDoc, { renderer: diffRend })
      const ddCmp = deepEqualValues(dd1.toJSON(), dd2.toJSON(), `S2B.gc${nextGc}.diffDocs`)
      assertInvariant(
        dd1.equals(dd2) && ddCmp.equal,
        `S2B(gc=${nextGc}): diffDocsToDelta() NOT idempotent across two calls (${ddCmp.reason ?? 'equals=false'})!`
      )

      // Live edits in suggestion mode with DiffRenderer attached
      nNode.useRenderer(diffRend)
      const liveDiff = nNode.delta
      for (let step = 0; step < 8; step++) {
        const desc = prng.bool(gen)
          ? mutateRichText(nNode, gen)
          : mutateUnifiedNode(nNode, gen, 0, false)
        pushTrace(trace, `S2B(gc=${nextGc}):live${step}:${desc}`)
      }
      assertLiveDeltaMatchesFresh(nNode, liveDiff, null, `S2B(gc=${nextGc}):live-under-DiffRenderer`)
      verifyDocInvariants(prevDoc, { expectNoPending: true, label: `S2B(gc=${nextGc}):prevDoc` })
      verifyDocInvariants(nextDoc, { expectNoPending: true, label: `S2B(gc=${nextGc}):nextDoc` })
    }
  } finally {
    for (let i = 0; i < renderers.length; i++) {
      renderers[i].destroy()
    }
    for (let i = 0; i < docs.length; i++) {
      docs[i].destroy()
    }
  }
}

/**
 * Suite 3: RelativePosition & position-helpers Round-Trip Fuzzer.
 * Generates random index & delta positions across formatted text, multi-element ContentAny,
 * nested YNodes, maps, and tombstones; verifies encode/decode/JSON round-trips, doc.share
 * non-pollution, cross-peer gc:false/gc:true resolution bounds & parity, and past-state renderer lookup.
 *
 * @param {number} seed
 * @param {IntensityConfig} cfg
 * @param {Array<string>} trace
 */
const runPositionFuzzer = (seed, cfg, trace) => {
  const gen = prng.create(seed + 20011)
  const doc1 = new Y.Doc({ gc: false })
  const doc2 = new Y.Doc({ gc: true })
  doc1.clientID = 401
  doc2.clientID = 402
  const um1 = new Y.UndoManager([doc1.get('text'), doc1.get('array'), doc1.get('map')], { captureTimeout: 0 })
  /** @type {Array<Y.AbstractRenderer>} */
  const renderers = []

  try {
    /** @type {Array<Y.RelativePosition>} */
    const savedIndexRpos = []
    /** @type {Array<Y.RelativePosition | null>} */
    const savedDeltaRpos = []

    for (let round = 0; round < cfg.s3Rounds; round++) {
      // Populate & mutate all 3 roots on both peers concurrently
      for (let step = 0; step < 8; step++) {
        const d = prng.bool(gen) ? doc1 : doc2
        const kind = prng.uint32(gen, 0, 2)
        if (kind === 0) {
          pushTrace(trace, `S3:r${round}:c${d.clientID}:${mutateRichText(d.get('text'), gen)}`)
        } else if (kind === 1) {
          pushTrace(trace, `S3:r${round}:c${d.clientID}:${mutateUnifiedNode(d.get('array'), gen, 0)}`)
        } else {
          const m = d.get('map')
          const k = prng.oneOf(gen, ATTR_KEYS)
          if (k === 'childAttr') {
            const existing = m.getAttr(k)
            if (existing instanceof Y.Node && prng.bool(gen)) {
              existing.insert(prng.uint32(gen, 0, existing.length), randSnippet(gen, 2))
            } else {
              const cn = new Y.Node('mchild')
              m.setAttr(k, cn)
              cn.insert(0, randSnippet(gen, 3))
            }
          } else if (m.hasAttr(k) && prng.uint32(gen, 0, 3) === 0) {
            m.deleteAttr(k)
          } else {
            m.setAttr(k, randAnyValue(gen))
          }
          pushTrace(trace, `S3:r${round}:c${d.clientID}:map(${k})`)
        }
      }
      um1.stopCapturing()

      // Sync peers before sampling positions
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)))
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)))

      // 1. Sample RelativePosition from type index with assoc in {-1, 0, 1}
      const roots = [doc1.get('text'), doc1.get('array')]
      /** @type {Array<number>} */
      const assocs = [-1, 0, 1]
      for (let ri = 0; ri < roots.length; ri++) {
        const node = roots[ri]
        for (let s = 0; s < 4; s++) {
          const idx = prng.uint32(gen, 0, node.length)
          const assoc = prng.oneOf(gen, assocs)
          const rpos = Y.createRelativePositionFromTypeIndex(node, idx, assoc)
          const binDecoded = Y.decodeRelativePosition(Y.encodeRelativePosition(rpos))
          const binDecoded2 = Y.decodeRelativePosition(Y.encodeRelativePosition(binDecoded))
          const jsonDecoded = Y.createRelativePositionFromJSON(Y.relativePositionToJSON(rpos))
          assertInvariant(
            Y.compareRelativePositions(binDecoded, binDecoded2),
            `S3:r${round}: encode/decodeRelativePosition is not idempotent`
          )
          assertInvariant(
            rpos.assoc === binDecoded.assoc && (rpos.item !== null ? Y.compareIDs(rpos.item, binDecoded.item) : Y.compareRelativePositions(rpos, binDecoded)),
            `S3:r${round}: encode/decodeRelativePosition roundtrip mismatch`
          )
          assertInvariant(
            Y.compareRelativePositions(rpos, jsonDecoded),
            `S3:r${round}: relativePositionToJSON/FromJSON roundtrip mismatch`
          )
          const apos = Y.createAbsolutePositionFromRelativePosition(binDecoded, doc1)
          assertInvariant(
            apos !== null && apos.type === node && apos.index === idx,
            `S3:r${round}: immediate RelativePosition resolution mismatch (expected ${idx}, got ${apos ? String(apos.index) : 'null'})`
          )
          savedIndexRpos.push(binDecoded)
        }
      }

      // 2. Sample doc-rooted DeltaPositions (valid paths + nonexistent ghost root!)
      /** @type {Array<dpos.Pos>} */
      const deltaPositions = []
      /** @type {Array<boolean>} */
      const expectValid = []
      const textLen = doc1.get('text').length
      const arrNode = doc1.get('array')
      const arrLen = arrNode.length
      /** @type {Array<-1 | 1>} */
      const dAssocs = [-1, 1]

      deltaPositions.push(dpos.create(['text', prng.uint32(gen, 0, textLen)], prng.oneOf(gen, dAssocs)))
      expectValid.push(true)
      deltaPositions.push(dpos.create(['array', prng.uint32(gen, 0, arrLen)], prng.oneOf(gen, dAssocs)))
      expectValid.push(true)

      // Nested YNode inside array if present
      for (let idx = 0; idx < arrLen; idx++) {
        const elem = arrNode.get(idx)
        if (elem instanceof Y.Node) {
          deltaPositions.push(dpos.create(['array', idx, prng.uint32(gen, 0, elem.length)], prng.oneOf(gen, dAssocs)))
          expectValid.push(true)
          break
        }
      }

      // Existing map attribute + nested map YNode if present
      for (const k of doc1.get('map').attrKeys()) {
        if (typeof k !== 'string') continue
        const val = doc1.get('map').getAttr(k)
        deltaPositions.push(dpos.create(['map', k], prng.oneOf(gen, dAssocs)))
        expectValid.push(true)
        if (val instanceof Y.Node) {
          deltaPositions.push(dpos.create(['map', k, prng.uint32(gen, 0, val.length)], prng.oneOf(gen, dAssocs)))
          expectValid.push(true)
        }
        break
      }

      // Nonexistent root key probe (must NEVER pollute doc.share — catches P-3!)
      const ghostRoot = `__ghost_root_${round}`
      deltaPositions.push(dpos.create([ghostRoot, 0], 1))
      expectValid.push(false)

      const shareBefore = Array.from(doc1.share.keys()).sort()
      const converted = Y.createRelativePositionsFromDeltaPositions(doc1, deltaPositions)
      const shareAfter = Array.from(doc1.share.keys()).sort()
      const shareCmp = deepEqualValues(shareBefore, shareAfter, 'doc1.share')
      assertInvariant(
        shareCmp.equal,
        `S3:r${round}: createRelativePositionsFromDeltaPositions polluted doc.share (${shareCmp.reason})`
      )
      assertInvariant(
        converted[converted.length - 1] === null,
        `S3:r${round}: expected null RelativePosition for nonexistent root "${ghostRoot}"`
      )

      const roundTripped = Y.createDeltaPositionsFromRelativePositions(doc1, converted)
      for (let i = 0; i < deltaPositions.length; i++) {
        if (expectValid[i]) {
          assertInvariant(
            converted[i] !== null,
            `S3:r${round}: valid DeltaPosition ${JSON.stringify(deltaPositions[i].path)} resolved to null`
          )
          const rt = roundTripped[i]
          assertInvariant(
            rt !== null && JSON.stringify(rt.path) === JSON.stringify(deltaPositions[i].path),
            `S3:r${round}: DeltaPosition roundtrip mismatch: orig=${JSON.stringify(deltaPositions[i].path)} vs rt=${rt ? JSON.stringify(rt.path) : 'null'}`
          )
          savedDeltaRpos.push(converted[i])
        }
      }

      // 3. Apply concurrent deletes / inserts / undo on both peers, sync, and verify all saved positions stay valid & bounded
      if (um1.canUndo() && prng.bool(gen)) {
        um1.undo()
        pushTrace(trace, `S3:r${round}:um1.undo`)
      }
      if (doc2.get('text').length > 2) {
        doc2.get('text').delete(0, math.min(2, doc2.get('text').length))
      }
      if (doc2.get('array').length > 2) {
        doc2.get('array').delete(0, math.min(2, doc2.get('array').length))
      }
      Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1)))
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2)))

      // Also verify exact parity against a fresh gc:false mirror (no local redone/GC differences)
      const mirror = Y.cloneDoc(doc1, { gc: false })
      try {
        for (let i = 0; i < savedIndexRpos.length; i++) {
          const rp = savedIndexRpos[i]
          const a1 = Y.createAbsolutePositionFromRelativePosition(rp, doc1, false)
          const aMirror = Y.createAbsolutePositionFromRelativePosition(rp, mirror, false)
          const a2 = Y.createAbsolutePositionFromRelativePosition(rp, doc2, false)
          if (a1 !== null) {
            assertInvariant(
              a1.index >= 0 && a1.index <= a1.type.length,
              `S3:r${round}: doc1 AbsolutePosition index=${a1.index} out of bounds [0..${a1.type.length}]`
            )
          }
          if (a2 !== null) {
            assertInvariant(
              a2.index >= 0 && a2.index <= a2.type.length,
              `S3:r${round}: doc2 AbsolutePosition index=${a2.index} out of bounds [0..${a2.type.length}]`
            )
          }
          assertInvariant(
            (a1 === null) === (aMirror === null) && (a1 === null || aMirror === null || a1.index === aMirror.index),
            `S3:r${round}: gc:false peer vs clone AbsolutePosition diverged (${a1 ? String(a1.index) : 'null'} vs ${aMirror ? String(aMirror.index) : 'null'})`
          )
          // gc:true may legitimately return null for a GC'd anchor, but any non-null anchor must agree with gc:false
          assertInvariant(
            a2 === null || (a1 !== null && a1.index === a2.index),
            `S3:r${round}: gc:false vs gc:true AbsolutePosition diverged (doc1=${a1 ? String(a1.index) : 'null'} vs doc2=${a2 ? String(a2.index) : 'null'})`
          )
        }

        const dpos1 = Y.createDeltaPositionsFromRelativePositions(doc1, savedDeltaRpos, { followUndoneDeletions: false })
        const dposMirror = Y.createDeltaPositionsFromRelativePositions(mirror, savedDeltaRpos, { followUndoneDeletions: false })
        const dpos2 = Y.createDeltaPositionsFromRelativePositions(doc2, savedDeltaRpos, { followUndoneDeletions: false })
        for (let i = 0; i < savedDeltaRpos.length; i++) {
          const p1 = dpos1[i]
          const pM = dposMirror[i]
          const p2 = dpos2[i]
          assertInvariant(
            (p1 === null) === (pM === null) && (p1 === null || pM === null || JSON.stringify(p1.path) === JSON.stringify(pM.path)),
            `S3:r${round}: gc:false peer vs clone DeltaPosition diverged (${p1 ? JSON.stringify(p1.path) : 'null'} vs ${pM ? JSON.stringify(pM.path) : 'null'})`
          )
          assertInvariant(
            p2 === null || (p1 !== null && JSON.stringify(p1.path) === JSON.stringify(p2.path)),
            `S3:r${round}: gc:false vs gc:true DeltaPosition diverged (${p1 ? JSON.stringify(p1.path) : 'null'} vs ${p2 ? JSON.stringify(p2.path) : 'null'})`
          )
        }
      } finally {
        mirror.destroy()
      }
    }

    // 4. Past-state AttributionsRenderer probe on future map key (catches P-1!)
    const pastCids = Y.createContentIdsFromDoc(doc1, false)
    const pastRend = Y.createAttributionsRenderer(Y.createContentMap(), { renderedContent: pastCids.inserts })
    renderers.push(pastRend)
    doc1.get('map').setAttr('__future_only_key__', 'futureVal')
    const [futureKeyRpos] = Y.createRelativePositionsFromDeltaPositions(
      doc1.get('map'),
      [dpos.create(['__future_only_key__'], 1)],
      { renderer: pastRend }
    )
    assertInvariant(
      futureKeyRpos === null,
      'S3: past-state AttributionsRenderer resolved a RelativePosition for a future map key (rendererMode===2)'
    )

    verifyDocInvariants(doc1, { expectNoPending: true, label: 'S3:doc1' })
    verifyDocInvariants(doc2, { expectNoPending: true, label: 'S3:doc2' })
  } finally {
    for (let i = 0; i < renderers.length; i++) {
      renderers[i].destroy()
    }
    um1.destroy()
    doc1.destroy()
    doc2.destroy()
  }
}

/**
 * Suite 4: Snapshot & V1/V2 Diff/Merge/Intersect Algebraic Oracle.
 * Interleaves Snapshot V1/V2 encoding, ContentIds extraction, V1<->V2 conversions,
 * diffUpdate/diffUpdateV2, intersectUpdateWithContentIds/V2 past-state restoration,
 * shuffled+duplicate mergeUpdates/V2, and obfuscateUpdate/V2 across out-of-order updates + UndoManager + GC.
 *
 * @param {number} seed
 * @param {IntensityConfig} cfg
 * @param {Array<string>} trace
 */
const runSnapshotWireAlgebraOracle = (seed, cfg, trace) => {
  const gen = prng.create(seed + 30013)
  const numPeers = cfg.s4Peers
  /** @type {Array<Y.Doc>} */
  const extraDocs = []
  /** @param {Y.Doc} d */
  const own = d => { extraDocs.push(d); return d }

  /** @type {Array<{ doc: Y.Doc, um: Y.UndoManager | null, inbox: Array<{ fmt: 'v1' | 'v2', data: Uint8Array<ArrayBuffer> }> }>} */
  const peers = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const allV1 = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const allV2 = []

  try {
    for (let i = 0; i < numPeers; i++) {
      // Peer 0 always gc:false so we can capture exact past-state ContentIds for intersectUpdateWithContentIds!
      const doc = new Y.Doc({ gc: i === 0 ? false : (i % 2 === 1) })
      doc.clientID = 500 + i
      const um = i === 0 ? new Y.UndoManager([doc.get('root'), doc.get('rich')], { captureTimeout: 0 }) : null
      peers.push({ doc, um, inbox: [] })
      doc.on('update', (u, origin) => {
        if (origin === NETWORK_ORIGIN) return
        allV1.push(u)
        for (let j = 0; j < peers.length; j++) {
          if (j !== i && prng.bool(gen)) peers[j].inbox.push({ fmt: 'v1', data: u })
        }
      })
      doc.on('updateV2', (u2, origin) => {
        if (origin === NETWORK_ORIGIN) return
        allV2.push(u2)
        for (let j = 0; j < peers.length; j++) {
          if (j !== i && prng.bool(gen)) peers[j].inbox.push({ fmt: 'v2', data: u2 })
        }
      })
    }

    /**
     * Verify Snapshot V1/V2, ContentIds, SV-from-update, and V1<->V2 roundtrips on a Doc.
     *
     * @param {Y.Doc} doc
     * @param {string} tag
     */
    const verifySnapshotAndUpdateAlgebra = (doc, tag) => {
      const snap = Y.snapshot(doc)
      const s1 = Y.decodeSnapshot(Y.encodeSnapshot(snap))
      const s2 = Y.decodeSnapshotV2(Y.encodeSnapshotV2(snap))
      assertInvariant(Y.equalSnapshots(snap, s1), `${tag}: Snapshot V1 encode/decode mismatch`)
      assertInvariant(Y.equalSnapshots(snap, s2), `${tag}: Snapshot V2 encode/decode mismatch`)

      const cidsFull = Y.createContentIdsFromDoc(doc, true)
      const cidsVis = Y.createContentIdsFromDoc(doc, false)
      assertInvariant(
        Y.equalContentIds(cidsFull, Y.decodeContentIds(Y.encodeContentIds(cidsFull))),
        `${tag}: ContentIds(full) encode/decode mismatch`
      )
      assertInvariant(
        Y.equalContentIds(cidsVis, Y.decodeContentIds(Y.encodeContentIds(cidsVis))),
        `${tag}: ContentIds(visible) encode/decode mismatch`
      )
      if (doc.store.skips.isEmpty()) {
        assertInvariant(
          Y.equalContentIds(Y.createContentIdsFromSnapshot(snap, true), cidsFull),
          `${tag}: createContentIdsFromSnapshot(true) !== createContentIdsFromDoc(true)`
        )
        assertInvariant(
          Y.equalContentIds(Y.createContentIdsFromSnapshot(snap, false), cidsVis),
          `${tag}: createContentIdsFromSnapshot(false) !== createContentIdsFromDoc(false)`
        )
      }

      const u1 = Y.encodeStateAsUpdate(doc)
      const u2 = Y.encodeStateAsUpdateV2(doc)
      const sv = Y.encodeStateVector(doc)
      assertInvariant(
        equalBytes(Y.encodeStateVectorFromUpdate(u1), sv),
        `${tag}: encodeStateVectorFromUpdate(V1) !== encodeStateVector`
      )
      assertInvariant(
        equalBytes(Y.encodeStateVectorFromUpdateV2(u2), sv),
        `${tag}: encodeStateVectorFromUpdateV2(V2) !== encodeStateVector`
      )
      assertInvariant(
        Y.equalContentIds(Y.createContentIdsFromUpdate(u1), Y.createContentIdsFromUpdateV2(u2)),
        `${tag}: createContentIdsFromUpdate(V1) !== createContentIdsFromUpdateV2(V2)`
      )

      const rt1 = own(new Y.Doc({ gc: doc.gc }))
      Y.applyUpdate(rt1, u1)
      const canonicalV1 = Y.encodeStateAsUpdate(rt1)
      const canonicalV2 = Y.encodeStateAsUpdateV2(rt1)

      const d12 = own(new Y.Doc({ gc: doc.gc }))
      Y.applyUpdateV2(d12, Y.convertUpdateFormatV1ToV2(u1))
      assertInvariant(equalBytes(Y.encodeStateAsUpdate(d12), canonicalV1), `${tag}: V1->V2 conversion altered canonical V1 wire bytes`)

      const d21 = own(new Y.Doc({ gc: doc.gc }))
      Y.applyUpdate(d21, Y.convertUpdateFormatV2ToV1(u2))
      assertInvariant(equalBytes(Y.encodeStateAsUpdateV2(d21), canonicalV2), `${tag}: V2->V1 conversion altered canonical V2 wire bytes`)
    }

    const half = math.floor(cfg.s4Steps / 2)
    /** @type {Y.Doc | null} */
    let pastClone = null
    /** @type {import('../../src/utils/ids.js').ContentIds | null} */
    let pastCids = null
    /** @type {Uint8Array<ArrayBuffer> | null} */
    let pastSV = null

    for (let step = 0; step < cfg.s4Steps; step++) {
      const pIdx = prng.uint32(gen, 0, numPeers - 1)
      const p = peers[pIdx]
      if (p.um !== null && p.um.undoStack.length > 0 && prng.uint32(gen, 0, 5) === 0) {
        p.um.undo()
        pushTrace(trace, `S4:s${step}:p${pIdx}:undo`)
      } else if (p.um !== null && p.um.redoStack.length > 0 && prng.uint32(gen, 0, 5) === 0) {
        p.um.redo()
        pushTrace(trace, `S4:s${step}:p${pIdx}:redo`)
      } else if (prng.bool(gen)) {
        pushTrace(trace, `S4:s${step}:p${pIdx}:root:${mutateUnifiedNode(p.doc.get('root'), gen, 0)}`)
      } else {
        pushTrace(trace, `S4:s${step}:p${pIdx}:rich:${mutateRichText(p.doc.get('rich'), gen)}`)
      }
      if (p.um !== null && prng.bool(gen)) p.um.stopCapturing()

      // Deliver 1-2 out-of-order updates
      for (let d = 0; d < 2; d++) {
        const target = peers[prng.uint32(gen, 0, numPeers - 1)]
        if (target.inbox.length > 0) {
          const pick = prng.uint32(gen, 0, target.inbox.length - 1)
          const msg = target.inbox.splice(pick, 1)[0]
          if (msg.fmt === 'v1') {
            Y.applyUpdate(target.doc, msg.data, NETWORK_ORIGIN)
          } else {
            Y.applyUpdateV2(target.doc, msg.data, NETWORK_ORIGIN)
          }
        }
      }

      if (step === half) {
        // Sync peer 0 with full states at midpoint (gc:false, no skips) to capture an exact past-state checkpoint
        for (let i = 1; i < numPeers; i++) {
          Y.applyUpdate(peers[0].doc, Y.encodeStateAsUpdate(peers[i].doc), NETWORK_ORIGIN)
        }
        verifySnapshotAndUpdateAlgebra(peers[0].doc, 'S4:midpoint')
        pastClone = own(Y.cloneDoc(peers[0].doc, { gc: false }))
        pastCids = Y.createContentIdsFromDoc(pastClone, true)
        pastSV = Y.encodeStateVector(pastClone)
      }
    }

    // Drain all inboxes and fully converge all peers
    for (let i = 0; i < numPeers; i++) {
      while (peers[i].inbox.length > 0) {
        const msg = peers[i].inbox.pop()
        if (msg !== undefined) {
          if (msg.fmt === 'v1') Y.applyUpdate(peers[i].doc, msg.data, NETWORK_ORIGIN)
          else Y.applyUpdateV2(peers[i].doc, msg.data, NETWORK_ORIGIN)
        }
      }
    }
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < numPeers; i++) {
        const next = peers[(i + 1) % numPeers]
        const sv = Y.encodeStateVector(next.doc)
        Y.applyUpdate(next.doc, Y.encodeStateAsUpdate(peers[i].doc, sv), NETWORK_ORIGIN)
      }
      if (round >= 1) {
        const refCids = Y.createContentIdsFromDoc(peers[0].doc, true)
        let allSynced = peers[0].doc.store.pendingStructs === null && peers[0].doc.store.pendingDs === null
        for (let i = 1; allSynced && i < numPeers; i++) {
          const d = peers[i].doc
          if (
            d.store.pendingStructs !== null ||
            d.store.pendingDs !== null ||
            !Y.equalContentIds(refCids, Y.createContentIdsFromDoc(d, true))
          ) {
            allSynced = false
          }
        }
        if (allSynced) break
      }
    }

    const fullDoc = peers[0].doc
    verifySnapshotAndUpdateAlgebra(fullDoc, 'S4:final')
    const fullV1 = Y.encodeStateAsUpdate(fullDoc)
    const fullV2 = Y.encodeStateAsUpdateV2(fullDoc)
    const canonicalFullDoc = own(Y.cloneDoc(fullDoc, { gc: false }))
    const canonicalFullV1 = Y.encodeStateAsUpdate(canonicalFullDoc)
    const canonicalFullV2 = Y.encodeStateAsUpdateV2(canonicalFullDoc)

    // DiffUpdate V1 & V2 algebraic law against midpoint pastClone
    if (pastClone !== null && pastSV !== null && pastCids !== null) {
      const viaDiff1 = own(Y.cloneDoc(pastClone, { gc: false }))
      Y.applyUpdate(viaDiff1, Y.diffUpdate(fullV1, pastSV))
      assertInvariant(equalBytes(Y.encodeStateAsUpdate(viaDiff1), canonicalFullV1), 'S4: diffUpdate(V1) failed to reconstruct canonical fullDoc')

      const viaDiff2 = own(Y.cloneDoc(pastClone, { gc: false }))
      Y.applyUpdateV2(viaDiff2, Y.diffUpdateV2(fullV2, pastSV))
      assertInvariant(equalBytes(Y.encodeStateAsUpdateV2(viaDiff2), canonicalFullV2), 'S4: diffUpdateV2(V2) failed to reconstruct canonical fullDoc')

      // IntersectUpdateWithContentIds V1 & V2 past-state restoration law
      const inter1 = Y.intersectUpdateWithContentIds(fullV1, pastCids)
      const inter2 = Y.intersectUpdateWithContentIdsV2(fullV2, pastCids)
      const restored1 = own(new Y.Doc({ gc: false }))
      const restored2 = own(new Y.Doc({ gc: false }))
      Y.applyUpdate(restored1, inter1)
      Y.applyUpdateV2(restored2, inter2)
      verifyConvergence([pastClone, restored1, restored2], ['root', 'rich'], { compareStores: false, checkRoundtrip: false })
    }

    // Shuffled + duplicate-injected mergeUpdates V1 & V2 law
    const shufV1 = shuffleCopy(gen, allV1)
    const shufV2 = shuffleCopy(gen, allV2)
    if (shufV1.length > 2) shufV1.push(shufV1[0], shufV1[shufV1.length - 1])
    if (shufV2.length > 2) shufV2.push(shufV2[0], shufV2[shufV2.length - 1])
    const mergedDoc1 = own(new Y.Doc({ gc: false }))
    const mergedDoc2 = own(new Y.Doc({ gc: false }))
    Y.applyUpdate(mergedDoc1, Y.mergeUpdates(shufV1))
    Y.applyUpdateV2(mergedDoc2, Y.mergeUpdatesV2(shufV2))

    verifyConvergence([...peers.map(p => p.doc), mergedDoc1, mergedDoc2], ['root', 'rich'], { compareStores: false, checkRoundtrip: true })

    // ObfuscateUpdate V1 & V2 structural invariant & SV preservation check
    const obf1 = own(new Y.Doc({ gc: false }))
    Y.applyUpdate(obf1, Y.obfuscateUpdate(fullV1))
    verifyDocInvariants(obf1, { expectNoPending: true, label: 'S4:obfuscateV1' })
    assertInvariant(equalBytes(Y.encodeStateVector(obf1), Y.encodeStateVector(fullDoc)), 'S4: obfuscateUpdate altered StateVector')

    const obf2 = own(new Y.Doc({ gc: false }))
    Y.applyUpdateV2(obf2, Y.obfuscateUpdateV2(fullV2))
    verifyDocInvariants(obf2, { expectNoPending: true, label: 'S4:obfuscateV2' })
    assertInvariant(equalBytes(Y.encodeStateVector(obf2), Y.encodeStateVector(fullDoc)), 'S4: obfuscateUpdateV2 altered StateVector')
  } finally {
    for (let i = 0; i < extraDocs.length; i++) {
      extraDocs[i].destroy()
    }
    for (let i = 0; i < peers.length; i++) {
      peers[i].um?.destroy()
      peers[i].doc.destroy()
    }
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20260505
  /** @type {number | null} */
  let seeds = null
  /** @type {Intensity} */
  let intensity = 'medium'
  let suite = 'all'
  let reportOnly = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--seeds' && i + 1 < argv.length) {
      seeds = Number.parseInt(argv[++i], 10)
    } else if (arg === '--intensity' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'low' || val === 'medium' || val === 'high') {
        intensity = val
      } else {
        console.error(`Invalid --intensity "${val}" (expected low|medium|high)`)
        process.exit(2)
      }
    } else if (arg === '--suite' && i + 1 < argv.length) {
      suite = argv[++i]
    } else if (arg === '--report') {
      reportOnly = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/v14-delta-attribution-fuzzer.js [--seed N] [--seeds N] [--intensity low|medium|high] [--suite 1|2|3|4|all] [--report]')
      process.exit(0)
    }
  }
  const cfg = INTENSITY_CONFIG[intensity]
  return { seed, seeds: seeds ?? cfg.defaultSeeds, intensity, cfg, suite, reportOnly }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const t0 = performance.now()

  /** @type {Array<{ id: string, name: string, fn: (seed: number, cfg: IntensityConfig, trace: Array<string>) => void }>} */
  const allSuites = [
    { id: '1', name: 'live-delta-vs-fresh-oracle', fn: runLiveDeltaOracle },
    { id: '2', name: 'attributed-and-diff-renderer-fuzzer', fn: runRendererFuzzer },
    { id: '3', name: 'relative-and-delta-position-fuzzer', fn: runPositionFuzzer },
    { id: '4', name: 'snapshot-v1-v2-wire-algebra-oracle', fn: runSnapshotWireAlgebraOracle }
  ]
  const selected = args.suite === 'all' ? allSuites : allSuites.filter(s => s.id === args.suite || s.name.includes(args.suite))
  if (selected.length === 0) {
    console.error(`Unknown --suite "${args.suite}" (expected 1|2|3|4|all)`)
    process.exit(2)
  }

  console.log(`=== Yjs v14 Delta, Attribution, Position & Wire Algebra Fuzzer (intensity=${args.intensity}, seeds=${args.seeds}, baseSeed=${args.seed}) ===`)

  let passed = 0
  let failed = 0
  /** @type {Array<{ suite: string, seed: number, error: string, repro: string, trace: Array<string> }>} */
  const failures = []

  for (let si = 0; si < selected.length; si++) {
    const s = selected[si]
    let suitePass = 0
    let suiteFail = 0
    const st0 = performance.now()
    for (let r = 0; r < args.seeds; r++) {
      const runSeed = args.seed + r * 9973
      /** @type {Array<string>} */
      const trace = []
      try {
        s.fn(runSeed, args.cfg, trace)
        passed++
        suitePass++
      } catch (err) {
        failed++
        suiteFail++
        const msg = err instanceof Error ? err.message : String(err)
        const repro = `node ./tests/lab/v14-delta-attribution-fuzzer.js --seed ${runSeed} --seeds 1 --suite ${s.id} --intensity ${args.intensity}`
        failures.push({ suite: `${s.id}:${s.name}`, seed: runSeed, error: msg, repro, trace: trace.slice(-12) })
      }
    }
    const ms = (performance.now() - st0).toFixed(1)
    const status = suiteFail === 0 ? 'PASS' : 'FAIL'
    console.log(`  [${status}] Suite ${s.id} (${s.name.padEnd(36)}) ${suitePass}/${args.seeds} seeds passed (${ms}ms)`)
  }

  if (failures.length > 0) {
    console.log('\n--- Discovered Failures (with minimal reproducer commands & op traces) ---')
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i]
      console.log(`  [${i + 1}] ${f.suite} seed=${f.seed}`)
      console.log(`      repro: ${f.repro}`)
      console.log(`      error: ${f.error}`)
      console.log(`      trace: ${f.trace.join(' -> ')}`)
    }
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed in ${(performance.now() - t0).toFixed(1)}ms ===`)
  if (failed > 0 && !args.reportOnly) {
    process.exit(1)
  }
}
