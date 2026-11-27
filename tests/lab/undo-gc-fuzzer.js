import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as delta from 'lib0/delta'
import {
  verifyDocInvariants,
  verifyConvergence,
  deepEqualValues,
  equalBytes,
  assertInvariant
} from './invariants.js'

const ROOT_KEYS = ['text', 'array', 'map', 'xml']
const MAP_KEYS = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']
const XML_TAGS = ['div', 'p', 'span', 'section']
const XML_ATTRS = ['id', 'class', 'data-k']

/**
 * @typedef {Record<string, string | number | boolean | null>} FormatMap
 */

/** @type {Array<FormatMap>} */
const INSERT_FORMATS = [
  { bold: true },
  { italic: true }
]

/** @type {Array<FormatMap>} */
const FORMATS = [
  { bold: true },
  { bold: null },
  { italic: true },
  { italic: null },
  { color: '#d22' },
  { color: null }
]

/**
 * @typedef {{
 *   name: string,
 *   defaultClients: number,
 *   gcMode: 'all-on' | 'all-off' | 'mixed',
 *   undoRatio: number,
 *   dupRate: number,
 *   clusterCount: number,
 *   nestedWeight: number,
 *   clearProb: number
 * }} UndoGcScenario
 */

/** @type {Array<UndoGcScenario>} */
const SCENARIOS = [
  {
    name: 'undo-gc-on-cluster-split',
    defaultClients: 12,
    gcMode: 'all-on',
    undoRatio: 0.7,
    dupRate: 0.3,
    clusterCount: 3,
    nestedWeight: 0.45,
    clearProb: 0.08
  },
  {
    name: 'undo-mixed-gc-heavy-dups',
    defaultClients: 14,
    gcMode: 'mixed',
    undoRatio: 0.75,
    dupRate: 0.4,
    clusterCount: 3,
    nestedWeight: 0.5,
    clearProb: 0.1
  },
  {
    name: 'undo-gc-on-deep-subtrees',
    defaultClients: 15,
    gcMode: 'all-on',
    undoRatio: 0.65,
    dupRate: 0.25,
    clusterCount: 2,
    nestedWeight: 0.65,
    clearProb: 0.12
  },
  {
    name: 'undo-gc-off-canonical',
    defaultClients: 10,
    gcMode: 'all-off',
    undoRatio: 0.8,
    dupRate: 0.35,
    clusterCount: 3,
    nestedWeight: 0.45,
    clearProb: 0.08
  }
]

/**
 * @typedef {{
 *   from: number,
 *   update: Uint8Array<ArrayBuffer>,
 *   format: 'v1' | 'v2'
 * }} Packet
 */

/**
 * @typedef {{
 *   index: number,
 *   doc: Doc,
 *   um: UndoManager | null,
 *   cluster: number,
 *   online: boolean,
 *   inbox: Array<Packet>,
 *   historyV1: Array<Uint8Array<ArrayBuffer>>,
 *   historyV2: Array<Uint8Array<ArrayBuffer>>
 * }} Peer
 */

/**
 * @typedef {{
 *   ops: number,
 *   undos: number,
 *   redos: number,
 *   clears: number,
 *   gcSubtreeAttacks: number,
 *   delivered: number,
 *   duplicates: number,
 *   batchMerges: number,
 *   diffSyncs: number,
 *   cloneChecks: number,
 *   idempotencyChecks: number,
 *   lawChecks: number,
 *   maxSkips: number,
 *   maxPending: number
 * }} UndoGcStats
 */

/**
 * Generate a short deterministic string.
 *
 * @param {prng.PRNG} gen
 * @param {number} maxLen
 * @return {string}
 */
const randStr = (gen, maxLen) => {
  const chars = 'abcXYZ012 \n'
  const len = prng.uint32(gen, 1, maxLen)
  let s = ''
  for (let i = 0; i < len; i++) {
    s += chars[prng.uint32(gen, 0, chars.length - 1)]
  }
  return s
}

/**
 * Generate a deterministic scalar or small object value.
 *
 * @param {prng.PRNG} gen
 * @return {string | number | boolean | null | { v: number }}
 */
const randVal = gen => {
  const k = prng.uint32(gen, 0, 4)
  if (k === 0) return prng.int32(gen, -500, 500)
  if (k === 1) return randStr(gen, 4)
  if (k === 2) return prng.bool(gen)
  if (k === 3) return null
  return { v: prng.uint32(gen, 0, 99) }
}

/**
 * Edit text root (insert, format, delete, rich delta).
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 */
const editText = (doc, gen) => {
  const ytext = doc.get('text')
  const len = ytext.length
  const op = prng.uint32(gen, 0, 3)
  if (len === 0 || op === 0) {
    const pos = prng.uint32(gen, 0, len)
    if (prng.bool(gen)) {
      ytext.insert(pos, randStr(gen, 4), prng.oneOf(gen, INSERT_FORMATS))
    } else {
      ytext.insert(pos, randStr(gen, 4))
    }
  } else if (op === 1) {
    const pos = prng.uint32(gen, 0, len - 1)
    const delLen = math.min(prng.uint32(gen, 1, 4), len - pos)
    ytext.delete(pos, delLen)
  } else if (op === 2) {
    const pos = prng.uint32(gen, 0, len - 1)
    const span = math.min(prng.uint32(gen, 1, 4), len - pos)
    ytext.format(pos, span, prng.oneOf(gen, FORMATS))
  } else {
    const pos = prng.uint32(gen, 0, math.max(0, len - 1))
    const d = delta.create().retain(pos).insert(randStr(gen, 3), { bold: true })
    if (pos < len) {
      d.delete(math.min(2, len - pos))
    }
    ytext.applyDelta(d)
  }
}

