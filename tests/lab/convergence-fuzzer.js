import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import * as delta from 'lib0/delta'
import {
  verifyDocInvariants,
  verifyConvergence,
  assertInvariant,
  equalBytes
} from './invariants.js'

const ROOT_KEYS = ['text', 'array', 'map', 'xml']
const MAP_KEYS = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']
const XML_TAGS = ['div', 'p', 'span']
const XML_ATTR_KEYS = ['id', 'class', 'role', 'data-state']

/**
 * @typedef {Record<string, string | number | boolean | null | Record<string, string>>} FormatAttrs
 */

/** @type {Array<FormatAttrs>} */
const TEXT_FORMATS = [
  { bold: true },
  { bold: null },
  { italic: true },
  { italic: null },
  { color: '#c00' },
  { color: '#08c' },
  { color: null },
  { link: 'https://yjs.dev' },
  { link: null },
  { bold: true, italic: true }
]

/** @type {Array<FormatAttrs | undefined>} */
const TEXT_INSERT_FORMATS = [
  undefined,
  { bold: true },
  { italic: true },
  { color: '#0a5' },
  { bold: true, italic: true }
]

/**
 * @typedef {{
 *   name: string,
 *   clients: number,
 *   gcMode: 'all-on' | 'all-off' | 'mixed',
 *   undoClients: number,
 *   formatMode: 'mixed' | 'v2-heavy' | 'v1-v2-convert',
 *   outOfOrderBias: number,
 *   partitionProb: number,
 *   nestedBias: number,
 *   checkSnapshots: boolean
 * }} ScenarioConfig
 */

/** @type {Array<ScenarioConfig>} */
const SCENARIOS = [
  {
    name: 'homogeneous-gc-on-8c',
    clients: 8,
    gcMode: 'all-on',
    undoClients: 0,
    formatMode: 'mixed',
    outOfOrderBias: 0.55,
    partitionProb: 0.08,
    nestedBias: 0.25,
    checkSnapshots: false
  },
  {
    name: 'homogeneous-gc-off-undo-10c',
    clients: 10,
    gcMode: 'all-off',
    undoClients: 4,
    formatMode: 'mixed',
    outOfOrderBias: 0.6,
    partitionProb: 0.1,
    nestedBias: 0.3,
    checkSnapshots: true
  },
  {
    name: 'mixed-gc-undo-partitions-12c',
    clients: 12,
    gcMode: 'mixed',
    undoClients: 5,
    formatMode: 'mixed',
    outOfOrderBias: 0.7,
    partitionProb: 0.14,
    nestedBias: 0.3,
    checkSnapshots: false
  },
  {
    name: 'high-contention-15c-gc-on-undo',
    clients: 15,
    gcMode: 'all-on',
    undoClients: 6,
    formatMode: 'mixed',
    outOfOrderBias: 0.65,
    partitionProb: 0.1,
    nestedBias: 0.25,
    checkSnapshots: false
  },
  {
    name: 'v2-primary-gc-off-11c',
    clients: 11,
    gcMode: 'all-off',
    undoClients: 0,
    formatMode: 'v2-heavy',
    outOfOrderBias: 0.65,
    partitionProb: 0.1,
    nestedBias: 0.3,
    checkSnapshots: true
  },
  {
    name: 'extreme-out-of-order-skips-9c',
    clients: 9,
    gcMode: 'all-on',
    undoClients: 0,
    formatMode: 'mixed',
    outOfOrderBias: 0.95,
    partitionProb: 0.12,
    nestedBias: 0.2,
    checkSnapshots: false
  },
  {
    name: 'deep-nested-mixed-gc-13c',
    clients: 13,
    gcMode: 'mixed',
    undoClients: 6,
    formatMode: 'v1-v2-convert',
    outOfOrderBias: 0.6,
    partitionProb: 0.1,
    nestedBias: 0.55,
    checkSnapshots: false
  },
  {
    name: 'snapshots-contentids-gc-off-14c',
    clients: 14,
    gcMode: 'all-off',
    undoClients: 7,
    formatMode: 'v1-v2-convert',
    outOfOrderBias: 0.6,
    partitionProb: 0.1,
    nestedBias: 0.3,
    checkSnapshots: true
  }
]

/**
 * @typedef {{
 *   from: number,
 *   update: Uint8Array<ArrayBuffer>,
 *   format: 'v1' | 'v2'
 * }} Envelope
 */

/**
 * @typedef {{
 *   index: number,
 *   doc: Doc,
 *   undoManager: UndoManager | null,
 *   partitionGroup: number,
 *   online: boolean,
 *   inbox: Array<Envelope>,
 *   deliveredV1: Array<Uint8Array<ArrayBuffer>>,
 *   deliveredV2: Array<Uint8Array<ArrayBuffer>>
 * }} SimClient
 */

