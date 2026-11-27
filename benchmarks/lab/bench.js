import os from 'node:os'
import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'

const BASE_SEED = 424242

/**
 * Count total structs across all clients in a Doc's StructStore.
 *
 * @param {import('../../src/utils/Doc.js').Doc} doc
 * @return {number}
 */
const countStructs = doc => {
  let total = 0
  for (const structs of doc.store.clients.values()) {
    total += structs.length
  }
  return total
}

/**
 * Compute percentile from a sorted ascending numeric array.
 *
 * @param {Array<number>} sorted
 * @param {number} p Percentile in [0, 1]
 * @return {number}
 */
const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/**
 * @typedef {{
 *   name: string,
 *   ops: number,
 *   iterations: number,
 *   meanMs: number,
 *   p50Ms: number,
 *   p95Ms: number,
 *   minMs: number,
 *   maxMs: number,
 *   opsPerSec: number,
 *   heapDeltaMB: number,
 *   meta: Record<string, number | string>
 * }} BenchResult
 */

// Sink reference to prevent dead-code elimination by V8
/** @type {unknown} */
let benchmarkSink = null

/**
 * Execute a benchmark with warmup + measured iterations and memory tracking.
 *
 * @param {{
 *   name: string,
 *   ops: number,
 *   warmup: number,
 *   iterations: number,
 *   meta?: Record<string, number | string>,
 *   fn: (iter: number) => unknown
 * }} cfg
 * @return {BenchResult}
 */
const runBench = ({ name, ops, warmup, iterations, meta = {}, fn }) => {
  const maybeGc = /** @type {{ gc?: () => void }} */ (globalThis).gc
  for (let w = 0; w < warmup; w++) {
    const wt0 = performance.now()
    benchmarkSink = fn(-1 - w)
    if (performance.now() - wt0 > 1000) {
      break
    }
  }

  /** @type {Array<number>} */
  const times = []
  /** @type {Array<number>} */
  const heapDeltas = []

  for (let i = 0; i < iterations; i++) {
    if (typeof maybeGc === 'function') {
      maybeGc()
    }
    const heapBefore = process.memoryUsage().heapUsed
    const t0 = performance.now()
    const out = fn(i)
    const elapsed = performance.now() - t0
    benchmarkSink = out
    const heapAfter = process.memoryUsage().heapUsed
    times.push(elapsed)
    heapDeltas.push((heapAfter - heapBefore) / (1024 * 1024))
  }

  const sortedTimes = times.slice().sort((a, b) => a - b)
  const sortedHeaps = heapDeltas.slice().sort((a, b) => a - b)
  const sum = times.reduce((acc, v) => acc + v, 0)
  const meanMs = sum / times.length
  const p50Ms = percentile(sortedTimes, 0.5)
  const p95Ms = percentile(sortedTimes, 0.95)
  const minMs = sortedTimes[0]
  const maxMs = sortedTimes[sortedTimes.length - 1]
  const opsPerSec = meanMs > 0 ? (ops / (meanMs / 1000)) : 0
  const heapDeltaMB = percentile(sortedHeaps, 0.5)

  return {
    name,
    ops,
    iterations,
    meanMs,
    p50Ms,
    p95Ms,
    minMs,
    maxMs,
    opsPerSec,
    heapDeltaMB,
    meta
  }
}

/**
 * Build a fragmented multi-client document with >= targetOps individual structs
 * (and optionally collect incremental V1/V2 updates and a 50% partial state vector).
 *
 * @param {{
 *   seed: number,
 *   clientCount: number,
 *   numOps: number,
 *   collectUpdates: boolean
 * }} opts
 */
