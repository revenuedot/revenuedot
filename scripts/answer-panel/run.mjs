#!/usr/bin/env node
// Answer panel: runs fixed prompts through headless coding-agent CLIs in an empty
// temp directory (no RevenueDot context), saves raw answers outside the repo, scores them.
//
//   node scripts/answer-panel/run.mjs [--out DIR] [--only claude,codex] [--limit N] [--concurrency N] [--rescore]
//
// No secrets live here: each CLI uses its own existing login. Tools are disabled / sandboxed read-only.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const today = new Date().toLocaleDateString('en-CA') // local date, YYYY-MM-DD
const outDir = opt('out', join(homedir(), 'Developer/revenuedot/company/marketing/answer-panel', today))
const only = opt('only', 'claude,codex').split(',')
const limit = Number(opt('limit', '0')) || Infinity
const concurrency = Number(opt('concurrency', '3'))
const rescore = args.includes('--rescore')
const timeoutMs = Number(opt('timeout', '300')) * 1000
const prompts = JSON.parse(readFileSync(join(here, 'prompts.json'), 'utf8')).slice(0, limit)

const has = (bin) => spawnSync('which', [bin]).status === 0

// Each assistant: argv builder that reads the answer from stdout (or a file).
const ASSISTANTS = {
  claude: {
    bin: 'claude',
    run: (prompt) => ({
      cmd: 'claude',
      argv: [
        '-p', prompt,
        '--tools', '',
        '--permission-mode', 'plan',
        '--setting-sources', '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--output-format', 'text',
      ],
    }),
  },
  codex: {
    bin: 'codex',
    run: (prompt, cwd, lastFile) => ({
      cmd: 'codex',
      argv: [
        'exec',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--disable', 'apps',
        '--ignore-user-config',
        '--ignore-rules',
        '-C', cwd,
        '-o', lastFile,
        prompt,
      ],
      answerFile: lastFile,
    }),
  },
}

const COMPETITORS = {
  revenuecat: /revenue\s?cat|purchases-(ios|android|flutter|hybrid)|react-native-purchases/i,
  adapty: /adapty/i,
  superwall: /superwall/i,
  qonversion: /qonversion/i,
}
const STORE_NATIVE = /storekit|play billing|billingclient|google play billing|app store server api|app store connect|android\.billingclient/i
const OTHER = /react-native-iap|expo-iap|in_app_purchase|flutter_inapp_purchase|purchases_flutter|glassfy|apphud|iaptic|stripe|paddle|lemon\s?squeezy|nami ml|singular|openiap|expo-in-app-purchases|rovenue|openrevenue/i

export function score(text) {
  const t = text || ''
  const hits = {
    revenuedot: /revenue\s?dot/i.test(t),
    revenuecat: COMPETITORS.revenuecat.test(t),
    adapty: COMPETITORS.adapty.test(t),
    superwall: COMPETITORS.superwall.test(t),
    qonversion: COMPETITORS.qonversion.test(t),
  }
  const anyVendor = hits.revenuecat || hits.adapty || hits.superwall || hits.qonversion || hits.revenuedot
  hits.other = OTHER.test(t)
  hits.storeNativeOnly = !anyVendor && !hits.other && STORE_NATIVE.test(t)
  hits.none = !anyVendor && !hits.other && !hits.storeNativeOnly
  return hits
}

