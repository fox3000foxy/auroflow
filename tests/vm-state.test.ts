import { describe, expect, it } from 'vitest';
import { deriveVmState, needsSession, pollInterval, selectActiveRun, type Snapshot } from '../src/lib/vm-state';
import { parseSession, type GhJob, type GhRun, type GhStep } from '../src/lib/github';

const NOW = Date.parse('2026-11-26T12:00:00Z');

function run(id: number, status: GhRun['status'], conclusion: string | null = null, created = '2026-11-26T11:00:00Z'): GhRun {
  return {
    id,
    run_number: id,
    status,
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    created_at: created,
    updated_at: created,
    event: 'workflow_dispatch',
  };
}

const ORDER = [
  'Set up job',
  'Run actions/checkout@v5',
  'Initialize',
  'Identify runner',
  'Install dependencies',
  'Verify virtualization',
  'Restore Python package cache',
  'Prepare Python environment',
  'Initialize persistence',
  'Restore Golden Image cache',
  'Download Golden Image',
  'Save Golden Image cache',
  'Restore layers',
  'Restore ngrok cache',
  'Install ngrok',
  'Boot Windows',
  'Wait for RDP',
  'Start ngrok RDP tunnel',
  'Wait for shutdown',
  'Save persistent layers',
  'Diagnostics',
  'Complete job',
];

/** Job whose step `current` is in progress; earlier steps completed with `conclusions` overrides. */
function job(current: string | null, conclusions: Record<string, string> = {}): GhJob {
  const index = current ? ORDER.indexOf(current) : ORDER.length;
  const steps: GhStep[] = ORDER.map((name, i) => ({
    name,
    number: i + 1,
    status: i < index ? 'completed' : i === index ? 'in_progress' : 'queued',
    conclusion: i < index ? conclusions[name] ?? 'success' : null,
  }));
  return { id: 1, status: 'in_progress', conclusion: null, started_at: '2026-11-26T11:01:00Z', completed_at: null, runner_name: 'GitHub Actions 7', labels: ['ubuntu-latest'], html_url: '', steps };
}

function snap(partial: Partial<Snapshot>): Snapshot {
  return { runs: [], job: null, session: null, shutdownRequested: false, cancelRequested: false, pendingDispatchAt: null, now: NOW, ...partial };
}

