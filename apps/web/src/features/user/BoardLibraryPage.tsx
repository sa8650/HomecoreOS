import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  SUPPORTED_CHIP_FAMILIES,
  buildEsp32S3N16R8PinMap,
  chipFamilyLabel,
  validateBoardProfileSpec,
  type BoardProfileSpec,
  type ChipFamily,
  type GpioPinDefinition,
} from "@homecoreos/shared";
import {
  RiAddLine,
  RiBookmarkFill,
  RiBookmarkLine,
  RiCpuLine,
  RiDeleteBinLine,
} from "@remixicon/react";
import { toast } from "sonner";
import { BoardDetailsDialog } from "@/components/boards/BoardDetailsDialog";
import { BoardLibraryCard } from "@/components/boards/BoardLibraryCard";
import { apiFetch, ApiError, cachedGet, getCachedSnapshot } from "@/lib/api";
import { Badge } from "@/components/reui/badge";
import { Frame, FramePanel } from "@/components/reui/frame";
import {
  ConfirmDeleteDialog,
  EmptyStatePanel,
  FormField,
} from "@/components/shared/AppUi";
import { BOARD_LIBRARY_HERO_ICONS } from "@/components/shared/HeroDomainIcons";
import { PageHeroHeader } from "@/components/shared/PageHeroHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MagicCard } from "@/components/ui/magic-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BoardProfileItem } from "@/features/types";

