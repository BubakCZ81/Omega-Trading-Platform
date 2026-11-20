const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LlamaCppManager } = require('./llama-cpp.cjs');

function createManager(t, { fetchImpl, spawnImpl } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-llama-cpp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtimeDirectory = path.join(directory, 'runtime');
  const modelDirectory = path.join(directory, 'models');
  fs.mkdirSync(runtimeDirectory);
  fs.mkdirSync(modelDirectory);
  const serverName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  fs.writeFileSync(path.join(runtimeDirectory, serverName), '');
  const modelPath = path.join(modelDirectory, 'qwen-coder.gguf');
  fs.writeFileSync(modelPath, 'test-model');

  const manager = new LlamaCppManager({
    configPath: path.join(directory, 'llama-cpp.json'),
    runtimeDirectory,
    modelDirectory,
    fetchImpl: fetchImpl ?? (async () => new Response('ok')),
    spawnImpl: spawnImpl ?? (() => new EventEmitter()),
  });
  return { manager, directory, modelDirectory, modelPath, runtimeDirectory };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

test('discovers nested GGUF models and ignores hidden paths', t => {
  const { manager, modelDirectory, modelPath } = createManager(t);
  fs.mkdirSync(path.join(modelDirectory, 'nested'));
  fs.writeFileSync(path.join(modelDirectory, 'nested', 'small.gguf'), 'small');
  fs.mkdirSync(path.join(modelDirectory, '.hidden'));
  fs.writeFileSync(path.join(modelDirectory, '.hidden', 'secret.gguf'), 'hidden');
  fs.writeFileSync(path.join(modelDirectory, 'not-a-model.bin'), 'other');

  const catalog = manager.listModels();
  assert.equal(catalog.directory, modelDirectory);
  assert.deepEqual(catalog.models.map(model => model.path), [
    path.join(modelDirectory, 'nested', 'small.gguf'),
    modelPath,
  ]);
  assert.equal(catalog.models[1].sizeBytes, Buffer.byteLength('test-model'));
});

test('starts a selected model, sends Pine context, and stops its local server', async t => {
  const spawned = [];
  const requests = [];
  const child = new FakeChild();
  const { manager, modelPath, runtimeDirectory } = createManager(t, {
    spawnImpl: (server, args, options) => {
      spawned.push({ server, args, options });
      return child;
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/health')) return new Response('ok');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '  Pine answer  ' } }],
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  const started = await manager.start('chat', modelPath);
  assert.equal(started.chat.isLoaded, true);
  assert.equal(started.chat.isRunning, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].server, path.join(runtimeDirectory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'));
  assert.equal(spawned[0].args[spawned[0].args.indexOf('-m') + 1], modelPath);
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(spawned[0].options.windowsHide, true);

  const completion = await manager.complete('chat', {
    prompt: 'Explain this strategy.',
    source: 'plot(ta.ema(close, 9))',
    scriptName: 'EMA test',
  });
  assert.deepEqual(completion, { text: 'Pine answer', model: 'qwen-coder.gguf' });
  const request = requests.find(item => item.url.endsWith('/v1/chat/completions'));
  assert.ok(request);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'qwen-coder.gguf');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /Pine Script coding assistant/);
  assert.match(body.messages[1].content, /EMA test/);
  assert.match(body.messages[1].content, /plot\(ta\.ema\(close, 9\)\)/);

  const stopped = await manager.stop('chat');
  assert.equal(child.killed, true);
  assert.equal(stopped.chat.isRunning, false);
  assert.equal(stopped.chat.isLoaded, false);
  assert.equal(stopped.chat.endpoint, '');
});

test('isolates inline inference settings from the chat model role', async t => {
  const argsByRole = [];
  const requestBodies = [];
  const { manager, modelPath } = createManager(t, {
    spawnImpl: (_server, args) => {
      argsByRole.push(args);
      return new FakeChild();
    },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/health')) return new Response('ok');
      requestBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'plot(close)' } }],
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await manager.start('inline', modelPath);
  assert.equal(result.inline.isLoaded, true);
  assert.equal(result.chat.isLoaded, false);
  assert.equal(argsByRole[0][argsByRole[0].indexOf('-c') + 1], '4096');
  await manager.complete('inline', { prompt: 'Complete the plot.', source: 'plot(', scriptName: 'Inline' });
  assert.equal(requestBodies[0].max_tokens, 300);
  assert.equal(requestBodies[0].temperature, 0.15);
});

test('refuses unknown roles and model paths outside the selected catalog', async t => {
  let spawnCount = 0;
  const { manager, directory, modelPath } = createManager(t, {
    spawnImpl: () => { spawnCount += 1; return new FakeChild(); },
  });
  await assert.rejects(manager.start('unknown', modelPath), /Choose Chat AI or Inline AI/);
  await assert.rejects(manager.start('chat', path.join(directory, 'outside.gguf')), /outside the configured model folder/);
  await assert.rejects(manager.start('chat', path.join(directory, 'outside.txt')), /Choose a GGUF model/);
  assert.equal(spawnCount, 0);
});

test('reports model-server exit and refuses completion when the server is not ready', async t => {
  const child = new FakeChild();
  let completionRequests = 0;
  const { manager, modelPath } = createManager(t, {
    spawnImpl: () => child,
    fetchImpl: async url => {
      if (String(url).endsWith('/health')) return new Response('not ready', { status: 503 });
      completionRequests += 1;
      return new Response('{}');
    },
  });
  await manager.start('chat', modelPath);
  child.emit('close', 2);
  const status = await manager.status();
  assert.match(status.chat.error, /exited with code 2/);
  await assert.rejects(
    manager.complete('chat', { prompt: 'hello', source: '', scriptName: 'test' }),
    /exited with code 2/,
  );
  assert.equal(completionRequests, 0);
});

test('validates request shape and fails explicitly for empty model responses', async t => {
  const { manager, modelPath } = createManager(t, {
    spawnImpl: () => new FakeChild(),
    fetchImpl: async url => String(url).endsWith('/health')
      ? new Response('ok')
      : new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  await manager.start('chat', modelPath);
  await assert.rejects(manager.complete('chat', { prompt: 'x'.repeat(20_001), source: '', scriptName: '' }), /invalid or too large/);
  await assert.rejects(manager.complete('chat', { prompt: 'valid', source: '', scriptName: '' }), /returned no text/);
});
