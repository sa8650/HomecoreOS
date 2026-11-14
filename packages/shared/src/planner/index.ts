/**
 * Smart Home Planner — deterministic recommendation engine.
 *
 * One module per concern:
 *   1. requirements.ts       requirement normalization
 *   2. board-capability.ts   board capability evaluation
 *   3. allocation.ts         GPIO and device allocation
 *   4. firmware.ts           firmware compatibility evaluation
 *   5. availability.ts       availability evaluation
 *   6. ranking.ts            recommendation ranking
 *   7. warnings.ts           warning generation
 *
 * engine.ts runs them as a pipeline; catalog-revision.ts fingerprints the
 * board and firmware records so cached recommendations can be invalidated.
 */
export * from "./types";
export * from "./requirements";
export * from "./board-capability";
export * from "./allocation";
export * from "./firmware";
export * from "./availability";
export * from "./ranking";
export * from "./warnings";
export * from "./external-hardware";
export * from "./catalog-revision";
export * from "./engine";
