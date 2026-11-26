import type { GhJob, GhRun, GitHubClient } from './github';
import { ApiError, describe } from './errors';
import { SHUTDOWN_TITLE_RE, shutdownIssueTitle } from './config';
import { Poller } from './poller';
import { cancelRequests, dispatchLock } from './storage';
import {
  deriveVmState,
  isActiveRun,
  needsSession,
  pollInterval,
  selectActiveRun,
  type SessionInput,
  type VmView,
} from './vm-state';

export interface VmSnapshotState {
  view: VmView | null;
  runs: GhRun[];
  job: GhJob | null;
  error: string | null;
  errorKind: ApiError['kind'] | null;
  updatedAt: number | null;
  loading: boolean;
  /** An action (start, shutdown, force stop) is in flight. */
  busy: 'start' | 'shutdown' | 'force' | null;
  nextPollAt: number | null;
}

type Listener = (state: VmSnapshotState) => void;
type ActivityLogger = (level: 'info' | 'success' | 'warning' | 'error', message: string) => void;

/**
 * Owns the VM state for one workspace: fetching, derivation, polling and the
 * three lifecycle actions. The UI only subscribes and calls actions.
 */
export class VmController {
  private state: VmSnapshotState = {
    view: null,
    runs: [],
    job: null,
    error: null,
    errorKind: null,
    updatedAt: null,
    loading: true,
    busy: null,
    nextPollAt: null,
  };
  private listeners = new Set<Listener>();
  private poller: Poller;
  private lastPhase: VmView['phase'] | null = null;
  private readonly repoKey: string;