/**
 * Edit array root with heavy nested Y.Node subtree creation, edits, and deletions.
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 * @param {number} nestedWeight
 */
const editArray = (doc, gen, nestedWeight) => {
  const yarr = doc.get('array')
  const len = yarr.length
  const r = prng.real53(gen)
  if (len === 0 || r < nestedWeight * 0.5) {
    const pos = prng.uint32(gen, 0, len)
    const child = new Y.Node()
    yarr.insert(pos, [child])
    child.insert(0, randStr(gen, 4))
    child.setAttr('tag', prng.uint32(gen, 0, 9))
  } else if (r < nestedWeight) {
    const idx = prng.uint32(gen, 0, len - 1)
    const cur = yarr.get(idx)
    if (cur instanceof Y.Node) {
      const sub = prng.uint32(gen, 0, 3)
      if (sub === 0) {
        cur.insert(prng.uint32(gen, 0, cur.length), randStr(gen, 3))
      } else if (sub === 1 && cur.length > 0) {
        cur.delete(prng.uint32(gen, 0, cur.length - 1), 1)
      } else if (sub === 2) {
        cur.setAttr(prng.oneOf(gen, ['tag', 'note']), randVal(gen))
      } else {
        cur.deleteAttr('note')
      }
    } else {
      yarr.insert(idx, [randVal(gen)])
    }
  } else if (r < 0.72) {
    yarr.insert(prng.uint32(gen, 0, len), [randVal(gen), randVal(gen)])
  } else {
    const pos = prng.uint32(gen, 0, len - 1)
    yarr.delete(pos, math.min(prng.uint32(gen, 1, 2), len - pos))
  }
}

/**
 * Edit map root with nested Y.Node subtrees and attribute churn.
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 * @param {number} nestedWeight
 */
const editMap = (doc, gen, nestedWeight) => {
  const ymap = doc.get('map')
  const key = prng.oneOf(gen, MAP_KEYS)
  const r = prng.real53(gen)
  if (r < nestedWeight * 0.45) {
    const sub = new Y.Node()
    ymap.setAttr(key, sub)
    sub.setAttr('a', prng.uint32(gen, 0, 50))
    sub.insert(0, [prng.uint32(gen, 0, 20)])
  } else if (r < nestedWeight) {
    const cur = ymap.getAttr(key)
    if (cur instanceof Y.Node) {
      if (prng.bool(gen)) {
        cur.setAttr(prng.oneOf(gen, ['a', 'b']), randVal(gen))
      } else if (cur.length > 0 && prng.bool(gen)) {
        cur.delete(prng.uint32(gen, 0, cur.length - 1), 1)
      } else {
        cur.insert(prng.uint32(gen, 0, cur.length), [prng.uint32(gen, 0, 20)])
      }
    } else {
      ymap.setAttr(key, randVal(gen))
    }
  } else if (r < 0.72) {
    ymap.setAttr(key, randVal(gen))
  } else {
    ymap.deleteAttr(key)
  }
}

/**
 * Edit XML root with nested tagged Y.Node trees.
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 */
const editXml = (doc, gen) => {
  const yxml = doc.get('xml')
  const len = yxml.length
  const op = prng.uint32(gen, 0, 3)
  if (len === 0 || op === 0) {
    const el = new Y.Node(prng.oneOf(gen, XML_TAGS))
    yxml.insert(prng.uint32(gen, 0, len), [el])
    el.setAttr(prng.oneOf(gen, XML_ATTRS), `v${prng.uint32(gen, 0, 9)}`)
    const inner = new Y.Node('span')
    el.insert(0, [inner])
    inner.insert(0, randStr(gen, 3))
  } else if (op === 1 || op === 2) {
    const child = yxml.get(prng.uint32(gen, 0, len - 1))
    if (child instanceof Y.Node) {
      if (prng.bool(gen)) {
        child.setAttr(prng.oneOf(gen, XML_ATTRS), `x${prng.uint32(gen, 0, 9)}`)
      } else if (child.length > 0 && prng.bool(gen)) {
        child.delete(prng.uint32(gen, 0, child.length - 1), 1)
      } else {
        const sub = new Y.Node(prng.oneOf(gen, XML_TAGS))
        child.insert(prng.uint32(gen, 0, child.length), [sub])
        sub.insert(0, randStr(gen, 3))
      }
    }
  } else {
    const pos = prng.uint32(gen, 0, len - 1)
    yxml.delete(pos, 1)
  }
}

/**
 * Deterministically shuffle a copy of an array.
 *
 * @template T
 * @param {prng.PRNG} gen
 * @param {Array<T>} arr
 * @return {Array<T>}
 */
