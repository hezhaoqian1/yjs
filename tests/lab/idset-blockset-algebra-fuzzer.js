import * as Y from '../../src/index.js'
import { writeStructsFromIdSet } from '../../src/utils/encoding-helpers.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'
import {
  assertInvariant,
  deepEqualValues,
  equalBytes,
  verifyDocInvariants
} from './invariants.js'

const ATTR_NAMES = ['insert', 'delete', 'format']
const ATTR_VALS = ['alice', 'bob', 'carol', 'dave']
const ROOT_SLOTS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']

/**
 * @typedef {'default' | 'high' | 'extreme'} Intensity
 */

/**
 * @typedef {{
 *   defaultRuns: number,
 *   s1OpsPerRun: number,
 *   s2Clients: number,
 *   s2TxsPerClient: number
 * }} IntensityConfig
 */

/** @type {Record<Intensity, IntensityConfig>} */
const INTENSITY_CONFIG = {
  default: { defaultRuns: 8, s1OpsPerRun: 14, s2Clients: 3, s2TxsPerClient: 7 },
  high: { defaultRuns: 16, s1OpsPerRun: 22, s2Clients: 4, s2TxsPerClient: 9 },
  extreme: { defaultRuns: 40, s1OpsPerRun: 30, s2Clients: 4, s2TxsPerClient: 10 }
}

/**
 * Shuffle a copy of an array deterministically.
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
 * Convert an IdSet to a ground-truth point-by-point mathematical model: Map<client, Set<clock>>.
 *
 * @param {Y.IdSet} idSet
 * @return {Map<number, Set<number>>}
 */
const idSetToModel = idSet => {
  /** @type {Map<number, Set<number>>} */
  const model = new Map()
  idSet.clients.forEach((ranges, client) => {
    const ids = ranges.getIds()
    for (let i = 0; i < ids.length; i++) {
      const r = ids[i]
      let cset = model.get(client)
      if (cset === undefined) {
        cset = new Set()
        model.set(client, cset)
      }
      for (let k = 0; k < r.len; k++) {
        cset.add(r.clock + k)
      }
    }
  })
  return model
}

/**
 * Compare two point-by-point IdSet reference models for exact equality.
 *
 * @param {Map<number, Set<number>>} a
 * @param {Map<number, Set<number>>} b
 * @param {string} label
 */
const assertEqualSetModels = (a, b, label) => {
  /** @type {Set<number>} */
  const clients = new Set([...a.keys(), ...b.keys()])
  for (const c of clients) {
    const sa = a.get(c)
    const sb = b.get(c)
    const sizeA = sa ? sa.size : 0
    const sizeB = sb ? sb.size : 0
    assertInvariant(sizeA === sizeB, `${label}: client ${c} point count mismatch (${sizeA} !== ${sizeB})`)
    if (sa !== undefined && sb !== undefined) {
      for (const clk of sa) {
        assertInvariant(sb.has(clk), `${label}: client ${c} missing clock ${clk}`)
      }
    }
  }
}

/**
 * Union of two IdSet reference models.
 *
 * @param {Map<number, Set<number>>} a
 * @param {Map<number, Set<number>>} b
 * @return {Map<number, Set<number>>}
 */
const unionSetModels = (a, b) => {
  /** @type {Map<number, Set<number>>} */
  const out = new Map()
  for (const [c, s] of a.entries()) out.set(c, new Set(s))
  for (const [c, s] of b.entries()) {
    let cur = out.get(c)
    if (cur === undefined) {
      cur = new Set()
      out.set(c, cur)
    }
    for (const clk of s) cur.add(clk)
  }
  return out
}

/**
 * Intersection of two IdSet reference models.
 *
 * @param {Map<number, Set<number>>} a
 * @param {Map<number, Set<number>>} b
 * @return {Map<number, Set<number>>}
 */
const intersectSetModels = (a, b) => {
  /** @type {Map<number, Set<number>>} */
  const out = new Map()
  for (const [c, sa] of a.entries()) {
    const sb = b.get(c)
    if (sb === undefined) continue
    /** @type {Set<number>} */
    const cur = new Set()
    for (const clk of sa) {
      if (sb.has(clk)) cur.add(clk)
    }
    if (cur.size > 0) out.set(c, cur)
  }
  return out
}

/**
 * Difference (a \ b) of two IdSet reference models.
 *
 * @param {Map<number, Set<number>>} a
 * @param {Map<number, Set<number>>} b
 * @return {Map<number, Set<number>>}
 */
const diffSetModels = (a, b) => {
  /** @type {Map<number, Set<number>>} */
  const out = new Map()
  for (const [c, sa] of a.entries()) {
    const sb = b.get(c)
    /** @type {Set<number>} */
    const cur = new Set()
    for (const clk of sa) {
      if (sb === undefined || !sb.has(clk)) cur.add(clk)
    }
    if (cur.size > 0) out.set(c, cur)
  }
  return out
}

/**
 * Canonical string key for a ContentAttribute.
 *
 * @param {Y.ContentAttribute<string>} a
 * @return {string}
 */
const attrKey = a => `${a.name}:${a.val}`

/**
 * Convert an IdMap to a ground-truth point-by-point model: Map<client, Map<clock, Set<attrKey>>>.
 *
 * @param {Y.IdMap<string>} idMap
 * @return {Map<number, Map<number, Set<string>>>}
 */
const idMapToModel = idMap => {
  /** @type {Map<number, Map<number, Set<string>>>} */
  const model = new Map()
  idMap.clients.forEach((ranges, client) => {
    const ids = ranges.getIds()
    for (let i = 0; i < ids.length; i++) {
      const r = ids[i]
      let cmap = model.get(client)
      if (cmap === undefined) {
        cmap = new Map()
        model.set(client, cmap)
      }
      for (let k = 0; k < r.len; k++) {
        let aset = cmap.get(r.clock + k)
        if (aset === undefined) {
          aset = new Set()
          cmap.set(r.clock + k, aset)
        }
        for (let j = 0; j < r.attrs.length; j++) {
          aset.add(attrKey(r.attrs[j]))
        }
      }
    }
  })
  return model
}

/**
 * Compare two point-by-point IdMap reference models for exact equality.
 *
 * @param {Map<number, Map<number, Set<string>>>} a
 * @param {Map<number, Map<number, Set<string>>>} b
 * @param {string} label
 */
