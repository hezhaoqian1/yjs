import os from 'node:os'
import { createHash } from 'node:crypto'
import * as Y from '../../src/index.js'
import * as prng from 'lib0/prng'
import * as math from 'lib0/math'

const DEFAULT_SEED = 20261001
const CHARS_PER_PAGE = 2300

/**
 * @typedef {'quick' | 'realistic'} BenchScale
 */

/**
 * @typedef {{
 *   scale: BenchScale,
 *   authors: number,
 *   textOps: number,
 *   seedAnnotationOps: number,
 *   liveRandomEdits: number,
 *   liveAnnotationPushes: number,
 *   encodeIters: number,
 *   loadIters: number,
 *   deltaIters: number,
 *   fanoutSamplePeers: number
 * }} ScaleConfig
 */

/** @type {Record<BenchScale, ScaleConfig>} */
const SCALE_CONFIGS = {
  quick: {
    scale: 'quick',
    authors: 8,
    textOps: 2500,
    seedAnnotationOps: 400,
    liveRandomEdits: 250,
    liveAnnotationPushes: 1000,
    encodeIters: 5,
    loadIters: 3,
    deltaIters: 3,
    fanoutSamplePeers: 4
  },
  realistic: {
    scale: 'realistic',
    authors: 14,
    textOps: 26000,
    seedAnnotationOps: 2800,
    liveRandomEdits: 1000,
    liveAnnotationPushes: 5000,
    encodeIters: 5,
    loadIters: 3,
    deltaIters: 3,
    fanoutSamplePeers: 7
  }
}

/**
 * Realistic prose fragments (~12-20 chars avg) so 26k collaborative edits with ~72% inserts / ~14% deletes
 * naturally converge to ~225k-255k characters (~100 pages of formatted multi-author prose).
 */
const PROSE_FRAGMENTS = [
  'The distributed ',
  'architecture ',
  'guarantees strong ',
  'eventual ',
  'convergence ',
  'across offline ',
  'collaborators. ',
  'Formatting runs ',
  'merge cleanly ',
  'without losing ',
  'inline links or ',
  'section styles. ',
  'Incremental ',
  'binary updates ',
  'compress state ',
  'vectors compactly ',
  'while preserving ',
  'causal history. ',
  'Reviewers noted ',
  'latency budgets ',
  'must remain low ',
  'for large specs. ',
  'Paragraph edits ',
  'interleave smoothly '
]

const SECTION_TITLES = [
  'Executive Summary',
  'System Architecture',
  'CRDT Convergence Guarantees',
  'Binary Wire Protocol V1 & V2',
  'Rich-Text Formatting Semantics',
  'Attribution & Diff Renderers',
  'Subdocument Lifecycle',
  'Undo/Redo & Garbage Collection',
  'Offline Sync & Partitions',
  'Security & Malformed Input Hardening',
  'Performance & Memory Budgets',
  'Client Indexing & Search Markers',
  'Operational Telemetry',
  'Release & Migration Checklist'
]

/**
 * @typedef {Record<string, string | number | boolean | Record<string, string | number | boolean> | null>} RichFormat
 */

/** @type {Array<RichFormat>} */
const INLINE_MARKS = [
  { bold: true },
  { bold: null },
  { italic: true },
  { italic: null },
  { code: true },
  { code: null },
  { link: { href: 'https://yjs.dev/docs', target: '_blank' } },
  { link: { href: 'https://example.org/spec', target: '_self' } },
  { link: null },
  { bold: true, italic: true },
  { bold: null, italic: null, link: null }
]

/** @type {Array<RichFormat>} */
const HEADING_MARKS = [
  { heading: 1 },
  { heading: 2 },
  { heading: null }
]

/**
 * Compute SHA-256 hex digest of bytes or UTF-8 string.
 *
 * @param {Uint8Array | string} data
 * @return {string}
 */
const sha256Hex = data => createHash('sha256').update(data).digest('hex')

/**
 * Compute percentile from an ascending sorted numeric array.
 *
 * @param {Array<number>} sorted
 * @param {number} p
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
 * Summarize timing array into mean, p50, p95, min, max (ms).
 *
 * @param {Array<number>} samples
 */
