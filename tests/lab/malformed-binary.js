import * as Y from '../../src/index.js'
import * as encoding from 'lib0/encoding'
import * as prng from 'lib0/prng'
import * as delta from 'lib0/delta'
import {
  verifyDocInvariants,
  deepEqualValues,
  equalBytes
} from './invariants.js'

/**
 * @typedef {'DOS_SLOW' | 'DOS_ALLOC' | 'ATOMICITY_VIOLATION' | 'POST_THROW_INVARIANT_BROKEN' | 'SILENT_CORRUPTION' | 'POST_ACCEPT_CRASH' | 'UNREJECTED_INVALID_PAYLOAD' | 'BROKEN_RETURN_VALUE'} FailureKind
 */

/**
 * @typedef {{
 *   category: string,
 *   payloadName: string,
 *   entryPoint: string,
 *   kind: FailureKind,
 *   elapsedMs: number,
 *   heapDeltaMB: number,
 *   payloadLen: number,
 *   payloadHex: string,
 *   detail: string
 * }} Finding
 */

/**
 * Format first N bytes of a Uint8Array as hex for reproducible diagnostics.
 *
 * @param {Uint8Array} buf
 * @param {number} [maxBytes]
 * @return {string}
 */
const toHexPreview = (buf, maxBytes = 40) => {
  const n = Math.min(buf.byteLength, maxBytes)
  const parts = []
  for (let i = 0; i < n; i++) {
    parts.push(buf[i].toString(16).padStart(2, '0'))
  }
  return parts.join(' ') + (buf.byteLength > maxBytes ? ` ... (${buf.byteLength}B total)` : '')
}

/**
 * Copy a Uint8Array into a fresh ArrayBuffer-backed Uint8Array<ArrayBuffer>.
 *
 * @param {Uint8Array} src
 * @return {Uint8Array<ArrayBuffer>}
 */
const toArrayBufferCopy = src => {
  const out = new Uint8Array(new ArrayBuffer(src.byteLength))
  out.set(src)
  return out
}

/**
 * Build a complex, valid multi-client document exercising all Yjs content types
 * (ContentString, ContentFormat, ContentEmbed, ContentDeleted/GC, ContentAny,
 * ContentBinary, ContentType, ContentDoc, deleteSet, multiple clients).
 */
const buildValidFixtures = () => {
  const doc1 = new Y.Doc({ gc: false })
  doc1.clientID = 10
  const doc2 = new Y.Doc({ gc: false })
  doc2.clientID = 20

  // Client 10 edits
  const t1 = doc1.get('text')
  t1.insert(0, 'Hello ', { bold: true })
  t1.insert(6, 'Yjs v14!', { italic: true })
  t1.applyDelta(delta.create(delta.$deltaAny).retain(5).insert([{ image: { src: 'a.png' } }]))
  t1.delete(2, 2)

  const a1 = doc1.get('array')
  a1.insert(0, [1, 'two', true, null, { nested: [1, 2] }, new Uint8Array([9, 8, 7])])
  const subNode = new Y.Node()
  a1.insert(2, [subNode])
  subNode.insert(0, ['inner'])
  const subDoc = new Y.Doc({ guid: 'subdoc-fixture-1' })
  a1.insert(a1.length, [subDoc])

  const m1 = doc1.get('map')
  m1.setAttr('k1', 'v1')
  m1.setAttr('k1', 'v1-updated')
  m1.setAttr('k2', 42)
  m1.setAttr('k3', new Uint8Array([1, 2, 3]))
  m1.deleteAttr('k2')

  const x1 = doc1.get('xml')
  const div = new Y.Node('div')
  x1.insert(0, [div])
  div.setAttr('class', 'box')
  const p = new Y.Node('p')
  div.insert(0, [p])
  p.insert(0, 'paragraph')

  // Sync doc1 -> doc2 and make concurrent edits on client 20
  Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
  doc2.get('text').insert(0, 'Prefix: ')
  doc2.get('text').format(0, 6, { color: '#00f' })
  doc2.get('array').delete(0, 1)
  doc2.get('map').setAttr('k4', { ok: true })
  Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))

  // Also produce a doc with GC enabled so valid updates include GC structs
  const docGc = new Y.Doc({ gc: true })
  Y.applyUpdate(docGc, Y.encodeStateAsUpdate(doc1))
  docGc.get('xml').delete(0, 1)

  const validV1 = Y.encodeStateAsUpdate(doc1)
  const validV2 = Y.encodeStateAsUpdateV2(doc1)
  const validGcV1 = Y.encodeStateAsUpdate(docGc)
  const validGcV2 = Y.encodeStateAsUpdateV2(docGc)
  const validSV = Y.encodeStateVector(doc1)
  const snap = Y.snapshot(doc1)
  const validSnapV1 = toArrayBufferCopy(Y.encodeSnapshot(snap))
  const validSnapV2 = toArrayBufferCopy(Y.encodeSnapshotV2(snap))
  const relPos = Y.createRelativePositionFromTypeIndex(doc1.get('text'), 2)
  const validRelPos = toArrayBufferCopy(Y.encodeRelativePosition(relPos))
  const ds = Y.createDeleteSetFromStructStore(doc1.store)
  const validIdSet = Y.encodeIdSet(ds)
  const idMap = Y.createIdMapFromIdSet(ds, [Y.createContentAttribute('author', 'alice')])
  const validIdMap = toArrayBufferCopy(Y.encodeIdMap(idMap))

  doc1.destroy()
  doc2.destroy()
  docGc.destroy()
  subDoc.destroy()

  return {
    validV1,
    validV2,
    validGcV1,
    validGcV2,
    validSV,
    validSnapV1,
    validSnapV2,
    validRelPos,
    validIdSet,
    validIdMap
  }
}

/**
 * Create a fresh pre-populated baseline document for applyUpdate atomicity testing.
 *
 * @return {Doc}
 */
const createTargetDoc = () => {
  const doc = new Y.Doc({ gc: false })
  doc.clientID = 1
  doc.get('text').insert(0, 'baseline-hello', { bold: true })
  doc.get('array').insert(0, [10, 'twenty', { x: 30 }])
  doc.get('map').setAttr('baseKey', 'origVal')
  const el = new Y.Node('div')
  doc.get('xml').insert(0, [el])
  el.setAttr('id', 'root')
  el.insert(0, 'ok')
  return doc
}

/**
 * Build a V2 update envelope from raw sub-stream buffers and a restEncoder buffer.
 *
 * @param {{
 *   keyClock?: Uint8Array,
 *   client?: Uint8Array,
 *   leftClock?: Uint8Array,
 *   rightClock?: Uint8Array,
 *   info?: Uint8Array,
 *   str?: Uint8Array,
 *   parentInfo?: Uint8Array,
 *   typeRef?: Uint8Array,
 *   len?: Uint8Array,
 *   rest: Uint8Array
 * }} streams
 * @return {Uint8Array<ArrayBuffer>}
 */
const buildRawV2Update = streams => {
  const empty = new Uint8Array(0)
  const emptyStr = new Uint8Array([0])
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0) // feature flag
  encoding.writeVarUint8Array(enc, streams.keyClock ?? empty)
  encoding.writeVarUint8Array(enc, streams.client ?? empty)
  encoding.writeVarUint8Array(enc, streams.leftClock ?? empty)
  encoding.writeVarUint8Array(enc, streams.rightClock ?? empty)
  encoding.writeVarUint8Array(enc, streams.info ?? empty)
  encoding.writeVarUint8Array(enc, streams.str ?? emptyStr)
  encoding.writeVarUint8Array(enc, streams.parentInfo ?? empty)
  encoding.writeVarUint8Array(enc, streams.typeRef ?? empty)
  encoding.writeVarUint8Array(enc, streams.len ?? empty)
  encoding.writeUint8Array(enc, streams.rest)
  return toArrayBufferCopy(encoding.toUint8Array(enc))
}

/**
 * Build a UintOptRle-encoded stream that repeats `val` `count` times (count >= 2).
 *
 * @param {number} val
 * @param {number} count
 * @return {Uint8Array<ArrayBuffer>}
 */
const encodeUintOptRleRepeat = (val, count) => {
  const enc = encoding.createEncoder()
  // Negative sign indicates repetition count follows (count - 2)
  encoding.writeVarInt(enc, val === 0 ? -0 : -val)
  encoding.writeVarUint(enc, count - 2)
  return toArrayBufferCopy(encoding.toUint8Array(enc))
}