const buildFragmentedWorkload = ({ seed, clientCount, numOps, collectUpdates }) => {
  const gen = prng.create(seed)
  /** @type {Array<import('../../src/utils/Doc.js').Doc>} */
  const docs = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updatesV1 = []
  /** @type {Array<Uint8Array<ArrayBuffer>>} */
  const updatesV2 = []

  for (let c = 0; c < clientCount; c++) {
    const d = new Y.Doc({ gc: true })
    d.clientID = 100 + c
    docs.push(d)
  }

  const master = new Y.Doc({ gc: true })
  master.clientID = 9999

  /** @type {Uint8Array<ArrayBuffer>} */
  let partialSV = new Uint8Array(new ArrayBuffer(1))
  const halfPoint = Math.floor(numOps / 2)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 '

  for (let i = 0; i < numOps; i++) {
    const cIdx = i % clientCount
    const d = docs[cIdx]
    /** @type {Uint8Array<ArrayBuffer> | null} */
    let u1 = null
    /** @type {Uint8Array<ArrayBuffer> | null} */
    let u2 = null
    /** @param {Uint8Array<ArrayBuffer>} u */
    const onU1 = u => { u1 = u }
    /** @param {Uint8Array<ArrayBuffer>} u */
    const onU2 = u => { u2 = u }
    if (collectUpdates) {
      d.on('update', onU1)
      d.on('updateV2', onU2)
    } else {
      d.on('update', onU1)
    }

    const kind = i % 5
    if (kind === 0 || kind === 1) {
      const ytext = d.get('text')
      const pos = prng.uint32(gen, 0, ytext.length)
      const ch = alphabet[prng.uint32(gen, 0, alphabet.length - 1)]
      ytext.insert(pos, ch)
    } else if (kind === 2) {
      const ytext = d.get('text')
      if (ytext.length > 4) {
        const pos = prng.uint32(gen, 0, ytext.length - 2)
        ytext.delete(pos, 1)
      } else {
        ytext.insert(0, 'x')
      }
    } else if (kind === 3) {
      const yarr = d.get('array')
      const pos = prng.uint32(gen, 0, yarr.length)
      yarr.insert(pos, [i])
      if (yarr.length > 300) {
        yarr.delete(prng.uint32(gen, 0, yarr.length - 1), 1)
      }
    } else {
      const ymap = d.get('map')
      ymap.setAttr(`k${i % 64}`, i)
    }

    if (collectUpdates) {
      d.off('update', onU1)
      d.off('updateV2', onU2)
    } else {
      d.off('update', onU1)
    }

    if (u1 !== null) {
      Y.applyUpdate(master, u1)
      if (collectUpdates) {
        updatesV1.push(u1)
      }
    }
    if (collectUpdates && u2 !== null) {
      updatesV2.push(u2)
    }

    // Periodically sync a peer with master so origins interleave across clients
    if (i > 0 && i % 64 === 0) {
      const peer = docs[prng.uint32(gen, 0, clientCount - 1)]
      const sv = Y.encodeStateVector(peer)
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(master, sv))
    }

    if (i === halfPoint) {
      partialSV = Y.encodeStateVector(master)
    }
  }

  for (let c = 0; c < docs.length; c++) {
    docs[c].destroy()
  }

  return {
    master,
    structCount: countStructs(master),
    updatesV1,
    updatesV2,
    partialSV
  }
}

/**
 * Run all 6 benchmark suites.
 * Default profile is memory-safe and fast (<5-8s); pass `--scale full` for heavy stress scale.
 *
 * @param {{ warmup: number, iterations: number, scale: number, isFull: boolean }} opts
 * @return {Array<BenchResult>}
 */