const summarizeMs = samples => {
  const sorted = samples.slice().sort((a, b) => a - b)
  const sum = samples.reduce((acc, v) => acc + v, 0)
  return {
    meanMs: Number((sum / samples.length).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2))
  }
}

/**
 * Trigger V8 GC if exposed (--expose-gc).
 */
const tryRunGc = () => {
  const maybeGc = /** @type {{ gc?: () => void }} */ (globalThis).gc
  if (typeof maybeGc === 'function') {
    maybeGc()
  }
}

/**
 * Collect detailed StructStore breakdown (total structs, alive items, deleted items, GC structs, clients).
 *
 * @param {Y.Doc} doc
 */
const inspectStructStore = doc => {
  let totalStructs = 0
  let aliveItems = 0
  let deletedItems = 0
  let gcStructs = 0
  let skipStructs = 0
  doc.store.clients.forEach(structs => {
    totalStructs += structs.length
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i]
      if (s instanceof Y.GC) {
        gcStructs++
      } else if (s instanceof Y.Skip) {
        skipStructs++
      } else if (s instanceof Y.Item) {
        if (s.deleted) deletedItems++
        else aliveItems++
      }
    }
  })
  const aliveRatio = totalStructs > 0 ? aliveItems / totalStructs : 1
  return {
    uniqueClients: doc.store.clients.size,
    totalStructs,
    aliveItems,
    deletedItems,
    gcStructs,
    skipStructs,
    aliveRatio: Number(aliveRatio.toFixed(4))
  }
}

/**
 * Shift all author cursor indices after an insertion at `pos` of length `deltaLen`.
 *
 * @param {Array<number>} cursors
 * @param {number} pos
 * @param {number} deltaLen
 */
const shiftCursorsOnInsert = (cursors, pos, deltaLen) => {
  for (let i = 0; i < cursors.length; i++) {
    if (cursors[i] >= pos) cursors[i] += deltaLen
  }
}

/**
 * Shift all author cursor indices after deleting `[pos, pos + delLen)`.
 *
 * @param {Array<number>} cursors
 * @param {number} pos
 * @param {number} delLen
 */
const shiftCursorsOnDelete = (cursors, pos, delLen) => {
  for (let i = 0; i < cursors.length; i++) {
    if (cursors[i] > pos) {
      cursors[i] = math.max(pos, cursors[i] - delLen)
    }
  }
}

/**
 * Build a realistic multi-author collaborative long document (10 pages quick / ~100 pages realistic)
 * with 8-14 authors (`clientID = 101..114`), headings, inline marks (including object-valued links),
 * localized paragraph editing + cross-section revisions, and a comments/annotations array.
 *
 * Also captures a 95%-progress checkpoint (`update95V1`) for realistic returning-peer catch-up sync.
 *
 * @param {ScaleConfig} cfg
 * @param {number} seed
 */