const shuffleCopy = (gen, arr) => {
  const copy = arr.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = prng.uint32(gen, 0, i)
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

/**
 * Verify that applying an already-seen update is strictly idempotent (zero state change).
 *
 * @param {Doc} doc
 * @param {Uint8Array<ArrayBuffer>} update
 * @param {'v1' | 'v2'} fmt
 * @param {string} origin
 * @param {string} label
 */
const assertIdempotentReplay = (doc, update, fmt, origin, label) => {
  const svBefore = Y.encodeStateVector(doc)
  const jsonBefore = doc.toJSON()
  if (fmt === 'v1') {
    Y.applyUpdate(doc, update, origin)
  } else {
    Y.applyUpdateV2(doc, update, origin)
  }
  verifyDocInvariants(doc, { expectNoPending: false, label: `${label}:post-dup` })
  assertInvariant(
    equalBytes(svBefore, Y.encodeStateVector(doc)),
    `${label}: duplicate ${fmt} replay altered StateVector!`
  )
  const cmp = deepEqualValues(jsonBefore, doc.toJSON(), `${label}.toJSON`)
  assertInvariant(cmp.equal, `${label}: duplicate ${fmt} replay altered doc JSON (${cmp.reason})`)
}

/**
 * Compare two Docs for algebraic law equivalence (strict `verifyConvergence` when
 * neither has unresolved external pending/skips, and full SV + ContentIds + deep
 * semantic + invariant equality otherwise).
 *
 * @param {Array<Doc>} docs
 * @param {string} label
 */
const assertLawEquivalence = (docs, label) => {
  let allComplete = true
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]
    verifyDocInvariants(d, { expectNoPending: false, label: `${label}[${i}]` })
    if (d.store.pendingStructs !== null || d.store.pendingDs !== null || !d.store.skips.isEmpty()) {
      allComplete = false
    }
  }
  if (allComplete) {
    verifyConvergence(docs, ROOT_KEYS, { checkRoundtrip: false })
    return
  }
  const d0 = docs[0]
  const sv0 = Y.encodeStateVector(d0)
  const cidsFull0 = Y.createContentIdsFromDoc(d0, true)
  const cidsVis0 = Y.createContentIdsFromDoc(d0, false)
  const json0 = d0.toJSON()
  for (let i = 1; i < docs.length; i++) {
    const di = docs[i]
    assertInvariant(
      equalBytes(sv0, Y.encodeStateVector(di)),
      `${label}: StateVector mismatch between doc[0] and doc[${i}]`
    )
    assertInvariant(
      Y.equalContentIds(cidsFull0, Y.createContentIdsFromDoc(di, true)),
      `${label}: ContentIds(full) mismatch between doc[0] and doc[${i}]`
    )
    assertInvariant(
      Y.equalContentIds(cidsVis0, Y.createContentIdsFromDoc(di, false)),
      `${label}: ContentIds(visible) mismatch between doc[0] and doc[${i}]`
    )
    const cmp = deepEqualValues(json0, di.toJSON(), `${label}.toJSON`)
    assertInvariant(cmp.equal, `${label}: JSON mismatch between doc[0] and doc[${i}] (${cmp.reason})`)
    for (let k = 0; k < ROOT_KEYS.length; k++) {
      const key = ROOT_KEYS[k]
      assertInvariant(
        d0.get(key).toDeltaDeep().equals(di.get(key).toDeltaDeep()),
        `${label}: root '${key}' toDeltaDeep mismatch between doc[0] and doc[${i}]`
      )
    }
  }
}

/**
 * Verify CRDT algebraic laws (Commutativity, Associativity, Idempotency) on
 * a triple of live diverged updates (both V1 and V2 formats).
 *
 * @param {{
 *   uA: Uint8Array<ArrayBuffer>,
 *   uB: Uint8Array<ArrayBuffer>,
 *   uC: Uint8Array<ArrayBuffer>,
 *   format: 'v1' | 'v2',
 *   gc: boolean,
 *   label: string
 * }} params
 */
const verifyAlgebraicLawsOnTriple = ({ uA, uB, uC, format, gc, label }) => {
  const apply = format === 'v1' ? Y.applyUpdate : Y.applyUpdateV2
  const merge = format === 'v1' ? Y.mergeUpdates : Y.mergeUpdatesV2

  const docAB = new Y.Doc({ gc })
  const docBA = new Y.Doc({ gc })
  const docLeft = new Y.Doc({ gc })
  const docRight = new Y.Doc({ gc })
  const docOnce = new Y.Doc({ gc })
  const docTwice = new Y.Doc({ gc })
  const docDupMerge = new Y.Doc({ gc })

  try {
    // 1. Commutativity: apply(uA); apply(uB) === apply(uB); apply(uA)
    apply(docAB, uA)
    apply(docAB, uB)
    apply(docBA, uB)
    apply(docBA, uA)

    // 2. Associativity: merge([merge([uA, uB]), uC]) === merge([uA, merge([uB, uC])])
    const leftAssoc = merge([merge([uA, uB]), uC])
    const rightAssoc = merge([uA, merge([uB, uC])])
    apply(docLeft, leftAssoc)
    apply(docRight, rightAssoc)

    // 3. Idempotency: apply(uA) === apply(uA); apply(uA) === apply(merge([uA, uA]))
    apply(docOnce, uA)
    apply(docTwice, uA)
    apply(docTwice, uA)
    apply(docDupMerge, merge([uA, uA]))

    assertLawEquivalence([docAB, docBA], `${label}(${format}):commutativity`)
    assertLawEquivalence([docLeft, docRight], `${label}(${format}):associativity`)
    assertLawEquivalence([docOnce, docTwice, docDupMerge], `${label}(${format}):idempotency`)
  } finally {
    docAB.destroy()
    docBA.destroy()
    docLeft.destroy()
    docRight.destroy()
    docOnce.destroy()
    docTwice.destroy()
    docDupMerge.destroy()
  }
}

/**
 * Verify CRDT algebraic laws on incremental (potentially gapped/out-of-order) update triples.
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} updates
 * @param {'v1' | 'v2'} format
 * @param {prng.PRNG} gen
 * @param {boolean} gc
 * @param {string} label
 */
