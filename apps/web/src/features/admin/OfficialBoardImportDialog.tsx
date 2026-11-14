import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiAlertLine,
  RiArrowDownSLine,
  RiArrowLeftLine,
  RiCheckLine,
  RiCloseLine,
  RiDownloadCloud2Line,
  RiExternalLinkLine,
  RiInformationLine,
  RiLoader4Line,
  RiQuestionLine,
  RiSearchLine,
  RiSubtractLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BoardPadTable, listBoardPads } from "@/components/boards/BoardPadTable";
import { BoardVectorSvg } from "@/components/boards/BoardVectorSvg";
import { Badge } from "@/components/reui/badge";
import { StatusAlert } from "@/components/shared/AppUi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type {
  BoardImportCandidate,
  BoardImportPreview,
  BoardImportProvider,
  BoardImportRun,
  BoardImportSourceCheck,
} from "../types";

type ImportStep = "source" | "preview" | "result";

const STEPS: Array<{ id: ImportStep; label: string }> = [
  { id: "source", label: "Source" },
  { id: "preview", label: "Preview and select" },
  { id: "result", label: "Result" },
];

const PROVIDERS: Array<{
  id: BoardImportProvider;
  name: string;
  summary: string;
  sources: string;
}> = [
  {
    id: "seeed_xiao",
    name: "Seeed Studio XIAO",
    summary: "XIAO ESP32-C3, C5, C6, S3, S3 Sense and S3 Plus.",
    sources: "Pin maps are checked against the Seeed Studio wiki and Seeed's PlatformIO board files.",
  },
  {
    id: "espressif",
    name: "Espressif DevKits",
    summary: "Espressif's own development boards.",
    sources: "Read from the Espressif hardware documentation and the ESP-IDF board list.",
  },
];

const STATUS_BADGE: Record<
  BoardImportCandidate["status"],
  { label: string; variant: "info-light" | "secondary" | "warning-light" | "outline" }
> = {
  new: { label: "New", variant: "info-light" },
  in_library: { label: "Already in library", variant: "secondary" },
  removed: { label: "Removed earlier", variant: "warning-light" },
  unsupported: { label: "Not supported", variant: "outline" },
};

function CheckMark({ status }: { status: BoardImportSourceCheck["status"] }) {
  const className = "mt-px size-3.5 shrink-0";
  if (status === "confirmed") {
    return <RiCheckLine className={cn(className, "text-success")} aria-hidden="true" />;
  }
  if (status === "conflict") {
    return <RiCloseLine className={cn(className, "text-destructive")} aria-hidden="true" />;
  }
  if (status === "unreachable") {
    return <RiQuestionLine className={cn(className, "text-warning")} aria-hidden="true" />;
  }
  if (status === "reference") {
    return <RiInformationLine className={cn(className, "text-info")} aria-hidden="true" />;
  }
  return <RiSubtractLine className={cn(className, "text-muted-foreground")} aria-hidden="true" />;
}

const CHECK_STATUS_TEXT: Record<BoardImportSourceCheck["status"], string> = {
  confirmed: "Confirmed",
  conflict: "Conflict",
  unreachable: "Source not reachable",
  not_available: "Not published",
  reference: "Built-in reference",
};

function specLine(candidate: BoardImportCandidate): string {
  const board = candidate.board;
  if (!board) return candidate.slug;
  const parts = [
    board.chip_variant || board.chip_family.toUpperCase(),
    `${board.flash_size_mb} MB flash`,
    board.psram_size_mb > 0 ? `${board.psram_size_mb} MB PSRAM` : "no PSRAM",
  ];
  // Every GPIO the profile describes, including the ones reserved on the board.
  if (board.gpio_definitions.length > 0) {
    parts.push(`${board.gpio_definitions.length} pins defined`);
  }
  return parts.join(" · ");
}

/**
 * Admin flow "Import Official Boards": choose a source, preview what the
 * official documentation says about every board, select the boards to add,
 * and see what happened to each of them. Nothing is saved before step 3.
 */
