import {
  RiKeyLine,
  RiLightbulbFlashLine,
  RiLightbulbLine,
  RiPlug2Line,
  RiPlugLine,
  RiAirplayLine,
  RiCupLine,
  RiHome4Line,
  RiLeafLine,
  RiLockLine,
  RiMoonClearLine,
  RiRemoteControlLine,
  RiShutDownLine,
  RiSpeakerLine,
  RiSparklingLine,
  RiStarLine,
  RiSunLine,
  RiTv2Line,
  RiWifiLine,
  type RemixiconComponentType,
} from "@remixicon/react";
import type { ActionButtonColor, ActionButtonIcon } from "@homecoreos/shared";
import { ACTION_BUTTON_COLOR_HEX } from "@homecoreos/shared";

export const ACTION_BUTTON_ICON_COMPONENTS: Record<string, RemixiconComponentType> = {
  zap: RiLightbulbFlashLine,
  power: RiShutDownLine,
  lightbulb: RiLightbulbLine,
  plug: RiPlugLine,
  outlet: RiPlug2Line,
  tv: RiTv2Line,
  lock: RiLockLine,
  wifi: RiWifiLine,
  home: RiHome4Line,
  moon: RiMoonClearLine,
  sun: RiSunLine,
  star: RiStarLine,
  coffee: RiCupLine,
  speaker: RiSpeakerLine,
  airplay: RiAirplayLine,
  leaf: RiLeafLine,
  remote: RiRemoteControlLine,
  sparkles: RiSparklingLine,
  key: RiKeyLine,
};

export function ActionButtonGlyph({
  icon,
  className,
  style,
}: {
  icon: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Component =
    ACTION_BUTTON_ICON_COMPONENTS[icon] ?? ACTION_BUTTON_ICON_COMPONENTS.zap;
  return <Component className={className} style={style} aria-hidden="true" />;
}

export function actionButtonColorHex(color: string | undefined): string {
  return ACTION_BUTTON_COLOR_HEX[(color ?? "blue") as ActionButtonColor] ?? "#3b76f6";
}

/** Derive the ON/OFF/MIXED label for a set of controllable targets. */
export function aggregateStateLabel(
  states: { on: number; off: number } | null | undefined
): "ON" | "OFF" | "MIXED" | null {
  if (!states) return null;
  const { on, off } = states;
  if (on + off === 0) return null;
  if (off === 0 && on > 0) return "ON";
  if (on === 0 && off > 0) return "OFF";
  return "MIXED";
}

export type { ActionButtonIcon };