/**
 * @typedef {{
 *   opsExecuted: number,
 *   messagesDelivered: number,
 *   duplicatesDelivered: number,
 *   batchMerges: number,
 *   diffSyncs: number,
 *   formatConversions: number,
 *   undos: number,
 *   redos: number,
 *   partitions: number,
 *   snapshotChecks: number,
 *   invariantChecks: number,
 *   maxObservedSkips: number,
 *   maxObservedPending: number
 * }} RunStats
 */

/**
 * Generate a deterministic small Uint8Array payload.
 *
 * @param {prng.PRNG} gen
 * @return {Uint8Array<ArrayBuffer>}
 */
const randomBytes = gen => {
  const len = prng.uint32(gen, 1, 8)
  const arr = new Uint8Array(new ArrayBuffer(len))
  for (let i = 0; i < len; i++) {
    arr[i] = prng.uint32(gen, 0, 255)
  }
  return arr
}

/**
 * Generate a deterministic short text snippet (ASCII + occasional BMP Unicode).
 *
 * @param {prng.PRNG} gen
 * @param {number} maxLen
 * @return {string}
 */
const randomTextSnippet = (gen, maxLen) => {
  const alphabet = 'abcdefXYZ012 \n-_'
  const len = prng.uint32(gen, 1, maxLen)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += alphabet[prng.uint32(gen, 0, alphabet.length - 1)]
  }
  if (prng.uint32(gen, 0, 12) === 0) {
    out += prng.oneOf(gen, ['\u00e9', '\u03b1', '\u2603', '\u4e2d'])
  }
  return out
}

/**
 * Generate a deterministic primitive/object/binary value for Array or Map entries.
 *
 * @param {prng.PRNG} gen
 * @return {string | number | boolean | null | Uint8Array<ArrayBuffer> | Array<number> | { tag: string, n: number }}
 */
const randomScalarOrObj = gen => {
  const kind = prng.uint32(gen, 0, 6)
  switch (kind) {
    case 0: return prng.int32(gen, -1000, 1000)
    case 1: return randomTextSnippet(gen, 6)
    case 2: return prng.bool(gen)
    case 3: return null
    case 4: return randomBytes(gen)
    case 5: return [prng.int32(gen, 0, 50), prng.int32(gen, 0, 50)]
    default: return { tag: prng.oneOf(gen, ['a', 'b', 'c']), n: prng.uint32(gen, 0, 99) }
  }
}

/**
 * Apply a random text mutation (insert, formatted insert, delete, format, or rich applyDelta).
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 */
const mutateText = (doc, gen) => {
  const ytext = doc.get('text')
  const len = ytext.length
  const action = prng.uint32(gen, 0, 5)
  if (action === 0 || len === 0) {
    const pos = prng.uint32(gen, 0, len)
    const str = randomTextSnippet(gen, 5)
    const fmt = prng.oneOf(gen, TEXT_INSERT_FORMATS)
    if (fmt !== undefined) {
      ytext.insert(pos, str, fmt)
    } else {
      ytext.insert(pos, str)
    }
  } else if (action === 1) {
    const pos = prng.uint32(gen, 0, len - 1)
    const delLen = math.min(prng.uint32(gen, 1, 5), len - pos)
    ytext.delete(pos, delLen)
  } else if (action === 2) {
    const pos = prng.uint32(gen, 0, len - 1)
    const fmtLen = math.min(prng.uint32(gen, 1, 6), len - pos)
    const fmt = prng.oneOf(gen, TEXT_FORMATS)
    ytext.format(pos, fmtLen, fmt)
  } else if (action === 3) {
    // Rich delta with multiple ops (retain + format + insert + delete)
    let cur = prng.uint32(gen, 0, math.max(0, len - 1))
    const d = delta.create().retain(cur)
    const steps = prng.uint32(gen, 1, 4)
    for (let s = 0; s < steps && cur <= len; s++) {
      const sub = prng.uint32(gen, 0, 2)
      if (sub === 0) {
        const fmt = prng.oneOf(gen, TEXT_INSERT_FORMATS)
        d.insert(randomTextSnippet(gen, 3), fmt)
      } else if (sub === 1 && cur < len) {
        const span = math.min(prng.uint32(gen, 1, 4), len - cur)
        d.retain(span, prng.oneOf(gen, TEXT_FORMATS))
        cur += span
      } else if (cur < len) {
        const span = math.min(prng.uint32(gen, 1, 3), len - cur)
        d.delete(span)
        cur += span
      }
    }
    ytext.applyDelta(d)
  } else if (action === 4) {
    // Insert formatted newline block marker
    const pos = prng.uint32(gen, 0, len)
    const blockFmt = prng.oneOf(gen, [
      { 'code-block': true },
      { list: 'bullet' },
      { heading: 2 }
    ])
    const d = delta.create().retain(pos).insert(randomTextSnippet(gen, 4)).insert('\n', blockFmt)
    ytext.applyDelta(d)
  } else {
    // Insert embed object inside text delta
    const pos = prng.uint32(gen, 0, len)
    const embedId = prng.uint32(gen, 1, 20)
    const d = delta.create(delta.$deltaAny).retain(pos).insert([{ widget: { id: embedId } }])
    ytext.applyDelta(d)
  }
}