export function OfficialBoardImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after boards were added, so the catalog table can reload. */
  onImported: () => Promise<void> | void;
}) {
  const [step, setStep] = useState<ImportStep>("source");
  const [provider, setProvider] = useState<BoardImportProvider>("seeed_xiao");
  const [preview, setPreview] = useState<BoardImportPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [search, setSearch] = useState("");
  const [publish, setPublish] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [run, setRun] = useState<BoardImportRun | null>(null);
  const requestRef = useRef(0);

  // Every time the dialog opens it starts from the beginning.
  useEffect(() => {
    if (!open) return;
    requestRef.current += 1;
    setStep("source");
    setPreview(null);
    setPreviewError(null);
    setLoadingPreview(false);
    setSelected(new Set());
    setExpanded(null);
    setShowUnsupported(false);
    setSearch("");
    setPublish(true);
    setImportError(null);
    setRun(null);
  }, [open]);

  // Boards the platform can run on come first; the rest is listed separately.
  const candidates = useMemo(
    () => (preview?.candidates ?? []).filter((c) => c.status !== "unsupported"),
    [preview]
  );
  const unsupported = useMemo(
    () => (preview?.candidates ?? []).filter((c) => c.status === "unsupported"),
    [preview]
  );
  const selectable = useMemo(() => candidates.filter((c) => c.selectable), [candidates]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      `${c.name} ${c.slug} ${c.board?.chip_variant ?? ""}`.toLowerCase().includes(q)
    );
  }, [candidates, search]);
  const selectedCount = selected.size;
  const heldBackCount = candidates.filter(
    (c) => selected.has(c.slug) && c.verification === "needs_verification"
  ).length;

  async function loadPreview() {
    const requestId = ++requestRef.current;
    setStep("preview");
    setLoadingPreview(true);
    setPreviewError(null);
    setPreview(null);
    setSelected(new Set());
    setExpanded(null);
    setShowUnsupported(false);
    setSearch("");
    try {
      const res = await apiFetch<{ preview: BoardImportPreview }>(
        "/api/admin/boards/import/preview",
        { method: "POST", body: JSON.stringify({ provider }) }
      );
      if (requestRef.current !== requestId) return;
      setPreview(res.preview);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setPreviewError(
        err instanceof ApiError ? err.message : "The official sources could not be read."
      );
    } finally {
      if (requestRef.current === requestId) setLoadingPreview(false);
    }
  }

  function toggle(slug: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleImport() {
    if (!preview || selectedCount === 0 || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await apiFetch<{ run: BoardImportRun }>("/api/admin/boards/import", {
        method: "POST",
        body: JSON.stringify({
          provider: preview.provider,
          slugs: candidates.filter((c) => selected.has(c.slug)).map((c) => c.slug),
          publish,
        }),
      });
      setRun(res.run);
      setStep("result");
      const added = res.run.importedCount + res.run.restoredCount;
      if (added > 0) {
        toast.success(
          `${added} board${added === 1 ? "" : "s"} added to the Board Library from ${res.run.providerLabel}.`
        );
        await onImported();
      } else {
        toast.info("No boards were added. Every selected board was skipped.");
      }
    } catch (err) {
      setImportError(err instanceof ApiError ? err.message : "The import failed. Nothing was added.");
    } finally {
      setImporting(false);
    }
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <Dialog open={open} onOpenChange={(next) => !importing && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import Official Boards</DialogTitle>
          <DialogDescription>
            Add boards from the makers' own documentation. You see every board, its pinout and its
            sources before anything is saved.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-wrap items-center gap-1.5 text-[11px]" aria-label="Import steps">
          {STEPS.map((item, index) => (
            <li
              key={item.id}
              aria-current={item.id === step ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
                item.id === step
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : index < stepIndex
                    ? "border-success/30 bg-success/10 text-success-foreground"
                    : "border-border text-muted-foreground"
              )}
            >
              <span className="tabular-nums">{index + 1}</span>
              {item.label}
            </li>
          ))}
        </ol>

        {step === "source" && (
          <div className="space-y-4">
            <div role="radiogroup" aria-label="Board source" className="grid gap-3 sm:grid-cols-2">
              {PROVIDERS.map((item) => {
                const active = item.id === provider;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setProvider(item.id)}
                    className={cn(
                      "flex h-full flex-col gap-1.5 rounded-xl border p-3.5 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150",
                      "focus-visible:ring-2 focus-visible:ring-ring/60",
                      active
                        ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/30"
                        : "border-border hover:border-primary/40 hover:bg-muted/40"
                    )}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-foreground">{item.name}</span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-4 items-center justify-center rounded-full border",
                          active ? "border-primary bg-primary text-primary-foreground" : "border-input"
                        )}
                      >
                        {active && <RiCheckLine className="size-3" />}
                      </span>
                    </span>
                    <span className="text-xs text-foreground/80">{item.summary}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">
                      {item.sources}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Boards that are already in the library are never changed. A board whose official
              sources disagree with its profile is added hidden, so it can be checked first.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void loadPreview()}>
                <RiSearchLine className="size-4" aria-hidden="true" />
                Preview boards
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-3">
            {loadingPreview && (
              <div role="status" className="space-y-2">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                  Reading the official sources. This can take a few seconds.
                </p>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {previewError && (
              <StatusAlert
                tone="danger"
                title="The preview could not be loaded"
                action={
                  <Button size="xs" variant="outline" onClick={() => void loadPreview()}>
                    Try again
                  </Button>
                }
              >
                {previewError}
              </StatusAlert>
            )}

            {preview && (
              <>
                <div className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{preview.providerLabel}</span>
                      <span className="text-muted-foreground">
                        {candidates.length} board{candidates.length === 1 ? "" : "s"} ·{" "}
                        {selectable.length} can be imported
                      </span>
                    </div>
                    {preview.liveSourcesReached > 0 ? (
                      <Badge variant="success-light" size="xs">
                        Checked against {preview.liveSourcesReached} official source
                        {preview.liveSourcesReached === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <Badge variant="warning-light" size="xs">
                        Official sources not reachable
                      </Badge>
                    )}
                  </div>
                  {preview.notes.length > 0 && (
                    <p className="break-words text-[11px] text-muted-foreground">
                      {preview.notes.join(" · ")}
                    </p>
                  )}
                </div>

                {preview.liveSourcesReached === 0 && (
                  <StatusAlert tone="warning" title="Preview from built-in profiles">
                    The official pages could not be reached, so nothing could be compared just now.
                    The boards below come from the profiles built into HomecoreOS, which were
                    checked against the official documentation when they were added.
                  </StatusAlert>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="relative min-w-0 flex-1 sm:max-w-xs">
                    <RiSearchLine
                      className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter boards"
                      aria-label="Filter boards in the preview"
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={selectable.length === 0 || selectedCount === selectable.length}
                      onClick={() => setSelected(new Set(selectable.map((c) => c.slug)))}
                    >
                      Select all ({selectable.length})
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={selectedCount === 0}
                      onClick={() => setSelected(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                </div>

                <ul className="space-y-2" aria-label="Boards found at the source">
                  {visible.length === 0 && (
                    <li className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                      No board matches this filter.
                    </li>
                  )}
                  {visible.map((candidate) => {
                    const isSelected = selected.has(candidate.slug);
                    const isOpen = expanded === candidate.slug;
                    const status = STATUS_BADGE[candidate.status];
                    const checkboxId = `import-${candidate.slug}`;
                    const padRows = candidate.board
                      ? listBoardPads(candidate.board, { gpioOnly: true })
                      : [];
                    return (
                      <li
                        key={candidate.slug}
                        data-testid={`import-candidate-${candidate.slug}`}
                        className={cn(
                          "rounded-xl border transition-[border-color,background-color] duration-150",
                          isSelected ? "border-primary/60 bg-primary/5" : "border-border bg-card",
                          !candidate.selectable && "opacity-80"
                        )}
                      >
                        <div className="flex items-start gap-3 p-3">
                          <Checkbox
                            id={checkboxId}
                            checked={isSelected}
                            disabled={!candidate.selectable}
                            onCheckedChange={() => toggle(candidate.slug)}
                            aria-label={`Select ${candidate.name}`}
                            className="mt-1"
                          />
                          {candidate.board && candidate.board.board_layout && (
                            <div className="hidden h-12 w-[4.5rem] shrink-0 items-center justify-center rounded-md border border-border bg-[#0b0e12] p-1 sm:flex">
                              <BoardVectorSvg
                                board={candidate.board}
                                orientation="horizontal"
                                compact
                                className="h-full w-full"
                              />
                            </div>
                          )}
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <label
                                htmlFor={checkboxId}
                                className={cn(
                                  "text-sm font-semibold text-foreground",
                                  candidate.selectable && "cursor-pointer"
                                )}
                              >
                                {candidate.name}
                              </label>
                              <Badge variant={status.variant} size="xs">
                                {status.label}
                              </Badge>
                              {candidate.board && (
                                <Badge
                                  variant={
                                    candidate.verification === "verified"
                                      ? "success-light"
                                      : "warning-light"
                                  }
                                  size="xs"
                                >
                                  {candidate.verification === "verified"
                                    ? "Verified pin map"
                                    : "Needs verification"}
                                </Badge>
                              )}
                            </div>
                            <p className="break-words text-xs text-muted-foreground">
                              {specLine(candidate)}
                            </p>
                            {(candidate.status !== "new" ||
                              candidate.verification === "needs_verification") && (
                              <p className="break-words text-[11px] text-muted-foreground">
                                {candidate.status !== "new"
                                  ? candidate.statusDetail
                                  : candidate.verificationNote}
                              </p>
                            )}
                            <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
                              {candidate.checks.map((check) => (
                                <li
                                  key={check.key}
                                  className="flex items-center gap-1 text-[11px] text-muted-foreground"
                                >
                                  <CheckMark status={check.status} />
                                  {check.label}
                                  <span className="sr-only">: {CHECK_STATUS_TEXT[check.status]}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            aria-expanded={isOpen}
                            aria-controls={`import-details-${candidate.slug}`}
                            aria-label={`${isOpen ? "Hide" : "Show"} details of ${candidate.name}`}
                            onClick={() => setExpanded(isOpen ? null : candidate.slug)}
                          >
                            Details
                            <RiArrowDownSLine
                              className={cn(
                                "size-3.5 transition-transform duration-150",
                                isOpen && "rotate-180"
                              )}
                              aria-hidden="true"
                            />
                          </Button>
                        </div>

                        {isOpen && (
                          <div
                            id={`import-details-${candidate.slug}`}
                            className="hc-step-enter grid gap-4 border-t px-3 py-3 md:grid-cols-2"
                          >
                            <div className="min-w-0 space-y-3">
                              {candidate.highlights.length > 0 && (
                                <section className="space-y-1">
                                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    About this board
                                  </h4>
                                  <ul className="list-disc space-y-0.5 pl-4 text-xs text-foreground/85">
                                    {candidate.highlights.map((line) => (
                                      <li key={line}>{line}</li>
                                    ))}
                                  </ul>
                                </section>
                              )}
                              <section className="space-y-1">
                                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  Source checks
                                </h4>
                                <ul className="space-y-1.5">
                                  {candidate.checks.map((check) => (
                                    <li key={check.key} className="flex items-start gap-1.5 text-xs">
                                      <CheckMark status={check.status} />
                                      <span className="min-w-0">
                                        <span className="font-medium text-foreground">
                                          {check.label}: {CHECK_STATUS_TEXT[check.status]}.
                                        </span>{" "}
                                        <span className="break-words text-muted-foreground">
                                          {check.detail}
                                        </span>{" "}
                                        {check.url && (
                                          <a
                                            href={check.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                                          >
                                            Open source
                                            <RiExternalLinkLine className="size-3" aria-hidden="true" />
                                          </a>
                                        )}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </section>
                              {candidate.verificationNote && (
                                <p className="break-words text-[11px] text-muted-foreground">
                                  {candidate.verificationNote}
                                </p>
                              )}
                              {candidate.sources.length > 0 && (
                                <section className="space-y-1">
                                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Official documentation
                                  </h4>
                                  <ul className="flex flex-wrap gap-x-3 gap-y-1">
                                    {candidate.sources.map((source) => (
                                      <li key={source.url}>
                                        <a
                                          href={source.url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
                                        >
                                          {source.label}
                                          <RiExternalLinkLine className="size-3" aria-hidden="true" />
                                        </a>
                                      </li>
                                    ))}
                                  </ul>
                                </section>
                              )}
                            </div>
                            <div className="min-w-0 space-y-1">
                              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Pinout
                              </h4>
                              {padRows.length > 0 ? (
                                <BoardPadTable
                                  rows={padRows}
                                  caption={`Pads of ${candidate.name} and the GPIO behind each one`}
                                />
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  No checked pin map exists for this board yet. It is added without
                                  pins and stays hidden until its pin map is verified.
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {unsupported.length > 0 && (
                  <div className="rounded-lg border border-dashed">
                    <button
                      type="button"
                      aria-expanded={showUnsupported}
                      aria-controls="import-unsupported"
                      onClick={() => setShowUnsupported((value) => !value)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                    >
                      <span>
                        {unsupported.length} other board{unsupported.length === 1 ? "" : "s"} at this
                        source cannot be imported
                      </span>
                      <RiArrowDownSLine
                        className={cn(
                          "size-4 shrink-0 transition-transform duration-150",
                          showUnsupported && "rotate-180"
                        )}
                        aria-hidden="true"
                      />
                    </button>
                    {showUnsupported && (
                      <ul
                        id="import-unsupported"
                        className="hc-step-enter grid gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px] sm:grid-cols-2"
                      >
                        {unsupported.map((candidate) => (
                          <li key={candidate.slug} className="min-w-0">
                            <span className="font-medium text-foreground">{candidate.name}</span>{" "}
                            <span className="break-words text-muted-foreground">
                              {candidate.statusDetail}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {importError && <StatusAlert tone="danger">{importError}</StatusAlert>}

                <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <Label htmlFor="import-publish" className="cursor-pointer text-xs font-medium">
                      Publish verified boards right away
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Published boards appear in the customer Board Library. Boards that need
                      verification are always added hidden.
                    </p>
                  </div>
                  <Switch id="import-publish" checked={publish} onCheckedChange={setPublish} />
                </div>
                {heldBackCount > 0 && (
                  <p className="flex items-start gap-1.5 text-[11px] text-warning-foreground">
                    <RiAlertLine className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    {heldBackCount} selected board{heldBackCount === 1 ? "" : "s"} will be added
                    hidden, because {heldBackCount === 1 ? "its" : "their"} pin map is not verified.
                  </p>
                )}
              </>
            )}

            <DialogFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={importing}
                onClick={() => {
                  requestRef.current += 1;
                  setLoadingPreview(false);
                  setStep("source");
                }}
              >
                <RiArrowLeftLine className="size-4" aria-hidden="true" />
                Back
              </Button>
              <Button
                type="button"
                disabled={!preview || selectedCount === 0 || importing}
                onClick={() => void handleImport()}
              >
                {importing ? (
                  <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RiDownloadCloud2Line className="size-4" aria-hidden="true" />
                )}
                {importing
                  ? "Importing..."
                  : selectedCount === 0
                    ? "Select boards to import"
                    : `Import ${selectedCount} board${selectedCount === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "result" && run && (
          <div className="space-y-3">
            <StatusAlert
              tone={
                run.importedCount + run.restoredCount === 0
                  ? "warning"
                  : run.status === "succeeded"
                    ? "success"
                    : "warning"
              }
              title={`${run.importedCount} imported · ${run.restoredCount} restored · ${run.skippedCount} skipped`}
            >
              {/* The counts are in the title, so only the source notes follow. */}
              <p>
                {run.needsVerificationCount > 0 &&
                  `${run.needsVerificationCount} added hidden: verify the pin map before publishing. `}
                {(run.sourceNotes ?? []).join(" · ")}
              </p>
            </StatusAlert>
            <ul className="space-y-1.5" aria-label="Import result per board">
              {run.outcomes.map((outcome) => (
                <li
                  key={outcome.slug}
                  data-action={outcome.action}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border bg-card px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="break-words text-xs font-semibold text-foreground">{outcome.name}</p>
                    <p className="break-words text-[11px] text-muted-foreground">{outcome.detail}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Badge
                      variant={
                        outcome.action === "imported"
                          ? "success-light"
                          : outcome.action === "restored"
                            ? "info-light"
                            : "secondary"
                      }
                      size="xs"
                    >
                      {outcome.action === "imported"
                        ? "Imported"
                        : outcome.action === "restored"
                          ? "Restored"
                          : "Skipped"}
                    </Badge>
                    {outcome.action !== "skipped" && (
                      <Badge variant={outcome.published ? "success-light" : "outline"} size="xs">
                        {outcome.published ? "Published" : "Hidden"}
                      </Badge>
                    )}
                    {outcome.verification === "needs_verification" && (
                      <Badge variant="warning-light" size="xs">
                        Needs verification
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <DialogFooter className="sm:justify-between">
              <Button type="button" variant="outline" onClick={() => setStep("source")}>
                Import more
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
