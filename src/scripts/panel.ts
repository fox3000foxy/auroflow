import { loadSession, currentWorkspace, logActivity, type AppSession } from '../lib/session';
import { VmController, type VmSnapshotState } from '../lib/vm-controller';
import { ApiError, describe } from '../lib/errors';
import { activityStore, credentials } from '../lib/storage';
import { HuggingFaceClient, defaultDatasetName } from '../lib/huggingface';
import { ENGINE_OWNER, ENGINE_REPO, AUTO_SHUTDOWN_MIN, VAR_HF_REPO } from '../lib/config';
import { stepDetail, type VmView } from '../lib/vm-state';
import type { GhRepo, GhRun, GitHubClient } from '../lib/github';
import { $, $$, el, icon, confirmDialog, copyText, toast } from '../lib/ui';
import { ago, bytes, clock, dateTime, duration } from '../lib/format';
import { downloadRdpFile, rdpUri, supportsRdpUri } from '../lib/rdp';

const RDP_URI_SUPPORTED = supportsRdpUri(navigator.userAgent, (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? '');

type Gate = 'loading' | 'signed-out' | 'no-workspace' | 'error' | 'ready';

let controller: VmController | null = null;
let unsubscribe: (() => void) | null = null;
let lastState: VmSnapshotState | null = null;
let repoMeta: GhRepo | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let workspaceRepo = '';

function gate(name: Gate) {
  for (const section of $$('[data-gate]')) section.hidden = section.dataset.gate !== name;
}

function gateError(title: string, text: string) {
  $('[data-gate-error-title]').textContent = title;
  $('[data-gate-error-text]').textContent = text;
  gate('error');
}

function teardown() {
  unsubscribe?.();
  controller?.stop();
  controller = null;
  unsubscribe = null;
  lastState = null;
  resourceRun = 0;
  resourceLoaded = false;
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/* ---------------- Boot ---------------- */

async function boot() {
  teardown();
  gate('loading');
  let session: AppSession | null;
  try {
    session = await loadSession();
  } catch (error) {
    gateError('GitHub is unreachable', `${describe(error)} The panel retries when you try again.`);
    return;
  }
  if (!session) {
    gate('signed-out');
    return;
  }
  const workspace = currentWorkspace(session.user.login);
  if (!workspace) {
    gate('no-workspace');
    return;
  }

  try {
    repoMeta = await session.gh.repo(workspace.owner, workspace.repo);
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'not_found') {
      gateError('Workspace not found', `${workspace.owner}/${workspace.repo} does not exist or this account cannot access it. Check the repository in Settings.`);
    } else {
      gateError('The workspace could not be loaded', describe(error));
    }
    return;
  }

  const repoKey = `${workspace.owner}/${workspace.repo}`;
  workspaceRepo = workspace.repo;
  $('[data-instance-name]').textContent = workspace.repo;
  const repoLink = $('[data-instance-repo]') as HTMLAnchorElement;
  repoLink.textContent = `${repoKey}${repoMeta.private ? '' : ' (public)'}`;
  repoLink.href = repoMeta.html_url;
  gate('ready');

  const log = (level: Parameters<typeof logActivity>[1], message: string) => logActivity(repoKey, level, message);
  controller = new VmController(session.gh, workspace.owner, workspace.repo, log);
  let previousPhase: VmView['phase'] | null = null;
  unsubscribe = controller.subscribe((state) => {
    lastState = state;
    render(state);
    const phase = state.view?.phase ?? null;
    if (phase === 'off' && previousPhase && previousPhase !== 'off') void loadStorage(session!.gh, workspace.owner, workspace.repo);
    previousPhase = phase;
  });
  renderLog(activityStore.list(repoKey));
  void controller.start();
  void loadStorage(session.gh, workspace.owner, workspace.repo);
  ticker = setInterval(() => lastState && renderClock(lastState), 1000);
}

/* ---------------- Rendering ---------------- */

const ACTIVE_PHASES = new Set<VmView['phase']>(['queued', 'booting', 'on', 'stopping', 'saving']);

let resourceRun = 0;
let resourcePending = false;
let resourceLoaded = false;
function render(state: VmSnapshotState) {
  const run = state.view?.run?.id ?? 0;
  $('[data-resource-section]').hidden = !run;
  if (run !== resourceRun) {
    resourceRun = run;
    resourceLoaded = false;
    $('[data-storage-disk]').textContent = 'Not detected';
    document.querySelectorAll('[data-vm-resource]').forEach(el => el.textContent = 'Pending');
    document.querySelector('[data-vm-details]')!.textContent = 'Waiting for current session metadata.';
  }
  void loadSession().then(async session => {
  const ws = session && currentWorkspace(session.user.login);
  if (session && ws && run && state.view?.phase === 'on' && !resourcePending && !resourceLoaded) {
    resourcePending = true;
    void session.gh.fileText(ws.owner,ws.repo,'session.json','golden-control').then(raw => {
      if (!raw || resourceRun !== run) return;
      const data = JSON.parse(raw);
      if (String(data.run_id) !== String(run) || !data.vm) return;
      const vm = data.vm;
      resourceLoaded = true;

      if (Number.isFinite(vm.disk_virtual_bytes)) {
        $('[data-storage-disk]').textContent =
          (vm.disk_virtual_bytes / 1073741824).toFixed(1) + ' GiB, QCOW2';
      }
      const values = [Number.isFinite(vm.vcpus) ? String(vm.vcpus) : 'Unavailable', Number.isFinite(vm.memory_mib) ? (vm.memory_mib/1024).toFixed(2)+' GiB' : 'Unavailable', Number.isFinite(vm.disk_virtual_bytes) ? (vm.disk_virtual_bytes/1073741824).toFixed(1)+' GiB' : 'Unavailable', vm.acceleration === 'kvm' ? 'KVM' : 'Unavailable'];
      document.querySelectorAll('[data-vm-resource]').forEach((el,i) => el.textContent = values[i]);
      document.querySelector('[data-vm-details]')!.textContent = [vm.cpu_model,vm.machine,vm.firmware,vm.tpm,vm.image_source].filter(v=>typeof v==='string').join(' | ');
    }).catch(()=>{}).finally(()=>{resourcePending=false;});
  }
  }).catch(console.error);
  const view = state.view;
  const status = $('[data-vm-status]');
  status.dataset.tone = view?.tone ?? 'unknown';
  $('[data-status-label]').textContent = view?.label ?? (state.error ? 'Unknown' : 'Checking');
  $('[data-status-detail]').textContent = view?.detail ?? (state.error ? 'The VM state could not be determined.' : 'Reading the workflow state from GitHub.');

  // API errors are shown separately from the VM state.
  const errorBox = $('[data-api-error]');
  errorBox.hidden = !state.error;
  $('[data-api-error-text]').textContent = state.error ?? '';
  if (state.errorKind === 'auth') {
    teardown();
    gate('signed-out');
    return;
  }

  $('[data-public-warning]').hidden = !(repoMeta && !repoMeta.private);

  // Controls
  const busy = state.busy;
  const phase = view?.phase;
  const cancelling = view?.label === 'Stopping...';
  setButton('start', !busy && phase === 'off', busy === 'start');
  setButton('shutdown', !busy && phase === 'on', busy === 'shutdown');
  setButton('force', !busy && !!phase && ACTIVE_PHASES.has(phase) && !cancelling, busy === 'force');
  const refresh = $('[data-action="refresh"]') as HTMLButtonElement;
  refresh.disabled = state.loading;

  renderEndpoint(view);
  renderStages(view);
  renderRuns(state.runs, view?.run ?? null);
  renderActions(state);
  renderClock(state);
}

function setButton(action: string, enabled: boolean, busy: boolean) {
  const button = $(`[data-action="${action}"]`) as HTMLButtonElement;
  button.disabled = !enabled;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

function renderEndpoint(view: VmView | null) {
  const box = $('.endpoint');
  const value = $('[data-endpoint]');
  const note = $('[data-endpoint-note]');
  const copy = $('[data-action="copy"]') as HTMLButtonElement;
  const state = view?.endpointState ?? 'none';
  box.dataset.endpointState = state;
  value.textContent = view?.endpoint ?? (state === 'pending' ? 'Waiting for tunnel' : 'No active endpoint');
  copy.disabled = !view?.endpoint;
  ($('[data-action="rdp-file"]') as HTMLButtonElement).disabled = !view?.endpoint;
  const uriLink = $('[data-rdp-link]') as HTMLAnchorElement;
  uriLink.hidden = !(RDP_URI_SUPPORTED && view?.endpoint);
  if (view?.endpoint) uriLink.href = rdpUri(view.endpoint);
  else uriLink.removeAttribute('href');
  note.textContent = view?.endpointNote || (view?.phase === 'off' ? 'Start the instance to open an RDP tunnel.' : '');

  const link = $('[data-workflow-link]') as HTMLAnchorElement;
  const run = view?.run ?? view?.lastRun ?? null;
  link.hidden = !run;
  if (run) {
    link.href = run.html_url;
    $('[data-workflow-link-text]').textContent = view?.run ? `Run #${run.run_number}` : `Last run #${run.run_number}`;
  }
}

const STAGE_TEXT: Record<string, string> = { pending: 'pending', active: 'in progress', done: 'done', failed: 'failed', skipped: 'skipped' };

function renderStages(view: VmView | null) {
  const stages = view?.stages ?? [];
  $$('[data-stage-index]').forEach((item, index) => {
    const status = stages[index]?.status ?? 'pending';
    item.dataset.status = status;
    item.querySelector('[data-stage-sr]')!.textContent = STAGE_TEXT[status];
  });
  $('[data-lifecycle-meta]').textContent = view?.run ? `Run #${view.run.run_number}${view.queuedBehind ? `, ${view.queuedBehind} queued` : ''}` : 'Idle';
}

function resultCell(run: GhRun): HTMLElement {
  const active = run.status !== 'completed';
  const key = active ? 'active' : run.conclusion ?? 'unknown';
  const label = active ? (run.status === 'in_progress' ? 'Running' : 'Queued') : ({ success: 'Completed', failure: 'Failed', cancelled: 'Force stopped', timed_out: 'Timed out', skipped: 'Skipped' }[key] ?? key);
  const name = active ? 'circle' : key === 'success' ? 'check' : key === 'cancelled' ? 'minus' : key === 'failure' || key === 'timed_out' ? 'x' : 'info';
  return el('span', { class: 'result', attrs: { 'data-result': key } }, [icon(name), el('span', { text: label })]);
}

function renderRuns(runs: GhRun[], current: GhRun | null) {
  const body = $('[data-runs]');
  body.replaceChildren(
    ...runs.map((run) => {
      const started = run.run_started_at ?? run.created_at;
      const end = run.status === 'completed' ? Date.parse(run.updated_at) : Date.now();
      const num = el('td', {}, [el('span', { class: 'runs__num', text: `#${run.run_number}` })]);
      if (current?.id === run.id) num.append(el('span', { class: 'runs__current', text: 'current' }));
      const link = el('a', { attrs: { href: run.html_url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open run ${run.run_number} on GitHub` } }, [icon('external')]);
      return el('tr', {}, [
        num,
        el('td', {}, [resultCell(run)]),
        el('td', { text: dateTime(started), attrs: { title: new Date(started).toISOString() } }),
        el('td', { text: duration(end - Date.parse(started)) }),
        el('td', {}, [link]),
      ]);
    }),
  );
  $('[data-runs-empty]').hidden = runs.length > 0;
  $('.runs').hidden = runs.length === 0;
}

function renderActions(state: VmSnapshotState) {
  const view = state.view;
  const run = view?.run;
  const job = state.job;
  $('[data-gh-run]').textContent = run ? `#${run.run_number} (${run.id})` : 'None active';
  $('[data-gh-status]').textContent = run ? run.status.replace('_', ' ') : view?.lastRun ? `completed, ${view.lastRun.conclusion ?? 'unknown'}` : 'None';
  const step = job?.steps?.find((s) => s.status === 'in_progress');
  $('[data-gh-step]').textContent = step ? step.name : run ? 'Waiting' : 'None';
  $('[data-gh-step]').title = step ? stepDetail(step.name) : '';
  const trigger = run ?? view?.lastRun;
  $('[data-gh-trigger]').textContent = trigger ? `${trigger.event} by ${trigger.triggering_actor?.login ?? trigger.actor?.login ?? 'unknown'}` : 'None';
  $('[data-gh-created]').textContent = trigger ? dateTime(trigger.created_at) : 'None';
  $('[data-runner]').textContent = job?.runner_name ? `${job.runner_name}${job.labels.length ? ` (${job.labels.join(', ')})` : ''}` : run ? 'Waiting for assignment' : 'Assigned at start';
}

function renderClock(state: VmSnapshotState) {
  const meta = $('[data-refresh-meta]');
  meta.dataset.loading = String(state.loading);
  if (state.loading) meta.textContent = 'Refreshing';
  else if (state.updatedAt) {
    const seconds = Math.round((Date.now() - state.updatedAt) / 1000);
    const next = state.nextPollAt ? Math.max(0, Math.round((state.nextPollAt - Date.now()) / 1000)) : null;
    meta.textContent = `Updated ${seconds < 5 ? 'just now' : `${seconds} s ago`}${next !== null ? `, next in ${next} s` : document.hidden ? '' : ', auto refresh paused'}`;
  } else meta.textContent = '';

  const job = state.job;
  const started = job?.started_at ? Date.parse(job.started_at) : null;
  const active = !!state.view?.run && state.view.phase !== 'queued';
  $('[data-session-elapsed]').textContent = active && started ? duration(Date.now() - started) : 'Not running';
  $('[data-session-deadline]').textContent = active && started
    ? `About ${clock(started + AUTO_SHUTDOWN_MIN * 60_000).slice(0, 5)} (${duration(started + AUTO_SHUTDOWN_MIN * 60_000 - Date.now())} left)`
    : `${AUTO_SHUTDOWN_MIN} min after start`;
}

function renderLog(entries: ReturnType<typeof activityStore.list>) {
  const list = $('[data-log]');
  const names = { info: 'info', success: 'check', warning: 'alert', error: 'x' } as const;
  list.replaceChildren(
    ...entries.map((entry) =>
      el('li', { attrs: { 'data-level': entry.level } }, [
        el('time', { text: clock(entry.at), attrs: { datetime: new Date(entry.at).toISOString(), title: new Date(entry.at).toLocaleString() } }),
        icon(names[entry.level]),
        el('span', { text: entry.message }),
      ]),
    ),
  );
  $('[data-log-empty]').hidden = entries.length > 0;
}

/* ---------------- Storage details ---------------- */

function setDd(selector: string, text: string, title = '') {
  const node = $(selector);
  node.textContent = text;
  node.title = title;
}

async function loadStorage(gh: GitHubClient, owner: string, repo: string) {
  const note = $('[data-storage-note]');
  const notes: string[] = [];

  // Detect the configured image source.
  try {
    const customUrl = await gh.variable(owner, repo, 'GOLDEN_URL');

    if (customUrl) {
      setDd('[data-instance-os]', 'Custom virtual machine');
      setDd('[data-golden-tag]', 'Custom QCOW2', customUrl);
      setDd('[data-golden-cache]', 'Not applicable');

      try {
        const hf = new HuggingFaceClient(credentials.huggingFace() ?? '');
        const size = await hf.goldenSize(customUrl);

        setDd('[data-golden-size]', size === null ? 'Unknown' : bytes(size));
      } catch (error) {
        setDd('[data-golden-size]', 'Unavailable', describe(error));
      }
    } else {
      setDd('[data-instance-os]', 'Windows 10 IoT Enterprise LTSC 2021');

      const env = await gh.fileText(owner, repo, 'golden.env');
      const tag = env ? /^GOLDEN_TAG=(.+)$/m.exec(env)?.[1]?.trim() : undefined;

      setDd('[data-golden-tag]', tag ?? 'Not pinned');

      if (tag) {
        const release = await gh.releaseByTag(ENGINE_OWNER, ENGINE_REPO, tag);
        const parts = release?.assets.filter(
          a => /^(windows10-golden|auroflow-engine)\.qcow2\.part-?\d+$/.test(a.name)
        ) ?? [];

        setDd(
          '[data-golden-size]',
          parts.length
            ? `${bytes(parts.reduce((sum, a) => sum + a.size, 0))} in ${parts.length} parts`
            : 'Image assets not detected'
        );
      } else {
        setDd('[data-golden-size]', 'Unknown');
      }

      try {
        const caches = await gh.goldenCaches(owner, repo);
        const cache = caches[0];

        setDd(
          '[data-golden-cache]',
          cache ? `${bytes(cache.size_in_bytes)}, used ${ago(cache.last_accessed_at)}` : 'Not cached yet',
          cache?.key ?? ''
        );
      } catch (error) {
        setDd('[data-golden-cache]', 'Unavailable', describe(error));
      }
    }
  } catch (error) {
    setDd('[data-instance-os]', 'Virtual machine');
    setDd('[data-golden-tag]', 'Unavailable', describe(error));
    setDd('[data-golden-size]', 'Unavailable', describe(error));
    setDd('[data-golden-cache]', 'Unknown');
  }

  // Persistence dataset.
  let dataset: string | null = null;
  try {
    dataset = await gh.variable(owner, repo, VAR_HF_REPO);
  } catch (error) {
    notes.push(`${VAR_HF_REPO} could not be read: ${describe(error)}`);
  }
  const hfToken = credentials.huggingFace();
  if (!hfToken) {
    setDd('[data-dataset]', dataset ?? `Default (<hf-user>/${repo}-layers)`);
    setDd('[data-layers]', 'Token needed');
    setDd('[data-dataset-size]', 'Token needed');
    notes.push('Layer details need the Hugging Face token. Enter it in Settings and keep it for this tab.');
  } else {
    const hf = new HuggingFaceClient(hfToken);
    try {
      if (!dataset) dataset = defaultDatasetName((await hf.whoami()).name, repo);
      setDd('[data-dataset]', dataset);
      const info = await hf.datasetOrNull(dataset);
      if (!info) {
        setDd('[data-layers]', 'None');
        setDd('[data-dataset-size]', 'Not created yet');
        notes.push('The dataset is created as private on the first run.');
      } else {
        const usage = await hf.usage(dataset);
        setDd('[data-layers]', `${usage.layers} ${usage.layers === 1 ? 'layer' : 'layers'}`);
        setDd('[data-dataset-size]', `${bytes(usage.bytes)}${info.lastModified ? `, updated ${ago(info.lastModified)}` : ''}`);
        if (!info.private) notes.push('The dataset is public. The engine refuses to save to a public dataset.');
      }
    } catch (error) {
      setDd('[data-dataset]', dataset ?? 'Unknown');
      setDd('[data-layers]', 'Unavailable', describe(error));
      setDd('[data-dataset-size]', 'Unavailable', describe(error));
      notes.push(describe(error));
    }
  }
  note.textContent = notes.join(' ');
  note.hidden = notes.length === 0;
}

/* ---------------- Actions ---------------- */

function bindActions() {
  const act = async (fn: () => Promise<void>, success?: string) => {
    try {
      await fn();
      if (success) toast(success, 'success');
    } catch (error) {
      toast(describe(error), 'error');
    }
  };

  $('[data-action="start"]').addEventListener('click', async () => {
    if (!controller) return;
    if (repoMeta && !repoMeta.private) {
      const ok = await confirmDialog({
        title: 'Start a public instance?',
        body: 'This workspace is public, so the RDP endpoint will be readable by anyone. The reference image has a passwordless account. Continue only if you have set a strong Windows password.',
        confirmLabel: 'Start instance',
      });
      if (!ok) return;
    }
    await act(() => controller!.startInstance(), 'Start requested.');
  });

  $('[data-action="shutdown"]').addEventListener('click', async () => {
    if (!controller) return;
    const ok = await confirmDialog({
      title: 'Shut down Windows?',
      body: 'Windows receives an ACPI power-down request, then the session layer is saved to Hugging Face. Save your work and close applications first. The engine checks for requests every 15 seconds.',
      confirmLabel: 'Shut down',
    });
    if (ok) await act(() => controller!.requestShutdown(), 'Shutdown requested.');
  });

  $('[data-action="force"]').addEventListener('click', async () => {
    if (!controller) return;
    const saving = lastState?.view?.phase === 'saving';
    const ok = await confirmDialog({
      title: 'Force stop the instance?',
      body: saving
        ? 'The session layer is being uploaded right now. Cancelling may leave the dataset without this session. Every change made since the last saved session will be lost.'
        : 'The workflow run is cancelled immediately. Windows is not shut down and nothing is saved: every change made since the last saved session will be lost.',
      confirmLabel: 'Force stop',
      tone: 'danger',
    });
    if (ok) await act(() => controller!.forceStop(), 'Cancellation requested.');
  });

  $('[data-action="refresh"]').addEventListener('click', () => void controller?.refresh());

  $('[data-action="copy"]').addEventListener('click', async () => {
    const endpoint = lastState?.view?.endpoint;
    if (!endpoint) return;
    const label = $('[data-copy-label]');
    if (await copyText(endpoint)) {
      label.textContent = 'Copied';
      setTimeout(() => (label.textContent = 'Copy'), 1800);
    } else toast('The browser blocked clipboard access. Select the address and copy it manually.', 'error');
  });

  $('[data-action="rdp-file"]').addEventListener('click', () => {
    const endpoint = lastState?.view?.endpoint;
    if (!endpoint) return;
    try {
      downloadRdpFile(endpoint, workspaceRepo);
      toast('Connection file downloaded. Open it with your Remote Desktop client.', 'success');
    } catch (error) {
      toast(describe(error), 'error');
    }
  });

  $('[data-gate-retry]').addEventListener('click', () => void boot());

  // Tabs with arrow-key navigation.
  const tabs = $$('[data-tab]') as HTMLButtonElement[];
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      $(`[data-tabpanel="${t.dataset.tab}"]`).hidden = !selected;
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      select(next);
      next.focus();
    });
  });

  document.addEventListener('golden:activity', (event) => renderLog((event as CustomEvent).detail));
  document.addEventListener('golden:signed-in', () => void boot());
  document.addEventListener('golden:signed-out', () => {
    teardown();
    gate('signed-out');
  });
}

export function initPanel(): void {
  bindActions();
  void boot();
}