/**
 * Build deeply nested lib0 writeAny payload of arrays (tag 117) or objects (tag 118).
 *
 * @param {number} depth
 * @param {'array' | 'object'} kind
 * @return {Uint8Array<ArrayBuffer>}
 */
const buildDeepReadAnyBytes = (depth, kind) => {
  const enc = encoding.createEncoder()
  if (kind === 'array') {
    for (let i = 0; i < depth; i++) {
      encoding.writeUint8(enc, 117) // array
      encoding.writeVarUint(enc, 1) // 1 element
    }
    encoding.writeUint8(enc, 126) // null leaf
  } else {
    for (let i = 0; i < depth; i++) {
      encoding.writeUint8(enc, 118) // object
      encoding.writeVarUint(enc, 1) // 1 property
      encoding.writeVarString(enc, 'a')
    }
    encoding.writeUint8(enc, 126) // null leaf
  }
  return toArrayBufferCopy(encoding.toUint8Array(enc))
}

/**
 * Wrap raw lib0 readAny bytes inside a V1 update containing a single ContentAny item.
 *
 * @param {Uint8Array} anyBytes
 * @return {Uint8Array<ArrayBuffer>}
 */
const wrapAnyInV1Update = anyBytes => {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 1) // numOfStateUpdates
  encoding.writeVarUint(enc, 1) // numberOfBlocks
  encoding.writeVarUint(enc, 777) // client
  encoding.writeVarUint(enc, 0) // clock
  encoding.writeUint8(enc, 8) // ContentAny, no origin, no rightOrigin, no parentSub
  encoding.writeVarUint(enc, 1) // parentInfo = true (root key)
  encoding.writeVarString(enc, 'array')
  encoding.writeVarUint(enc, 1) // ContentAny len = 1
  encoding.writeUint8Array(enc, anyBytes)
  encoding.writeVarUint(enc, 0) // ds numClients = 0
  return toArrayBufferCopy(encoding.toUint8Array(enc))
}

/**
 * Build all crafted DoS and boundary attack payloads.
 */
