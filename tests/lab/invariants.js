import * as Y from '../../src/index.js'
import * as delta from 'lib0/delta'
import * as list from 'lib0/list'

/**
 * Byte-level equality check for Uint8Arrays.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @return {boolean}
 */
export const equalBytes = (a, b) => {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export class InvariantError extends Error {
  /**
   * @param {string} message
   */
  constructor (message) {
    super(message)
    this.name = 'InvariantError'
  }
}

/**
 * @param {boolean} condition
 * @param {string} message
 */
export const assertInvariant = (condition, message) => {
  if (!condition) {
    throw new InvariantError(message)
  }
}

/**
 * Normalize a value that may contain Y.Node instances into a plain comparable representation.
 *
 * @param {unknown} val
 * @return {unknown}
 */
const normalizeValue = val => {
  if (val instanceof Y.Node) {
    return {
      __yNode: true,
      name: val.name,
      json: val.toJSON(),
      delta: val.toDeltaDeep().toJSON()
    }
  }
  if (val instanceof Y.Doc) {
    return {
      __yDoc: true,
      guid: val.guid,
      gc: val.gc,
      autoLoad: val.autoLoad,
      meta: val.meta
    }
  }
  return val
}

/**
 * Deep equality check with detailed mismatch path reporting.
 * Handles primitives, NaN, Uint8Array, Date, BigInt, Array, Y.Node, and plain objects.
 *
 * @param {unknown} rawA
 * @param {unknown} rawB
 * @param {string} [path]
 * @return {{ equal: boolean, reason: string }}
 */
export const deepEqualValues = (rawA, rawB, path = '$') => {
  const a = normalizeValue(rawA)
  const b = normalizeValue(rawB)
  if (Object.is(a, b)) {
    return { equal: true, reason: '' }
  }
  if (typeof a === 'number' && typeof b === 'number' && a === 0 && b === 0) {
    return { equal: true, reason: '' }
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return { equal: false, reason: `${path}: ${String(a)} !== ${String(b)}` }
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
      return { equal: false, reason: `${path}: Uint8Array type mismatch` }
    }
    if (!equalBytes(a, b)) {
      return { equal: false, reason: `${path}: Uint8Array bytes differ (len ${a.length} vs ${b.length})` }
    }
    return { equal: true, reason: '' }
  }
  if (a instanceof Date || b instanceof Date) {
    if (!(a instanceof Date) || !(b instanceof Date)) {
      return { equal: false, reason: `${path}: Date type mismatch` }
    }
    if (!Object.is(a.getTime(), b.getTime())) {
      return { equal: false, reason: `${path}: Date ${a.toISOString()} !== ${b.toISOString()}` }
    }
    return { equal: true, reason: '' }
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return { equal: false, reason: `${path}: Array type mismatch` }
    }
    if (a.length !== b.length) {
      return { equal: false, reason: `${path}: array length ${a.length} !== ${b.length}` }
    }
    for (let i = 0; i < a.length; i++) {
      const res = deepEqualValues(a[i], b[i], `${path}[${i}]`)
      if (!res.equal) return res
    }
    return { equal: true, reason: '' }
  }
  const objA = /** @type {Record<string, unknown>} */ (a)
  const objB = /** @type {Record<string, unknown>} */ (b)
  const keysA = Object.keys(objA).sort()
  const keysB = Object.keys(objB).sort()
  if (keysA.length !== keysB.length) {
    return { equal: false, reason: `${path}: object key count ${keysA.length} (${keysA.join(',')}) !== ${keysB.length} (${keysB.join(',')})` }
  }
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) {
      return { equal: false, reason: `${path}: object key ${keysA[i]} !== ${keysB[i]}` }
    }
    const k = keysA[i]
    const res = deepEqualValues(objA[k], objB[k], `${path}.${k}`)
    if (!res.equal) return res
  }
  return { equal: true, reason: '' }
}

/**
 * Read optional formatting snapshot from an ArraySearchMarker (compatible before & after Perf PR #1).
 *
 * @param {object} marker
 * @return {{ hasProp: boolean, formats: Map<string, unknown> | null | undefined }}
 */
const readMarkerFormats = marker => {
  if ('formats' in marker) {
    const val = /** @type {{ formats?: Map<string, unknown> | null }} */ (marker).formats
    return { hasProp: true, formats: val }
  }
  return { hasProp: false, formats: undefined }
}

