import type { GhJob, GhRun, GhStep, SessionResult } from './github';

/**
 * Pure derivation of the VM state from GitHub data. No network access here,
 * so the logic is unit tested in tests/vm-state.test.ts.
 *
 * The VM status is derived from the workflow *steps*, not from the run status:
 * a run is "in progress" from the moment a runner is allocated until the last
 * layer is uploaded, which covers booting, running, shutting down and saving.
 */

export type Phase = 'off' | 'starting' | 'queued' | 'booting' | 'on' | 'stopping' | 'saving' | 'unknown';
export type Tone = 'off' | 'boot' | 'on' | 'stop' | 'save' | 'unknown';
export type EndpointState = 'none' | 'pending' | 'available' | 'missing' | 'stale' | 'invalid' | 'error' | 'closed';

export type SessionInput = SessionResult | { kind: 'error'; message: string } | null;

export interface Snapshot {
  runs: GhRun[];
  job: GhJob | null;
  session: SessionInput;
  shutdownRequested: boolean;
  cancelRequested: boolean;
  pendingDispatchAt: number | null;
  now: number;
}

export type StageStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface Stage {
  key: string;
  label: string;
  status: StageStatus;
}

export interface VmView {
  phase: Phase;
  tone: Tone;
  label: string;
  detail: string;
  run: GhRun | null;
  lastRun: GhRun | null;
  endpoint: string | null;
  endpointState: EndpointState;
  endpointNote: string;
  stages: Stage[];
  /** The dispatched run is now visible: the dispatch lock can be released. */
  dispatchResolved: boolean;
  /** No run appeared after dispatching: the lock expired. */
  dispatchExpired: boolean;
  /** Further runs waiting behind the active one (workflow concurrency group). */
  queuedBehind: number;
}

export const DISPATCH_WINDOW_MS = 120_000;
/** Tolerance between the browser clock and GitHub's created_at. */
const CLOCK_SKEW_MS = 30_000;

export const STEP = {
  tunnel: 'Start ngrok RDP tunnel',
  wait: 'Wait for shutdown',
  save: 'Save persistent layers',
} as const;

/** Step names from .github/workflows/windows-persistent.yml in the engine. */
const STEP_DETAIL: Record<string, string> = {
  'Set up job': 'Allocating the runner',
  'Run actions/checkout@v5': 'Checking out the workspace',
  Initialize: 'Initializing the workspace',
  'Identify runner': 'Identifying the runner',
  'Install dependencies': 'Installing QEMU and swtpm',
  'Verify virtualization': 'Checking KVM support',
  'Restore Python package cache': 'Restoring Python packages',
  'Prepare Python environment': 'Preparing the Python environment',
  'Initialize persistence': 'Connecting to the Hugging Face dataset',
  'Restore Golden Image cache': 'Restoring the Golden Image cache',
  'Download Golden Image': 'Preparing the Golden Image',
  'Save Golden Image cache': 'Caching the Golden Image',
  'Restore layers': 'Restoring saved layers',
  'Restore ngrok cache': 'Restoring ngrok',
  'Install ngrok': 'Installing ngrok',
  'Boot Windows': 'Starting QEMU',
  'Wait for RDP': 'Waiting for Windows Remote Desktop',
  'Start ngrok RDP tunnel': 'Opening the ngrok tunnel',
};

const STAGES: { key: string; label: string; steps: string[] }[] = [
  {
    key: 'runner',
    label: 'Runner',
    steps: ['Set up job', 'Run actions/checkout@v5', 'Initialize', 'Identify runner', 'Install dependencies', 'Verify virtualization', 'Restore Python package cache', 'Prepare Python environment'],
  },
  { key: 'dataset', label: 'Dataset', steps: ['Initialize persistence'] },
  { key: 'image', label: 'Golden Image', steps: ['Restore Golden Image cache', 'Download Golden Image', 'Save Golden Image cache'] },
  { key: 'layers', label: 'Layers', steps: ['Restore layers'] },
  { key: 'boot', label: 'Boot', steps: ['Restore ngrok cache', 'Install ngrok', 'Boot Windows', 'Wait for RDP'] },
  { key: 'tunnel', label: 'Tunnel', steps: [STEP.tunnel] },
  { key: 'session', label: 'Session', steps: [STEP.wait] },
  { key: 'save', label: 'Save', steps: [STEP.save] },
];

const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export const isActiveRun = (run: GhRun) => ACTIVE_STATUSES.has(run.status);

