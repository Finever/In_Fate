import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')
const source = join(root, 'tools', 'installer-bootstrapper.cs')
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim()
const magic = Buffer.from('IN_FATE_SETUP_V1', 'ascii')
if (magic.length !== 16) throw new Error('installer magic must be 16 bytes')

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const packagePath = resolve(
  arg('--package')
    ?? join(releaseDir, `In_First-v${version}-${process.platform}-${process.arch}.zip`),
)
const outPath = resolve(
  arg('--out')
    ?? join(releaseDir, `In_Fate-Setup-v${version}-${process.platform}-${process.arch}.exe`),
)

if (!existsSync(source)) throw new Error(`missing bootstrapper source: ${source}`)
if (!existsSync(packagePath)) {
  throw new Error(`missing release zip: ${packagePath}\n先运行 npm run release，或用 --package 指定 zip`)
}
if (resolve(outPath) === resolve(packagePath)) {
  throw new Error('--out must not overwrite the release zip')
}
if (!existsSync(join(root, 'tools', 'install.mjs'))) {
  throw new Error('tools/install.mjs is missing')
}
const installerMtime = Math.max(
  statSync(join(root, 'tools', 'install.mjs')).mtimeMs,
  statSync(source).mtimeMs,
  statSync(join(root, 'VERSION')).mtimeMs,
)
if (statSync(packagePath).mtimeMs < installerMtime) {
  throw new Error(`release zip is older than the installer: ${packagePath}\n先重新运行 npm run release，再打包 exe`)
}

const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
const csc = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const frameworkDir = dirname(csc)
const compression = join(frameworkDir, 'System.IO.Compression.dll')
const compressionFileSystem = join(frameworkDir, 'System.IO.Compression.FileSystem.dll')
const icon = join(root, 'desktop', 'if-w3.ico')
for (const path of [csc, compression, compressionFileSystem]) {
  if (!existsSync(path)) throw new Error(`missing .NET build dependency: ${path}`)
}

mkdirSync(releaseDir, { recursive: true })
const compiled = join(releaseDir, `.installer-bootstrapper-${process.pid}.exe`)
rmSync(compiled, { force: true })

const compileArgs = [
  '/nologo',
  '/target:exe',
  '/platform:anycpu',
  '/optimize+',
  `/out:${compiled}`,
  `/r:${compression}`,
  `/r:${compressionFileSystem}`,
]
if (existsSync(icon)) compileArgs.push(`/win32icon:${icon}`)
compileArgs.push(source)
const compile = spawnSync(csc, compileArgs, { stdio: 'inherit' })

if (compile.error) throw compile.error
if (compile.status !== 0) throw new Error(`csc exited with ${compile.status ?? 'unknown'}`)

const exeBytes = readFileSync(compiled)
const payloadSize = statSync(packagePath).size
if (payloadSize <= 0) throw new Error(`empty release zip: ${packagePath}`)

rmSync(outPath, { force: true })
const out = openSync(outPath, 'w')
try {
  writeAll(out, exeBytes)
  copyFile(out, packagePath, payloadSize)
  writeAll(out, magic)
  const length = Buffer.alloc(8)
  length.writeBigInt64LE(BigInt(payloadSize))
  writeAll(out, length)
} finally {
  closeSync(out)
  rmSync(compiled, { force: true })
}

// 尾部回读校验，确认 exe 真的带上了完整 payload。
const builtSize = statSync(outPath).size
const footer = Buffer.alloc(24)
const verify = openSync(outPath, 'r')
try {
  readAll(verify, footer, builtSize - footer.length)
} finally {
  closeSync(verify)
}
if (!footer.subarray(0, 16).equals(magic) || footer.readBigInt64LE(16) !== BigInt(payloadSize)) {
  throw new Error('installer footer verification failed')
}

const sha256 = await new Promise((resolveHash, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(outPath)
  stream.on('data', chunk => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolveHash(hash.digest('hex')))
})
writeFileSync(`${outPath}.sha256`, `${sha256}  ${outPath.split(/[\\/]/).pop()}\n`, 'utf8')

console.log(`[installer] ${outPath}`)
console.log(`[installer] payload: ${formatBytes(payloadSize)} (${packagePath})`)
console.log(`[installer] size: ${formatBytes(builtSize)}`)
console.log(`[installer] sha256: ${sha256}`)
console.log(`[installer] checksum: ${outPath}.sha256`)

function writeAll(fd, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset)
  }
}

function copyFile(outFd, sourcePath, size) {
  const input = openSync(sourcePath, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  let position = 0
  try {
    while (position < size) {
      const read = readSync(input, buffer, 0, Math.min(buffer.length, size - position), position)
      if (read <= 0) throw new Error(`unexpected EOF: ${sourcePath}`)
      writeAll(outFd, buffer.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(input)
  }
}

function readAll(fd, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset)
    if (read <= 0) throw new Error('unexpected EOF while verifying installer')
    offset += read
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