/**
 * Format an ID or null for diagnostic messages.
 *
 * @param {ID | null} id
 * @return {string}
 */
const fmtId = id => id === null ? 'null' : `(${id.client},${id.clock})`

/**
 * Check whether two nullable Item pointers share the same starting ID.
 *
 * @param {Item | null} a
 * @param {Item | null} b
 * @return {boolean}
 */
const equalItemIds = (a, b) => a === b || (a !== null && b !== null && Y.compareIDs(a.id, b.id))

/**
 * Compare two StructStores for exact structural equivalence.
 *
 * @param {StructStore} ss1
 * @param {StructStore} ss2
 * @param {string} [label1]
 * @param {string} [label2]
 */
export const compareStructStores = (ss1, ss2, label1 = 'store1', label2 = 'store2') => {
  assertInvariant(
    ss1.clients.size === ss2.clients.size,
    `StructStore client count mismatch (${label1}=${ss1.clients.size}, ${label2}=${ss2.clients.size})`
  )
  for (const [client, structs1] of ss1.clients) {
    const structs2 = ss2.clients.get(client)
    assertInvariant(
      structs2 !== undefined,
      `StructStore client ${client} present in ${label1} but missing in ${label2}`
    )
    const s2Arr = /** @type {Array<GC | Item | Skip>} */ (structs2)
    if (structs1.length !== s2Arr.length) {
      let diffDetail = ''
      const minLen = Math.min(structs1.length, s2Arr.length)
      for (let i = 0; i < minLen; i++) {
        const a = structs1[i]
        const b = s2Arr[i]
        if (a.constructor !== b.constructor || a.id.clock !== b.id.clock || a.length !== b.length || a.deleted !== b.deleted) {
          const aRedone = a instanceof Y.Item ? fmtId(a.redone) : 'n/a'
          const bRedone = b instanceof Y.Item ? fmtId(b.redone) : 'n/a'
          const aContent = a instanceof Y.Item ? a.content.constructor.name : a.constructor.name
          const bContent = b instanceof Y.Item ? b.content.constructor.name : b.constructor.name
          diffDetail = ` firstDiff[${i}]: ${label1}=${aContent}${fmtId(a.id)} len=${a.length} del=${a.deleted} redone=${aRedone} vs ${label2}=${bContent}${fmtId(b.id)} len=${b.length} del=${b.deleted} redone=${bRedone}`
          break
        }
      }
      throw new InvariantError(
        `StructStore client ${client} struct count mismatch (${label1}=${structs1.length}, ${label2}=${s2Arr.length})${diffDetail}`
      )
    }
    for (let i = 0; i < structs1.length; i++) {
      const s1 = structs1[i]
      const s2 = s2Arr[i]
      assertInvariant(
        s1.constructor === s2.constructor &&
        Y.compareIDs(s1.id, s2.id) &&
        s1.deleted === s2.deleted &&
        s1.length === s2.length,
        `StructStore mismatch at client=${client}[${i}]: ${label1}=${s1.constructor.name}${fmtId(s1.id)} len=${s1.length} del=${s1.deleted} vs ${label2}=${s2.constructor.name}${fmtId(s2.id)} len=${s2.length} del=${s2.deleted}`
      )
      if (s1 instanceof Y.Item) {
        assertInvariant(s2 instanceof Y.Item, `StructStore type mismatch at client=${client}[${i}]`)
        const item2 = /** @type {Item} */ (s2)
        const leftMatch = (s1.left === null && item2.left === null) ||
          (s1.left !== null && item2.left !== null && Y.compareIDs(s1.left.lastId, item2.left.lastId))
        assertInvariant(
          leftMatch &&
          equalItemIds(s1.right, item2.right) &&
          Y.compareIDs(s1.origin, item2.origin) &&
          Y.compareIDs(s1.rightOrigin, item2.rightOrigin) &&
          s1.parentSub === item2.parentSub &&
          (s1.deleted || s1.countable === item2.countable),
          `Item mismatch at ${fmtId(s1.id)}: ${label1}(left=${s1.left ? fmtId(s1.left.lastId) : 'null'}, right=${s1.right ? fmtId(s1.right.id) : 'null'}, origin=${fmtId(s1.origin)}, rightOrigin=${fmtId(s1.rightOrigin)}, sub=${String(s1.parentSub)}) vs ${label2}(left=${item2.left ? fmtId(item2.left.lastId) : 'null'}, right=${item2.right ? fmtId(item2.right.id) : 'null'}, origin=${fmtId(item2.origin)}, rightOrigin=${fmtId(item2.rightOrigin)}, sub=${String(item2.parentSub)})`
        )
        assertInvariant(s1.left === null || s1.left.right === s1, `${label1} broken left.right at ${fmtId(s1.id)}`)
        assertInvariant(s1.right === null || s1.right.left === s1, `${label1} broken right.left at ${fmtId(s1.id)}`)
        assertInvariant(item2.left === null || item2.left.right === item2, `${label2} broken left.right at ${fmtId(item2.id)}`)
        assertInvariant(item2.right === null || item2.right.left === item2, `${label2} broken right.left at ${fmtId(item2.id)}`)
      }
    }
  }
}