const assertEqualMapModels = (a, b, label) => {
  /** @type {Set<number>} */
  const clients = new Set([...a.keys(), ...b.keys()])
  for (const c of clients) {
    const ma = a.get(c)
    const mb = b.get(c)
    const sizeA = ma ? ma.size : 0
    const sizeB = mb ? mb.size : 0
    assertInvariant(sizeA === sizeB, `${label}: client ${c} clock count mismatch (${sizeA} !== ${sizeB})`)
    if (ma !== undefined && mb !== undefined) {
      for (const [clk, sa] of ma.entries()) {
        const sb = mb.get(clk)
        assertInvariant(sb !== undefined, `${label}: client ${c} missing clock ${clk}`)
        if (sb !== undefined) {
          const ka = Array.from(sa).sort().join(',')
          const kb = Array.from(sb).sort().join(',')
          assertInvariant(ka === kb, `${label}: client ${c}@${clk} attrs mismatch (${ka} !== ${kb})`)
        }
      }
    }
  }
}

/**
 * Verify internal health, schema compliance, range sorting, and binary roundtrip of an IdSet.
 *
 * @param {Y.IdSet} s
 * @param {string} label
 */
const assertIdSetHealth = (s, label) => {
  assertInvariant(Y.$idSet.check(s), `${label}: $idSet schema check failed`)
  s.clients.forEach((ranges, client) => {
    const ids = ranges.getIds()
    let prevEnd = -1
    for (let i = 0; i < ids.length; i++) {
      const r = ids[i]
      assertInvariant(r.len > 0 && r.clock >= 0, `${label}: client ${client} invalid range (${r.clock}, len=${r.len})`)
      assertInvariant(r.clock > prevEnd, `${label}: client ${client} unsorted/overlapping/unmerged range ${r.clock} <= ${prevEnd}`)
      prevEnd = r.clock + r.len
    }
  })
  const decoded = Y.decodeIdSet(Y.encodeIdSet(s))
  assertInvariant(Y.equalIdSets(s, decoded), `${label}: encodeIdSet/decodeIdSet roundtrip mismatch`)
}

/**
 * Verify internal health, deduplication, attr interning, schema compliance, and binary roundtrip of an IdMap.
 *
 * @param {Y.IdMap<string>} m
 * @param {string} label
 */
const assertIdMapHealth = (m, label) => {
  assertInvariant(Y.$idMapAny.check(m), `${label}: $idMapAny schema check failed`)
  m.clients.forEach((ranges, client) => {
    const ids = ranges.getIds()
    let prevEnd = -1
    for (let i = 0; i < ids.length; i++) {
      const r = ids[i]
      assertInvariant(r.len > 0 && r.clock >= 0, `${label}: client ${client} invalid AttrRange (${r.clock}, len=${r.len})`)
      assertInvariant(r.clock >= prevEnd, `${label}: client ${client} overlapping AttrRange ${r.clock} < ${prevEnd}`)
      prevEnd = r.clock + r.len
      /** @type {Set<string>} */
      const seen = new Set()
      for (let j = 0; j < r.attrs.length; j++) {
        const attr = r.attrs[j]
        const key = attrKey(attr)
        assertInvariant(!seen.has(key), `${label}: client ${client}@${r.clock} contains duplicate equal ContentAttribute (${key})`)
        seen.add(key)
        assertInvariant(
          m.attrs.has(attr) && m.attrsH.get(attr.hash()) === attr,
          `${label}: client ${client}@${r.clock} ContentAttribute (${key}) is not interned in m.attrs/m.attrsH (attrs.size=${m.attrs.size})`
        )
      }
    }
  })
  const encoded = Y.encodeIdMap(m)
  /** @type {Y.IdMap<string>} */
  const decoded = Y.decodeIdMap(encoded)
  assertEqualMapModels(idMapToModel(m), idMapToModel(decoded), `${label}:encode/decodeIdMap`)
}

/**
 * Generate a random IdSet across clients 1..3 with overlapping, adjacent, and disjoint ranges.
 *
 * @param {prng.PRNG} gen
 * @param {number} count
 * @return {Y.IdSet}
 */
const buildRandomIdSet = (gen, count) => {
  const s = Y.createIdSet()
  for (let i = 0; i < count; i++) {
    const client = prng.uint32(gen, 1, 3)
    const clock = prng.uint32(gen, 0, 28)
    const len = prng.uint32(gen, 1, 7)
    s.add(client, clock, len)
  }
  return s
}

/**
 * Generate a random IdMap across clients 1..3 using fresh ContentAttribute instances (stresses interning!).
 *
 * @param {prng.PRNG} gen
 * @param {number} count
 * @return {Y.IdMap<string>}
 */
const buildRandomIdMap = (gen, count) => {
  /** @type {Y.IdMap<string>} */
  const m = Y.createIdMap()
  for (let i = 0; i < count; i++) {
    const client = prng.uint32(gen, 1, 3)
    const clock = prng.uint32(gen, 0, 28)
    const len = prng.uint32(gen, 1, 7)
    const numAttrs = prng.uint32(gen, 1, 2)
    /** @type {Array<Y.ContentAttribute<string>>} */
    const attrs = []
    for (let j = 0; j < numAttrs; j++) {
      attrs.push(Y.createContentAttribute(prng.oneOf(gen, ATTR_NAMES), prng.oneOf(gen, ATTR_VALS)))
    }
    m.add(client, clock, len, attrs)
  }
  return m
}

/**
 * Compute per-client tail end clocks (maxClock + 1) from a point-by-point model without touching any IdSet/IdMap._lastIsUsed flag.
 *
 * @param {Map<number, Set<number>> | Map<number, Map<number, Set<string>>>} model
 * @return {Array<{ client: number, end: number }>}
 */
const tailsFromModel = model => {
  /** @type {Array<{ client: number, end: number }>} */
  const tails = []
  for (const [client, clocks] of model.entries()) {
    let maxClk = -1
    for (const clk of clocks.keys()) {
      if (clk > maxClk) maxClk = clk
    }
    if (maxClk >= 0) tails.push({ client, end: maxClk + 1 })
  }
  return tails
}

/**
 * Mutate a derived IdSet aggressively WITHOUT calling out.getIds() first, so _lastIsUsed stays false and catches ID-COPY-2 aliasing!
 *
 * @param {Y.IdSet} out
 * @param {Array<{ client: number, end: number }>} tails
 */
