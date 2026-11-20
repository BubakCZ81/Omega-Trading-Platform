const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalAiAssistant, PROVIDERS } = require('./local-ai.cjs');

function createAssistant(fetchImpl) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-local-ai-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`enc:${value}`),
    decryptString: buffer => buffer.toString().replace(/^enc:/, ''),
  };
  const assistant = new LocalAiAssistant({
    safeStorage,
    storagePath: path.join(directory, 'ai-keys.json'),
    localConfigPath: path.join(directory, 'local-ai.json'),
    fetchImpl: fetchImpl ?? (() => { throw new Error('network should not be used'); }),
  });
  return { assistant, directory };
}

test('exposes the supported providers plus the local endpoint', async () => {
  assert.deepEqual(Object.keys(PROVIDERS), ['gemini', 'groq', 'openrouter', 'anthropic', 'cohere', 'deepseek', 'mistral', 'together', 'zai', 'siliconflow', 'sambanova']);
  const { assistant } = createAssistant();
  const providers = await assistant.configuredProviders();
  assert.equal(providers.length, Object.keys(PROVIDERS).length + 1);
  assert.deepEqual(providers.at(-1), { id: 'local', name: 'Ollama / local AI API', configured: false });
});

test('completes Pine requests through every configured cloud provider adapter', async () => {
  const calls = [];
  let requestedProvider = '';
  const { assistant } = createAssistant(async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ provider: options.headers['x-goog-api-key'] ? 'gemini'
      : options.headers['x-api-key'] ? 'anthropic'
        : url.includes('cohere.ai') ? 'cohere' : requestedProvider,
    url, options, request });

    const provider = calls.at(-1).provider;
    const response = provider === 'gemini'
      ? { candidates: [{ content: { parts: [{ text: '  Pine answer  ' }] } }] }
      : provider === 'anthropic'
        ? { content: [{ text: '  Pine answer  ' }] }
        : provider === 'cohere'
          ? { text: '  Pine answer  ' }
          : { choices: [{ message: { content: '  Pine answer  ' } }] };
    return { ok: true, json: async () => response };
  });
  assistant.apiKey = async provider => `test-key-${provider}`;

  for (const provider of Object.keys(PROVIDERS)) {
    requestedProvider = provider;
    const result = await assistant.complete({
      provider,
      model: 'test-model',
      prompt: 'Explain the crossover.',
      source: 'plot(ta.ema(close, 9))',
      scriptName: 'EMA test',
    });
    assert.deepEqual(result, { text: 'Pine answer', model: 'test-model' }, provider);
  }

  assert.equal(calls.length, Object.keys(PROVIDERS).length);
  for (const call of calls) {
    assert.equal(call.url, PROVIDERS[call.provider].endpoint('test-model'), call.provider);
    assert.equal(call.options.method, 'POST', call.provider);
    assert.equal(call.options.signal instanceof AbortSignal, true, call.provider);
    if (call.provider === 'gemini') {
      assert.match(call.url, /:generateContent$/);
      assert.match(call.request.systemInstruction.parts[0].text, /Pine Script v6/);
      assert.match(call.request.contents[0].parts[0].text, /plot\(ta\.ema\(close, 9\)\)/);
    } else if (call.provider === 'anthropic') {
      assert.match(call.url, /\/messages$/);
      assert.match(call.request.system, /Pine Script v6/);
      assert.match(call.request.messages[0].content, /Explain the crossover\./);
    } else if (call.provider === 'cohere') {
      assert.match(call.url, /\/chat$/);
      assert.match(call.request.preamble, /Pine Script v6/);
      assert.match(call.request.message, /Explain the crossover\./);
    } else {
      assert.equal(call.request.messages[0].role, 'system', call.provider);
      assert.match(call.request.messages[0].content, /Pine Script v6/, call.provider);
      assert.match(call.request.messages[1].content, /plot\(ta\.ema\(close, 9\)\)/, call.provider);
      if (call.provider === 'openrouter') {
        assert.equal(call.options.headers['HTTP-Referer'], 'https://omega.local');
        assert.equal(call.options.headers['X-Title'], 'Omega Pine Assistant');
      }
    }
  }
});

test('testLocalConfig keeps explicitly selected OpenAI-compatible mode on port 11434', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: [{ id: 'local-model' }] }) };
  });
  const result = await assistant.testLocalConfig({
    baseUrl: 'http://127.0.0.1:11434/v1',
    ollama: false,
  });
  assert.deepEqual(result, { models: [{ id: 'local-model', name: 'local-model' }], defaultModel: 'local-model' });
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/models');
});

test('localConfig returns documented defaults when nothing is saved', async () => {
  const { assistant } = createAssistant();
  assert.deepEqual(await assistant.localConfig(), { baseUrl: 'http://127.0.0.1:11434/v1', model: '', hasApiKey: false, ollama: true });
});