/**
 * Apply a random array mutation (primitives, objects, nested Y.Node, nested edits, delete).
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 * @param {number} nestedBias
 */
const mutateArray = (doc, gen, nestedBias) => {
  const yarr = doc.get('array')
  const len = yarr.length
  const roll = prng.real53(gen)
  if (len === 0 || roll < 0.35) {
    const pos = prng.uint32(gen, 0, len)
    const count = prng.uint32(gen, 1, 3)
    const items = []
    for (let i = 0; i < count; i++) {
      items.push(randomScalarOrObj(gen))
    }
    yarr.insert(pos, items)
  } else if (roll < 0.35 + nestedBias * 0.5) {
    const pos = prng.uint32(gen, 0, len)
    const child = new Y.Node()
    yarr.insert(pos, [child])
    if (prng.bool(gen)) {
      child.insert(0, [prng.int32(gen, 0, 50), prng.int32(gen, 0, 50)])
    } else {
      child.setAttr('nestedKey', prng.int32(gen, 0, 100))
      child.setAttr('label', randomTextSnippet(gen, 4))
    }
  } else if (roll < 0.72) {
    // Mutate an existing nested Y.Node if present, else insert
    const idx = prng.uint32(gen, 0, len - 1)
    const existing = yarr.get(idx)
    if (existing instanceof Y.Node) {
      if (prng.bool(gen)) {
        if (existing.length > 0 && prng.bool(gen)) {
          existing.delete(prng.uint32(gen, 0, existing.length - 1), 1)
        } else {
          existing.insert(prng.uint32(gen, 0, existing.length), [prng.int32(gen, 0, 99)])
        }
      } else {
        const k = prng.oneOf(gen, ['a', 'b', 'nestedKey'])
        if (prng.bool(gen)) {
          existing.setAttr(k, prng.int32(gen, 0, 99))
        } else {
          existing.deleteAttr(k)
        }
      }
    } else {
      yarr.insert(idx, [randomScalarOrObj(gen)])
    }
  } else {
    const pos = prng.uint32(gen, 0, len - 1)
    const delLen = math.min(prng.uint32(gen, 1, 3), len - pos)
    yarr.delete(pos, delLen)
  }
}

/**
 * Apply a random map mutation (setAttr, deleteAttr, nested Y.Node creation and mutation).
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 * @param {number} nestedBias
 */
const mutateMap = (doc, gen, nestedBias) => {
  const ymap = doc.get('map')
  const key = prng.oneOf(gen, MAP_KEYS)
  const roll = prng.real53(gen)
  if (roll < 0.35) {
    ymap.setAttr(key, randomScalarOrObj(gen))
  } else if (roll < 0.35 + nestedBias * 0.5) {
    const sub = new Y.Node()
    ymap.setAttr(key, sub)
    if (prng.bool(gen)) {
      sub.setAttr('subA', prng.int32(gen, 0, 50))
      sub.insert(0, randomTextSnippet(gen, 4))
    } else {
      sub.insert(0, [prng.int32(gen, 0, 10), prng.int32(gen, 0, 10)])
    }
  } else if (roll < 0.72) {
    const cur = ymap.getAttr(key)
    if (cur instanceof Y.Node) {
      if (prng.bool(gen)) {
        cur.setAttr(prng.oneOf(gen, ['subA', 'subB']), randomScalarOrObj(gen))
      } else if (cur.length > 0 && prng.bool(gen)) {
        cur.delete(prng.uint32(gen, 0, cur.length - 1), 1)
      } else {
        cur.insert(prng.uint32(gen, 0, cur.length), [prng.int32(gen, 0, 20)])
      }
    } else {
      ymap.setAttr(key, randomScalarOrObj(gen))
    }
  } else {
    ymap.deleteAttr(key)
  }
}

/**
 * Apply a random XML mutation (nested Y.Node('div'|'p'|'span'), attrs, children, delete).
 *
 * @param {Doc} doc
 * @param {prng.PRNG} gen
 */