const buildLongCollaborativeDoc = (cfg, seed) => {
  const gen = prng.create(seed)
  const master = new Y.Doc({ gc: true })
  const ytext = master.get('text')
  const comments = master.get('comments')

  const t0 = performance.now()
  /** @type {Array<number>} */
  const cursors = []

  // Seed one initial section heading + opening sentence per author so all authors start evenly spread
  for (let a = 0; a < cfg.authors; a++) {
    master.clientID = 101 + a
    const title = SECTION_TITLES[a % SECTION_TITLES.length]
    const headingLine = `${a + 1}. ${title}`
    const startIdx = ytext.length
    ytext.insert(startIdx, headingLine, { bold: true })
    ytext.insert(ytext.length, '\n', { heading: a % 2 === 0 ? 1 : 2 })
    ytext.insert(ytext.length, `Section ${a + 1} collaborative draft initialized by author ${a + 1}. `)
    cursors.push(ytext.length)
  }

  const checkpointOp = math.floor(cfg.textOps * 0.95)
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let update95V1 = null
  let annotationCount = 0
  const commentInterval = math.max(1, math.floor(cfg.textOps / cfg.seedAnnotationOps))

  for (let step = 0; step < cfg.textOps; step++) {
    const authorIdx = prng.uint32(gen, 0, cfg.authors - 1)
    master.clientID = 101 + authorIdx

    // 8% of edits simulate reviewing/editing another author's section; 92% stay near author's active cursor
    const targetCursorIdx = prng.real53(gen) < 0.08
      ? prng.uint32(gen, 0, cfg.authors - 1)
      : authorIdx

    const docLen = ytext.length
    const jitter = prng.uint32(gen, 0, 80) - 40
    const pos = math.min(docLen, math.max(0, cursors[targetCursorIdx] + jitter))
    const roll = prng.real53(gen)

    if (docLen === 0 || roll < 0.70) {
      // Formatted or plain prose fragment insert
      const frag = prng.oneOf(gen, PROSE_FRAGMENTS)
      if (prng.real53(gen) < 0.35) {
        ytext.insert(pos, frag, prng.oneOf(gen, INLINE_MARKS))
      } else {
        ytext.insert(pos, frag)
      }
      shiftCursorsOnInsert(cursors, pos, frag.length)
      if (targetCursorIdx === authorIdx) {
        cursors[authorIdx] = math.min(ytext.length, pos + frag.length)
      }
    } else if (roll < 0.74) {
      // Paragraph break or sub-heading boundary
      const headingFmt = prng.oneOf(gen, HEADING_MARKS)
      ytext.insert(pos, '\n', headingFmt)
      shiftCursorsOnInsert(cursors, pos, 1)
      if (targetCursorIdx === authorIdx) {
        cursors[authorIdx] = math.min(ytext.length, pos + 1)
      }
    } else if (roll < 0.87 && docLen > 12) {
      // Inline format / link / mark toggle on nearby words
      const fPos = math.min(pos, docLen - 1)
      const fSpan = math.min(prng.uint32(gen, 4, 24), docLen - fPos)
      ytext.format(fPos, fSpan, prng.oneOf(gen, INLINE_MARKS))
    } else if (docLen > 20) {
      // Realistic backspace / phrase revision delete
      const dPos = math.min(pos, docLen - 1)
      const dSpan = math.min(prng.uint32(gen, 2, 12), docLen - dPos)
      ytext.delete(dPos, dSpan)
      shiftCursorsOnDelete(cursors, dPos, dSpan)
    }

    // Interleave periodic review comments/annotations across the 14 authors
    if (annotationCount < cfg.seedAnnotationOps && step % commentInterval === 0) {
      const pageNum = math.floor(pos / CHARS_PER_PAGE) + 1
      comments.push([{
        id: `c-${annotationCount}`,
        author: `editor-${authorIdx + 1}`,
        page: pageNum,
        resolved: annotationCount % 5 === 0,
        ts: 1700000000000 + step * 1000,
        body: `Review note #${annotationCount} on page ${pageNum}`
      }])
      annotationCount++
    }

    if (step === checkpointOp) {
      update95V1 = Y.encodeStateAsUpdate(master)
    }
  }

  if (update95V1 === null) {
    update95V1 = Y.encodeStateAsUpdate(master)
  }

  const buildMs = Number((performance.now() - t0).toFixed(2))
  return {
    master,
    update95V1,
    buildMs,
    textOps: cfg.textOps,
    annotationOps: annotationCount
  }
}

/**
 * Execute the full D-008 realistic long-doc collaborative benchmark suite.
 *
 * @param {ScaleConfig} cfg
 * @param {number} seed
 */
