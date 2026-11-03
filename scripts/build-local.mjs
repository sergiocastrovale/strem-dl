// Builds the desktop app on this machine, checks that nothing personal ended up inside, and can add
// the packages to the draft GitHub release. Linux and Windows only: macOS is built by GitHub.
//
//   pnpm build:local              build and check
//   pnpm build:local --upload     ...then add the packages to the draft release (creating it if needed)
//   --skip-tests                  don't run the tests first
//   --forbid=word                 also fail if this text turns up inside (repeatable)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const windows = process.platform === 'win32'
const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const extraForbidden = args.filter((arg) => arg.startsWith('--forbid=')).map((arg) => arg.slice('--forbid='.length))

const fail = (message) => {
  console.error(`\n${message}`)
  process.exit(1)
}
const capture = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', shell: windows }).trim()
const run = (cmd, cmdArgs, env = {}) => {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell: windows, env: { ...process.env, ...env } })
  if (result.status !== 0) fail(`${cmd} ${cmdArgs.join(' ')} failed.`)
}

if (process.platform === 'darwin') fail('Build macOS on GitHub: run "Build macOS" under Actions.')

const version = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version
const tag = `v${version}`
const sha = capture('git', ['rev-parse', 'HEAD'])
if (capture('git', ['status', '--porcelain'])) {
  console.warn('Warning: uncommitted changes. The release would not match any commit.')
  if (flag('upload')) fail('Commit everything before uploading.')
}

// Compiler paths end up inside the program (panic messages, debug info). Rewrite the ones that
// contain a home folder, so the username isn't in what gets shipped.
const home = homedir()
const cargoHome = process.env.CARGO_HOME ?? join(home, '.cargo')
const rustupHome = process.env.RUSTUP_HOME ?? join(home, '.rustup')
const remap = (from, to) => {
  const forms = new Set([from, from.replaceAll('\\', '/'), from.replaceAll('/', '\\')])
  return [...forms].map((form) => `--remap-path-prefix=${form}=${to}`)
}
// Where several match, the last one wins, so the most specific go last.
const rustflags = [
  ...remap(home, '/remapped/home'),
  ...remap(cargoHome, '/remapped/cargo'),
  ...remap(rustupHome, '/remapped/rustup'),
  ...remap(root, '/remapped/strem-dl'),
]

