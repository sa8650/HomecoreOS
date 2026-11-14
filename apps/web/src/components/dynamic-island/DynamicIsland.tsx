import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import "./dynamic-island.css";

const MORPH_SPRING = {
  type: "spring" as const,
  stiffness: 360,
  damping: 32,
  mass: 0.78,
};

const COLLAPSED_FALLBACK = { width: 52, height: 36 };
const EXPANDED_FALLBACK = { width: 224, height: 38 };
const DRAG_THRESHOLD = 8;
const EDGE_MARGIN = 12;
const STORAGE_KEY = "hc:island:offset-x";

function readStoredOffset(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed) : 0;
  } catch {
    return 0;
  }
}

function saveStoredOffset(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(value)));
  } catch {
    // ignore storage errors
  }
}

function clampHorizontalOffset(
  desiredX: number,
  shellWidth: number,
  hostWidth: number
): number {
  if (hostWidth <= 0) return desiredX;
  const maxAbs = Math.max(0, hostWidth / 2 - shellWidth / 2 - EDGE_MARGIN);
  return Math.max(-maxAbs, Math.min(maxAbs, Math.round(desiredX)));
}

export function IslandDivider() {
  return <span className="island-divider" aria-hidden="true" />;
}

export const IslandControl = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
>(function IslandControl({ active = false, className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      data-island-control=""
      data-active={active ? "true" : undefined}
      className={cn("island-control", className)}
      {...props}
    />
  );
});

