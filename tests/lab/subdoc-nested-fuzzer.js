import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import {
  assertInvariant,
  deepEqualValues,
  equalBytes,
  verifyDocInvariants
} from './invariants.js'

const NET_ORIGIN = 'subdoc-fuzzer-net'
const MAP_KEYS = ['docA', 'docB', 'folderA', 'folderB', 'metaK']
const ROOT_KEYS = ['list', 'map', 'tree']

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
  low: { runs: 2, ops: 50, clients: 6 },
  medium: { runs: 4, ops: 80, clients: 8 },
  high: { runs: 12, ops: 150, clients: 10 },
  extreme: { runs: 24, ops: 220, clients: 12 }
}

/**
 * @typedef {{
 *   name: string,
 *   gcMode: 'mixed' | 'all-on' | 'all-off',
 *   undoRatio: number,
 *   destroyParentMidRun: boolean,
 *   dupRate: number,
 *   v2Ratio: number
 * }} SubdocScenario
 */

/** @type {Array<SubdocScenario>} */
const SCENARIOS = [
  {
    name: 'subdoc-mixed-gc-undo-lifecycle',
    gcMode: 'mixed',
    undoRatio: 0.5,
    destroyParentMidRun: true,
    dupRate: 0.25,
    v2Ratio: 0.5
  },
  {
    name: 'subdoc-gc-on-aggressive-delete',
    gcMode: 'all-on',
    undoRatio: 0.5,
    destroyParentMidRun: true,
    dupRate: 0.3,
    v2Ratio: 0.6
  },
  {
    name: 'subdoc-gc-off-deep-nesting-undo',
    gcMode: 'all-off',
    undoRatio: 0.6,
    destroyParentMidRun: false,
    dupRate: 0.25,
    v2Ratio: 0.5
  },
  {
    name: 'subdoc-v2-out-of-order-dups',
    gcMode: 'mixed',
    undoRatio: 0.4,
    destroyParentMidRun: true,
    dupRate: 0.35,
    v2Ratio: 0.8
  }
]

/**
 * @typedef {{
 *   index: number,
 *   doc: Y.Doc,
 *   um: Y.UndoManager | null,
 *   alive: boolean,
 *   online: boolean,
 *   cluster: number,
 *   loadCallbackViolations: Array<string>,
 *   subdocsEvents: number,
 *   destroyedSubdocs: Array<Y.Doc>,
 *   inbox: Array<{ fmt: 'v1' | 'v2', data: Uint8Array<ArrayBuffer> }>,
 *   histV1: Array<Uint8Array<ArrayBuffer>>,
 *   histV2: Array<Uint8Array<ArrayBuffer>>
 * }} SubdocPeer
 */

/**
 * @typedef {{
 *   ops: number,
 *   subdocsInserted: number,
 *   subdocsLoaded: number,
 *   subdocsEdited: number,
 *   subdocsDestroyed: number,
 *   subdocsDeleted: number,
 *   parentsDestroyed: number,
 *   undos: number,
 *   redos: number,
 *   msgs: number,
 *   dups: number,
 *   merges: number,
 *   subdocsEvents: number
 * }} SubdocStats
 */

/**
 * Bounded trace ring buffer for crisp failure reproducers.
 *
 * @param {Array<string>} trace
 * @param {string} msg
 */
const pushTrace = (trace, msg) => {
  trace.push(msg)
  if (trace.length > 24) trace.shift()
}

/**
 * Bounded per-peer update replay history (O(1) memory at extreme scale).
 *
 * @param {Array<Uint8Array<ArrayBuffer>>} hist
 * @param {Uint8Array<ArrayBuffer>} u
 */
const pushBoundedHist = (hist, u) => {
  if (hist.length >= 128) hist.shift()
  hist.push(u)
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
 * Recursively convert any value containing Y.Doc / Y.Node / Delta JSON into a cycle-free comparable structure.
 *
 * @param {unknown} val
 * @return {unknown}
 */
const sanitizeForCompare = val => {
  if (val instanceof Y.Doc) {
    return {
      __yDoc: true,
      guid: val.guid,
      gc: val.gc,
      autoLoad: val.autoLoad,
      meta: val.meta
    }
  }
  if (val instanceof Y.Node) {
    return sanitizeForCompare(val.toDeltaDeep().toJSON())
  }
  if (val instanceof Uint8Array) {
    return val
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeForCompare)
  }
  if (val !== null && typeof val === 'object') {
    const src = /** @type {Record<string, unknown>} */ (val)
    /** @type {Record<string, unknown>} */
    const out = {}
    const keys = Object.keys(src).sort()
    for (let i = 0; i < keys.length; i++) {
      out[keys[i]] = sanitizeForCompare(src[keys[i]])
    }
    return out
  }
  return val
}

