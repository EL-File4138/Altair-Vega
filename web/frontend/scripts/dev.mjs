import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const frontendDir = resolve(scriptDir, '..')
const workerDir = resolve(frontendDir, '..', 'rendezvous-worker')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const args = new Set(process.argv.slice(2))
const withWorker = !args.has('--no-worker')

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? frontendDir,
      stdio: 'inherit',
      shell: false,
    })
    child.on('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${commandArgs.join(' ')} exited with ${signal ?? code}`))
    })
    child.on('error', rejectRun)
  })
}

function start(command, commandArgs, options = {}) {
  return spawn(command, commandArgs, {
    cwd: options.cwd ?? frontendDir,
    stdio: 'inherit',
    shell: false,
  })
}

await run(npm, ['run', 'build:wasm'])

const children = []
if (withWorker) {
  children.push(start(npm, ['run', 'dev'], { cwd: workerDir }))
}
children.push(start(npm, ['run', 'dev:vite']))

let shuttingDown = false
function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(exitCode), 250)
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 0)
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
