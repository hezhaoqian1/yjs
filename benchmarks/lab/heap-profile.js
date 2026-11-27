import os from 'node:os'
import v8 from 'node:v8'
import * as Y from '../../src/index.js'
import {
  CHARS_PER_PAGE,
  DEFAULT_SEED,
  SCALE_CONFIGS,
  buildLongCollaborativeDoc
} from './longdoc-bench.js'

/**
 * @typedef {'quick' | 'realistic'} BenchScale
 */

/**
 * @typedef {'v1' | 'v2' | 'both'} ProfileFormat
 */

/**
 * @typedef {{ count: number, bytes: number }} Bucket
 */

/**
 * @typedef {{
 *   totalNodes: number,
 *   totalShallowBytes: number,
 *   buckets: Map<string, Bucket>
 * }} SnapshotSummary
 */

// Strong sink to prevent V8 from collecting the cold-loaded Doc before Snapshot B finishes
/** @type {unknown} */
let liveDocSink = null

/**
 * Yield to the event loop so V8 unwinds stack-frame register references, then run two full GC cycles.
 *
 * @param {() => void} gcFn
 * @return {Promise<void>}
 */
const yieldAndGc = async gcFn => {
  await new Promise(resolve => setImmediate(resolve))
  gcFn()
  gcFn()
}

/**
 * Format bytes cleanly in MB or KB.
 *
 * @param {number} bytes
 * @return {string}
 */