test('saveLocalConfig normalises localhost URLs and persists them', async () => {
  const { assistant, directory } = createAssistant();
  const saved = await assistant.saveLocalConfig({ baseUrl: 'HTTP://127.0.0.1:1234/v1/', model: 'qwen2.5-coder' });
  assert.deepEqual(saved, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-coder', hasApiKey: false, ollama: false });
  assert.deepEqual(await assistant.localConfig(), { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-coder', hasApiKey: false, ollama: false });
  assert.equal(fs.existsSync(path.join(directory, 'local-ai.json')), true);

  const localhost = await assistant.saveLocalConfig({ baseUrl: 'http://localhost:1234', model: 'm' });
  assert.equal(localhost.baseUrl, 'http://localhost:1234/v1');
});

test('saveLocalConfig rejects non-local, insecure or ambiguous endpoints', async () => {
  const { assistant } = createAssistant();
  const cases = [
    'https://127.0.0.1:1234/v1',
    'http://example.com/v1',
    'http://user:pass@127.0.0.1:1234/v1',
    'http://127.0.0.1:1234/v1?key=1',
    'http://127.0.0.1:1234/v1#fragment',
    'not a url',
  ];
  for (const baseUrl of cases) {
    await assert.rejects(
      () => assistant.saveLocalConfig({ baseUrl, model: 'm' }),
      /localhost|valid localhost API URL/,
      baseUrl,
    );
  }
  await assert.rejects(() => assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: '' }), /model name/);
});

test('local API keys are encrypted on disk and reported as configured', async () => {
  const { assistant, directory } = createAssistant();
  const saved = await assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: 'sk-local-secret' });
  assert.equal(saved.hasApiKey, true);
  const raw = fs.readFileSync(path.join(directory, 'local-ai.json'), 'utf8');
  assert.doesNotMatch(raw, /sk-local-secret/);
  assert.match(raw, /"version":1/);

  const cleared = await assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', clearApiKey: true });
  assert.equal(cleared.hasApiKey, false);
});

test('testLocalConfig loads OpenAI-compatible models over plain HTTP', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        data: [
          { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
          { id: 'llama-3.1', name: null },
          { id: 42 },
          { id: 'x'.repeat(200) },
        ],
      }),
    };
  });

  const result = await assistant.testLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1' });
  assert.deepEqual(result, {
    models: [{ id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' }, { id: 'llama-3.1', name: 'llama-3.1' }],
    defaultModel: 'qwen2.5-coder',
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(calls[0].options.redirect, 'error');
});

test('testLocalConfig loads installed Ollama models from the native tags API on a custom port', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen3:8b', model: 'qwen3:8b', size: 5_200_000_000 },
          { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_000_000_000 },
          { name: 'invalid-model-name-that-is-too-long'.repeat(5) },
          { name: 42 },
        ],
      }),
    };
  });

  const result = await assistant.testLocalConfig({ baseUrl: 'http://127.0.0.1:11435/v1', ollama: true });
  assert.deepEqual(result, {
    models: [
      { id: 'qwen3:8b', name: 'qwen3:8b' },
      { id: 'llama3.2:latest', name: 'llama3.2:latest' },
    ],
    defaultModel: 'qwen3:8b',
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:11435/api/tags');
  assert.equal(calls[0].options.redirect, 'error');
});

test('custom Ollama port setting persists and is returned with local config', async () => {
  const { assistant } = createAssistant();
  const saved = await assistant.saveLocalConfig({
    baseUrl: 'http://localhost:11435/v1',
    model: 'qwen3:8b',
    ollama: true,
  });
  assert.deepEqual(saved, {
    baseUrl: 'http://localhost:11435/v1',
    model: 'qwen3:8b',
    hasApiKey: false,
    ollama: true,
  });
  assert.deepEqual(await assistant.localConfig(), saved);
});

test('testLocalConfig reports an empty Ollama model catalog', async () => {
  const { assistant } = createAssistant(async () => ({
    ok: true,
    json: async () => ({ models: [] }),
  }));
  assert.deepEqual(
    await assistant.testLocalConfig({ baseUrl: 'http://localhost:11434/v1' }),
    { models: [], defaultModel: '' },
  );
});

test('testLocalConfig gives a useful error when Ollama is unavailable', async () => {
  const { assistant } = createAssistant(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  await assert.rejects(
    assistant.testLocalConfig({ baseUrl: 'http://localhost:11434/v1' }),
    /Could not reach Ollama.*Start Ollama.*ECONNREFUSED/,
  );
});

test('runOllamaModel loads the saved model through the native API without sending a prompt', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ model: 'qwen3:8b', done: true }) };
  });
  await assistant.saveLocalConfig({
    baseUrl: 'http://127.0.0.1:11435/v1',
    model: 'qwen3:8b',
    ollama: true,
  });

  assert.deepEqual(await assistant.runOllamaModel({ model: 'qwen3:8b' }), { model: 'qwen3:8b', loaded: true });
  assert.equal(calls[0].url, 'http://127.0.0.1:11435/api/generate');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'qwen3:8b', stream: false, keep_alive: '5m' });
  assert.equal('prompt' in JSON.parse(calls[0].options.body), false);
  await assert.rejects(assistant.runOllamaModel({ model: 'another-model' }), /Select and save the Ollama model/);
});

