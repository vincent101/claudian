import { performance } from 'perf_hooks';

import { HISTORY_RESOURCE_POLICY } from '@/features/chat/history/HistoryResourcePolicy';
import { planHistoryWindow } from '@/providers/claude/history/HistoryWindowPlanner';

function percentile(samples: number[], value: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * value) - 1] ?? 0;
}

describe('first-screen planner microbenchmark scaffold', () => {
  // This measures only pure planner overhead. It does not cover index scan,
  // materialization, render, or the §3.2 device p95 acceptance gate.
  it('measures 30 copied and reused descriptor-array planner runs', () => {
    const fixture = Array.from({ length: 200 }, () => 32 * 1024);
    const cold: number[] = [];
    const cached: number[] = [];
    let latest = { start: 0, end: 0 };

    for (let run = 0; run < 30; run += 1) {
      const coldStart = performance.now();
      latest = planHistoryWindow([...fixture], {
        anchorTurn: fixture.length,
        direction: 'older',
        budget: HISTORY_RESOURCE_POLICY.firstScreen,
      });
      cold.push(performance.now() - coldStart);
      expect(latest).toMatchObject({ start: 0, end: fixture.length });

      const cachedStart = performance.now();
      latest = planHistoryWindow(fixture, {
        anchorTurn: fixture.length,
        direction: 'older',
        budget: HISTORY_RESOURCE_POLICY.firstScreen,
      });
      cached.push(performance.now() - cachedStart);
    }

    expect(latest).toMatchObject({ start: 0, end: fixture.length });
    expect(cold).toHaveLength(30);
    expect(cached).toHaveLength(30);
    expect(percentile(cold, 0.95)).toBeGreaterThanOrEqual(0);
    expect(percentile(cached, 0.95)).toBeGreaterThanOrEqual(0);
  });
});
