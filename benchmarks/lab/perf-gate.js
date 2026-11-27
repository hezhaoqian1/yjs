import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from '../../src/index.js'
import {
  CHARS_PER_PAGE,
  DEFAULT_SEED,
  SCALE_CONFIGS,
  buildLongCollaborativeDoc,
  inspectStructStore,
  percentile,
  sha256Hex
} from './longdoc-bench.js'

const BENCH_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_BASELINE_PATH = join(BENCH_DIR, 'perf-baseline.json')

/**
 * @typedef {'quick' | 'realistic'} BenchScale
 */

/**
 * @typedef {{
 *   encodeMs: number,
 *   encodeWallMs: number,
 *   coldLoadMs: number,
 *   coldLoadWallMs: number,
 *   coldLoadPeakHeapBytes: number,
 *   coldLoadRetainedHeapBytes: number,
 *   coldLoadRssBytes: number
 * }} FormatMetrics
 */

/**
 * @typedef {{
 *   version: number,
 *   recordedAt: string,
 *   env: {
 *     node: string,
 *     platform: string,
 *     cpu: string,
 *     scale: BenchScale,
 *     seed: number,
 *     iters: number
 *   },
 *   docStats: {
 *     charLength: number,
 *     estimatedPages: number,
 *     commentsLength: number,
 *     totalStructs: number,
 *     aliveItems: number,
 *     deletedItems: number,
 *     gcStructs: number,
 *     buildMs: number
 *   },
 *   wire: {
 *     v1Bytes: number,
 *     v2Bytes: number,
 *     v1Sha256: string,
 *     v2Sha256: string,
 *     deltaSha256: string
 *   },
 *   v1: FormatMetrics,
 *   v2: FormatMetrics
 * }} PerfSnapshot
 */

/**
 * @typedef {{
 *   metric: string,
 *   kind: 'exact' | 'max-regression',
 *   baselineDisplay: string,
 *   currentDisplay: string,
 *   deltaDisplay: string,
 *   ok: boolean
 * }} GateCheck
 */

// Module-level strong reference sink so V8 never collects a live Doc before retained heap is sampled
/** @type {unknown} */
let retainedSink = null

/**
 * Compute median (p50) of a numeric sample array.
 *
 * @param {Array<number>} samples
 * @return {number}
 */
const median = samples => {
  const sorted = samples.slice().sort((a, b) => a - b)
  return percentile(sorted, 0.5)
}

/**
 * Format bytes as human-readable MB or KB.
 *
 * @param {number} bytes
 * @return {string}
 */
const fmtBytes = bytes => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Format signed percentage delta.
 *
 * @param {number} ratio
 * @return {string}
 */