export function DynamicIsland({
  face,
  children,
  layer,
  hasActiveLayer = false,
  onCloseLayer,
  expanded,
  onExpandedChange,
  faceAriaLabel = "Open workspace quick bar",
  actionsAriaLabel = "Workspace quick bar",
}: {
  face: ReactNode;
  children: ReactNode;
  layer?: ReactNode;
  hasActiveLayer?: boolean;
  onCloseLayer?: () => void;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  faceAriaLabel?: string;
  actionsAriaLabel?: string;
}) {
  const reducedMotion = useReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const faceBtnRef = useRef<HTMLButtonElement>(null);
  const faceWrapRef = useRef<HTMLDivElement>(null);
  const panelWrapRef = useRef<HTMLDivElement>(null);
  const layerSlotRef = useRef<HTMLDivElement>(null);

  const [faceSize, setFaceSize] = useState(COLLAPSED_FALLBACK);
  const [panelSize, setPanelSize] = useState(EXPANDED_FALLBACK);
  const [offsetX, setOffsetX] = useState<number>(readStoredOffset);
  const [isDragging, setIsDragging] = useState(false);
  const [layerShift, setLayerShift] = useState(0);

  const didDragRef = useRef(false);
  const expandedRef = useRef(expanded);
  const hasLayerRef = useRef(hasActiveLayer);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    hasLayerRef.current = hasActiveLayer;
  }, [hasActiveLayer]);

  const activeSize = expanded ? panelSize : faceSize;

  const getHostWidth = useCallback(() => {
    const el = hostRef.current;
    if (!el) return typeof window !== "undefined" ? window.innerWidth : 0;
    const width = el.getBoundingClientRect().width;
    return width > 0 ? width : typeof window !== "undefined" ? window.innerWidth : 0;
  }, []);

  // Re-clamp horizontal offset whenever pill width or host container width changes
  const clampCurrentOffset = useCallback(
    (shellWidth: number) => {
      const hostWidth = getHostWidth();
      if (hostWidth <= 0) return;
      setOffsetX((prev) => {
        const next = clampHorizontalOffset(prev, shellWidth, hostWidth);
        if (next !== prev) saveStoredOffset(next);
        return next;
      });
    },
    [getHostWidth]
  );

  // Measure face & panel sizes dynamically with ResizeObserver
  useLayoutEffect(() => {
    const faceEl = faceWrapRef.current;
    const panelEl = panelWrapRef.current;
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      if (faceEl) {
        const rect = faceEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setFaceSize({
            width: Math.ceil(rect.width),
            height: Math.ceil(rect.height),
          });
        }
      }
      if (panelEl) {
        const rect = panelEl.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setPanelSize({
            width: Math.ceil(rect.width),
            height: Math.ceil(rect.height),
          });
        }
      }
    });

    if (faceEl) ro.observe(faceEl);
    if (panelEl) ro.observe(panelEl);
    return () => ro.disconnect();
  }, [expanded]);

  useEffect(() => {
    clampCurrentOffset(activeSize.width);
  }, [activeSize.width, clampCurrentOffset]);

  useEffect(() => {
    const hostEl = hostRef.current;
    const updateOnResize = () => clampCurrentOffset(activeSize.width);
    window.addEventListener("resize", updateOnResize);
    let ro: ResizeObserver | undefined;
    if (hostEl && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(updateOnResize);
      ro.observe(hostEl);
    }
    return () => {
      window.removeEventListener("resize", updateOnResize);
      ro?.disconnect();
    };
  }, [activeSize.width, clampCurrentOffset]);

  // Measure active popover layer and shift horizontally so it stays within host bounds
  useLayoutEffect(() => {
    if (!hasActiveLayer || !layer) {
      setLayerShift(0);
      return;
    }

    const computeShift = () => {
      const slot = layerSlotRef.current;
      const host = hostRef.current;
      if (!slot || !host) {
        setLayerShift(0);
        return;
      }
      const child = slot.querySelector<HTMLElement>("[data-island-layer]") ?? slot.firstElementChild;
      if (!(child instanceof HTMLElement)) {
        setLayerShift(0);
        return;
      }
      const hostRect = host.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      if (hostRect.width <= 0 || childRect.width <= 0) {
        setLayerShift(0);
        return;
      }
      const center = hostRect.left + hostRect.width / 2 + offsetX;
      const desiredLeft = center - childRect.width / 2;
      const desiredRight = center + childRect.width / 2;
      const minLeft = hostRect.left + EDGE_MARGIN;
      const maxRight = hostRect.right - EDGE_MARGIN;

      let shift = 0;
      if (desiredLeft < minLeft) {
        shift = minLeft - desiredLeft;
      } else if (desiredRight > maxRight) {
        shift = maxRight - desiredRight;
      }
      setLayerShift(Math.round(shift));
    };

    computeShift();
    const slot = layerSlotRef.current;
    if (!slot || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(computeShift);
    ro.observe(slot);
    return () => ro.disconnect();
  }, [hasActiveLayer, layer, offsetX]);

  // Collapse on pointerdown outside track (while ignoring modal dialogs)
  useEffect(() => {
    if (!expanded && !hasActiveLayer) return;

    const handlePointerDownCapture = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (trackRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest(
          '[role="dialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="select-content"], [data-radix-popper-content-wrapper], .modal-backdrop'
        )
      ) {
        return;
      }
      onCloseLayer?.();
      onExpandedChange(false);
    };

    document.addEventListener("pointerdown", handlePointerDownCapture, true);
    return () => document.removeEventListener("pointerdown", handlePointerDownCapture, true);
  }, [expanded, hasActiveLayer, onCloseLayer, onExpandedChange]);

  // Escape closes child popovers first, then collapses the pill & restores focus to face
  useEffect(() => {
    if (!expanded && !hasActiveLayer) return;

    const handleKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (
        document.querySelector(
          '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [role="dialog"][aria-modal="true"]'
        )
      ) {
        return;
      }
      if (hasLayerRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onCloseLayer?.();
        return;
      }
      if (expandedRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onExpandedChange(false);
        requestAnimationFrame(() => faceBtnRef.current?.focus());
      }
    };

    document.addEventListener("keydown", handleKeyDownCapture, true);
    return () => document.removeEventListener("keydown", handleKeyDownCapture, true);
  }, [expanded, hasActiveLayer, onCloseLayer, onExpandedChange]);

  // Horizontal pointer drag on the shell (mouse & pen only)
  const handleShellPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType === "touch") return;
    dragCleanupRef.current?.();
    const startClientX = e.clientX;
    const startOffset = offsetX;
    let dragging = false;
    didDragRef.current = false;

    const handleMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startClientX;
      if (!dragging && Math.abs(dx) >= DRAG_THRESHOLD) {
        dragging = true;
        didDragRef.current = true;
        setIsDragging(true);
      }
      if (dragging) {
        const clamped = clampHorizontalOffset(
          startOffset + dx,
          activeSize.width,
          getHostWidth()
        );
        setOffsetX(clamped);
      }
    };

    const cleanupListeners = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      dragCleanupRef.current = null;
    };

    const handleUp = (ev: PointerEvent) => {
      cleanupListeners();
      if (dragging) {
        const clamped = clampHorizontalOffset(
          startOffset + (ev.clientX - startClientX),
          activeSize.width,
          getHostWidth()
        );
        setOffsetX(clamped);
        saveStoredOffset(clamped);
        setIsDragging(false);
        window.setTimeout(() => {
          didDragRef.current = false;
        }, 0);
      }
    };

    dragCleanupRef.current = cleanupListeners;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  };

  const handleActionsKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const container = e.currentTarget;
    const controls = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-island-control], .ds-theme-toggle, .island-avatar"
      )
    ).filter((el) => {
      if ((el as HTMLButtonElement).disabled) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    if (controls.length === 0) return;

    const currentIdx = controls.indexOf(document.activeElement as HTMLElement);
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const nextIdx =
      currentIdx === -1
        ? delta > 0
          ? 0
          : controls.length - 1
        : (currentIdx + delta + controls.length) % controls.length;

    e.preventDefault();
    controls[nextIdx]?.focus();
  };

  const springTransition = reducedMotion ? { duration: 0.01 } : MORPH_SPRING;

  return (
    <div ref={hostRef} className="hc-island-scope dynamic-island-host">
      <div className="dynamic-island-anchor">
        <div
          ref={trackRef}
          className="dynamic-island-track"
          style={{ ["--island-x" as string]: `${offsetX}px` }}
        >
          <motion.div
            data-testid="dynamic-island-shell"
            data-expanded={expanded ? "true" : "false"}
            data-dragging={isDragging ? "true" : undefined}
            className="island-shell"
            initial={false}
            animate={{
              width: activeSize.width,
              height: activeSize.height,
            }}
            transition={springTransition}
            onPointerDown={handleShellPointerDown}
            onClickCapture={(e) => {
              if (didDragRef.current) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {!expanded ? (
                <motion.div
                  key="face"
                  ref={faceWrapRef}
                  className="island-face-wrap"
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reducedMotion ? undefined : { opacity: 0, scale: 0.94 }}
                  transition={{ duration: reducedMotion ? 0 : 0.14 }}
                >
                  <button
                    ref={faceBtnRef}
                    type="button"
                    data-testid="dynamic-island-face"
                    className="island-face"
                    aria-label={faceAriaLabel}
                    aria-expanded={false}
                    onClick={() => onExpandedChange(true)}
                  >
                    {face}
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="panel"
                  ref={panelWrapRef}
                  className="island-panel-wrap"
                  initial={reducedMotion ? false : { opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reducedMotion ? undefined : { opacity: 0, scale: 0.96 }}
                  transition={{ duration: reducedMotion ? 0 : 0.16 }}
                >
                  <div
                    role="toolbar"
                    aria-label={actionsAriaLabel}
                    data-testid="dynamic-island-actions"
                    className="island-actions"
                    onKeyDown={handleActionsKeyDown}
                  >
                    {children}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {/* Popover layer below the pill */}
          <AnimatePresence>
            {hasActiveLayer && layer && (
              <motion.div
                className="island-layer"
                initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0, y: -6, scale: 0.97 }}
                transition={{ duration: reducedMotion ? 0 : 0.16 }}
              >
                <div
                  ref={layerSlotRef}
                  className="island-layer-anchor"
                  style={{ ["--island-layer-shift" as string]: `${layerShift}px` }}
                >
                  {layer}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
