import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@/styles/globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AppErrorFallback,
  ErrorBoundary,
  isChunkLoadError,
  reloadForStaleChunk,
} from "@/components/layout/ErrorBoundary";
import { App } from "./App";

/**
 * Cloudflare's SPA fallback answers missing assets with `200 OK text/html`, so
 * a tab left open across a deploy fails its lazy import. Vite surfaces that as
 * an `error` event on the script element (`vite:preloadError`); recovering here
 * keeps the tab usable instead of leaving a white `#root`.
 */
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadForStaleChunk();
});

/**
 * Last-resort net: a rejection that escapes React entirely should not leave a
 * blank page behind. Chunk failures trigger the guarded one-time reload, and
 * anything else is logged so the boundary can still show the recovery panel.
 */
window.addEventListener("unhandledrejection", (event) => {
  if (isChunkLoadError(event.reason)) {
    event.preventDefault();
    reloadForStaleChunk();
    return;
  }
  console.error("Unhandled promise rejection:", event.reason);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="flex min-h-screen items-center justify-center bg-background px-4">
          <AppErrorFallback
            error={error}
            onRetry={() => {
              reset();
            }}
          />
        </div>
      )}
    >
      <TooltipProvider delayDuration={200}>
        <App />
      </TooltipProvider>
    </ErrorBoundary>
  </StrictMode>
);