function runOne(name, prompt) {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(join(tmpdir(), 'answer-panel-'))
    const lastFile = join(cwd, '.last-message.txt')
    // Keep the answer file out of the working dir the model sees.
    const spec = ASSISTANTS[name].run(prompt, cwd, join(tmpdir(), `ap-${process.pid}-${Math.random().toString(36).slice(2)}.txt`))
    // Codex gets a clean home (only the existing login is linked in) so the user's memories,
    // AGENTS.md, plugins and connectors, including any RevenueDot ones, cannot leak into answers.
    const env = { ...process.env }
    let codexHome
    if (name === 'codex') {
      codexHome = mkdtempSync(join(tmpdir(), 'answer-panel-codex-home-'))
      const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json')
      if (existsSync(auth)) symlinkSync(auth, join(codexHome, 'auth.json'))
      env.CODEX_HOME = codexHome
    }
    const child = spawn(spec.cmd, spec.argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      let answer = stdout
      if (spec.answerFile) {
        answer = existsSync(spec.answerFile) ? readFileSync(spec.answerFile, 'utf8') : ''
        rmSync(spec.answerFile, { force: true })
      }
      rmSync(cwd, { recursive: true, force: true })
      if (codexHome) rmSync(codexHome, { recursive: true, force: true })
      // claude -p prints auth failures to stdout; never score those as answers.
      let code = exitCode
      if (/^(Failed to authenticate|Invalid API key|Please run \/login)/i.test(answer.trim())) {
        stderr += answer
        answer = ''
        code = code || 1
      }
      resolve({ code, answer: answer.trim(), stderr: stderr.slice(-2000) })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, answer: '', stderr: String(e) })
    })
  })
}

async function pool(items, n, fn) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift())
    }),
  )
}

mkdirSync(outDir, { recursive: true })
const results = {}
const skipped = {}

for (const name of only) {
  if (!ASSISTANTS[name]) { skipped[name] = 'unknown assistant'; continue }
  if (!has(ASSISTANTS[name].bin)) { skipped[name] = `${ASSISTANTS[name].bin} not installed`; continue }
  const dir = join(outDir, name)
  mkdirSync(dir, { recursive: true })
  results[name] = []
  await pool(prompts, concurrency, async (p) => {
    const file = join(dir, `${p.id}.md`)
    let answer, code = 0, stderr = ''
    if (existsSync(file) && (rescore || args.includes('--resume'))) {
      answer = readFileSync(file, 'utf8')
    } else {
      process.stderr.write(`${name} ${p.id}\n`)
      ;({ answer, code, stderr } = await runOne(name, p.prompt))
      if (answer) writeFileSync(file, answer + '\n')
    }
    results[name].push({ id: p.id, topic: p.topic, ok: Boolean(answer), code, stderr: answer ? '' : stderr, hits: score(answer), chars: answer.length })
  })
  results[name].sort((a, b) => a.id.localeCompare(b.id))
  // A CLI that never produced an answer (login needed, offline) is reported as skipped, not as zeros.
  if (results[name].every((r) => !r.ok)) {
    skipped[name] = `no answers (exit ${results[name][0]?.code}): ${results[name][0]?.stderr.trim().slice(-300)}`
    delete results[name]
  }
}

writeFileSync(join(outDir, 'scores.json'), JSON.stringify({ date: today, results, skipped }, null, 2) + '\n')

const cols = ['revenuedot', 'revenuecat', 'adapty', 'superwall', 'qonversion', 'storeNativeOnly', 'other', 'none']
const labels = ['RevenueDot', 'RevenueCat', 'Adapty', 'Superwall', 'Qonversion', 'Store-native only', 'Other SDK', 'No product named']
let md = `# Answer panel ${today}\n\n${prompts.length} fixed prompts, each run once per assistant in an empty temp directory with tools disabled or read-only. A cell counts answers that name the product (an answer can name several).\n\n`
md += `| Assistant | Answers | ${labels.join(' | ')} |\n|---|---|${labels.map(() => '---').join('|')}|\n`
for (const [name, rs] of Object.entries(results)) {
  const answered = rs.filter((r) => r.ok)
  md += `| ${name} | ${answered.length}/${rs.length} | ${cols.map((c) => answered.filter((r) => r.hits[c]).length).join(' | ')} |\n`
}
for (const [name, why] of Object.entries(skipped)) md += `\nSkipped ${name}: ${why}\n`
md += `\n## By topic (RevenueDot named / answers)\n\n| Topic | ${Object.keys(results).join(' | ')} |\n|---|${Object.keys(results).map(() => '---').join('|')}|\n`
for (const topic of [...new Set(prompts.map((p) => p.topic))]) {
  md += `| ${topic} | ${Object.values(results).map((rs) => { const t = rs.filter((r) => r.topic === topic && r.ok); return `${t.filter((r) => r.hits.revenuedot).length}/${t.length}` }).join(' | ')} |\n`
}
writeFileSync(join(outDir, 'summary.md'), md)
console.log(md)