const verifyIncrementalTripleLaws = (updates, format, gen, gc, label) => {
  if (updates.length < 3) return
  const uA = prng.oneOf(gen, updates)
  const uB = prng.oneOf(gen, updates)
  const uC = prng.oneOf(gen, updates)
  const apply = format === 'v1' ? Y.applyUpdate : Y.applyUpdateV2
  const merge = format === 'v1' ? Y.mergeUpdates : Y.mergeUpdatesV2

  // Associativity on raw incremental updates (may contain Skips / pendingStructs)
  const docL = new Y.Doc({ gc })
  const docR = new Y.Doc({ gc })
  const docAB = new Y.Doc({ gc })
  const docBA = new Y.Doc({ gc })
  const docIdem1 = new Y.Doc({ gc })
  const docIdem2 = new Y.Doc({ gc })
  try {
    apply(docL, merge([merge([uA, uB]), uC]))
    apply(docR, merge([uA, merge([uB, uC])]))
    verifyDocInvariants(docL, { expectNoPending: false, label: `${label}:incAssocL` })
    verifyDocInvariants(docR, { expectNoPending: false, label: `${label}:incAssocR` })
    assertInvariant(
      equalBytes(Y.encodeStateVector(docL), Y.encodeStateVector(docR)),
      `${label}(${format}): incremental associativity SV mismatch`
    )
    const assocCmp = deepEqualValues(docL.toJSON(), docR.toJSON(), `${label}.incAssoc`)
    assertInvariant(assocCmp.equal, `${label}(${format}): incremental associativity JSON mismatch (${assocCmp.reason})`)

    apply(docAB, uA)
    apply(docAB, uB)
    apply(docBA, uB)
    apply(docBA, uA)
    verifyDocInvariants(docAB, { expectNoPending: false, label: `${label}:incCommAB` })
    verifyDocInvariants(docBA, { expectNoPending: false, label: `${label}:incCommBA` })
    assertInvariant(
      equalBytes(Y.encodeStateVector(docAB), Y.encodeStateVector(docBA)),
      `${label}(${format}): incremental commutativity SV mismatch`
    )
    const commCmp = deepEqualValues(docAB.toJSON(), docBA.toJSON(), `${label}.incComm`)
    assertInvariant(commCmp.equal, `${label}(${format}): incremental commutativity JSON mismatch (${commCmp.reason})`)

    apply(docIdem1, uA)
    apply(docIdem2, uA)
    apply(docIdem2, uA)
    verifyDocInvariants(docIdem1, { expectNoPending: false, label: `${label}:incIdem1` })
    verifyDocInvariants(docIdem2, { expectNoPending: false, label: `${label}:incIdem2` })
    assertInvariant(
      equalBytes(Y.encodeStateVector(docIdem1), Y.encodeStateVector(docIdem2)),
      `${label}(${format}): incremental idempotency SV mismatch`
    )
  } finally {
    docL.destroy()
    docR.destroy()
    docAB.destroy()
    docBA.destroy()
    docIdem1.destroy()
    docIdem2.destroy()
  }
}

/**
 * Execute one deterministic extreme UndoManager + GC + Partition + Duplicate-Replay fuzz run.
 *
 * @param {{
 *   seed: number,
 *   scenario: UndoGcScenario,
 *   ops: number,
 *   clientsOverride?: number | null
 * }} params
 * @return {UndoGcStats}
 */