if (!flag('skip-tests')) {
  run('pnpm', ['test'])
  run('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml'], { CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f') })
}
run('pnpm', ['tauri', 'build'], { CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f') })

// Packages for this system.
const bundle = join(root, 'src-tauri/target/release/bundle')
const listed = (folder, test) =>
  existsSync(join(bundle, folder)) ? readdirSync(join(bundle, folder)).filter(test).map((name) => join(bundle, folder, name)) : []
const packages = (
  windows
    ? [...listed('nsis', (n) => n.endsWith('-setup.exe')), ...listed('msi', (n) => n.endsWith('.msi'))]
    : [...listed('appimage', (n) => n.endsWith('.AppImage')), ...listed('deb', (n) => n.endsWith('.deb')), ...listed('rpm', (n) => n.endsWith('.rpm'))]
).filter((file) => file.includes(version))
if (!packages.length) fail(`No packages for ${version} found in ${bundle}.`)

// What must not appear. Short names like "kp" would match random bytes, so look for them where they
// mean something: in a path or an address.
const user = userInfo().username
const forbidden = new Set(
  [
    `/home/${user}`,
    `/Users/${user}`,
    `\\Users\\${user}`,
    `/Users/${user.toLowerCase()}`,
    `com.${user}.`,
    `${user}@`,
    home,
    ...extraForbidden,
  ].filter((text) => text.length > 3),
)
for (const key of ['user.email']) {
  for (const scope of ['--global', '--local']) {
    try {
      const value = capture('git', ['config', scope, key])
      if (value && value !== capture('git', ['config', 'user.email'])) forbidden.add(value)
    } catch {
      // Not set there.
    }
  }
}
// Whatever commits are made with is fine; any other address of yours isn't.

/** Every file under a folder, or the file itself. */
function* files(path) {
  if (statSync(path).isDirectory()) for (const name of readdirSync(path)) yield* files(join(path, name))
  else yield path
}

function scan(label, paths) {
  const needles = [...forbidden].flatMap((text) => [
    { text, bytes: Buffer.from(text.toLowerCase(), 'latin1') },
    // Windows programs keep many strings as UTF-16.
    { text, bytes: Buffer.from(text.toLowerCase(), 'utf16le') },
  ])
  const found = []
  let count = 0
  for (const path of paths) {
    for (const file of files(path)) {
      let data
      try {
        data = readFileSync(file)
      } catch {
        continue // A link that goes nowhere.
      }
      count++
      const lower = Buffer.from(data.map((byte) => (byte >= 65 && byte <= 90 ? byte + 32 : byte)))
      for (const { text, bytes } of needles) {
        const at = lower.indexOf(bytes)
        if (at >= 0) found.push(`${file.replace(root, '.')}: "${text}" at byte ${at}`)
      }
    }
  }
  console.log(`${found.length ? 'FOUND' : 'clean'}  ${label} (${count} files)`)
  return found
}

const found = [
  ...scan('web files', [join(root, 'dist')]),
  ...scan('program', [join(root, 'src-tauri/target/release', windows ? 'strem-dl.exe' : 'strem-dl')]),
]

if (!windows) {
  // Packages are compressed, so look at what's inside them.
  const temp = mkdtempSync(join(tmpdir(), 'strem-dl-scan-'))
  try {
    for (const file of packages) {
      const inside = join(temp, file.split('/').pop())
      if (file.endsWith('.deb')) {
        execFileSync('dpkg-deb', ['-x', file, inside])
        execFileSync('dpkg-deb', ['-e', file, join(inside, 'DEBIAN')])
        found.push(...scan(file.split('/').pop(), [inside]))
      } else if (file.endsWith('.AppImage')) {
        spawnSync('mkdir', ['-p', inside])
        const extracted = spawnSync(file, ['--appimage-extract'], { cwd: inside, stdio: 'ignore' })
        if (extracted.status === 0) found.push(...scan(file.split('/').pop(), [join(inside, 'squashfs-root')]))
        else console.warn(`skipped ${file.split('/').pop()}: could not unpack it`)
      } else {
        // An .rpm is checked through the program and web files it was made from.
        console.log(`note   ${file.split('/').pop()} not unpacked`)
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
} else {
  console.log('note   installers are compressed and only the program and web files inside them were checked')
}

if (found.length) fail(`Personal details found. Not uploading.\n${found.join('\n')}`)
console.log(`\nBuilt ${packages.length} packages for ${tag}:\n${packages.map((file) => `  ${file.replace(root, '.')}`).join('\n')}`)

if (!flag('upload')) {
  console.log('\nNothing uploaded. Run again with --upload to add them to the draft release.')
  process.exit(0)
}

// The release must be a draft for exactly this commit, and that commit must be on GitHub.
if (!capture('git', ['branch', '-r', '--contains', sha])) fail(`${sha} isn't pushed. Push it first.`)
let release
try {
  release = JSON.parse(capture('gh', ['release', 'view', tag, '--json', 'isDraft,targetCommitish']))
} catch {
  console.log(`Creating draft ${tag}`)
  run('gh', ['release', 'create', tag, '--draft', '--target', sha, '--title', `strem-dl ${tag}`, '--generate-notes'])
  release = { isDraft: true, targetCommitish: sha }
}
if (!release.isDraft) fail(`${tag} is already published.`)
if (release.targetCommitish !== sha) fail(`Draft ${tag} is for ${release.targetCommitish}, not ${sha}.`)
run('gh', ['release', 'upload', tag, ...packages, '--clobber'])
console.log(`\nUploaded to the draft ${tag}. Check it, then publish.`)
