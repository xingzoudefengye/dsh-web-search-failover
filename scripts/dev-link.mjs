#!/usr/bin/env node
/**
 * Link the installed DeepSeek Harness packages this bundle imports into this
 * checkout, so a *local-path* install (and `npm test`) can resolve them.
 *
 * Why this is needed: `dsh plugin add /abs/path` installs a `link:` dependency,
 * and Node's ESM resolver follows that symlink to this repository's real path.
 * Resolution then walks up from here and never reaches the profile's
 * node_modules. A git install has no such problem, so this is a development
 * convenience, not part of a normal install.
 *
 * Usage: node scripts/dev-link.mjs [directory containing @deepseek-ai/dsh-*]
 *   DSH_PACKAGE_DIR  same, via environment
 */
import { existsSync, mkdirSync, lstatSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGES = ['schemastery', 'dsh-credentials', 'dsh-launch-environment', 'dsh-web', 'dsh-web-search-deepseek']

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Find the `dsh` launcher on PATH, honouring Windows' PATHEXT shims. */
function findDshBin() {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `dsh${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Ask Node itself where a harness package lives when resolution starts from
 * `base` — this follows the same node_modules walk the loader will use, and
 * needs no platform-specific path guessing.
 */
function packagesFrom(base) {
  const require = createRequire(join(base, '__dsh_dev_link_probe__.cjs'))
  try {
    const entry = require.resolve('@deepseek-ai/schemastery/package.json')
    return dirname(dirname(entry))
  } catch {
    return undefined
  }
}

function hasPackages(dir) {
  return existsSync(dir) && existsSync(join(dir, 'schemastery')) && existsSync(join(dir, 'dsh-web'))
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = process.argv[3] ?? process.env.DSH_PROFILE ?? 'web'
const bin = findDshBin()

const explicit = process.argv[2] ?? process.env.DSH_PACKAGE_DIR
const binDir = bin ? dirname(bin) : undefined
const searchBases = explicit
  ? [explicit]
  : [
      // The `dsh` package itself carries its private dependencies under
      // node_modules/, so probing from there finds packages the npm root does
      // not hoist.
      ...(binDir ? [join(binDir, 'node_modules', '@deepseek-ai', 'dsh'), binDir] : []),
      join(dshHome, 'profiles', profile),
      join(dshHome, 'profiles'),
      dshHome,
      here,
    ]

const packageDir = searchBases.map((base) => (explicit ? base : packagesFrom(base))).find((dir) => dir && hasPackages(dir))

if (!packageDir) {
  console.error('dev-link: no schemastery/dsh-web under any candidate directory; pass the directory holding @deepseek-ai/dsh-* instead')
  console.error(`dev-link: tried ${searchBases.join(', ')}`)
  process.exit(1)
}

const linkRoot = join(here, 'node_modules', '@deepseek-ai')
mkdirSync(linkRoot, { recursive: true })

for (const pkg of PACKAGES) {
  const source = join(packageDir, pkg)
  if (!existsSync(source)) {
    console.error(`dev-link: ${pkg} is not installed in ${packageDir}`)
    process.exit(1)
  }
  const link = join(linkRoot, pkg)
  let present = false
  try {
    present = lstatSync(link) !== undefined
  } catch {
    present = false
  }
  if (present) continue
  // Windows needs an explicit link type; 'junction' works without elevation.
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`dev-link: linked ${pkg}`)
}

console.log('dev-link: local-path installs can now resolve the harness packages')
