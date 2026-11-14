import { useSyncExternalStore } from "react";

function subscribeToDarkClass(callback: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(() => {
    callback();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getIsDarkSnapshot(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function useIsDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeToDarkClass,
    getIsDarkSnapshot,
    () => false
  );
}
