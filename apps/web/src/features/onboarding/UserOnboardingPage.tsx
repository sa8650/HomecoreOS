import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  RiArrowRightLine,
  RiBookOpenLine,
  RiCheckLine,
  RiCloudLine,
  RiCpuLine,
  RiErrorWarningLine,
  RiFlashlightLine,
  RiHomeGearLine,
  RiLoader4Line,
  RiLogoutBoxRLine,
  RiRouterLine,
  RiSensorLine,
  RiStackLine,
  RiToggleLine,
} from "@remixicon/react";
import {
  ONBOARDING_STEPS,
  ONBOARDING_TOTAL_STEPS,
  type OnboardingState,
  type OnboardingStepId,
} from "@homecoreos/shared";
import { apiFetch, ApiError } from "@/lib/api";
import { HomecoreWordmark } from "@/components/graphics/HomecoreGraphics";
import { Onboarding } from "@/components/ui/onboarding";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/reui/badge";
import type { UserSessionData } from "@/features/types";
import {
  ControlAutomateArt,
  HardwareChainArt,
  MonitorExpandArt,
  WelcomeHomeArt,
} from "@/features/onboarding/OnboardingArt";

export interface UserOnboardingPageProps {
  session: UserSessionData;
  onSessionRefresh: () => Promise<void> | void;
  onSignOut: () => Promise<void> | void;
  /** Called once the server confirms completion. */
  onFinished: () => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";

interface StepCopy {
  title: string;
  lede: string;
  art: ReactNode;
  points: Array<{ icon: ReactNode; term: string; text: string }>;
  footnote?: string;
}

const STEP_COPY: Record<OnboardingStepId, StepCopy> = {
  1: {
    title: "Welcome to Your Smart Home",
    lede:
      "HomecoreOS is the one place where your home lives: every room, every light, every sensor, on a single dashboard you can open from any browser.",
    art: <WelcomeHomeArt />,
    points: [
      {
        icon: <RiHomeGearLine className="size-4" aria-hidden="true" />,
        term: "Home, Areas & Rooms",
        text: "Your home is organised into Areas and Rooms, so you always know where a device is and what it belongs to.",
      },
      {
        icon: <RiCpuLine className="size-4" aria-hidden="true" />,
        term: "Nodes",
        text: "A Node is the small board that connects physical hardware in a room to HomecoreOS.",
      },
      {
        icon: <RiSensorLine className="size-4" aria-hidden="true" />,
        term: "Sensors & Devices",
        text: "Sensors collect information, while switches and devices perform actions such as turning a light on.",
      },
      {
        icon: <RiFlashlightLine className="size-4" aria-hidden="true" />,
        term: "Automations",
        text: "Automations make things happen on their own, using the information your sensors collect.",
      },
      {
        icon: <RiCloudLine className="size-4" aria-hidden="true" />,
        term: "One dashboard",
        text: "Everything is monitored and managed from the same HomecoreOS dashboard - no separate apps per room.",
      },
    ],
  },
  2: {
    title: "Connect Your Hardware",
    lede:
      "HomecoreOS talks to your home through Nodes. A Node is a controller board installed in the home - for example a supported ESP32 development board from the Board Library.",
    art: <HardwareChainArt />,
    points: [
      {
        icon: <RiStackLine className="size-4" aria-hidden="true" />,
        term: "Board Library",
        text: "Board Library lists every supported board, with its specifications, GPIO pins and firmware compatibility.",
      },
      {
        icon: <RiCpuLine className="size-4" aria-hidden="true" />,
        term: "Configure a Node",
        text: "Pick the board, assign its GPIO pins, then connect the compatible sensors, switches, relays and other devices for that room.",
      },
      {
        icon: <RiToggleLine className="size-4" aria-hidden="true" />,
        term: "Relays & drivers",
        text: "Some electrical devices need an extra component to switch safely - a relay module or a driver board - and HomecoreOS shows which ones you need.",
      },
      {
        icon: <RiRouterLine className="size-4" aria-hidden="true" />,
        term: "Home network",
        text: "A Node joins your home Wi-Fi, so it works from anywhere inside the house and reports back to HomecoreOS.",
      },
      {
        icon: <RiBookOpenLine className="size-4" aria-hidden="true" />,
        term: "Flash, Setup & Recover",
        text: "Flash Controller installs HomecoreOS on a new board, Setup Controller walks you through Wi-Fi and pairing, and Repair / Recover Controller brings a Node back if it loses its connection.",
      },
    ],
    footnote: "Physical Device → Node → Home Wi-Fi → HomecoreOS",
  },
  3: {
    title: "Control and Automate Your Home",
    lede:
      "Once a Node is connected, its devices appear on your dashboard. You decide which room they belong to and how they behave.",
    art: <ControlAutomateArt />,
    points: [
      {
        icon: <RiStackLine className="size-4" aria-hidden="true" />,
        term: "Areas & Rooms",
        text: "Create and manage Areas and Rooms, then add each device to the room where it physically lives.",
      },
      {
        icon: <RiSensorLine className="size-4" aria-hidden="true" />,
        term: "Overview & home map",
        text: "The Overview page and the 2D home map show every device and its current state at a glance.",
      },
      {
        icon: <RiToggleLine className="size-4" aria-hidden="true" />,
        term: "Control",
        text: "Control supported devices straight from the dashboard, and monitor sensor readings and device status as they change.",
      },
      {
        icon: <RiFlashlightLine className="size-4" aria-hidden="true" />,
        term: "Automations",
        text: "Automations are built from a trigger, an optional condition and an action - for example: when motion is detected in the hallway at night, automatically turn on the hallway light.",
      },
    ],
  },
  4: {
    title: "Monitor, Manage and Expand",
    lede:
      "Your smart home keeps working while you watch over it. HomecoreOS shows what happened and helps you add more whenever you are ready.",
    art: <MonitorExpandArt />,
    points: [
      {
        icon: <RiRouterLine className="size-4" aria-hidden="true" />,
        term: "Node connectivity",
        text: "Monitor whether each Node is online, and see the status of every device it controls.",
      },
      {
        icon: <RiBookOpenLine className="size-4" aria-hidden="true" />,
        term: "Activity",
        text: "Activity records what happened in the home, so you can always understand a change after the fact.",
      },
      {
        icon: <RiCpuLine className="size-4" aria-hidden="true" />,
        term: "Firmware & recovery",
        text: "Manage firmware updates from Firmware & Updates, and recover a Node from My Boards if it stops responding.",
      },
      {
        icon: <RiStackLine className="size-4" aria-hidden="true" />,
        term: "Grow over time",
        text: "Add more Nodes, boards, sensors and devices as the home expands, and manage authorised users where your plan supports it.",
      },
      {
        icon: <RiCheckLine className="size-4" aria-hidden="true" />,
        term: "No electronics knowledge needed",
        text: "You manage everything from the HomecoreOS dashboard - the communication technology stays out of your way.",
      },
    ],
  },
};

export function UserOnboardingPage({
  session,
  onSessionRefresh,
  onSignOut,
  onFinished,
}: UserOnboardingPageProps) {
  const initialStep = (session.onboarding?.step ?? 1) as OnboardingStepId;
  const [step, setStep] = useState<OnboardingStepId>(initialStep);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const lastSavedStep = useRef<number>(initialStep);

  // The server is the source of truth: a refresh (or a second tab) always
  // resumes on the stored step.
  useEffect(() => {
    const stored = (session.onboarding?.step ?? 1) as OnboardingStepId;
    if (session.onboarding?.required) {
      setStep(stored);
      lastSavedStep.current = stored;
    }
  }, [session.onboarding?.required, session.onboarding?.step]);

  const persistStep = useCallback(async (next: OnboardingStepId) => {
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await apiFetch<{ onboarding: OnboardingState }>("/api/auth/onboarding", {
        method: "PUT",
        body: JSON.stringify({ step: next }),
      });
      lastSavedStep.current = res.onboarding?.step ?? next;
      setSaveState("saved");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Your progress could not be saved. Check your connection and try again.";
      setSaveError(message);
      setSaveState("error");
    }
  }, []);

