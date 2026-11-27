import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const LAB_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * @typedef {'quick' | 'medium' | '10x'} CampaignScale
 */

/**
 * @typedef {{
 *   id: string,
 *   script: string,
 *   args: Array<string>,
 *   label: string
 * }} CampaignStep
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   ok: boolean,
 *   exitCode: number | null,
 *   ms: number,
 *   passedUnits: number,
 *   failedUnits: number,
 *   binaryChecks: number,
 *   binaryFindings: number,
 *   summaryLine: string
 * }} StepResult
 */

/**
 * Build the strictly serialized execution plan for a given scale.
 *
 * @param {CampaignScale} scale
 * @param {number} seed
 * @return {Array<CampaignStep>}
 */
const buildPlan = (scale, seed) => {
  /** @type {Array<CampaignStep>} */
  const steps = []

  if (scale === 'quick') {
    steps.push(
      { id: 'convergence', script: 'convergence-fuzzer.js', args: ['--seed', String(seed), '--runs', '4', '--ops', '120'], label: 'convergence (4 runs x 120 ops)' },
      { id: 'undo-gc', script: 'undo-gc-fuzzer.js', args: ['--seed', String(seed + 101), '--runs', '4', '--ops', '100'], label: 'undo-gc (4 runs x 100 ops)' },
      { id: 'richtext', script: 'richtext-fuzzer.js', args: ['--seed', String(seed + 202), '--runs', '4', '--clients', '10', '--ops', '100'], label: 'richtext (4 runs x 10c x 100 ops)' },
      { id: 'v14-delta', script: 'v14-delta-attribution-fuzzer.js', args: ['--seed', String(seed + 303), '--seeds', '2', '--intensity', 'medium'], label: 'v14-delta-attr (4 suites x 2 seeds)' },
      { id: 'subdoc', script: 'subdoc-nested-fuzzer.js', args: ['--seed', String(seed + 404), '--runs', '4', '--clients', '8', '--ops', '80'], label: 'subdoc-nested (4 runs x 8c x 80 ops)' },
      { id: 'idset-blockset', script: 'idset-blockset-algebra-fuzzer.js', args: ['--seed', String(seed + 505), '--runs', '4', '--intensity', 'default'], label: 'idset-blockset (2 suites x 4 runs)' },
      { id: 'binary-1337', script: 'malformed-binary.js', args: ['--seed', '1337'], label: 'malformed-binary (seed=1337)' }
    )
  } else if (scale === 'medium') {
    steps.push(
      { id: 'convergence', script: 'convergence-fuzzer.js', args: ['--seed', String(seed), '--runs', '8', '--ops', '120'], label: 'convergence (8 runs x 120 ops)' },
      { id: 'undo-gc', script: 'undo-gc-fuzzer.js', args: ['--seed', String(seed + 101), '--runs', '4', '--ops', '100'], label: 'undo-gc (4 runs x 100 ops)' },
      { id: 'richtext', script: 'richtext-fuzzer.js', args: ['--seed', String(seed + 202), '--runs', '4', '--clients', '10', '--ops', '100'], label: 'richtext (4 runs x 10c x 100 ops)' },
      { id: 'v14-delta', script: 'v14-delta-attribution-fuzzer.js', args: ['--seed', String(seed + 303), '--seeds', '4', '--intensity', 'medium'], label: 'v14-delta-attr (4 suites x 4 seeds)' },
      { id: 'subdoc', script: 'subdoc-nested-fuzzer.js', args: ['--seed', String(seed + 404), '--runs', '4', '--clients', '8', '--ops', '80'], label: 'subdoc-nested (4 runs x 8c x 80 ops)' },
      { id: 'idset-blockset', script: 'idset-blockset-algebra-fuzzer.js', args: ['--seed', String(seed + 505), '--runs', '8', '--intensity', 'default'], label: 'idset-blockset (2 suites x 8 runs)' },
      { id: 'binary-1337', script: 'malformed-binary.js', args: ['--seed', '1337'], label: 'malformed-binary (seed=1337)' }
    )
  } else {
    steps.push(
      { id: 'convergence', script: 'convergence-fuzzer.js', args: ['--seed', String(seed), '--runs', '40', '--clients', '20', '--ops', '250'], label: 'convergence (40 runs x 20c x 250 ops)' },
      { id: 'undo-gc', script: 'undo-gc-fuzzer.js', args: ['--seed', String(seed + 101), '--runs', '40', '--clients', '18', '--ops', '200'], label: 'undo-gc (40 runs x 18c x 200 ops)' },
      { id: 'richtext', script: 'richtext-fuzzer.js', args: ['--seed', String(seed + 202), '--runs', '32', '--clients', '18', '--ops', '300'], label: 'richtext (32 runs x 18c x 300 ops)' },
      { id: 'v14-delta', script: 'v14-delta-attribution-fuzzer.js', args: ['--seed', String(seed + 303), '--seeds', '24', '--intensity', 'high'], label: 'v14-delta-attr (4 suites x 24 seeds, high)' },
      { id: 'subdoc', script: 'subdoc-nested-fuzzer.js', args: ['--seed', String(seed + 404), '--runs', '24', '--clients', '12', '--ops', '200'], label: 'subdoc-nested (24 runs x 12c x 200 ops)' },
      { id: 'idset-blockset', script: 'idset-blockset-algebra-fuzzer.js', args: ['--seed', String(seed + 505), '--runs', '40', '--intensity', 'extreme'], label: 'idset-blockset (2 suites x 40 runs, ext)' },
      { id: 'binary-1337', script: 'malformed-binary.js', args: ['--seed', '1337'], label: 'malformed-binary (seed=1337)' },
      { id: 'binary-2026', script: 'malformed-binary.js', args: ['--seed', '2026'], label: 'malformed-binary (seed=2026)' },
      { id: 'binary-9001', script: 'malformed-binary.js', args: ['--seed', '9001'], label: 'malformed-binary (seed=9001)' }
    )
  }

  return steps
}

