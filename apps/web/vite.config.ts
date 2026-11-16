import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter(
          (dep) => !dep.includes("vendor-esptool") && !dep.includes("vendor-xyflow")
        );
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@xyflow")) {
            return "vendor-xyflow";
          }
          if (id.includes("node_modules/esptool-js")) {
            return "vendor-esptool";
          }
          if (id.includes("node_modules/@remixicon/react")) {
            return "vendor-icons";
          }
          if (
            id.includes("node_modules/radix-ui") ||
            id.includes("node_modules/@radix-ui") ||
            id.includes("node_modules/@floating-ui")
          ) {
            return "vendor-radix";
          }
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
});