const runAllBenchmarks = ({ warmup, iterations, scale, isFull }) => {
  /** @type {Array<BenchResult>} */
  const results = []

  // 1. text_seq_insert: 25k default (100k on --scale full)
  {
    const baseN = isFull ? 100000 : 25000
    const n = Math.max(1000, Math.round(baseN * scale))
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 '
    results.push(runBench({
      name: `text_seq_insert_${Math.round(n / 1000)}k`,
      ops: n,
      warmup,
      iterations,
      meta: { chars: n },
      fn: () => {
        const doc = new Y.Doc()
        doc.clientID = 1
        const ytext = doc.get('text')
        for (let i = 0; i < n; i++) {
          ytext.insert(i, chars[i % chars.length])
        }
        const len = ytext.length
        doc.destroy()
        return len
      }
    }))
  }

  // 2. text_random_edit: 3k default (20k on --scale full)
  {
    const baseN = isFull ? 20000 : 3000
    const n = Math.max(500, Math.round(baseN * scale))
    // Pre-generate deterministic operation tape so PRNG overhead isn't measured
    const gen = prng.create(BASE_SEED + 2)
    /** @type {Array<{ isDelete: boolean, posRatio: number, len: number, text: string }>} */
    const opsTape = new Array(n)
    const words = ['a', 'bc', 'def', 'ghij', 'klmno']
    for (let i = 0; i < n; i++) {
      const isDelete = prng.uint32(gen, 0, 99) < 30
      opsTape[i] = {
        isDelete,
        posRatio: prng.real53(gen),
        len: prng.uint32(gen, 1, 5),
        text: words[prng.uint32(gen, 0, words.length - 1)]
      }
    }
    let finalLen = 0
    results.push(runBench({
      name: `text_random_edit_${Math.round(n / 1000)}k`,
      ops: n,
      warmup,
      iterations,
      meta: { ops: n },
      fn: () => {
        const doc = new Y.Doc()
        doc.clientID = 2
        const ytext = doc.get('text')
        for (let i = 0; i < n; i++) {
          const op = opsTape[i]
          const curLen = ytext.length
          if (op.isDelete && curLen > 0) {
            const pos = Math.floor(op.posRatio * curLen)
            const delLen = math.min(op.len, curLen - pos)
            if (delLen > 0) ytext.delete(pos, delLen)
          } else {
            const pos = Math.floor(op.posRatio * (curLen + 1))
            ytext.insert(pos, op.text)
          }
        }
        finalLen = ytext.length
        doc.destroy()
        return finalLen
      }
    }))
    results[results.length - 1].meta.finalLen = finalLen
  }

  // 2b. array_seq_push: sequential single-element array pushes (targets ContentAny.mergeWith O(N^2))
  {
    const baseN = isFull ? 20000 : 5000
    const n = Math.max(500, Math.round(baseN * scale))
    results.push(runBench({
      name: `array_seq_push_${Math.round(n / 1000)}k`,
      ops: n,
      warmup,
      iterations,
      meta: { pushes: n },
      fn: () => {
        const doc = new Y.Doc()
        doc.clientID = 3
        const yarr = doc.get('array')
        for (let i = 0; i < n; i++) {
          yarr.push([i])
        }
        const len = yarr.length
        doc.destroy()
        return len
      }
    }))
  }

  // Build shared fragmented fixture (5k ops default / 15k ops -> 12k+ structs on --scale full)
  const fragOps = Math.max(1000, Math.round((isFull ? 15000 : 5000) * scale))
  const frag = buildFragmentedWorkload({
    seed: BASE_SEED + 3,
    clientCount: 8,
    numOps: fragOps,
    collectUpdates: false
  })
  const fullUpdateV1 = Y.encodeStateAsUpdate(frag.master)
  const fullUpdateV2 = Y.encodeStateAsUpdateV2(frag.master)

  // 3. snapshot_encode_decode_v1_v2
  results.push(runBench({
    name: 'snapshot_encode_v1',
    ops: frag.structCount,
    warmup,
    iterations,
    meta: { structs: frag.structCount, bytes: fullUpdateV1.byteLength },
    fn: () => Y.encodeStateAsUpdate(frag.master)
  }))

  results.push(runBench({
    name: 'snapshot_decode_v1',
    ops: frag.structCount,
    warmup,
    iterations,
    meta: { structs: frag.structCount, bytes: fullUpdateV1.byteLength },
    fn: () => {
      const d = new Y.Doc({ gc: true })
      Y.applyUpdate(d, fullUpdateV1)
      const n = d.store.clients.size
      d.destroy()
      return n
    }
  }))

  results.push(runBench({
    name: 'snapshot_encode_v2',
    ops: frag.structCount,
    warmup,
    iterations,
    meta: { structs: frag.structCount, bytes: fullUpdateV2.byteLength },
    fn: () => Y.encodeStateAsUpdateV2(frag.master)
  }))

  results.push(runBench({
    name: 'snapshot_decode_v2',
    ops: frag.structCount,
    warmup,
    iterations,
    meta: { structs: frag.structCount, bytes: fullUpdateV2.byteLength },
    fn: () => {
      const d = new Y.Doc({ gc: true })
      Y.applyUpdateV2(d, fullUpdateV2)
      const n = d.store.clients.size
      d.destroy()
      return n
    }
  }))

  // 4. merge_updates_v1_v2: 3k updates default (10k on --scale full)
  {
    const baseMerge = isFull ? 10000 : 3000
    const mergeOps = Math.max(500, Math.round(baseMerge * scale))
    const mergeFixture = buildFragmentedWorkload({
      seed: BASE_SEED + 4,
      clientCount: 8,
      numOps: mergeOps,
      collectUpdates: true
    })
    let mergedV1Bytes = 0
    let mergedV2Bytes = 0

    results.push(runBench({
      name: `merge_updates_v1_${Math.round(mergeOps / 1000)}k`,
      ops: mergeFixture.updatesV1.length,
      warmup,
      iterations,
      meta: { updates: mergeFixture.updatesV1.length },
      fn: () => {
        const merged = Y.mergeUpdates(mergeFixture.updatesV1)
        mergedV1Bytes = merged.byteLength
        return merged
      }
    }))
    results[results.length - 1].meta.outBytes = mergedV1Bytes

    results.push(runBench({
      name: `merge_updates_v2_${Math.round(mergeOps / 1000)}k`,
      ops: mergeFixture.updatesV2.length,
      warmup,
      iterations,
      meta: { updates: mergeFixture.updatesV2.length },
      fn: () => {
        const merged = Y.mergeUpdatesV2(mergeFixture.updatesV2)
        mergedV2Bytes = merged.byteLength
        return merged
      }
    }))
    results[results.length - 1].meta.outBytes = mergedV2Bytes

    mergeFixture.master.destroy()
  }

  // 4b. merge_updates_fragmented: out-of-order + overlapping chunks (stresses BlockSet.insertInto overlap/Skip paths)
  {
    const baseFragMerge = isFull ? 6000 : 2000
    const fragMergeOps = Math.max(400, Math.round(baseFragMerge * scale))
    const fragFixture = buildFragmentedWorkload({
      seed: BASE_SEED + 41,
      clientCount: 16,
      numOps: fragMergeOps,
      collectUpdates: true
    })
    const gen = prng.create(BASE_SEED + 42)
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const fragmentedV1 = fragFixture.updatesV1.slice()
    /** @type {Array<Uint8Array<ArrayBuffer>>} */
    const fragmentedV2 = fragFixture.updatesV2.slice()

    // Inject overlapping pre-merged chunks (~15%) so BlockSet.insertInto hits duplicate/overlap slicing
    const overlapChunks = Math.floor(fragMergeOps * 0.05)
    for (let c = 0; c < overlapChunks; c++) {
      const start = prng.uint32(gen, 0, Math.max(0, fragFixture.updatesV1.length - 5))
      const span = Math.min(prng.uint32(gen, 2, 5), fragFixture.updatesV1.length - start)
      if (span >= 2) {
        fragmentedV1.push(Y.mergeUpdates(fragFixture.updatesV1.slice(start, start + span)))
        fragmentedV2.push(Y.mergeUpdatesV2(fragFixture.updatesV2.slice(start, start + span)))
      }
    }
    // Deterministically shuffle out-of-order to maximize Skip creation and overlap resolution
    for (let i = fragmentedV1.length - 1; i > 0; i--) {
      const j = prng.uint32(gen, 0, i)
      const tmp1 = fragmentedV1[i]
      fragmentedV1[i] = fragmentedV1[j]
      fragmentedV1[j] = tmp1
      const tmp2 = fragmentedV2[i]
      fragmentedV2[i] = fragmentedV2[j]
      fragmentedV2[j] = tmp2
    }

    let fragOutV1 = 0
    let fragOutV2 = 0
    results.push(runBench({
      name: `merge_updates_frag_v1_${Math.round(fragMergeOps / 1000)}k`,
      ops: fragmentedV1.length,
      warmup,
      iterations,
      meta: { updates: fragmentedV1.length, clients: 16 },
      fn: () => {
        const merged = Y.mergeUpdates(fragmentedV1)
        fragOutV1 = merged.byteLength
        return merged
      }
    }))
    results[results.length - 1].meta.outBytes = fragOutV1

    results.push(runBench({
      name: `merge_updates_frag_v2_${Math.round(fragMergeOps / 1000)}k`,
      ops: fragmentedV2.length,
      warmup,
      iterations,
      meta: { updates: fragmentedV2.length, clients: 16 },
      fn: () => {
        const merged = Y.mergeUpdatesV2(fragmentedV2)
        fragOutV2 = merged.byteLength
        return merged
      }
    }))
    results[results.length - 1].meta.outBytes = fragOutV2

    fragFixture.master.destroy()
  }

  // 5. diff_update_v1_v2: diffing large update against 50% partial state vector
  {
    let diffV1Bytes = 0
    let diffV2Bytes = 0
    results.push(runBench({
      name: 'diff_update_v1',
      ops: frag.structCount,
      warmup,
      iterations,
      meta: { structs: frag.structCount, inBytes: fullUpdateV1.byteLength },
      fn: () => {
        const diff = Y.diffUpdate(fullUpdateV1, frag.partialSV)
        diffV1Bytes = diff.byteLength
        return diff
      }
    }))
    results[results.length - 1].meta.outBytes = diffV1Bytes

    results.push(runBench({
      name: 'diff_update_v2',
      ops: frag.structCount,
      warmup,
      iterations,
      meta: { structs: frag.structCount, inBytes: fullUpdateV2.byteLength },
      fn: () => {
        const diff = Y.diffUpdateV2(fullUpdateV2, frag.partialSV)
        diffV2Bytes = diff.byteLength
        return diff
      }
    }))
    results[results.length - 1].meta.outBytes = diffV2Bytes
  }

  frag.master.destroy()

  // 6. encode/decode_state_vector: 2k clients default (5k on --scale full)
  {
    const baseClients = isFull ? 5000 : 2000
    const clientCount = Math.max(500, Math.round(baseClients * scale))
    const gen = prng.create(BASE_SEED + 6)
    /** @type {Map<number, number>} */
    const svMap = new Map()
    for (let i = 0; i < clientCount; i++) {
      svMap.set(100000 + i * 17 + prng.uint32(gen, 0, 15), prng.uint32(gen, 1, 1000000))
    }
    const encodedSV = Y.encodeStateVector(svMap)
    const svIters = Math.max(iterations, 5)

    results.push(runBench({
      name: `encode_state_vector_${Math.round(clientCount / 1000)}k`,
      ops: clientCount,
      warmup,
      iterations: svIters,
      meta: { clients: clientCount, bytes: encodedSV.byteLength },
      fn: () => Y.encodeStateVector(svMap)
    }))

    results.push(runBench({
      name: `decode_state_vector_${Math.round(clientCount / 1000)}k`,
      ops: clientCount,
      warmup,
      iterations: svIters,
      meta: { clients: clientCount, bytes: encodedSV.byteLength },
      fn: () => Y.decodeStateVector(encodedSV)
    }))
  }

  // Reference sink so linter & V8 know it's intentionally read
  if (benchmarkSink === Symbol('never')) {
    console.log('')
  }

  return results
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  let json = false
  let warmup = 1
  let iterations = 3
  let scale = 1
  let isFull = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--warmup' && i + 1 < argv.length) {
      warmup = Number.parseInt(argv[++i], 10)
    } else if (arg === '--iterations' && i + 1 < argv.length) {
      iterations = Number.parseInt(argv[++i], 10)
    } else if (arg === '--scale' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'full') {
        isFull = true
        scale = 1
      } else if (val === 'default' || val === 'light') {
        isFull = false
        scale = 1
      } else {
        scale = Number.parseFloat(val)
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./benchmarks/lab/bench.js [--json] [--warmup N] [--iterations N] [--scale default|full|F]')
      process.exit(0)
    }
  }
  return { json, warmup, iterations, scale, isFull }
}