export function BoardLibraryPage({ canManage }: { canManage: boolean }) {
  const cachedCat = getCachedSnapshot<{ boards: BoardProfileItem[] }>("/api/boards/catalog");
  const cachedMy = getCachedSnapshot<{
    catalogBoards: BoardProfileItem[];
    customBoards: BoardProfileItem[];
  }>("/api/boards/my-boards");

  const [tab, setTab] = useState("catalog");
  const [search, setSearch] = useState("");
  const [chipFilter, setChipFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [firmwareFilter, setFirmwareFilter] = useState("all");
  const [catalog, setCatalog] = useState<BoardProfileItem[]>(() => cachedCat?.boards ?? []);
  const [myCatalog, setMyCatalog] = useState<BoardProfileItem[]>(
    () => cachedMy?.catalogBoards ?? []
  );
  const [myCustom, setMyCustom] = useState<BoardProfileItem[]>(
    () => cachedMy?.customBoards ?? []
  );
  const [loading, setLoading] = useState(!cachedCat);
  const creatingBoardRef = useRef(false);
  const [inspectBoard, setInspectBoard] = useState<BoardProfileItem | null>(null);

  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [revision, setRevision] = useState("v1.0");
  const [chipFamily, setChipFamily] = useState<ChipFamily>("esp32s3");
  const [chipVariant, setChipVariant] = useState("ESP32-S3-WROOM-1");
  const [flashMb, setFlashMb] = useState(16);
  const [psramMb, setPsramMb] = useState(8);
  const [gpios, setGpios] = useState<GpioPinDefinition[]>(() =>
    buildEsp32S3N16R8PinMap().slice(0, 12)
  );
  const [newPinNum, setNewPinNum] = useState(15);
  const [newPinLabel, setNewPinLabel] = useState("GPIO15");
  const [newPinAdc, setNewPinAdc] = useState(false);
  const [newPinInputOnly, setNewPinInputOnly] = useState(false);
  const [newPinStrapping, setNewPinStrapping] = useState(false);
  const [newPinReserved, setNewPinReserved] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<BoardProfileItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);

  async function load(force = false) {
    if (!getCachedSnapshot("/api/boards/catalog")) {
      setLoading(true);
    }
    try {
      const [catRes, myRes] = await Promise.all([
        cachedGet<{ boards: BoardProfileItem[] }>("/api/boards/catalog", {
          ttlMs: 60_000,
          force,
        }),
        cachedGet<{
          catalogBoards: BoardProfileItem[];
          customBoards: BoardProfileItem[];
        }>("/api/boards/my-boards", { ttlMs: 60_000, force }),
      ]);
      setCatalog(catRes.boards);
      setMyCatalog(myRes.catalogBoards);
      setMyCustom(myRes.customBoards);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load boards.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleSaveToMyBoards(boardId: string) {
    try {
      await apiFetch(`/api/boards/my-boards/${boardId}`, { method: "POST" });
      toast.success("Board saved to My Boards.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save board.");
    }
  }

  async function handleRemoveFromMyBoards(boardId: string) {
    try {
      await apiFetch(`/api/boards/my-boards/${boardId}`, { method: "DELETE" });
      toast.success("Board removed from My Boards.");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove board.");
    }
  }

  function handleAddPinRow() {
    if (gpios.some((g) => g.pin === newPinNum)) {
      toast.error(`GPIO ${newPinNum} is already defined.`);
      return;
    }
    const row: GpioPinDefinition = {
      pin: newPinNum,
      label: newPinLabel.trim() || `GPIO${newPinNum}`,
      capabilities: {
        digital_in: !newPinReserved,
        digital_out: !newPinReserved && !newPinInputOnly,
        pwm: !newPinReserved && !newPinInputOnly,
        adc: newPinAdc,
        i2c: !newPinReserved && !newPinInputOnly,
        spi: !newPinReserved && !newPinInputOnly,
        uart: !newPinReserved && !newPinInputOnly,
        touch: false,
        pull_up: !newPinReserved,
        pull_down: !newPinReserved,
      },
      restrictions: {
        input_only: newPinInputOnly,
        reserved: newPinReserved,
        reserved_reason: newPinReserved ? "Reserved by board hardware" : undefined,
        strapping_pin: newPinStrapping,
        strapping_note: newPinStrapping ? "Boot strapping pin" : undefined,
        flash_psram_conflict: false,
        usb_jtag_conflict: false,
      },
    };
    setGpios((prev) => [...prev, row].sort((a, b) => a.pin - b.pin));
  }

  async function handleCreateCustomBoard(e: FormEvent) {
    e.preventDefault();
    if (creatingBoardRef.current) return;
    const spec: BoardProfileSpec = {
      slug: `${manufacturer}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      manufacturer: manufacturer.trim(),
      model: model.trim(),
      revision: revision.trim(),
      chip_family: chipFamily,
      chip_variant: chipVariant.trim(),
      flash_size_mb: flashMb,
      psram_size_mb: psramMb,
      gpio_definitions: gpios,
    };
    const localValidation = validateBoardProfileSpec(spec);
    if (!localValidation.valid) {
      toast.error(localValidation.errors.join(" "));
      return;
    }
    creatingBoardRef.current = true;
    try {
      await apiFetch("/api/boards/custom", {
        method: "POST",
        body: JSON.stringify({
          manufacturer: spec.manufacturer,
          model: spec.model,
          revision: spec.revision,
          chipFamily: spec.chip_family,
          chipVariant: spec.chip_variant,
          flashSizeMb: spec.flash_size_mb,
          psramSizeMb: spec.psram_size_mb,
          gpioDefinitions: spec.gpio_definitions,
        }),
      });
      setManufacturer("");
      setModel("");
      toast.success("Validated custom board profile saved.");
      setTab("my-boards");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save custom board.");
    } finally {
      creatingBoardRef.current = false;
    }
  }

  async function handleConfirmDeleteCustom() {
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await apiFetch(`/api/boards/custom/${deleteTarget.id}`, { method: "DELETE" });
      toast.success(`Deleted custom board "${deleteTarget.model}".`);
      setDeleteTarget(null);
      await load(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed.");
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  if (loading && catalog.length === 0) {
    return (
      <div className="py-12 text-center text-xs text-muted-foreground">
        Loading board library...
      </div>
    );
  }

  const filteredCatalog = catalog.filter((b) => {
    if (chipFilter !== "all" && b.chip_family !== chipFilter) return false;
    if (categoryFilter !== "all" && (b.catalog_category ?? "official_espressif") !== categoryFilter) {
      return false;
    }
    if (firmwareFilter !== "all" && (b.firmware_status ?? "catalog_only") !== firmwareFilter) {
      return false;
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return `${b.manufacturer} ${b.model} ${b.chip_variant} ${b.slug} ${b.series ?? ""}`
        .toLowerCase()
        .includes(q);
    }
    return true;
  });

  const savedIds = new Set(myCatalog.map((b) => b.id));

  const savedTotal = myCatalog.length + myCustom.length;

  return (
    <div className="space-y-6">
      <PageHeroHeader
        tone="orange"
        ariaLabel="Board Library Header"
        title="HomecoreOS Board Library"
        subtitle={
          <>
            Explore verified{" "}
            <span className="font-medium text-foreground/85">
              Espressif DevKits, Partner Boards, Interactive Pinouts,
            </span>{" "}
            <br className="hidden sm:inline" />
            Flash &amp; PSRAM Specs,{" "}
            <span className="font-semibold text-[#d26736] dark:text-amber-400">
              GPIO Constraints,
            </span>{" "}
            &amp; Custom Profiles
          </>
        }
        leftIcons={BOARD_LIBRARY_HERO_ICONS.left}
        rightIcons={BOARD_LIBRARY_HERO_ICONS.right}
        searchValue={search}
        onSearchChange={(next) => {
          setSearch(next);
          if (next && tab !== "catalog") {
            setTab("catalog");
          }
        }}
        searchAriaLabel="Search board catalog"
        searchPlaceholder="Search in Board Library (model, chip, XIAO, DevKit)..."
      />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* On narrow phones the tab strip scrolls inside itself instead of widening the page. */}
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="catalog">
              Board Catalog ({catalog.length})
            </TabsTrigger>
            <TabsTrigger value="my-boards">
              My Boards ({savedTotal})
            </TabsTrigger>
            <TabsTrigger value="custom">Custom Board Builder</TabsTrigger>
          </TabsList>

          {tab === "catalog" && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger aria-label="Filter by board source" className="h-8 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="official_espressif">Official Espressif</SelectItem>
                  <SelectItem value="partner">Partner Boards</SelectItem>
                </SelectContent>
              </Select>
              <Select value={chipFilter} onValueChange={setChipFilter}>
                <SelectTrigger aria-label="Filter by chip family" className="h-8 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Chips</SelectItem>
                  {SUPPORTED_CHIP_FAMILIES.map((fam) => (
                    <SelectItem key={fam} value={fam}>
                      {fam.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={firmwareFilter} onValueChange={setFirmwareFilter}>
                <SelectTrigger aria-label="Filter by firmware support" className="h-8 w-40 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Firmware States</SelectItem>
                  <SelectItem value="firmware_supported">Firmware Supported</SelectItem>
                  <SelectItem value="catalog_only">Catalog Only</SelectItem>
                  <SelectItem value="build_pending">Build Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <TabsContent value="catalog" className="space-y-4 pt-2">
          {filteredCatalog.length === 0 ? (
            <EmptyStatePanel
              icon={<RiCpuLine />}
              title="No matching boards found"
              description="Adjust your chip family, category, or firmware filter to inspect available microcontroller profiles."
              action={
                (search.trim() ||
                  chipFilter !== "all" ||
                  categoryFilter !== "all" ||
                  firmwareFilter !== "all") ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setChipFilter("all");
                      setCategoryFilter("all");
                      setFirmwareFilter("all");
                    }}
                  >
                    Clear Filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredCatalog.map((b) => (
                <BoardLibraryCard
                  key={b.id}
                  board={b}
                  source={b.catalog_category === "partner" ? "partner" : "official"}
                  onOpenDetails={() => setInspectBoard(b)}
                  action={
                    savedIds.has(b.id) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8 shrink-0 text-xs"
                        disabled={!canManage}
                        aria-label={`Remove ${b.model} from My Boards`}
                        onClick={() => void handleRemoveFromMyBoards(b.id)}
                      >
                        <RiBookmarkFill className="size-3.5 text-primary" aria-hidden="true" />
                        Saved
                      </Button>
                    ) : canManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 text-xs"
                        aria-label={`Save ${b.model} to My Boards`}
                        onClick={() => void handleSaveToMyBoards(b.id)}
                      >
                        <RiBookmarkLine className="size-3.5" aria-hidden="true" />
                        Save
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="my-boards" className="pt-2">
          {myCatalog.length === 0 && myCustom.length === 0 ? (
            <EmptyStatePanel
              icon={<RiCpuLine className="size-6" />}
              title="No boards saved yet"
              description="Save a catalog board or build a validated custom board profile to attach controllers."
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {myCatalog.map((b) => (
                <BoardLibraryCard
                  key={b.id}
                  board={b}
                  source={b.catalog_category === "partner" ? "partner" : "official"}
                  onOpenDetails={() => setInspectBoard(b)}
                  action={
                    canManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 text-xs"
                        aria-label={`Remove ${b.model} from My Boards`}
                        onClick={() => void handleRemoveFromMyBoards(b.id)}
                      >
                        Unsave
                      </Button>
                    ) : undefined
                  }
                />
              ))}
              {myCustom.map((b) => (
                <BoardLibraryCard
                  key={b.id}
                  board={b}
                  source="custom"
                  compactDrawing
                  onOpenDetails={() => setInspectBoard(b)}
                  action={
                    canManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 text-xs"
                        aria-label={`Delete custom board ${b.model}`}
                        onClick={() => setDeleteTarget(b)}
                      >
                        <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
                        Delete
                      </Button>
                    ) : undefined
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="custom" className="pt-2">
          <Card className="border-none p-0 shadow-none ring-0">
            <MagicCard
              mode="orb"
              spotlightTone="orange"
              className="rounded-xl p-0"
              contentClassName="py-4"
            >
              <CardContent>
              {!canManage ? (
                <p className="text-xs text-muted-foreground">
                  Only Owners and Administrators can define custom board hardware profiles.
                </p>
              ) : (
                <form onSubmit={handleCreateCustomBoard} className="space-y-5">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <FormField id="cb-mfg" label="Manufacturer">
                      <Input
                        id="cb-mfg"
                        required
                        value={manufacturer}
                        onChange={(e) => setManufacturer(e.target.value)}
                        placeholder="LilyGO / Waveshare"
                      />
                    </FormField>
                    <FormField id="cb-model" label="Board Model">
                      <Input
                        id="cb-model"
                        required
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="S3 Relay 4CH"
                      />
                    </FormField>
                    <FormField id="cb-rev" label="Revision">
                      <Input
                        id="cb-rev"
                        value={revision}
                        onChange={(e) => setRevision(e.target.value)}
                      />
                    </FormField>
                    <FormField id="cb-chip" label="Chip Family">
                      <Select
                        value={chipFamily}
                        onValueChange={(v) => setChipFamily(v as ChipFamily)}
                      >
                        <SelectTrigger id="cb-chip" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SUPPORTED_CHIP_FAMILIES.map((chip) => (
                            <SelectItem key={chip} value={chip}>
                              {chipFamilyLabel(chip)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                    <FormField id="cb-var" label="Chip Variant">
                      <Input
                        id="cb-var"
                        required
                        value={chipVariant}
                        onChange={(e) => setChipVariant(e.target.value)}
                      />
                    </FormField>
                    <FormField id="cb-flash" label="Flash (MB)">
                      <Input
                        id="cb-flash"
                        type="number"
                        min={2}
                        max={64}
                        value={flashMb}
                        onChange={(e) => setFlashMb(Number(e.target.value))}
                      />
                    </FormField>
                    <FormField id="cb-psram" label="PSRAM (MB)">
                      <Input
                        id="cb-psram"
                        type="number"
                        min={0}
                        max={32}
                        value={psramMb}
                        onChange={(e) => setPsramMb(Number(e.target.value))}
                      />
                    </FormField>
                  </div>

                  <Frame spacing="sm">
                    <FramePanel className="space-y-3">
                      <h3 className="text-xs font-semibold text-foreground">
                        Add GPIO Pin Definition ({gpios.length} pins defined)
                      </h3>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="w-24">
                          <FormField id="pin-num" label="Pin #">
                            <Input
                              id="pin-num"
                              type="number"
                              min={0}
                              max={54}
                              value={newPinNum}
                              onChange={(e) => setNewPinNum(Number(e.target.value))}
                            />
                          </FormField>
                        </div>
                        <div className="w-36">
                          <FormField id="pin-lbl" label="Pin Label">
                            <Input
                              id="pin-lbl"
                              value={newPinLabel}
                              onChange={(e) => setNewPinLabel(e.target.value)}
                            />
                          </FormField>
                        </div>
                        <div className="flex items-center gap-1.5 pb-1.5">
                          <Switch id="pin-adc" checked={newPinAdc} onCheckedChange={setNewPinAdc} />
                          <Label htmlFor="pin-adc" className="text-xs">ADC</Label>
                        </div>
                        <div className="flex items-center gap-1.5 pb-1.5">
                          <Switch id="pin-in" checked={newPinInputOnly} onCheckedChange={setNewPinInputOnly} />
                          <Label htmlFor="pin-in" className="text-xs">Input-only</Label>
                        </div>
                        <div className="flex items-center gap-1.5 pb-1.5">
                          <Switch id="pin-strap" checked={newPinStrapping} onCheckedChange={setNewPinStrapping} />
                          <Label htmlFor="pin-strap" className="text-xs">Strapping</Label>
                        </div>
                        <div className="flex items-center gap-1.5 pb-1.5">
                          <Switch id="pin-res" checked={newPinReserved} onCheckedChange={setNewPinReserved} />
                          <Label htmlFor="pin-res" className="text-xs">Reserved</Label>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleAddPinRow}
                        >
                          <RiAddLine className="size-3.5" aria-hidden="true" />
                          Add Pin
                        </Button>
                      </div>

                      <div className="max-h-60 overflow-y-auto rounded-lg border bg-card">
                        <Table className="text-xs">
                          <TableHeader className="bg-muted/60">
                            <TableRow>
                              <TableHead>Pin</TableHead>
                              <TableHead>Label</TableHead>
                              <TableHead>Capabilities</TableHead>
                              <TableHead>Restrictions</TableHead>
                              <TableHead>Action</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {gpios.map((g) => (
                              <TableRow key={g.pin}>
                                <TableCell className="font-mono font-semibold">GPIO{g.pin}</TableCell>
                                <TableCell>{g.label}</TableCell>
                                <TableCell className="text-muted-foreground">
                                  {[
                                    g.capabilities.digital_out && "OUT",
                                    g.capabilities.digital_in && "IN",
                                    g.capabilities.pwm && "PWM",
                                    g.capabilities.adc && "ADC",
                                    g.capabilities.i2c && "I2C",
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </TableCell>
                                <TableCell>
                                  {g.restrictions.reserved ? (
                                    <Badge variant="destructive-light">Reserved</Badge>
                                  ) : g.restrictions.strapping_pin ? (
                                    <Badge variant="warning-light">Strapping</Badge>
                                  ) : g.restrictions.input_only ? (
                                    <Badge variant="warning-light">Input-only</Badge>
                                  ) : (
                                    <Badge variant="success-light">Usable</Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="ghost"
                                    onClick={() =>
                                      setGpios((prev) => prev.filter((x) => x.pin !== g.pin))
                                    }
                                  >
                                    Remove
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </FramePanel>
                  </Frame>

                  <div className="flex justify-end">
                    <Button type="submit">Validate & Save Custom Board</Button>
                  </div>
                </form>
              )}
            </CardContent>
            </MagicCard>
          </Card>
        </TabsContent>
      </Tabs>

      <BoardDetailsDialog board={inspectBoard} onClose={() => setInspectBoard(null)} />

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete custom board "${deleteTarget?.model ?? ""}"?`}
        description="This removes your custom board profile from the library."
        confirmLabel="Delete Custom Board"
        busy={deleting}
        onConfirm={handleConfirmDeleteCustom}
      />
    </div>
  );
}
