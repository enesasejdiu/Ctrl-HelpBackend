// scripts/docker-entrypoint.sh, the API image's entrypoint: migrations before the server starts, and no server when
// they fail. Run here with sh and the real scripts, on the throwaway test database (tests/setupEnv.js set DB_NAME).
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const root = path.join(__dirname, '..')

function start(args, env = {}) {
  const child = spawn('sh', ['scripts/docker-entrypoint.sh', ...args], {
    cwd: root,
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true', ...env },
  })
  const result = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => (result.stdout += chunk))
  child.stderr.on('data', (chunk) => (result.stderr += chunk))
  result.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, result }
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

test('starting the server: migrations first ("up to date" here), then the server itself', async () => {
  const port = await freePort()
  const { child, result } = start(['node', 'src/server.js'], { PORT: String(port) })
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', () => /API running/.test(result.stdout) && resolve())
      child.on('exit', () => reject(new Error(`exited early:\n${result.stdout}${result.stderr}`)))
    })
    const migrated = result.stdout.indexOf(`Database "${process.env.DB_NAME}" is up to date`)
    expect(result.stdout).toContain('[entrypoint] Applying database migrations')
    expect(migrated).toBeGreaterThan(-1)
    expect(result.stdout.indexOf('API running')).toBeGreaterThan(migrated)
    // exec: the server replaced the shell, so the signal reaches Node and it shuts down cleanly
    child.kill('SIGTERM')
    await expect(result.exited).resolves.toBe(0)
    expect(result.stdout).toContain('[shutdown] Shut down cleanly')
  } finally {
    child.kill('SIGKILL')
  }
}, 30000)

test('migrations that fail: the error and exit code 1, and the server is never started', async () => {
  // Nothing listens on port 1, so migrate.js can't connect
  const { result } = start(['node', 'src/server.js'], { DB_HOST: '127.0.0.1', DB_PORT: '1', PORT: '1' })
  await expect(result.exited).resolves.toBe(1)
  expect(result.stderr).toMatch(/Migration failed/)
  expect(result.stderr).toContain('[entrypoint] Migrations failed (see above): the API was not started')
  expect(result.stdout).not.toContain('API running')
}, 30000)

test('MIGRATE_ON_START=false skips the migrations', async () => {
  // With an unreachable database the migrations would fail, so the server starting proves they were skipped
  const port = await freePort()
  const { child, result } = start(['node', 'src/server.js'], {
    MIGRATE_ON_START: 'false',
    DB_HOST: '127.0.0.1',
    DB_PORT: '1',
    PORT: String(port),
  })
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', () => /API running/.test(result.stdout) && resolve())
      child.on('exit', () => reject(new Error(`exited early:\n${result.stdout}${result.stderr}`)))
    })
    expect(result.stdout).not.toContain('[entrypoint] Applying database migrations')
  } finally {
    child.kill('SIGKILL')
  }
}, 30000)

test('any other command (e.g. create-admin, a rollback) runs as it is, without migrating first', async () => {
  const { result } = start(['node', '-e', 'console.log("other command ran")'], { DB_HOST: '127.0.0.1', DB_PORT: '1' })
  await expect(result.exited).resolves.toBe(0)
  expect(result.stdout).toBe('other command ran\n')
})