/**
 * Check whether any Item in a Doc has the `keep` bit set (e.g. pinned by UndoManager).
 *
 * @param {Doc} doc
 * @return {boolean}
 */
const docHasKeptItems = doc => {
  for (const structs of doc.store.clients.values()) {
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      if (s instanceof Y.Item && s.keep) {
        return true
      }
    }
  }
  return false
}

/**
 * Check whether any Item in a Doc has local-only `redone` metadata (set by UndoManager),
 * which legitimately inhibits local `Item.mergeWith` coalescing on that peer only.
 *
 * @param {Doc} doc
 * @return {boolean}
 */
const docHasRedoneItems = doc => {
  for (const structs of doc.store.clients.values()) {
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      if (s instanceof Y.Item && s.redone !== null) {
        return true
      }
    }
  }
  return false
}

/**
 * Check whether any deleted Item in a Doc has not been GC'd into ContentDeleted/GC
 * (e.g. a gc:true peer whose UndoManager held keep=true during deletion and later cleared keep=false).
 *
 * @param {Doc} doc
 * @return {boolean}
 */
const docHasUnGcdDeletedItems = doc => {
  for (const structs of doc.store.clients.values()) {
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      if (s instanceof Y.Item && s.deleted && !(s.content instanceof Y.ContentDeleted)) {
        return true
      }
    }
  }
  return false
}

/**
 * Compute countable length represented by a node's deep delta children.
 *
 * @param {Y.Node} node
 * @return {number}
 */
const deltaChildrenLength = node => {
  const ops = list.toArray(node.toDeltaDeep().children)
  let total = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (delta.$textOp.check(op) || delta.$insertOp.check(op)) {
      total += op.insert.length
    }
  }
  return total
}

/**
 * Verify all internal StructStore, DeleteSet, Skip, and YNode doubly-linked-list invariants on a Doc.
 *
 * @param {Doc} doc
 * @param {{ expectNoPending?: boolean, label?: string }} [opts]
 */