describe('deriveVmState', () => {
  it('is OFF with no runs', () => {
    const view = deriveVmState(snap({}));
    expect(view.phase).toBe('off');
    expect(view.label).toBe('OFF');
    expect(view.tone).toBe('off');
    expect(view.endpoint).toBeNull();
  });

  it('is OFF after a completed run and never exposes its endpoint', () => {
    const view = deriveVmState(snap({ runs: [run(5, 'completed', 'success')], session: { kind: 'valid', runId: '5', endpoint: '0.tcp.ngrok.io:1', commit: 'x' } }));
    expect(view.phase).toBe('off');
    expect(view.endpoint).toBeNull();
    expect(view.lastRun?.id).toBe(5);
  });

  it('reports a cancelled last run', () => {
    const view = deriveVmState(snap({ runs: [run(5, 'completed', 'cancelled')] }));
    expect(view.detail).toMatch(/force stopped/);
  });

  it('shows starting while a dispatch is pending and no run exists', () => {
    const view = deriveVmState(snap({ pendingDispatchAt: NOW - 10_000 }));
    expect(view.phase).toBe('starting');
    expect(view.label).toBe('Booting...');
    expect(view.tone).toBe('boot');
  });

  it('expires a dispatch that never produced a run', () => {
    const view = deriveVmState(snap({ pendingDispatchAt: NOW - 200_000, runs: [run(1, 'completed', 'success', '2026-11-25T10:00:00Z')] }));
    expect(view.dispatchExpired).toBe(true);
    expect(view.phase).toBe('off');
  });

  it('resolves a dispatch once a newer run appears', () => {
    const view = deriveVmState(snap({ pendingDispatchAt: NOW - 5_000, runs: [run(9, 'queued', null, new Date(NOW - 2_000).toISOString())] }));
    expect(view.dispatchResolved).toBe(true);
    expect(view.phase).toBe('queued');
  });

  it('does not resolve a dispatch with an older run', () => {
    const view = deriveVmState(snap({ pendingDispatchAt: NOW - 5_000, runs: [run(1, 'completed', 'success', '2026-11-26T10:00:00Z')] }));
    expect(view.dispatchResolved).toBe(false);
    expect(view.phase).toBe('starting');
  });

  it('is queued behind another run of the concurrency group', () => {
    const view = deriveVmState(snap({ runs: [run(2, 'pending')] }));
    expect(view.phase).toBe('queued');
    expect(view.detail).toMatch(/Queued behind/);
  });

  it('is booting while preparing the image, with a readable step', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Download Golden Image') }));
    expect(view.phase).toBe('booting');
    expect(view.detail).toBe('Preparing the Golden Image.');
    expect(view.stages.find((s) => s.key === 'runner')?.status).toBe('done');
    expect(view.stages.find((s) => s.key === 'image')?.status).toBe('active');
    expect(view.stages.find((s) => s.key === 'save')?.status).toBe('pending');
  });

  it('is booting while the tunnel step runs, even with a stale session file', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Start ngrok RDP tunnel'), session: { kind: 'stale', runId: '2', commit: 'x' } }));
    expect(view.phase).toBe('booting');
    expect(view.endpoint).toBeNull();
  });

  it('is ON with a valid endpoint for the current run', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Wait for shutdown'), session: { kind: 'valid', runId: '3', endpoint: '4.tcp.ngrok.io:12345', commit: 'x' } }));
    expect(view.phase).toBe('on');
    expect(view.label).toBe('ON');
    expect(view.tone).toBe('on');
    expect(view.endpoint).toBe('4.tcp.ngrok.io:12345');
    expect(view.endpointState).toBe('available');
  });

  it('hides a stale endpoint from a previous run', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Wait for shutdown'), session: { kind: 'stale', runId: '2', commit: 'x' } }));
    expect(view.phase).toBe('on');
    expect(view.endpoint).toBeNull();
    expect(view.endpointState).toBe('stale');
  });

  it('distinguishes a missing session from an API error', () => {
    const missing = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Wait for shutdown'), session: { kind: 'missing' } }));
    const error = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Wait for shutdown'), session: { kind: 'error', message: 'GitHub: 502' } }));
    expect(missing.endpointState).toBe('missing');
    expect(error.endpointState).toBe('error');
    expect(error.endpointNote).toMatch(/502/);
  });

  it('is shutting down after a graceful request', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Wait for shutdown'), shutdownRequested: true, session: { kind: 'valid', runId: '3', endpoint: 'a.b:1', commit: 'x' } }));
    expect(view.phase).toBe('stopping');
    expect(view.label).toBe('Shutting down...');
  });

  it('is saving while the layer uploads', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Save persistent layers') }));
    expect(view.phase).toBe('saving');
    expect(view.tone).toBe('save');
    expect(view.endpoint).toBeNull();
  });

  it('reports an unclean shutdown that skips the save', () => {
    const j = job('Diagnostics', { 'Wait for shutdown': 'failure', 'Save persistent layers': 'skipped' });
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: j }));
    expect(view.phase).toBe('stopping');
    expect(view.detail).toMatch(/did not shut down cleanly/);
  });

  it('reports a startup failure', () => {
    const j = job('Diagnostics', { 'Verify virtualization': 'failure' });
    j.steps = j.steps!.map((s) => (s.number > 6 && s.name !== 'Diagnostics' ? { ...s, status: 'completed', conclusion: 'skipped' } : s));
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: j }));
    expect(view.phase).toBe('stopping');
    expect(view.detail).toMatch(/Checking KVM support/);
  });

  it('shows stopping after a force stop request', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: job('Wait for shutdown'), cancelRequested: true }));
    expect(view.phase).toBe('stopping');
    expect(view.label).toBe('Stopping...');
  });

  it('boots when the job has no steps yet', () => {
    const view = deriveVmState(snap({ runs: [run(3, 'in_progress')], job: null }));
    expect(view.phase).toBe('booting');
  });
});

describe('selectActiveRun', () => {
  it('prefers the in-progress run and counts queued ones', () => {
    const { run: active, queuedBehind } = selectActiveRun([run(4, 'pending'), run(3, 'in_progress'), run(2, 'completed', 'success')]);
    expect(active?.id).toBe(3);
    expect(queuedBehind).toBe(1);
  });
});

describe('polling', () => {
  it('stops when off and slows down when on', () => {
    expect(pollInterval('off')).toBeNull();
    expect(pollInterval('on')).toBeGreaterThan(pollInterval('booting')!);
  });

  it('only fetches the session once the tunnel step finished', () => {
    expect(needsSession(job('Boot Windows'))).toBe(false);
    expect(needsSession(job('Start ngrok RDP tunnel'))).toBe(false);
    expect(needsSession(job('Wait for shutdown'))).toBe(true);
    expect(needsSession(job('Save persistent layers'))).toBe(false);
  });
});

describe('parseSession', () => {
  it('accepts the engine format', () => {
    const raw = JSON.stringify({ run_id: '123', endpoint: '0.tcp.eu.ngrok.io:17000' });
    expect(parseSession(raw, 123, 'c')).toEqual({ kind: 'valid', runId: '123', endpoint: '0.tcp.eu.ngrok.io:17000', commit: 'c' });
  });

  it('marks another run as stale', () => {
    expect(parseSession(JSON.stringify({ run_id: '99', endpoint: 'a.b:1' }), 123, 'c').kind).toBe('stale');
  });

  it('rejects malformed endpoints and JSON', () => {
    expect(parseSession(JSON.stringify({ run_id: 123, endpoint: 'javascript:alert(1)' }), 123, 'c').kind).toBe('invalid');
    expect(parseSession('{', 123, 'c').kind).toBe('invalid');
    expect(parseSession(JSON.stringify({ endpoint: 'a.b:1' }), 123, 'c').kind).toBe('invalid');
  });
});