/** The run the panel controls: the in-progress one, otherwise the oldest waiting one. */
export function selectActiveRun(runs: GhRun[]): { run: GhRun | null; queuedBehind: number } {
  const active = runs.filter(isActiveRun);
  if (!active.length) return { run: null, queuedBehind: 0 };
  const running = active.find((run) => run.status === 'in_progress');
  const run = running ?? [...active].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return { run, queuedBehind: active.length - 1 };
}

const isFailure = (step: GhStep) => step.status === 'completed' && (step.conclusion === 'failure' || step.conclusion === 'cancelled');
const isDone = (step?: GhStep) => step?.status === 'completed';

export function buildStages(steps: GhStep[]): Stage[] {
  const byName = new Map(steps.map((step) => [step.name, step]));
  return STAGES.map(({ key, label, steps: names }) => {
    const found = names.map((name) => byName.get(name)).filter((s): s is GhStep => !!s);
    let status: StageStatus = 'pending';
    if (found.some(isFailure)) status = 'failed';
    else if (found.length && found.every((s) => s.status === 'completed')) {
      status = found.every((s) => s.conclusion === 'skipped') ? 'skipped' : 'done';
    } else if (found.some((s) => s.status === 'in_progress' || s.status === 'completed')) status = 'active';
    return { key, label, status };
  });
}

export function stepDetail(name: string): string {
  return STEP_DETAIL[name] ?? name;
}

function lastRunDetail(run: GhRun | null): string {
  if (!run) return 'No session has been started from this workspace yet.';
  switch (run.conclusion) {
    case 'success':
      return 'The last session completed.';
    case 'cancelled':
      return 'The last session was force stopped. Changes from that session were not saved.';
    case 'failure':
      return 'The last session failed. Open the workflow run for details.';
    case 'timed_out':
      return 'The last session reached the workflow time limit.';
    default:
      return run.conclusion ? `The last session ended: ${run.conclusion}.` : 'The last session ended.';
  }
}

const TONE: Record<Phase, Tone> = {
  off: 'off',
  starting: 'boot',
  queued: 'boot',
  booting: 'boot',
  on: 'on',
  stopping: 'stop',
  saving: 'save',
  unknown: 'unknown',
};

function view(partial: Omit<VmView, 'tone'>): VmView {
  return { ...partial, tone: TONE[partial.phase] };
}