const runLongDocBenchmark = (cfg, seed) => {
  const { master, update95V1, buildMs, textOps, annotationOps } = buildLongCollaborativeDoc(cfg, seed)

  try {
    const masterText = master.get('text')
    const masterComments = master.get('comments')
    const charLength = masterText.length
    const commentsLength = masterComments.length
    const estimatedPages = Number((charLength / CHARS_PER_PAGE).toFixed(1))
    const storeStats = inspectStructStore(master)

    // 1. Encode Latency (V1 & V2) + Wire Sizes & SHA-256 Fingerprints
    /** @type {Uint8Array<ArrayBuffer>} */
    let fullV1 = Y.encodeStateAsUpdate(master) // warmup
    /** @type {Uint8Array<ArrayBuffer>} */
    let fullV2 = Y.encodeStateAsUpdateV2(master) // warmup

    /** @type {Array<number>} */
    const encV1Samples = []
    for (let i = 0; i < cfg.encodeIters; i++) {
      const t0 = performance.now()
      fullV1 = Y.encodeStateAsUpdate(master)
      encV1Samples.push(performance.now() - t0)
    }
    /** @type {Array<number>} */
    const encV2Samples = []
    for (let i = 0; i < cfg.encodeIters; i++) {
      const t0 = performance.now()
      fullV2 = Y.encodeStateAsUpdateV2(master)
      encV2Samples.push(performance.now() - t0)
    }

    const v1Sha256 = sha256Hex(fullV1)
    const v2Sha256 = sha256Hex(fullV2)
    const initialMasterDelta = masterText.toDeltaDeep()
    const deltaSha256 = sha256Hex(JSON.stringify(initialMasterDelta.toJSON()))

    // 2. Cold Binary Load Time & Heap Memory (V1 & V2) + Initial toDeltaDeep() Render
    /** @type {Array<number>} */
    const loadV1Samples = []
    /** @type {Array<number>} */
    const loadV1Heaps = []
    let loadV1RssMB = 0
    for (let i = 0; i < cfg.loadIters; i++) {
      tryRunGc()
      const heapBefore = process.memoryUsage().heapUsed
      const doc = new Y.Doc({ gc: true })
      try {
        const t0 = performance.now()
        Y.applyUpdate(doc, fullV1)
        const elapsed = performance.now() - t0
        const memAfter = process.memoryUsage()
        if (doc.get('text').length !== charLength) {
          throw new Error(`Cold V1 load length mismatch (${doc.get('text').length} !== ${charLength})`)
        }
        loadV1Samples.push(elapsed)
        loadV1Heaps.push((memAfter.heapUsed - heapBefore) / (1024 * 1024))
        loadV1RssMB = memAfter.rss / (1024 * 1024)
      } finally {
        doc.destroy()
      }
    }

    /** @type {Array<number>} */
    const loadV2Samples = []
    /** @type {Array<number>} */
    const loadV2Heaps = []
    let loadV2RssMB = 0
    /** @type {Array<number>} */
    const renderDeltaSamples = []
    let deltaOpsCount = 0
    for (let i = 0; i < cfg.loadIters; i++) {
      tryRunGc()
      const heapBefore = process.memoryUsage().heapUsed
      const doc = new Y.Doc({ gc: true })
      try {
        const t0 = performance.now()
        Y.applyUpdateV2(doc, fullV2)
        const elapsed = performance.now() - t0
        const memAfter = process.memoryUsage()
        const loadedText = doc.get('text')
        if (loadedText.length !== charLength) {
          throw new Error(`Cold V2 load length mismatch (${loadedText.length} !== ${charLength})`)
        }
        loadV2Samples.push(elapsed)
        loadV2Heaps.push((memAfter.heapUsed - heapBefore) / (1024 * 1024))
        loadV2RssMB = memAfter.rss / (1024 * 1024)

        // Measure initial toDeltaDeep() right on freshly loaded doc
        for (let di = 0; di < cfg.deltaIters; di++) {
          const dt0 = performance.now()
          const d = loadedText.toDeltaDeep()
          const dt = performance.now() - dt0
          if (i === 0 && di === 0) {
            let opsCnt = 0
            for (const op of d.children) {
              if (op !== null) opsCnt++
            }
            deltaOpsCount = opsCnt
          }
          if (di > 0 || i > 0) {
            renderDeltaSamples.push(dt)
          }
        }
      } finally {
        doc.destroy()
      }
    }

    // 3. Returning 95%-Synced Peer Catch-Up Sync (V1 & V2: encodeSV + diffEncode + apply)
    const measureCatchUp = /** @param {'v1' | 'v2'} fmt */ fmt => {
      const peer95 = new Y.Doc({ gc: true })
      try {
        Y.applyUpdate(peer95, update95V1)
        const tSv0 = performance.now()
        const sv = Y.encodeStateVector(peer95)
        const encodeSVMs = performance.now() - tSv0

        const tDiff0 = performance.now()
        const diffUpdate = fmt === 'v1'
          ? Y.encodeStateAsUpdate(master, sv)
          : Y.encodeStateAsUpdateV2(master, sv)
        const encodeDiffMs = performance.now() - tDiff0

        const tApply0 = performance.now()
        if (fmt === 'v1') {
          Y.applyUpdate(peer95, diffUpdate)
        } else {
          Y.applyUpdateV2(peer95, diffUpdate)
        }
        const applyDiffMs = performance.now() - tApply0

        if (peer95.get('text').length !== charLength || peer95.get('comments').length !== commentsLength) {
          throw new Error(`Catch-up sync (${fmt}) diverged: text=${peer95.get('text').length}/${charLength}`)
        }
        return {
          encodeSVMs: Number(encodeSVMs.toFixed(2)),
          encodeDiffMs: Number(encodeDiffMs.toFixed(2)),
          applyDiffMs: Number(applyDiffMs.toFixed(2)),
          totalMs: Number((encodeSVMs + encodeDiffMs + applyDiffMs).toFixed(2)),
          diffBytes: diffUpdate.byteLength,
          diffKB: Number((diffUpdate.byteLength / 1024).toFixed(1))
        }
      } finally {
        peer95.destroy()
      }
    }
    const catchupV1 = measureCatchUp('v1')
    const catchupV2 = measureCatchUp('v2')

    // 4. Live Collaborative Editing by Joining 15th Editor (clientID = 115) inside the Loaded 100-Page Doc!
    //    4a: live_random_formatted_edits (directly measures random-access text edit / _searchMarker O(N^2)!)
    //    4b: live_annotation_pushes (directly measures ContentAny.mergeWith O(N^2)!)
    /** @type {Uint8Array<ArrayBuffer>} */
    let liveIncV1 = new Uint8Array(new ArrayBuffer(0))
    /** @type {Uint8Array<ArrayBuffer>} */
    let liveIncV2 = new Uint8Array(new ArrayBuffer(0))
    let liveEditedTextLen = 0
    let liveEditedCommentsLen = 0
    let liveEditsMs = 0
    let liveEditsHeapMB = 0
    let livePushesMs = 0
    let livePushesHeapMB = 0

    const editor15 = new Y.Doc({ gc: true })
    editor15.clientID = 115
    try {
      Y.applyUpdateV2(editor15, fullV2)
      const svBeforeLive = Y.encodeStateVector(editor15)
      const liveText = editor15.get('text')
      const liveComments = editor15.get('comments')
      const editGen = prng.create(seed + 77777)

      // 4a. Random-position formatted edits across the entire 100-page document
      tryRunGc()
      const editHeapBefore = process.memoryUsage().heapUsed
      const editT0 = performance.now()
      for (let i = 0; i < cfg.liveRandomEdits; i++) {
        const len = liveText.length
        const pos = len > 0 ? prng.uint32(editGen, 0, len - 1) : 0
        const mode = i % 10
        if (mode < 5) {
          const frag = prng.oneOf(editGen, PROSE_FRAGMENTS)
          liveText.insert(pos, frag, prng.oneOf(editGen, INLINE_MARKS))
        } else if (mode < 8 && len > 8) {
          const span = math.min(prng.uint32(editGen, 3, 18), len - pos)
          liveText.format(pos, span, prng.oneOf(editGen, INLINE_MARKS))
        } else if (len > 8) {
          const span = math.min(prng.uint32(editGen, 2, 10), len - pos)
          liveText.delete(pos, span)
        }
      }
      liveEditsMs = performance.now() - editT0
      liveEditsHeapMB = (process.memoryUsage().heapUsed - editHeapBefore) / (1024 * 1024)

      // 4b. Sequential annotation/comment pushes (stresses ContentAny.mergeWith O(N^2)!)
      tryRunGc()
      const pushHeapBefore = process.memoryUsage().heapUsed
      const pushT0 = performance.now()
      for (let i = 0; i < cfg.liveAnnotationPushes; i++) {
        liveComments.push([{
          id: `live-${i}`,
          author: 'editor-15',
          page: (i % math.max(1, Math.floor(estimatedPages))) + 1,
          resolved: false,
          ts: 1700500000000 + i * 1000,
          body: `Live review annotation #${i}`
        }])
      }
      livePushesMs = performance.now() - pushT0
      livePushesHeapMB = (process.memoryUsage().heapUsed - pushHeapBefore) / (1024 * 1024)

      liveEditedTextLen = liveText.length
      liveEditedCommentsLen = liveComments.length
      liveIncV1 = Y.encodeStateAsUpdate(editor15, svBeforeLive)
      liveIncV2 = Y.encodeStateAsUpdateV2(editor15, svBeforeLive)
    } finally {
      editor15.destroy()
    }

    // 5. Incremental Sync Fanout of Editor #15's Live Edits Back to Existing 14 Peers (V1 & V2)
    //    Measured cleanly one peer doc at a time to stay well within D-001 RAM limits!
    const measureFanout = /** @param {'v1' | 'v2'} fmt */ fmt => {
      /** @type {Array<number>} */
      const samples = []
      const inc = fmt === 'v1' ? liveIncV1 : liveIncV2
      for (let i = 0; i < cfg.fanoutSamplePeers; i++) {
        const peerDoc = new Y.Doc({ gc: true })
        try {
          Y.applyUpdateV2(peerDoc, fullV2)
          const t0 = performance.now()
          if (fmt === 'v1') {
            Y.applyUpdate(peerDoc, inc)
          } else {
            Y.applyUpdateV2(peerDoc, inc)
          }
          samples.push(performance.now() - t0)
          if (peerDoc.get('text').length !== liveEditedTextLen || peerDoc.get('comments').length !== liveEditedCommentsLen) {
            throw new Error(`Incremental fanout (${fmt}) diverged on peer #${i}`)
          }
        } finally {
          peerDoc.destroy()
        }
      }
      const stats = summarizeMs(samples)
      return {
        perPeerMeanMs: stats.meanMs,
        perPeerP95Ms: stats.p95Ms,
        estimatedAllPeersMs: Number((stats.meanMs * cfg.authors).toFixed(2)),
        updateBytes: inc.byteLength,
        updateKB: Number((inc.byteLength / 1024).toFixed(1))
      }
    }
    const fanoutV1 = measureFanout('v1')
    const fanoutV2 = measureFanout('v2')

    const v1LoadSummary = summarizeMs(loadV1Samples)
    const v2LoadSummary = summarizeMs(loadV2Samples)
    const renderSummary = summarizeMs(renderDeltaSamples.length > 0 ? renderDeltaSamples : [0])
    const encV1Summary = summarizeMs(encV1Samples)
    const encV2Summary = summarizeMs(encV2Samples)

    return {
      env: {
        node: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        scale: cfg.scale,
        seed
      },
      docStats: {
        authors: cfg.authors,
        charLength,
        estimatedPages,
        textOps,
        annotationOps,
        commentsLength,
        buildMs,
        ...storeStats,
        v1Bytes: fullV1.byteLength,
        v1KB: Number((fullV1.byteLength / 1024).toFixed(1)),
        v1MB: Number((fullV1.byteLength / (1024 * 1024)).toFixed(3)),
        v2Bytes: fullV2.byteLength,
        v2KB: Number((fullV2.byteLength / 1024).toFixed(1)),
        v2MB: Number((fullV2.byteLength / (1024 * 1024)).toFixed(3)),
        v2ToV1Ratio: Number((fullV2.byteLength / math.max(1, fullV1.byteLength)).toFixed(3))
      },
      encode: {
        v1: encV1Summary,
        v2: encV2Summary
      },
      coldLoad: {
        v1: {
          ...v1LoadSummary,
          heapDeltaMB: Number(percentile(loadV1Heaps.slice().sort((a, b) => a - b), 0.5).toFixed(2)),
          rssMB: Number(loadV1RssMB.toFixed(1))
        },
        v2: {
          ...v2LoadSummary,
          heapDeltaMB: Number(percentile(loadV2Heaps.slice().sort((a, b) => a - b), 0.5).toFixed(2)),
          rssMB: Number(loadV2RssMB.toFixed(1))
        },
        initialToDeltaDeep: {
          ...renderSummary,
          deltaOpsCount
        }
      },
      peerSync: {
        catchup95V1: catchupV1,
        catchup95V2: catchupV2,
        fanoutAllPeersV1: fanoutV1,
        fanoutAllPeersV2: fanoutV2
      },
      liveEditing: {
        randomFormattedEdits: {
          ops: cfg.liveRandomEdits,
          totalMs: Number(liveEditsMs.toFixed(2)),
          msPerOp: Number((liveEditsMs / math.max(1, cfg.liveRandomEdits)).toFixed(3)),
          opsPerSec: Math.round(cfg.liveRandomEdits / math.max(0.0001, liveEditsMs / 1000)),
          heapDeltaMB: Number(liveEditsHeapMB.toFixed(2))
        },
        annotationPushes: {
          ops: cfg.liveAnnotationPushes,
          totalMs: Number(livePushesMs.toFixed(2)),
          opsPerSec: Math.round(cfg.liveAnnotationPushes / math.max(0.0001, livePushesMs / 1000)),
          heapDeltaMB: Number(livePushesHeapMB.toFixed(2)),
          finalCommentsLength: liveEditedCommentsLen
        }
      },
      fingerprints: {
        v1Sha256,
        v2Sha256,
        deltaSha256
      }
    }
  } finally {
    master.destroy()
  }
}

