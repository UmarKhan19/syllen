import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import { fileURLToPath } from "node:url";
const host = process.env.TAURI_DEV_HOST;

const litertFiles = [
  "litert_wasm_compat_internal.js",
  "litert_wasm_compat_internal.wasm",
  "litert_wasm_jspi_internal.js",
  "litert_wasm_jspi_internal.wasm",
  "litert_wasm_threaded_internal.js",
  "litert_wasm_threaded_internal.wasm",
  "litert_wasm_internal.js",
  "litert_wasm_internal.wasm",
];
const litertDir = join(dirname(fileURLToPath(import.meta.url)), "node_modules/@litertjs/core/wasm");

function litertAssets(): Plugin {
  return {
    name: "litert-assets",
    configureServer(server) {
      server.middlewares.use("/litert", (request, response, next) => {
        const name = decodeURIComponent(
          new URL(request.url ?? "/", "http://localhost").pathname.slice(1),
        );
        if (!litertFiles.includes(name)) return next();
        response.setHeader(
          "Content-Type",
          name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        );
        createReadStream(join(litertDir, name)).on("error", next).pipe(response);
      });
    },
    async generateBundle() {
      await Promise.all(
        litertFiles.map(async (name) => {
          this.emitFile({
            type: "asset",
            fileName: `litert/${name}`,
            source: await readFile(join(litertDir, name)),
          });
        }),
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), litertAssets()],
  optimizeDeps: { include: ["@desert-ant-labs/who", "@litertjs/core"] },
  build: {
    target: "esnext",
    license: { fileName: "licenses/frontend-dependencies.json" },
  },
  // The Who worker is loaded from a classic worker stub so LiteRT can use
  // importScripts; its bundle must stay ESM because Who has top-level await.
  worker: { format: "es" },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