export const runUndoGcScenario = ({ seed, scenario, ops, clientsOverride = null }) => {
  const gen = prng.create(seed)
  const numClients = clientsOverride !== null ? clientsOverride : scenario.defaultClients
  const NET_ORIGIN = 'undo-gc-net'

  /** @type {UndoGcStats} */
  const stats = {
    ops: 0,
    undos: 0,
    redos: 0,
    clears: 0,
    gcSubtreeAttacks: 0,
    delivered: 0,
    duplicates: 0,
    batchMerges: 0,
    diffSyncs: 0,
    cloneChecks: 0,
    idempotencyChecks: 0,
    lawChecks: 0,
    maxSkips: 0,
    maxPending: 0
  }

  /** @type {Array<{ uA: Uint8Array<ArrayBuffer>, uB: Uint8Array<ArrayBuffer>, uC: Uint8Array<ArrayBuffer>, format: 'v1' | 'v2' }>} */
  const capturedTriples = []

  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const allV1 = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const allV2 = []

  // Distinct deterministic randomized clientIDs
  /** @type {Set<number>} */
  const usedIds = new Set()
  /** @type {Array<number>} */
  const cids = []
  while (cids.length < numClients) {
    const cid = prng.uint32(gen, 1, 2000000)
    if (!usedIds.has(cid)) {
      usedIds.add(cid)
      cids.push(cid)
    }
  }

  const undoCount = math.max(2, math.floor(numClients * scenario.undoRatio))

  /** @type {Array<Peer>} */
  const peers = []

  for (let i = 0; i < numClients; i++) {
    const gc = scenario.gcMode === 'all-on'
      ? true
      : scenario.gcMode === 'all-off'
        ? false
        : (i % 2 === 0)
    const doc = new Y.Doc({ gc })
    doc.clientID = cids[i]
    const roots = ROOT_KEYS.map(k => doc.get(k))
    const um = i < undoCount
      ? new Y.UndoManager(roots, { captureTimeout: 0 })
      : null

    /** @type {Peer} */
    const peer = {
      index: i,
      doc,
      um,
      cluster: i % scenario.clusterCount,
      online: true,
      inbox: [],
      historyV1: [],
      historyV2: []
    }

    doc.on('update', (u, origin) => {
      if (origin === NET_ORIGIN) return
      allV1.push(u)
      if (!peer.online) return
      if (prng.bool(gen)) {
        for (let p = 0; p < peers.length; p++) {
          const dst = peers[p]
          if (dst.index !== peer.index && dst.online && dst.cluster === peer.cluster) {
            const convert = prng.uint32(gen, 0, 3) === 0
            dst.inbox.push({
              from: peer.index,
              update: convert ? Y.convertUpdateFormatV1ToV2(u) : u,
              format: convert ? 'v2' : 'v1'
            })
          }
        }
      }
    })

    doc.on('updateV2', (u2, origin) => {
      if (origin === NET_ORIGIN) return
      allV2.push(u2)
      if (!peer.online) return
      if (prng.bool(gen)) {
        for (let p = 0; p < peers.length; p++) {
          const dst = peers[p]
          if (dst.index !== peer.index && dst.online && dst.cluster === peer.cluster) {
            const convert = prng.uint32(gen, 0, 3) === 0
            dst.inbox.push({
              from: peer.index,
              update: convert ? Y.convertUpdateFormatV2ToV1(u2) : u2,
              format: convert ? 'v1' : 'v2'
            })
          }
        }
      }
    })

    peers.push(peer)
  }

  /**
   * Deliver one out-of-order packet or merged batch to a peer, with heavy duplicate retention.
   *
   * @param {Peer} dst
   * @param {boolean} allowDup
   */
  const deliverOne = (dst, allowDup) => {
    if (dst.inbox.length === 0) return

    // Occasionally batch-merge 2..3 same-format packets out-of-order
    if (dst.inbox.length >= 2 && prng.uint32(gen, 0, 4) === 0) {
      const fmt = dst.inbox[prng.uint32(gen, 0, dst.inbox.length - 1)].format
      /** @type {Array<number>} */
      const idxs = []
      for (let i = 0; i < dst.inbox.length; i++) {
        if (dst.inbox[i].format === fmt) idxs.push(i)
      }
      if (idxs.length >= 2) {
        const count = math.min(prng.uint32(gen, 2, 3), idxs.length)
        /** @type {Array<number>} */
        const picked = []
        for (let k = 0; k < count; k++) {
          const p = prng.uint32(gen, 0, idxs.length - 1)
          picked.push(idxs[p])
          idxs.splice(p, 1)
        }
        picked.sort((a, b) => b - a)
        /** @type {Array<Uint8Array<ArrayBuffer>>} */
        const batch = []
        for (let k = 0; k < picked.length; k++) {
          const idx = picked[k]
          batch.push(dst.inbox[idx].update)
          if (!allowDup || prng.real53(gen) >= scenario.dupRate) {
            dst.inbox.splice(idx, 1)
          } else {
            stats.duplicates++
          }
        }
        if (fmt === 'v1') {
          const merged = Y.mergeUpdates(batch)
          Y.applyUpdate(dst.doc, merged, NET_ORIGIN)
          if (dst.historyV1.length >= 128) dst.historyV1.shift()
          dst.historyV1.push(merged)
        } else {
          const merged = Y.mergeUpdatesV2(batch)
          Y.applyUpdateV2(dst.doc, merged, NET_ORIGIN)
          if (dst.historyV2.length >= 128) dst.historyV2.shift()
          dst.historyV2.push(merged)
        }
        stats.batchMerges++
        stats.delivered++
        return
      }
    }

    // Extreme out-of-order: strongly bias toward newest packets to force Skips & pendingStructs
    const idx = prng.real53(gen) < 0.75
      ? dst.inbox.length - 1
      : prng.uint32(gen, 0, dst.inbox.length - 1)
    const pkt = dst.inbox[idx]
    const keepDup = allowDup && prng.real53(gen) < scenario.dupRate
    if (!keepDup) {
      dst.inbox.splice(idx, 1)
    } else {
      stats.duplicates++
    }
    if (pkt.format === 'v1') {
      Y.applyUpdate(dst.doc, pkt.update, NET_ORIGIN)
      if (dst.historyV1.length >= 128) dst.historyV1.shift()
      dst.historyV1.push(pkt.update)
    } else {
      Y.applyUpdateV2(dst.doc, pkt.update, NET_ORIGIN)
      if (dst.historyV2.length >= 128) dst.historyV2.shift()
      dst.historyV2.push(pkt.update)
    }
    stats.delivered++
  }

  /**
   * Pairwise state-vector sync via encodeStateAsUpdate/V2 or diffUpdate/V2.
   *
   * @param {Peer} src
   * @param {Peer} dst
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
    stats.diffSyncs++
  }

  /** @type {Y.Doc | null} */
  let mergedV1 = null
  /** @type {Y.Doc | null} */
  let mergedV2 = null
  /** @type {Y.Doc | null} */
  let finalClone = null

  try {
    for (let step = 0; step < ops; step++) {
      const peer = peers[prng.uint32(gen, 0, numClients - 1)]

      // 1. Interleaved UndoManager undo / redo / clear(false, true) OR multi-type mutation
      if (peer.um !== null && prng.real53(gen) < scenario.clearProb && (peer.um.canUndo() || peer.um.canRedo())) {
        // Exercise partial stack clears (especially clear(false, true) which stresses ancestor keep!)
        if (peer.um.canRedo() && prng.real53(gen) < 0.75) {
          peer.um.clear(false, true)
        } else {
          peer.um.clear(true, false)
        }
        stats.clears++
      } else if (peer.um !== null && peer.um.canRedo() && prng.uint32(gen, 0, 2) !== 0) {
        peer.um.redo()
        stats.redos++
      } else if (peer.um !== null && peer.um.canUndo() && prng.uint32(gen, 0, 3) === 0) {
        peer.um.undo()
        stats.undos++
      } else {
        const target = prng.uint32(gen, 0, 3)
        if (target === 0) editText(peer.doc, gen)
        else if (target === 1) editArray(peer.doc, gen, scenario.nestedWeight)
        else if (target === 2) editMap(peer.doc, gen, scenario.nestedWeight)
        else editXml(peer.doc, gen)
        if (peer.um !== null && prng.bool(gen)) {
          peer.um.stopCapturing()
        }
      }
      stats.ops++

      // 2. Aggressive cluster repartitioning / disconnect / reconnect
      if (step % 13 === 0) {
        const pOp = prng.uint32(gen, 0, 3)
        if (pOp === 0) {
          // Re-assign all peers into 2..clusterCount isolated sub-clusters
          const k = prng.uint32(gen, 2, scenario.clusterCount)
          for (let i = 0; i < numClients; i++) {
            peers[i].cluster = prng.uint32(gen, 0, k - 1)
          }
        } else if (pOp === 1) {
          // Disconnect a random peer and drop part of its inbox
          const victim = peers[prng.uint32(gen, 0, numClients - 1)]
          victim.online = false
          victim.inbox.length = math.floor(victim.inbox.length / 2)
        } else if (pOp === 2) {
          // Reconnect an offline peer (or merge two clusters)
          const offline = peers.filter(p => !p.online)
          if (offline.length > 0) {
            prng.oneOf(gen, offline).online = true
          } else {
            for (let i = 0; i < numClients; i++) {
              if (peers[i].cluster === 1) peers[i].cluster = 0
            }
          }
        } else {
          // Temporarily heal all clusters, sync a couple pairs, then re-split next cycle
          for (let i = 0; i < numClients; i++) {
            peers[i].online = true
            peers[i].cluster = 0
          }
        }
      }

      // 3. Deliver a few out-of-order packets
      const bursts = prng.uint32(gen, 1, 3)
      for (let b = 0; b < bursts; b++) {
        const ready = peers.filter(p => p.online && p.inbox.length > 0)
        if (ready.length === 0) break
        deliverOne(prng.oneOf(gen, ready), true)
      }

      // 4. Heavy historical duplicate replay to hammer CRDT idempotency!
      if (prng.real53(gen) < scenario.dupRate) {
        const dst = peers[prng.uint32(gen, 0, numClients - 1)]
        if (dst.historyV1.length > 0 && prng.bool(gen)) {
          const oldU = prng.oneOf(gen, dst.historyV1)
          assertIdempotentReplay(dst.doc, oldU, 'v1', NET_ORIGIN, `${scenario.name}:step${step}:c${dst.index}`)
          stats.duplicates++
          stats.idempotencyChecks++
        } else if (dst.historyV2.length > 0) {
          const oldU2 = prng.oneOf(gen, dst.historyV2)
          assertIdempotentReplay(dst.doc, oldU2, 'v2', NET_ORIGIN, `${scenario.name}:step${step}:c${dst.index}`)
          stats.duplicates++
          stats.idempotencyChecks++
        }
      }

      // 5. Occasional intra-cluster diff sync
      if (step % 9 === 0) {
        const a = peers[prng.uint32(gen, 0, numClients - 1)]
        const b = peers[prng.uint32(gen, 0, numClients - 1)]
        if (a !== b && a.online && b.online && a.cluster === b.cluster) {
          syncPair(a, b)
        }
      }

      // 5b. Targeted cross-client GC + UndoManager nested subtree attack:
      // Peer A (with UndoManager) edits & deletes inside a nested Y.Node, creates redoStack and calls clear(false, true),
      // while Peer B deletes the parent Y.Node under gc and syncs to Peer A, then Peer A attempts undo()/redo()!
      if (step > 0 && step % 23 === 0) {
        const undoPeers = peers.filter(p => p.um !== null)
        if (undoPeers.length >= 2) {
          const peerA = prng.oneOf(gen, undoPeers)
          const umA = peerA.um
          const peerB = prng.oneOf(gen, peers.filter(p => p !== peerA))
          if (umA !== null) {
            const arrA = peerA.doc.get('array')
            // Create a nested Y.Node on peerA with inner text & attr, sync to peerB
            const nested = new Y.Node()
            const insertIdx = arrA.length
            arrA.insert(insertIdx, [nested])
            nested.insert(0, 'sub-' + String(step))
            nested.setAttr('k', step)
            umA.stopCapturing()
            syncPair(peerA, peerB)

            // Peer A deletes content inside nested, inserts temp, undoes temp, then clears ONLY redoStack
            if (nested.length > 0) {
              nested.delete(0, math.min(2, nested.length))
              umA.stopCapturing()
            }
            nested.insert(0, 'tmp')
            umA.stopCapturing()
            umA.undo()
            if (umA.canRedo()) {
              umA.clear(false, true)
              stats.clears++
            }

            // Peer B deletes the parent nested Y.Node (preferring the tail where nested was appended) and syncs to Peer A
            const arrB = peerB.doc.get('array')
            if (arrB.length > 0) {
              const delIdx = prng.bool(gen) ? arrB.length - 1 : prng.uint32(gen, 0, arrB.length - 1)
              arrB.delete(delIdx, 1)
              syncPair(peerB, peerA)
            }

            // Peer A exercises undo/redo after remote parent deletion under GC, and invariants must remain valid
            if (umA.canUndo()) {
              umA.undo()
              stats.undos++
            }
            if (umA.canRedo() && prng.bool(gen)) {
              umA.redo()
              stats.redos++
            }
            verifyDocInvariants(peerA.doc, { expectNoPending: false, label: `${scenario.name}:gcAttack:step${step}:A` })
            verifyDocInvariants(peerB.doc, { expectNoPending: false, label: `${scenario.name}:gcAttack:step${step}:B` })
            stats.gcSubtreeAttacks++
          }
        }
      }

      // 6. Mid-partition deep invariants + cloneDoc check + diverged triple capture for algebraic laws
      if (step > 0 && step % 35 === 0) {
        for (let i = 0; i < numClients; i++) {
          const d = peers[i].doc
          if (d.store.skips.clients.size > stats.maxSkips) {
            stats.maxSkips = d.store.skips.clients.size
          }
          const pendingCnt = (d.store.pendingStructs ? 1 : 0) + (d.store.pendingDs ? 1 : 0)
          if (pendingCnt > stats.maxPending) {
            stats.maxPending = pendingCnt
          }
          verifyDocInvariants(d, { expectNoPending: false, label: `${scenario.name}:step${step}:c${i}` })
        }
        // Capture diverged peer triple for full Commutativity/Associativity/Idempotency checks
        if (numClients >= 3 && capturedTriples.length < 4) {
          const idxA = prng.uint32(gen, 0, numClients - 1)
          const idxB = (idxA + 1) % numClients
          const idxC = (idxA + 2) % numClients
          capturedTriples.push({
            uA: Y.encodeStateAsUpdate(peers[idxA].doc),
            uB: Y.encodeStateAsUpdate(peers[idxB].doc),
            uC: Y.encodeStateAsUpdate(peers[idxC].doc),
            format: 'v1'
          })
          capturedTriples.push({
            uA: Y.encodeStateAsUpdateV2(peers[idxA].doc),
            uB: Y.encodeStateAsUpdateV2(peers[idxB].doc),
            uC: Y.encodeStateAsUpdateV2(peers[idxC].doc),
            format: 'v2'
          })
        }
        // Verify cloneDoc mid-partition (with possible pendingStructs / pendingDs / skips!)
        const sample = peers[prng.uint32(gen, 0, numClients - 1)].doc
        const cloned = Y.cloneDoc(sample, { gc: sample.gc })
        try {
          verifyDocInvariants(cloned, { expectNoPending: false, label: `${scenario.name}:step${step}:clone` })
          assertInvariant(
            equalBytes(Y.encodeStateVector(sample), Y.encodeStateVector(cloned)),
            `${scenario.name}: mid-partition cloneDoc StateVector mismatch`
          )
        } finally {
          cloned.destroy()
        }
        stats.cloneChecks++
      }
    }

    // Final heal: bring all peers online into one cluster, drain all inboxes out-of-order, then full sync
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

    // Post-convergence idempotency burst: replay random historical updates onto converged peers
    const replayCount = math.min(6, allV1.length)
    for (let r = 0; r < replayCount; r++) {
      const target = peers[r % numClients]
      assertIdempotentReplay(target.doc, prng.oneOf(gen, allV1), 'v1', NET_ORIGIN, `${scenario.name}:finalDupV1`)
      if (allV2.length > 0) {
        assertIdempotentReplay(target.doc, prng.oneOf(gen, allV2), 'v2', NET_ORIGIN, `${scenario.name}:finalDupV2`)
      }
      stats.idempotencyChecks += 2
    }

    // Synthetic merged & cloned docs with heavy duplicate injection into mergeUpdates/V2
    const baseGc = peers[0].doc.gc
    const dupShuffledV1 = shuffleCopy(gen, allV1)
    for (let i = 0; i < math.min(10, allV1.length); i++) {
      dupShuffledV1.push(prng.oneOf(gen, allV1))
    }
    mergedV1 = new Y.Doc({ gc: baseGc })
    Y.applyUpdate(mergedV1, Y.mergeUpdates(dupShuffledV1))

    const dupShuffledV2 = shuffleCopy(gen, allV2)
    for (let i = 0; i < math.min(10, allV2.length); i++) {
      dupShuffledV2.push(prng.oneOf(gen, allV2))
    }
    mergedV2 = new Y.Doc({ gc: baseGc })
    Y.applyUpdateV2(mergedV2, Y.mergeUpdatesV2(dupShuffledV2))

    finalClone = Y.cloneDoc(peers[0].doc, { gc: baseGc })

    verifyConvergence(
      [...peers.map(p => p.doc), mergedV1, mergedV2, finalClone],
      ROOT_KEYS,
      {
        compareStores: scenario.gcMode === 'mixed' ? false : null,
        checkRoundtrip: true
      }
    )

    // Explicit CRDT algebraic laws (Commutativity, Associativity, Idempotency) on both
    // diverged full-state triples AND random incremental V1/V2 update triples
    for (let t = 0; t < capturedTriples.length; t++) {
      const tr = capturedTriples[t]
      verifyAlgebraicLawsOnTriple({
        uA: tr.uA,
        uB: tr.uB,
        uC: tr.uC,
        format: tr.format,
        gc: baseGc,
        label: `${scenario.name}:triple#${t}`
      })
      stats.lawChecks++
    }
    // Also spawn 3 guaranteed-complete concurrent branches atop the converged state so
    // strict expectNoPending=true YATA Commutativity / Associativity / Idempotency run on every scenario
    {
      const bA = Y.cloneDoc(peers[0].doc, { gc: baseGc })
      const bB = Y.cloneDoc(peers[0].doc, { gc: baseGc })
      const bC = Y.cloneDoc(peers[0].doc, { gc: baseGc })
      bA.clientID = 9000001
      bB.clientID = 9000002
      bC.clientID = 9000003
      try {
        editText(bA, gen)
        editMap(bA, gen, 0.3)
        editText(bB, gen)
        editArray(bB, gen, 0.3)
        editText(bC, gen)
        editXml(bC, gen)
        verifyAlgebraicLawsOnTriple({
          uA: Y.encodeStateAsUpdate(bA),
          uB: Y.encodeStateAsUpdate(bB),
          uC: Y.encodeStateAsUpdate(bC),
          format: 'v1',
          gc: baseGc,
          label: `${scenario.name}:completeBranchV1`
        })
        verifyAlgebraicLawsOnTriple({
          uA: Y.encodeStateAsUpdateV2(bA),
          uB: Y.encodeStateAsUpdateV2(bB),
          uC: Y.encodeStateAsUpdateV2(bC),
          format: 'v2',
          gc: baseGc,
          label: `${scenario.name}:completeBranchV2`
        })
        stats.lawChecks += 2
      } finally {
        bA.destroy()
        bB.destroy()
        bC.destroy()
      }
    }
    verifyIncrementalTripleLaws(allV1, 'v1', gen, baseGc, `${scenario.name}:incV1`)
    verifyIncrementalTripleLaws(allV2, 'v2', gen, baseGc, `${scenario.name}:incV2`)
    stats.lawChecks += 2

    return stats
  } finally {
    for (let i = 0; i < peers.length; i++) {
      peers[i].um?.destroy()
      peers[i].doc.destroy()
    }
    mergedV1?.destroy()
    mergedV2?.destroy()
    finalClone?.destroy()
  }
}