/**
 * Verify all subdoc-specific structural & GC invariants on a single parent Doc.
 *
 * @param {Y.Doc} doc
 * @param {string} label
 * @param {boolean} expectNoPending
 */
const verifySubdocInvariants = (doc, label, expectNoPending) => {
  verifyDocInvariants(doc, { expectNoPending, label })

  /** @type {Set<Y.Doc>} */
  const expectedLiveSubdocs = new Set()

  for (const structs of doc.store.clients.values()) {
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      if (!(s instanceof Y.Item)) continue
      if (s.content instanceof Y.ContentDeleted) {
        // DOC-1: ContentDeleted must NEVER be polluted with a .doc property by subdoc.destroy()
        assertInvariant(
          !Object.prototype.hasOwnProperty.call(s.content, 'doc'),
          `${label}: ContentDeleted at (${s.id.client},${s.id.clock}) has polluted .doc property (DOC-1)`
        )
      } else if (s.content instanceof Y.ContentDoc) {
        if (!s.deleted) {
          const sub = s.content.doc
          assertInvariant(
            sub !== null,
            `${label}: live ContentDoc at (${s.id.client},${s.id.clock}) has null .doc`
          )
          if (sub !== null) {
            assertInvariant(
              !sub.isDestroyed,
              `${label}: live ContentDoc at (${s.id.client},${s.id.clock}) points to destroyed subdoc (guid=${sub.guid})`
            )
            assertInvariant(
              sub._item === s,
              `${label}: live subdoc (guid=${sub.guid}) has mismatched _item pointer`
            )
            assertInvariant(
              doc.subdocs.has(sub),
              `${label}: live ContentDoc subdoc (guid=${sub.guid}) missing from parent.subdocs`
            )
            expectedLiveSubdocs.add(sub)
          }
        }
      }
    }
  }

  // Every entry in doc.subdocs must correspond to an exact live ContentDoc item (zero zombie leaks!)
  assertInvariant(
    doc.subdocs.size === expectedLiveSubdocs.size,
    `${label}: parent.subdocs.size=${doc.subdocs.size} !== live ContentDoc count=${expectedLiveSubdocs.size}`
  )
  for (const sub of doc.subdocs) {
    assertInvariant(
      expectedLiveSubdocs.has(sub) && !sub.isDestroyed,
      `${label}: zombie/destroyed subdoc (guid=${sub.guid}) still present in parent.subdocs`
    )
  }
}

/**
 * Verify full subdoc + parent tree convergence across all surviving parent Docs (plus V1/V2 roundtrip).
 *
 * @param {Array<Y.Doc>} docs
 * @param {string} label
 */
