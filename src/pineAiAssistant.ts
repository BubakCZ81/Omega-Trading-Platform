export interface PineAiProviderStatus {
  id: 'local' | 'gemini' | 'groq' | 'openrouter' | 'anthropic' | 'cohere' | 'deepseek' | 'mistral' | 'together' | 'zai' | 'siliconflow' | 'sambanova';
  name: string;
  configured: boolean;
}

interface PineAiModel {
  id: string;
  name: string;
}

interface PineAiBridge {
  providers(): Promise<PineAiProviderStatus[]>;
  saveKey(provider: PineAiProviderStatus['id'], apiKey: string): Promise<PineAiProviderStatus[]>;
  clearKey(provider: PineAiProviderStatus['id']): Promise<PineAiProviderStatus[]>;
  testKey(provider: PineAiProviderStatus['id'], apiKey?: string): Promise<{
    provider: PineAiProviderStatus['id'];
    models: PineAiModel[];
    defaultModel: string;
    providers: PineAiProviderStatus[];
  }>;
  localConfig(): Promise<{ baseUrl: string; model: string; hasApiKey: boolean; ollama: boolean }>;
  saveLocalConfig(request: { baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean; ollama?: boolean }): Promise<{ baseUrl: string; model: string; hasApiKey: boolean; ollama: boolean }>;
  testLocalConfig(request: { baseUrl: string; apiKey?: string; ollama?: boolean }): Promise<{ models: PineAiModel[]; defaultModel: string }>;
  runOllamaModel(request: { model: string }): Promise<{ model: string; loaded: boolean }>;
  unloadOllamaModel(request: { model: string }): Promise<{ model: string; unloaded: boolean }>;
  cancelCompletion(requestId: string): Promise<boolean>;
  llamaModels(): Promise<{ directory: string; models: Array<{ path: string; name: string; sizeBytes: number }> }>;
  llamaStatus(): Promise<{ directory: string; chat: LlamaCppRoleStatus; inline: LlamaCppRoleStatus }>;
  startLlama(role: 'chat' | 'inline', modelPath: string): Promise<{ directory: string; chat: LlamaCppRoleStatus; inline: LlamaCppRoleStatus }>;
  stopLlama(role: 'chat' | 'inline'): Promise<{ directory: string; chat: LlamaCppRoleStatus; inline: LlamaCppRoleStatus }>;
  llamaComplete(request: { role: 'chat' | 'inline'; prompt: string; source: string; scriptName: string }): Promise<{ text: string; model: string }>;
  chooseLlamaFolder(): Promise<{ directory: string; models: Array<{ path: string; name: string; sizeBytes: number }> } | null>;
  complete(request: {
    provider: PineAiProviderStatus['id'];
    model: string;
    prompt: string;
    source: string;
    scriptName: string;
    useLuxAlgoMcp?: boolean;
    requestId?: string;
  }): Promise<{ text: string; model: string }>;
}

interface LlamaCppRoleStatus {
  role: 'chat' | 'inline';
  modelPath: string;
  endpoint: string;
  isLoaded: boolean;
  starting: boolean;
  isRunning: boolean;
  error: string;
  logs: string[];
  startedAt: number;
}

declare global {
  interface Window {
    velaAi?: PineAiBridge;
  }
}

interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AiConversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: AiChatMessage[];
}

export interface PineAiAssistant {
  setStatus(message: string, isError?: boolean): void;
}

export interface PineAiAssistantOptions {
  getCurrentScriptName(): string;
  getEditorValue(): string;
  applyCodeToEditor?(code: string, mode: 'insert' | 'replace-selection' | 'replace-document'): void;
  manageReferenceResize?: boolean;
}

const historyStorageKey = 'omega_pine_ai_conversations';
const defaultModels: Record<PineAiProviderStatus['id'], string> = {
  local: '',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
  anthropic: 'claude-3-5-sonnet-20241022',
  cohere: 'command-r-plus',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
  zai: 'glm-4.7-flash',
  siliconflow: 'Qwen/Qwen2.5-Coder-7B-Instruct',
  sambanova: 'Meta-Llama-3.3-70B-Instruct',
};
const localEndpointPresets: Record<string, { baseUrl: string; hint: string }> = {
  cherry: { baseUrl: 'http://127.0.0.1:23333/v1', hint: 'Cherry Studio Gateway' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', hint: 'LM Studio' },
  atomic: { baseUrl: 'http://127.0.0.1:1337/v1', hint: 'Atomic Chat' },
  koboldcpp: { baseUrl: 'http://127.0.0.1:5001/v1', hint: 'KoboldCpp' },
  msty: { baseUrl: 'http://127.0.0.1:3939/v1', hint: 'Msty Nexus' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', hint: 'Ollama OpenAI-compatible API' },
};
const codeBlockPattern = /```([a-zA-Z0-9_-]*)\s*\r?\n([\s\S]*?)```/g;

function newConversationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadConversations(): AiConversation[] {
  try {
    const raw = localStorage.getItem(historyStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AiConversation => Boolean(item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.title === 'string' && Number.isFinite(item.updatedAt)
      && Array.isArray(item.messages)
      && item.messages.every((message: unknown) => Boolean(message && typeof message === 'object'
        && ['user', 'assistant'].includes((message as AiChatMessage).role)
        && typeof (message as AiChatMessage).content === 'string'))));
  } catch (error) {
    console.error('Could not load saved AI conversations:', error);
    return [];
  }
}

function conversationTitle(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim();
  return title.length > 58 ? `${title.slice(0, 55)}…` : title || 'New conversation';
}

function makeConversationPrompt(messages: AiChatMessage[], latestPrompt: string, priorConversations: AiConversation[]): string {
  const prior = messages.slice(0, -1);
  const lines: string[] = [];
  let length = 0;
  for (let index = prior.length - 1; index >= 0 && lines.length < 16; index--) {
    const message = prior[index];
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(-3500)}`;
    if (length + line.length > 14_000) break;
    lines.unshift(line);
    length += line.length;
  }
  const memoryLines: string[] = [];
  let memoryLength = 0;
  for (const conversation of priorConversations.sort((left, right) => right.updatedAt - left.updatedAt)) {
    const excerpt = conversation.messages.slice(-4)
      .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content.slice(-900)}`)
      .join('\n');
    if (!excerpt || memoryLength + excerpt.length > 8_000) break;
    memoryLines.push(`Conversation: ${conversation.title}\n${excerpt}`);
    memoryLength += excerpt.length;
  }
  return `${memoryLines.length ? `Relevant memory from earlier saved conversations (context only; do not expose it unless useful):\n${memoryLines.join('\n\n')}\n\n` : ''}${lines.length ? `Earlier messages in this conversation:\n${lines.join('\n\n')}\n\n` : ''}Latest user message:\n${latestPrompt}`;
}