const buildCraftedPayloads = () => {
  /**
   * @typedef {{
   *   name: string,
   *   payload: Uint8Array<ArrayBuffer>,
   *   targets: Array<string>,
   *   mustReject: boolean,
   *   description: string,
   *   validateResult?: (res: unknown) => string | null
   * }} CraftedCase
   */

  /** @type {Array<CraftedCase>} */
  const cases = []

  // 1. Huge numOfStateUpdates (V1)
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0x7fffffff)
    cases.push({
      name: 'v1_huge_numOfStateUpdates_0x7fffffff',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 claiming 2^31-1 state updates in 5 bytes'
    })
  }

  // 2. Huge numberOfBlocks (0x0fffffff, 0x7fffffff, 0x100000000)
  for (const blocks of [0x0fffffff, 0x7fffffff, 0x100000000]) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // numOfStateUpdates
    encoding.writeVarUint(enc, blocks)
    encoding.writeVarUint(enc, 55) // client
    encoding.writeVarUint(enc, 0) // clock
    cases.push({
      name: `v1_huge_numberOfBlocks_${blocks.toString(16)}`,
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: `V1 claiming numberOfBlocks=${blocks} in short buffer`
    })
  }

  // 3. Zero-block client entry (numberOfBlocks = 0) for existing client=1
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // numOfStateUpdates
    encoding.writeVarUint(enc, 0) // numberOfBlocks = 0!
    encoding.writeVarUint(enc, 1) // client = 1 (already exists in targetDoc!)
    encoding.writeVarUint(enc, 0) // clock
    encoding.writeVarUint(enc, 0) // ds numClients = 0
    cases.push({
      name: 'v1_zero_blocks_client_entry',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: false, // Must not crash with TypeError or corrupt invariants
      description: 'V1 with numberOfBlocks=0 for existing client=1 (triggers structs[0] crash in BlockSet)'
    })
  }

  // 4. Zero-length GC struct
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 42)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 0) // GC
    encoding.writeVarUint(enc, 0) // len = 0!
    encoding.writeVarUint(enc, 0) // ds
    cases.push({
      name: 'v1_zero_length_gc',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 GC struct with length=0'
    })
  }

  // 5. Zero-length Skip struct
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 42)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 10) // Skip
    encoding.writeVarUint(enc, 0) // len = 0!
    encoding.writeVarUint(enc, 0) // ds
    cases.push({
      name: 'v1_zero_length_skip',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 Skip struct with length=0'
    })
  }

  // 6. Zero-length ContentDeleted / ContentString / ContentAny
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 43)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 1) // ContentDeleted
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'text')
    encoding.writeVarUint(enc, 0) // len = 0
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_zero_length_content_deleted',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 ContentDeleted item with length=0'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 44)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 4) // ContentString
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'text')
    encoding.writeVarString(enc, '') // empty string => length 0!
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_zero_length_content_string',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 ContentString item with empty string (length=0)'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 45)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 8) // ContentAny
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'array')
    encoding.writeVarUint(enc, 0) // len = 0!
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_zero_length_content_any',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 ContentAny item with length=0'
    })
  }

  // 7. Huge GC & Skip clock overflow (> MAX_SAFE_INTEGER)
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 46)
    encoding.writeVarUint(enc, Number.MAX_SAFE_INTEGER - 2)
    encoding.writeUint8(enc, 0) // GC
    encoding.writeVarUint(enc, 1000)
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_huge_gc_clock_overflow',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 GC causing clock + length > Number.MAX_SAFE_INTEGER'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 2)
    encoding.writeVarUint(enc, 47)
    encoding.writeVarUint(enc, Number.MAX_SAFE_INTEGER - 2)
    encoding.writeUint8(enc, 10) // Skip
    encoding.writeVarUint(enc, 1000)
    encoding.writeUint8(enc, 0) // GC after overflowing Skip
    encoding.writeVarUint(enc, 10)
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_huge_skip_clock_overflow',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 Skip causing clock overflow past Number.MAX_SAFE_INTEGER'
    })
  }

  // 8. Invalid contentRef / info tags (11, 15, 20, 31)
  for (const tag of [11, 15, 20, 31]) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 50 + tag)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, tag) // invalid 5-bit contentRef
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'text')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: `v1_invalid_contentRef_${tag}`,
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: `V1 update with invalid contentRef tag=${tag} (valid range 0..10)`
    })
  }

  // 9. Invalid JSON inside ContentJSON and ContentFormat
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 88)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 2) // ContentJSON
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'array')
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, '{broken-json')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_invalid_json_content',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 ContentJSON with invalid JSON string'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 89)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 6) // ContentFormat
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'text')
    encoding.writeVarString(enc, 'bold')
    encoding.writeVarString(enc, '{invalid')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_invalid_format_json',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'V1 ContentFormat with invalid JSON value'
    })
  }

  // 10. Non-ContentType parent ID (parent points to client=1,clock=0 which is ContentString)
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 91)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 4) // ContentString, cantCopyParentInfo
    encoding.writeVarUint(enc, 0) // parentInfo = false (parent is ID)
    encoding.writeVarUint(enc, 1) // parent client = 1
    encoding.writeVarUint(enc, 0) // parent clock = 0 (ContentString, NOT ContentType!)
    encoding.writeVarString(enc, 'orphan')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_non_type_parent_id',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate'],
      mustReject: false, // Must not crash or corrupt invariants
      description: 'V1 item whose parent ID points to a ContentString rather than ContentType'
    })
  }

  // 11. Self-referential origin & two-client causal cycle
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 98)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 4 | 128) // ContentString + BIT8 (origin present)
    encoding.writeVarUint(enc, 98) // origin client = self!
    encoding.writeVarUint(enc, 0) // origin clock = self!
    encoding.writeVarString(enc, 'loop')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_self_origin_cycle',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate'],
      mustReject: false, // Must terminate cleanly and preserve invariants
      description: 'V1 item with self-referential origin=(98,0)'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 2)
    // Client 98 depends on (99, 0)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 98)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 4 | 128)
    encoding.writeVarUint(enc, 99)
    encoding.writeVarUint(enc, 0)
    encoding.writeVarString(enc, 'a')
    // Client 99 depends on (98, 0)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 99)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 4 | 128)
    encoding.writeVarUint(enc, 98)
    encoding.writeVarUint(enc, 0)
    encoding.writeVarString(enc, 'b')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_two_client_origin_cycle',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate'],
      mustReject: false, // Must not infinite loop; invariants must hold
      description: 'V1 update with circular causal dependency between clients 98 and 99'
    })
  }

  // 12. Atomicity probes: valid structs followed by truncated/corrupt deleteSet!
  {
    const src = new Y.Doc()
    src.clientID = 9999
    src.get('text').insert(0, 'INJECTED_BEFORE_CORRUPT_DS')
    const valid = Y.encodeStateAsUpdate(src)
    src.destroy()
    // Replace trailing 0x00 (empty ds) with numClients=5 and EOF!
    const bad = new Uint8Array(new ArrayBuffer(valid.byteLength))
    bad.set(valid)
    bad[bad.byteLength - 1] = 5
    cases.push({
      name: 'v1_corrupt_ds_after_valid_structs',
      payload: bad,
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: true,
      description: 'Atomicity probe: valid V1 structs followed by truncated deleteSet'
    })
  }
  {
    const src = new Y.Doc()
    src.clientID = 9998
    src.get('text').insert(0, 'INJECTED_V2_BEFORE_CORRUPT_DS')
    const valid = Y.encodeStateAsUpdateV2(src)
    src.destroy()
    const bad = new Uint8Array(new ArrayBuffer(valid.byteLength))
    bad.set(valid)
    bad[bad.byteLength - 1] = 5
    cases.push({
      name: 'v2_corrupt_ds_after_valid_structs',
      payload: bad,
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: true,
      description: 'Atomicity probe: valid V2 structs followed by truncated deleteSet'
    })
  }

  // 13. V2 RLE bombs (tiny buffer claiming 200,000 GC blocks via 1-byte infinite RleDecoder + 4-byte OptRLE!)
  {
    const bombCount = 200000
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 500)
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1) // numOfStateUpdates = 1
    encoding.writeVarUint(restEnc, bombCount) // numberOfBlocks = 200,000
    encoding.writeVarUint(restEnc, 0) // startClock = 0
    encoding.writeVarUint(restEnc, 0) // ds = 0
    const bomb = buildRawV2Update({
      client: encoding.toUint8Array(clientEnc),
      info: new Uint8Array([0]), // RleDecoder with 1 byte repeats 0 (GC) FOREVER!
      len: encodeUintOptRleRepeat(1, bombCount), // repeats len=1 200,000 times in ~4 bytes!
      rest: encoding.toUint8Array(restEnc)
    })
    cases.push({
      name: 'v2_rle_bomb_gc_200k',
      payload: bomb,
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: true,
      description: `V2 RLE amplification bomb (${bomb.byteLength}B expanding to ${bombCount} GC structs)`
    })
  }

  // 14. V2 RLE bomb using ContentDeleted (info=1) & ContentType (info=7)
  {
    const bombCount = 200000
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 503)
    const strEnc = encoding.createEncoder()
    encoding.writeVarString(strEnc, '')
    encoding.writeUint8Array(strEnc, encodeUintOptRleRepeat(0, bombCount))
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1)
    encoding.writeVarUint(restEnc, bombCount)
    encoding.writeVarUint(restEnc, 0)
    encoding.writeVarUint(restEnc, 0)
    const bomb = buildRawV2Update({
      client: encoding.toUint8Array(clientEnc),
      info: new Uint8Array([1]), // ContentDeleted repeated forever
      parentInfo: new Uint8Array([1]), // root key repeated forever
      str: encoding.toUint8Array(strEnc),
      len: encodeUintOptRleRepeat(1, bombCount),
      rest: encoding.toUint8Array(restEnc)
    })
    cases.push({
      name: 'v2_rle_bomb_content_deleted_200k',
      payload: bomb,
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: true,
      description: `V2 RLE bomb (${bomb.byteLength}B expanding to ${bombCount} ContentDeleted items)`
    })
  }
  {
    const bombCount = 200000
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 504)
    const strEnc = encoding.createEncoder()
    encoding.writeVarString(strEnc, '')
    encoding.writeUint8Array(strEnc, encodeUintOptRleRepeat(0, bombCount))
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1)
    encoding.writeVarUint(restEnc, bombCount)
    encoding.writeVarUint(restEnc, 0)
    encoding.writeVarUint(restEnc, 0)
    const bomb = buildRawV2Update({
      client: encoding.toUint8Array(clientEnc),
      info: new Uint8Array([7]), // ContentType repeated forever
      parentInfo: new Uint8Array([1]),
      str: encoding.toUint8Array(strEnc),
      typeRef: encodeUintOptRleRepeat(0, bombCount), // YArrayRefID=0 repeated 200k times!
      rest: encoding.toUint8Array(restEnc)
    })
    cases.push({
      name: 'v2_rle_bomb_content_type_200k',
      payload: bomb,
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: true,
      description: `V2 RLE bomb (${bomb.byteLength}B expanding to ${bombCount} ContentType YNode items)`
    })
  }

  // 14b. V2 StringDecoder over-read producing zero-length ContentString items!
  {
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 501)
    const strEnc = encoding.createEncoder()
    encoding.writeVarString(strEnc, 'x') // only 1 char total!
    // Lengths: 1, 1, 1, 1, 1 (so reads 2..5 slice past end -> ''!)
    encoding.writeUint8Array(strEnc, encodeUintOptRleRepeat(1, 10))
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1) // numOfStateUpdates = 1
    encoding.writeVarUint(restEnc, 5) // 5 ContentString blocks
    encoding.writeVarUint(restEnc, 0) // startClock = 0
    encoding.writeVarUint(restEnc, 0) // ds = 0
    const payload = buildRawV2Update({
      client: encoding.toUint8Array(clientEnc),
      info: new Uint8Array([4]), // ContentString repeated forever
      parentInfo: new Uint8Array([1]), // root key repeated forever
      str: encoding.toUint8Array(strEnc),
      rest: encoding.toUint8Array(restEnc)
    })
    cases.push({
      name: 'v2_string_overread_zero_len',
      payload,
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: true,
      description: 'V2 StringDecoder over-read past string length produces empty ContentString (length=0)'
    })
  }

  // 15. V2 zero-block client entry (numberOfBlocks = 0)
  {
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 1) // existing client=1
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1) // numOfStateUpdates = 1
    encoding.writeVarUint(restEnc, 0) // numberOfBlocks = 0
    encoding.writeVarUint(restEnc, 0) // clock
    encoding.writeVarUint(restEnc, 0) // ds
    cases.push({
      name: 'v2_zero_blocks_client_entry',
      payload: buildRawV2Update({
        client: encoding.toUint8Array(clientEnc),
        rest: encoding.toUint8Array(restEnc)
      }),
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: false,
      description: 'V2 with numberOfBlocks=0 for existing client=1'
    })
  }

  // 16. V2 invalid contentRef tag (25)
  {
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 502)
    const strEnc = encoding.createEncoder()
    encoding.writeVarString(strEnc, 'text')
    encoding.writeVarInt(strEnc, 4)
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1)
    encoding.writeVarUint(restEnc, 1)
    encoding.writeVarUint(restEnc, 0)
    encoding.writeVarUint(restEnc, 0)
    cases.push({
      name: 'v2_invalid_contentRef_25',
      payload: buildRawV2Update({
        client: encoding.toUint8Array(clientEnc),
        info: new Uint8Array([25]),
        parentInfo: new Uint8Array([1]),
        str: encoding.toUint8Array(strEnc),
        rest: encoding.toUint8Array(restEnc)
      }),
      targets: ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1'],
      mustReject: true,
      description: 'V2 update with invalid contentRef tag=25'
    })
  }

  // 17. Deeply nested readAny arrays & objects (V1, V2, and IdMap; depth 5000 & 20000)
  cases.push({
    name: 'v1_deep_readAny_array_5000',
    payload: wrapAnyInV1Update(buildDeepReadAnyBytes(5000, 'array')),
    targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
    mustReject: true, // Exceeds MAX_ANY_DEPTH=128 nesting guard; must reject cleanly without regressing
    description: 'V1 ContentAny with 5,000-deep nested array'
  })
  cases.push({
    name: 'v1_deep_readAny_object_5000',
    payload: wrapAnyInV1Update(buildDeepReadAnyBytes(5000, 'object')),
    targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
    mustReject: true,
    description: 'V1 ContentAny with 5,000-deep nested object'
  })
  cases.push({
    name: 'v1_deep_readAny_array_20000',
    payload: wrapAnyInV1Update(buildDeepReadAnyBytes(20000, 'array')),
    targets: ['applyUpdate', 'decodeUpdate'],
    mustReject: true, // Depth 20000 exceeds JS stack / nesting limit -> must fail cleanly
    description: 'V1 ContentAny with 20,000-deep nested array (stack exhaustion probe)'
  })
  {
    const clientEnc = encoding.createEncoder()
    encoding.writeVarInt(clientEnc, 778)
    const strEnc = encoding.createEncoder()
    encoding.writeVarString(strEnc, 'array')
    encoding.writeVarInt(strEnc, 5)
    const lenEnc = encoding.createEncoder()
    encoding.writeVarInt(lenEnc, 1)
    const restEnc = encoding.createEncoder()
    encoding.writeVarUint(restEnc, 1)
    encoding.writeVarUint(restEnc, 1)
    encoding.writeVarUint(restEnc, 0)
    encoding.writeUint8Array(restEnc, buildDeepReadAnyBytes(5000, 'array'))
    encoding.writeVarUint(restEnc, 0)
    cases.push({
      name: 'v2_deep_readAny_array_5000',
      payload: buildRawV2Update({
        client: encoding.toUint8Array(clientEnc),
        info: new Uint8Array([8]),
        parentInfo: new Uint8Array([1]),
        str: encoding.toUint8Array(strEnc),
        len: encoding.toUint8Array(lenEnc),
        rest: encoding.toUint8Array(restEnc)
      }),
      targets: ['applyUpdateV2', 'decodeUpdateV2'],
      mustReject: true,
      description: 'V2 ContentAny with 5,000-deep nested array'
    })
  }
  {
    // Duplicate client IDs in the same V1 update
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 2) // 2 entries for same client 77!
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 77)
    encoding.writeVarUint(enc, 0)
    encoding.writeUint8(enc, 4)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'text')
    encoding.writeVarString(enc, 'a')
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 77)
    encoding.writeVarUint(enc, 1)
    encoding.writeUint8(enc, 4)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarString(enc, 'text')
    encoding.writeVarString(enc, 'b')
    encoding.writeVarUint(enc, 0)
    cases.push({
      name: 'v1_duplicate_client_entries',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: false,
      description: 'V1 update listing the same clientID=77 twice'
    })
  }
  {
    // V1 update with zero-length deleteSet range
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0) // 0 structs
    encoding.writeVarUint(enc, 1) // 1 ds client
    encoding.writeVarUint(enc, 1) // client=1
    encoding.writeVarUint(enc, 1) // 1 delete range
    encoding.writeVarUint(enc, 0) // clock=0
    encoding.writeVarUint(enc, 0) // len=0!
    cases.push({
      name: 'v1_deleteSet_zero_len',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2'],
      mustReject: false,
      description: 'V1 update with zero-length deleteSet range'
    })
  }
  {
    // V1 Snapshot with zero-length deleteSet range
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // ds: 1 client
    encoding.writeVarUint(enc, 1) // client=1
    encoding.writeVarUint(enc, 1) // 1 range
    encoding.writeVarUint(enc, 0) // clock=0
    encoding.writeVarUint(enc, 0) // len=0
    encoding.writeVarUint(enc, 0) // sv: 0 clients
    cases.push({
      name: 'snapshot_v1_zero_len_ds',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeSnapshot'],
      mustReject: false,
      description: 'V1 Snapshot with zero-length deleteSet range'
    })
  }
  {
    // IdMap with 5,000-deep nested readAny attribute value
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 0)
    encoding.writeVarUint(enc, 0)
    encoding.writeVarUint(enc, 1)
    encoding.writeVarUint(enc, 0)
    encoding.writeVarUint(enc, 0)
    encoding.writeVarString(enc, 'deep')
    encoding.writeUint8Array(enc, buildDeepReadAnyBytes(5000, 'array'))
    cases.push({
      name: 'idmap_deep_readAny_5000',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeIdMap'],
      mustReject: true,
      description: 'IdMap with 5,000-deep nested readAny attribute value'
    })
  }
  {
    /**
     * Verify decoded IdMap deduplicated [0,5) to 1 'alice', preserved both 'alice' and 'bob' on [5,10)
     * (zero silent attribute erasure via idmapAttrsEqual), and canonically interned exactly 2 attrs.
     *
     * @param {unknown} res
     * @return {string | null}
     */
    const validateDedupIdMap = res => {
      if (!(res instanceof Y.IdMap)) return 'Did not return IdMap instance'
      const attrs0 = res.slice(1, 0, 5)[0]?.attrs
      const attrs1 = res.slice(1, 5, 5)[0]?.attrs
      if (attrs0 === null || attrs0 === undefined || attrs0.length !== 1 || attrs0[0].val !== 'alice') {
        return `Expected [0,5) deduplicated to 1 'alice', got len=${attrs0 ? attrs0.length : -1}`
      }
      if (
        attrs1 === null || attrs1 === undefined || attrs1.length !== 2 ||
        !attrs1.some(a => a.val === 'alice') || !attrs1.some(a => a.val === 'bob')
      ) {
        return `Expected [5,10) to preserve both 'alice' and 'bob', got ${attrs1 ? attrs1.map(a => String(a.val)).join(',') : 'null'}`
      }
      if (res.attrs.size !== 2 || res.attrsH.size !== 2) {
        return `Expected canonical interning size=2, got attrs.size=${res.attrs.size}, attrsH.size=${res.attrsH.size}`
      }
      return null
    }

    // Vector A: IdMap with repeated attrId [0, 0] on [0,5) adjacent to [0, 1] on [5,10) (BUG-IDMAP-ADD-DUP)
    const encA = encoding.createEncoder()
    encoding.writeVarUint(encA, 1) // numClients = 1
    encoding.writeVarUint(encA, 1) // clientDiff = 1 (client = 1)
    encoding.writeVarUint(encA, 2) // numRanges = 2
    // Range 0: clock=0, len=5, attrs=[attrId 0 ('insert','alice'), attrId 0]
    encoding.writeVarUint(encA, 0)
    encoding.writeVarUint(encA, 4)
    encoding.writeVarUint(encA, 2)
    encoding.writeVarUint(encA, 0)
    encoding.writeVarUint(encA, 0)
    encoding.writeVarString(encA, 'insert')
    encoding.writeAny(encA, 'alice')
    encoding.writeVarUint(encA, 0) // duplicate attrId = 0
    // Range 1: clock=5, len=5, attrs=[attrId 0, attrId 1 ('insert','bob')]
    encoding.writeVarUint(encA, 0)
    encoding.writeVarUint(encA, 4)
    encoding.writeVarUint(encA, 2)
    encoding.writeVarUint(encA, 0)
    encoding.writeVarUint(encA, 1)
    encoding.writeVarUint(encA, 0)
    encoding.writeAny(encA, 'bob')
    cases.push({
      name: 'idmap_duplicate_attrId_adjacent_merge',
      payload: toArrayBufferCopy(encoding.toUint8Array(encA)),
      targets: ['decodeIdMap'],
      mustReject: false,
      description: 'IdMap repeating attrId=0 on [0,5) adjacent to [0,1] on [5,10) must deduplicate and preserve bob',
      validateResult: validateDedupIdMap
    })

    // Vector B: IdMap defining TWO distinct attrIds (0 & 1) with equal (name, val) hash on [0,5) adjacent to [0, 2] on [5,10)
    const encB = encoding.createEncoder()
    encoding.writeVarUint(encB, 1) // numClients = 1
    encoding.writeVarUint(encB, 1) // clientDiff = 1 (client = 1)
    encoding.writeVarUint(encB, 2) // numRanges = 2
    // Range 0: clock=0, len=5, attrs=[attrId 0 ('insert','alice'), attrId 1 ('insert','alice')]
    encoding.writeVarUint(encB, 0)
    encoding.writeVarUint(encB, 4)
    encoding.writeVarUint(encB, 2)
    encoding.writeVarUint(encB, 0) // new attrId = 0
    encoding.writeVarUint(encB, 0) // new attrNameId = 0 ('insert')
    encoding.writeVarString(encB, 'insert')
    encoding.writeAny(encB, 'alice')
    encoding.writeVarUint(encB, 1) // distinct attrId = 1 with EQUAL ('insert', 'alice')!
    encoding.writeVarUint(encB, 0) // known attrNameId = 0 ('insert')
    encoding.writeAny(encB, 'alice')
    // Range 1: clock=5, len=5, attrs=[attrId 0 ('insert','alice'), attrId 2 ('insert','bob')]
    encoding.writeVarUint(encB, 0)
    encoding.writeVarUint(encB, 4)
    encoding.writeVarUint(encB, 2)
    encoding.writeVarUint(encB, 0)
    encoding.writeVarUint(encB, 2) // new attrId = 2
    encoding.writeVarUint(encB, 0) // known attrNameId = 0 ('insert')
    encoding.writeAny(encB, 'bob')
    cases.push({
      name: 'idmap_duplicate_equal_attr_values',
      payload: toArrayBufferCopy(encoding.toUint8Array(encB)),
      targets: ['decodeIdMap'],
      mustReject: false,
      description: 'IdMap defining distinct attrIds 0 & 1 with equal (name,val) must canonically intern, deduplicate, and preserve bob',
      validateResult: validateDedupIdMap
    })
  }

  // 18. decodeStateVector huge ssLength
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0x7fffffff)
    cases.push({
      name: 'sv_huge_ssLength_0x7fffffff',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeStateVector', 'diffUpdate_sv', 'diffUpdateV2_sv'],
      mustReject: true,
      description: 'StateVector claiming 2^31-1 clients in 5 bytes'
    })
  }

  // 19. decodeSnapshot / decodeSnapshotV2 huge ds & sv counts
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0x7fffffff)
    cases.push({
      name: 'snapshot_huge_ds_clients',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeSnapshot', 'decodeSnapshotV2', 'decodeIdSet', 'decodeIdMap'],
      mustReject: true,
      description: 'IdSet/Snapshot/IdMap claiming 2^31-1 clients in 5 bytes'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // 1 client
    encoding.writeVarUint(enc, 1) // client=1
    encoding.writeVarUint(enc, 0x7fffffff) // huge numberOfDeletes
    cases.push({
      name: 'idset_huge_numberOfDeletes',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeSnapshot', 'decodeSnapshotV2', 'decodeIdSet', 'decodeIdMap'],
      mustReject: true,
      description: 'IdSet/Snapshot/IdMap claiming 2^31-1 ranges for client=1'
    })
  }

  // 20. decodeRelativePosition invalid tags (3, 42, 255)
  for (const tag of [3, 42, 255]) {
    cases.push({
      name: `relpos_invalid_tag_${tag}`,
      payload: new Uint8Array([tag]),
      targets: ['decodeRelativePosition'],
      mustReject: true,
      description: `RelativePosition with unknown discriminator tag=${tag}`
    })
  }

  // 21. decodeIdMap out-of-bounds attrId & attrNameId!
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // numClients = 1
    encoding.writeVarUint(enc, 1) // client diff = 1
    encoding.writeVarUint(enc, 1) // numberOfDeletes = 1
    encoding.writeVarUint(enc, 0) // clock = 0
    encoding.writeVarUint(enc, 0) // len = 1 (v2 adds +1)
    encoding.writeVarUint(enc, 1) // attrsLen = 1
    encoding.writeVarUint(enc, 999) // attrId = 999 (>= visitedAttributions.length = 0)!
    encoding.writeVarUint(enc, 0) // attrNameId = 0
    encoding.writeVarString(enc, 'author')
    encoding.writeAny(enc, 'mallory')
    cases.push({
      name: 'idmap_oob_attrId_999',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeIdMap'],
      mustReject: true,
      description: 'IdMap with out-of-bounds attrId=999 pushing undefined into range.attrs'
    })
  }
  {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1) // numClients = 1
    encoding.writeVarUint(enc, 1) // client diff = 1
    encoding.writeVarUint(enc, 1) // numberOfDeletes = 1
    encoding.writeVarUint(enc, 0) // clock = 0
    encoding.writeVarUint(enc, 0) // len = 1
    encoding.writeVarUint(enc, 1) // attrsLen = 1
    encoding.writeVarUint(enc, 0) // attrId = 0
    encoding.writeVarUint(enc, 999) // attrNameId = 999 (>= visitedAttrNames.length = 0)!
    encoding.writeVarString(enc, 'author')
    encoding.writeAny(enc, 'mallory')
    cases.push({
      name: 'idmap_oob_attrNameId_999',
      payload: toArrayBufferCopy(encoding.toUint8Array(enc)),
      targets: ['decodeIdMap'],
      mustReject: true,
      description: 'IdMap with out-of-bounds attrNameId=999 creating ContentAttribute(undefined, val)'
    })
  }

  return cases
}

