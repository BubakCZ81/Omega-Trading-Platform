import * as monaco from 'monaco-editor';
import type { PineAiProviderStatus } from './pineAiAssistant';

const enabledStorageKey = 'omega_ai_inline_completions';
const requestDebounceMs = 280;
let providerRegistered = false;
let requestSerial = 0;

function enabled(): boolean {
  return localStorage.getItem(enabledStorageKey) === 'true';
}

function selectedProvider(): PineAiProviderStatus['id'] {
  const value = localStorage.getItem('omega_ai_provider');
  return value && ['local', 'gemini', 'groq', 'openrouter', 'anthropic', 'cohere', 'deepseek', 'mistral', 'together', 'zai', 'siliconflow', 'sambanova'].includes(value)
    ? value as PineAiProviderStatus['id']
    : 'local';
}

function selectedModel(provider: string): string {
  return localStorage.getItem(`omega_ai_model_${provider}`) || '';
}

function extractSuggestion(text: string): string {
  const fenced = text.match(/```(?:pine|pinescript)?\s*\r?\n([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate || candidate.length > 2000) return '';
  return candidate;
}

function waitForDebounce(token: monaco.CancellationToken): Promise<boolean> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => resolve(!token.isCancellationRequested), requestDebounceMs);
    token.onCancellationRequested(() => {
      window.clearTimeout(timer);
      resolve(false);
    });
  });
}

export function registerPineAiInlineCompletions(): void {
  if (providerRegistered) return;
  providerRegistered = true;
  monaco.languages.registerInlineCompletionsProvider('pine', {
    debounceDelayMs: requestDebounceMs,
    async provideInlineCompletions(model, position, _context, token) {
      if (!enabled() || !window.velaAi || model.getLanguageId() !== 'pine') return { items: [] };
      if (!(await waitForDebounce(token))) return { items: [] };
      const serial = ++requestSerial;
      const source = model.getValue();
      const beforeCursor = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
      const prompt = [
        'Complete the Pine Script at the cursor.',
        'Return only the text to insert after the cursor; do not return markdown, explanations, or repeated existing code.',
        'Keep the completion concise and syntactically valid Pine v6.',
        `Code before cursor:\n${beforeCursor.slice(-5000)}`,
      ].join('\n\n');
      try {
        const scriptName = model.uri.path.split('/').pop() || 'Pine script';
        const result = localStorage.getItem('omega_ai_inline_engine') === 'llama.cpp'
          ? await window.velaAi.llamaComplete({ role: 'inline', prompt, source, scriptName })
          : await window.velaAi.complete({
            provider: selectedProvider(),
            model: selectedModel(selectedProvider()),
            prompt,
            source,
            scriptName,
          });
        if (token.isCancellationRequested || serial !== requestSerial || !enabled()) return { items: [] };
        const insertText = extractSuggestion(result.text);
        if (!insertText) return { items: [] };
        return {
          items: [{
            insertText,
            range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
          }],
        };
      } catch {
        return { items: [] };
      }
    },
    disposeInlineCompletions() {
      // Monaco owns the returned completion list; no external resources are retained.
    },
  });
}

export const pineAiInlineCompletionsStorageKey = enabledStorageKey;