/**
 * Parse the standardized `=== Summary: ... ===` line from a child harness's output.
 *
 * @param {string} output
 * @return {{ passedUnits: number, failedUnits: number, binaryChecks: number, binaryFindings: number, summaryLine: string }}
 */
const parseSummary = output => {
  const lines = output.split(/\r?\n/)
  let summaryLine = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('=== Summary:')) {
      summaryLine = trimmed
      break
    }
  }
  let passedUnits = 0
  let failedUnits = 0
  let binaryChecks = 0
  let binaryFindings = 0

  const pfMatch = summaryLine.match(/(\d+)\s+passed,\s+(\d+)\s+failed/)
  if (pfMatch !== null) {
    passedUnits = Number.parseInt(pfMatch[1], 10)
    failedUnits = Number.parseInt(pfMatch[2], 10)
  }
  const binMatch = summaryLine.match(/(\d+)\s+checks\b.*?(\d+)\s+findings/)
  if (binMatch !== null) {
    binaryChecks = Number.parseInt(binMatch[1], 10)
    binaryFindings = Number.parseInt(binMatch[2], 10)
  }
  return { passedUnits, failedUnits, binaryChecks, binaryFindings, summaryLine }
}

/**
 * Parse CLI arguments.
 *
 * @param {Array<string>} argv
 */