export function deriveVmState(snapshot: Snapshot): VmView {
  const { runs, job, session, now } = snapshot;
  const { run, queuedBehind } = selectActiveRun(runs);
  const lastRun = runs.find((r) => r.status === 'completed') ?? null;

  // Dispatch bookkeeping: GitHub does not return the run ID when dispatching,
  // so a recent dispatch is matched to any run created after it.
  let dispatchResolved = false;
  let dispatchExpired = false;
  const pendingAt = snapshot.pendingDispatchAt;
  if (pendingAt !== null) {
    const appeared = runs.some((r) => Date.parse(r.created_at) >= pendingAt - CLOCK_SKEW_MS);
    if (appeared) dispatchResolved = true;
    else if (now - pendingAt > DISPATCH_WINDOW_MS) dispatchExpired = true;
  }

  const base = {
    run,
    lastRun,
    endpoint: null,
    endpointState: 'none' as EndpointState,
    endpointNote: '',
    stages: buildStages(job?.steps ?? []),
    dispatchResolved,
    dispatchExpired,
    queuedBehind,
  };

  if (!run) {
    if (pendingAt !== null && !dispatchResolved && !dispatchExpired) {
      return view({
        ...base,
        phase: 'starting',
        label: 'Booting...',
        detail: 'Start requested. Waiting for GitHub to create the workflow run.',
        endpointState: 'pending',
        endpointNote: 'The endpoint appears once the ngrok tunnel is open.',
      });
    }
    return view({ ...base, phase: 'off', label: 'OFF', detail: lastRunDetail(lastRun), stages: buildStages([]) });
  }

  if (run.status !== 'in_progress') {
    return view({
      ...base,
      phase: 'queued',
      label: 'Booting...',
      detail: run.status === 'pending' ? 'Queued behind another session of this workspace.' : 'Waiting for a GitHub-hosted runner.',
      endpointState: 'pending',
      endpointNote: 'The endpoint appears once the ngrok tunnel is open.',
    });
  }

  if (snapshot.cancelRequested) {
    return view({
      ...base,
      phase: 'stopping',
      label: 'Stopping...',
      detail: 'Force stop requested. Changes made in this session will not be saved.',
      endpointState: 'closed',
      endpointNote: 'The session is being cancelled.',
    });
  }

  const steps = job?.steps ?? [];
  const byName = new Map(steps.map((s) => [s.name, s]));
  const wait = byName.get(STEP.wait);
  const save = byName.get(STEP.save);
  const tunnel = byName.get(STEP.tunnel);

  // Startup failure before the session step.
  const failed = steps.find((s) => isFailure(s) && s.number < (wait?.number ?? Number.MAX_SAFE_INTEGER));
  if (failed) {
    return view({
      ...base,
      phase: 'stopping',
      label: 'Shutting down...',
      detail: `Startup failed at "${stepDetail(failed.name)}". The workflow is ending.`,
      endpointState: 'closed',
      endpointNote: 'No endpoint was published.',
    });
  }

  // Shutdown and save sequence.
  if (wait && isDone(wait)) {
    if (wait.conclusion !== 'success') {
      return view({
        ...base,
        phase: 'stopping',
        label: 'Shutting down...',
        detail: 'Windows did not shut down cleanly. The engine skips the save to avoid publishing inconsistent disk state.',
        endpointState: 'closed',
        endpointNote: 'The session has ended.',
      });
    }
    if (!save || !isDone(save)) {
      return view({
        ...base,
        phase: 'saving',
        label: 'Saving...',
        detail: save?.status === 'in_progress' ? 'Compressing and uploading the session layer to Hugging Face.' : 'Preparing to save the session layer.',
        endpointState: 'closed',
        endpointNote: 'Windows is off. The session layer is being saved.',
      });
    }
    return view({
      ...base,
      phase: 'stopping',
      label: 'Shutting down...',
      detail: save.conclusion === 'skipped' ? 'Finishing the workflow. Persistence was skipped for this run.' : save.conclusion === 'success' ? 'Layer saved. Finishing the workflow.' : 'Saving failed. Open the workflow run for details.',
      endpointState: 'closed',
      endpointNote: 'The session has ended.',
    });
  }

  const tunnelOpen = wait?.status === 'in_progress' || isDone(tunnel);
  if (tunnelOpen) {
    const endpoint = endpointFromSession(session);
    if (snapshot.shutdownRequested) {
      return view({
        ...base,
        ...endpoint,
        phase: 'stopping',
        label: 'Shutting down...',
        detail: 'Graceful shutdown requested. Windows is powering off, then the session layer is saved.',
      });
    }
    return view({
      ...base,
      ...endpoint,
      phase: 'on',
      label: 'ON',
      detail: 'Windows is running and reachable over Remote Desktop.',
    });
  }

  const current = steps.find((s) => s.status === 'in_progress') ?? steps.find((s) => s.status !== 'completed');
  return view({
    ...base,
    phase: 'booting',
    label: 'Booting...',
    detail: current ? `${stepDetail(current.name)}.` : 'Allocating the runner.',
    endpointState: 'pending',
    endpointNote: 'The endpoint appears once the ngrok tunnel is open.',
  });
}

function endpointFromSession(session: SessionInput): Pick<VmView, 'endpoint' | 'endpointState' | 'endpointNote'> {
  if (!session) return { endpoint: null, endpointState: 'pending', endpointNote: 'Reading session.json.' };
  switch (session.kind) {
    case 'valid':
      return { endpoint: session.endpoint, endpointState: 'available', endpointNote: '' };
    case 'missing':
      return { endpoint: null, endpointState: 'missing', endpointNote: 'The golden-control branch has no session.json yet.' };
    case 'stale':
      return {
        endpoint: null,
        endpointState: 'stale',
        endpointNote: `session.json belongs to run ${session.runId}, not the current run. It is ignored until the engine publishes the new endpoint.`,
      };
    case 'invalid':
      return { endpoint: null, endpointState: 'invalid', endpointNote: `${session.reason}. The endpoint is not displayed.` };
    case 'error':
      return { endpoint: null, endpointState: 'error', endpointNote: `session.json could not be read: ${session.message}` };
  }
}

/** Polling interval for a phase, in milliseconds. null stops polling. */
export function pollInterval(phase: Phase): number | null {
  switch (phase) {
    case 'starting':
    case 'queued':
      return 5_000;
    case 'booting':
    case 'stopping':
    case 'saving':
      return 6_000;
    case 'on':
      return 15_000;
    case 'unknown':
      return 20_000;
    case 'off':
      return null;
  }
}

/** Whether session.json should be fetched for this job. */
export function needsSession(job: GhJob | null): boolean {
  const steps = job?.steps ?? [];
  const tunnel = steps.find((s) => s.name === STEP.tunnel);
  const wait = steps.find((s) => s.name === STEP.wait);
  return (isDone(tunnel) && !isDone(wait)) || wait?.status === 'in_progress';
}