export const verifyDocInvariants = (doc, { expectNoPending = false, label = `doc(client=${doc.clientID})` } = {}) => {
  const store = doc.store
  const expectedSkips = Y.createIdSet()
  const expectedDs = Y.createIdSet()
  /** @type {Set<Item>} */
  const storeItems = new Set()
  /** @type {Set<Y.Node>} */
  const nodes = new Set()

  for (const rootNode of doc.share.values()) {
    nodes.add(rootNode)
  }

  for (const [client, structs] of store.clients.entries()) {
    assertInvariant(
      Number.isSafeInteger(client) && client >= 0,
      `${label}: invalid client id ${client}`
    )
    assertInvariant(
      Array.isArray(structs) && structs.length > 0,
      `${label}: client ${client} has empty structs array`
    )
    assertInvariant(
      structs[0].id.clock === 0,
      `${label}: client ${client} first struct starts at clock ${structs[0].id.clock} (expected 0)`
    )
    let expectedClock = 0
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      assertInvariant(
        s.id.client === client,
        `${label}: struct at client=${client}[${i}] has mismatched id.client=${s.id.client}`
      )
      assertInvariant(
        Number.isSafeInteger(s.id.clock) && s.id.clock >= 0,
        `${label}: struct at client=${client}[${i}] has invalid clock=${s.id.clock}`
      )
      assertInvariant(
        Number.isSafeInteger(s.length) && s.length > 0,
        `${label}: struct ${fmtId(s.id)} (${s.constructor.name}) has non-positive or invalid length=${s.length}`
      )
      assertInvariant(
        Number.isSafeInteger(s.id.clock + s.length),
        `${label}: struct ${fmtId(s.id)} overflows MAX_SAFE_INTEGER with length=${s.length}`
      )
      assertInvariant(
        s.id.clock === expectedClock,
        `${label}: StructStore non-contiguous clock at client=${client}[${i}]: got ${s.id.clock}, expected ${expectedClock}`
      )
      expectedClock = s.id.clock + s.length

      if (s instanceof Y.Skip) {
        expectedSkips.add(client, s.id.clock, s.length)
        assertInvariant(!s.deleted, `${label}: Skip ${fmtId(s.id)} should not be deleted`)
      } else if (s instanceof Y.GC) {
        expectedDs.add(client, s.id.clock, s.length)
        assertInvariant(s.deleted, `${label}: GC ${fmtId(s.id)} must be deleted`)
      } else if (s instanceof Y.Item) {
        storeItems.add(s)
        if (s.deleted) {
          expectedDs.add(client, s.id.clock, s.length)
        }
        assertInvariant(
          s.length === s.content.getLength(),
          `${label}: Item ${fmtId(s.id)} length=${s.length} !== content.getLength()=${s.content.getLength()}`
        )
        if (!(s.content instanceof Y.ContentDeleted)) {
          assertInvariant(
            s.countable === s.content.isCountable(),
            `${label}: Item ${fmtId(s.id)} countable=${s.countable} !== content.isCountable()=${s.content.isCountable()}`
          )
        }
        assertInvariant(
          s.parent instanceof Y.Node,
          `${label}: integrated Item ${fmtId(s.id)} has non-YNode parent (${String(s.parent)})`
        )
        const parentNode = /** @type {Y.Node} */ (s.parent)
        nodes.add(parentNode)
        if (s.content instanceof Y.ContentType) {
          nodes.add(s.content.type)
        }
        assertInvariant(s.left !== s, `${label}: Item ${fmtId(s.id)} left self-loop`)
        assertInvariant(s.right !== s, `${label}: Item ${fmtId(s.id)} right self-loop`)
        if (s.left !== null) {
          assertInvariant(
            s.left.right === s,
            `${label}: Item ${fmtId(s.id)} left.right !== item (left=${fmtId(s.left.id)})`
          )
          assertInvariant(
            s.left.parent === parentNode && s.left.parentSub === s.parentSub,
            `${label}: Item ${fmtId(s.id)} left has different parent/parentSub`
          )
        }
        if (s.right !== null) {
          assertInvariant(
            s.right.left === s,
            `${label}: Item ${fmtId(s.id)} right.left !== item (right=${fmtId(s.right.id)})`
          )
          assertInvariant(
            s.right.parent === parentNode && s.right.parentSub === s.parentSub,
            `${label}: Item ${fmtId(s.id)} right has different parent/parentSub`
          )
        }
        if (s.parentSub === null) {
          if (s.left === null) {
            assertInvariant(
              parentNode._start === s,
              `${label}: list Item ${fmtId(s.id)} has left===null but parent._start is ${parentNode._start ? fmtId(parentNode._start.id) : 'null'}`
            )
          }
        } else {
          if (s.right === null) {
            const mapped = parentNode._map.get(s.parentSub)
            assertInvariant(
              mapped === s,
              `${label}: map Item ${fmtId(s.id)} (key=${s.parentSub}) has right===null but parent._map.get(key) is ${mapped ? fmtId(mapped.id) : 'undefined'}`
            )
          } else {
            assertInvariant(
              s.deleted,
              `${label}: superseded map Item ${fmtId(s.id)} (key=${s.parentSub}) with right!==null must be deleted`
            )
          }
        }
      } else {
        throw new InvariantError(`${label}: unknown struct type in store at client=${client}[${i}]`)
      }
    }
  }

  assertInvariant(
    Y.equalIdSets(store.skips, expectedSkips),
    `${label}: store.skips does not match actual Skip structs in store.clients`
  )
  const computedDs = Y.createDeleteSetFromStructStore(store)
  assertInvariant(
    Y.equalIdSets(store.ds, computedDs),
    `${label}: store.ds does not equal createDeleteSetFromStructStore(store)`
  )
  assertInvariant(
    Y.equalIdSets(store.ds, expectedDs),
    `${label}: store.ds does not match deleted structs in store.clients`
  )

  /** @type {Set<Item>} */
  const visitedItems = new Set()

  for (const node of nodes) {
    // 1. Verify _start doubly-linked list, cycle freedom, _length, and full _searchMarker bijection + formats
    /** @type {Map<Item, number>} */
    const itemOffsets = new Map()
    /** @type {Set<Item>} */
    const markedItems = new Set()
    /** @type {Map<Item, Map<string, unknown>>} */
    const itemFormats = new Map()
    /** @type {Map<string, unknown>} */
    const runningFormats = new Map()
    let liveLength = 0
    if (node._start !== null) {
      assertInvariant(
        node._start.left === null,
        `${label}: node._start ${fmtId(node._start.id)} has non-null left ${node._start.left ? fmtId(node._start.left.id) : 'null'}`
      )
      /** @type {Item | null} */
      let prev = null
      /** @type {Item | null} */
      let curr = node._start
      while (curr !== null) {
        assertInvariant(
          !itemOffsets.has(curr),
          `${label}: cycle detected in node._start linked list at ${fmtId(curr.id)}`
        )
        assertInvariant(
          curr.parent === node && curr.parentSub === null,
          `${label}: node._start item ${fmtId(curr.id)} has invalid parent/parentSub`
        )
        assertInvariant(
          curr.left === prev,
          `${label}: node._start item ${fmtId(curr.id)} left pointer mismatch`
        )
        assertInvariant(
          storeItems.has(curr),
          `${label}: node._start item ${fmtId(curr.id)} is not present in doc.store.clients`
        )
        itemOffsets.set(curr, liveLength)
        visitedItems.add(curr)
        if (curr.marker) {
          markedItems.add(curr)
          itemFormats.set(curr, new Map(runningFormats))
        }
        if (!curr.deleted) {
          if (curr.countable) {
            liveLength += curr.length
          }
          if (curr.content instanceof Y.ContentFormat) {
            if (curr.content.value === null) {
              runningFormats.delete(curr.content.key)
            } else {
              runningFormats.set(curr.content.key, curr.content.value)
            }
          }
        }
        prev = curr
        curr = curr.right
      }
    }
    assertInvariant(
      node._length === liveLength,
      `${label}: node._length=${node._length} !== sum of live countable items (${liveLength})`
    )
    /** @type {Set<Item>} */
    const seenMarkerItems = new Set()
    if (node._searchMarker !== null) {
      for (let i = 0; i < node._searchMarker.length; i++) {
        const marker = node._searchMarker[i]
        assertInvariant(
          marker.p.marker === true,
          `${label}: searchMarker[${i}] item ${fmtId(marker.p.id)} does not have marker bit set (marker=${String(marker.p.marker)})`
        )
        assertInvariant(
          !seenMarkerItems.has(marker.p),
          `${label}: duplicate searchMarker entry pointing to item ${fmtId(marker.p.id)}`
        )
        seenMarkerItems.add(marker.p)
        const actualOffset = itemOffsets.get(marker.p)
        assertInvariant(
          actualOffset !== undefined,
          `${label}: searchMarker[${i}] points to item ${fmtId(marker.p.id)} not in node._start list`
        )
        assertInvariant(
          marker.index === actualOffset,
          `${label}: searchMarker[${i}] index=${marker.index} !== actual offset=${String(actualOffset)} for item ${fmtId(marker.p.id)}`
        )
        const fmtInfo = readMarkerFormats(marker)
        if (fmtInfo.hasProp && (node._hasFormatting || fmtInfo.formats != null)) {
          const expectedFormats = itemFormats.get(marker.p) ?? new Map()
          const rawFormats = fmtInfo.formats
          assertInvariant(
            rawFormats === null || rawFormats === undefined || rawFormats instanceof Map,
            `${label}: searchMarker[${i}] formats is neither null nor Map for item ${fmtId(marker.p.id)}`
          )
          /** @type {Map<string, unknown>} */
          const actualFormats = rawFormats instanceof Map ? rawFormats : new Map()
          assertInvariant(
            actualFormats.size === expectedFormats.size,
            `${label}: searchMarker[${i}] formats.size=${actualFormats.size} !== expected ${expectedFormats.size} at item ${fmtId(marker.p.id)}`
          )
          for (const [fk, fv] of expectedFormats.entries()) {
            assertInvariant(
              actualFormats.has(fk),
              `${label}: searchMarker[${i}] missing format key "${fk}" at item ${fmtId(marker.p.id)}`
            )
            const cmp = deepEqualValues(actualFormats.get(fk), fv, `${label}.searchMarker[${i}].formats[${fk}]`)
            assertInvariant(
              cmp.equal,
              `${label}: searchMarker[${i}] format "${fk}" mismatch at item ${fmtId(marker.p.id)} (${cmp.reason})`
            )
          }
        }
      }
    }
    for (const marked of markedItems) {
      assertInvariant(
        seenMarkerItems.has(marked),
        `${label}: item ${fmtId(marked.id)} has leaked marker bit (item.marker===true) not present in node._searchMarker`
      )
    }

    // 2. Verify _map head pointers and backward chains
    for (const [key, head] of node._map.entries()) {
      assertInvariant(
        head instanceof Y.Item,
        `${label}: node._map[${key}] is not an Item`
      )
      assertInvariant(
        head.parent === node && head.parentSub === key,
        `${label}: node._map[${key}] head ${fmtId(head.id)} has mismatched parent/parentSub`
      )
      assertInvariant(
        head.right === null,
        `${label}: node._map[${key}] head ${fmtId(head.id)} has non-null right`
      )
      /** @type {Set<Item>} */
      const chainSeen = new Set()
      /** @type {Item | null} */
      let next = null
      /** @type {Item | null} */
      let curr = head
      while (curr !== null) {
        assertInvariant(
          !chainSeen.has(curr),
          `${label}: cycle detected in node._map[${key}] chain at ${fmtId(curr.id)}`
        )
        assertInvariant(
          curr.parent === node && curr.parentSub === key,
          `${label}: node._map[${key}] item ${fmtId(curr.id)} has mismatched parent/parentSub`
        )
        assertInvariant(
          curr.right === next,
          `${label}: node._map[${key}] item ${fmtId(curr.id)} right pointer mismatch`
        )
        if (curr !== head) {
          assertInvariant(
            curr.deleted,
            `${label}: historical node._map[${key}] item ${fmtId(curr.id)} is not deleted`
          )
        }
        assertInvariant(
          storeItems.has(curr),
          `${label}: node._map[${key}] item ${fmtId(curr.id)} is not present in doc.store.clients`
        )
        chainSeen.add(curr)
        visitedItems.add(curr)
        next = curr
        curr = curr.left
      }
    }
  }

  assertInvariant(
    visitedItems.size === storeItems.size,
    `${label}: ${storeItems.size - visitedItems.size} orphaned Item(s) in StructStore not reachable via any parent._start or parent._map`
  )

  if (expectNoPending) {
    assertInvariant(
      store.pendingStructs === null,
      `${label}: expected pendingStructs === null, got pending for ${store.pendingStructs ? store.pendingStructs.missing.size : 0} client(s)`
    )
    assertInvariant(
      store.pendingDs === null,
      `${label}: expected pendingDs === null, got ${store.pendingDs ? store.pendingDs.byteLength : 0} pending bytes`
    )
  }
}

