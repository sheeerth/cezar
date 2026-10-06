import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`cockpit at ${url} never became healthy`);
}

/** A raw JSON-RPC client over a child's stdio — and a check that stdout carries nothing else. */
function stdioClient(child: ChildProcess) {
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const stray: string[] = [];
  let nextId = 1;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let message: { id?: number };
    try {
      message = JSON.parse(line) as { id?: number };
    } catch {
      stray.push(line);
      return;
    }
    if (typeof message.id === 'number') pending.get(message.id)?.(message as Record<string, unknown>);
  });
  const write = (message: Record<string, unknown>) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return {
    stray,
    notify: (method: string) => write({ method }),
    request: (method: string, params?: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolveMessage, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolveMessage(message);
        });
        write({ id, method, ...(params ? { params } : {}) });
      }),
  };
}

test('the release tarball serves `cez mcp` against a dry-run cockpit', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cezar-mcp-e2e-'));
  const children: ChildProcess[] = [];
  try {
    const packDir = join(root, 'pack');
    await mkdir(packDir);
    const packed = await execFile(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const record = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0];
    assert.ok(record, 'npm pack should describe the generated tarball');
    const consumerDir = join(root, 'consumer');
    await mkdir(consumerDir);
    await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
    await execFile(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(packDir, record.filename)], {
      cwd: consumerDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    const packageRoot = join(consumerDir, 'node_modules', '@open-mercato', 'cezar');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { bin: { cez: string } };
    const cliPath = join(packageRoot, manifest.bin.cez);

    const help = await execFile(process.execPath, [cliPath, 'mcp', '--help'], { cwd: consumerDir });
    assert.match(help.stdout, /cez mcp — an MCP server \(stdio\)/);

    const fixtureRepo = join(root, 'fixture-repo');
    await mkdir(fixtureRepo);
    await writeFile(join(fixtureRepo, 'README.md'), '# fixture\n', 'utf8');
    await execFile('git', ['init', '--initial-branch=main'], { cwd: fixtureRepo });
    await execFile('git', ['add', 'README.md'], { cwd: fixtureRepo });
    await execFile('git', ['-c', 'user.name=cezar', '-c', 'user.email=cezar@example.invalid', 'commit', '-m', 'fixture'], { cwd: fixtureRepo });

    const env: NodeJS.ProcessEnv = { ...process.env, CEZ_DRY_RUN: '1', CEZ_HOME: join(root, 'cez-home'), CEZ_NO_BANNER: '1' };
    delete env.CEZ_TASK_ID;
    delete env.CEZ_API_URL;
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const serve = spawn(process.execPath, [cliPath, '--port', String(port), '--repo', fixtureRepo, '--no-open'], {
      cwd: fixtureRepo,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.push(serve);
    await waitForHealth(url, 60_000);

    const mcp = spawn(process.execPath, [cliPath, 'mcp', '--url', url], { cwd: fixtureRepo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(mcp);
    const client = stdioClient(mcp);

    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
    client.notify('notifications/initialized');

    const listed = (await client.request('tools/list')).result as { tools: Array<{ name: string }> };
    assert.ok(listed.tools.some((t) => t.name === 'start_run'), 'outside a task the write tools are served');

    const call = async (name: string, args: Record<string, unknown>) => {
      const response = (await client.request('tools/call', { name, arguments: args })).result as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };
      assert.ok(!response.isError, `${name} failed: ${response.content[0]?.text}`);
      return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
    };

    const projects = await call('list_projects', {});
    assert.equal((projects.projects as Array<{ current: boolean }>).filter((p) => p.current).length, 1, 'the cwd’s project is current');

    const started = await call('start_run', { task: 'mock:done' });
    assert.equal(typeof started.id, 'string');
    let waited: Record<string, unknown> = { timedOut: true };
    for (let i = 0; i < 3 && waited.timedOut; i++) waited = await call('wait_for_runs', { runs: [{ runId: started.id }], timeoutS: 30 });
    assert.equal(waited.timedOut, false, 'a dry-run task settles');
    const run = await call('get_run', { runId: started.id as string });
    assert.equal(run.settled, true);
    await call('get_run_messages', { runId: started.id as string });
    const diff = await call('get_diff', { runId: started.id as string, patches: false });
    assert.ok(Array.isArray(diff.files), 'get_diff answers with the task’s files');

    assert.deepEqual(client.stray, [], 'stdout carries JSON-RPC only');
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
});