const verifySubdocConvergence = (docs, label) => {
  assertInvariant(docs.length > 0, `${label}: expected at least one surviving doc`)
  for (let i = 0; i < docs.length; i++) {
    verifySubdocInvariants(docs[i], `${label}:doc[${i}]`, true)
    assertInvariant(
      docs[i].store.skips.isEmpty(),
      `${label}:doc[${i}] still has unintegrated skips after sync`
    )
  }

  const d0 = docs[0]
  const sv0 = Y.encodeStateVector(d0)
  const cidsFull0 = Y.createContentIdsFromDoc(d0, true)
  const cidsVis0 = Y.createContentIdsFromDoc(d0, false)
  const guidsSet0 = Array.from(d0.getSubdocGuids()).sort()
  const guidsMulti0 = Array.from(d0.subdocs).map(s => s.guid).sort()
  /** @type {Array<unknown>} */
  const deltas0 = ROOT_KEYS.map(k => sanitizeForCompare(d0.get(k).toDeltaDeep().toJSON()))
  /** @type {Array<unknown>} */
  const jsons0 = ROOT_KEYS.map(k => sanitizeForCompare(d0.get(k).toJSON()))

  for (let i = 1; i < docs.length; i++) {
    const di = docs[i]
    const tag = `${label}:doc[0]_vs_doc[${i}]`
    assertInvariant(equalBytes(sv0, Y.encodeStateVector(di)), `${tag}: StateVector mismatch`)
    assertInvariant(Y.equalContentIds(cidsFull0, Y.createContentIdsFromDoc(di, true)), `${tag}: ContentIds(full) mismatch`)
    assertInvariant(Y.equalContentIds(cidsVis0, Y.createContentIdsFromDoc(di, false)), `${tag}: ContentIds(visible) mismatch`)
    assertInvariant(
      d0.subdocs.size === di.subdocs.size,
      `${tag}: subdocs.size mismatch (${d0.subdocs.size} !== ${di.subdocs.size})`
    )
    const guidsSetCmp = deepEqualValues(guidsSet0, Array.from(di.getSubdocGuids()).sort(), `${tag}.getSubdocGuids`)
    assertInvariant(guidsSetCmp.equal, `${tag}: getSubdocGuids() diverged (${guidsSetCmp.reason})`)
    const guidsMultiCmp = deepEqualValues(guidsMulti0, Array.from(di.subdocs).map(s => s.guid).sort(), `${tag}.subdocMultiset`)
    assertInvariant(guidsMultiCmp.equal, `${tag}: subdoc guid multiset diverged (${guidsMultiCmp.reason})`)

    for (let k = 0; k < ROOT_KEYS.length; k++) {
      const rootKey = ROOT_KEYS[k]
      const deltaI = sanitizeForCompare(di.get(rootKey).toDeltaDeep().toJSON())
      const dCmp = deepEqualValues(deltas0[k], deltaI, `${tag}.${rootKey}.delta`)
      assertInvariant(dCmp.equal, `${tag}: root '${rootKey}' toDeltaDeep() diverged (${dCmp.reason})`)
      const jsonI = sanitizeForCompare(di.get(rootKey).toJSON())
      const jCmp = deepEqualValues(jsons0[k], jsonI, `${tag}.${rootKey}.json`)
      assertInvariant(jCmp.equal, `${tag}: root '${rootKey}' toJSON() diverged (${jCmp.reason})`)
    }
  }

  // V1 / V2 / V1<->V2 wire roundtrip verification on d0
  const u1 = Y.encodeStateAsUpdate(d0)
  const u2 = Y.encodeStateAsUpdateV2(d0)
  const rtDocs = [
    { name: 'rtV1', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Y.Doc} d */ d => Y.applyUpdate(d, u1) },
    { name: 'rtV2', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Y.Doc} d */ d => Y.applyUpdateV2(d, u2) },
    { name: 'rtV1toV2', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Y.Doc} d */ d => Y.applyUpdateV2(d, Y.convertUpdateFormatV1ToV2(u1)) },
    { name: 'rtV2toV1', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Y.Doc} d */ d => Y.applyUpdate(d, Y.convertUpdateFormatV2ToV1(u2)) }
  ]
  try {
    for (let i = 0; i < rtDocs.length; i++) {
      const rt = rtDocs[i]
      rt.apply(rt.doc)
      verifySubdocInvariants(rt.doc, `${label}:${rt.name}`, true)
      assertInvariant(equalBytes(sv0, Y.encodeStateVector(rt.doc)), `${label}:${rt.name}: SV mismatch`)
      assertInvariant(rt.doc.subdocs.size === d0.subdocs.size, `${label}:${rt.name}: subdocs.size mismatch`)
      const gCmp = deepEqualValues(guidsMulti0, Array.from(rt.doc.subdocs).map(s => s.guid).sort(), `${rt.name}.guids`)
      assertInvariant(gCmp.equal, `${label}:${rt.name}: subdoc guids mismatch (${gCmp.reason})`)
      for (let k = 0; k < ROOT_KEYS.length; k++) {
        const rootKey = ROOT_KEYS[k]
        const dCmp = deepEqualValues(deltas0[k], sanitizeForCompare(rt.doc.get(rootKey).toDeltaDeep().toJSON()), `${rt.name}.${rootKey}`)
        assertInvariant(dCmp.equal, `${label}:${rt.name}: root '${rootKey}' delta mismatch (${dCmp.reason})`)
      }
    }
  } finally {
    for (let i = 0; i < rtDocs.length; i++) {
      rtDocs[i].doc.destroy()
    }
  }
}

/**
 * Collect all reachable live Y.Node containers (roots + nested children/map nodes, bounded depth).
 *
 * @param {Y.Doc} doc
 * @return {Array<Y.Node>}
 */