/**
 * Verify deep semantic equality of a single root key between two Docs.
 *
 * @param {Doc} d0
 * @param {Doc} di
 * @param {string} key
 * @param {string} label0
 * @param {string} labeli
 */
const verifyRootKeyEquality = (d0, di, key, label0, labeli) => {
  const n0 = d0.get(key)
  const ni = di.get(key)

  assertInvariant(
    n0.length === ni.length,
    `Root '${key}' length mismatch: ${label0}=${n0.length} vs ${labeli}=${ni.length}`
  )
  assertInvariant(
    n0.attrSize === ni.attrSize,
    `Root '${key}' attrSize mismatch: ${label0}=${n0.attrSize} vs ${labeli}=${ni.attrSize}`
  )
  assertInvariant(
    deltaChildrenLength(n0) === n0.length,
    `Root '${key}' ${label0} toDeltaDeep children length (${deltaChildrenLength(n0)}) !== node.length (${n0.length})`
  )
  assertInvariant(
    deltaChildrenLength(ni) === ni.length,
    `Root '${key}' ${labeli} toDeltaDeep children length (${deltaChildrenLength(ni)}) !== node.length (${ni.length})`
  )

  const str0 = n0.toString()
  const strI = ni.toString()
  assertInvariant(
    str0 === strI,
    `Root '${key}' toString() mismatch between ${label0} and ${labeli}:\n  ${label0}: ${str0.slice(0, 200)}\n  ${labeli}: ${strI.slice(0, 200)}`
  )

  const delta0 = n0.toDeltaDeep()
  const deltaI = ni.toDeltaDeep()
  assertInvariant(
    delta0.equals(deltaI),
    `Root '${key}' toDeltaDeep().equals() failed between ${label0} and ${labeli}`
  )
  const deltaJsonCmp = deepEqualValues(delta0.toJSON(), deltaI.toJSON(), `${key}.delta`)
  assertInvariant(
    deltaJsonCmp.equal,
    `Root '${key}' toDeltaDeep().toJSON() mismatch (${label0} vs ${labeli}): ${deltaJsonCmp.reason}`
  )

  const arrCmp = deepEqualValues(n0.toArray(), ni.toArray(), `${key}.toArray`)
  assertInvariant(
    arrCmp.equal,
    `Root '${key}' toArray() mismatch (${label0} vs ${labeli}): ${arrCmp.reason}`
  )

  const attrs0 = n0.getAttrs()
  const attrsI = ni.getAttrs()
  const attrsCmp = deepEqualValues(attrs0, attrsI, `${key}.attrs`)
  assertInvariant(
    attrsCmp.equal,
    `Root '${key}' getAttrs() mismatch (${label0} vs ${labeli}): ${attrsCmp.reason}`
  )

  const attrKeys0 = Array.from(n0.attrKeys())
  assertInvariant(
    attrKeys0.length === Object.keys(attrs0).length && attrKeys0.length === n0.attrSize,
    `Root '${key}' ${label0} attrKeys/attrSize mismatch`
  )
  for (let k = 0; k < attrKeys0.length; k++) {
    assertInvariant(n0.hasAttr(String(attrKeys0[k])), `Root '${key}' ${label0} missing attr key ${String(attrKeys0[k])}`)
  }

  const jsonCmp = deepEqualValues(n0.toJSON(), ni.toJSON(), `${key}.toJSON`)
  assertInvariant(
    jsonCmp.equal,
    `Root '${key}' toJSON() mismatch (${label0} vs ${labeli}): ${jsonCmp.reason}`
  )
}

