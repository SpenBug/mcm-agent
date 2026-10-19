/**
 * One-time repair helper for this preset.
 *
 * Why this exists
 * ---------------
 * `@deepseek-ai/dsh-skill-filesystem` scans a `bundledSkillDir` root (rank 600)
 * that defaults to `process.env.DSH_BUNDLED_SKILL_DIR`. In this DSH Desktop
 * build that variable points INSIDE `app.asar`
 * (`…/app.asar/node_modules/@deepseek-ai/dsh-agent-preset/skills`), and
 * Electron's asar `fs` wrapper throws when listing it:
 *
 *   FsError: cannot list "…app.asar…/dsh-agent-preset/skills":
 *   Cannot mix BigInt and other types, use explicit conversions
 *
 * `@deepseek-ai/dsh-skill` catches a throwing provider and drops it whole
 * ("skill provider \"filesystem\" skipped"), so EVERY local skill — bundled,
 * user-level and project-level — silently disappears from the catalog. That is
 * why `mathmodelagent-suite` (and every other skill) was undiscoverable.
 *
 * The preset's `cordis.patch.yml` fixes it by setting an explicit
 * `bundledSkillDir` that points at a real directory on disk, overriding the
 * asar path. This script materialises that directory with the bundled skills
 * that live inside the asar, so nothing is lost.
 *
 * Usage (once per harness home; re-run after a DSH upgrade):
 *   node extract-bundled-skills.mjs
 *
 * The target defaults to `<DSH_HOME>/bundled-skills`, matching the patch's
 * `bundledSkillDir: !!js dshHomePath('bundled-skills')`. An empty directory is
 * already enough to stop the crash; extracting the packs keeps the built-in
 * Harness skills available too.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ASAR_CANDIDATES = [
  'D:/DSH Desktop/resources/app.asar',
  'C:/Program Files/DSH Desktop/resources/app.asar',
]
const PREFIX = '/node_modules/@deepseek-ai/dsh-agent-preset/skills/'

const asarPath = process.argv[2] ?? ASAR_CANDIDATES.find((p) => fs.existsSync(p))
if (asarPath === undefined) {
  console.error('Could not locate app.asar; pass its path as the first argument.')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness')
const dest = process.argv[3] ?? path.join(dshHome, 'bundled-skills')

const buf = fs.readFileSync(asarPath)
const headerSize = buf.readUInt32LE(4)
const headerBuf = buf.subarray(8, 8 + headerSize)
const strLen = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + strLen))
const base = 8 + headerSize

const files = []
;(function walk(node, prefix) {
  for (const [name, val] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (val.files) walk(val, p)
    else files.push({ path: p, offset: Number(val.offset), size: val.size })
  }
})(header, '')

const wanted = files.filter((f) => f.path.startsWith(PREFIX) && f.size > 0)
if (wanted.length === 0) {
  console.error('No bundled skill files found under ' + PREFIX + ' in ' + asarPath)
  process.exit(1)
}

for (const f of wanted) {
  const out = path.join(dest, f.path.slice(PREFIX.length))
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, buf.subarray(base + f.offset, base + f.offset + f.size))
}

const packs = [...new Set(wanted.map((f) => f.path.slice(PREFIX.length).split('/')[0]))].sort()
console.log('extracted ' + wanted.length + ' files to ' + dest)
console.log('skill packs: ' + packs.join(', '))