  const handleStepChange = useCallback(
    (nextStep: number) => {
      const clamped = Math.min(Math.max(nextStep, 1), ONBOARDING_TOTAL_STEPS) as OnboardingStepId;
      setStep(clamped);
      if (clamped !== lastSavedStep.current && !completing) {
        void persistStep(clamped);
      }
    },
    [completing, persistStep]
  );

  const handleComplete = useCallback(async () => {
    if (completing) return;
    setCompleting(true);
    setSaveError(null);
    try {
      await apiFetch<{ onboarding: OnboardingState }>("/api/auth/onboarding/complete", {
        method: "POST",
      });
      await onSessionRefresh();
      onFinished();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "Onboarding could not be completed. Check your connection and try again.";
      setSaveError(message);
      setSaveState("error");
      setCompleting(false);
    }
  }, [completing, onFinished, onSessionRefresh]);

  const retrySave = useCallback(() => {
    void persistStep(step);
  }, [persistStep, step]);

  const copy = STEP_COPY[step];
  const isLastStep = step === ONBOARDING_TOTAL_STEPS;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 hc-blueprint-bg opacity-70" />
        <div className="absolute -top-32 left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="absolute -bottom-40 right-0 size-[30rem] rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-8">
        <header className="pointer-events-auto mx-auto flex w-full items-center justify-between gap-3">
          <HomecoreWordmark subtitle="Set up your smart home" compact />
          <div className="flex items-center gap-2">
            <Badge variant="primary-light" radius="full" className="hidden sm:inline-flex">
              Step {step} of {ONBOARDING_TOTAL_STEPS}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void onSignOut()}
            >
              <RiLogoutBoxRLine className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center">
          <section aria-label="HomecoreOS onboarding" className="w-full">
            <Onboarding
              value={step}
              onValueChange={handleStepChange}
              totalSteps={ONBOARDING_TOTAL_STEPS}
              onComplete={handleComplete}
              canGoNext={() => true}
              className="mx-auto w-full max-w-5xl gap-5 rounded-3xl border-border/70 bg-card/95 p-4 shadow-xl backdrop-blur-sm sm:gap-6 sm:p-6 lg:p-8"
            >
              <Onboarding.Header className="text-left">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      Step {step} of {ONBOARDING_TOTAL_STEPS} · {ONBOARDING_STEPS[step - 1]!.shortLabel}
                    </p>
                    <SaveIndicator state={saveState} />
                  </div>
                  <Onboarding.StepIndicator variant="pills" className="w-full" />
                  <StepRail currentStep={step} />
                </div>
              </Onboarding.Header>

              <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start lg:gap-7">
                <div key={`art-${step}`} className="hc-onboarding-enter min-w-0">
                  <div className="overflow-hidden rounded-2xl border border-border/70 bg-white/70 shadow-xs dark:bg-slate-950/40">
                    {copy.art}
                  </div>
                </div>

                <Onboarding.Step step={step} className="hc-onboarding-enter min-w-0 space-y-4">
                  <div className="space-y-2">
                    <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
                      {copy.title}
                    </h1>
                    <p className="text-sm leading-relaxed text-muted-foreground">{copy.lede}</p>
                  </div>

                  <ul className="space-y-3">
                    {copy.points.map((point) => (
                      <li key={point.term} className="flex gap-3">
                        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-sky-400">
                          {point.icon}
                        </span>
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          <span className="font-medium text-foreground">{point.term}.</span>{" "}
                          {point.text}
                        </p>
                      </li>
                    ))}
                  </ul>

                  {copy.footnote && (
                    <p className="rounded-xl border border-dashed border-border/80 bg-muted/40 px-3 py-2 text-center text-[11px] font-medium tracking-wide text-muted-foreground">
                      {copy.footnote}
                    </p>
                  )}

                  {isLastStep && (
                    <p className="text-balance rounded-xl bg-gradient-to-r from-blue-500/10 via-emerald-500/10 to-amber-400/10 px-4 py-3 text-center text-sm font-semibold text-foreground">
                      Your home is ready. Let&apos;s make it smarter.
                    </p>
                  )}
                </Onboarding.Step>
              </div>

              {saveError && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                >
                  <span className="flex items-center gap-2">
                    <RiErrorWarningLine className="size-4" aria-hidden="true" />
                    {saveError}
                  </span>
                  <Button variant="outline" size="sm" onClick={retrySave}>
                    Try again
                  </Button>
                </div>
              )}

              <Onboarding.Navigation
                backLabel="Back"
                nextLabel="Next"
                completeLabel="Get Started"
                canGoNext={!completing && saveState !== "saving"}
                className="flex flex-col gap-2 border-t border-border/70 pt-4 sm:flex-row"
              >
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 py-5"
                  disabled={step === 1 || completing}
                  onClick={() => handleStepChange(step - 1)}
                >
                  Back
                </Button>
                {isLastStep ? (
                  <Button
                    type="button"
                    className="flex-1 py-5"
                    disabled={completing}
                    onClick={() => void handleComplete()}
                  >
                    {completing ? (
                      <>
                        <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                        Finishing...
                      </>
                    ) : (
                      <>
                        Get Started
                        <RiArrowRightLine className="size-4" aria-hidden="true" />
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="flex-1 py-5"
                    disabled={saveState === "saving" || completing}
                    onClick={() => handleStepChange(step + 1)}
                  >
                    {saveState === "saving" ? (
                      <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    Next
                    {saveState !== "saving" && (
                      <RiArrowRightLine className="size-4" aria-hidden="true" />
                    )}
                  </Button>
                )}
              </Onboarding.Navigation>
            </Onboarding>
          </section>
        </main>

        <footer className="mx-auto w-full max-w-5xl text-center text-[11px] text-muted-foreground">
          Signed in as {session.user.email} · {session.account.name} · progress is saved to your account
        </footer>
      </div>
    </div>
  );
}

function StepRail({ currentStep }: { currentStep: number }) {
  return (
    <ol className="hidden flex-wrap items-center gap-2 sm:flex" aria-hidden="true">
      {ONBOARDING_STEPS.map((definition) => {
        const state =
          definition.id < currentStep ? "done" : definition.id === currentStep ? "current" : "todo";
        return (
          <li key={definition.id} className="flex items-center gap-2">
            <span
              className={[
                "flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
                state === "done"
                  ? "bg-blue-600 text-white"
                  : state === "current"
                    ? "bg-blue-600/15 text-blue-700 ring-1 ring-blue-500/40 dark:text-sky-300"
                    : "bg-muted text-muted-foreground",
              ].join(" ")}
            >
              {state === "done" ? <RiCheckLine className="size-3" /> : definition.id}
            </span>
            <span
              className={[
                "text-[11px] font-medium",
                state === "current" ? "text-foreground" : "text-muted-foreground",
              ].join(" ")}
            >
              {definition.shortLabel}
            </span>
            {definition.id !== ONBOARDING_TOTAL_STEPS && (
              <span className="h-px w-5 bg-border" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <RiLoader4Line className="size-3.5 animate-spin" aria-hidden="true" />
        Saving progress
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
        <RiCheckLine className="size-3.5" aria-hidden="true" />
        Progress saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[11px] text-destructive">
        <RiErrorWarningLine className="size-3.5" aria-hidden="true" />
        Not saved
      </span>
    );
  }
  return null;
}