/**
 * Format benchmark results as an aligned table.
 *
 * @param {Array<BenchResult>} results
 * @param {{ node: string, platform: string, arch: string, cpu: string, totalMs: number, exposeGc: boolean }} envInfo
 */
const printTable = (results, envInfo) => {
  console.log('=== Yjs v14 Performance Benchmark Suite ===')
  console.log(`Node ${envInfo.node} | ${envInfo.platform}/${envInfo.arch} | ${envInfo.cpu} | expose-gc=${envInfo.exposeGc} | seed=${BASE_SEED}`)
  console.log('')
  const header = [
    'Benchmark'.padEnd(30),
    'Ops'.padStart(8),
    'Mean(ms)'.padStart(10),
    'p50(ms)'.padStart(10),
    'p95(ms)'.padStart(10),
    'Ops/sec'.padStart(12),
    'HeapΔ(MB)'.padStart(10),
    'Details'
  ].join(' | ')
  console.log(header)
  console.log('-'.repeat(header.length + 14))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const metaStr = Object.entries(r.meta).map(([k, v]) => `${k}=${v}`).join(' ')
    const row = [
      r.name.padEnd(30),
      String(r.ops).padStart(8),
      r.meanMs.toFixed(2).padStart(10),
      r.p50Ms.toFixed(2).padStart(10),
      r.p95Ms.toFixed(2).padStart(10),
      Math.round(r.opsPerSec).toLocaleString('en-US').padStart(12),
      r.heapDeltaMB.toFixed(2).padStart(10),
      metaStr
    ].join(' | ')
    console.log(row)
  }
  console.log('')
  console.log(`Total benchmark wall time: ${(envInfo.totalMs / 1000).toFixed(2)}s`)
}

const args = parseArgs(process.argv.slice(2))
const suiteStart = performance.now()
const results = runAllBenchmarks(args)
const totalMs = performance.now() - suiteStart
const cpus = os.cpus()
const envInfo = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus.length > 0 ? cpus[0].model.trim() : 'unknown',
  totalMs,
  exposeGc: typeof (/** @type {{ gc?: () => void }} */ (globalThis).gc) === 'function'
}

if (args.json) {
  console.log(JSON.stringify({ seed: BASE_SEED, env: envInfo, results }, null, 2))
} else {
  printTable(results, envInfo)
}
