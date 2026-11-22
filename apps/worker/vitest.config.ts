import fs from "node:fs";
import { defineConfig } from "vitest/config";

function wasmModulePlugin() {
  return {
    name: "worker-wasm-module-loader",
    enforce: "pre" as const,
    load(id: string) {
      if (!id.endsWith(".wasm")) return null;
      const bytes = fs.readFileSync(id);
      const b64 = bytes.toString("base64");
      return `
        const bin = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0));
        const mod = new WebAssembly.Module(bin);
        export default mod;
      `;
    },
  };
}

export default defineConfig({
  plugins: [wasmModulePlugin()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    server: {
      deps: {
        inline: ["argon2id"],
      },
    },
  },
});
