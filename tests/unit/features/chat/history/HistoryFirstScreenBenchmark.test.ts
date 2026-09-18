import { performance } from 'perf_hooks';

import { HISTORY_RESOURCE_POLICY } from '@/features/chat/history/HistoryResourcePolicy';
import { planHistoryWindow } from '@/providers/claude/history/HistoryWindowPlanner';

function percentile(samples: number[], value: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * value) - 1] ?? 0;
}

describe('indexed first-screen benchmark harness', () => {
  it('measures 30 cold and cached planner runs and covers a budget-fitting fixture', () => {
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
