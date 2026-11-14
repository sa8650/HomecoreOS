/**
 * Smart Home Planner — (5) availability evaluation.
 *
 * Keeps three ideas apart that customers easily confuse:
 *   - catalog availability: the board is listed in the Board Library,
 *   - physical stock: somebody actually has one to sell,
 *   - price.
 *
 * HomecoreOS records only the first. Stock is therefore reported as "unknown"
 * and a cost estimate is produced only from prices that really exist.
 */
import type {
  PlannerAccountContext,
  PlannerAccountLimitCheck,
  PlannerAvailability,
  PlannerBoardRecord,
  PlannerBoardStatus,
  PlannerControllerPlan,
  PlannerCostEstimate,
  PlannerStockStatus,
} from "./types";

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function evaluatePlannerStock(board: PlannerBoardRecord): PlannerStockStatus {
  if (board.stock?.status === "in_stock") {
    return {
      status: "in_stock",
      label: "In stock",
      detail:
        typeof board.stock.quantity === "number"
          ? `${board.stock.quantity} recorded in stock.`
          : "Recorded as in stock.",
    };
  }
  if (board.stock?.status === "out_of_stock") {
    return {
      status: "out_of_stock",
      label: "Out of stock",
      detail: "Recorded as out of stock.",
    };
  }
  return {
    status: "unknown",
    label: "Stock unknown",
    detail:
      "HomecoreOS does not track physical inventory. Being listed in the catalog does not mean a board is in stock, so confirm availability with your supplier.",
  };
}

/** A cost estimate exists only when the board record carries a real price. */
export function estimatePlannerCost(
  board: PlannerBoardRecord,
  controllerCount: number
): PlannerCostEstimate {
  if (controllerCount <= 0) {
    return { available: false, reason: "This plan contains no controllers to price." };
  }
  const price = board.unit_price;
  if (
    !price ||
    typeof price.amount !== "number" ||
    !Number.isFinite(price.amount) ||
    price.amount < 0 ||
    typeof price.currency !== "string" ||
    !price.currency.trim()
  ) {
    return {
      available: false,
      reason:
        "The Board Library has no price recorded for this board, so no cost estimate is shown.",
    };
  }
  const subtotal = roundMoney(price.amount * controllerCount);
  return {
    available: true,
    currency: price.currency.trim().toUpperCase(),
    total: subtotal,
    lines: [
      {
        label: `${board.manufacturer} ${board.model}`.trim(),
        quantity: controllerCount,
        unitAmount: roundMoney(price.amount),
        subtotal,
      },
    ],
    excludes: [
      "Relay modules, sensors and wiring",
      "Power supplies and enclosures",
      "Installation labour",
    ],
  };
}

/** HomecoreOS "device" entities the plan would create (switches and sensors are counted separately by the platform). */
export function countPlannedHomecoreDevices(controllers: PlannerControllerPlan[]): number {
  let count = 0;
  for (const controller of controllers) {
    for (const assignment of controller.assignments) {
      if (assignment.homecore.entity === "device") count += 1;
    }
  }
  return count;
}

export function evaluatePlannerAccountLimits(
  account: PlannerAccountContext | null,
  planned: { controllers: number; devices: number }
): PlannerAccountLimitCheck[] {
  if (!account) return [];
  const checks: PlannerAccountLimitCheck[] = [];
  if (typeof account.maxControllers === "number") {
    checks.push({
      kind: "controllers",
      limit: account.maxControllers,
      existing: account.existingControllers,
      planned: planned.controllers,
      exceeded: account.existingControllers + planned.controllers > account.maxControllers,
    });
  }
  if (typeof account.maxDevices === "number") {
    checks.push({
      kind: "devices",
      limit: account.maxDevices,
      existing: account.existingDevices,
      planned: planned.devices,
      exceeded: account.existingDevices + planned.devices > account.maxDevices,
    });
  }
  return checks;
}

export function evaluatePlannerAvailability(params: {
  board: PlannerBoardRecord;
  boardStatus: PlannerBoardStatus;
  controllers: PlannerControllerPlan[];
  account: PlannerAccountContext | null;
}): PlannerAvailability {
  const controllerCount = params.controllers.length;
  return {
    catalog: {
      status: params.boardStatus.code,
      label: params.boardStatus.label,
      detail: params.boardStatus.detail,
    },
    stock: evaluatePlannerStock(params.board),
    cost: estimatePlannerCost(params.board, controllerCount),
    accountLimits: evaluatePlannerAccountLimits(params.account, {
      controllers: controllerCount,
      devices: countPlannedHomecoreDevices(params.controllers),
    }),
  };
}
