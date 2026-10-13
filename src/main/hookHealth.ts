/**
 * Detect an engine whose terminal is working but whose lifecycle bridge has
 * stopped reporting. Pure state machine; the caller owns notifications.
 *
 * We start the initial grace after the first observed terminal output, not on
 * spawn. Slow launches and silent terminals must not be labelled unsafe.
 */
export const FIRST_HOOK_GRACE_MS = 60_000;
export const SILENT_HOOK_GRACE_MS = 3 * 60_000;

export interface HookHealthAgent {
  id: string;
  ptyId: string;
  /** Native Claude hooks, or a configured hooks/proxy bridge. */
  expectsHooks: boolean;
  lastOutputAt: number;
}

export interface HookHealthChange {
  agentId: string;
  state: 'missing' | 'recovered';
}

interface Watch {
  ptyId: string;
  firstOutputSeenAt: number | null;
  lastHookAt: number | null;
  lost: boolean;
}

export class HookHealthWatchdog {
  private watches = new Map<string, Watch>();
  private earlyHooks = new Map<string, number>();

  /** The hook server calls this for every validated event. */
  noteHook(agentId: string | undefined, at = Date.now()): HookHealthChange | null {
    if (!agentId) return null;
    const watch = this.watches.get(agentId);
    if (!watch) {
      // The server can deliver SessionStart before the first fleet census.
      this.earlyHooks.set(agentId, at);
      return null;
    }
    const recovered = watch.lost;
    watch.lastHookAt = at;
    watch.lost = false;
    return recovered ? { agentId, state: 'recovered' } : null;
  }

  /**
   * Run on the fleet beat with live terminal snapshots. A missing terminal,
   * archived member, or hookless custom command is removed from the watch.
   */
  inspect(agents: readonly HookHealthAgent[], at = Date.now()): HookHealthChange[] {
    const live = new Set<string>();
    const changed: HookHealthChange[] = [];
    for (const agent of agents) {
      if (!agent.expectsHooks || !agent.ptyId) continue;
      live.add(agent.id);
      let watch = this.watches.get(agent.id);
      if (!watch || watch.ptyId !== agent.ptyId) {
        watch = { ptyId: agent.ptyId, firstOutputSeenAt: null, lastHookAt: this.earlyHooks.get(agent.id) ?? null, lost: false };
        this.earlyHooks.delete(agent.id);
        this.watches.set(agent.id, watch);
      }
      if (!Number.isFinite(agent.lastOutputAt) || agent.lastOutputAt <= 0) continue;
      if (watch.firstOutputSeenAt === null) watch.firstOutputSeenAt = at;

      const first = watch.firstOutputSeenAt;
      const lastHook = watch.lastHookAt;
      // A prior hook counts as a successful initial check-in. Later inactivity
      // is suspicious only if the terminal produced output after that hook.
      const missing = lastHook === null
        ? at - first >= FIRST_HOOK_GRACE_MS
        : agent.lastOutputAt > lastHook
          && at - lastHook >= SILENT_HOOK_GRACE_MS
          && at - agent.lastOutputAt < SILENT_HOOK_GRACE_MS;
      if (missing && !watch.lost) {
        watch.lost = true;
        changed.push({ agentId: agent.id, state: 'missing' });
      }
    }
    for (const id of this.watches.keys()) {
      if (!live.has(id)) this.watches.delete(id);
    }
    return changed;
  }

  /** Used by routing consumers once they are wired up. */
  isOutOfSight(agentId: string): boolean {
    return this.watches.get(agentId)?.lost ?? false;
  }
}