const aggressivelyMutateIdSet = (out, tails) => {
  for (let i = 0; i < tails.length; i++) {
    out.add(tails[i].client, tails[i].end, 3)
  }
  out.add(1, 0, 2)
  out.delete(1, 1, 2)
}

/**
 * Mutate a derived IdMap aggressively WITHOUT calling out.getIds() first (tail append + new sentinel attrs + delete).
 *
 * @param {Y.IdMap<string>} out
 * @param {Array<{ client: number, end: number }>} tails
 */
const aggressivelyMutateIdMap = (out, tails) => {
  for (let i = 0; i < tails.length; i++) {
    out.add(tails[i].client, tails[i].end, 3, [Y.createContentAttribute('sentinel', 'tail')])
  }
  out.add(1, 0, 2, [Y.createContentAttribute('sentinel', 'head')])
  out.delete(1, 1, 1)
}

/**
 * Suite 1: IdSet & IdMap Algebraic, Interning, Schema, and Anti-Aliasing Property Fuzzer.
 *
 * @param {number} seed
 * @param {IntensityConfig} cfg
 */
const runIdSetIdMapAlgebraSuite = (seed, cfg) => {
  const gen = prng.create(seed)
  const sA = buildRandomIdSet(gen, cfg.s1OpsPerRun)
  const sB = buildRandomIdSet(gen, cfg.s1OpsPerRun)
  const sC = buildRandomIdSet(gen, cfg.s1OpsPerRun)
  const mA = buildRandomIdMap(gen, cfg.s1OpsPerRun)
  const mB = buildRandomIdMap(gen, cfg.s1OpsPerRun)
  const mC = buildRandomIdMap(gen, cfg.s1OpsPerRun)

  assertIdSetHealth(sA, 'S1:sA')
  assertIdSetHealth(sB, 'S1:sB')
  assertIdSetHealth(sC, 'S1:sC')
  assertIdMapHealth(mA, 'S1:mA')
  assertIdMapHealth(mB, 'S1:mB')
  assertIdMapHealth(mC, 'S1:mC')

  const modA = idSetToModel(sA)
  const modB = idSetToModel(sB)
  const modMA = idMapToModel(mA)
  const modMB = idMapToModel(mB)

  // Snapshot exact serialized inputs & attr pool sizes to assert strict immutability / anti-aliasing
  const snapSA = Y.encodeIdSet(sA)
  const snapSB = Y.encodeIdSet(sB)
  const snapSC = Y.encodeIdSet(sC)
  const snapMA = Y.encodeIdMap(mA)
  const snapMB = Y.encodeIdMap(mB)
  const snapMC = Y.encodeIdMap(mC)
  const mAAttrsSize = mA.attrs.size
  const mAAttrsHSize = mA.attrsH.size
  const mBAttrsSize = mB.attrs.size
  const mBAttrsHSize = mB.attrsH.size

  const assertInputsUnchanged = /** @param {string} step */ step => {
    assertInvariant(equalBytes(Y.encodeIdSet(sA), snapSA), `${step}: input sA was mutated via aliasing!`)
    assertInvariant(equalBytes(Y.encodeIdSet(sB), snapSB), `${step}: input sB was mutated via aliasing!`)
    assertInvariant(equalBytes(Y.encodeIdSet(sC), snapSC), `${step}: input sC was mutated via aliasing!`)
    assertInvariant(equalBytes(Y.encodeIdMap(mA), snapMA), `${step}: input mA was mutated via aliasing!`)
    assertInvariant(equalBytes(Y.encodeIdMap(mB), snapMB), `${step}: input mB was mutated via aliasing!`)
    assertInvariant(equalBytes(Y.encodeIdMap(mC), snapMC), `${step}: input mC was mutated via aliasing!`)
    assertInvariant(
      mA.attrs.size === mAAttrsSize && mA.attrsH.size === mAAttrsHSize,
      `${step}: input mA.attrs/attrsH mutated via aliasing (${mA.attrs.size}/${mA.attrsH.size} !== ${mAAttrsSize}/${mAAttrsHSize})`
    )
    assertInvariant(
      mB.attrs.size === mBAttrsSize && mB.attrsH.size === mBAttrsHSize,
      `${step}: input mB.attrs/attrsH mutated via aliasing (${mB.attrs.size}/${mB.attrsH.size} !== ${mBAttrsSize}/${mBAttrsHSize})`
    )
  }

  // 1. IdSet algebraic laws: union, intersection, difference, commutativity, associativity, partition identity
  const uAB = Y.mergeIdSets([sA, sB])
  const uBA = Y.mergeIdSets([sB, sA])
  assertIdSetHealth(uAB, 'S1:mergeIdSets(A,B)')
  assertEqualSetModels(idSetToModel(uAB), unionSetModels(modA, modB), 'S1:mergeIdSets(A,B)')
  assertInvariant(Y.equalIdSets(uAB, uBA), 'S1: mergeIdSets not commutative')
  assertInvariant(
    Y.equalIdSets(Y.mergeIdSets([uAB, sC]), Y.mergeIdSets([sA, Y.mergeIdSets([sB, sC])])),
    'S1: mergeIdSets not associative'
  )
  assertInvariant(Y.equalIdSets(Y.mergeIdSets([sA, sA]), sA), 'S1: mergeIdSets not idempotent')

  const iAB = Y.intersectSets(sA, sB)
  const iBA = Y.intersectSets(sB, sA)
  assertIdSetHealth(iAB, 'S1:intersectSets(A,B)')
  assertEqualSetModels(idSetToModel(iAB), intersectSetModels(modA, modB), 'S1:intersectSets(A,B)')
  assertInvariant(Y.equalIdSets(iAB, iBA), 'S1: intersectSets not commutative')
  assertInvariant(
    Y.equalIdSets(Y.intersectSets(iAB, sC), Y.intersectSets(sA, Y.intersectSets(sB, sC))),
    'S1: intersectSets not associative'
  )

  const dAB = Y.diffIdSet(sA, sB)
  assertIdSetHealth(dAB, 'S1:diffIdSet(A,B)')
  assertEqualSetModels(idSetToModel(dAB), diffSetModels(modA, modB), 'S1:diffIdSet(A,B)')
  assertInvariant(Y.equalIdSets(Y.mergeIdSets([dAB, iAB]), sA), 'S1: (A\\B) U (A&B) !== A')

  // 2. IdSet anti-aliasing checks (catches ID-COPY-1 & ID-COPY-2 without calling getIds() on derived copies!)
  const tailsA = tailsFromModel(modA)
  const tailsUAB = tailsFromModel(unionSetModels(modA, modB))
  const tailsDAB = tailsFromModel(diffSetModels(modA, modB))
  const tailsIAB = tailsFromModel(intersectSetModels(modA, modB))

  sA.clients.forEach((ranges, client) => {
    const cpy = ranges.copy()
    const tail = tailsA.find(t => t.client === client)
    if (tail !== undefined) {
      cpy.add(tail.end, 3)
    }
  })
  assertInputsUnchanged('S1:IdRanges.copy()')
  aggressivelyMutateIdSet(Y.mergeIdSets([sA]), tailsA)
  assertInputsUnchanged('S1:mergeIdSets([sA])')
  aggressivelyMutateIdSet(Y.mergeIdSets([sA, sB]), tailsUAB)
  assertInputsUnchanged('S1:mergeIdSets([sA,sB])')
  aggressivelyMutateIdSet(Y.diffIdSet(sA, Y.createIdSet()), tailsA)
  assertInputsUnchanged('S1:diffIdSet(sA,empty)')
  aggressivelyMutateIdSet(Y.diffIdSet(sA, sB), tailsDAB)
  assertInputsUnchanged('S1:diffIdSet(sA,sB)')
  aggressivelyMutateIdSet(Y.intersectSets(sA, sB), tailsIAB)
  assertInputsUnchanged('S1:intersectSets(sA,sB)')
  const insDest = Y.createIdSet()
  Y.insertIntoIdSet(insDest, sA)
  aggressivelyMutateIdSet(insDest, tailsA)
  assertInputsUnchanged('S1:insertIntoIdSet(dest,sA)')

  // 3. IdMap algebraic laws: mergeIdMaps, intersectMaps, diffIdMap, filterIdMap, insertIntoIdMap
  const mAB = Y.mergeIdMaps([mA, mB])
  const mBA = Y.mergeIdMaps([mB, mA])
  assertIdMapHealth(mAB, 'S1:mergeIdMaps(A,B)')
  assertIdMapHealth(mBA, 'S1:mergeIdMaps(B,A)')
  assertEqualMapModels(idMapToModel(mAB), idMapToModel(mBA), 'S1:mergeIdMaps-commutativity')
  const mABC1 = Y.mergeIdMaps([mAB, mC])
  const mABC2 = Y.mergeIdMaps([mA, Y.mergeIdMaps([mB, mC])])
  assertIdMapHealth(mABC1, 'S1:mergeIdMaps-assoc1')
  assertEqualMapModels(idMapToModel(mABC1), idMapToModel(mABC2), 'S1:mergeIdMaps-associativity')

  // Build exact mathematical reference model for intersectMaps(mA, mB)
  /** @type {Map<number, Map<number, Set<string>>>} */
  const expectedInterMap = new Map()
  for (const [c, mapA] of modMA.entries()) {
    const mapB = modMB.get(c)
    if (mapB === undefined) continue
    /** @type {Map<number, Set<string>>} */
    const cmap = new Map()
    for (const [clk, attrsA] of mapA.entries()) {
      const attrsB = mapB.get(clk)
      if (attrsB === undefined) continue
      cmap.set(clk, new Set([...attrsA, ...attrsB]))
    }
    if (cmap.size > 0) expectedInterMap.set(c, cmap)
  }
  const imAB = Y.intersectMaps(mA, mB)
  const imBA = Y.intersectMaps(mB, mA)
  assertIdMapHealth(imAB, 'S1:intersectMaps(A,B)')
  assertIdMapHealth(imBA, 'S1:intersectMaps(B,A)')
  assertEqualMapModels(idMapToModel(imAB), expectedInterMap, 'S1:intersectMaps(A,B)')
  assertEqualMapModels(idMapToModel(imAB), idMapToModel(imBA), 'S1:intersectMaps-commutativity')

  // diffIdMap(mA, sB) and diffIdMap(mA, empty)
  const dmAS = Y.diffIdMap(mA, sB)
  assertIdMapHealth(dmAS, 'S1:diffIdMap(mA,sB)')
  /** @type {Map<number, Map<number, Set<string>>>} */
  const expectedDiffMap = new Map()
  for (const [c, mapA] of modMA.entries()) {
    const excl = modB.get(c)
    /** @type {Map<number, Set<string>>} */
    const cmap = new Map()
    for (const [clk, attrsA] of mapA.entries()) {
      if (excl === undefined || !excl.has(clk)) cmap.set(clk, new Set(attrsA))
    }
    if (cmap.size > 0) expectedDiffMap.set(c, cmap)
  }
  assertEqualMapModels(idMapToModel(dmAS), expectedDiffMap, 'S1:diffIdMap(mA,sB)')

  // filterIdMap keeping only ranges with an 'insert' attribute
  const fmA = Y.filterIdMap(mA, attrs => attrs.some(a => a.name === 'insert'))
  assertIdMapHealth(fmA, 'S1:filterIdMap(mA)')

  // insertIntoIdMap(dest, sA) followed by dest.add(...) AND insertIntoIdMap(dest, mB) (catches BUG-IDMAP-INSERT!)
  /** @type {Y.IdMap<string>} */
  const mapFromSet = Y.createIdMap()
  Y.insertIntoIdMap(mapFromSet, sA)
  mapFromSet.add(1, 0, 4, [Y.createContentAttribute('insert', 'alice')])
  const sliceAfterSet = mapFromSet.slice(1, 0, 4)
  assertInvariant(
    sliceAfterSet.length > 0 && sliceAfterSet.every(r => r.attrs !== null && r.attrs.some(a => a.name === 'insert' && a.val === 'alice')),
    'S1: insertIntoIdMap(dest, IdSet) + dest.add() erased attributes (BUG-IDMAP-INSERT)'
  )
  assertIdMapHealth(mapFromSet, 'S1:insertIntoIdMap(dest,sA)+add')

  /** @type {Y.IdMap<string>} */
  const mapMerged = Y.createIdMap()
  Y.insertIntoIdMap(mapMerged, mA)
  Y.insertIntoIdMap(mapMerged, mB)
  assertIdMapHealth(mapMerged, 'S1:insertIntoIdMap(mA,mB)')
  assertEqualMapModels(idMapToModel(mapMerged), idMapToModel(mAB), 'S1:insertIntoIdMap-vs-mergeIdMaps')

  // 4. IdMap anti-aliasing checks (catches BUG-IDMAP-INTERSECT(B) & hidden aliasing!)
  const tailsMA = tailsFromModel(modMA)
  const tailsDiffMA = tailsFromModel(expectedDiffMap)
  const tailsInterMA = tailsFromModel(expectedInterMap)
  aggressivelyMutateIdMap(Y.diffIdMap(mA, Y.createIdSet()), tailsMA)
  assertInputsUnchanged('S1:diffIdMap(mA,empty)')
  aggressivelyMutateIdMap(Y.diffIdMap(mA, sB), tailsDiffMA)
  assertInputsUnchanged('S1:diffIdMap(mA,sB)')
  aggressivelyMutateIdMap(Y.mergeIdMaps([mA, mB]), tailsMA)
  assertInputsUnchanged('S1:mergeIdMaps(mA,mB)')
  aggressivelyMutateIdMap(Y.intersectMaps(mA, mB), tailsInterMA)
  assertInputsUnchanged('S1:intersectMaps(mA,mB)')
  aggressivelyMutateIdMap(Y.filterIdMap(mA, attrs => attrs.some(a => a.name === 'insert')), tailsMA)
  assertInputsUnchanged('S1:filterIdMap(mA)')
  /** @type {Y.IdMap<string>} */
  const mapMergedFresh = Y.createIdMap()
  Y.insertIntoIdMap(mapMergedFresh, mA)
  Y.insertIntoIdMap(mapMergedFresh, mB)
  aggressivelyMutateIdMap(mapMergedFresh, tailsMA)
  assertInputsUnchanged('S1:insertIntoIdMap(mA,mB)')
}