/**
 * Run the full malformed binary security test suite.
 *
 * @param {{ seed: number, timeoutMs: number, verbose: boolean }} opts
 */
export const runMalformedBinarySuite = ({ seed, timeoutMs, verbose }) => {
  const gen = prng.create(seed)
  const fixtures = buildValidFixtures()

  /** @type {Array<Finding>} */
  const findings = []
  let totalChecks = 0
  let threwCount = 0
  let acceptedSafeCount = 0

  /** @type {Map<string, { checks: number, findings: number }>} */
  const categoryStats = new Map()

  /**
   * @param {string} category
   * @param {boolean} hasFinding
   */
  const bumpCategory = (category, hasFinding) => {
    let entry = categoryStats.get(category)
    if (entry === undefined) {
      entry = { checks: 0, findings: 0 }
      categoryStats.set(category, entry)
    }
    entry.checks++
    if (hasFinding) entry.findings++
  }

  /**
   * Record a finding.
   *
   * @param {Finding} finding
   */
  const recordFinding = finding => {
    findings.push(finding)
    if (verbose) {
      console.log(`  [FINDING] [${finding.kind}] ${finding.category}/${finding.payloadName} -> ${finding.entryPoint}: ${finding.detail}`)
    }
  }

  /**
   * Execute an applyUpdate or applyUpdateV2 check with full atomicity & invariant verification.
   *
   * @param {{
   *   category: string,
   *   payloadName: string,
   *   entryPoint: 'applyUpdate' | 'applyUpdateV2',
   *   payload: Uint8Array<ArrayBuffer>,
   *   mustReject?: boolean
   * }} cfg
   */
  const testApplyEntryPoint = ({ category, payloadName, entryPoint, payload, mustReject = false }) => {
    totalChecks++
    const doc = createTargetDoc()
    let foundIssue = false
    try {
      const beforeSV = Y.encodeStateVector(doc)
      const beforeUpdate = Y.encodeStateAsUpdate(doc)
      const beforeJson = doc.toJSON()

      const heapBefore = process.memoryUsage().heapUsed
      const t0 = performance.now()
      let threw = false
      /** @type {unknown} */
      let thrownErr = null
      try {
        if (entryPoint === 'applyUpdate') {
          Y.applyUpdate(doc, payload)
        } else {
          Y.applyUpdateV2(doc, payload)
        }
      } catch (err) {
        threw = true
        thrownErr = err
        threwCount++
      }
      const elapsedMs = performance.now() - t0
      const heapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)

      if (elapsedMs > timeoutMs) {
        foundIssue = true
        recordFinding({
          category,
          payloadName,
          entryPoint,
          kind: 'DOS_SLOW',
          elapsedMs,
          heapDeltaMB,
          payloadLen: payload.byteLength,
          payloadHex: toHexPreview(payload),
          detail: `Exceeded ${timeoutMs}ms budget (${elapsedMs.toFixed(1)}ms, threw=${threw})`
        })
      }

      if (payload.byteLength <= 256 && heapDeltaMB > 32) {
        foundIssue = true
        recordFinding({
          category,
          payloadName,
          entryPoint,
          kind: 'DOS_ALLOC',
          elapsedMs,
          heapDeltaMB,
          payloadLen: payload.byteLength,
          payloadHex: toHexPreview(payload),
          detail: `Tiny ${payload.byteLength}B payload allocated ${heapDeltaMB.toFixed(1)}MB heap`
        })
      }

      if (threw) {
        // Check post-throw invariants AND atomicity (doc must NOT be mutated if applyUpdate threw!)
        try {
          verifyDocInvariants(doc, { expectNoPending: false, label: `${entryPoint}:${payloadName}` })
        } catch (invErr) {
          foundIssue = true
          recordFinding({
            category,
            payloadName,
            entryPoint,
            kind: 'POST_THROW_INVARIANT_BROKEN',
            elapsedMs,
            heapDeltaMB,
            payloadLen: payload.byteLength,
            payloadHex: toHexPreview(payload),
            detail: `After throwing (${String(thrownErr)}), doc invariants broke: ${String(invErr)}`
          })
        }

        const afterSV = Y.encodeStateVector(doc)
        const afterUpdate = Y.encodeStateAsUpdate(doc)
        const afterJson = doc.toJSON()
        const svSame = equalBytes(beforeSV, afterSV)
        const updSame = equalBytes(beforeUpdate, afterUpdate)
        const jsonCmp = deepEqualValues(beforeJson, afterJson)
        const pendingClean = doc.store.pendingStructs === null && doc.store.pendingDs === null
        if (!svSame || !updSame || !jsonCmp.equal || !pendingClean) {
          foundIssue = true
          recordFinding({
            category,
            payloadName,
            entryPoint,
            kind: 'ATOMICITY_VIOLATION',
            elapsedMs,
            heapDeltaMB,
            payloadLen: payload.byteLength,
            payloadHex: toHexPreview(payload),
            detail: `Doc state mutated despite throwing (${String(thrownErr)}): svSame=${svSame} updSame=${updSame} jsonSame=${jsonCmp.equal} pendingClean=${pendingClean}`
          })
        }
      } else {
        if (mustReject) {
          foundIssue = true
          recordFinding({
            category,
            payloadName,
            entryPoint,
            kind: 'UNREJECTED_INVALID_PAYLOAD',
            elapsedMs,
            heapDeltaMB,
            payloadLen: payload.byteLength,
            payloadHex: toHexPreview(payload),
            detail: 'Strictly malformed payload was accepted without throwing'
          })
        }
        // Even when accepted, doc MUST satisfy all internal invariants and be re-encodable!
        try {
          verifyDocInvariants(doc, { expectNoPending: false, label: `${entryPoint}:${payloadName}` })
          Y.encodeStateAsUpdate(doc)
          Y.encodeStateAsUpdateV2(doc)
          doc.toJSON()
          if (!foundIssue) acceptedSafeCount++
        } catch (postErr) {
          foundIssue = true
          recordFinding({
            category,
            payloadName,
            entryPoint,
            kind: 'SILENT_CORRUPTION',
            elapsedMs,
            heapDeltaMB,
            payloadLen: payload.byteLength,
            payloadHex: toHexPreview(payload),
            detail: `Accepted payload corrupted doc invariants or crashed post-apply access: ${String(postErr)}`
          })
        }
      }
    } finally {
      doc.destroy()
    }
    bumpCategory(category, foundIssue)
  }

  /**
   * Execute a non-Doc binary decode/transform entry point check.
   *
   * @param {{
   *   category: string,
   *   payloadName: string,
   *   entryPoint: string,
   *   payload: Uint8Array<ArrayBuffer>,
   *   fn: () => unknown,
   *   mustReject?: boolean,
   *   validateResult?: (res: unknown) => string | null
   * }} cfg
   */
  const testPureEntryPoint = ({ category, payloadName, entryPoint, payload, fn, mustReject = false, validateResult }) => {
    totalChecks++
    const heapBefore = process.memoryUsage().heapUsed
    const t0 = performance.now()
    let threw = false
    /** @type {unknown} */
    let result
    try {
      result = fn()
    } catch (_err) {
      threw = true
      threwCount++
    }
    const elapsedMs = performance.now() - t0
    const heapDeltaMB = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024)
    let foundIssue = false

    if (elapsedMs > timeoutMs) {
      foundIssue = true
      recordFinding({
        category,
        payloadName,
        entryPoint,
        kind: 'DOS_SLOW',
        elapsedMs,
        heapDeltaMB,
        payloadLen: payload.byteLength,
        payloadHex: toHexPreview(payload),
        detail: `Exceeded ${timeoutMs}ms budget (${elapsedMs.toFixed(1)}ms, threw=${threw})`
      })
    }

    if (payload.byteLength <= 256 && heapDeltaMB > 32) {
      foundIssue = true
      recordFinding({
        category,
        payloadName,
        entryPoint,
        kind: 'DOS_ALLOC',
        elapsedMs,
        heapDeltaMB,
        payloadLen: payload.byteLength,
        payloadHex: toHexPreview(payload),
        detail: `Tiny ${payload.byteLength}B payload allocated ${heapDeltaMB.toFixed(1)}MB heap`
      })
    }

    if (!threw) {
      if (mustReject) {
        foundIssue = true
        recordFinding({
          category,
          payloadName,
          entryPoint,
          kind: 'UNREJECTED_INVALID_PAYLOAD',
          elapsedMs,
          heapDeltaMB,
          payloadLen: payload.byteLength,
          payloadHex: toHexPreview(payload),
          detail: 'Strictly malformed payload was accepted without throwing'
        })
      }
      if (validateResult !== undefined) {
        const validationErr = validateResult(result)
        if (validationErr !== null) {
          foundIssue = true
          recordFinding({
            category,
            payloadName,
            entryPoint,
            kind: 'BROKEN_RETURN_VALUE',
            elapsedMs,
            heapDeltaMB,
            payloadLen: payload.byteLength,
            payloadHex: toHexPreview(payload),
            detail: validationErr
          })
        }
      }
      if (!foundIssue) acceptedSafeCount++
    }

    bumpCategory(category, foundIssue)
  }

  /**
   * Validate a decoded RelativePosition obeys its structural contract.
   *
   * @param {unknown} res
   * @return {string | null}
   */
  const validateRelPos = res => {
    if (!(res instanceof Y.RelativePosition)) return 'Did not return RelativePosition instance'
    if (res.type === null && res.tname === null && res.item === null) {
      return 'Returned invalid RelativePosition with type=null, tname=null, item=null'
    }
    return null
  }

  /**
   * Validate a decoded IdMap contains no undefined attributes, no duplicate equal hashes per range,
   * canonical attrs/attrsH interning, and clean re-encodability.
   *
   * @param {unknown} res
   * @return {string | null}
   */
  const validateIdMapResult = res => {
    if (!(res instanceof Y.IdMap)) return 'Did not return IdMap instance'
    for (const [client, ranges] of res.clients.entries()) {
      const ids = ranges.getIds()
      for (let i = 0; i < ids.length; i++) {
        const r = ids[i]
        /** @type {Set<string>} */
        const seenHashes = new Set()
        for (let j = 0; j < r.attrs.length; j++) {
          const a = r.attrs[j]
          if (a === undefined || a === null || typeof a.name !== 'string') {
            return `IdMap client=${client} contains invalid/undefined ContentAttribute (name=${String(a?.name)})`
          }
          const h = a.hash()
          if (seenHashes.has(h)) {
            return `IdMap client=${client}@${r.clock} contains duplicate equal ContentAttribute (${a.name})`
          }
          seenHashes.add(h)
          if (!res.attrs.has(a) || res.attrsH.get(h) !== a) {
            return `IdMap client=${client}@${r.clock} ContentAttribute (${a.name}) is not canonically interned in attrs/attrsH`
          }
        }
      }
    }
    try {
      Y.encodeIdMap(res)
    } catch (err) {
      return `IdMap failed re-encode: ${err instanceof Error ? err.message : String(err)}`
    }
    return null
  }

  /**
   * Dispatch a payload to a named entry point.
   *
   * @param {string} category
   * @param {string} payloadName
   * @param {string} entryPoint
   * @param {Uint8Array<ArrayBuffer>} payload
   * @param {boolean} [mustReject]
   * @param {(res: unknown) => string | null} [extraValidate]
   */
  const runTarget = (category, payloadName, entryPoint, payload, mustReject = false, extraValidate) => {
    switch (entryPoint) {
      case 'applyUpdate':
        testApplyEntryPoint({ category, payloadName, entryPoint: 'applyUpdate', payload, mustReject })
        break
      case 'applyUpdateV2':
        testApplyEntryPoint({ category, payloadName, entryPoint: 'applyUpdateV2', payload, mustReject })
        break
      case 'decodeUpdate':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeUpdate(payload) })
        break
      case 'decodeUpdateV2':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeUpdateV2(payload) })
        break
      case 'mergeUpdates':
        testPureEntryPoint({ category, payloadName, entryPoint: 'mergeUpdates(p,v)', payload, mustReject, fn: () => Y.mergeUpdates([payload, fixtures.validV1]) })
        testPureEntryPoint({ category, payloadName, entryPoint: 'mergeUpdates(v,p)', payload, mustReject, fn: () => Y.mergeUpdates([fixtures.validV1, payload]) })
        break
      case 'mergeUpdatesV2':
        testPureEntryPoint({ category, payloadName, entryPoint: 'mergeUpdatesV2(p,v)', payload, mustReject, fn: () => Y.mergeUpdatesV2([payload, fixtures.validV2]) })
        testPureEntryPoint({ category, payloadName, entryPoint: 'mergeUpdatesV2(v,p)', payload, mustReject, fn: () => Y.mergeUpdatesV2([fixtures.validV2, payload]) })
        break
      case 'diffUpdate':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.diffUpdate(payload, fixtures.validSV) })
        break
      case 'diffUpdate_sv':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.diffUpdate(fixtures.validV1, payload) })
        break
      case 'diffUpdateV2':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.diffUpdateV2(payload, fixtures.validSV) })
        break
      case 'diffUpdateV2_sv':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.diffUpdateV2(fixtures.validV2, payload) })
        break
      case 'convertUpdateFormatV1ToV2':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.convertUpdateFormatV1ToV2(payload) })
        break
      case 'convertUpdateFormatV2ToV1':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.convertUpdateFormatV2ToV1(payload) })
        break
      case 'decodeStateVector':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeStateVector(payload) })
        break
      case 'decodeSnapshot':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeSnapshot(payload) })
        break
      case 'decodeSnapshotV2':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeSnapshotV2(payload) })
        break
      case 'decodeRelativePosition':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeRelativePosition(payload), validateResult: validateRelPos })
        break
      case 'decodeIdSet':
        testPureEntryPoint({ category, payloadName, entryPoint, payload, mustReject, fn: () => Y.decodeIdSet(payload) })
        break
      case 'decodeIdMap':
        testPureEntryPoint({
          category,
          payloadName,
          entryPoint,
          payload,
          mustReject,
          fn: () => Y.decodeIdMap(payload),
          validateResult: res => {
            const baseErr = validateIdMapResult(res)
            if (baseErr !== null) return baseErr
            return extraValidate ? extraValidate(res) : null
          }
        })
        break
    }
  }

  const ALL_TARGETS = [
    'applyUpdate',
    'applyUpdateV2',
    'decodeStateVector',
    'decodeUpdate',
    'decodeUpdateV2',
    'mergeUpdates',
    'mergeUpdatesV2',
    'diffUpdate',
    'diffUpdate_sv',
    'diffUpdateV2',
    'diffUpdateV2_sv',
    'decodeSnapshot',
    'decodeSnapshotV2',
    'decodeRelativePosition',
    'decodeIdSet',
    'decodeIdMap',
    'convertUpdateFormatV1ToV2',
    'convertUpdateFormatV2ToV1'
  ]

  // --- Suite 1: Primitive / edge buffers across ALL 16 entry points ---
  /** @type {Array<{ name: string, buf: Uint8Array<ArrayBuffer> }>} */
  const primitiveBuffers = [
    { name: 'empty_0B', buf: new Uint8Array(new ArrayBuffer(0)) },
    { name: 'one_0x00', buf: toArrayBufferCopy(new Uint8Array([0x00])) },
    { name: 'one_0x01', buf: toArrayBufferCopy(new Uint8Array([0x01])) },
    { name: 'one_0x03', buf: toArrayBufferCopy(new Uint8Array([0x03])) },
    { name: 'one_0x7f', buf: toArrayBufferCopy(new Uint8Array([0x7f])) },
    { name: 'one_0x80', buf: toArrayBufferCopy(new Uint8Array([0x80])) },
    { name: 'one_0xff', buf: toArrayBufferCopy(new Uint8Array([0xff])) },
    { name: 'zeros_16B', buf: new Uint8Array(new ArrayBuffer(16)) },
    { name: 'ones_0xff_16B', buf: toArrayBufferCopy(new Uint8Array(16).fill(0xff)) },
    { name: 'unterminated_varuint_64B', buf: toArrayBufferCopy(new Uint8Array(64).fill(0x80)) }
  ]
  for (let i = 0; i < primitiveBuffers.length; i++) {
    const p = primitiveBuffers[i]
    for (let t = 0; t < ALL_TARGETS.length; t++) {
      runTarget('primitives', p.name, ALL_TARGETS[t], p.buf, false)
    }
  }

  // --- Suite 2: Truncations at EVERY byte offset of complex V1 & V2 updates and metadata ---
  const v1Targets = ['applyUpdate', 'decodeUpdate', 'mergeUpdates', 'diffUpdate', 'convertUpdateFormatV1ToV2']
  for (let cut = 0; cut < fixtures.validV1.byteLength; cut++) {
    const truncated = toArrayBufferCopy(fixtures.validV1.subarray(0, cut))
    for (let t = 0; t < v1Targets.length; t++) {
      runTarget('truncations-v1', `validV1[0..${cut}]`, v1Targets[t], truncated, false)
    }
  }

  const v2Targets = ['applyUpdateV2', 'decodeUpdateV2', 'mergeUpdatesV2', 'diffUpdateV2', 'convertUpdateFormatV2ToV1']
  for (let cut = 0; cut < fixtures.validV2.byteLength; cut++) {
    const truncated = toArrayBufferCopy(fixtures.validV2.subarray(0, cut))
    for (let t = 0; t < v2Targets.length; t++) {
      runTarget('truncations-v2', `validV2[0..${cut}]`, v2Targets[t], truncated, false)
    }
  }

  /** @type {Array<{ name: string, buf: Uint8Array<ArrayBuffer>, targets: Array<string> }>} */
  const metaFixtures = [
    { name: 'validSV', buf: fixtures.validSV, targets: ['decodeStateVector', 'diffUpdate_sv', 'diffUpdateV2_sv'] },
    { name: 'validSnapV1', buf: fixtures.validSnapV1, targets: ['decodeSnapshot'] },
    { name: 'validSnapV2', buf: fixtures.validSnapV2, targets: ['decodeSnapshotV2'] },
    { name: 'validRelPos', buf: fixtures.validRelPos, targets: ['decodeRelativePosition'] },
    { name: 'validIdSet', buf: fixtures.validIdSet, targets: ['decodeIdSet'] },
    { name: 'validIdMap', buf: fixtures.validIdMap, targets: ['decodeIdMap'] }
  ]
  for (let m = 0; m < metaFixtures.length; m++) {
    const mf = metaFixtures[m]
    for (let cut = 0; cut < mf.buf.byteLength; cut++) {
      const truncated = toArrayBufferCopy(mf.buf.subarray(0, cut))
      for (let t = 0; t < mf.targets.length; t++) {
        runTarget('truncations-meta', `${mf.name}[0..${cut}]`, mf.targets[t], truncated, false)
      }
    }
  }

  // --- Suite 3: Deterministic single-bit & multi-byte bit-flips ---
  /**
   * @param {string} category
   * @param {string} baseName
   * @param {Uint8Array<ArrayBuffer>} base
   * @param {Array<string>} targets
   * @param {number} singleCount
   * @param {number} multiCount
   */
  const runMutations = (category, baseName, base, targets, singleCount, multiCount) => {
    for (let i = 0; i < singleCount; i++) {
      const mutated = toArrayBufferCopy(base)
      const pos = prng.uint32(gen, 0, mutated.byteLength - 1)
      const bit = 1 << prng.uint32(gen, 0, 7)
      mutated[pos] ^= bit
      for (let t = 0; t < targets.length; t++) {
        runTarget(category, `${baseName}_flip1_pos${pos}_bit${bit}`, targets[t], mutated, false)
      }
    }
    for (let i = 0; i < multiCount; i++) {
      const mutated = toArrayBufferCopy(base)
      const flips = prng.uint32(gen, 2, Math.min(6, mutated.byteLength))
      for (let f = 0; f < flips; f++) {
        const pos = prng.uint32(gen, 0, mutated.byteLength - 1)
        mutated[pos] = prng.uint32(gen, 0, 255)
      }
      for (let t = 0; t < targets.length; t++) {
        runTarget(category, `${baseName}_mut${flips}_#${i}`, targets[t], mutated, false)
      }
    }
  }

  runMutations('bitflips-v1', 'validV1', fixtures.validV1, v1Targets, 80, 30)
  runMutations('bitflips-v1', 'validGcV1', fixtures.validGcV1, ['applyUpdate', 'decodeUpdate'], 30, 15)
  runMutations('bitflips-v2', 'validV2', fixtures.validV2, v2Targets, 80, 30)
  runMutations('bitflips-v2', 'validGcV2', fixtures.validGcV2, ['applyUpdateV2', 'decodeUpdateV2'], 30, 15)
  runMutations('bitflips-meta', 'validSV', fixtures.validSV, ['decodeStateVector', 'diffUpdate_sv', 'diffUpdateV2_sv'], 20, 15)
  runMutations('bitflips-meta', 'validSnapV1', fixtures.validSnapV1, ['decodeSnapshot'], 20, 15)
  runMutations('bitflips-meta', 'validSnapV2', fixtures.validSnapV2, ['decodeSnapshotV2'], 20, 15)
  runMutations('bitflips-meta', 'validRelPos', fixtures.validRelPos, ['decodeRelativePosition'], 15, 10)
  runMutations('bitflips-meta', 'validIdSet', fixtures.validIdSet, ['decodeIdSet'], 20, 15)
  runMutations('bitflips-meta', 'validIdMap', fixtures.validIdMap, ['decodeIdMap'], 25, 15)

  // Random garbage buffers across all entry points
  for (let i = 0; i < 20; i++) {
    const len = prng.uint32(gen, 1, 64)
    const garbage = new Uint8Array(new ArrayBuffer(len))
    for (let b = 0; b < len; b++) {
      garbage[b] = prng.uint32(gen, 0, 255)
    }
    for (let t = 0; t < ALL_TARGETS.length; t++) {
      runTarget('random-garbage', `garbage_${len}B_#${i}`, ALL_TARGETS[t], garbage, false)
    }
  }

  // --- Suite 4: Crafted DoS / Security Boundary / Atomicity Payloads ---
  const crafted = buildCraftedPayloads()
  for (let i = 0; i < crafted.length; i++) {
    const c = crafted[i]
    for (let t = 0; t < c.targets.length; t++) {
      runTarget('crafted-security', c.name, c.targets[t], c.payload, c.mustReject, c.validateResult)
    }
  }

  // --- Suite 5: Positive V2 Compatibility Regression (V2-COMPAT-4000) ---
  // Verify compact high-compression legitimate V2 docs (4000 empty Y.Nodes in a table)
  // are NEVER false-rejected by V2 RLE bomb defenses across all V2 entry points.
  {
    const compatDoc = new Y.Doc({ gc: false })
    compatDoc.clientID = 1234
    compatDoc.get('table').insert(0, Array.from({ length: 4000 }, () => new Y.Node()))
    const compatV2 = Y.encodeStateAsUpdateV2(compatDoc)
    const compatV1 = Y.encodeStateAsUpdate(compatDoc)
    const compatSV = Y.encodeStateVector(compatDoc)
    compatDoc.destroy()

    totalChecks++
    const t0 = performance.now()
    /** @type {string | null} */
    let compatErr = null
    try {
      const dst = new Y.Doc({ gc: false })
      try {
        Y.applyUpdateV2(dst, compatV2)
        if (dst.get('table').length !== 4000) {
          compatErr = `Expected table.length === 4000, got ${dst.get('table').length}`
        } else if (!equalBytes(compatSV, Y.encodeStateVector(dst))) {
          compatErr = 'StateVector mismatch after V2-COMPAT-4000 applyUpdateV2'
        } else {
          verifyDocInvariants(dst, { expectNoPending: true, label: 'V2-COMPAT-4000' })
          const dec = Y.decodeUpdateV2(compatV2)
          if (dec.structs.length !== 4000) {
            compatErr = `decodeUpdateV2 returned ${dec.structs.length} structs (expected 4000)`
          }
          const merged = Y.mergeUpdatesV2([compatV2, fixtures.validV2])
          const conv = Y.convertUpdateFormatV2ToV1(compatV2)
          const diff = Y.diffUpdateV2(compatV2, new Uint8Array([0]))
          if (merged.byteLength === 0 || conv.byteLength === 0 || diff.byteLength === 0 || compatV1.byteLength === 0) {
            compatErr = 'Empty output from V2 transform on V2-COMPAT-4000'
          }
        }
      } finally {
        dst.destroy()
      }
    } catch (err) {
      compatErr = `Legitimate 4000-node V2 update was falsely rejected: ${String(err)}`
    }
    const elapsedMs = performance.now() - t0
    if (compatErr !== null) {
      recordFinding({
        category: 'v2-compat',
        payloadName: 'V2-COMPAT-4000',
        entryPoint: 'applyUpdateV2/decodeUpdateV2/mergeUpdatesV2/convertV2ToV1',
        kind: 'BROKEN_RETURN_VALUE',
        elapsedMs,
        heapDeltaMB: 0,
        payloadLen: compatV2.byteLength,
        payloadHex: toHexPreview(compatV2),
        detail: compatErr
      })
      bumpCategory('v2-compat', true)
    } else {
      acceptedSafeCount++
      bumpCategory('v2-compat', false)
    }
  }

  return {
    totalChecks,
    threwCount,
    acceptedSafeCount,
    findings,
    categoryStats
  }
}

