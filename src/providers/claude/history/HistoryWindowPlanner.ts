import type { HistoryLoadBudget, HistoryWindowDirection } from '../../../core/providers/types';

export interface HistoryWindowPlan {
  start: number;
  end: number;
  /**
   * The anchor-adjacent turn alone exceeds the byte budget and is included as
   * an oversized summary turn; an over-budget turn is never an empty page.
   */
  oversizedAnchor: boolean;
  plannedSourceBytes: number;
}

export interface HistoryWindowPlanRequest {
  anchorTurn: number;
  direction: HistoryWindowDirection;
  budget: HistoryLoadBudget;
  /** Inclusive floor for 'older' planning: turns below are already loaded. */
  minTurn?: number;
  /** Exclusive ceiling for 'newer' planning. */
  maxTurn?: number;
}

/**
 * Pure metadata-only window planning: picks the largest contiguous turn window
 * that satisfies the turn and source-byte budgets without reading content.
 * Projected-char enforcement happens during materialization where actual
 * projections are measurable.
 */
export function planHistoryWindow(
  turnSourceBytes: ReadonlyArray<number | undefined>,
  request: HistoryWindowPlanRequest,
): HistoryWindowPlan {
  const total = turnSourceBytes.length;
  const { budget } = request;
  const bytesOf = (index: number): number => turnSourceBytes[index] ?? 0;

  if (total === 0) {
    return { start: 0, end: 0, oversizedAnchor: false, plannedSourceBytes: 0 };
  }

  if (budget.maxTurns < 1) {
    const emptyStart = request.direction === 'newer'
      ? Math.max(0, Math.min(request.anchorTurn, total))
      : request.direction === 'around'
        ? Math.max(0, Math.min(request.anchorTurn, total - 1))
        : Math.max(0, Math.min(request.anchorTurn, total));
    return { start: emptyStart, end: emptyStart, oversizedAnchor: false, plannedSourceBytes: 0 };
  }

  if (request.direction === 'newer') {
    const start = Math.max(0, Math.min(request.anchorTurn, total));
    const ceiling = Math.max(start, Math.min(request.maxTurn ?? total, total));
    let end = start;
    let count = 0;
    let sum = 0;
    let oversizedAnchor = false;
    for (let index = start; index < ceiling; index += 1) {
      const turnBytes = bytesOf(index);
      if (count === 0) {
        end = index + 1;
        count = 1;
        sum = turnBytes;
        oversizedAnchor = turnBytes > budget.maxSourceBytes;
        if (oversizedAnchor) break;
        continue;
      }
      if (count + 1 > budget.maxTurns || sum + turnBytes > budget.maxSourceBytes) break;
      end = index + 1;
      count += 1;
      sum += turnBytes;
    }
    return { start, end, oversizedAnchor, plannedSourceBytes: sum };
  }

  if (request.direction === 'around') {
    const center = Math.max(0, Math.min(request.anchorTurn, total - 1));
    const centerBytes = bytesOf(center);
    let start = center;
    let end = center + 1;
    let count = 1;
    let sum = centerBytes;
    const oversizedAnchor = centerBytes > budget.maxSourceBytes;
    if (!oversizedAnchor) {
      // Alternate sides so the anchor stays centered instead of greedily
      // filling one direction first.
      let olderIndex = center - 1;
      let newerIndex = center + 1;
      let preferOlder = true;
      while (count < budget.maxTurns) {
        const olderFits = olderIndex >= 0 && sum + bytesOf(olderIndex) <= budget.maxSourceBytes;
        const newerFits = newerIndex < total && sum + bytesOf(newerIndex) <= budget.maxSourceBytes;
        const takeOlder = preferOlder ? olderFits : !newerFits && olderFits;
        if (takeOlder) {
          start = olderIndex;
          sum += bytesOf(olderIndex);
          olderIndex -= 1;
          count += 1;
          preferOlder = false;
          continue;
        }
        if (newerFits) {
          end = newerIndex + 1;
          sum += bytesOf(newerIndex);
          newerIndex += 1;
          count += 1;
          preferOlder = true;
          continue;
        }
        break;
      }
    }
    return { start, end, oversizedAnchor, plannedSourceBytes: sum };
  }

  const end = Math.max(0, Math.min(request.anchorTurn, total));
  const floor = Math.max(0, Math.min(request.minTurn ?? 0, end));
  let start = end;
  let count = 0;
  let sum = 0;
  let oversizedAnchor = false;
  for (let index = end - 1; index >= floor; index -= 1) {
    const turnBytes = bytesOf(index);
    if (count === 0) {
      start = index;
      count = 1;
      sum = turnBytes;
      oversizedAnchor = turnBytes > budget.maxSourceBytes;
      if (oversizedAnchor) break;
      continue;
    }
    if (count + 1 > budget.maxTurns || sum + turnBytes > budget.maxSourceBytes) break;
    start = index;
    count += 1;
    sum += turnBytes;
  }
  return { start, end, oversizedAnchor, plannedSourceBytes: sum };
}