/**
 * Parse CLI options.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20260202
  /** @type {number | null} */
  let runsOverride = null
  /** @type {number | null} */
  let clients = null
  /** @type {number | null} */
  let opsOverride = null
  /** @type {string | null} */
  let scenarioName = null
  /** @type {'default' | 'high' | 'extreme'} */
  let intensity = 'default'
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--runs' && i + 1 < argv.length) {
      runsOverride = Number.parseInt(argv[++i], 10)
    } else if (arg === '--clients' && i + 1 < argv.length) {
      clients = Number.parseInt(argv[++i], 10)
    } else if (arg === '--ops' && i + 1 < argv.length) {
      opsOverride = Number.parseInt(argv[++i], 10)
    } else if (arg === '--scenario' && i + 1 < argv.length) {
      scenarioName = argv[++i]
    } else if (arg === '--intensity' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'default' || val === 'high' || val === 'extreme') {
        intensity = val
      }
    } else if (arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/undo-gc-fuzzer.js [--seed N] [--runs N] [--clients N] [--ops N] [--intensity default|high|extreme] [--scenario NAME] [--verbose]')
      process.exit(0)
    }
  }
  const runs = runsOverride !== null ? runsOverride : (intensity === 'extreme' ? 24 : intensity === 'high' ? 12 : SCENARIOS.length)
  const ops = opsOverride !== null ? opsOverride : (intensity === 'extreme' ? 250 : intensity === 'high' ? 220 : 100)
  return { seed, runs, clients, ops, scenarioName, intensity, verbose }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const selected = args.scenarioName !== null
    ? SCENARIOS.filter(s => s.name === args.scenarioName)
    : SCENARIOS
  if (selected.length === 0) {
    console.error(`Unknown scenario: ${String(args.scenarioName)}. Valid: ${SCENARIOS.map(s => s.name).join(', ')}`)
    process.exit(2)
  }

  const t0 = performance.now()
  let passed = 0
  let failed = 0

  console.log('=== Yjs v14 Extreme UndoManager + GC + Duplicate Replay Fuzzer ===')
  console.log(`baseSeed=${args.seed} intensity=${args.intensity} runs=${args.runs} ops/run=${args.ops} clientsOverride=${args.clients === null ? 'scenario(10..15)' : String(args.clients)}`)

  for (let r = 0; r < args.runs; r++) {
    const scenario = selected[r % selected.length]
    const runSeed = args.seed + r * 104729
    const clientCount = args.clients !== null ? args.clients : scenario.defaultClients
    const rt0 = performance.now()
    try {
      const st = runUndoGcScenario({
        seed: runSeed,
        scenario,
        ops: args.ops,
        clientsOverride: args.clients
      })
      const ms = (performance.now() - rt0).toFixed(1)
      passed++
      console.log(
        `[PASS] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} clients=${clientCount} gc=${scenario.gcMode} ` +
        `ops=${st.ops} undo/redo/clr=${st.undos}/${st.redos}/${st.clears} gcAtk=${st.gcSubtreeAttacks} msgs=${st.delivered} dups=${st.duplicates} ` +
        `idem=${st.idempotencyChecks} laws=${st.lawChecks} skipsMax=${st.maxSkips} pendMax=${st.maxPending} time=${ms}ms`
      )
      if (args.verbose) {
        console.log(`       batchMerges=${st.batchMerges} diffSyncs=${st.diffSyncs} cloneChecks=${st.cloneChecks}`)
      }
    } catch (err) {
      failed++
      const ms = (performance.now() - rt0).toFixed(1)
      console.error(`[FAIL] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} clients=${clientCount} time=${ms}ms`)
      console.error(`       Reproduce: node ./tests/lab/undo-gc-fuzzer.js --seed ${runSeed} --scenario ${scenario.name} --clients ${clientCount} --ops ${args.ops} --runs 1`)
      console.error(err)
    }
  }

  console.log(`=== Summary: ${passed} passed, ${failed} failed in ${(performance.now() - t0).toFixed(1)}ms ===`)
  if (failed > 0) {
    process.exit(1)
  }
}
