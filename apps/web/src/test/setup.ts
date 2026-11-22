import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach } from "vitest";
import { resetApiCache } from "../lib/api";

afterEach(() => {
  toast.dismiss();
  cleanup();
  resetApiCache();
});

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
      ResizeObserverStub;
  }

  if (!("DOMMatrixReadOnly" in window)) {
    class DOMMatrixReadOnlyStub {
      m22 = 1;
      a = 1;
      b = 0;
      c = 0;
      d = 1;
      e = 0;
      f = 0;
      constructor() {}
    }
    (
      window as unknown as { DOMMatrixReadOnly: typeof DOMMatrixReadOnlyStub }
    ).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
    (
      globalThis as unknown as { DOMMatrixReadOnly: typeof DOMMatrixReadOnlyStub }
    ).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
  }

  // Radix UI pointer capture & scrollIntoView polyfills for jsdom
  if (typeof Element !== "undefined") {
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  }

  // Normalize jsdom cross-realm ArrayBuffer/TypedArray instances passed to Node WebCrypto subtle.digest
  const nodeBuffer = (
    globalThis as unknown as {
      Buffer?: { from(input: ArrayLike<number> | ArrayBufferView): BufferSource };
    }
  ).Buffer;
  if (globalThis.crypto?.subtle && nodeBuffer) {
    const origDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    globalThis.crypto.subtle.digest = (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const u8 =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data as ArrayBufferLike);
      return origDigest(algorithm, nodeBuffer.from(u8));
    };
  }
}
