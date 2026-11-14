import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GpioPinEntityKind, PinOperationRequirement } from "@homecoreos/shared";
import {
  resolvePinChoice,
  resolvePinMap,
  suggestedDefaultPin,
  type HardwareContext,
  type PinSelection,
} from "@/lib/board-pin-helpers";
import type { ControllerItem } from "@/features/types";

export interface GpioPinField {
  /** Text of the pin field. An empty string means "no pin". */
  text: string;
  /** Called when the user types a pin or picks one from the map. */
  setPin: (raw: string) => void;
  /** The entered pin as a number, or null when the field is empty. */
  pinNum: number | null;
  /** The pin map and the verdict for the entered pin. */
  selection: PinSelection;
}

/**
 * State of the GPIO pin field in the device, switch and sensor editors.
 *
 * While editing, the field starts from the saved pin. For something new it
 * follows the best suggestion for the selected controller and type, until the
 * user picks a pin themselves.
 */
export function useGpioPinField(params: {
  open: boolean;
  /** The saved pin of the entity being edited; undefined for a new entity. */
  savedPin: number | null | undefined;
  controller: ControllerItem | undefined;
  ctx: HardwareContext;
  requirement: PinOperationRequirement;
  entityKind: GpioPinEntityKind;
  /** Id of the entity being edited, so its own pin is not a conflict. */
  entityId: string | undefined;
  /** Starting pin when the board's pin map is unknown ("" for none). */
  fallbackPin: string;
}): GpioPinField {
  const { open, savedPin, controller, ctx, requirement, entityKind, entityId, fallbackPin } = params;
  const isEditing = savedPin !== undefined;
  const [text, setText] = useState("");
  const initializedRef = useRef(false);
  const touchedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      return;
    }
    if (initializedRef.current) return;
    initializedRef.current = true;
    touchedRef.current = isEditing;
    setText(isEditing && savedPin !== null ? String(savedPin) : "");
  }, [open, isEditing, savedPin]);

  const pinMap = useMemo(
    () =>
      resolvePinMap({
        controller,
        boardsById: ctx.boardsById,
        requirement,
        usedPinsByController: ctx.usedPinsByController,
        excludeEntity: entityId ? { kind: entityKind, id: entityId } : undefined,
      }),
    [controller, ctx.boardsById, ctx.usedPinsByController, requirement, entityKind, entityId]
  );

  const hasPinMap = pinMap.model !== null;
  const suggestedPin = suggestedDefaultPin(pinMap.model, requirement);

  useEffect(() => {
    if (!open || isEditing || touchedRef.current) return;
    const next = hasPinMap ? (suggestedPin !== null ? String(suggestedPin) : "") : fallbackPin;
    setText((previous) => (previous === next ? previous : next));
  }, [open, isEditing, hasPinMap, suggestedPin, fallbackPin]);

  const setPin = useCallback((raw: string) => {
    touchedRef.current = true;
    setText(raw);
  }, []);

  const pinNum = text.trim() === "" ? null : Number(text);
  const selection = useMemo(() => resolvePinChoice(pinMap, pinNum), [pinMap, pinNum]);

  return { text, setPin, pinNum, selection };
}