const mutateXml = (doc, gen) => {
  const yxml = doc.get('xml')
  const len = yxml.length
  const action = prng.uint32(gen, 0, 4)
  if (action === 0 || len === 0) {
    const tag = prng.oneOf(gen, XML_TAGS)
    const el = new Y.Node(tag)
    const pos = prng.uint32(gen, 0, len)
    yxml.insert(pos, [el])
    el.setAttr(prng.oneOf(gen, XML_ATTR_KEYS), `v${prng.uint32(gen, 0, 9)}`)
    if (prng.bool(gen)) {
      const inner = new Y.Node(prng.oneOf(gen, XML_TAGS))
      el.insert(0, [inner])
      inner.insert(0, randomTextSnippet(gen, 4))
    } else {
      el.insert(0, randomTextSnippet(gen, 4))
    }
  } else if (action === 1 || action === 2) {
    const idx = prng.uint32(gen, 0, len - 1)
    const child = yxml.get(idx)
    if (child instanceof Y.Node) {
      const subAction = prng.uint32(gen, 0, 3)
      if (subAction === 0) {
        child.setAttr(prng.oneOf(gen, XML_ATTR_KEYS), `u${prng.uint32(gen, 0, 20)}`)
      } else if (subAction === 1) {
        child.deleteAttr(prng.oneOf(gen, XML_ATTR_KEYS))
      } else if (subAction === 2) {
        const subTag = prng.oneOf(gen, XML_TAGS)
        const subEl = new Y.Node(subTag)
        child.insert(prng.uint32(gen, 0, child.length), [subEl])
        subEl.setAttr('k', String(prng.uint32(gen, 0, 9)))
      } else if (child.length > 0) {
        child.delete(prng.uint32(gen, 0, child.length - 1), 1)
      }
    }
  } else if (action === 3) {
    // Also exercise attributes on the root xml node itself
    if (prng.bool(gen)) {
      yxml.setAttr(prng.oneOf(gen, XML_ATTR_KEYS), `root-${prng.uint32(gen, 0, 9)}`)
    } else {
      yxml.deleteAttr(prng.oneOf(gen, XML_ATTR_KEYS))
    }
  } else {
    const pos = prng.uint32(gen, 0, len - 1)
    const delLen = math.min(prng.uint32(gen, 1, 2), len - pos)
    yxml.delete(pos, delLen)
  }
}

/**
 * Verify Snapshot V1/V2 & ContentIds encode/decode roundtrips and intersectUpdateWithContentIds.
 *
 * @param {Doc} doc
 */
const verifySnapshotAndContentIds = doc => {
  const snap = Y.snapshot(doc)
  const snapV1 = Y.encodeSnapshot(snap)
  const snapV2 = Y.encodeSnapshotV2(snap)
  const decSnapV1 = Y.decodeSnapshot(snapV1)
  const decSnapV2 = Y.decodeSnapshotV2(snapV2)
  assertInvariant(Y.equalSnapshots(snap, decSnapV1), 'Snapshot V1 roundtrip mismatch')
  assertInvariant(Y.equalSnapshots(snap, decSnapV2), 'Snapshot V2 roundtrip mismatch')

  const cidsFull = Y.createContentIdsFromDoc(doc, true)
  const cidsVisible = Y.createContentIdsFromDoc(doc, false)
  const decFull = Y.decodeContentIds(Y.encodeContentIds(cidsFull))
  const decVisible = Y.decodeContentIds(Y.encodeContentIds(cidsVisible))
  assertInvariant(Y.equalContentIds(cidsFull, decFull), 'ContentIds(full) roundtrip mismatch')
  assertInvariant(Y.equalContentIds(cidsVisible, decVisible), 'ContentIds(visible) roundtrip mismatch')

  if (doc.store.skips.isEmpty()) {
    const cidsFromSnap = Y.createContentIdsFromSnapshot(snap, true)
    assertInvariant(
      Y.equalContentIds(cidsFull, cidsFromSnap),
      'createContentIdsFromSnapshot mismatch against createContentIdsFromDoc'
    )
    const u1 = Y.encodeStateAsUpdate(doc)
    const u2 = Y.encodeStateAsUpdateV2(doc)
    const inter1 = Y.intersectUpdateWithContentIds(u1, cidsFull)
    const inter2 = Y.intersectUpdateWithContentIdsV2(u2, cidsFull)
    const d1 = new Y.Doc({ gc: doc.gc })
    const d2 = new Y.Doc({ gc: doc.gc })
    Y.applyUpdate(d1, inter1)
    Y.applyUpdateV2(d2, inter2)
    verifyDocInvariants(d1, { expectNoPending: true, label: 'intersect-v1' })
    verifyDocInvariants(d2, { expectNoPending: true, label: 'intersect-v2' })
    assertInvariant(
      equalBytes(Y.encodeStateVector(doc), Y.encodeStateVector(d1)),
      'intersectUpdateWithContentIds V1 state vector mismatch'
    )
    assertInvariant(
      equalBytes(Y.encodeStateVector(doc), Y.encodeStateVector(d2)),
      'intersectUpdateWithContentIds V2 state vector mismatch'
    )
    d1.destroy()
    d2.destroy()
  }
}

/**
 * Deterministically shuffle an array copy using PRNG.
 *
 * @template T
 * @param {prng.PRNG} gen
 * @param {Array<T>} items
 * @return {Array<T>}
 */