/**
 * Assert decoded update has zero leading or trailing Skips per client and strictly contiguous clocks.
 *
 * @param {Uint8Array} update
 * @param {'v1' | 'v2'} fmt
 * @param {string} label
 */
const assertNoLeadingOrTrailingSkips = (update, fmt, label) => {
  const dec = fmt === 'v1' ? Y.decodeUpdate(update) : Y.decodeUpdateV2(update)
  /** @type {Map<number, Array<Y.Item | Y.GC | Y.Skip>>} */
  const byClient = new Map()
  for (let i = 0; i < dec.structs.length; i++) {
    const s = dec.structs[i]
    let list = byClient.get(s.id.client)
    if (list === undefined) {
      list = []
      byClient.set(s.id.client, list)
    }
    list.push(s)
  }
  byClient.forEach((structs, client) => {
    assertInvariant(
      !(structs[0] instanceof Y.Skip),
      `${label}: client ${client} starts with spurious leading Skip@${structs[0].id.clock} (len=${structs[0].length})`
    )
    const last = structs[structs.length - 1]
    assertInvariant(
      !(last instanceof Y.Skip),
      `${label}: client ${client} ends with spurious trailing Skip@${last.id.clock} (len=${last.length})`
    )
    for (let i = 1; i < structs.length; i++) {
      const prev = structs[i - 1]
      const cur = structs[i]
      assertInvariant(
        cur.id.clock >= prev.id.clock + prev.length,
        `${label}: client ${client} overlapping/non-monotonic clocks (${prev.id.clock}+${prev.length} > ${cur.id.clock})`
      )
    }
  })
}

