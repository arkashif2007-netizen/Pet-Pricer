import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * End-to-end check that the MCP server actually speaks the protocol, not just
 * that it compiles. It runs entirely offline against a seeded fixture, so it
 * is safe in CI and does not touch the market.
 *
 * This matters because an MCP server is easy to write and easy to get subtly
 * wrong: nothing writes to stdout, the handshake completes, tools are listed
 * with schemas, and a call returns usable text.
 */

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const projectRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function seed(dbPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/seed-fixture.ts', '--db', dbPath], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`seed failed (${code}): ${stderr}`))
    );
  });
}

class McpClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: string[] = [];

  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (value: JsonRpcResponse) => void>();

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, ['src/mcp/cli.ts'], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line.length > 0) this.dispatch(line);
        index = this.buffer.indexOf('\n');
      }
    });
    // stdout must carry protocol frames only; diagnostics belong on stderr.
    this.child.stderr.on('data', (chunk: Buffer) => this.stderr.push(chunk.toString()));
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      throw new Error(`non-JSON frame on stdout: ${line.slice(0, 200)}`);
    }
    if (typeof message.id === 'number') {
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr: ${this.stderr.join('')}`));
      }, 20_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
    return this.request('tools/call', { name, arguments: args }).then((response) => {
      assert.equal(response.error, undefined, `tools/call ${name} errored: ${JSON.stringify(response.error)}`);
      return response.result as ToolCallResult;
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      this.child.once('close', () => resolve());
      setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3_000);
    });
  }
}

const textOf = (result: ToolCallResult): string =>
  result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('MCP server over stdio', () => {
  let dir: string;
  let client: McpClient;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'starpets-mcp-'));
    const dbPath = join(dir, 'fixture.sqlite');
    await seed(dbPath);
    client = new McpClient({ STARPETS_DB: dbPath });

    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
    client.notify('notifications/initialized');
  });

  after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares itself as a server', async () => {
    // The handshake completed in `before`; assert the shape of what came back.
    const listed = await client.request('tools/list');
    const result = listed.result as { tools: Array<{ name: string; description?: string }> };
    assert.ok(Array.isArray(result.tools));
    assert.ok(result.tools.length >= 5);
  });

  it('exposes the expected tool set', async () => {
    const listed = await client.request('tools/list');
    const names = (listed.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'find_pet',
      'get_order_book',
      'get_pet',
      'market_status',
      'price_history',
      'scan_opportunities',
    ]);
  });

  it('describes every tool so a model can choose between them', async () => {
    const listed = await client.request('tools/list');
    const tools = (listed.result as { tools: Array<{ name: string; description?: string }> }).tools;
    for (const tool of tools) {
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
    }
  });

  it('reports snapshot status', async () => {
    const text = textOf(await client.callTool('market_status'));
    assert.match(text, /4 pets/);
    assert.match(text, /break-even ratio: 5\.333x/);
    assert.match(text, /fee: 25%/);
  });

  it('scans and returns only profitable candidates by default', async () => {
    const text = textOf(await client.callTool('scan_opportunities'));
    assert.match(text, /break-even ratio 5\.333x/);
    assert.match(text, /Dragonfruit Fox/);
    // The three loss-making pets must be absent from the default view.
    assert.doesNotMatch(text, /Three Blind Mice/);
    assert.doesNotMatch(text, /Sushi Penguin/);
    assert.doesNotMatch(text, /Dango Penguins/);
  });

  it('states the break-even rule even when nothing qualifies', async () => {
    const result = await client.callTool('scan_opportunities', { max_normal_price: 0.01 });
    const text = textOf(result);
    assert.match(text, /No candidates matched/);
    assert.match(text, /just to break even/);
  });

  it('explains a single pet with the evidence behind the verdict', async () => {
    const text = textOf(await client.callTool('get_pet', { pet: 'Dango Penguins' }));
    assert.match(text, /verdict: skip/);
    assert.match(text, /neon ask: \$3\.07 at reborn/);
    assert.match(text, /neon rungs walked/);
    // Every rung is listed, proving the ladder was walked rather than assumed.
    assert.match(text, /twinkle/);
    assert.match(text, /luminous/);
  });

  it('resolves a pet from a loose name', async () => {
    const text = textOf(await client.callTool('get_pet', { pet: 'dragonfruit' }));
    assert.match(text, /Dragonfruit Fox/);
    assert.match(text, /verdict: craft/);
  });

  it('explains an unknown pet instead of failing opaquely', async () => {
    const result = await client.callTool('get_pet', { pet: 'definitely-not-a-pet' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No pet matching/);
  });

  it('applies a caller-supplied fee', async () => {
    // At a 0% fee three of the four pets look profitable, which is exactly the
    // trap the 25% default exists to avoid.
    const text = textOf(await client.callTool('scan_opportunities', { fee_pct: 0, verdict: 'all' }));
    assert.match(text, /break-even ratio 4\.000x/);
    assert.match(text, /Sushi Penguin/);
  });

  it('searches the catalog', async () => {
    const text = textOf(await client.callTool('find_pet', { query: 'penguin' }));
    assert.match(text, /Dango Penguins/);
    assert.match(text, /Sushi Penguin/);
  });

  it('reports price history', async () => {
    const text = textOf(await client.callTool('price_history', { pet: 'dango_penguins', hours: 24 }));
    assert.match(text, /normal: 1 observations/);
    assert.match(text, /drift/);
  });

  it('keeps stdout clean so the protocol is not corrupted', () => {
    assert.ok(client.stderr.join('').includes('[mcp] ready'));
  });
});