/**
 * Parse CLI flags.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let seed = 1337
  let timeoutMs = 200
  let reportOnly = false
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--timeout-ms' && i + 1 < argv.length) {
      timeoutMs = Number.parseInt(argv[++i], 10)
    } else if (arg === '--report') {
      reportOnly = true
    } else if (arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/malformed-binary.js [--seed N] [--timeout-ms N] [--report] [--verbose]')
      process.exit(0)
    }
  }
  return { seed, timeoutMs, reportOnly, verbose }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const t0 = performance.now()
  console.log('=== Yjs v14 Malformed Binary Security & Robustness Harness ===')
  console.log(`seed=${args.seed} timeoutMs=${args.timeoutMs} mode=${args.reportOnly ? 'report' : 'gate'}`)

  const res = runMalformedBinarySuite(args)
  const totalMs = (performance.now() - t0).toFixed(1)

  console.log('\n--- Category Breakdown ---')
  for (const [cat, st] of res.categoryStats.entries()) {
    const status = st.findings === 0 ? 'PASS' : 'FAIL'
    console.log(`  [${status}] ${cat.padEnd(20)} checks=${String(st.checks).padStart(5)}  findings=${st.findings}`)
  }

  if (res.findings.length > 0) {
    /** @type {Map<string, { count: number, sample: Finding }>} */
    const grouped = new Map()
    for (let i = 0; i < res.findings.length; i++) {
      const f = res.findings[i]
      const key = `${f.kind} | ${f.category} | ${f.entryPoint} | ${f.category === 'crafted-security' ? f.payloadName : f.detail.slice(0, 70)}`
      const existing = grouped.get(key)
      if (existing === undefined) {
        grouped.set(key, { count: 1, sample: f })
      } else {
        existing.count++
      }
    }

    console.log(`\n--- Discovered Vulnerabilities / Failures (${res.findings.length} total, ${grouped.size} unique groups) ---`)
    for (const [, g] of grouped.entries()) {
      const s = g.sample
      console.log(`  [${s.kind}] (x${g.count}) ${s.category}/${s.payloadName} -> ${s.entryPoint}`)
      console.log(`      time=${s.elapsedMs.toFixed(1)}ms heapDelta=${s.heapDeltaMB.toFixed(2)}MB len=${s.payloadLen}B`)
      console.log(`      detail: ${s.detail}`)
      console.log(`      hex:    ${s.payloadHex}`)
    }
  }

  console.log(`\n=== Summary: ${res.totalChecks} checks (${res.threwCount} threw, ${res.acceptedSafeCount} safely accepted), ${res.findings.length} findings in ${totalMs}ms ===`)
  if (res.findings.length > 0 && !args.reportOnly) {
    process.exit(1)
  }
}
