import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface PerspectiveGridProps {
  /** Additional CSS classes for the grid container */
  className?: string;
  /** Number of tiles per row/column (default: 24 for smooth GPU performance) */
  gridSize?: number;
  /** Whether to show the radial gradient fade overlay (default: true) */
  showOverlay?: boolean;
  /** Fade radius percentage for the gradient overlay (default: 80) */
  fadeRadius?: number;
}

export function PerspectiveGrid({
  className,
  gridSize = 24,
  showOverlay = true,
  fadeRadius = 80,
}: PerspectiveGridProps) {
  const tileIndices = useMemo(
    () => Array.from({ length: gridSize * gridSize }, (_, index) => index),
    [gridSize]
  );

  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative h-full w-full overflow-hidden bg-background",
        "[--fade-stop:var(--background)]",
        className
      )}
      style={{
        perspective: "2000px",
        contain: "layout style paint",
      }}
    >
      {/* Soft multi-color atmospheric aura */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: [
            "radial-gradient(circle at 18% 24%, rgba(6, 182, 212, 0.16), transparent 46%)",
            "radial-gradient(circle at 82% 22%, rgba(139, 92, 246, 0.15), transparent 48%)",
            "radial-gradient(circle at 76% 80%, rgba(16, 185, 129, 0.14), transparent 46%)",
            "radial-gradient(circle at 24% 78%, rgba(245, 158, 11, 0.11), transparent 45%)",
          ].join(", "),
        }}
      />

      {/* GPU-composited interactive perspective tile plane */}
      <div
        className="absolute aspect-square w-[80rem] grid origin-center"
        style={{
          left: "50%",
          top: "50%",
          transform:
            "translate3d(-50%, -50%, 0) rotateX(30deg) rotateY(-5deg) rotateZ(20deg) scale(2)",
          willChange: "transform",
          gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${gridSize}, minmax(0, 1fr))`,
        }}
      >
        {tileIndices.map((idx) => (
          <div key={idx} className="tile" />
        ))}
      </div>

      {showOverlay && (
        <div
          className="pointer-events-none absolute inset-0 z-10"
          style={{
            background: `radial-gradient(circle, transparent 28%, var(--fade-stop) ${fadeRadius}%)`,
          }}
        />
      )}
    </div>
  );
}

export default PerspectiveGrid;