const shuffleCopy = (gen, items) => {
  const copy = items.slice()
  for (let i = copy.length - 1; i > 0; i--) {
    const j = prng.uint32(gen, 0, i)
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy
}

/**
 * Run a single deterministic multi-client CRDT convergence fuzzing scenario.
 *
 * @param {{
 *   seed: number,
 *   scenario: ScenarioConfig,
 *   ops: number,
 *   clientCountOverride?: number | null
 * }} params
 * @return {RunStats}
 */
export const runScenario = ({ seed, scenario, ops, clientCountOverride = null }) => {
  const gen = prng.create(seed)
  const numClients = clientCountOverride !== null ? clientCountOverride : scenario.clients
  const NETWORK_ORIGIN = 'lab-network-sync'

  /** @type {RunStats} */
  const stats = {
    opsExecuted: 0,
    messagesDelivered: 0,
    duplicatesDelivered: 0,
    batchMerges: 0,
    diffSyncs: 0,
    formatConversions: 0,
    undos: 0,
    redos: 0,
    partitions: 0,
    snapshotChecks: 0,
    invariantChecks: 0,
    maxObservedSkips: 0,
    maxObservedPending: 0
  }

  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const globalUpdatesV1 = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const globalUpdatesV2 = []

  // Generate distinct deterministic client IDs in randomized order
  /** @type {Set<number>} */
  const usedIds = new Set()
  /** @type {Array<number>} */
  const clientIds = []
  while (clientIds.length < numClients) {
    const cid = prng.uint32(gen, 1, 1000000)
    if (!usedIds.has(cid)) {
      usedIds.add(cid)
      clientIds.push(cid)
    }
  }

  /** @type {Array<SimClient>} */
  const clients = []

  for (let i = 0; i < numClients; i++) {
    const gc = scenario.gcMode === 'all-on'
      ? true
      : scenario.gcMode === 'all-off'
        ? false
        : (i % 2 === 0)
    const doc = new Y.Doc({ gc })
    doc.clientID = clientIds[i]
    // Initialize all root keys upfront so UndoManager scope covers all 4
    const rootNodes = ROOT_KEYS.map(k => doc.get(k))
    const undoManager = i < scenario.undoClients
      ? new Y.UndoManager(rootNodes, { captureTimeout: 0 })
      : null

    /** @type {SimClient} */
    const simClient = {
      index: i,
      doc,
      undoManager,
      partitionGroup: 0,
      online: true,
      inbox: [],
      deliveredV1: [],
      deliveredV2: []
    }

    doc.on('update', (update, origin) => {
      globalUpdatesV1.push(update)
      if (origin === NETWORK_ORIGIN) return
      if (!simClient.online) return
      // Decide whether to broadcast V1, V2, or converted format
      const useV2 = scenario.formatMode === 'v2-heavy'
        ? prng.real53(gen) < 0.8
        : prng.bool(gen)
      if (!useV2) {
        for (let p = 0; p < clients.length; p++) {
          const peer = clients[p]
          if (peer.index !== simClient.index && peer.online && peer.partitionGroup === simClient.partitionGroup) {
            let payload = update
            /** @type {'v1' | 'v2'} */
            let fmt = 'v1'
            if (scenario.formatMode === 'v1-v2-convert' && prng.bool(gen)) {
              payload = Y.convertUpdateFormatV1ToV2(update)
              fmt = 'v2'
              stats.formatConversions++
            }
            peer.inbox.push({ from: simClient.index, update: payload, format: fmt })
          }
        }
      }
    })

    doc.on('updateV2', (updateV2, origin) => {
      globalUpdatesV2.push(updateV2)
      if (origin === NETWORK_ORIGIN) return
      if (!simClient.online) return
      const sendViaV2 = scenario.formatMode === 'v2-heavy'
        ? prng.real53(gen) < 0.85
        : prng.bool(gen)
      if (sendViaV2) {
        for (let p = 0; p < clients.length; p++) {
          const peer = clients[p]
          if (peer.index !== simClient.index && peer.online && peer.partitionGroup === simClient.partitionGroup) {
            let payload = updateV2
            /** @type {'v1' | 'v2'} */
            let fmt = 'v2'
            if (scenario.formatMode === 'v1-v2-convert' && prng.bool(gen)) {
              payload = Y.convertUpdateFormatV2ToV1(updateV2)
              fmt = 'v1'
              stats.formatConversions++
            }
            peer.inbox.push({ from: simClient.index, update: payload, format: fmt })
          }
        }
      }
    })

    clients.push(simClient)
  }

  /**
   * Deliver one message (or a merged batch) to a specific client.
   *
   * @param {SimClient} receiver
   * @param {boolean} allowDuplicate
   */
  const deliverToClient = (receiver, allowDuplicate) => {
    if (receiver.inbox.length === 0) return

    // Occasionally merge 2..4 messages of the same format in transit before delivering
    if (receiver.inbox.length >= 2 && prng.uint32(gen, 0, 5) === 0) {
      /** @type {'v1' | 'v2'} */
      const targetFmt = receiver.inbox[prng.uint32(gen, 0, receiver.inbox.length - 1)].format
      /** @type {Array<number>} */
      const matchingIndices = []
      for (let i = 0; i < receiver.inbox.length; i++) {
        if (receiver.inbox[i].format === targetFmt) matchingIndices.push(i)
      }
      if (matchingIndices.length >= 2) {
        const batchCount = math.min(prng.uint32(gen, 2, 4), matchingIndices.length)
        /** @type {Array<number>} */
        const chosenIndices = []
        for (let b = 0; b < batchCount; b++) {
          const pick = prng.uint32(gen, 0, matchingIndices.length - 1)
          chosenIndices.push(matchingIndices[pick])
          matchingIndices.splice(pick, 1)
        }
        chosenIndices.sort((a, b) => b - a)
        /** @type {Array<Uint8Array<ArrayBuffer>>} */
        const batch = []
        for (let b = 0; b < chosenIndices.length; b++) {
          const idx = chosenIndices[b]
          batch.push(receiver.inbox[idx].update)
          if (!allowDuplicate || prng.uint32(gen, 0, 5) !== 0) {
            receiver.inbox.splice(idx, 1)
          } else {
            stats.duplicatesDelivered++
          }
        }
        if (targetFmt === 'v1') {
          const merged = Y.mergeUpdates(batch)
          Y.applyUpdate(receiver.doc, merged, NETWORK_ORIGIN)
          receiver.deliveredV1.push(merged)
        } else {
          const merged = Y.mergeUpdatesV2(batch)
          Y.applyUpdateV2(receiver.doc, merged, NETWORK_ORIGIN)
          receiver.deliveredV2.push(merged)
        }
        stats.batchMerges++
        stats.messagesDelivered++
        return
      }
    }

    // Pick message index: biased toward newest (out-of-order) or uniform random
    let msgIdx
    if (prng.real53(gen) < scenario.outOfOrderBias) {
      msgIdx = scenario.outOfOrderBias > 0.9
        ? receiver.inbox.length - 1
        : prng.uint32(gen, 0, receiver.inbox.length - 1)
    } else {
      msgIdx = 0
    }
    const env = receiver.inbox[msgIdx]
    const duplicate = allowDuplicate && prng.uint32(gen, 0, 6) === 0
    if (!duplicate) {
      receiver.inbox.splice(msgIdx, 1)
    } else {
      stats.duplicatesDelivered++
    }
    if (env.format === 'v1') {
      Y.applyUpdate(receiver.doc, env.update, NETWORK_ORIGIN)
      receiver.deliveredV1.push(env.update)
    } else {
      Y.applyUpdateV2(receiver.doc, env.update, NETWORK_ORIGIN)
      receiver.deliveredV2.push(env.update)
    }
    stats.messagesDelivered++
  }

  /**
   * Perform a state-vector diff sync between two peers using encodeStateAsUpdate or diffUpdate.
   *
   * @param {SimClient} sender
   * @param {SimClient} receiver
   */
  const syncPairViaDiff = (sender, receiver) => {
    const sv = Y.encodeStateVector(receiver.doc)
    const mode = prng.uint32(gen, 0, 3)
    if (mode === 0) {
      const diff = Y.encodeStateAsUpdate(sender.doc, sv)
      Y.applyUpdate(receiver.doc, diff, NETWORK_ORIGIN)
    } else if (mode === 1) {
      const diffV2 = Y.encodeStateAsUpdateV2(sender.doc, sv)
      Y.applyUpdateV2(receiver.doc, diffV2, NETWORK_ORIGIN)
    } else if (mode === 2) {
      const fullV1 = Y.encodeStateAsUpdate(sender.doc)
      const diff = Y.diffUpdate(fullV1, sv)
      Y.applyUpdate(receiver.doc, diff, NETWORK_ORIGIN)
    } else {
      const fullV2 = Y.encodeStateAsUpdateV2(sender.doc)
      const diffV2 = Y.diffUpdateV2(fullV2, sv)
      Y.applyUpdateV2(receiver.doc, diffV2, NETWORK_ORIGIN)
    }
    stats.diffSyncs++
  }

  // Main deterministic fuzzing loop
  for (let step = 0; step < ops; step++) {
    const client = clients[prng.uint32(gen, 0, numClients - 1)]

    // 1. Perform a local CRDT mutation or UndoManager undo/redo
    if (client.undoManager !== null && client.undoManager.redoStack.length > 0 && prng.uint32(gen, 0, 1) === 0) {
      client.undoManager.redo()
      stats.redos++
    } else if (client.undoManager !== null && prng.uint32(gen, 0, 5) === 0) {
      if (client.undoManager.undoStack.length > 0) {
        client.undoManager.undo()
        stats.undos++
      } else {
        mutateText(client.doc, gen)
      }
    } else {
      const targetType = prng.uint32(gen, 0, 3)
      if (targetType === 0) {
        mutateText(client.doc, gen)
      } else if (targetType === 1) {
        mutateArray(client.doc, gen, scenario.nestedBias)
      } else if (targetType === 2) {
        mutateMap(client.doc, gen, scenario.nestedBias)
      } else {
        mutateXml(client.doc, gen)
      }
      if (client.undoManager !== null && prng.uint32(gen, 0, 2) === 0) {
        client.undoManager.stopCapturing()
      }
    }
    stats.opsExecuted++

    // 2. Network partition / reconnect events
    if (prng.real53(gen) < scenario.partitionProb) {
      const pAction = prng.uint32(gen, 0, 3)
      if (pAction === 0) {
        // Split into 2 or 3 partition groups
        const groups = prng.uint32(gen, 2, 3)
        for (let i = 0; i < numClients; i++) {
          clients[i].partitionGroup = prng.uint32(gen, 0, groups - 1)
        }
        stats.partitions++
      } else if (pAction === 1) {
        // Toggle a random client online/offline
        const victim = clients[prng.uint32(gen, 0, numClients - 1)]
        victim.online = !victim.online
        if (!victim.online) {
          // Drop half of buffered inbox to simulate dropped packets during disconnect
          victim.inbox.length = math.floor(victim.inbox.length / 2)
        }
        stats.partitions++
      } else if (pAction === 2) {
        // Heal partitions and reconnect everyone
        for (let i = 0; i < numClients; i++) {
          clients[i].online = true
          clients[i].partitionGroup = 0
        }
        stats.partitions++
      } else {
        // Re-deliver an already delivered historical update to test idempotence
        const target = clients[prng.uint32(gen, 0, numClients - 1)]
        if (target.deliveredV1.length > 0 && prng.bool(gen)) {
          const oldU = prng.oneOf(gen, target.deliveredV1)
          Y.applyUpdate(target.doc, oldU, NETWORK_ORIGIN)
          stats.duplicatesDelivered++
        } else if (target.deliveredV2.length > 0) {
          const oldU2 = prng.oneOf(gen, target.deliveredV2)
          Y.applyUpdateV2(target.doc, oldU2, NETWORK_ORIGIN)
          stats.duplicatesDelivered++
        }
      }
    }

    // 3. Deliver a few random out-of-order messages (skip some steps in extreme-out-of-order mode to let queues build)
    const deliverAttempts = scenario.outOfOrderBias > 0.9 ? (step % 3 === 0 ? 3 : 0) : prng.uint32(gen, 1, 3)
    for (let d = 0; d < deliverAttempts; d++) {
      const withInbox = clients.filter(c => c.online && c.inbox.length > 0)
      if (withInbox.length === 0) break
      const receiver = prng.oneOf(gen, withInbox)
      deliverToClient(receiver, true)
    }

    // 4. Occasional pairwise diff sync within the same partition
    if (step % 11 === 0) {
      const a = clients[prng.uint32(gen, 0, numClients - 1)]
      const b = clients[prng.uint32(gen, 0, numClients - 1)]
      if (a !== b && a.online && b.online && a.partitionGroup === b.partitionGroup) {
        syncPairViaDiff(a, b)
      }
    }

    // 5. Mid-run deep invariant check (even with active skips / pendingStructs / pendingDs!)
    if (step > 0 && step % 50 === 0) {
      for (let i = 0; i < numClients; i++) {
        const d = clients[i].doc
        const skipClients = d.store.skips.clients.size
        if (skipClients > stats.maxObservedSkips) stats.maxObservedSkips = skipClients
        const pendingCount = (d.store.pendingStructs ? 1 : 0) + (d.store.pendingDs ? 1 : 0)
        if (pendingCount > stats.maxObservedPending) stats.maxObservedPending = pendingCount
        verifyDocInvariants(d, {
          expectNoPending: false,
          label: `run(${scenario.name},seed=${seed},step=${step},client=${i})`
        })
        stats.invariantChecks++
      }
      if (scenario.checkSnapshots) {
        const sample = clients[prng.uint32(gen, 0, numClients - 1)].doc
        verifySnapshotAndContentIds(sample)
        stats.snapshotChecks++
      }
    }
  }

  // Final heal phase: reconnect all clients, drain inboxes in random order, then full state-vector sync
  for (let i = 0; i < numClients; i++) {
    clients[i].online = true
    clients[i].partitionGroup = 0
  }
  while (true) {
    const withInbox = clients.filter(c => c.inbox.length > 0)
    if (withInbox.length === 0) break
    const receiver = prng.oneOf(gen, withInbox)
    deliverToClient(receiver, false)
  }

  // Ring + hub-and-spoke state-vector diff sync so every client receives every missing op/delete
  // even across earlier disconnects and dropped packets
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < numClients; i++) {
      const next = clients[(i + 1) % numClients]
      syncPairViaDiff(clients[i], next)
    }
    for (let i = 1; i < numClients; i++) {
      syncPairViaDiff(clients[0], clients[i])
      syncPairViaDiff(clients[i], clients[0])
    }
  }

  // Construct synthetic verification docs via mergeUpdates / mergeUpdatesV2 / format conversions / cloneDoc
  const baseGc = clients[0].doc.gc
  const shuffledV1 = shuffleCopy(gen, globalUpdatesV1)
  if (shuffledV1.length > 2) {
    // Inject duplicates to stress mergeUpdates deduplication
    shuffledV1.push(shuffledV1[0], shuffledV1[math.floor(shuffledV1.length / 2)])
  }
  const mergedV1Doc = new Y.Doc({ gc: baseGc })
  Y.applyUpdate(mergedV1Doc, Y.mergeUpdates(shuffledV1))

  const shuffledV2 = shuffleCopy(gen, globalUpdatesV2)
  if (shuffledV2.length > 2) {
    shuffledV2.push(shuffledV2[0], shuffledV2[math.floor(shuffledV2.length / 2)])
  }
  const mergedV2Doc = new Y.Doc({ gc: baseGc })
  Y.applyUpdateV2(mergedV2Doc, Y.mergeUpdatesV2(shuffledV2))

  const clonedDoc = Y.cloneDoc(clients[0].doc, { gc: baseGc })

  // Verify final snapshot & ContentIds consistency on converged docs
  verifySnapshotAndContentIds(clients[0].doc)
  stats.snapshotChecks++

  const allDocs = [
    ...clients.map(c => c.doc),
    mergedV1Doc,
    mergedV2Doc,
    clonedDoc
  ]

  // Homogeneous GC with no UndoManager must satisfy direct StructStore equality;
  // homogeneous gc:false with UndoManager verifies canonical wire StructStore equality
  const strictDirectStoreMatch = (scenario.gcMode === 'all-off' || scenario.gcMode === 'all-on') && scenario.undoClients === 0
  verifyConvergence(allDocs, ROOT_KEYS, {
    compareStores: strictDirectStoreMatch ? true : null,
    checkRoundtrip: true
  })

  // Clean up
  for (let i = 0; i < clients.length; i++) {
    clients[i].undoManager?.destroy()
    clients[i].doc.destroy()
  }
  mergedV1Doc.destroy()
  mergedV2Doc.destroy()
  clonedDoc.destroy()

  return stats
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20261127
  /** @type {number | null} */
  let clients = null
  let ops = 120
  let runs = SCENARIOS.length
  /** @type {string | null} */
  let scenarioName = null
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--clients' && i + 1 < argv.length) {
      clients = Number.parseInt(argv[++i], 10)
    } else if (arg === '--ops' && i + 1 < argv.length) {
      ops = Number.parseInt(argv[++i], 10)
    } else if (arg === '--runs' && i + 1 < argv.length) {
      runs = Number.parseInt(argv[++i], 10)
    } else if (arg === '--scenario' && i + 1 < argv.length) {
      scenarioName = argv[++i]
    } else if (arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/convergence-fuzzer.js [--seed N] [--clients N] [--ops N] [--runs N] [--scenario NAME] [--verbose]')
      process.exit(0)
    }
  }
  return { seed, clients, ops, runs, scenarioName, verbose }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const t0 = performance.now()
  let passed = 0
  let failed = 0
  const selectedScenarios = args.scenarioName !== null
    ? SCENARIOS.filter(s => s.name === args.scenarioName)
    : SCENARIOS
  if (selectedScenarios.length === 0) {
    console.error(`Unknown scenario: ${String(args.scenarioName)}. Valid: ${SCENARIOS.map(s => s.name).join(', ')}`)
    process.exit(2)
  }

  console.log('=== Yjs v14 Multi-Client CRDT Convergence Fuzzer ===')
  console.log(`baseSeed=${args.seed} runs=${args.runs} ops/run=${args.ops} clientsOverride=${args.clients === null ? 'scenario(8..15)' : String(args.clients)}`)

  for (let r = 0; r < args.runs; r++) {
    const scenario = selectedScenarios[r % selectedScenarios.length]
    const runSeed = args.seed + r * 7919
    const runStart = performance.now()
    const clientCount = args.clients !== null ? args.clients : scenario.clients
    try {
      const stats = runScenario({
        seed: runSeed,
        scenario,
        ops: args.ops,
        clientCountOverride: args.clients
      })
      const elapsedMs = (performance.now() - runStart).toFixed(1)
      passed++
      console.log(
        `[PASS] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} clients=${clientCount} gc=${scenario.gcMode} undo=${scenario.undoClients} ` +
        `ops=${stats.opsExecuted} msgs=${stats.messagesDelivered} dup=${stats.duplicatesDelivered} merges=${stats.batchMerges} diffs=${stats.diffSyncs} ` +
        `undo/redo=${stats.undos}/${stats.redos} skipsMax=${stats.maxObservedSkips} pendingMax=${stats.maxObservedPending} time=${elapsedMs}ms`
      )
      if (args.verbose) {
        console.log(`       invChecks=${stats.invariantChecks} snapChecks=${stats.snapshotChecks} conversions=${stats.formatConversions} partitions=${stats.partitions}`)
      }
    } catch (err) {
      failed++
      const elapsedMs = (performance.now() - runStart).toFixed(1)
      console.error(`[FAIL] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} clients=${clientCount} time=${elapsedMs}ms`)
      console.error(`       Reproduce: node ./tests/lab/convergence-fuzzer.js --seed ${runSeed} --scenario ${scenario.name} --clients ${clientCount} --ops ${args.ops} --runs 1`)
      console.error(err)
    }
  }

  const totalMs = (performance.now() - t0).toFixed(1)
  console.log(`=== Summary: ${passed} passed, ${failed} failed in ${totalMs}ms ===`)
  if (failed > 0) {
    process.exit(1)
  }
}
