import type { IncomingMessage, ServerResponse } from 'node:http';

// Describe only the hooks used here so a mounting app can use its own Vite
// installation without coupling the two copies' private server types.
export function devTutorialLevel(options?: { root?: string }): {
  name: string;
  apply: 'serve';
  configureServer(server: {
    config: { root: string; base: string };
    middlewares: {
      use(handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void): unknown;
    };
  }): void;
  handleHotUpdate<Module>(context: {
    file: string;
    modules: Module[];
    server: { moduleGraph: { invalidateModule(module: Module): void } };
  }): [] | undefined;
};
