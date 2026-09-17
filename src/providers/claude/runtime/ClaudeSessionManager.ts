import type { ClaudeModel } from '../types/models';
import type { HistoryRecoveryState, SessionState } from './types';

const MAX_RECOVERY_ATTEMPTS = 2;

export class SessionManager {
  private state: SessionState = this.initialState();
  private recoveryListener: ((state: HistoryRecoveryState) => void) | null = null;

  private initialState(): SessionState {
    return {
      sessionId: null,
      sessionModel: null,
      pendingSessionModel: null,
      wasInterrupted: false,
      historyRecovery: { status: 'idle', generation: 0 },
      sessionInvalidated: false,
    };
  }

  getSessionId(): string | null { return this.state.sessionId; }
  getHistoryRecoveryState(): HistoryRecoveryState { return { ...this.state.historyRecovery }; }

  onHistoryRecoveryStateChange(listener: ((state: HistoryRecoveryState) => void) | null): void {
    this.recoveryListener = listener;
    if (listener) listener(this.getHistoryRecoveryState());
  }

  private setRecovery(state: HistoryRecoveryState): void {
    this.state.historyRecovery = state;
    this.recoveryListener?.({ ...state });
  }

  private nextGeneration(): number { return this.state.historyRecovery.generation + 1; }

  setSessionId(id: string | null, defaultModel?: ClaudeModel): void {
    this.state.sessionId = id;
    this.state.sessionModel = id ? (defaultModel ?? null) : null;
    this.setRecovery({ status: 'idle', generation: this.nextGeneration() });
    this.state.sessionInvalidated = false;
  }

  wasInterrupted(): boolean { return this.state.wasInterrupted; }
  markInterrupted(): void { this.state.wasInterrupted = true; }
  clearInterrupted(): void { this.state.wasInterrupted = false; }
  setPendingModel(model: ClaudeModel): void { this.state.pendingSessionModel = model; }
  clearPendingModel(): void { this.state.pendingSessionModel = null; }

  captureSession(sessionId: string, isFork = false): void {
    const previous = this.state.sessionId;
    if (previous && previous !== sessionId) {
      if (isFork) {
        this.setRecovery({ status: 'idle', generation: this.nextGeneration() });
      } else if (this.state.historyRecovery.status !== 'tripped') {
        this.setRecovery({
          status: 'pending', generation: this.nextGeneration(), lostSessionId: previous, attempts: 0,
        });
      }
    }
    this.state.sessionId = sessionId;
    this.state.sessionModel = this.state.pendingSessionModel;
    this.state.pendingSessionModel = null;
    this.state.sessionInvalidated = false;
  }

  needsHistoryRebuild(): boolean { return this.state.historyRecovery.status === 'pending'; }

  markRecoveryDispatched(): number | null {
    const recovery = this.state.historyRecovery;
    const dispatchSessionId = this.state.sessionId;
    if (recovery.status !== 'pending' || !dispatchSessionId) return null;
    const attempts = recovery.attempts + 1;
    this.setRecovery({
      status: 'awaiting_result', generation: recovery.generation, dispatchSessionId,
      sessionSnapshot: dispatchSessionId, attempts,
    });
    return recovery.generation;
  }

  confirmRecovery(generation: number, resultSessionId: string | null, success: boolean): boolean {
    const recovery = this.state.historyRecovery;
    if (recovery.status !== 'awaiting_result' || recovery.generation !== generation) return false;
    const unchanged = this.state.sessionId === recovery.sessionSnapshot;
    if (success && unchanged && resultSessionId === recovery.dispatchSessionId) {
      this.setRecovery({ status: 'idle', generation });
      return true;
    }
    if (recovery.attempts >= MAX_RECOVERY_ATTEMPTS) {
      this.setRecovery({ status: 'tripped', generation, reason: 'recovery_attempts_exhausted' });
    } else {
      this.setRecovery({
        status: 'pending', generation, lostSessionId: recovery.dispatchSessionId, attempts: recovery.attempts,
      });
    }
    return false;
  }

  failRecoveryDispatch(generation: number): void {
    this.confirmRecovery(generation, null, false);
  }

  retryHistoryRecovery(generation: number): boolean {
    const recovery = this.state.historyRecovery;
    if (recovery.status !== 'tripped' || recovery.generation !== generation) return false;
    this.setRecovery({
      status: 'pending', generation: generation + 1,
      lostSessionId: this.state.sessionId ?? '', attempts: 0,
    });
    return true;
  }

  clearHistoryRebuild(): void {
    this.setRecovery({ status: 'idle', generation: this.state.historyRecovery.generation });
  }

  invalidateSession(): void {
    this.state.sessionId = null;
    this.state.sessionModel = null;
    this.state.sessionInvalidated = true;
  }

  consumeInvalidation(): boolean {
    const value = this.state.sessionInvalidated;
    this.state.sessionInvalidated = false;
    return value;
  }

  reset(): void {
    const generation = this.nextGeneration();
    this.state = this.initialState();
    this.state.historyRecovery.generation = generation;
    this.recoveryListener?.(this.getHistoryRecoveryState());
  }
}
