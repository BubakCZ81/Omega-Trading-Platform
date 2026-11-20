const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROLES = new Set(['chat', 'inline']);

class LlamaCppManager {
  constructor({ configPath, runtimeDirectory, modelDirectory, fetchImpl = fetch, spawnImpl = spawn } = {}) {
    this.configPath = configPath;
    this.runtimeDirectory = runtimeDirectory;
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.children = new Map();
    this.roles = new Map(['chat', 'inline'].map(role => [role, {
      role, modelPath: '', endpoint: '', isLoaded: false, starting: false, error: '', logs: [], startedAt: 0,
    }]));
    this.modelDirectory = this.loadModelDirectory(modelDirectory);
  }

  loadModelDirectory(fallback) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (typeof saved.modelDirectory === 'string' && saved.modelDirectory.trim()) return saved.modelDirectory.trim();
    } catch { /* First run or unreadable config: use the provided model directory. */ }
    return fallback || process.env.OMEGA_GGUF_DIRECTORY || 'D:\\Programy\\AI\\MODELY';
  }

  saveModelDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new TypeError('Choose an existing folder for GGUF models.');
    }
    this.modelDirectory = directory;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify({ modelDirectory: directory }), 'utf8');
    return this.modelDirectory;
  }

  listModels() {
    const result = [];
    const stack = [this.modelDirectory];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(fullPath);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
          const stats = fs.statSync(fullPath);
          result.push({ path: fullPath, name: entry.name, sizeBytes: stats.size });
        }
      }
    }
    result.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
    return { directory: this.modelDirectory, models: result };
  }

  resolveServer() {
    const explicit = process.env.OMEGA_LLAMA_SERVER;
    if (explicit && fs.existsSync(explicit)) return explicit;
    const directories = [
      this.runtimeDirectory,
      process.env.VELA_LLAMA_RUNTIME,
      path.join(__dirname, 'llama-cuda12'),
      'D:\\PINESTUDIO\\llama-cuda12',
    ].filter(Boolean);
    const filename = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    for (const directory of directories) {
      const server = path.join(directory, filename);
      if (fs.existsSync(server)) return server;
    }
    throw new Error('llama-server was not found. Set OMEGA_LLAMA_RUNTIME to the llama.cpp runtime folder.');
  }

  appendLog(role, message) {
    const state = this.roles.get(role);
    if (!state) return;
    state.logs.push(`${new Date().toISOString()} ${message}`);
    if (state.logs.length > 60) state.logs.splice(0, state.logs.length - 60);
  }

  async start(role, modelPath) {
    if (!ROLES.has(role)) throw new TypeError('Choose Chat AI or Inline AI.');
    if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath) || !modelPath.toLowerCase().endsWith('.gguf')) throw new TypeError('Choose a GGUF model from the model list.');
    const catalog = this.listModels().models;
    if (!catalog.some(model => path.resolve(model.path) === path.resolve(modelPath))) throw new Error('The selected GGUF file is outside the configured model folder. Refresh the model list and select it again.');
    const existing = this.children.get(role);
    const state = this.roles.get(role);
    if (existing && !existing.killed && state.modelPath === modelPath) return this.status();

    const server = this.resolveServer();
    if (existing && !existing.killed) existing.kill();
    state.modelPath = modelPath;
    state.endpoint = '';
    state.isLoaded = false;
    state.starting = true;
    state.error = '';
    state.logs = [];
    state.startedAt = Date.now();
    const port = await this.reservePort();
    const inline = role === 'inline';
    const args = [
      '-m', modelPath,
      '-ngl', 'auto',
      '--fit', 'on', '--fit-target', inline ? '128' : '256',
      '--flash-attn', 'auto', '--reasoning', 'off', '--reasoning-budget', '0',
      '-b', inline ? '512' : '1024', '-ub', inline ? '128' : '256',
      '-t', inline ? '4' : '6', '-tb', inline ? '4' : '6',
      '-c', inline ? '4096' : '8192', '--parallel', '1',
      '--host', '127.0.0.1', '--port', String(port),
    ];
    const child = this.spawnImpl(server, args, { cwd: path.dirname(server), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(role, child);
    state.endpoint = `http://127.0.0.1:${port}`;
    const capture = stream => stream.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) this.appendLog(role, line.slice(0, 500));
    });
    capture(child.stdout);
    capture(child.stderr);
    child.once('error', error => {
      if (this.children.get(role) !== child) return;
      state.starting = false;
      state.isLoaded = false;
      state.error = error.message;
      this.appendLog(role, `Process error: ${error.message}`);
    });
    child.once('close', code => {
      if (this.children.get(role) !== child) return;
      this.children.delete(role);
      state.starting = false;
      state.isLoaded = false;
      if (code !== 0 && code !== null) state.error = `llama.cpp exited with code ${code}.`;
      this.appendLog(role, `Process exited with code ${code}.`);
    });
    this.appendLog(role, `Loading ${path.basename(modelPath)} for ${role === 'chat' ? 'Chat AI' : 'Inline AI'}.`);
    return this.status();
  }

  async reservePort() {
    const { createServer } = require('node:net');
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(error => error
          ? reject(error)
          : typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No local port is available.')));
      });
    });
  }

  async roleStatus(role) {
    const state = this.roles.get(role);
    const child = this.children.get(role);
    let isLoaded = false;
    if (child && !child.killed && state.endpoint) {
      isLoaded = await this.fetchImpl(`${state.endpoint}/health`, { signal: AbortSignal.timeout(1200) })
        .then(response => response.ok).catch(() => false);
    }
    state.isLoaded = isLoaded;
    if (isLoaded) state.starting = false;
    return { ...state, isRunning: Boolean(child && !child.killed) };
  }

  async status() {
    const [chat, inline] = await Promise.all([this.roleStatus('chat'), this.roleStatus('inline')]);
    return { directory: this.modelDirectory, chat, inline };
  }

  async stop(role) {
    if (!ROLES.has(role)) throw new TypeError('Choose Chat AI or Inline AI.');
    const child = this.children.get(role);
    if (child && !child.killed) child.kill();
    this.children.delete(role);
    const state = this.roles.get(role);
    state.isLoaded = false;
    state.starting = false;
    state.endpoint = '';
    state.error = '';
    this.appendLog(role, 'Model stopped.');
    return this.status();
  }

  async complete(role, request) {
    if (!ROLES.has(role)) throw new TypeError('Choose Chat AI or Inline AI.');
    const state = this.roles.get(role);
    const health = await this.roleStatus(role);
    if (!health.isLoaded) throw new Error(health.error || `${role === 'chat' ? 'Chat' : 'Inline'} llama.cpp model is not ready.`);
    if (!request || typeof request.prompt !== 'string' || request.prompt.length > 20000 || typeof request.source !== 'string' || request.source.length > 100000) {
      throw new TypeError('The local model request is invalid or too large.');
    }
    const response = await this.fetchImpl(`${state.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(role === 'inline' ? 30000 : 120000),
      body: JSON.stringify({
        model: path.basename(state.modelPath),
        temperature: role === 'inline' ? 0.15 : 0.2,
        max_tokens: role === 'inline' ? 300 : 4096,
        messages: [
          { role: 'system', content: `You are ${role === 'inline' ? 'an inline Pine Script v6 code completion model' : 'a Pine Script coding assistant'}. Keep outputs accurate and concise.` },
          { role: 'user', content: `${request.prompt}\n\nScript: ${request.scriptName || 'Pine script'}\n\nFull current Pine source:\n\`\`\`pine\n${request.source}\n\`\`\`` },
        ],
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || result.error || `llama.cpp request failed (${response.status}).`);
    const text = result.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('The local model returned no text.');
    return { text: text.trim(), model: path.basename(state.modelPath) };
  }

  stopAll() {
    for (const [role, child] of this.children) {
      if (!child.killed) child.kill();
      this.children.delete(role);
      const state = this.roles.get(role);
      state.isLoaded = false;
      state.starting = false;
    }
  }
}

module.exports = { LlamaCppManager };