/**
 * Print a clean human-readable report table + JSON summary.
 *
 * @param {ReturnType<typeof runLongDocBenchmark>} res
 */
const printReport = res => {
  const { env, docStats, encode, coldLoad, peerSync, liveEditing, fingerprints } = res
  console.log('=== Yjs v14 Realistic Collaborative Long-Doc Benchmark (D-008) ===')
  console.log(`env: Node ${env.node} | ${env.platform} | scale=${env.scale} | seed=${env.seed}`)
  console.log('')

  console.log('1. Document Stats')
  console.log(`   Authors / Clients : ${docStats.authors} editors (${docStats.uniqueClients} clients in StructStore)`)
  console.log(`   Document Size     : ${docStats.charLength.toLocaleString()} chars (~${docStats.estimatedPages} pages @ ${CHARS_PER_PAGE} chars/page)`)
  console.log(`   Build Workload    : ${docStats.textOps.toLocaleString()} formatted text ops + ${docStats.annotationOps.toLocaleString()} comments in ${docStats.buildMs}ms`)
  console.log(`   StructStore       : ${docStats.totalStructs.toLocaleString()} structs (alive=${docStats.aliveItems.toLocaleString()}, deleted=${docStats.deletedItems.toLocaleString()}, gc=${docStats.gcStructs.toLocaleString()}, aliveRatio=${(docStats.aliveRatio * 100).toFixed(1)}%)`)
  console.log(`   Binary Wire Size  : V1=${docStats.v1KB} KB (${docStats.v1MB} MB) | V2=${docStats.v2KB} KB (${docStats.v2MB} MB) | V2/V1=${docStats.v2ToV1Ratio}x`)
  console.log('')

  console.log('2. Full-Doc Encode Latency')
  console.log(`   encodeStateAsUpdate   (V1) : mean=${encode.v1.meanMs}ms  p50=${encode.v1.p50Ms}ms  p95=${encode.v1.p95Ms}ms`)
  console.log(`   encodeStateAsUpdateV2 (V2) : mean=${encode.v2.meanMs}ms  p50=${encode.v2.p50Ms}ms  p95=${encode.v2.p95Ms}ms`)
  console.log('')

  console.log('3. Cold Binary Load, Memory & Initial Render')
  console.log(`   Cold applyUpdate   (V1)    : mean=${coldLoad.v1.meanMs}ms  p50=${coldLoad.v1.p50Ms}ms  p95=${coldLoad.v1.p95Ms}ms | heapDelta=${coldLoad.v1.heapDeltaMB} MB | rss=${coldLoad.v1.rssMB} MB`)
  console.log(`   Cold applyUpdateV2 (V2)    : mean=${coldLoad.v2.meanMs}ms  p50=${coldLoad.v2.p50Ms}ms  p95=${coldLoad.v2.p95Ms}ms | heapDelta=${coldLoad.v2.heapDeltaMB} MB | rss=${coldLoad.v2.rssMB} MB`)
  console.log(`   Initial toDeltaDeep()      : mean=${coldLoad.initialToDeltaDeep.meanMs}ms  p50=${coldLoad.initialToDeltaDeep.p50Ms}ms  p95=${coldLoad.initialToDeltaDeep.p95Ms}ms (${coldLoad.initialToDeltaDeep.deltaOpsCount} delta ops)`)
  console.log('')

  console.log('4. Peer Join, 95%-Synced Catch-Up & Live Collaborative Editing (Editor #15)')
  console.log(`   95% Catch-Up Sync (V1)     : total=${peerSync.catchup95V1.totalMs}ms (sv=${peerSync.catchup95V1.encodeSVMs}ms, diff=${peerSync.catchup95V1.encodeDiffMs}ms, apply=${peerSync.catchup95V1.applyDiffMs}ms, ${peerSync.catchup95V1.diffKB} KB)`)
  console.log(`   95% Catch-Up Sync (V2)     : total=${peerSync.catchup95V2.totalMs}ms (sv=${peerSync.catchup95V2.encodeSVMs}ms, diff=${peerSync.catchup95V2.encodeDiffMs}ms, apply=${peerSync.catchup95V2.applyDiffMs}ms, ${peerSync.catchup95V2.diffKB} KB)`)
  console.log(`   Live Random Formatted Edits: ${liveEditing.randomFormattedEdits.ops} ops in ${liveEditing.randomFormattedEdits.totalMs}ms (${liveEditing.randomFormattedEdits.msPerOp}ms/op, ${liveEditing.randomFormattedEdits.opsPerSec.toLocaleString()} ops/s, heapDelta=${liveEditing.randomFormattedEdits.heapDeltaMB} MB)`)
  console.log(`   Live Annotation Pushes     : ${liveEditing.annotationPushes.ops} pushes in ${liveEditing.annotationPushes.totalMs}ms (${liveEditing.annotationPushes.opsPerSec.toLocaleString()} ops/s, heapDelta=${liveEditing.annotationPushes.heapDeltaMB} MB)`)
  console.log(`   Incremental Fanout V1 (${docStats.authors}p): perPeer=${peerSync.fanoutAllPeersV1.perPeerMeanMs}ms (p95=${peerSync.fanoutAllPeersV1.perPeerP95Ms}ms), allPeers~=${peerSync.fanoutAllPeersV1.estimatedAllPeersMs}ms (${peerSync.fanoutAllPeersV1.updateKB} KB)`)
  console.log(`   Incremental Fanout V2 (${docStats.authors}p): perPeer=${peerSync.fanoutAllPeersV2.perPeerMeanMs}ms (p95=${peerSync.fanoutAllPeersV2.perPeerP95Ms}ms), allPeers~=${peerSync.fanoutAllPeersV2.estimatedAllPeersMs}ms (${peerSync.fanoutAllPeersV2.updateKB} KB)`)
  console.log('')

  console.log('5. Deterministic Wire & Semantic Fingerprints (SHA-256)')
  console.log(`   V1 SHA-256    : ${fingerprints.v1Sha256}`)
  console.log(`   V2 SHA-256    : ${fingerprints.v2Sha256}`)
  console.log(`   Delta SHA-256 : ${fingerprints.deltaSha256}`)
  console.log('')
  console.log('--- JSON_SUMMARY_START ---')
  console.log(JSON.stringify(res))
  console.log('--- JSON_SUMMARY_END ---')
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  /** @type {BenchScale} */
  let scale = 'quick'
  let seed = DEFAULT_SEED
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
    } else if (arg === '--json') {
      jsonOnly = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./benchmarks/lab/longdoc-bench.js [--scale quick|realistic] [--seed N] [--json]')
      process.exit(0)
    }
  }
  return { scale, seed, jsonOnly }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const result = runLongDocBenchmark(SCALE_CONFIGS[args.scale], args.seed)
  if (args.jsonOnly) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printReport(result)
  }
}