const collectLiveNodes = doc => {
  /** @type {Array<Y.Node>} */
  const result = []
  /** @type {Array<{ node: Y.Node, depth: number }>} */
  const queue = ROOT_KEYS.map(k => ({ node: doc.get(k), depth: 0 }))
  while (queue.length > 0 && result.length < 24) {
    const cur = queue.shift()
    if (cur === undefined) break
    result.push(cur.node)
    if (cur.depth >= 3) continue
    for (let item = cur.node._start; item !== null; item = item.right) {
      if (!item.deleted && item.content instanceof Y.ContentType) {
        queue.push({ node: item.content.type, depth: cur.depth + 1 })
      }
    }
    cur.node._map.forEach(item => {
      if (!item.deleted && item.content instanceof Y.ContentType) {
        queue.push({ node: item.content.type, depth: cur.depth + 1 })
      }
    })
  }
  return result
}

/**
 * Run one deterministic multi-client subdoc + deep nested Y.Node fuzzing scenario.
 *
 * @param {{
 *   seed: number,
 *   scenario: SubdocScenario,
 *   ops: number,
 *   numClients: number,
 *   trace: Array<string>
 * }} cfg
 * @return {SubdocStats}
 */
export const runSubdocScenario = ({ seed, scenario, ops, numClients, trace }) => {
  const gen = prng.create(seed)
  /** @type {SubdocStats} */
  const stats = {
    ops: 0,
    subdocsInserted: 0,
    subdocsLoaded: 0,
    subdocsEdited: 0,
    subdocsDestroyed: 0,
    subdocsDeleted: 0,
    parentsDestroyed: 0,
    undos: 0,
    redos: 0,
    msgs: 0,
    dups: 0,
    merges: 0,
    subdocsEvents: 0
  }

  /** @type {Array<SubdocPeer>} */
  const peers = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const uniqueV1 = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const uniqueV2 = []
  /** @type {Array<Y.Doc>} */
  const extraDocs = []
  /** @param {Y.Doc} d */
  const ownDoc = d => { extraDocs.push(d); return d }

  let guidCounter = 1
  const nextSubdocOpts = () => {
    // Reuse a few guids occasionally to test duplicate-guid subdocs as well as unique guids
    const guid = prng.uint32(gen, 0, 5) === 0 && guidCounter > 1
      ? `sub-${prng.uint32(gen, 1, guidCounter - 1)}`
      : `sub-${guidCounter++}`
    const autoLoad = prng.uint32(gen, 0, 3) === 0
    const shouldLoad = autoLoad ? true : prng.bool(gen)
    const gc = prng.bool(gen)
    const meta = prng.bool(gen) ? { tag: guidCounter % 7 } : null
    return { guid, autoLoad, shouldLoad, gc, meta }
  }

  try {
    const undoCount = math.max(1, math.floor(numClients * scenario.undoRatio))
    for (let i = 0; i < numClients; i++) {
      const gc = scenario.gcMode === 'all-on'
        ? true
        : scenario.gcMode === 'all-off'
          ? false
          : (i % 2 === 1)
      const doc = new Y.Doc({ gc })
      doc.clientID = 2000 + i * 29 + prng.uint32(gen, 0, 11)
      const roots = ROOT_KEYS.map(k => doc.get(k))
      const um = i < undoCount ? new Y.UndoManager(roots, { captureTimeout: 0 }) : null

      /** @type {SubdocPeer} */
      const peer = {
        index: i,
        doc,
        um,
        alive: true,
        online: true,
        cluster: 0,
        loadCallbackViolations: [],
        subdocsEvents: 0,
        destroyedSubdocs: [],
        inbox: [],
        histV1: [],
        histV2: []
      }
      peers.push(peer)

      // DOC-2 invariant: EVERY subdoc in `loaded` inside synchronous `'subdocs'` event MUST have shouldLoad === true
      doc.on('subdocs', ({ loaded, removed }) => {
        peer.subdocsEvents++
        stats.subdocsEvents++
        loaded.forEach(s => {
          if (s.shouldLoad !== true) {
            peer.loadCallbackViolations.push(`p${i}: subdoc(guid=${s.guid}) had shouldLoad=${String(s.shouldLoad)} inside 'subdocs' loaded callback (DOC-2)`)
          }
        })
        removed.forEach(s => {
          if (peer.destroyedSubdocs.length < 32) {
            peer.destroyedSubdocs.push(s)
          }
        })
      })

      doc.on('update', (u, origin) => {
        if (origin === NET_ORIGIN) return
        uniqueV1.push(u)
        if (!peer.online || !peer.alive) return
        if (prng.real53(gen) >= scenario.v2Ratio) {
          for (let j = 0; j < peers.length; j++) {
            const dst = peers[j]
            if (dst.index !== peer.index && dst.alive && dst.online && dst.cluster === peer.cluster) {
              dst.inbox.push({ fmt: 'v1', data: u })
            }
          }
        }
      })

      doc.on('updateV2', (u2, origin) => {
        if (origin === NET_ORIGIN) return
        uniqueV2.push(u2)
        if (!peer.online || !peer.alive) return
        if (prng.real53(gen) < scenario.v2Ratio) {
          for (let j = 0; j < peers.length; j++) {
            const dst = peers[j]
            if (dst.index !== peer.index && dst.alive && dst.online && dst.cluster === peer.cluster) {
              dst.inbox.push({ fmt: 'v2', data: u2 })
            }
          }
        }
      })
    }

    /**
     * Deliver one out-of-order update or merged batch to a live peer.
     *
     * @param {SubdocPeer} dst
     * @param {boolean} allowDup
     */
    const deliverOne = (dst, allowDup) => {
      if (!dst.alive || dst.inbox.length === 0) return
      if (dst.inbox.length >= 2 && prng.uint32(gen, 0, 3) === 0) {
        const fmt = dst.inbox[prng.uint32(gen, 0, dst.inbox.length - 1)].fmt
        /** @type {Array<number>} */
        const idxs = []
        for (let k = 0; k < dst.inbox.length && idxs.length < 3; k++) {
          if (dst.inbox[k].fmt === fmt) idxs.push(k)
        }
        if (idxs.length >= 2) {
          /** @type {Array<Uint8Array<ArrayBuffer>>} */
          const batch = []
          for (let k = idxs.length - 1; k >= 0; k--) {
            batch.push(dst.inbox[idxs[k]].data)
            if (!allowDup || prng.real53(gen) >= scenario.dupRate) {
              dst.inbox.splice(idxs[k], 1)
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
      const pick = prng.uint32(gen, 0, dst.inbox.length - 1)
      const pkt = dst.inbox[pick]
      if (!allowDup || prng.real53(gen) >= scenario.dupRate) {
        dst.inbox.splice(pick, 1)
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
     * Pairwise SV diff sync between two alive peers.
     *
     * @param {SubdocPeer} src
     * @param {SubdocPeer} dst
     */
    const syncPair = (src, dst) => {
      if (!src.alive || !dst.alive) return
      const sv = Y.encodeStateVector(dst.doc)
      if (prng.bool(gen)) {
        Y.applyUpdate(dst.doc, Y.encodeStateAsUpdate(src.doc, sv), NET_ORIGIN)
      } else {
        Y.applyUpdateV2(dst.doc, Y.encodeStateAsUpdateV2(src.doc, sv), NET_ORIGIN)
      }
    }

    const midDestroyStep = math.floor(ops * 0.6)

    for (let step = 0; step < ops; step++) {
      const alivePeers = peers.filter(p => p.alive)
      const peer = prng.oneOf(gen, alivePeers)
      const nodes = collectLiveNodes(peer.doc)
      const targetNode = prng.oneOf(gen, nodes)
      const action = prng.uint32(gen, 0, 99)

      if (action < 22) {
        // Insert a subdoc into list slot of root or nested Y.Node
        const sub = new Y.Doc(nextSubdocOpts())
        const pos = prng.uint32(gen, 0, targetNode.length)
        targetNode.insert(pos, [sub])
        if (peer.um !== null && prng.bool(gen)) peer.um.stopCapturing()
        stats.subdocsInserted++
        pushTrace(trace, `s${step}:p${peer.index}:insSubdocList(${sub.guid},sl=${sub.shouldLoad})`)
      } else if (action < 40) {
        // Insert or overwrite a subdoc in a map attribute of root or nested Y.Node
        const sub = new Y.Doc(nextSubdocOpts())
        const key = prng.oneOf(gen, MAP_KEYS)
        targetNode.setAttr(key, sub)
        if (peer.um !== null && prng.bool(gen)) peer.um.stopCapturing()
        stats.subdocsInserted++
        pushTrace(trace, `s${step}:p${peer.index}:setSubdocAttr(${key},${sub.guid})`)
      } else if (action < 54) {
        // Insert a nested Y.Node (folder) into list or map, optionally pre-populated with a subdoc
        const child = new Y.Node('folder')
        if (prng.bool(gen)) {
          const pos = prng.uint32(gen, 0, targetNode.length)
          targetNode.insert(pos, [child])
        } else {
          targetNode.setAttr(prng.oneOf(gen, ['folderA', 'folderB']), child)
        }
        if (prng.bool(gen)) {
          const innerSub = new Y.Doc(nextSubdocOpts())
          child.insert(0, [innerSub])
          stats.subdocsInserted++
        } else {
          child.insert(0, `n${step}`)
        }
        if (peer.um !== null && prng.bool(gen)) peer.um.stopCapturing()
        pushTrace(trace, `s${step}:p${peer.index}:insNestedFolder`)
      } else if (action < 64) {
        // Call subdoc.load() on a live subdoc (tests DOC-2!)
        const liveSubs = Array.from(peer.doc.subdocs)
        if (liveSubs.length > 0) {
          const sub = prng.oneOf(gen, liveSubs)
          sub.load()
          assertInvariant(sub.shouldLoad === true, `s${step}:p${peer.index}: subdoc.shouldLoad false after load()`)
          stats.subdocsLoaded++
          pushTrace(trace, `s${step}:p${peer.index}:load(${sub.guid})`)
        }
      } else if (action < 72) {
        // Edit content inside a live subdoc
        const liveSubs = Array.from(peer.doc.subdocs)
        if (liveSubs.length > 0) {
          const sub = prng.oneOf(gen, liveSubs)
          sub.get('body').insert(0, `e${step}`)
          sub.get('meta').setAttr('step', step)
          stats.subdocsEdited++
          pushTrace(trace, `s${step}:p${peer.index}:editSub(${sub.guid})`)
        }
      } else if (action < 80) {
        // Call subdoc.destroy() on a live subdoc (replaces in parent!) OR on an already-removed subdoc (idempotent!)
        const liveSubs = Array.from(peer.doc.subdocs)
        if (peer.destroyedSubdocs.length > 0 && prng.uint32(gen, 0, 2) === 0) {
          const dead = prng.oneOf(gen, peer.destroyedSubdocs)
          dead.destroy()
          stats.subdocsDestroyed++
          pushTrace(trace, `s${step}:p${peer.index}:destroyRemovedSub(${dead.guid})`)
        } else if (liveSubs.length > 0) {
          const sub = prng.oneOf(gen, liveSubs)
          const oldGuid = sub.guid
          const sizeBefore = peer.doc.subdocs.size
          sub.destroy()
          // Destroying a live subdoc replaces it with a fresh placeholder subdoc of the same guid
          assertInvariant(
            peer.doc.subdocs.size === sizeBefore && !peer.doc.subdocs.has(sub),
            `s${step}:p${peer.index}: destroying live subdoc(${oldGuid}) left unexpected subdocs.size (${peer.doc.subdocs.size} vs ${sizeBefore})`
          )
          stats.subdocsDestroyed++
          pushTrace(trace, `s${step}:p${peer.index}:destroyLiveSub(${oldGuid})`)
        }
      } else if (action < 92) {
        // Delete a list element (subdoc or nested folder containing subdocs!) or deleteAttr
        if (targetNode.length > 0 && prng.bool(gen)) {
          const pos = prng.uint32(gen, 0, targetNode.length - 1)
          const span = math.min(prng.uint32(gen, 1, 2), targetNode.length - pos)
          targetNode.delete(pos, span)
          if (peer.um !== null && prng.bool(gen)) peer.um.stopCapturing()
          stats.subdocsDeleted++
          pushTrace(trace, `s${step}:p${peer.index}:delList(${pos},${span})`)
        } else {
          const k = prng.oneOf(gen, MAP_KEYS)
          if (targetNode.hasAttr(k)) {
            targetNode.deleteAttr(k)
            if (peer.um !== null && prng.bool(gen)) peer.um.stopCapturing()
            stats.subdocsDeleted++
            pushTrace(trace, `s${step}:p${peer.index}:delAttr(${k})`)
          }
        }
      } else if (peer.um !== null) {
        // Interleaved UndoManager undo / redo on subdoc inserts & deletions
        if (peer.um.canRedo() && prng.bool(gen)) {
          peer.um.redo()
          stats.redos++
          pushTrace(trace, `s${step}:p${peer.index}:redo`)
        } else if (peer.um.canUndo()) {
          peer.um.undo()
          stats.undos++
          pushTrace(trace, `s${step}:p${peer.index}:undo`)
        }
      }
      stats.ops++

      // Immediately assert zero DOC-2 violations in any fired `'subdocs'` callbacks
      for (let i = 0; i < peers.length; i++) {
        assertInvariant(
          peers[i].loadCallbackViolations.length === 0,
          peers[i].loadCallbackViolations[0] ?? ''
        )
      }

      // Destroy one parent doc mid-session (with live subdocs!) to verify DOC-1 clean teardown
      if (scenario.destroyParentMidRun && step === midDestroyStep && alivePeers.length > 3) {
        const victim = alivePeers[alivePeers.length - 1]
        // Flush victim's own authored state to a survivor's inbox before tearing it down,
        // so later out-of-order updates already sent by victim remain causally healable
        alivePeers[0].inbox.push({ fmt: 'v1', data: Y.encodeStateAsUpdate(victim.doc) })
        const victimSubsBefore = Array.from(victim.doc.subdocs)
        victim.um?.destroy()
        victim.um = null
        victim.doc.destroy()
        victim.alive = false
        victim.inbox.length = 0
        assertInvariant(
          victim.doc.isDestroyed && victim.doc.subdocs.size === 0,
          `${scenario.name}:s${step}: destroyed parent p${victim.index} leaked ${victim.doc.subdocs.size} subdoc(s) (DOC-1)`
        )
        for (let k = 0; k < victimSubsBefore.length; k++) {
          assertInvariant(
            victimSubsBefore[k].isDestroyed,
            `${scenario.name}:s${step}: destroying parent p${victim.index} failed to destroy child subdoc(${victimSubsBefore[k].guid})`
          )
        }
        stats.parentsDestroyed++
        pushTrace(trace, `s${step}:destroyParent(p${victim.index},subs=${victimSubsBefore.length})`)
      }

      // Network partition / reconnect
      if (step % 15 === 0) {
        const pOp = prng.uint32(gen, 0, 2)
        if (pOp === 0) {
          for (let i = 0; i < peers.length; i++) peers[i].cluster = prng.uint32(gen, 0, 1)
        } else if (pOp === 1) {
          const p = prng.oneOf(gen, peers.filter(x => x.alive))
          p.online = !p.online
        } else {
          for (let i = 0; i < peers.length; i++) {
            peers[i].online = true
            peers[i].cluster = 0
          }
        }
      }

      // Deliver out-of-order messages
      const deliveries = prng.uint32(gen, 1, 3)
      for (let d = 0; d < deliveries; d++) {
        const ready = peers.filter(p => p.alive && p.online && p.inbox.length > 0)
        if (ready.length === 0) break
        deliverOne(prng.oneOf(gen, ready), true)
      }

      // Duplicate replay check
      if (prng.real53(gen) < scenario.dupRate) {
        const dst = prng.oneOf(gen, peers.filter(p => p.alive))
        if (dst.histV1.length > 0 && prng.bool(gen)) {
          const oldU = prng.oneOf(gen, dst.histV1)
          const svBefore = Y.encodeStateVector(dst.doc)
          Y.applyUpdate(dst.doc, oldU, NET_ORIGIN)
          assertInvariant(equalBytes(svBefore, Y.encodeStateVector(dst.doc)), `s${step}:p${dst.index}: dup V1 altered SV`)
          stats.dups++
        } else if (dst.histV2.length > 0) {
          const oldU2 = prng.oneOf(gen, dst.histV2)
          const svBefore = Y.encodeStateVector(dst.doc)
          Y.applyUpdateV2(dst.doc, oldU2, NET_ORIGIN)
          assertInvariant(equalBytes(svBefore, Y.encodeStateVector(dst.doc)), `s${step}:p${dst.index}: dup V2 altered SV`)
          stats.dups++
        }
      }

      // Periodic mid-run subdoc + GC invariant sweep across all alive peers
      if (step > 0 && step % 25 === 0) {
        for (let i = 0; i < peers.length; i++) {
          if (peers[i].alive) {
            verifySubdocInvariants(peers[i].doc, `${scenario.name}:s${step}:p${i}`, false)
          }
        }
      }
    }

    // Final heal across all surviving peers
    const survivors = peers.filter(p => p.alive)
    for (let i = 0; i < survivors.length; i++) {
      survivors[i].online = true
      survivors[i].cluster = 0
    }
    while (true) {
      const ready = survivors.filter(p => p.inbox.length > 0)
      if (ready.length === 0) break
      deliverOne(prng.oneOf(gen, ready), false)
    }
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < survivors.length; i++) {
        syncPair(survivors[i], survivors[(i + 1) % survivors.length])
      }
      for (let i = 1; i < survivors.length; i++) {
        syncPair(survivors[0], survivors[i])
        syncPair(survivors[i], survivors[0])
      }
    }

    // Re-check zero DOC-2 callback violations across all survivors after final sync
    for (let i = 0; i < survivors.length; i++) {
      assertInvariant(
        survivors[i].loadCallbackViolations.length === 0,
        survivors[i].loadCallbackViolations[0] ?? ''
      )
    }

    // Synthetic convergence docs via shuffled + duplicate mergeUpdates / mergeUpdatesV2 / cloneDoc
    // Note: if a mid-run destroyed peer had unsynced local ops, survivors may not have them unless synced;
    // so only compare mergedV1/mergedV2 against survivors when no parent was destroyed mid-run!
    const verifyList = survivors.map(p => p.doc)
    const cloned = ownDoc(Y.cloneDoc(survivors[0].doc, { gc: survivors[0].doc.gc }))
    verifyList.push(cloned)
    if (!scenario.destroyParentMidRun && uniqueV1.length > 0 && uniqueV2.length > 0) {
      const shufV1 = shuffleCopy(gen, uniqueV1)
      if (shufV1.length > 2) shufV1.push(shufV1[0], shufV1[shufV1.length - 1])
      const m1 = ownDoc(new Y.Doc({ gc: survivors[0].doc.gc }))
      Y.applyUpdate(m1, Y.mergeUpdates(shufV1))

      const shufV2 = shuffleCopy(gen, uniqueV2)
      if (shufV2.length > 2) shufV2.push(shufV2[0], shufV2[shufV2.length - 1])
      const m2 = ownDoc(new Y.Doc({ gc: survivors[0].doc.gc }))
      Y.applyUpdateV2(m2, Y.mergeUpdatesV2(shufV2))
      verifyList.push(m1, m2)
    }

    verifySubdocConvergence(verifyList, scenario.name)

    // Verify clean parent teardown at end of run (DOC-1 on every surviving parent!)
    for (let i = 0; i < survivors.length; i++) {
      const p = survivors[i]
      p.um?.destroy()
      p.um = null
      p.doc.destroy()
      p.alive = false
      assertInvariant(
        p.doc.isDestroyed && p.doc.subdocs.size === 0,
        `${scenario.name}: final destroy() on p${p.index} leaked ${p.doc.subdocs.size} subdoc(s) (DOC-1)`
      )
    }

    return stats
  } finally {
    for (let i = 0; i < extraDocs.length; i++) {
      if (!extraDocs[i].isDestroyed) extraDocs[i].destroy()
    }
    for (let i = 0; i < peers.length; i++) {
      peers[i].um?.destroy()
      if (!peers[i].doc.isDestroyed) peers[i].doc.destroy()
    }
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20260707
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
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/subdoc-nested-fuzzer.js [--seed N] [--runs N] [--ops N] [--clients N] [--intensity low|medium|high|extreme] [--scenario NAME] [--report]')
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
    reportOnly
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

  console.log('=== Yjs v14 Subdoc Lifecycle & Deep Nested YNode Fuzzer ===')
  console.log(`baseSeed=${args.seed} intensity=${args.intensity} runs=${args.runs} clients=${args.clients} ops/run=${args.ops}`)

  for (let r = 0; r < args.runs; r++) {
    const scenario = selected[r % selected.length]
    const runSeed = args.seed + r * 42407
    /** @type {Array<string>} */
    const trace = []
    const rt0 = performance.now()
    try {
      const st = runSubdocScenario({
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
        `ops=${st.ops} subIns/Ld/Ed/Des/Del=${st.subdocsInserted}/${st.subdocsLoaded}/${st.subdocsEdited}/${st.subdocsDestroyed}/${st.subdocsDeleted} ` +
        `parDes=${st.parentsDestroyed} undo/redo=${st.undos}/${st.redos} msgs=${st.msgs} dups=${st.dups} ev=${st.subdocsEvents} time=${ms}ms`
      )
    } catch (err) {
      failed++
      const ms = (performance.now() - rt0).toFixed(1)
      const msg = err instanceof Error ? err.message : String(err)
      const repro = `node ./tests/lab/subdoc-nested-fuzzer.js --seed ${runSeed} --runs 1 --scenario ${scenario.name} --clients ${args.clients} --ops ${args.ops}`
      failures.push({ run: r + 1, scenario: scenario.name, seed: runSeed, error: msg, repro, trace: trace.slice(-12) })
      console.error(`[FAIL] run=${r + 1}/${args.runs} scenario=${scenario.name} seed=${runSeed} time=${ms}ms`)
      console.error(`       repro: ${repro}`)
      console.error(`       error: ${msg}`)
    }
  }

  if (failures.length > 0) {
    console.log('\n--- Subdoc Fuzzer Failure Traces ---')
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
