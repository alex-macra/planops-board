import react from "@vitejs/plugin-react-swc";
import { defineConfig, type InlineConfig, type Plugin } from "vite";

import {
  handleBoardHttpRequest,
  handleHttpFailure,
  LOOPBACK_HOST,
} from "./server/http.ts";
import type { BoardRuntime } from "./server/runtime.ts";
import { DEFAULT_PORT } from "./shared/config.ts";

function boardApi(runtime: BoardRuntime): Plugin {
  return {
    name: "board-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleBoardHttpRequest(runtime, request, response)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((error: unknown) => handleHttpFailure(response, error));
      });
    },
  };
}

export function createBoardViteConfig(runtime: BoardRuntime): InlineConfig {
  return {
    configFile: false,
    root: runtime.engineRoot,
    plugins: [react(), boardApi(runtime)],
    server: { host: LOOPBACK_HOST, port: runtime.port, strictPort: true },
    preview: { host: LOOPBACK_HOST, port: runtime.port, strictPort: true },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  };
}

export default defineConfig({
  plugins: [react()],
  server: { host: LOOPBACK_HOST, port: DEFAULT_PORT, strictPort: true },
  preview: { host: LOOPBACK_HOST, port: DEFAULT_PORT, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