export function createPineAiAssistant(options: PineAiAssistantOptions): PineAiAssistant {
  const panel = document.getElementById('pine-ai-assistant') as HTMLElement;
  const toggle = document.getElementById('btn-ai-assistant') as HTMLButtonElement;
  const provider = document.getElementById('pine-ai-provider') as HTMLSelectElement;
  const model = document.getElementById('pine-ai-model') as HTMLSelectElement;
  const key = document.getElementById('pine-ai-key') as HTMLInputElement;
  const cloudSettings = document.getElementById('pine-ai-cloud-settings') as HTMLDivElement;
  const localSettings = document.getElementById('pine-ai-local-settings') as HTMLDivElement;
  const localPreset = document.getElementById('pine-ai-local-preset') as HTMLSelectElement;
  const localUrl = document.getElementById('pine-ai-local-url') as HTMLInputElement;
  const localKey = document.getElementById('pine-ai-local-key') as HTMLInputElement;
  const localModelSearch = document.getElementById('pine-ai-local-model-search') as HTMLInputElement;
  const localModel = document.getElementById('pine-ai-local-model') as HTMLSelectElement;
  const ollamaStatus = document.getElementById('pine-ai-ollama-status') as HTMLSpanElement;
  const testLocal = document.getElementById('pine-ai-test-local') as HTMLButtonElement;
  const saveLocal = document.getElementById('pine-ai-save-local') as HTMLButtonElement;
  const unloadOllama = document.getElementById('pine-ai-unload-model') as HTMLButtonElement;
  const clearLocalKey = document.getElementById('pine-ai-clear-local-key') as HTMLButtonElement;
  const llamaDirectory = document.getElementById('pine-ai-llama-directory') as HTMLSpanElement;
  const llamaBrowse = document.getElementById('pine-ai-llama-browse') as HTMLButtonElement;
  const llamaChatModel = document.getElementById('pine-ai-llama-chat-model') as HTMLSelectElement;
  const llamaInlineModel = document.getElementById('pine-ai-llama-inline-model') as HTMLSelectElement;
  const llamaChatLoad = document.getElementById('pine-ai-llama-chat-load') as HTMLButtonElement;
  const llamaChatStop = document.getElementById('pine-ai-llama-chat-stop') as HTMLButtonElement;
  const llamaInlineLoad = document.getElementById('pine-ai-llama-inline-load') as HTMLButtonElement;
  const llamaInlineStop = document.getElementById('pine-ai-llama-inline-stop') as HTMLButtonElement;
  const llamaChatStatus = document.getElementById('pine-ai-llama-chat-status') as HTMLSpanElement;
  const llamaInlineStatus = document.getElementById('pine-ai-llama-inline-status') as HTMLSpanElement;
  const prompt = document.getElementById('pine-ai-prompt') as HTMLTextAreaElement;
  const status = document.getElementById('pine-ai-status') as HTMLParagraphElement;
  const luxAlgoEnabled = document.getElementById('pine-ai-luxalgo-enabled') as HTMLInputElement;
  const allowAiEdit = document.getElementById('pine-ai-allow-edit') as HTMLInputElement;
  const inlineAiEnabled = document.getElementById('pine-ai-inline-enabled') as HTMLInputElement;
  const optionalFeatures = document.getElementById('pine-ai-options') as HTMLDetailsElement;
  const chat = document.getElementById('pine-ai-chat') as HTMLDivElement;
  const history = document.getElementById('pine-ai-history') as HTMLDivElement;
  const workspace = document.getElementById('pine-ai-workspace') as HTMLDivElement;
  const conversationTitleElement = document.getElementById('pine-ai-conversation-title') as HTMLParagraphElement;
  const modelStatus = document.getElementById('pine-ai-model-status') as HTMLSpanElement;
  const historyToggle = document.getElementById('pine-ai-history-toggle') as HTMLButtonElement;
  const settings = document.getElementById('pine-ai-settings') as HTMLDetailsElement;
  const saveKey = document.getElementById('pine-ai-save-key') as HTMLButtonElement;
  const testKey = document.getElementById('pine-ai-test-key') as HTMLButtonElement;
  const clearKey = document.getElementById('pine-ai-clear-key') as HTMLButtonElement;
  const ask = document.getElementById('pine-ai-ask') as HTMLButtonElement;
  const stop = document.getElementById('pine-ai-stop') as HTMLButtonElement;
  const close = document.getElementById('pine-ai-close') as HTMLButtonElement;
  const newButton = document.getElementById('pine-ai-new') as HTMLButtonElement;
  const resize = document.getElementById('pine-ai-resize') as HTMLElement;
  const reference = document.getElementById('pine-reference') as HTMLElement;
  const referenceToggle = document.getElementById('btn-pine-reference') as HTMLButtonElement;
  const referenceResize = document.getElementById('pine-reference-resize') as HTMLElement;
  const aiModels = new Map<PineAiProviderStatus['id'], PineAiModel[]>();
  const configuredProviders = new Map<PineAiProviderStatus['id'], boolean>();
  let localModelCatalog: PineAiModel[] = [];
  let localModelSelection = '';
  let localModelLoadRequest = 0;
  let localModelRefreshTimer = 0;
  let localEndpointIsOllama = false;
  let ollamaModelBusy = false;
  let activeCompletionId = '';
  let activeCompletionIsLlama = false;
  let activeCompletionStopRequested = false;
  let llamaCatalog: Array<{ path: string; name: string; sizeBytes: number }> = [];
  let llamaPollTimer = 0;
  let conversations = loadConversations();
  let activeConversationId = conversations[0]?.id ?? '';
  const storedProvider = localStorage.getItem('omega_ai_provider');
  if (storedProvider && [...provider.options].some(option => option.value === storedProvider)) provider.value = storedProvider;
  luxAlgoEnabled.checked = localStorage.getItem('omega_ai_luxalgo_mcp') === 'true';
  allowAiEdit.checked = localStorage.getItem('omega_ai_allow_edit') === 'true';
  inlineAiEnabled.checked = localStorage.getItem('omega_ai_inline_completions') === 'true';

  const setStatus = (message: string, isError = false, state?: 'loading') => {
    status.textContent = message;
    if (isError) status.dataset.state = 'error';
    else if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };

  const selectedLocalModel = () => localModel.value.trim() || localModelSelection.trim();

  const syncLocalPreset = () => {
    const matched = Object.entries(localEndpointPresets).find(([id, preset]) => id !== 'ollama' && preset.baseUrl === localUrl.value.trim());
    localPreset.value = localEndpointIsOllama ? 'ollama' : matched?.[0] ?? 'custom';
    ollamaStatus.hidden = !localEndpointIsOllama;
    testLocal.textContent = localEndpointIsOllama ? 'Refresh Ollama models' : 'Test endpoint & load models';
  };

  const renderLocalModels = (preferredModel = selectedLocalModel(), emptyLabel = 'Test the endpoint to load models.') => {
    const query = localModelSearch.value.trim().toLocaleLowerCase();
    const matching = localModelCatalog.filter(item => {
      const haystack = `${item.name} ${item.id}`.toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
    const selected = localModelCatalog.find(item => item.id === preferredModel);
    const options = selected && !matching.some(item => item.id === selected.id)
      ? [selected, ...matching]
      : matching;
    localModel.replaceChildren(...options.map(item => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name === item.id ? item.id : `${item.name} · ${item.id}`;
      return option;
    }));
    if (!options.length) {
      const option = new Option(emptyLabel, '');
      option.disabled = true;
      localModel.append(option);
    }
    localModel.value = options.some(item => item.id === preferredModel) ? preferredModel : options[0]?.id ?? '';
    localModel.disabled = !options.length;
  };

  const loadLocalModels = async (automatic = false) => {
    if (!window.velaAi) {
      if (!automatic) setStatus('Local AI endpoint testing is available in the Omega desktop app.', true);
      return;
    }
    const baseUrl = localUrl.value.trim();
    const isOllama = localEndpointIsOllama;
    const requestId = ++localModelLoadRequest;
    const previousLabel = testLocal.textContent;
    testLocal.disabled = true;
    testLocal.textContent = isOllama ? 'Loading Ollama models…' : 'Loading models…';
    if (isOllama) {
      ollamaStatus.hidden = false;
      ollamaStatus.textContent = 'Checking the local Ollama service…';
      ollamaStatus.dataset.state = 'loading';
      renderLocalModels(selectedLocalModel(), 'Checking Ollama for installed models…');
    }
    try {
      const result = await window.velaAi.testLocalConfig({ baseUrl, apiKey: localKey.value, ollama: isOllama });
      if (requestId !== localModelLoadRequest || baseUrl !== localUrl.value.trim() || selectedProvider() !== 'local') return;
      aiModels.set('local', result.models);
      const previousModel = selectedLocalModel();
      localModelCatalog = result.models;
      localModelSelection = result.models.some(item => item.id === previousModel) ? previousModel : result.defaultModel;
      renderLocalModels(localModelSelection, isOllama
        ? 'Ollama is running, but no models are installed. Run `ollama pull <model>` to add one.'
        : 'The endpoint returned no models.');
      if (isOllama) {
        const empty = result.models.length === 0;
        ollamaStatus.textContent = empty
          ? 'Ollama is running, but no models are installed. Run `ollama pull <model>` and refresh.'
          : `Ollama connected · ${result.models.length} installed model${result.models.length === 1 ? '' : 's'}`;
        ollamaStatus.dataset.state = empty ? 'setup' : 'ready';
        setStatus(empty
          ? 'Ollama is running, but no models are installed. Use `ollama pull <model>`, then refresh the model list.'
          : `Connected to Ollama. Loaded ${result.models.length} installed models; the selected model will load automatically.`);
        if (!empty && localModelSelection) void startOllamaModel(localModelSelection);
      } else {
        renderModelStatus('endpoint reachable');
        setStatus(`Connected to localhost. Loaded ${result.models.length} models; choose one and save the settings.`);
      }
    } catch (error) {
      if (requestId !== localModelLoadRequest || baseUrl !== localUrl.value.trim() || selectedProvider() !== 'local') return;
      const message = error instanceof Error ? error.message : String(error);
      if (isOllama) {
        ollamaStatus.textContent = `Ollama unavailable · ${message}`;
        ollamaStatus.dataset.state = 'error';
        setStatus(message, true);
      } else {
        setStatus(message, true);
      }
    } finally {
      if (requestId === localModelLoadRequest) {
        testLocal.disabled = false;
        testLocal.textContent = localEndpointIsOllama ? 'Refresh Ollama models' : (previousLabel === 'Loading models…' ? 'Test endpoint & load models' : previousLabel);
      }
    }
  };

  const renderLlamaModels = () => {
    const render = (select: HTMLSelectElement, storageKey: string) => {
      const preferred = localStorage.getItem(storageKey) || '';
      select.replaceChildren(...llamaCatalog.map(item => {
        const option = document.createElement('option');
        option.value = item.path;
        const folder = item.path.slice(0, Math.max(0, item.path.length - item.name.length)).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        const size = item.sizeBytes >= 1024 ** 3 ? `${(item.sizeBytes / 1024 ** 3).toFixed(1)} GB` : `${(item.sizeBytes / 1024 ** 2).toFixed(0)} MB`;
        option.textContent = `${folder ? `${folder} · ` : ''}${item.name} · ${size}`;
        option.title = item.path;
        return option;
      }));
      select.value = llamaCatalog.some(item => item.path === preferred) ? preferred : llamaCatalog[0]?.path ?? '';
      if (select.value && !preferred) localStorage.setItem(storageKey, select.value);
    };
    render(llamaChatModel, 'omega_ai_llama_chat_model');
    render(llamaInlineModel, 'omega_ai_llama_inline_model');
    const emptyLabel = llamaCatalog.length ? '' : 'No GGUF files found in this folder.';
    llamaChatModel.disabled = !llamaCatalog.length;
    llamaInlineModel.disabled = !llamaCatalog.length;
    if (emptyLabel) {
      const empty = (select: HTMLSelectElement) => select.append(new Option(emptyLabel, ''));
      empty(llamaChatModel);
      empty(llamaInlineModel);
    }
  };

  const renderLlamaStatus = (role: 'chat' | 'inline', state: LlamaCppRoleStatus) => {
    const status = role === 'chat' ? llamaChatStatus : llamaInlineStatus;
    const loadButton = role === 'chat' ? llamaChatLoad : llamaInlineLoad;
    const stopButton = role === 'chat' ? llamaChatStop : llamaInlineStop;
    const select = role === 'chat' ? llamaChatModel : llamaInlineModel;
    const roleLabel = role === 'chat' ? 'Chat AI' : 'Inline AI';
    if (state.error) status.textContent = `${roleLabel}: ${state.error}`;
    else if (state.isLoaded) status.textContent = `${roleLabel} ready · ${state.modelPath.split(/[\\/]/).pop()}`;
    else if (state.starting || state.isRunning) status.textContent = `${roleLabel} loading · ${state.modelPath.split(/[\\/]/).pop() || 'model'}…`;
    else status.textContent = `${roleLabel} model not loaded`;
    status.dataset.state = state.error ? 'error' : state.isLoaded ? 'ready' : state.starting || state.isRunning ? 'loading' : 'setup';
    loadButton.disabled = !select.value || Boolean(state.starting);
    stopButton.disabled = !state.isRunning;
  };

  const refreshLlamaStatus = async () => {
    if (!window.velaAi) return;
    try {
      const state = await window.velaAi.llamaStatus();
      renderLlamaStatus('chat', state.chat);
      renderLlamaStatus('inline', state.inline);
    } catch (error) {
      llamaChatStatus.textContent = error instanceof Error ? error.message : 'Could not read llama.cpp status.';
    }
  };

  const refreshLlamaModels = async () => {
    if (!window.velaAi) {
      llamaDirectory.textContent = 'Available in the Omega desktop app';
      return;
    }
    try {
      const result = await window.velaAi.llamaModels();
      llamaCatalog = result.models;
      llamaDirectory.textContent = result.directory;
      llamaDirectory.title = result.directory;
      renderLlamaModels();
      await refreshLlamaStatus();
    } catch (error) {
      llamaDirectory.textContent = error instanceof Error ? error.message : 'Could not read model folder.';
    }
  };

  const loadLlamaModel = async (role: 'chat' | 'inline') => {
    if (!window.velaAi) return setStatus('Built-in llama.cpp is available in the Omega desktop app.', true);
    const select = role === 'chat' ? llamaChatModel : llamaInlineModel;
    const button = role === 'chat' ? llamaChatLoad : llamaInlineLoad;
    const storageKey = role === 'chat' ? 'omega_ai_llama_chat_model' : 'omega_ai_llama_inline_model';
    if (!select.value) return setStatus('Choose a GGUF model first.', true);
    button.disabled = true;
    localStorage.setItem(storageKey, select.value);
    setStatus(`Starting llama.cpp for ${role === 'chat' ? 'Chat AI' : 'Inline AI'}…`);
    try {
      await window.velaAi.startLlama(role, select.value);
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => window.setTimeout(resolve, 1800));
        const state = await window.velaAi.llamaStatus();
        renderLlamaStatus('chat', state.chat);
        renderLlamaStatus('inline', state.inline);
        const roleState = state[role];
        if (roleState.error) throw new Error(roleState.error);
        if (roleState.isLoaded) {
          if (role === 'chat') {
            localStorage.setItem('omega_ai_chat_engine', 'llama.cpp');
            provider.value = 'local';
            localStorage.setItem('omega_ai_provider', 'local');
            localSettings.hidden = false;
            cloudSettings.hidden = true;
            model.hidden = true;
            renderModelStatus('llama.cpp model loaded');
          } else {
            localStorage.setItem('omega_ai_inline_engine', 'llama.cpp');
          }
          setStatus(`${role === 'chat' ? 'Chat AI' : 'Inline AI'} is ready with ${roleState.modelPath.split(/[\\/]/).pop()}.`);
          return;
        }
        if (!roleState.isRunning && !roleState.starting) throw new Error('llama.cpp stopped before the model became ready. Check its loading log and available GPU memory.');
        setStatus(`Loading ${roleState.modelPath.split(/[\\/]/).pop() || 'GGUF model'} for ${role === 'chat' ? 'Chat AI' : 'Inline AI'}…`);
      }
      throw new Error('Model loading timed out. Check llama.cpp logs and available GPU memory.');
    } catch (error) {
      await refreshLlamaStatus();
      setStatus(error instanceof Error ? error.message : 'Could not load the GGUF model.', true);
    } finally {
      button.disabled = false;
    }
  };

  const stopLlamaModel = async (role: 'chat' | 'inline') => {
    if (!window.velaAi) return;
    const engineKey = role === 'chat' ? 'omega_ai_chat_engine' : 'omega_ai_inline_engine';
    await window.velaAi.stopLlama(role);
    localStorage.removeItem(engineKey);
    await refreshLlamaStatus();
    setStatus(`${role === 'chat' ? 'Chat AI' : 'Inline AI'} llama.cpp model stopped.`);
  };

  const saveConversations = () => {
    try {
      localStorage.setItem(historyStorageKey, JSON.stringify(conversations));
    } catch (error) {
      setStatus(`Could not save AI conversation history: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const activeConversation = (): AiConversation => {
    let conversation = conversations.find(item => item.id === activeConversationId);
    if (!conversation) {
      conversation = { id: newConversationId(), title: 'New conversation', updatedAt: Date.now(), messages: [] };
      conversations.unshift(conversation);
      activeConversationId = conversation.id;
      saveConversations();
    }
    return conversation;
  };

  const renderHistory = () => {
    history.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'pine-ai-history-heading';
    const title = document.createElement('span');
    title.textContent = 'Recents';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn pine-ai-history-clear';
    clear.textContent = 'Clear';
    clear.disabled = !conversations.some(conversation => conversation.messages.length > 0);
    clear.addEventListener('click', () => {
      if (!window.confirm('Clear all saved AI conversations? This cannot be undone.')) return;
      conversations = [];
      activeConversationId = '';
      saveConversations();
      renderConversation();
      setStatus('Conversation history cleared.');
    });
    heading.append(title, clear);
    history.append(heading);
    const savedConversations = conversations.filter(conversation => conversation.messages.length > 0);
    if (!savedConversations.length) {
      const empty = document.createElement('p');
      empty.className = 'pine-ai-history-empty';
      empty.textContent = 'No saved conversations yet.';
      history.append(empty);
      return;
    }
    for (const conversation of [...savedConversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const row = document.createElement('div');
      row.className = 'pine-ai-history-item';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'pine-ai-history-open';
      open.classList.toggle('active', conversation.id === activeConversationId);
      open.textContent = conversation.title;
      open.title = `${conversation.title} · ${new Date(conversation.updatedAt).toLocaleString()}`;
      open.addEventListener('click', () => {
        activeConversationId = conversation.id;
        renderConversation();
        prompt.focus();
      });
      row.append(open);
      history.append(row);
    }
  };

  const appendText = (host: HTMLElement, text: string) => {
    const node = document.createElement('div');
    node.className = 'pine-ai-message-text';
    node.textContent = text;
    host.append(node);
  };

  const renderMessage = (message: AiChatMessage) => {
    const article = document.createElement('article');
    article.className = 'pine-ai-message';
    article.dataset.role = message.role;
    const label = document.createElement('p');
    label.className = 'pine-ai-message-label';
    label.textContent = message.role === 'user' ? 'You' : 'Omega AI';
    article.append(label);

    // The copy action must sit at the END of the message. The button is built here but
    // appended after the body: appending it first placed it between the label and the
    // text, so it rendered in the middle of the message.
    let copyMessageButton: HTMLButtonElement | null = null;
    if (message.role === 'user') {
      const copyMessageBtn = document.createElement('button');
      copyMessageBtn.type = 'button';
      copyMessageBtn.className = 'btn pine-ai-copy-message';
      copyMessageBtn.textContent = '📋 Copy';
      copyMessageBtn.setAttribute('aria-label', 'Copy this message');
      copyMessageBtn.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(message.content);
          } else {
            const temporary = document.createElement('textarea');
            temporary.value = message.content;
            temporary.style.position = 'fixed';
            temporary.style.opacity = '0';
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand('copy');
            temporary.remove();
            if (!copied) throw new Error('Clipboard access is unavailable.');
          }
          copyMessageBtn.textContent = '✓ Copied';
          window.setTimeout(() => { copyMessageBtn.textContent = '📋 Copy'; }, 1600);
        } catch (error) {
          setStatus(`Could not copy message: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      });
      copyMessageButton = copyMessageBtn;
    }

    let cursor = 0;
    for (const match of message.content.matchAll(codeBlockPattern)) {
      const start = match.index ?? 0;
      if (start > cursor) appendText(article, message.content.slice(cursor, start));
      const code = match[2].replace(/\r?\n$/, '');
      const block = document.createElement('section');
      block.className = 'pine-ai-code';
      const header = document.createElement('div');
      header.className = 'pine-ai-code-header';
      const language = document.createElement('span');
      language.textContent = match[1] || 'code';
      header.append(language);
      const pre = document.createElement('pre');
      const codeNode = document.createElement('code');
      codeNode.textContent = code;
      pre.append(codeNode);
      const actions = document.createElement('div');
      actions.className = 'pine-ai-code-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn';
      copy.textContent = 'Copy code';
      copy.addEventListener('click', async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(code);
          } else {
            const temporary = document.createElement('textarea');
            temporary.value = code;
            temporary.style.position = 'fixed';
            temporary.style.opacity = '0';
            document.body.append(temporary);
            temporary.select();
            const copied = document.execCommand('copy');
            temporary.remove();
            if (!copied) throw new Error('Clipboard access is unavailable.');
          }
          copy.textContent = 'Copied';
          window.setTimeout(() => { copy.textContent = 'Copy code'; }, 1600);
        } catch (error) {
          setStatus(`Could not copy code: ${error instanceof Error ? error.message : String(error)}`, true);
        }
      });
      actions.append(copy);
      if (options.applyCodeToEditor && allowAiEdit.checked) {
        const editMenu = document.createElement('details');
        editMenu.className = 'pine-ai-code-edit-menu';
        const editSummary = document.createElement('summary');
        editSummary.className = 'btn';
        editSummary.textContent = 'Apply…';
        const editOptions = document.createElement('div');
        editOptions.className = 'pine-ai-code-edit-options';
        const apply = (mode: 'insert' | 'replace-selection' | 'replace-document', label: string, confirmation?: string) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = label;
          button.addEventListener('click', () => {
            if (confirmation && !window.confirm(confirmation)) return;
            try {
              options.applyCodeToEditor?.(code, mode);
              button.textContent = 'Applied';
              editMenu.open = false;
              window.setTimeout(() => { button.textContent = label; }, 1600);
            } catch (error) {
              setStatus(`Could not edit the Pine script: ${error instanceof Error ? error.message : String(error)}`, true);
            }
          });
          editOptions.append(button);
        };
        apply('insert', 'Insert at cursor');
        apply('replace-selection', 'Replace selection');
        apply('replace-document', 'Replace editor', 'Replace the entire current Pine script with this AI code? This can be undone with Ctrl+Z.');
        editMenu.append(editSummary, editOptions);
        actions.append(editMenu);
      }
      block.append(header, pre, actions);
      article.append(block);
      cursor = start + match[0].length;
    }
    if (cursor < message.content.length) appendText(article, message.content.slice(cursor));
    if (copyMessageButton) article.append(copyMessageButton);
    chat.append(article);
  };

  const renderConversation = () => {
    const conversation = activeConversation();
    conversationTitleElement.textContent = conversation.title;
    chat.replaceChildren();
    if (conversation.messages.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'pine-ai-empty-state';
      const title = document.createElement('strong');
      title.textContent = 'How can I help?';
      const description = document.createElement('p');
      description.textContent = 'Ask a question about Pine Script or the script open in the editor. Your conversation and code will appear here.';
      emptyState.append(title, description);
      chat.append(emptyState);
    }
    conversation.messages.forEach(renderMessage);
    chat.scrollTop = chat.scrollHeight;
    renderHistory();
  };

  const selectedProvider = (): PineAiProviderStatus['id'] => provider.value as PineAiProviderStatus['id'];

  const syncOllamaControls = () => {
    unloadOllama.disabled = ollamaModelBusy || selectedProvider() !== 'local' || !localEndpointIsOllama || !selectedLocalModel();
    unloadOllama.textContent = ollamaModelBusy ? 'Ollama model busy…' : 'Unload Ollama model';
  };

  const startOllamaModel = async (modelName: string) => {
    if (!window.velaAi || selectedProvider() !== 'local' || !localEndpointIsOllama || !modelName) return;
    localStorage.removeItem('omega_ai_chat_engine');
    ollamaModelBusy = true;
    syncOllamaControls();
    ollamaStatus.hidden = false;
    ollamaStatus.textContent = `Loading ${modelName} into Ollama…`;
    ollamaStatus.dataset.state = 'loading';
    try {
      await window.velaAi.saveLocalConfig({
        baseUrl: localUrl.value.trim(),
        model: modelName,
        apiKey: localKey.value,
        ollama: true,
      });
      localKey.value = '';
      configuredProviders.set('local', true);
      const result = await window.velaAi.runOllamaModel({ model: modelName });
      ollamaStatus.textContent = `${result.model} is loaded in Ollama.`;
      ollamaStatus.dataset.state = 'ready';
      setStatus(`Ollama model ${result.model} is loaded and ready.`);
      renderModelStatus('Ollama model loaded');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ollamaStatus.textContent = `Could not load ${modelName} · ${message}`;
      ollamaStatus.dataset.state = 'error';
      setStatus(message, true);
    } finally {
      ollamaModelBusy = false;
      syncOllamaControls();
    }
  };

  const unloadSelectedOllamaModel = async () => {
    if (!window.velaAi) return setStatus('Ollama model controls are available in the Omega desktop app.', true);
    const modelName = selectedLocalModel();
    if (!modelName || !localEndpointIsOllama) return;
    ollamaModelBusy = true;
    syncOllamaControls();
    ollamaStatus.textContent = `Unloading ${modelName} from Ollama memory…`;
    ollamaStatus.dataset.state = 'loading';
    try {
      const result = await window.velaAi.unloadOllamaModel({ model: modelName });
      ollamaStatus.textContent = `${result.model} unloaded from Ollama memory.`;
      ollamaStatus.dataset.state = 'ready';
      setStatus(`Unloaded ${result.model} from Ollama memory.`);
      renderModelStatus('Ollama model unloaded');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ollamaStatus.textContent = `Could not unload ${modelName} · ${message}`;
      ollamaStatus.dataset.state = 'error';
      setStatus(message, true);
    } finally {
      ollamaModelBusy = false;
      syncOllamaControls();
    }
  };

  const renderModelStatus = (keyState?: string) => {
    const providerName = provider.selectedOptions[0]?.textContent?.trim() || provider.value;
    const selectedModel = selectedProvider() === 'local'
      ? aiModels.get('local')?.find(item => item.id === selectedLocalModel())
      : aiModels.get(selectedProvider())?.find(item => item.id === model.value);
    const modelId = selectedProvider() === 'local' ? selectedLocalModel() : model.value;
    const chatLlamaPath = localStorage.getItem('omega_ai_llama_chat_model') || '';
    const usingLlamaChat = selectedProvider() === 'local' && localStorage.getItem('omega_ai_chat_engine') === 'llama.cpp';
    const modelName = usingLlamaChat
      ? chatLlamaPath.split(/[\\/]/).pop() || 'GGUF'
      : selectedModel && selectedModel.name !== selectedModel.id
      ? `${selectedModel.name} (${selectedModel.id})`
      : modelId || 'No model selected';
    const configured = configuredProviders.get(selectedProvider());
    const keyLabel = keyState ?? (configured === undefined
      ? 'key status unknown'
      : configured ? 'key saved' : 'key not saved');
    modelStatus.textContent = `${usingLlamaChat ? 'Chat AI · llama.cpp' : providerName} · ${modelName} · ${usingLlamaChat ? 'loaded locally' : keyLabel}`;
    modelStatus.title = modelStatus.textContent;
    modelStatus.dataset.state = usingLlamaChat || configured === true ? 'ready' : configured === false ? 'setup' : 'unknown';
  };

  const syncModel = () => {
    const selected = selectedProvider();
    const saved = localStorage.getItem(`omega_ai_model_${selected}`) || defaultModels[selected];
    const models = aiModels.get(selected);
    model.replaceChildren();
    if (!models?.length) {
      const option = document.createElement('option');
      option.value = saved;
      option.textContent = `${saved} (test API key to load models)`;
      model.append(option);
      renderModelStatus();
      return;
    }
    for (const item of models) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name === item.id ? item.id : `${item.name} · ${item.id}`;
      model.append(option);
    }
    model.value = models.some(item => item.id === saved) ? saved
      : models.some(item => item.id === defaultModels[selected]) ? defaultModels[selected]
        : models[0].id;
    renderModelStatus();
  };

  const refreshProviderStatus = async () => {
    if (!window.velaAi) {
      renderModelStatus('desktop app required');
      setStatus('This is the browser preview. Use the Omega desktop app to enable AI requests with encrypted API-key storage.', true);
      return;
    }
    try {
      const providers = await window.velaAi.providers();
      for (const item of providers) configuredProviders.set(item.id, item.configured);
      if (selectedProvider() === 'local') {
        const config = await window.velaAi.localConfig();
        localUrl.value = config.baseUrl;
        localEndpointIsOllama = config.ollama;
        if (config.ollama) localStorage.removeItem('omega_ai_chat_engine');
        syncLocalPreset();
        syncOllamaControls();
        localKey.value = '';
        localModelCatalog = config.model ? [{ id: config.model, name: config.model }] : [];
        localModelSelection = config.model;
        renderLocalModels(config.model);
        localSettings.hidden = false;
        cloudSettings.hidden = true;
        model.hidden = true;
        renderModelStatus(localStorage.getItem('omega_ai_chat_engine') === 'llama.cpp' ? 'llama.cpp local model' : configuredProviders.get('local')
          ? (config.hasApiKey ? 'local endpoint · API key encrypted' : 'local endpoint · no key required')
          : 'local endpoint not saved');
        setStatus(localStorage.getItem('omega_ai_chat_engine') === 'llama.cpp'
          ? 'Chat AI is configured to use the built-in llama.cpp GGUF runtime. Load its model after restarting Omega.'
          : configuredProviders.get('local')
          ? `Local endpoint saved at ${config.baseUrl}. Prompts stay on this computer unless LuxAlgo MCP research is enabled.`
          : 'Enter a localhost endpoint, test it, then save the model settings.');
        if (localEndpointIsOllama) await loadLocalModels(true);
        return;
      }
      localSettings.hidden = true;
      cloudSettings.hidden = false;
      model.hidden = false;
      const selected = providers.find(item => item.id === selectedProvider());
      renderModelStatus();
      setStatus(selected?.configured
        ? `${selected.name} key is saved using operating-system encryption.`
        : `No ${selected?.name ?? 'provider'} key saved. Enter an API key to continue.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  };

  const updateProviderStatus = (providers: PineAiProviderStatus[]) => {
    for (const item of providers) configuredProviders.set(item.id, item.configured);
    const selected = providers.find(item => item.id === selectedProvider());
    renderModelStatus();
    setStatus(selected?.configured
      ? `${selected.name} key is saved using operating-system encryption.`
      : `No ${selected?.name ?? 'provider'} key saved.`);
  };

  const setupResizer = (handle: HTMLElement, target: HTMLElement, storageKey: string, minimum: number, ratio: number) => {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved >= minimum) target.style.width = `${saved}px`;
    let resizing = false;
    handle.addEventListener('pointerdown', event => {
      resizing = true;
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);
      document.body.style.userSelect = 'none';
    });
    handle.addEventListener('pointermove', event => {
      if (!resizing) return;
      const bounds = handle.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.max(minimum, Math.min(bounds.width * ratio, bounds.right - event.clientX));
      target.style.width = `${width}px`;
      localStorage.setItem(storageKey, String(Math.round(width)));
    });
    const stop = () => {
      resizing = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const bounds = handle.parentElement?.getBoundingClientRect();
      if (!bounds) return;
      const direction = target.id === 'pine-ai-assistant' ? -1 : 1;
      const change = (event.key === 'ArrowLeft' ? 1 : -1) * 24 * direction;
      const width = Math.max(minimum, Math.min(bounds.width * ratio, target.clientWidth + change));
      target.style.width = `${width}px`;
      localStorage.setItem(storageKey, String(Math.round(width)));
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    });
  };

  const setupFloatingHistory = () => {
    const stored = localStorage.getItem('omega_pine_ai_history_position');
    if (stored) {
      try {
        const position = JSON.parse(stored) as { left?: number; top?: number };
        if (Number.isFinite(position.left)) history.style.left = `${position.left}px`;
        if (Number.isFinite(position.top)) history.style.top = `${position.top}px`;
      } catch {
        // Ignore an old or invalid saved panel position.
      }
    }
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;
    const place = (left: number, top: number) => {
      const maximumLeft = Math.max(0, workspace.clientWidth - history.offsetWidth);
      const maximumTop = Math.max(0, workspace.clientHeight - history.offsetHeight);
      const nextLeft = Math.max(0, Math.min(maximumLeft, left));
      const nextTop = Math.max(0, Math.min(maximumTop, top));
      history.style.left = `${Math.round(nextLeft)}px`;
      history.style.top = `${Math.round(nextTop)}px`;
      localStorage.setItem('omega_pine_ai_history_position', JSON.stringify({ left: Math.round(nextLeft), top: Math.round(nextTop) }));
    };
    history.addEventListener('pointerdown', event => {
      const target = event.target as Element;
      if (!target.closest('.pine-ai-history-heading') || target.closest('.pine-ai-history-clear')) return;
      const bounds = history.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - bounds.left;
      offsetY = event.clientY - bounds.top;
      history.classList.add('dragging');
      history.setPointerCapture(event.pointerId);
      document.body.style.userSelect = 'none';
    });
    history.addEventListener('pointermove', event => {
      if (!dragging) return;
      const bounds = workspace.getBoundingClientRect();
      place(event.clientX - bounds.left - offsetX, event.clientY - bounds.top - offsetY);
    });
    const stopDragging = () => {
      dragging = false;
      history.classList.remove('dragging');
      document.body.style.userSelect = '';
    };
    history.addEventListener('pointerup', stopDragging);
    history.addEventListener('pointercancel', stopDragging);
  };

  const submitPrompt = async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot make AI requests. Use the Omega desktop app, where API keys stay encrypted.', true);
    const text = prompt.value.trim();
    if (!text) return setStatus('Describe what you want the assistant to do.');
    ask.disabled = true;
    setStatus(luxAlgoEnabled.checked
      ? 'Searching the public LuxAlgo Library, then sending the prompt and Pine script to your selected AI provider…'
      : selectedProvider() === 'local'
        ? 'Sending the prompt and current Pine script to your localhost model…'
        : 'Sending the prompt and current Pine script to your selected AI provider…', false, 'loading');
    const conversation = activeConversation();
    const conversationId = conversation.id;
    conversation.messages.push({ role: 'user', content: text });
    if (conversation.messages.filter(message => message.role === 'user').length === 1) conversation.title = conversationTitle(text);
    conversation.updatedAt = Date.now();
    prompt.value = '';
    saveConversations();
    renderConversation();
    try {
      const requestPrompt = makeConversationPrompt(conversation.messages, text, conversations.filter(item => item.id !== conversationId));
      const requestSource = options.getEditorValue();
      const requestScriptName = options.getCurrentScriptName();
      const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const useBuiltInLlama = selectedProvider() === 'local'
        && !localEndpointIsOllama
        && localStorage.getItem('omega_ai_chat_engine') === 'llama.cpp';
      activeCompletionId = requestId;
      activeCompletionIsLlama = useBuiltInLlama;
      activeCompletionStopRequested = false;
      stop.hidden = false;
      const result = useBuiltInLlama
        ? await window.velaAi.llamaComplete({ role: 'chat', prompt: requestPrompt, source: requestSource, scriptName: requestScriptName })
        : await window.velaAi.complete({
          provider: selectedProvider(),
          model: selectedProvider() === 'local' ? selectedLocalModel() : model.value.trim(),
          prompt: requestPrompt,
          source: requestSource,
          scriptName: requestScriptName,
          useLuxAlgoMcp: luxAlgoEnabled.checked,
          requestId,
        });
      conversation.messages.push({ role: 'assistant', content: result.text });
      conversation.updatedAt = Date.now();
      saveConversations();
      if (activeConversationId === conversationId) {
        renderConversation();
        setStatus(options.applyCodeToEditor && allowAiEdit.checked
          ? `Response from ${result.model}. Review the code and use an Apply button to add it to the Pine editor.`
          : `Response from ${result.model}. Copy any code you want into the Pine editor.`);
      }
      localStorage.setItem(`omega_ai_model_${selectedProvider()}`, selectedProvider() === 'local' ? selectedLocalModel() : model.value.trim());
    } catch (error) {
      if (activeCompletionStopRequested) setStatus('Generation stopped.');
      else setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      activeCompletionId = '';
      activeCompletionIsLlama = false;
      activeCompletionStopRequested = false;
      stop.hidden = true;
      stop.disabled = false;
      stop.textContent = 'Stop';
      ask.disabled = false;
    }
  };

  referenceToggle.addEventListener('click', () => {
    const opening = reference.hidden;
    if (opening && !panel.hidden) {
      panel.hidden = true;
      resize.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
    reference.hidden = !opening;
    referenceResize.hidden = !opening;
    referenceToggle.setAttribute('aria-expanded', String(opening));
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
  window.addEventListener('pine-reference:open', () => {
    if (!panel.hidden) {
      panel.hidden = true;
      resize.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
    reference.hidden = false;
    referenceResize.hidden = false;
    referenceToggle.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    resize.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    if (opening) {
      if (!reference.hidden) {
        reference.hidden = true;
        referenceResize.hidden = true;
        referenceToggle.setAttribute('aria-expanded', 'false');
      }
      syncModel();
      renderConversation();
      void refreshProviderStatus();
      void refreshLlamaModels();
      settings.open = false;
    } else {
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    resize.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
  provider.addEventListener('change', () => {
    localModelLoadRequest++;
    testLocal.disabled = false;
    localStorage.setItem('omega_ai_provider', selectedProvider());
    if (selectedProvider() === 'local' && localEndpointIsOllama) localStorage.removeItem('omega_ai_chat_engine');
    key.value = '';
    syncModel();
    syncOllamaControls();
    renderModelStatus(selectedProvider() === 'local' ? 'loading local endpoint…' : 'checking key…');
    void refreshProviderStatus();
  });

  // Add active state styling for Provider settings button
  settings.addEventListener('toggle', () => {
    if (settings.open) {
      settings.querySelector('summary')?.classList.add('active');
    } else {
      settings.querySelector('summary')?.classList.remove('active');
    }
  });
  model.addEventListener('change', () => {
    localStorage.setItem(`omega_ai_model_${selectedProvider()}`, model.value.trim());
    renderModelStatus();
  });
  localModel.addEventListener('change', () => {
    localModelSelection = localModel.value.trim();
    renderModelStatus();
    if (localEndpointIsOllama) void startOllamaModel(localModelSelection);
    syncOllamaControls();
  });
  unloadOllama.addEventListener('click', () => void unloadSelectedOllamaModel());
  localModelSearch.addEventListener('input', () => {
    renderLocalModels(localModelSelection || localModel.value.trim());
    renderModelStatus();
  });
  llamaChatModel.addEventListener('change', () => localStorage.setItem('omega_ai_llama_chat_model', llamaChatModel.value));
  llamaInlineModel.addEventListener('change', () => localStorage.setItem('omega_ai_llama_inline_model', llamaInlineModel.value));
  llamaChatLoad.addEventListener('click', () => void loadLlamaModel('chat'));
  llamaInlineLoad.addEventListener('click', () => void loadLlamaModel('inline'));
  llamaChatStop.addEventListener('click', () => void stopLlamaModel('chat'));
  llamaInlineStop.addEventListener('click', () => void stopLlamaModel('inline'));
  llamaBrowse.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('Choose a GGUF model folder in the Omega desktop app.', true);
    llamaBrowse.disabled = true;
    try {
      const result = await window.velaAi.chooseLlamaFolder();
      if (result) {
        llamaCatalog = result.models;
        llamaDirectory.textContent = result.directory;
        llamaDirectory.title = result.directory;
        renderLlamaModels();
        setStatus(`Loaded ${result.models.length} GGUF models from the selected folder.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not select the GGUF model folder.', true);
    } finally {
      llamaBrowse.disabled = false;
    }
  });
  localPreset.addEventListener('change', () => {
    if (localPreset.value === 'custom') {
      localEndpointIsOllama = false;
      syncOllamaControls();
      window.clearTimeout(localModelRefreshTimer);
      localModelLoadRequest++;
      localModelCatalog = [];
      localModelSelection = '';
      syncLocalPreset();
      renderLocalModels('', 'Test the endpoint to load models.');
      renderModelStatus('custom local endpoint selected');
      setStatus('Custom OpenAI-compatible endpoint selected. Enter its localhost URL and test the endpoint.');
      return;
    }
    const preset = localEndpointPresets[localPreset.value];
    if (!preset) return;
    localEndpointIsOllama = localPreset.value === 'ollama';
    if (localEndpointIsOllama) localStorage.removeItem('omega_ai_chat_engine');
    syncOllamaControls();
    localUrl.value = preset.baseUrl;
    localModelCatalog = [];
    localModelSelection = '';
    localModelLoadRequest++;
    localModel.replaceChildren();
    localModelSearch.value = '';
    syncLocalPreset();
    renderLocalModels('', localPreset.value === 'ollama' ? 'Checking Ollama for installed models…' : 'Test the endpoint to load models.');
    renderModelStatus(`${preset.hint} selected; test endpoint to load models`);
    setStatus(`${preset.hint} selected. Test the endpoint to discover its available models.`);
    if (localPreset.value === 'ollama') void loadLocalModels(true);
  });
  localUrl.addEventListener('input', () => {
    localModelLoadRequest++;
    window.clearTimeout(localModelRefreshTimer);
    syncLocalPreset();
    syncOllamaControls();
    testLocal.disabled = false;
    if (localEndpointIsOllama && selectedProvider() === 'local') {
      localModelCatalog = [];
      localModelSelection = '';
      renderLocalModels('', 'Endpoint changed. Checking Ollama for installed models…');
      ollamaStatus.textContent = 'Endpoint changed · refreshing installed models…';
      ollamaStatus.dataset.state = 'loading';
      localModelRefreshTimer = window.setTimeout(() => {
        void loadLocalModels(true);
      }, 700);
    }
  });
  testLocal.addEventListener('click', () => void loadLocalModels(false));
  saveLocal.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('Local AI settings are available in the Omega desktop app.', true);
    saveLocal.disabled = true;
    try {
      const result = await window.velaAi.saveLocalConfig({
        baseUrl: localUrl.value.trim(),
        model: selectedLocalModel(),
        apiKey: localKey.value,
        ollama: localEndpointIsOllama,
      });
      localUrl.value = result.baseUrl;
      localEndpointIsOllama = result.ollama;
      syncLocalPreset();
      localModelSelection = result.model;
      renderLocalModels(result.model);
      localKey.value = '';
      configuredProviders.set('local', true);
      renderModelStatus(result.hasApiKey ? 'local API key encrypted' : 'no API key required');
      setStatus(`Saved localhost model ${result.model} at ${result.baseUrl}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      saveLocal.disabled = false;
    }
  });
  clearLocalKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('Local AI settings are available in the Omega desktop app.', true);
    clearLocalKey.disabled = true;
    try {
      const result = await window.velaAi.saveLocalConfig({
        baseUrl: localUrl.value.trim(),
        model: selectedLocalModel(),
        clearApiKey: true,
        ollama: localEndpointIsOllama,
      });
      configuredProviders.set('local', true);
      localKey.value = '';
      renderModelStatus('no API key required');
      setStatus(`Removed the saved local API key. The endpoint at ${result.baseUrl} remains configured.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearLocalKey.disabled = false;
    }
  });
  saveKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot access encrypted key storage. Use the Omega desktop app to save an API key.', true);
    const value = key.value;
    if (!value.trim()) return setStatus('Enter an API key before saving.', true);
    saveKey.disabled = true;
    setStatus('Encrypting and saving the API key…');
    try {
      updateProviderStatus(await window.velaAi.saveKey(selectedProvider(), value));
      key.value = '';
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      saveKey.disabled = false;
    }
  });
  testKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot test keys. Use the Omega desktop app.', true);
    testKey.disabled = true;
    saveKey.disabled = true;
    clearKey.disabled = true;
    setStatus(`Checking ${provider.selectedOptions[0]?.textContent ?? 'provider'} API key and loading available models…`);
    try {
      const result = await window.velaAi.testKey(selectedProvider(), key.value.trim() || undefined);
      aiModels.set(result.provider, result.models);
      key.value = '';
      updateProviderStatus(result.providers);
      syncModel();
      setStatus(`API key is valid. Loaded ${result.models.length} models from ${provider.selectedOptions[0]?.textContent ?? 'provider'}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      testKey.disabled = false;
      saveKey.disabled = false;
      clearKey.disabled = false;
    }
  });
  clearKey.addEventListener('click', async () => {
    if (!window.velaAi) return setStatus('This browser preview cannot access encrypted key storage. Use the Omega desktop app to remove an API key.', true);
    if (!window.confirm(`Remove the saved ${provider.selectedOptions[0]?.textContent ?? 'provider'} API key from this computer?`)) return;
    clearKey.disabled = true;
    try {
      updateProviderStatus(await window.velaAi.clearKey(selectedProvider()));
      key.value = '';
      aiModels.delete(selectedProvider());
      syncModel();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearKey.disabled = false;
    }
  });
  ask.addEventListener('click', () => void submitPrompt());
  stop.addEventListener('click', async () => {
    if (!activeCompletionId || !window.velaAi) return;
    activeCompletionStopRequested = true;
    stop.disabled = true;
    stop.textContent = 'Stopping…';
    try {
      if (activeCompletionIsLlama) await window.velaAi.stopLlama('chat');
      else await window.velaAi.cancelCompletion(activeCompletionId);
      setStatus('Stop requested.');
    } catch (error) {
      activeCompletionStopRequested = false;
      stop.disabled = false;
      stop.textContent = 'Stop';
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  luxAlgoEnabled.addEventListener('change', () => {
    localStorage.setItem('omega_ai_luxalgo_mcp', String(luxAlgoEnabled.checked));
    setStatus(luxAlgoEnabled.checked
      ? 'LuxAlgo Library MCP research is enabled for the next prompt.'
      : 'LuxAlgo Library MCP research is disabled.');
  });
  allowAiEdit.addEventListener('change', () => {
    localStorage.setItem('omega_ai_allow_edit', String(allowAiEdit.checked));
    renderConversation();
    setStatus(allowAiEdit.checked
      ? 'AI edit actions enabled. Review each change before applying it.'
      : 'AI edit actions disabled. The assistant can still suggest and copy code.');
  });
  optionalFeatures.open = localStorage.getItem('omega_pine_ai_options_open') === 'true';
  optionalFeatures.addEventListener('toggle', () => {
    localStorage.setItem('omega_pine_ai_options_open', String(optionalFeatures.open));
  });
  inlineAiEnabled.addEventListener('change', () => {
    localStorage.setItem('omega_ai_inline_completions', String(inlineAiEnabled.checked));
    setStatus(inlineAiEnabled.checked
      ? 'AI inline completions enabled. Type in the Pine editor to request suggestions.'
      : 'AI inline completions disabled.');
  });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
    }
  });
  newButton.addEventListener('click', () => {
    const conversation: AiConversation = { id: newConversationId(), title: 'New conversation', updatedAt: Date.now(), messages: [] };
    conversations.unshift(conversation);
    activeConversationId = conversation.id;
    saveConversations();
    renderConversation();
    prompt.focus();
    setStatus('Started a new conversation. Earlier saved chats are available as assistant memory.');
  });
  historyToggle.addEventListener('click', () => {
    const expanded = historyToggle.getAttribute('aria-expanded') !== 'true';
    workspace.classList.toggle('history-collapsed', !expanded);
    historyToggle.setAttribute('aria-expanded', String(expanded));
    historyToggle.textContent = 'Chats';
    historyToggle.title = expanded ? 'Hide saved chats' : 'Show saved chats';
    localStorage.setItem('omega_pine_ai_history_collapsed', String(!expanded));
    if (expanded) history.focus();
  });
  const historyCollapsed = localStorage.getItem('omega_pine_ai_history_collapsed') === 'true';
  workspace.classList.toggle('history-collapsed', historyCollapsed);
  historyToggle.setAttribute('aria-expanded', String(!historyCollapsed));
  historyToggle.textContent = 'Chats';
  historyToggle.title = historyCollapsed ? 'Show saved chats' : 'Hide saved chats';
  setupResizer(resize, panel, 'omega_pine_ai_width', 360, 0.7);
  setupFloatingHistory();
  if (options.manageReferenceResize !== false) {
    setupResizer(referenceResize, reference, 'vela_pine_reference_width', 250, 0.6);
  }

  syncModel();
  renderConversation();
  return {
    setStatus,
  };
}
