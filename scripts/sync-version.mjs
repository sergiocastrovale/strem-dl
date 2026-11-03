// Runs after `pnpm version patch|minor|major` (npm's "version" lifecycle), once package.json has the new
// number. Copies it to the other places an app version lives, and stages them so they join the commit.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error(`Not a version: ${version}`)

/** Replace exactly one match, so a changed file layout fails loudly instead of skipping a place. */
function replaceOnce(file, pattern, replacement) {
  const text = readFileSync(file, 'utf8')
  if ([...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length !== 1) {
    throw new Error(`${file}: expected exactly one match for ${pattern}`)
  }
  writeFileSync(file, text.replace(pattern, replacement))
}

const files = ['src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']
replaceOnce(files[0], /^(\s*"version":\s*")[^"]+(",?)$/m, `$1${version}$2`)
replaceOnce(files[1], /^(version = ")[^"]+(")$/m, `$1${version}$2`)
// The lock file lists the app among its packages.
replaceOnce(files[2], /^(name = "strem-dl"\r?\nversion = ")[^"]+(")$/m, `$1${version}$2`)

console.log(`Version ${version}: ${files.join(', ')}`)
execFileSync('git', ['add', ...files], { stdio: 'inherit' })