const parseArgs = argv => {
  /** @type {CampaignScale} */
  let scale = 'quick'
  let seed = 20260808
  let reportOnly = false
  let verbose = false
  /** @type {Array<string>} */
  let only = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--scale' && i + 1 < argv.length) {
      const val = argv[++i]
      if (val === 'quick' || val === 'medium' || val === '10x') {
        scale = val
      } else {
        console.error(`Invalid --scale "${val}" (expected quick|medium|10x)`)
        process.exit(2)
      }
    } else if (arg === '--seed' && i + 1 < argv.length) {
      seed = Number.parseInt(argv[++i], 10)
    } else if (arg === '--only' && i + 1 < argv.length) {
      only = argv[++i].split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    } else if (arg === '--report') {
      reportOnly = true
    } else if (arg === '--verbose') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node ./tests/lab/fuzz-campaign.js [--scale quick|medium|10x] [--seed N] [--only id1,id2] [--report] [--verbose]')
      process.exit(0)
    }
  }
  return { scale, seed, only, reportOnly, verbose }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '')

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const allSteps = buildPlan(args.scale, args.seed)
  const steps = args.only.length === 0
    ? allSteps
    : allSteps.filter(s => args.only.some(f => s.id.toLowerCase().includes(f) || s.script.toLowerCase().includes(f)))

  if (steps.length === 0) {
    console.error(`No campaign steps matched --only=${args.only.join(',')}`)
    process.exit(2)
  }

  console.log(`=== Yjs v14 Serialized Fuzz Campaign (scale=${args.scale}, seed=${args.seed}, steps=${steps.length}, D-001 single-process mutex) ===`)
  const t0 = performance.now()
  /** @type {Array<StepResult>} */
  const results = []

  // Strictly sequential execution: ONE child Node process at a time for flat RAM & clean V8 heap!
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const scriptPath = join(LAB_DIR, step.script)
    const st0 = performance.now()
    console.log(`\n[${i + 1}/${steps.length}] Running ${step.label} ...`)
    const proc = spawnSync(process.execPath, [scriptPath, ...step.args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    const ms = performance.now() - st0
    const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`
    const parsed = parseSummary(combined)
    const ok = proc.error === undefined && proc.status === 0
    results.push({
      id: step.id,
      label: step.label,
      ok,
      exitCode: proc.status,
      ms,
      passedUnits: parsed.passedUnits,
      failedUnits: parsed.failedUnits,
      binaryChecks: parsed.binaryChecks,
      binaryFindings: parsed.binaryFindings,
      summaryLine: parsed.summaryLine
    })

    if (args.verbose || !ok) {
      if (proc.stdout) process.stdout.write(proc.stdout)
      if (proc.stderr) process.stderr.write(proc.stderr)
      if (proc.error) console.error(proc.error)
    }
    const badge = ok ? 'PASS' : 'FAIL'
    console.log(`  -> [${badge}] ${step.id} (${(ms / 1000).toFixed(2)}s) ${parsed.summaryLine || `(exit=${String(proc.status)})`}`)
  }

  const totalMs = performance.now() - t0
  let totalHarnessesPassed = 0
  let totalHarnessesFailed = 0
  let totalPassedUnits = 0
  let totalFailedUnits = 0
  let totalBinaryChecks = 0
  let totalBinaryFindings = 0

  console.log('\n================================================================================')
  console.log(`=== Campaign Scorecard (scale=${args.scale}, seed=${args.seed}) ===`)
  console.log('================================================================================')
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.ok) totalHarnessesPassed++
    else totalHarnessesFailed++
    totalPassedUnits += r.passedUnits
    totalFailedUnits += r.failedUnits
    totalBinaryChecks += r.binaryChecks
    totalBinaryFindings += r.binaryFindings
    const metric = r.binaryChecks > 0
      ? `${r.binaryChecks} checks, ${r.binaryFindings} findings`
      : `${r.passedUnits} passed, ${r.failedUnits} failed`
    console.log(
      `  [${r.ok ? 'PASS' : 'FAIL'}] ${r.label.padEnd(44)} | ${metric.padEnd(26)} | ${(r.ms / 1000).toFixed(2)}s`
    )
  }
  console.log('--------------------------------------------------------------------------------')
  console.log(
    `  GRAND TOTAL: ${totalHarnessesPassed}/${results.length} steps passed | ` +
    `fuzz seeds: ${totalPassedUnits} passed, ${totalFailedUnits} failed | ` +
    `binary checks: ${totalBinaryChecks} (${totalBinaryFindings} findings) | ` +
    `elapsed: ${(totalMs / 1000).toFixed(2)}s`
  )
  console.log('================================================================================')

  if (totalHarnessesFailed > 0 && !args.reportOnly) {
    process.exit(1)
  }
}