/**
 * Compute exact point-by-point non-Skip Item clocks from a decoded update.
 *
 * @param {Uint8Array} update
 * @param {'v1' | 'v2'} fmt
 * @return {Map<number, Set<number>>}
 */
const decodedItemClocks = (update, fmt) => {
  const dec = fmt === 'v1' ? Y.decodeUpdate(update) : Y.decodeUpdateV2(update)
  /** @type {Map<number, Set<number>>} */
  const out = new Map()
  for (let i = 0; i < dec.structs.length; i++) {
    const s = dec.structs[i]
    if (s instanceof Y.Skip) continue
    let set = out.get(s.id.client)
    if (set === undefined) {
      set = new Set()
      out.set(s.id.client, set)
    }
    for (let k = 0; k < s.length; k++) {
      set.add(s.id.clock + k)
    }
  }
  return out
}

/**
 * Suite 2: Skip-Gapped Partial Updates, BlockSet Merge, SV-From-Update, & Intersect Mid-Skip Oracle.
 *
 * @param {number} seed
 * @param {IntensityConfig} cfg
 */
const runSkipBlockSetWireSuite = (seed, cfg) => {
  const gen = prng.create(seed + 50021)
  /** @type {Array<Y.Doc>} */
  const docs = []
  /** @param {Y.Doc} d */
  const own = d => { docs.push(d); return d }

  try {
    /**
     * @typedef {{
     *   client: number,
     *   start: number,
     *   len: number,
     *   v1: Uint8Array<ArrayBuffer>,
     *   v2: Uint8Array<ArrayBuffer>
     * }} TxSlice
     */

    /** @type {Array<TxSlice>} */
    const allSlices = []
    const fullDoc = own(new Y.Doc({ gc: false }))

    // Build independent origin=null transactions per client across ROOT_SLOTS so any subset integrates with clean Skips!
    for (let ci = 0; ci < cfg.s2Clients; ci++) {
      const client = 10 + ci
      const src = own(new Y.Doc({ gc: false }))
      src.clientID = client
      for (let ti = 0; ti < cfg.s2TxsPerClient; ti++) {
        const svBefore = Y.encodeStateVector(src)
        const startClock = src.store.getClock(client)
        const rootKey = ROOT_SLOTS[ti % ROOT_SLOTS.length]
        const node = src.get(rootKey)
        const strLen = prng.uint32(gen, 2, 6)
        let txt = ''
        for (let k = 0; k < strLen; k++) txt += String.fromCharCode(97 + ((client + ti + k) % 26))
        // Insert at index 0 (origin=null!) or setAttr so every tx has zero dependency on earlier clocks of the same client!
        if (ti % 3 === 2) {
          node.setAttr(`k${client}_${ti}`, txt)
        } else {
          node.insert(0, txt)
        }
        const len = src.store.getClock(client) - startClock
        const v1 = Y.encodeStateAsUpdate(src, svBefore)
        const v2 = Y.encodeStateAsUpdateV2(src, svBefore)
        allSlices.push({ client, start: startClock, len, v1, v2 })
      }
      // Also exercise a delete on one existing item in full history
      const delSv = Y.encodeStateVector(src)
      const r0 = src.get('r0')
      if (r0.length > 0) r0.delete(0, 1)
      const delV1 = Y.encodeStateAsUpdate(src, delSv)
      const delV2 = Y.encodeStateAsUpdateV2(src, delSv)
      allSlices.push({ client, start: src.store.getClock(client), len: 0, v1: delV1, v2: delV2 })
      Y.applyUpdate(fullDoc, Y.encodeStateAsUpdate(src))
    }

    // Build 3 distinct partial gapped docs:
    // - pDocLeadSkip: explicitly OMITS tx 0 for every client -> starts with Skip(client, 0, len)! (catches BUG-SV-SKIP0 & BUG-BLOCKSET-LEADSKIP!)
    // - pDocInteriorSkip: includes tx 0, skips tx 1..2, includes tx 3.. -> interior Skip! (catches BUG-SKIP-WRITE!)
    // - pDocRandom: random overlapping/disjoint subset of transactions
    const pDocLeadSkip = own(new Y.Doc({ gc: false }))
    const pDocInterior = own(new Y.Doc({ gc: false }))
    const pDocRandom = own(new Y.Doc({ gc: false }))

    for (let i = 0; i < allSlices.length; i++) {
      const sl = allSlices[i]
      if (sl.start > 0 && sl.len > 0 && prng.uint32(gen, 0, 2) !== 0) {
        Y.applyUpdate(pDocLeadSkip, sl.v1)
      }
      if (sl.start === 0 || (sl.start >= 8 && sl.len > 0 && prng.bool(gen))) {
        Y.applyUpdate(pDocInterior, sl.v1)
      }
      if (prng.bool(gen)) {
        Y.applyUpdate(pDocRandom, sl.v1)
      }
    }

    // Guarantee pDocLeadSkip and pDocInterior actually have non-empty structs + Skips
    const nonZeroSlice = allSlices.find(s => s.start > 0 && s.len > 0)
    if (nonZeroSlice !== undefined) {
      Y.applyUpdate(pDocLeadSkip, nonZeroSlice.v1)
    }
    const zeroSliceC10 = allSlices.find(s => s.client === 10 && s.start === 0 && s.len > 0)
    const lateSliceC10 = allSlices.find(s => s.client === 10 && s.start >= 6 && s.len > 0)
    if (zeroSliceC10 !== undefined && lateSliceC10 !== undefined) {
      Y.applyUpdate(pDocInterior, zeroSliceC10.v1)
      Y.applyUpdate(pDocInterior, lateSliceC10.v1)
    }

    const partialDocs = [
      { name: 'leadSkip', doc: pDocLeadSkip },
      { name: 'interiorSkip', doc: pDocInterior },
      { name: 'randomSkip', doc: pDocRandom }
    ]

    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const partialV1s = []
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const partialV2s = []

    // 1. Verify encodeStateVectorFromUpdate(V1/V2) & V1<->V2 conversions on EVERY gapped partial doc! (catches BUG-SV-SKIP0!)
    for (let i = 0; i < partialDocs.length; i++) {
      const { name, doc } = partialDocs[i]
      verifyDocInvariants(doc, { expectNoPending: false, label: `S2:${name}` })
      const u1 = Y.encodeStateAsUpdate(doc)
      const u2 = Y.encodeStateAsUpdateV2(doc)
      partialV1s.push(u1)
      partialV2s.push(u2)

      const trueSV = Y.encodeStateVector(doc)
      assertInvariant(
        equalBytes(Y.encodeStateVectorFromUpdate(u1), trueSV),
        `S2:${name}: encodeStateVectorFromUpdate(V1) !== encodeStateVector(doc) (BUG-SV-SKIP0)`
      )
      assertInvariant(
        equalBytes(Y.encodeStateVectorFromUpdateV2(u2), trueSV),
        `S2:${name}: encodeStateVectorFromUpdateV2(V2) !== encodeStateVector(doc) (BUG-SV-SKIP0)`
      )
      assertInvariant(
        Y.equalContentIds(Y.createContentIdsFromUpdate(u1), Y.createContentIdsFromUpdateV2(u2)),
        `S2:${name}: createContentIdsFromUpdate V1 vs V2 mismatch`
      )

      // V1 <-> V2 conversion preserves exact SV & Item clocks
      const conv12 = Y.convertUpdateFormatV1ToV2(u1)
      const conv21 = Y.convertUpdateFormatV2ToV1(u2)
      assertEqualSetModels(decodedItemClocks(u1, 'v1'), decodedItemClocks(conv12, 'v2'), `S2:${name}:V1->V2`)
      assertEqualSetModels(decodedItemClocks(u2, 'v2'), decodedItemClocks(conv21, 'v1'), `S2:${name}:V2->V1`)
      assertInvariant(equalBytes(Y.encodeStateVectorFromUpdateV2(conv12), trueSV), `S2:${name}: V1->V2 SV mismatch`)
      assertInvariant(equalBytes(Y.encodeStateVectorFromUpdate(conv21), trueSV), `S2:${name}: V2->V1 SV mismatch`)
    }

    // 2. BlockSet / mergeUpdates / mergeUpdatesV2 on shuffled + duplicate-injected gapped updates (catches BUG-BLOCKSET-LEADSKIP!)
    // Also specifically merge two clock-0-skipped updates to guarantee hitting BlockSet.insertInto slow path!
    const leadOnlyA = own(new Y.Doc({ gc: false }))
    const leadOnlyB = own(new Y.Doc({ gc: false }))
    const c10Slices = allSlices.filter(s => s.client === 10 && s.start > 0 && s.len > 0)
    if (c10Slices.length >= 2) {
      Y.applyUpdate(leadOnlyA, c10Slices[0].v1)
      Y.applyUpdate(leadOnlyB, c10Slices[c10Slices.length - 1].v1)
      const lAv1 = Y.encodeStateAsUpdate(leadOnlyA)
      const lBv1 = Y.encodeStateAsUpdate(leadOnlyB)
      const lAv2 = Y.encodeStateAsUpdateV2(leadOnlyA)
      const lBv2 = Y.encodeStateAsUpdateV2(leadOnlyB)
      const leadCases = [
        { tag: 'leadMerge(A,B)', mv1: Y.mergeUpdates([lAv1, lBv1]), mv2: Y.mergeUpdatesV2([lAv2, lBv2]) },
        { tag: 'leadMerge(B,A)', mv1: Y.mergeUpdates([lBv1, lAv1]), mv2: Y.mergeUpdatesV2([lBv2, lAv2]) }
      ]
      for (let ci = 0; ci < leadCases.length; ci++) {
        const { tag, mv1, mv2 } = leadCases[ci]
        assertNoLeadingOrTrailingSkips(mv1, 'v1', `S2:${tag}:V1`)
        assertNoLeadingOrTrailingSkips(mv2, 'v2', `S2:${tag}:V2`)
        const d1 = own(new Y.Doc({ gc: false }))
        const d2 = own(new Y.Doc({ gc: false }))
        Y.applyUpdate(d1, mv1)
        Y.applyUpdateV2(d2, mv2)
        assertInvariant(equalBytes(Y.encodeStateVectorFromUpdate(mv1), Y.encodeStateVector(d1)), `S2:${tag}:V1 SV mismatch`)
        assertInvariant(equalBytes(Y.encodeStateVectorFromUpdateV2(mv2), Y.encodeStateVector(d2)), `S2:${tag}:V2 SV mismatch`)
      }
    }

    // General shuffled + duplicate merge of all 3 gapped partial docs
    const shufV1 = shuffleCopy(gen, partialV1s)
    shufV1.push(partialV1s[0])
    const shufV2 = shuffleCopy(gen, partialV2s)
    shufV2.push(partialV2s[0])
    const mergedV1 = Y.mergeUpdates(shufV1)
    const mergedV2 = Y.mergeUpdatesV2(shufV2)
    assertNoLeadingOrTrailingSkips(mergedV1, 'v1', 'S2:mergedV1')
    assertNoLeadingOrTrailingSkips(mergedV2, 'v2', 'S2:mergedV2')

    const mDoc1 = own(new Y.Doc({ gc: false }))
    const mDoc2 = own(new Y.Doc({ gc: false }))
    const refUnion = own(new Y.Doc({ gc: false }))
    Y.applyUpdate(mDoc1, mergedV1)
    Y.applyUpdateV2(mDoc2, mergedV2)
    for (let i = 0; i < partialV1s.length; i++) Y.applyUpdate(refUnion, partialV1s[i])

    verifyDocInvariants(mDoc1, { expectNoPending: false, label: 'S2:mDoc1' })
    verifyDocInvariants(mDoc2, { expectNoPending: false, label: 'S2:mDoc2' })
    assertInvariant(equalBytes(Y.encodeStateVectorFromUpdate(mergedV1), Y.encodeStateVector(mDoc1)), 'S2: mergedV1 SV mismatch')
    assertInvariant(equalBytes(Y.encodeStateVectorFromUpdateV2(mergedV2), Y.encodeStateVector(mDoc2)), 'S2: mergedV2 SV mismatch')
    assertInvariant(equalBytes(Y.encodeStateVector(mDoc1), Y.encodeStateVector(refUnion)), 'S2: mergedV1 vs refUnion SV mismatch')
    assertInvariant(equalBytes(Y.encodeStateVector(mDoc2), Y.encodeStateVector(refUnion)), 'S2: mergedV2 vs refUnion SV mismatch')
    assertInvariant(
      Y.equalContentIds(Y.createContentIdsFromDoc(mDoc1, true), Y.createContentIdsFromDoc(refUnion, true)),
      'S2: mergedV1 ContentIds !== refUnion'
    )
    assertInvariant(
      Y.equalContentIds(Y.createContentIdsFromDoc(mDoc2, true), Y.createContentIdsFromDoc(refUnion, true)),
      'S2: mergedV2 ContentIds !== refUnion'
    )
    const jsonCmp = deepEqualValues(mDoc1.toJSON(), refUnion.toJSON(), 'S2:mDoc1.toJSON')
    assertInvariant(jsonCmp.equal, `S2: mergedV1 toJSON !== refUnion (${jsonCmp.reason})`)

    // 3. intersectUpdateWithContentIds(V1/V2) with slices terminating MID-SKIP (catches BUG-SKIP-WRITE!)
    const interSrcV1 = Y.encodeStateAsUpdate(pDocInterior)
    const interSrcV2 = Y.encodeStateAsUpdateV2(pDocInterior)
    const interSrcModel = decodedItemClocks(interSrcV1, 'v1')
    const filterIns = Y.createIdSet()
    pDocInterior.store.clients.forEach((structs, client) => {
      for (let i = 0; i < structs.length; i++) {
        const s = structs[i]
        if (s instanceof Y.Skip && s.length >= 2) {
          // Deliberately include only the first half of the Skip -> forces offsetEnd > 0 in Skip.prototype.write!
          const partialSkipLen = math.max(1, math.floor(s.length / 2))
          filterIns.add(client, s.id.clock, partialSkipLen)
        } else if (s instanceof Y.Item) {
          // Keep full or partial live item clocks
          const keepLen = prng.bool(gen) ? s.length : math.max(1, math.floor(s.length / 2))
          filterIns.add(client, s.id.clock, keepLen)
        }
      }
    })
    const filterCids = Y.createContentIds(filterIns, Y.createIdSet())
    const expectedInterClocks = intersectSetModels(interSrcModel, idSetToModel(filterIns))

    const resInterV1 = Y.intersectUpdateWithContentIds(interSrcV1, filterCids)
    const resInterV2 = Y.intersectUpdateWithContentIdsV2(interSrcV2, filterCids)
    assertEqualSetModels(decodedItemClocks(resInterV1, 'v1'), expectedInterClocks, 'S2:intersectMidSkip(V1)')
    assertEqualSetModels(decodedItemClocks(resInterV2, 'v2'), expectedInterClocks, 'S2:intersectMidSkip(V2)')

    // Direct writeStructsFromIdSet on pDocInterior.store with mid-Skip filterIns -> hits Skip.write(encoder, offset, offsetEnd) (catches BUG-SKIP-WRITE!)
    const rawEncV1 = new Y.UpdateEncoderV1()
    writeStructsFromIdSet(rawEncV1, pDocInterior.store, filterIns)
    Y.writeIdSet(rawEncV1, Y.createIdSet())
    const rawSliceV1 = rawEncV1.toUint8Array()
    assertEqualSetModels(decodedItemClocks(rawSliceV1, 'v1'), expectedInterClocks, 'S2:writeStructsFromIdSetMidSkip(V1)')

    const rawEncV2 = new Y.UpdateEncoderV2()
    writeStructsFromIdSet(rawEncV2, pDocInterior.store, filterIns)
    Y.writeIdSet(rawEncV2, Y.createIdSet())
    const rawSliceV2 = rawEncV2.toUint8Array()
    assertEqualSetModels(decodedItemClocks(rawSliceV2, 'v2'), expectedInterClocks, 'S2:writeStructsFromIdSetMidSkip(V2)')

    const iDoc1 = own(new Y.Doc({ gc: false }))
    const iDoc2 = own(new Y.Doc({ gc: false }))
    Y.applyUpdate(iDoc1, resInterV1)
    Y.applyUpdateV2(iDoc2, resInterV2)
    verifyDocInvariants(iDoc1, { expectNoPending: false, label: 'S2:iDoc1' })
    verifyDocInvariants(iDoc2, { expectNoPending: false, label: 'S2:iDoc2' })
    assertInvariant(equalBytes(Y.encodeStateVector(iDoc1), Y.encodeStateVector(iDoc2)), 'S2: intersect V1 vs V2 SV mismatch')
    assertInvariant(
      Y.equalContentIds(Y.createContentIdsFromDoc(iDoc1, true), Y.createContentIdsFromDoc(iDoc2, true)),
      'S2: intersect V1 vs V2 ContentIds mismatch'
    )

    // 4. diffUpdate / diffUpdateV2 reconstruction from partial doc to fullDoc
    const fullV1 = Y.encodeStateAsUpdate(fullDoc)
    const fullV2 = Y.encodeStateAsUpdateV2(fullDoc)
    const pSV = Y.encodeStateVector(pDocInterior)
    const rec1 = own(Y.cloneDoc(pDocInterior, { gc: false }))
    const rec2 = own(Y.cloneDoc(pDocInterior, { gc: false }))
    Y.applyUpdate(rec1, Y.diffUpdate(fullV1, pSV))
    Y.applyUpdateV2(rec2, Y.diffUpdateV2(fullV2, pSV))
    assertInvariant(equalBytes(Y.encodeStateVector(rec1), Y.encodeStateVector(fullDoc)), 'S2: diffUpdate(V1) failed to reconstruct fullDoc SV')
    assertInvariant(equalBytes(Y.encodeStateVector(rec2), Y.encodeStateVector(fullDoc)), 'S2: diffUpdateV2(V2) failed to reconstruct fullDoc SV')
    const recCmp = deepEqualValues(rec1.toJSON(), fullDoc.toJSON(), 'S2:rec1.toJSON')
    assertInvariant(recCmp.equal, `S2: diffUpdate(V1) JSON mismatch (${recCmp.reason})`)
  } finally {
    for (let i = 0; i < docs.length; i++) {
      docs[i].destroy()
    }
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 20260909
  /** @type {Intensity} */
  let intensity = 'default'
  /** @type {number | null} */
  let runsOverride = null
  let suite = 'all'
  let reportOnly = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--runs' && i + 1 < argv.length) {
      runsOverride = Number.parseInt(argv[++i], 10)
    } else if (arg === '--suite' && i + 1 < argv.length) {
      suite = argv[++i]
    } else if (arg === '--intensity' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'default' || val === 'high' || val === 'extreme') {
        intensity = val
      } else {
        console.error(`Invalid --intensity "${val}" (expected default|high|extreme)`)
        process.exit(2)
      }
    } else if (arg === '--report') {
      reportOnly = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/idset-blockset-algebra-fuzzer.js [--seed N] [--runs N] [--intensity default|high|extreme] [--suite 1|2|all] [--report]')
      process.exit(0)
    }
  }
  const cfg = INTENSITY_CONFIG[intensity]
  return { seed, intensity, cfg, runs: runsOverride ?? cfg.defaultRuns, suite, reportOnly }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const t0 = performance.now()
  /** @type {Array<{ id: string, name: string, fn: (seed: number, cfg: IntensityConfig) => void }>} */
  const allSuites = [
    { id: '1', name: 'idset-idmap-algebra-and-aliasing', fn: runIdSetIdMapAlgebraSuite },
    { id: '2', name: 'skip-blockset-sv-intersect-oracle', fn: runSkipBlockSetWireSuite }
  ]
  const selected = args.suite === 'all' ? allSuites : allSuites.filter(s => s.id === args.suite || s.name.includes(args.suite))
  if (selected.length === 0) {
    console.error(`Unknown --suite "${args.suite}" (expected 1|2|all)`)
    process.exit(2)
  }

  console.log(`=== Yjs v14 IdSet / IdMap / Skip / BlockSet Algebraic Property Fuzzer (intensity=${args.intensity}, runs=${args.runs}, baseSeed=${args.seed}) ===`)

  let passed = 0
  let failed = 0
  /** @type {Array<{ suite: string, seed: number, error: string, repro: string }>} */
  const failures = []

  for (let si = 0; si < selected.length; si++) {
    const s = selected[si]
    let sPass = 0
    let sFail = 0
    const st0 = performance.now()
    for (let r = 0; r < args.runs; r++) {
      const runSeed = args.seed + r * 6151
      try {
        s.fn(runSeed, args.cfg)
        passed++
        sPass++
      } catch (err) {
        failed++
        sFail++
        const msg = err instanceof Error ? err.message : String(err)
        const repro = `node ./tests/lab/idset-blockset-algebra-fuzzer.js --seed ${runSeed} --runs 1 --suite ${s.id} --intensity ${args.intensity}`
        failures.push({ suite: `${s.id}:${s.name}`, seed: runSeed, error: msg, repro })
      }
    }
    const ms = (performance.now() - st0).toFixed(1)
    console.log(`  [${sFail === 0 ? 'PASS' : 'FAIL'}] Suite ${s.id} (${s.name.padEnd(34)}) ${sPass}/${args.runs} runs passed (${ms}ms)`)
  }

  if (failures.length > 0) {
    console.log('\n--- Discovered Failures ---')
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i]
      console.log(`  [${i + 1}] ${f.suite} seed=${f.seed}`)
      console.log(`      repro: ${f.repro}`)
      console.log(`      error: ${f.error}`)
    }
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed in ${(performance.now() - t0).toFixed(1)}ms ===`)
  if (failed > 0 && !args.reportOnly) {
    process.exit(1)
  }
}
