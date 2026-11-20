import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(workerId: string, label: string): Worker | Promise<Worker>;
    };
  }
}

self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};