  constructor(
    private readonly gh: GitHubClient,
    readonly owner: string,
    readonly repo: string,
    private readonly log: ActivityLogger,
  ) {
    this.repoKey = `${owner}/${repo}`;
    this.poller = new Poller(() => this.tick(), {
      fatal: (error) => error instanceof ApiError && (error.kind === 'auth' || error.kind === 'not_found'),
      onError: (error) => this.fail(error),
    });
    // Another tab dispatching the workflow refreshes this one.
    window.addEventListener('storage', (event) => {
      if (event.key === dispatchLock.storageKey(this.repoKey)) void this.refresh();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<VmSnapshotState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private fail(error: unknown) {
    this.set({
      error: describe(error),
      errorKind: error instanceof ApiError ? error.kind : null,
      loading: false,
      nextPollAt: null,
    });
  }

  start(): Promise<void> {
    return this.poller.now();
  }

  refresh(): Promise<void> {
    return this.poller.now();
  }

  stop(): void {
    this.poller.destroy();
  }

  /** One polling cycle. Returns the delay before the next one. */
  private async tick(): Promise<number | null> {
    this.set({ loading: true });
    const { owner, repo, gh } = this;
    const runs = await gh.runs(owner, repo, 10);
    const { run } = selectActiveRun(runs);

    let job: GhJob | null = null;
    let session: SessionInput = null;
    let shutdownRequested = false;

    if (run?.status === 'in_progress') {
      const jobs = await gh.jobs(owner, repo, run.id);
      job = jobs[0] ?? null;
      if (needsSession(job)) {
        try {
          session = await gh.session(owner, repo, run.id);
        } catch (error) {
          if (error instanceof ApiError && error.kind === 'auth') throw error;
          session = { kind: 'error', message: describe(error) };
        }
        const issues = await gh.openShutdownIssues(owner, repo);
        shutdownRequested = issues.some((issue) => issue.title === shutdownIssueTitle(run.id));
      }
    }

    const view = deriveVmState({
      runs,
      job,
      session,
      shutdownRequested,
      cancelRequested: run ? cancelRequests.has(run.id) : false,
      pendingDispatchAt: dispatchLock.get(this.repoKey),
      now: Date.now(),
    });

    if (view.dispatchResolved) dispatchLock.clear(this.repoKey);
    if (view.dispatchExpired) {
      dispatchLock.clear(this.repoKey);
      this.log('warning', 'No workflow run appeared within two minutes of the start request. Check the Actions tab of the workspace.');
    }

    const enteredOff = view.phase === 'off' && this.lastPhase !== 'off';
    this.trackTransitions(view);

    // On load and whenever a session ends, close shutdown issues of finished runs.
    if (enteredOff) void this.closeStaleShutdownIssues(runs);

    const interval = pollInterval(view.phase);
    this.set({
      view,
      runs,
      job,
      error: null,
      errorKind: null,
      loading: false,
      updatedAt: Date.now(),
      nextPollAt: interval === null ? null : Date.now() + interval,
    });
    return interval;
  }

  private trackTransitions(view: VmView) {
    const previous = this.lastPhase;
    this.lastPhase = view.phase;
    if (previous === null || previous === view.phase) return;
    const messages: Partial<Record<VmView['phase'], [Parameters<ActivityLogger>[0], string]>> = {
      booting: ['info', `Run #${view.run?.run_number ?? ''} is booting.`],
      on: ['success', 'Windows is running. The RDP endpoint is available.'],
      saving: ['info', 'Windows powered off. Saving the session layer.'],
      off: ['info', view.lastRun ? `Session ended (${view.lastRun.conclusion ?? 'completed'}).` : 'Instance is off.'],
    };
    const entry = messages[view.phase];
    if (entry) this.log(entry[0], entry[1]);
  }

  /**
   * The engine never closes shutdown issues. Once no run is active, close the
   * panel's issues for finished runs so the list stays clean. Best effort.
   */
  private async closeStaleShutdownIssues(runs: GhRun[]) {
    try {
      const activeIds = new Set(runs.filter(isActiveRun).map((r) => String(r.id)));
      const issues = await this.gh.openShutdownIssues(this.owner, this.repo);
      for (const issue of issues) {
        const runId = SHUTDOWN_TITLE_RE.exec(issue.title)?.[1];
        if (runId && !activeIds.has(runId)) await this.gh.closeIssue(this.owner, this.repo, issue.number);
      }
    } catch {
      /* Cleanup is optional; failures are not surfaced. */
    }
  }

  private async guard(kind: VmSnapshotState['busy'], action: () => Promise<void>) {
    if (this.state.busy) return;
    this.set({ busy: kind });
    try {
      await action();
    } catch (error) {
      this.log('error', describe(error));
      throw error;
    } finally {
      this.set({ busy: null });
    }
  }

  /** Dispatch the workflow, refusing if any run is active or a dispatch is pending. */
  startInstance(): Promise<void> {
    return this.guard('start', async () => {
      const lock = dispatchLock.get(this.repoKey);
      if (lock !== null && Date.now() - lock < 120_000) {
        throw new ApiError('Panel', 'conflict', 'A start request is already pending for this workspace.');
      }
      const runs = await this.gh.runs(this.owner, this.repo, 10);
      if (runs.some(isActiveRun)) {
        await this.refresh();
        throw new ApiError('Panel', 'conflict', 'A session is already running or queued for this workspace.');
      }
      dispatchLock.set(this.repoKey, Date.now());
      try {
        await this.gh.dispatch(this.owner, this.repo);
      } catch (error) {
        dispatchLock.clear(this.repoKey);
        throw error;
      }
      this.log('info', 'Start requested. GitHub is queuing the workflow run.');
      await this.refresh();
    });
  }

  /** Graceful shutdown through the issue protocol. Idempotent per run. */
  requestShutdown(): Promise<void> {
    return this.guard('shutdown', async () => {
      const run = this.state.view?.run;
      if (!run || this.state.view?.phase !== 'on') {
        throw new ApiError('Panel', 'conflict', 'Graceful shutdown is available once the instance is on.');
      }
      const issues = await this.gh.openShutdownIssues(this.owner, this.repo);
      if (!issues.some((issue) => issue.title === shutdownIssueTitle(run.id))) {
        await this.gh.createShutdownIssue(this.owner, this.repo, run.id);
      }
      this.log('info', 'Graceful shutdown requested. The engine checks for requests every 15 seconds.');
      await this.refresh();
    });
  }

  /** Cancel the workflow run. Unsaved changes are lost. */
  forceStop(): Promise<void> {
    return this.guard('force', async () => {
      const run = this.state.view?.run;
      if (!run) throw new ApiError('Panel', 'conflict', 'No active run to stop.');
      await this.gh.cancel(this.owner, this.repo, run.id);
      cancelRequests.add(run.id);
      this.log('warning', `Force stop requested for run #${run.run_number}.`);
      await this.refresh();
    });
  }
}