test('unloadOllamaModel uses keep_alive zero for the selected saved model', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ model: 'qwen3:8b', done: true }) };
  });
  await assistant.saveLocalConfig({
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    ollama: true,
  });

  assert.deepEqual(await assistant.unloadOllamaModel({ model: 'qwen3:8b' }), { model: 'qwen3:8b', unloaded: true });
  assert.equal(calls[0].url, 'http://localhost:11434/api/generate');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'qwen3:8b', stream: false, keep_alive: 0 });
});

test('cancelCompletion aborts the matching in-flight provider request', async () => {
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const { assistant } = createAssistant(async (_url, options) => {
    markStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  await assistant.saveLocalConfig({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'provider:model',
    ollama: false,
  });
  const completion = assistant.complete({
    provider: 'local',
    model: 'provider:model',
    prompt: 'hello',
    source: '',
    scriptName: 'test',
    requestId: 'request-123',
  });
  await started;
  assert.equal(assistant.cancelCompletion('request-123'), true);
  await assert.rejects(completion, { name: 'AbortError' });
  assert.equal(assistant.cancelCompletion('request-123'), false);
});

test('cancelAllCompletions releases every in-flight provider request', async () => {
  const started = [];
  const { assistant } = createAssistant(async (_url, options) => {
    started.push(options.signal);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  });
  await assistant.saveLocalConfig({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'provider:model',
    ollama: false,
  });
  const requests = ['request-one', 'request-two'].map(requestId => assistant.complete({
    provider: 'local',
    model: 'provider:model',
    prompt: 'hello',
    source: '',
    scriptName: 'test',
    requestId,
  }));
  while (started.length < 2) await new Promise(resolve => setImmediate(resolve));

  assert.equal(assistant.cancelAllCompletions(), 2);
  assert.equal(assistant.cancelAllCompletions(), 0);
  await Promise.all(requests.map(request => assert.rejects(request, { name: 'AbortError' })));
});

test('normalises Cherry Studio Authorization header when testing and saving the local key', async () => {
  const calls = [];
  const { assistant } = createAssistant(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => url.endsWith('/models')
        ? ({ data: [{ id: 'provider:model' }] })
        : ({ choices: [{ message: { content: 'ok' } }] }),
    };
  });
  await assistant.testLocalConfig({
    baseUrl: 'http://127.0.0.1:23333/v1',
    apiKey: 'Authorization: Bearer cs-sk-test',
  });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer cs-sk-test');
  await assistant.saveLocalConfig({
    baseUrl: 'http://127.0.0.1:23333/v1',
    model: 'provider:model',
    apiKey: 'Bearer cs-sk-test',
  });
  const completion = await assistant.complete({
    provider: 'local',
    model: 'provider:model',
    prompt: 'hello',
    source: '',
    scriptName: 'test',
  });
  assert.equal(completion.text, 'ok');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer cs-sk-test');
});

test('readLocalConfig refuses unsupported settings files', async () => {
  const { assistant, directory } = createAssistant();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'local-ai.json'), JSON.stringify({ version: 2, baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', encryptedApiKey: '' }));
  await assert.rejects(() => assistant.readLocalConfig(), /unsupported format/);
});

test('a corrupt key or endpoint store can be repaired from the app', async () => {
  const { assistant, directory } = createAssistant();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'ai-keys.json'), '{ this is not json');
  fs.writeFileSync(path.join(directory, 'local-ai.json'), 'not json either');

  // Reading still succeeds and reports everything as unconfigured.
  const providers = await assistant.configuredProviders();
  assert.equal(providers.find(provider => provider.id === 'gemini').configured, false);
  assert.deepEqual(await assistant.localConfig(), { baseUrl: 'http://127.0.0.1:11434/v1', model: '', hasApiKey: false, ollama: true });

  // Saving rewrites both stores, so the user can recover without deleting files.
  await assistant.saveKey('groq', 'gsk-test-key');
  const repaired = await assistant.configuredProviders();
  assert.equal(repaired.find(provider => provider.id === 'groq').configured, true);
  await assistant.saveLocalConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen' });
  assert.equal((await assistant.localConfig()).model, 'qwen');

  // Clearing also succeeds against the repaired store.
  const cleared = await assistant.clearKey('groq');
  assert.equal(cleared.find(provider => provider.id === 'groq').configured, false);
});