const fmtBytes = bytes => {
  const abs = Math.abs(bytes)
  const sign = bytes < 0 ? '-' : ''
  if (abs >= 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MB`
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  return `${sign}${Math.round(abs)} B`
}

/**
 * Stream-parse `v8.getHeapSnapshot()` with minimal peak memory (~3.6 MB typed arrays for 400k nodes):
 * parses `snapshot.meta`, streams `nodes` into compact typed arrays, discards `edges`/`locations`
 * completely, streams `strings`, and aggregates exact shallow byte counts per V8 constructor/type.
 *
 * @return {Promise<SnapshotSummary>}
 */
const captureStreamingHeapSummary = async () => {
  const stream = v8.getHeapSnapshot()
  stream.setEncoding('utf8')

  const NODES_MARKER = '"nodes":['
  const STRINGS_MARKER = '"strings":['

  // State machine: 0=HEADER, 1=NODES, 2=SEEK_STRINGS, 3=STRINGS, 4=DONE
  let state = 0
  let headerBuf = ''
  let seekTail = ''

  /** @type {Array<string>} */
  let nodeTypeNames = []
  let typeIdx = 0
  let nameIdx = 1
  let sizeIdx = 3
  let stride = 7
  let nodeCount = 0

  /** @type {Uint8Array | null} */
  let nodeType = null
  /** @type {Uint32Array | null} */
  let nodeName = null
  /** @type {Uint32Array | null} */
  let nodeSize = null

  let nodeIdx = 0
  let fieldPos = 0
  let curNum = 0
  let hasNum = false
  let isNeg = false

  /** @type {Array<string>} */
  const strings = []
  let inString = false
  let escaped = false
  let hasEscape = false
  let curStr = ''

  for await (const rawChunk of stream) {
    let buf = /** @type {string} */ (rawChunk)
    let pos = 0

    if (state === 0) {
      headerBuf += buf
      const mIdx = headerBuf.indexOf(NODES_MARKER)
      if (mIdx === -1) continue
      let hdr = headerBuf.slice(0, mIdx).trimEnd()
      if (hdr.endsWith(',')) hdr = hdr.slice(0, -1)
      /** @type {{ snapshot: { meta: { node_fields: Array<string>, node_types: Array<Array<string> | string> }, node_count: number } }} */
      const parsed = JSON.parse(hdr + '}')
      const meta = parsed.snapshot.meta
      const nodeFields = meta.node_fields
      const firstTypeList = meta.node_types[0]
      nodeTypeNames = Array.isArray(firstTypeList) ? firstTypeList : []
      typeIdx = nodeFields.indexOf('type')
      nameIdx = nodeFields.indexOf('name')
      sizeIdx = nodeFields.indexOf('self_size')
      stride = nodeFields.length
      nodeCount = parsed.snapshot.node_count

      nodeType = new Uint8Array(nodeCount)
      nodeName = new Uint32Array(nodeCount)
      nodeSize = new Uint32Array(nodeCount)

      buf = headerBuf
      pos = mIdx + NODES_MARKER.length
      headerBuf = ''
      state = 1
    }

    if (state === 1 && nodeType !== null && nodeName !== null && nodeSize !== null) {
      const len = buf.length
      while (pos < len) {
        const c = buf.charCodeAt(pos)
        if (c >= 48 && c <= 57) {
          curNum = curNum * 10 + (c - 48)
          hasNum = true
          pos++
        } else if (c === 45) {
          isNeg = true
          pos++
        } else if (c === 44 || c === 93) {
          if (hasNum) {
            const val = isNeg ? -curNum : curNum
            if (nodeIdx < nodeCount) {
              if (fieldPos === typeIdx) nodeType[nodeIdx] = val
              else if (fieldPos === nameIdx) nodeName[nodeIdx] = val
              else if (fieldPos === sizeIdx) nodeSize[nodeIdx] = val
            }
            curNum = 0
            hasNum = false
            isNeg = false
            fieldPos++
            if (fieldPos === stride) {
              fieldPos = 0
              nodeIdx++
            }
          }
          pos++
          if (c === 93) {
            state = 2
            break
          }
        } else {
          pos++
        }
      }
    }

    if (state === 2) {
      const combined = seekTail + (pos > 0 ? buf.slice(pos) : buf)
      const sIdx = combined.indexOf(STRINGS_MARKER)
      if (sIdx === -1) {
        seekTail = combined.length > 16 ? combined.slice(-16) : combined
        continue
      }
      buf = combined
      pos = sIdx + STRINGS_MARKER.length
      seekTail = ''
      state = 3
    }

    if (state === 3) {
      const len = buf.length
      let segStart = pos
      while (pos < len) {
        const c = buf.charCodeAt(pos)
        if (!inString) {
          if (c === 34) { // '"'
            inString = true
            escaped = false
            hasEscape = false
            curStr = ''
            segStart = pos + 1
            pos++
          } else if (c === 93) { // ']'
            state = 4
            break
          } else {
            pos++
          }
        } else {
          if (escaped) {
            escaped = false
            pos++
          } else if (c === 92) { // '\\'
            escaped = true
            hasEscape = true
            pos++
          } else if (c === 34) { // '"'
            const tail = buf.slice(segStart, pos)
            if (!hasEscape) {
              strings.push(curStr.length === 0 ? tail : curStr + tail)
            } else {
              strings.push(/** @type {string} */ (JSON.parse(`"${curStr}${tail}"`)))
            }
            curStr = ''
            inString = false
            pos++
          } else {
            pos++
          }
        }
      }
      if (state === 3 && inString && segStart < len) {
        curStr += buf.slice(segStart, len)
      }
    }
  }

  /** @type {Map<string, Bucket>} */
  const buckets = new Map()
  let totalShallowBytes = 0

  if (nodeType !== null && nodeName !== null && nodeSize !== null) {
    for (let i = 0; i < nodeIdx; i++) {
      const sz = nodeSize[i]
      totalShallowBytes += sz
      const tName = nodeTypeNames[nodeType[i]] ?? 'unknown'
      const rawName = strings[nodeName[i]] ?? ''
      let key
      if (tName === 'object' || tName === 'native' || tName === 'closure') {
        key = rawName.length > 0 ? rawName : '(anonymous)'
      } else if (tName === 'string' || tName === 'concatenated string' || tName === 'sliced string') {
        key = `(${tName})`
      } else if (tName === 'hidden') {
        key = rawName.length > 0 ? `system / ${rawName}` : '(hidden)'
      } else {
        key = `(${tName})`
      }
      const existing = buckets.get(key)
      if (existing === undefined) {
        // Flatten key out of V8 SlicedString so snapA.buckets NEVER pins 64KB snapshot chunks!
        const flatKey = Buffer.from(key, 'utf8').toString('utf8')
        buckets.set(flatKey, { count: 1, bytes: sz })
      } else {
        existing.count++
        existing.bytes += sz
      }
    }
  }

  return {
    totalNodes: nodeIdx,
    totalShallowBytes,
    buckets
  }
}

/**
 * Inspect Yjs domain structures directly inside a cold-loaded Doc (without allocating temporary IDs).
 *
 * @param {Y.Doc} doc
 */
const inspectYjsDomain = doc => {
  let totalStructs = 0
  let gcCount = 0
  let skipCount = 0
  let itemCount = 0
  let aliveItems = 0
  let deletedItems = 0
  let nonNullOriginCount = 0
  let originMatchesLeftLastId = 0
  let nonNullRightOriginCount = 0
  let rightOriginMatchesRightId = 0
  let nonNullRedoneCount = 0
  let nonNullParentSubCount = 0
  let parentIsIdCount = 0
  let rawStringChars = 0
  let contentAnyItems = 0
  let contentAnyElements = 0
  let totalContentFormatItems = 0
  let aliveContentFormatItems = 0
  let yNodeCount = doc.share.size

  /** @type {Set<string>} */
  const distinctFormats = new Set()
  /** @type {Set<Y.ID>} */
  const uniqueIdInstances = new Set()
  /** @type {Map<string, { alive: number, deleted: number, total: number }>} */
  const byContentType = new Map()

  doc.store.clients.forEach(structs => {
    totalStructs += structs.length
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      uniqueIdInstances.add(s.id)
      if (s instanceof Y.GC) {
        gcCount++
      } else if (s instanceof Y.Skip) {
        skipCount++
      } else if (s instanceof Y.Item) {
        itemCount++
        if (s.deleted) deletedItems++
        else aliveItems++

        if (s.origin !== null) {
          nonNullOriginCount++
          uniqueIdInstances.add(s.origin)
          if (s.left !== null && s.origin.client === s.left.id.client && s.origin.clock === s.left.id.clock + s.left.length - 1) {
            originMatchesLeftLastId++
          }
        }
        if (s.rightOrigin !== null) {
          nonNullRightOriginCount++
          uniqueIdInstances.add(s.rightOrigin)
          if (s.right !== null && s.rightOrigin.client === s.right.id.client && s.rightOrigin.clock === s.right.id.clock) {
            rightOriginMatchesRightId++
          }
        }
        if (s.redone !== null) {
          nonNullRedoneCount++
          uniqueIdInstances.add(s.redone)
        }
        if (s.parentSub !== null) {
          nonNullParentSubCount++
        }
        if (s.parent instanceof Y.ID) {
          parentIsIdCount++
          uniqueIdInstances.add(s.parent)
        }

        const cName = s.content.constructor.name
        let entry = byContentType.get(cName)
        if (entry === undefined) {
          entry = { alive: 0, deleted: 0, total: 0 }
          byContentType.set(cName, entry)
        }
        entry.total++
        if (s.deleted) entry.deleted++
        else entry.alive++

        if (s.content instanceof Y.ContentString) {
          if (!s.deleted) rawStringChars += s.content.str.length
        } else if (s.content instanceof Y.ContentFormat) {
          totalContentFormatItems++
          if (!s.deleted) aliveContentFormatItems++
          distinctFormats.add(`${s.content.key}\0${JSON.stringify(s.content.value)}`)
        } else if (s.content instanceof Y.ContentAny) {
          contentAnyItems++
          contentAnyElements += s.content.arr.length
        } else if (s.content instanceof Y.ContentType) {
          yNodeCount++
        }
      }
    }
  })

  let dsRanges = 0
  doc.store.ds.clients.forEach(ranges => {
    dsRanges += ranges.getIds().length
  })

  /** @type {Array<{ contentType: string, alive: number, deleted: number, total: number }>} */
  const contentBreakdown = Array.from(byContentType.entries())
    .map(([contentType, v]) => ({ contentType, ...v }))
    .sort((a, b) => b.total - a.total)

  return {
    clients: doc.store.clients.size,
    totalStructs,
    gcCount,
    skipCount,
    itemCount,
    aliveItems,
    deletedItems,
    yNodeCount,
    idAccounting: {
      uniqueIdInstances: uniqueIdInstances.size,
      structIds: totalStructs,
      nonNullOrigin: nonNullOriginCount,
      originMatchesLeftLastId,
      nonNullRightOrigin: nonNullRightOriginCount,
      rightOriginMatchesRightId,
      nonNullRedone: nonNullRedoneCount,
      nonNullParentSub: nonNullParentSubCount,
      parentIsId: parentIsIdCount
    },
    formatAccounting: {
      totalContentFormatItems,
      aliveContentFormatItems,
      distinctFormatPairs: distinctFormats.size
    },
    deleteSetAccounting: {
      dsClients: doc.store.ds.clients.size,
      dsRanges
    },
    payloadAccounting: {
      rawStringChars,
      rawStringUtf16Bytes: rawStringChars * 2,
      contentAnyItems,
      contentAnyElements
    },
    contentBreakdown
  }
}

/**
 * Run a single cold-load warmup in an isolated stack frame so `warmDoc` is released on return.
 *
 * @param {'v1' | 'v2'} fmt
 * @param {Uint8Array<ArrayBuffer>} payload
 */
const warmupFormat = (fmt, payload) => {
  const warmDoc = new Y.Doc({ gc: true })
  try {
    if (fmt === 'v1') Y.applyUpdate(warmDoc, payload)
    else Y.applyUpdateV2(warmDoc, payload)
  } finally {
    warmDoc.destroy()
  }
}

/**
 * Cold-load a Doc, sample post-GC retained heap & Snapshot B, and destroy in an isolated frame
 * so `doc` cannot remain pinned across subsequent profiles.
 *
 * @param {{
 *   fmt: 'v1' | 'v2',
 *   payload: Uint8Array<ArrayBuffer>,
 *   charLength: number,
 *   commentsLength: number,
 *   memBeforeHeapUsed: number,
 *   gcFn: () => void
 * }} opts
 */
const loadAndCaptureSnapshotB = async ({ fmt, payload, charLength, commentsLength, memBeforeHeapUsed, gcFn }) => {
  const doc = new Y.Doc({ gc: true })
  liveDocSink = doc
  try {
    const t0 = performance.now()
    if (fmt === 'v1') Y.applyUpdate(doc, payload)
    else Y.applyUpdateV2(doc, payload)
    const coldLoadMs = Number((performance.now() - t0).toFixed(2))
    const peakHeapBytes = Math.max(0, process.memoryUsage().heapUsed - memBeforeHeapUsed)

    gcFn()
    gcFn()
    const v8After = v8.getHeapStatistics()
    const memAfter = process.memoryUsage()
    const retainedHeapBytes = Math.max(0, memAfter.heapUsed - memBeforeHeapUsed)

    if (liveDocSink !== doc || doc.get('text').length !== charLength || doc.get('comments').length !== commentsLength) {
      throw new Error(`Cold load (${fmt}) state mismatch: text=${doc.get('text').length}/${charLength}`)
    }

    const snapB = await captureStreamingHeapSummary()
    const domain = inspectYjsDomain(doc)

    return {
      coldLoadMs,
      peakHeapBytes,
      retainedHeapBytes,
      rssBytes: memAfter.rss,
      v8After,
      snapB,
      domain
    }
  } finally {
    liveDocSink = null
    doc.destroy()
  }
}

/**
 * Profile cold-loading one binary format (V1 or V2) using Snapshot B - Snapshot A diffing.
 *
 * @param {{
 *   fmt: 'v1' | 'v2',
 *   payload: Uint8Array<ArrayBuffer>,
 *   charLength: number,
 *   commentsLength: number,
 *   topN: number,
 *   gcFn: () => void
 * }} opts
 */
const profileColdLoadFormat = async ({ fmt, payload, charLength, commentsLength, topN, gcFn }) => {
  // 1. Warmup V8 decoder ICs in an isolated stack frame and fully unwind + GC
  warmupFormat(fmt, payload)
  await yieldAndGc(gcFn)

  // 2. Capture Snapshot A, then unwind + GC so ALL Snapshot A parser buffers are freed before sampling baseline stats!
  const snapA = await captureStreamingHeapSummary()
  await yieldAndGc(gcFn)

  const v8Before = v8.getHeapStatistics()
  const memBefore = process.memoryUsage()

  // 3. Cold-load Doc, capture Snapshot B + domain stats in an isolated frame, then unwind + GC for spotless next run
  const loaded = await loadAndCaptureSnapshotB({
    fmt,
    payload,
    charLength,
    commentsLength,
    memBeforeHeapUsed: memBefore.heapUsed,
    gcFn
  })
  await yieldAndGc(gcFn)

  const { coldLoadMs, peakHeapBytes, retainedHeapBytes, rssBytes, v8After, snapB, domain } = loaded

  // Compute exact Snapshot B - Snapshot A per-constructor delta
  /** @type {Array<{ constructor: string, deltaCount: number, deltaBytes: number, pctOfRetained: number, avgBytes: number }>} */
  const deltas = []
  let totalSnapshotDeltaBytes = 0
  let totalSnapshotDeltaNodes = 0
  for (const [key, bBucket] of snapB.buckets.entries()) {
    const aBucket = snapA.buckets.get(key)
    const dCount = bBucket.count - (aBucket ? aBucket.count : 0)
    const dBytes = bBucket.bytes - (aBucket ? aBucket.bytes : 0)
    if (dBytes > 0 || dCount > 0) {
      totalSnapshotDeltaBytes += Math.max(0, dBytes)
      totalSnapshotDeltaNodes += Math.max(0, dCount)
    }
    if (dBytes > 0) {
      deltas.push({
        constructor: key,
        deltaCount: dCount,
        deltaBytes: dBytes,
        pctOfRetained: 0,
        avgBytes: dCount > 0 ? Number((dBytes / dCount).toFixed(1)) : 0
      })
    }
  }
  const denom = Math.max(1, totalSnapshotDeltaBytes)
  for (let i = 0; i < deltas.length; i++) {
    deltas[i].pctOfRetained = Number(((deltas[i].deltaBytes / denom) * 100).toFixed(2))
  }
  deltas.sort((a, b) => b.deltaBytes - a.deltaBytes)

  const wireBytes = payload.byteLength
  const effectiveRetained = retainedHeapBytes > 0 ? retainedHeapBytes : totalSnapshotDeltaBytes

  return {
    format: fmt,
    wireBytes,
    coldLoadMs,
    peakHeapBytes,
    retainedHeapBytes: effectiveRetained,
    snapshotDeltaBytes: totalSnapshotDeltaBytes,
    snapshotDeltaNodes: totalSnapshotDeltaNodes,
    rssBytes,
    inflationRatio: Number((effectiveRetained / Math.max(1, wireBytes)).toFixed(2)),
    bytesPerStruct: Number((effectiveRetained / Math.max(1, domain.totalStructs)).toFixed(1)),
    v8StatsDelta: {
      usedHeapSizeBytes: v8After.used_heap_size - v8Before.used_heap_size,
      totalHeapSizeBytes: v8After.total_heap_size - v8Before.total_heap_size,
      mallocedMemoryBytes: v8After.malloced_memory - v8Before.malloced_memory,
      externalMemoryBytes: v8After.external_memory - v8Before.external_memory
    },
    topConstructors: deltas.slice(0, topN),
    domain
  }
}

/**
 * Print human-readable V8 heap snapshot diff + Yjs domain struct breakdown.
 *
 * @param {{
 *   env: { node: string, platform: string, scale: BenchScale, seed: number, charLength: number, estimatedPages: number },
 *   profiles: Array<Awaited<ReturnType<typeof profileColdLoadFormat>>>
 * }} report
 */
const printHeapReport = report => {
  const { env, profiles } = report
  console.log('=== Yjs v14 Cold-Load V8 Heap Profile & Domain Struct Breakdown (D-012) ===')
  console.log(`env: Node ${env.node} | ${env.platform} | scale=${env.scale} (~${env.estimatedPages}p, ${env.charLength.toLocaleString()} chars) | seed=${env.seed}`)
  console.log('')

  for (let pi = 0; pi < profiles.length; pi++) {
    const p = profiles[pi]
    const d = p.domain
    console.log(`--- Format: ${p.format.toUpperCase()} ---`)
    console.log('1. Headline Memory Summary')
    console.log(`   Wire Payload       : ${fmtBytes(p.wireBytes)} (${p.wireBytes.toLocaleString()} B)`)
    console.log(`   Cold-Load Time     : ${p.coldLoadMs} ms`)
    console.log(`   Pre-GC Peak Heap   : ${fmtBytes(p.peakHeapBytes)}`)
    console.log(`   Post-GC Retained   : ${fmtBytes(p.retainedHeapBytes)} (${p.inflationRatio}x wire size | ${p.bytesPerStruct} B/struct)`)
    console.log(`   Snapshot Diff Sum  : ${fmtBytes(p.snapshotDeltaBytes)} across +${p.snapshotDeltaNodes.toLocaleString()} live V8 heap nodes`)
    console.log(`   Process RSS        : ${fmtBytes(p.rssBytes)}`)
    console.log(
      `   v8.getHeapStats Δ  : used=${fmtBytes(p.v8StatsDelta.usedHeapSizeBytes)} | ` +
      `total=${fmtBytes(p.v8StatsDelta.totalHeapSizeBytes)} | ` +
      `malloced=${fmtBytes(p.v8StatsDelta.mallocedMemoryBytes)} | ` +
      `external=${fmtBytes(p.v8StatsDelta.externalMemoryBytes)}`
    )
    console.log('')

    console.log(`2. Top-${p.topConstructors.length} V8 Heap Constructors (Snapshot B - Snapshot A)`)
    const hdr = `${'Constructor / V8 Type'.padEnd(32)} | ${'+Count'.padStart(10)} | ${'+Shallow'.padStart(10)} | ${'% Retained'.padStart(10)} | ${'Avg B/obj'.padStart(9)}`
    console.log(`   ${hdr}`)
    console.log(`   ${'-'.repeat(hdr.length)}`)
    let shownPct = 0
    for (let i = 0; i < p.topConstructors.length; i++) {
      const c = p.topConstructors[i]
      shownPct += c.pctOfRetained
      console.log(
        `   ${c.constructor.slice(0, 32).padEnd(32)} | ` +
        `${c.deltaCount.toLocaleString().padStart(10)} | ` +
        `${fmtBytes(c.deltaBytes).padStart(10)} | ` +
        `${(c.pctOfRetained.toFixed(2) + '%').padStart(10)} | ` +
        `${c.avgBytes.toFixed(1).padStart(9)}`
      )
    }
    console.log(`   (Top ${p.topConstructors.length} account for ${shownPct.toFixed(1)}% of snapshot delta bytes)`)
    console.log('')

    console.log('3. Yjs Domain Struct & ID Accounting')
    console.log(`   StructStore        : ${d.totalStructs.toLocaleString()} structs across ${d.clients} clients (Item=${d.itemCount.toLocaleString()} [alive=${d.aliveItems.toLocaleString()}, del=${d.deletedItems.toLocaleString()}], GC=${d.gcCount.toLocaleString()}, Skip=${d.skipCount}, YNode=${d.yNodeCount})`)
    console.log('   Items by Content*:')
    for (let i = 0; i < d.contentBreakdown.length; i++) {
      const cb = d.contentBreakdown[i]
      console.log(`     - ${cb.contentType.padEnd(18)}: total=${cb.total.toLocaleString().padStart(8)} (alive=${cb.alive.toLocaleString().padStart(8)}, deleted=${cb.deleted.toLocaleString().padStart(6)})`)
    }
    const idA = d.idAccounting
    const originRedundantPct = idA.nonNullOrigin > 0
      ? ((idA.originMatchesLeftLastId / idA.nonNullOrigin) * 100).toFixed(1)
      : '0.0'
    const rightOriginRedundantPct = idA.nonNullRightOrigin > 0
      ? ((idA.rightOriginMatchesRightId / idA.nonNullRightOrigin) * 100).toFixed(1)
      : '0.0'
    console.log(
      `   Live ID Objects    : ${idA.uniqueIdInstances.toLocaleString()} distinct Y.ID instances ` +
      `(struct.id=${idA.structIds.toLocaleString()}, ` +
      `origin=${idA.nonNullOrigin.toLocaleString()} [${idA.originMatchesLeftLastId.toLocaleString()} / ${originRedundantPct}% match left.lastId!], ` +
      `rightOrigin=${idA.nonNullRightOrigin.toLocaleString()} [${idA.rightOriginMatchesRightId.toLocaleString()} / ${rightOriginRedundantPct}% match right.id!], ` +
      `redone=${idA.nonNullRedone.toLocaleString()}, parentSub=${idA.nonNullParentSub.toLocaleString()}, parentID=${idA.parentIsId})`
    )
    console.log(`   ContentFormat      : ${d.formatAccounting.totalContentFormatItems.toLocaleString()} total (${d.formatAccounting.aliveContentFormatItems.toLocaleString()} alive) vs ONLY ${d.formatAccounting.distinctFormatPairs} distinct (key, value) pairs!`)
    console.log(`   DeleteSet (IdSet)  : ${d.deleteSetAccounting.dsRanges.toLocaleString()} IdRange entries across ${d.deleteSetAccounting.dsClients} clients`)
    console.log(`   Raw Payload vs Heap: ${d.payloadAccounting.rawStringChars.toLocaleString()} chars (${fmtBytes(d.payloadAccounting.rawStringUtf16Bytes)} UTF-16) + ${d.payloadAccounting.contentAnyElements.toLocaleString()} ContentAny elements (${d.payloadAccounting.contentAnyItems} items) vs ${fmtBytes(p.retainedHeapBytes)} retained heap`)
    console.log('')
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  /** @type {BenchScale} */
  let scale = 'realistic'
  /** @type {ProfileFormat} */
  let format = 'v1'
  let seed = DEFAULT_SEED
  let topN = 25
  let jsonOnly = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scale' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'quick' || val === 'realistic') {
        scale = val
      } else {
        console.error(`Invalid --scale "${val}" (expected quick|realistic)`)
        process.exit(2)
      }
    } else if (arg === '--format' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'v1' || val === 'v2' || val === 'both') {
        format = val
      } else {
        console.error(`Invalid --format "${val}" (expected v1|v2|both)`)
        process.exit(2)
      }
    } else if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
      if (!Number.isFinite(seed)) {
        console.error('Invalid --seed (expected integer)')
        process.exit(2)
      }
    } else if (arg === '--top' && i + 1 < argv.length) {
      topN = Number.parseInt(argv[++i], 10)
      if (!Number.isFinite(topN) || topN < 1) {
        console.error('Invalid --top (expected positive integer)')
        process.exit(2)
      }
    } else if (arg === '--json') {
      jsonOnly = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node --expose-gc ./benchmarks/lab/heap-profile.js [--scale realistic|quick] [--format v1|v2|both] [--seed N] [--top 25] [--json]')
      process.exit(0)
    }
  }
  return { scale, format, seed, topN, jsonOnly }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

/**
 * Build & encode wire fixture in an isolated stack frame so `master` is released before Snapshot A.
 *
 * @param {import('./longdoc-bench.js').ScaleConfig} cfg
 * @param {ProfileFormat} format
 * @param {number} seed
 */
const buildWireFixture = (cfg, format, seed) => {
  const built = buildLongCollaborativeDoc(cfg, seed)
  try {
    const charLength = built.master.get('text').length
    const commentsLength = built.master.get('comments').length
    const fullV1 = (format === 'v1' || format === 'both') ? Y.encodeStateAsUpdate(built.master) : null
    const fullV2 = (format === 'v2' || format === 'both') ? Y.encodeStateAsUpdateV2(built.master) : null
    return { charLength, commentsLength, fullV1, fullV2 }
  } finally {
    built.master.destroy()
  }
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const maybeGc = /** @type {{ gc?: () => void }} */ (globalThis).gc
  if (typeof maybeGc !== 'function') {
    console.error('ERROR: heap-profile.js requires --expose-gc for clean Snapshot B - Snapshot A diffing.')
    console.error('Run: node --expose-gc ./benchmarks/lab/heap-profile.js')
    process.exit(2)
  }

  const cfg = SCALE_CONFIGS[args.scale]
  const { charLength, commentsLength, fullV1, fullV2 } = buildWireFixture(cfg, args.format, args.seed)
  // Unwind buildWireFixture stack frame & flush master completely before Snapshot A
  await yieldAndGc(maybeGc)

  /** @type {Array<Awaited<ReturnType<typeof profileColdLoadFormat>>>} */
  const profiles = []
  if (fullV1 !== null) {
    profiles.push(await profileColdLoadFormat({
      fmt: 'v1',
      payload: fullV1,
      charLength,
      commentsLength,
      topN: args.topN,
      gcFn: maybeGc
    }))
  }
  if (fullV2 !== null) {
    profiles.push(await profileColdLoadFormat({
      fmt: 'v2',
      payload: fullV2,
      charLength,
      commentsLength,
      topN: args.topN,
      gcFn: maybeGc
    }))
  }

  const report = {
    env: {
      node: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      scale: args.scale,
      seed: args.seed,
      charLength,
      estimatedPages: Number((charLength / CHARS_PER_PAGE).toFixed(1))
    },
    profiles
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHeapReport(report)
  }
}

if (isMain) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