/**
 * Verify full convergence across an array of Y.Doc instances.
 *
 * @param {Array<Doc>} docs
 * @param {Array<string>} [rootKeys]
 * @param {{ compareStores?: boolean | null, checkRoundtrip?: boolean }} [opts]
 */
export const verifyConvergence = (
  docs,
  rootKeys = ['text', 'array', 'map', 'xml'],
  { compareStores = null, checkRoundtrip = true } = {}
) => {
  assertInvariant(docs.length > 0, 'verifyConvergence requires at least one doc')

  for (let i = 0; i < docs.length; i++) {
    verifyDocInvariants(docs[i], { expectNoPending: true, label: `doc[${i}](client=${docs[i].clientID})` })
    assertInvariant(
      docs[i].store.skips.isEmpty(),
      `doc[${i}](client=${docs[i].clientID}) still has unintegrated skips after convergence`
    )
  }

  const d0 = docs[0]
  const sv0 = Y.encodeStateVector(d0)
  const cidsFull0 = Y.createContentIdsFromDoc(d0, true)
  const cidsVisible0 = Y.createContentIdsFromDoc(d0, false)
  const d0Kept = docHasKeptItems(d0)
  const d0Redone = docHasRedoneItems(d0)
  const d0UnGcd = d0.gc && docHasUnGcdDeletedItems(d0)
  /** @type {Doc | null} */
  let canonicalD0 = null
  if (d0Redone || (d0.gc && (d0Kept || d0UnGcd))) {
    canonicalD0 = new Y.Doc({ gc: d0.gc })
    Y.applyUpdate(canonicalD0, Y.encodeStateAsUpdate(d0))
  }

  try {
    for (let i = 1; i < docs.length; i++) {
      const di = docs[i]
      const label0 = `doc[0](client=${d0.clientID},gc=${d0.gc})`
      const labeli = `doc[${i}](client=${di.clientID},gc=${di.gc})`

      const svi = Y.encodeStateVector(di)
      assertInvariant(
        equalBytes(sv0, svi),
        `StateVector byte mismatch between ${label0} and ${labeli}`
      )

      const cidsFullI = Y.createContentIdsFromDoc(di, true)
      assertInvariant(
        Y.equalContentIds(cidsFull0, cidsFullI),
        `ContentIds(full) mismatch between ${label0} and ${labeli}`
      )
      const cidsVisibleI = Y.createContentIdsFromDoc(di, false)
      assertInvariant(
        Y.equalContentIds(cidsVisible0, cidsVisibleI),
        `ContentIds(visible) mismatch between ${label0} and ${labeli}`
      )

      const diKept = docHasKeptItems(di)
      const diRedone = docHasRedoneItems(di)
      const diUnGcd = di.gc && docHasUnGcdDeletedItems(di)
      const directComparable = d0.gc === di.gc && !d0Redone && !diRedone && (!d0.gc || (!d0Kept && !diKept && !d0UnGcd && !diUnGcd))
      const shouldCompareDirect = compareStores !== null ? compareStores : directComparable
      if (shouldCompareDirect) {
        compareStructStores(d0.store, di.store, label0, labeli)
      } else if (compareStores !== false && d0.gc === di.gc) {
        // Same gc mode but local UndoManager `redone`, `keep`, or post-clear() un-GC'd tombstones
        // prevent raw StructStore equality: verify strict wire-canonical StructStore equivalence
        // after roundtripping both docs through fresh Docs with the same gc mode
        if (canonicalD0 === null) {
          canonicalD0 = new Y.Doc({ gc: d0.gc })
          Y.applyUpdate(canonicalD0, Y.encodeStateAsUpdate(d0))
        }
        const freshI = new Y.Doc({ gc: di.gc })
        try {
          Y.applyUpdate(freshI, Y.encodeStateAsUpdate(di))
          compareStructStores(canonicalD0.store, freshI.store, `${label0}[canonical]`, `${labeli}[canonical]`)
        } finally {
          freshI.destroy()
        }
      }

      for (let k = 0; k < rootKeys.length; k++) {
        verifyRootKeyEquality(d0, di, rootKeys[k], label0, labeli)
      }
    }

    if (checkRoundtrip) {
      // Verify encodeStateAsUpdate (V1) and encodeStateAsUpdateV2 (V2) roundtrip equivalence
      // including V1 <-> V2 format conversion
      const u1 = Y.encodeStateAsUpdate(d0)
      const u2 = Y.encodeStateAsUpdateV2(d0)
      const u1ToV2 = Y.convertUpdateFormatV1ToV2(u1)
      const u2ToV1 = Y.convertUpdateFormatV2ToV1(u2)
      const refForStore = canonicalD0 ?? d0

      const rtDocs = [
        { label: 'roundtrip-v1', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Doc} d */ d => Y.applyUpdate(d, u1) },
        { label: 'roundtrip-v2', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Doc} d */ d => Y.applyUpdateV2(d, u2) },
        { label: 'roundtrip-v1-to-v2', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Doc} d */ d => Y.applyUpdateV2(d, u1ToV2) },
        { label: 'roundtrip-v2-to-v1', doc: new Y.Doc({ gc: d0.gc }), apply: /** @param {Doc} d */ d => Y.applyUpdate(d, u2ToV1) }
      ]

      try {
        for (let i = 0; i < rtDocs.length; i++) {
          const rt = rtDocs[i]
          rt.apply(rt.doc)
          verifyDocInvariants(rt.doc, { expectNoPending: true, label: rt.label })
          assertInvariant(
            equalBytes(sv0, Y.encodeStateVector(rt.doc)),
            `${rt.label}: StateVector mismatch against doc[0]`
          )
          assertInvariant(
            Y.equalContentIds(cidsFull0, Y.createContentIdsFromDoc(rt.doc, true)),
            `${rt.label}: ContentIds(full) mismatch against doc[0]`
          )
          compareStructStores(refForStore.store, rt.doc.store, 'doc[0][canonical]', rt.label)
          for (let k = 0; k < rootKeys.length; k++) {
            verifyRootKeyEquality(d0, rt.doc, rootKeys[k], 'doc[0]', rt.label)
          }
        }
      } finally {
        for (let i = 0; i < rtDocs.length; i++) {
          rtDocs[i].doc.destroy()
        }
      }
    }
  } finally {
    canonicalD0?.destroy()
  }
}
