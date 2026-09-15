import type { HistoryLoadBudget } from '@/core/providers/types';
import { planHistoryWindow } from '@/providers/claude/history/HistoryWindowPlanner';

const MiB = 1024 * 1024;

function budget(overrides: Partial<HistoryLoadBudget> = {}): HistoryLoadBudget {
  return {
    maxTurns: 25,
    maxSourceBytes: 8 * MiB,
    maxProjectedChars: 2_000_000,
    timeSliceMs: 8,
    ...overrides,
  };
}

function bytes(sizes: number[]): Array<number | undefined> {
  return sizes;
}

describe('planHistoryWindow', () => {
  it('caps the window at maxTurns when every turn is small', () => {
    const sizes = Array.from({ length: 50 }, () => 1024);
    const plan = planHistoryWindow(sizes, { anchorTurn: 50, direction: 'older', budget: budget() });
    expect(plan).toMatchObject({ start: 25, end: 50, oversizedAnchor: false });
    expect(plan.plannedSourceBytes).toBe(25 * 1024);
  });

  it('returns the newest turn alone as an oversized anchor when it exceeds the byte budget', () => {
    const sizes = [1024, 1024, 12 * MiB];
    const plan = planHistoryWindow(sizes, { anchorTurn: 3, direction: 'older', budget: budget() });
    expect(plan).toMatchObject({ start: 2, end: 3, oversizedAnchor: true });
    expect(plan.plannedSourceBytes).toBe(12 * MiB);
  });

  it('stops before tail turns whose sum would exceed the byte budget', () => {
    // Tail of three ~7 MiB turns: only the newest fits the 8 MiB budget.
    const sizes = [1024, 7 * MiB, 7 * MiB, 7 * MiB];
    const plan = planHistoryWindow(sizes, { anchorTurn: 4, direction: 'older', budget: budget() });
    expect(plan).toMatchObject({ start: 3, end: 4, oversizedAnchor: false });
  });

  it('packs as many turns as the byte budget allows', () => {
    const sizes = [1024, 2 * MiB, 2 * MiB, 2 * MiB, 2 * MiB, 2 * MiB];
    const plan = planHistoryWindow(sizes, { anchorTurn: 6, direction: 'older', budget: budget() });
    // 4 x 2 MiB = 8 MiB fits; the 5th would exceed.
    expect(plan).toMatchObject({ start: 2, end: 6, oversizedAnchor: false });
    expect(plan.plannedSourceBytes).toBe(8 * MiB);
  });

  it('respects the minTurn floor for already-loaded ranges', () => {
    const sizes = Array.from({ length: 50 }, () => 1024);
    const plan = planHistoryWindow(sizes, { anchorTurn: 30, direction: 'older', budget: budget(), minTurn: 20 });
    expect(plan).toMatchObject({ start: 20, end: 30 });
  });

  it('returns an empty window for a zero anchor', () => {
    const plan = planHistoryWindow(bytes([1024]), { anchorTurn: 0, direction: 'older', budget: budget() });
    expect(plan).toMatchObject({ start: 0, end: 0, oversizedAnchor: false });
  });

  it('treats missing byte metadata as zero without unbounding the turn cap', () => {
    const sizes: Array<number | undefined> = Array.from({ length: 40 }, () => undefined);
    const plan = planHistoryWindow(sizes, { anchorTurn: 40, direction: 'older', budget: budget() });
    expect(plan).toMatchObject({ start: 15, end: 40 });
  });

  it('clamps the anchor to the available turn count', () => {
    const plan = planHistoryWindow(bytes([1024, 1024]), { anchorTurn: 99, direction: 'older', budget: budget() });
    expect(plan).toMatchObject({ start: 0, end: 2 });
  });

  it('plans a newer-direction window bounded by maxTurn', () => {
    const sizes = Array.from({ length: 50 }, () => 1024);
    const plan = planHistoryWindow(sizes, { anchorTurn: 5, direction: 'newer', budget: budget(), maxTurn: 30 });
    expect(plan).toMatchObject({ start: 5, end: 30, oversizedAnchor: false });
  });

  it('centers an around-direction window on the anchor turn', () => {
    const sizes = Array.from({ length: 20 }, () => 1024);
    const plan = planHistoryWindow(sizes, { anchorTurn: 10, direction: 'around', budget: budget({ maxTurns: 5 }) });
    expect(plan).toMatchObject({ start: 8, end: 13, oversizedAnchor: false });
  });

  it('keeps a single oversized anchor turn for around-direction requests', () => {
    const sizes = Array.from({ length: 10 }, () => 1024);
    sizes[5] = 20 * MiB;
    const plan = planHistoryWindow(sizes, { anchorTurn: 5, direction: 'around', budget: budget() });
    expect(plan).toMatchObject({ start: 5, end: 6, oversizedAnchor: true });
  });

  it('returns an empty window when the turn budget is non-positive', () => {
    const plan = planHistoryWindow(bytes([1024, 1024]), { anchorTurn: 2, direction: 'older', budget: budget({ maxTurns: 0 }) });
    expect(plan).toMatchObject({ start: 2, end: 2 });
  });
});