const fmtPct = ratio => {
  const pct = ratio * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

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
 * Build the deterministic long doc and measure V1/V2 encode latencies in an isolated stack frame
 * so `master` is guaranteed eligible for GC as soon as this helper returns.
 *
 * @param {import('./longdoc-bench.js').ScaleConfig} cfg
 * @param {number} seed
 * @param {number} iters
 */
const buildAndEncodeFixture = (cfg, seed, iters) => {
  const { master, buildMs } = buildLongCollaborativeDoc(cfg, seed)
  /** @type {Uint8Array<ArrayBuffer>} */
  let fullV1 = new Uint8Array(new ArrayBuffer(0))
  /** @type {Uint8Array<ArrayBuffer>} */
  let fullV2 = new Uint8Array(new ArrayBuffer(0))
  /** @type {Array<number>} */
  const encV1CpuSamples = []
  /** @type {Array<number>} */
  const encV1WallSamples = []
  /** @type {Array<number>} */
  const encV2CpuSamples = []
  /** @type {Array<number>} */
  const encV2WallSamples = []

  try {
    const masterText = master.get('text')
    const masterComments = master.get('comments')
    const charLength = masterText.length
    const commentsLength = masterComments.length
    const estimatedPages = Number((charLength / CHARS_PER_PAGE).toFixed(1))
    const st = inspectStructStore(master)
    const deltaSha256 = sha256Hex(JSON.stringify(masterText.toDeltaDeep().toJSON()))

    // Warmup V1 & V2 encoders (3 passes each)
    for (let w = 0; w < 3; w++) {
      fullV1 = Y.encodeStateAsUpdate(master)
      fullV2 = Y.encodeStateAsUpdateV2(master)
    }

    const ENCODE_BATCH = 8
    // Measure encode V1 (median of `iters`, CPU time + wall time)
    for (let i = 0; i < iters; i++) {
      const c0 = process.cpuUsage()
      const t0 = performance.now()
      for (let b = 0; b < ENCODE_BATCH; b++) {
        fullV1 = Y.encodeStateAsUpdate(master)
      }
      const wallMs = (performance.now() - t0) / ENCODE_BATCH
      const dc = process.cpuUsage(c0)
      const cpuMs = (dc.user + dc.system) / 1000 / ENCODE_BATCH
      encV1CpuSamples.push(cpuMs)
      encV1WallSamples.push(wallMs)
    }

    // Measure encode V2 (median of `iters`, CPU time + wall time)
    for (let i = 0; i < iters; i++) {
      const c0 = process.cpuUsage()
      const t0 = performance.now()
      for (let b = 0; b < ENCODE_BATCH; b++) {
        fullV2 = Y.encodeStateAsUpdateV2(master)
      }
      const wallMs = (performance.now() - t0) / ENCODE_BATCH
      const dc = process.cpuUsage(c0)
      const cpuMs = (dc.user + dc.system) / 1000 / ENCODE_BATCH
      encV2CpuSamples.push(cpuMs)
      encV2WallSamples.push(wallMs)
    }

    return {
      fullV1,
      fullV2,
      v1Sha256: sha256Hex(fullV1),
      v2Sha256: sha256Hex(fullV2),
      deltaSha256,
      v1EncodeMs: Number(median(encV1CpuSamples).toFixed(2)),
      v1EncodeWallMs: Number(median(encV1WallSamples).toFixed(2)),
      v2EncodeMs: Number(median(encV2CpuSamples).toFixed(2)),
      v2EncodeWallMs: Number(median(encV2WallSamples).toFixed(2)),
      docStats: {
        charLength,
        estimatedPages,
        commentsLength,
        totalStructs: st.totalStructs,
        aliveItems: st.aliveItems,
        deletedItems: st.deletedItems,
        gcStructs: st.gcStructs,
        buildMs
      }
    }
  } finally {
    master.destroy()
  }
}

/**
 * Run a single cold-load warmup in an isolated stack frame so `warmDoc` is released on return.
 *
 * @param {'v1' | 'v2'} fmt
 * @param {Uint8Array<ArrayBuffer>} payload
 */
const warmupColdLoad = (fmt, payload) => {
  const warmDoc = new Y.Doc({ gc: true })
  try {
    if (fmt === 'v1') Y.applyUpdate(warmDoc, payload)
    else Y.applyUpdateV2(warmDoc, payload)
  } finally {
    warmDoc.destroy()
  }
}

/**
 * Execute one cold-load iteration in an isolated stack frame so `doc` cannot pin heap into the next iteration.
 *
 * @param {'v1' | 'v2'} fmt
 * @param {Uint8Array<ArrayBuffer>} payload
 * @param {number} charLength
 * @param {number} commentsLength
 * @param {() => void} gcFn
 */
const measureSingleColdLoad = (fmt, payload, charLength, commentsLength, gcFn) => {
  const heapBefore = process.memoryUsage().heapUsed
  const doc = new Y.Doc({ gc: true })
  retainedSink = doc
  try {
    const c0 = process.cpuUsage()
    const t0 = performance.now()
    if (fmt === 'v1') {
      Y.applyUpdate(doc, payload)
    } else {
      Y.applyUpdateV2(doc, payload)
    }
    const wallMs = performance.now() - t0
    const dc = process.cpuUsage(c0)
    const cpuMs = (dc.user + dc.system) / 1000
    const peakDelta = Math.max(0, process.memoryUsage().heapUsed - heapBefore)

    // Evict all transient decoder/nursery garbage while keeping `doc` strongly live
    gcFn()
    gcFn()
    const memRetained = process.memoryUsage()
    const retainedDelta = Math.max(0, memRetained.heapUsed - heapBefore)

    if (retainedSink !== doc || doc.get('text').length !== charLength || doc.get('comments').length !== commentsLength) {
      throw new Error(`Cold load (${fmt}) state mismatch: text=${doc.get('text').length}/${charLength}, comments=${doc.get('comments').length}/${commentsLength}`)
    }

    return {
      cpuMs,
      wallMs,
      peakDelta,
      retainedDelta,
      rss: memRetained.rss
    }
  } finally {
    retainedSink = null
    doc.destroy()
  }
}

/**
 * Measure the repeatable D-012 encode, cold-load latency, peak pre-GC heap, true post-GC retained heap,
 * and SHA-256 wire/delta identity on the deterministic long-doc workload.
 *
 * @param {{
 *   scale: BenchScale,
 *   seed: number,
 *   iters: number,
 *   gcFn: () => void
 * }} opts
 * @return {Promise<PerfSnapshot>}
 */
const measurePerfSnapshot = async ({ scale, seed, iters, gcFn }) => {
  const cfg = SCALE_CONFIGS[scale]
  const fixture = buildAndEncodeFixture(cfg, seed, iters)
  // Unwind buildAndEncodeFixture frame and flush master completely before any cold-load measurement
  await yieldAndGc(gcFn)

  /**
   * Measure cold load time (CPU + wall), pre-GC peak heap delta, and true post-GC retained heap delta.
   *
   * @param {'v1' | 'v2'} fmt
   * @param {Uint8Array<ArrayBuffer>} payload
   */
  const measureColdLoad = async (fmt, payload) => {
    // 2 warmups so TurboFan finishes tiering up decoder paths before sample #1
    for (let w = 0; w < 2; w++) {
      warmupColdLoad(fmt, payload)
      await yieldAndGc(gcFn)
    }

    /** @type {Array<number>} */
    const loadCpuSamples = []
    /** @type {Array<number>} */
    const loadWallSamples = []
    /** @type {Array<number>} */
    const peakHeapSamples = []
    /** @type {Array<number>} */
    const retainedHeapSamples = []
    /** @type {Array<number>} */
    const rssSamples = []

    for (let i = 0; i < iters; i++) {
      await yieldAndGc(gcFn)
      const sample = measureSingleColdLoad(
        fmt,
        payload,
        fixture.docStats.charLength,
        fixture.docStats.commentsLength,
        gcFn
      )
      loadCpuSamples.push(sample.cpuMs)
      loadWallSamples.push(sample.wallMs)
      peakHeapSamples.push(sample.peakDelta)
      retainedHeapSamples.push(sample.retainedDelta)
      rssSamples.push(sample.rss)
    }
    await yieldAndGc(gcFn)

    return {
      coldLoadMs: Number(median(loadCpuSamples).toFixed(2)),
      coldLoadWallMs: Number(median(loadWallSamples).toFixed(2)),
      coldLoadPeakHeapBytes: Math.round(median(peakHeapSamples)),
      coldLoadRetainedHeapBytes: Math.round(median(retainedHeapSamples)),
      coldLoadRssBytes: Math.round(median(rssSamples))
    }
  }

  const coldV1 = await measureColdLoad('v1', fixture.fullV1)
  const coldV2 = await measureColdLoad('v2', fixture.fullV2)

  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    env: {
      node: process.version,
      platform: `${os.platform()}-${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      scale,
      seed,
      iters
    },
    docStats: fixture.docStats,
    wire: {
      v1Bytes: fixture.fullV1.byteLength,
      v2Bytes: fixture.fullV2.byteLength,
      v1Sha256: fixture.v1Sha256,
      v2Sha256: fixture.v2Sha256,
      deltaSha256: fixture.deltaSha256
    },
    v1: {
      encodeMs: fixture.v1EncodeMs,
      encodeWallMs: fixture.v1EncodeWallMs,
      ...coldV1
    },
    v2: {
      encodeMs: fixture.v2EncodeMs,
      encodeWallMs: fixture.v2EncodeWallMs,
      ...coldV2
    }
  }
}

/**
 * Evaluate current measurements against a recorded baseline snapshot.
 *
 * @param {PerfSnapshot} baseline
 * @param {PerfSnapshot} current
 * @param {number} maxRegression
 * @return {{ passed: boolean, checks: Array<GateCheck> }}
 */
const evaluateGate = (baseline, current, maxRegression) => {
  /** @type {Array<GateCheck>} */
  const checks = []

  /**
   * @param {string} metric
   * @param {string | number} baseVal
   * @param {string | number} curVal
   * @param {string} [bDisp]
   * @param {string} [cDisp]
   */
  const checkExact = (metric, baseVal, curVal, bDisp, cDisp) => {
    const ok = baseVal === curVal
    checks.push({
      metric,
      kind: 'exact',
      baselineDisplay: bDisp ?? String(baseVal),
      currentDisplay: cDisp ?? String(curVal),
      deltaDisplay: ok ? '0% (exact)' : 'MISMATCH',
      ok
    })
  }

  /**
   * @param {string} metric
   * @param {number} baseVal
   * @param {number} curVal
   * @param {(v: number) => string} fmt
   */
  const checkRegression = (metric, baseVal, curVal, fmt) => {
    const ratio = baseVal > 0 ? (curVal - baseVal) / baseVal : (curVal > 0 ? 1 : 0)
    const ok = ratio <= maxRegression
    checks.push({
      metric,
      kind: 'max-regression',
      baselineDisplay: fmt(baseVal),
      currentDisplay: fmt(curVal),
      deltaDisplay: fmtPct(ratio),
      ok
    })
  }

  // 0% tolerance wire & semantic identity gates
  checkExact('wire.v1Bytes', baseline.wire.v1Bytes, current.wire.v1Bytes, fmtBytes(baseline.wire.v1Bytes), fmtBytes(current.wire.v1Bytes))
  checkExact('wire.v2Bytes', baseline.wire.v2Bytes, current.wire.v2Bytes, fmtBytes(baseline.wire.v2Bytes), fmtBytes(current.wire.v2Bytes))
  checkExact('wire.v1Sha256', baseline.wire.v1Sha256, current.wire.v1Sha256, baseline.wire.v1Sha256.slice(0, 12), current.wire.v1Sha256.slice(0, 12))
  checkExact('wire.v2Sha256', baseline.wire.v2Sha256, current.wire.v2Sha256, baseline.wire.v2Sha256.slice(0, 12), current.wire.v2Sha256.slice(0, 12))
  checkExact('wire.deltaSha256', baseline.wire.deltaSha256, current.wire.deltaSha256, baseline.wire.deltaSha256.slice(0, 12), current.wire.deltaSha256.slice(0, 12))

  // <= maxRegression CPU-time & memory gates (V1 & V2)
  const fmtMs = /** @param {number} v */ v => `${v.toFixed(2)} ms`
  checkRegression('v1.encodeCpuMs', baseline.v1.encodeMs, current.v1.encodeMs, fmtMs)
  checkRegression('v2.encodeCpuMs', baseline.v2.encodeMs, current.v2.encodeMs, fmtMs)
  checkRegression('v1.coldLoadCpuMs', baseline.v1.coldLoadMs, current.v1.coldLoadMs, fmtMs)
  checkRegression('v2.coldLoadCpuMs', baseline.v2.coldLoadMs, current.v2.coldLoadMs, fmtMs)
  checkRegression('v1.coldLoadPeakHeap', baseline.v1.coldLoadPeakHeapBytes, current.v1.coldLoadPeakHeapBytes, fmtBytes)
  checkRegression('v2.coldLoadPeakHeap', baseline.v2.coldLoadPeakHeapBytes, current.v2.coldLoadPeakHeapBytes, fmtBytes)
  checkRegression('v1.coldLoadRetainedHeap', baseline.v1.coldLoadRetainedHeapBytes, current.v1.coldLoadRetainedHeapBytes, fmtBytes)
  checkRegression('v2.coldLoadRetainedHeap', baseline.v2.coldLoadRetainedHeapBytes, current.v2.coldLoadRetainedHeapBytes, fmtBytes)

  const passed = checks.every(c => c.ok)
  return { passed, checks }
}

/**
 * Print human-readable perf gate report table.
 *
 * @param {PerfSnapshot} current
 * @param {Array<GateCheck> | null} checks
 * @param {number} maxRegression
 * @param {string} baselinePath
 * @param {boolean} recorded
 */
const printGateReport = (current, checks, maxRegression, baselinePath, recorded) => {
  console.log('=== Yjs v14 Automated Perf & Memory Regression Gate (D-012) ===')
  console.log(
    `env: Node ${current.env.node} | ${current.env.platform} | scale=${current.env.scale} ` +
    `(~${current.docStats.estimatedPages}p, ${current.docStats.charLength.toLocaleString()} chars, ${current.docStats.totalStructs.toLocaleString()} structs) | ` +
    `seed=${current.env.seed} | median-of-${current.env.iters}`
  )
  console.log(
    `info: buildMs=${current.docStats.buildMs}ms | ` +
    `V1 RSS=${fmtBytes(current.v1.coldLoadRssBytes)} | V2 RSS=${fmtBytes(current.v2.coldLoadRssBytes)} | ` +
    `maxRegression=${(maxRegression * 100).toFixed(1)}%`
  )
  console.log('')

  if (recorded) {
    console.log(`Recorded baseline -> ${baselinePath}`)
    console.log(`  wire.v1Bytes             : ${fmtBytes(current.wire.v1Bytes)} (${current.wire.v1Bytes} B)  sha256=${current.wire.v1Sha256.slice(0, 16)}`)
    console.log(`  wire.v2Bytes             : ${fmtBytes(current.wire.v2Bytes)} (${current.wire.v2Bytes} B)  sha256=${current.wire.v2Sha256.slice(0, 16)}`)
    console.log(`  wire.deltaSha256         : ${current.wire.deltaSha256.slice(0, 16)}`)
    console.log(`  v1.encodeCpuMs           : ${current.v1.encodeMs.toFixed(2)} ms (wall=${current.v1.encodeWallMs.toFixed(2)} ms)`)
    console.log(`  v2.encodeCpuMs           : ${current.v2.encodeMs.toFixed(2)} ms (wall=${current.v2.encodeWallMs.toFixed(2)} ms)`)
    console.log(`  v1.coldLoadCpuMs         : ${current.v1.coldLoadMs.toFixed(2)} ms (wall=${current.v1.coldLoadWallMs.toFixed(2)} ms)`)
    console.log(`  v2.coldLoadCpuMs         : ${current.v2.coldLoadMs.toFixed(2)} ms (wall=${current.v2.coldLoadWallMs.toFixed(2)} ms)`)
    console.log(`  v1.coldLoadPeakHeap      : ${fmtBytes(current.v1.coldLoadPeakHeapBytes)} (${current.v1.coldLoadPeakHeapBytes.toLocaleString()} B)`)
    console.log(`  v2.coldLoadPeakHeap      : ${fmtBytes(current.v2.coldLoadPeakHeapBytes)} (${current.v2.coldLoadPeakHeapBytes.toLocaleString()} B)`)
    console.log(`  v1.coldLoadRetainedHeap  : ${fmtBytes(current.v1.coldLoadRetainedHeapBytes)} (${current.v1.coldLoadRetainedHeapBytes.toLocaleString()} B)`)
    console.log(`  v2.coldLoadRetainedHeap  : ${fmtBytes(current.v2.coldLoadRetainedHeapBytes)} (${current.v2.coldLoadRetainedHeapBytes.toLocaleString()} B)`)
    return
  }

  if (checks === null) return
  const hdr = `${'Metric'.padEnd(25)} | ${'Baseline'.padStart(14)} | ${'Current'.padStart(14)} | ${'Delta'.padStart(12)} | Status`
  console.log(hdr)
  console.log('-'.repeat(hdr.length + 4))
  let failCount = 0
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]
    if (!c.ok) failCount++
    const status = c.ok ? 'PASS' : 'FAIL'
    console.log(
      `${c.metric.padEnd(25)} | ${c.baselineDisplay.padStart(14)} | ${c.currentDisplay.padStart(14)} | ${c.deltaDisplay.padStart(12)} | ${status}`
    )
  }
  console.log('')
  console.log(`=== Perf Gate Result: ${failCount === 0 ? 'PASS' : 'FAIL'} (${checks.length - failCount}/${checks.length} checks passed) ===`)
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  /** @type {BenchScale} */
  let scale = 'realistic'
  let seed = DEFAULT_SEED
  let iters = 5
  let maxRegression = 0.05
  let baselinePath = DEFAULT_BASELINE_PATH
  let record = false
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
    } else if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
      if (!Number.isFinite(seed)) {
        console.error('Invalid --seed (expected integer)')
        process.exit(2)
      }
    } else if (arg === '--iters' && i + 1 < argv.length) {
      iters = Number.parseInt(argv[++i], 10)
      if (!Number.isFinite(iters) || iters < 1) {
        console.error('Invalid --iters (expected positive integer)')
        process.exit(2)
      }
    } else if (arg === '--max-regression' && i + 1 < argv.length) {
      maxRegression = Number.parseFloat(argv[++i])
      if (!Number.isFinite(maxRegression) || maxRegression < 0) {
        console.error('Invalid --max-regression (expected non-negative decimal, e.g. 0.05)')
        process.exit(2)
      }
    } else if (arg === '--baseline' && i + 1 < argv.length) {
      baselinePath = resolve(argv[++i])
    } else if (arg === '--record') {
      record = true
    } else if (arg === '--json') {
      jsonOnly = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node --expose-gc ./benchmarks/lab/perf-gate.js [--scale realistic|quick] [--seed N] [--iters 5] [--max-regression 0.05] [--baseline path] [--record] [--json]')
      process.exit(0)
    }
  }
  return { scale, seed, iters, maxRegression, baselinePath, record, jsonOnly }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const maybeGc = /** @type {{ gc?: () => void }} */ (globalThis).gc
  if (typeof maybeGc !== 'function') {
    console.error('ERROR: perf-gate.js requires --expose-gc for accurate retained heap measurement.')
    console.error('Run: node --expose-gc ./benchmarks/lab/perf-gate.js')
    process.exit(2)
  }

  const current = await measurePerfSnapshot({
    scale: args.scale,
    seed: args.seed,
    iters: args.iters,
    gcFn: maybeGc
  })

  if (args.record) {
    writeFileSync(args.baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    if (args.jsonOnly) {
      console.log(JSON.stringify({ recorded: true, baselinePath: args.baselinePath, current }, null, 2))
    } else {
      printGateReport(current, null, args.maxRegression, args.baselinePath, true)
    }
    process.exit(0)
  }

  if (!existsSync(args.baselinePath)) {
    console.error(`ERROR: Baseline file not found: ${args.baselinePath}`)
    console.error('Record a baseline first with: node --expose-gc ./benchmarks/lab/perf-gate.js --record')
    process.exit(2)
  }

  /** @type {PerfSnapshot} */
  const baseline = JSON.parse(readFileSync(args.baselinePath, 'utf8'))
  if (baseline.env.scale !== current.env.scale || baseline.env.seed !== current.env.seed) {
    console.error(
      `ERROR: Baseline mismatch (baseline scale=${baseline.env.scale}/seed=${baseline.env.seed} vs current scale=${current.env.scale}/seed=${current.env.seed})`
    )
    process.exit(2)
  }

  const gate = evaluateGate(baseline, current, args.maxRegression)
  if (args.jsonOnly) {
    console.log(JSON.stringify({ passed: gate.passed, maxRegression: args.maxRegression, baselinePath: args.baselinePath, checks: gate.checks, current }, null, 2))
  } else {
    printGateReport(current, gate.checks, args.maxRegression, args.baselinePath, false)
  }
  if (!gate.passed) {
    process.exit(1)
  }
}

if (isMain) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
