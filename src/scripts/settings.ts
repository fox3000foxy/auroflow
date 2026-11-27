import { loadSession, signOut, currentWorkspace, logActivity, isRemembered, type AppSession } from '../lib/session';
import { credentials, workspaceStore, activityStore, takeLegacyRepo, dispatchLock } from '../lib/storage';
import { inspectWorkspace, validateWorkspace, saveWorkspace, isValidIpv4Host, type WorkspaceStatus, type Check } from '../lib/workspace';
import { HuggingFaceClient, defaultDatasetName } from '../lib/huggingface';
import { isActiveRun } from '../lib/vm-state';
import { describe } from '../lib/errors';
import { DATASET_RE, DEFAULT_WORKSPACE_REPO, REPO_NAME_RE, VAR_RDP_CIDR } from '../lib/config';
import { ago } from '../lib/format';
import { $, $$, el, icon, confirmDialog, toast } from '../lib/ui';

let session: AppSession | null = null;
let status: WorkspaceStatus | null = null;
let inspectToken = 0;

const form = () => $('[data-config-form]') as HTMLFormElement;
const input = (selector: string) => $(selector) as HTMLInputElement;
const repoName = () => input('[data-repo-input]').value.trim();
const visibility = () => (form().elements.namedItem('visibility') as RadioNodeList).value as 'private' | 'public';

/* ---------------- Account ---------------- */

function renderAccount() {
  $('[data-account-loading]').hidden = true;
  $('[data-account-signed-out]').hidden = !!session;
  $('[data-account-signed-in]').hidden = !session;
  (($('[data-config-fieldset]') as HTMLFieldSetElement).disabled = !session);
  ($('[data-validate]') as HTMLButtonElement).disabled = !session;
  ($('[data-forget]') as HTMLButtonElement).disabled = !workspaceStore.get();
  const scopeWarning = $('[data-scope-warning]');
  if (!session) {
    scopeWarning.hidden = true;
    renderChecks(null);
    return;
  }
  const { user, gh, missingScopes } = session;
  $('[data-account-name]').textContent = user.name ? `${user.name} (${user.login})` : user.login;
  const where = isRemembered() ? 'Remembered on this browser for up to 7 days.' : 'Kept in this tab only.';
  $('[data-account-scopes]').textContent = gh.scopes ? `Scopes: ${gh.scopes.join(', ') || 'none'}. ${where}` : where;
  const avatar = $('[data-account-avatar]') as HTMLImageElement;
  if (/^https:\/\/avatars\.githubusercontent\.com\//.test(user.avatar_url)) avatar.src = `${user.avatar_url}${user.avatar_url.includes('?') ? '&' : '?'}s=80`;
  $('[data-owner-prefix]').textContent = `${user.login}/`;
  scopeWarning.hidden = missingScopes.length === 0;
  $('[data-scope-warning-text]').textContent = `This token is missing the ${missingScopes.join(' and ')} scope. Starting the VM and saving secrets will fail. Sign out and sign in again.`;
}

/* ---------------- Workspace status ---------------- */

function setFieldError(name: string, message: string | null) {
  const node = $(`[data-error-for="${name}"]`);
  node.textContent = message ?? '';
  node.hidden = !message;
  const field = form().elements.namedItem(name) as HTMLInputElement | null;
  if (field) field.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function renderStatus() {
  const repoState = $('[data-repo-state]');
  const visState = $('[data-visibility-state]');
  const repo = status?.repo ?? null;
  if (!status) {
    repoState.textContent = '';
    visState.textContent = '';
  } else if (!repo) {
    repoState.textContent = 'Will be created from the template';
    visState.textContent = 'Applied on creation';
  } else {
    repoState.textContent = 'Exists';
    visState.textContent = `Currently ${repo.private ? 'private' : 'public'}`;
  }

  const secretText = (updated: string | null) => (updated ? `Configured, updated ${ago(updated)}` : 'Required');
  $('[data-secret-state="ngrok"]').textContent = status ? secretText(status.secrets.ngrok) : 'Unknown';
  $('[data-secret-state="hf"]').textContent = status ? secretText(status.secrets.hf) : 'Unknown';
  input('[data-ngrok-input]').placeholder = status?.secrets.ngrok ? 'Leave empty to keep the stored token' : 'Required';
  input('[data-hf-input]').placeholder = status?.secrets.hf ? 'Leave empty to keep the stored token' : 'Required';

  const datasetInput = input('[data-dataset-input]');
  if (status && !datasetInput.dataset.touched) datasetInput.value = status.variables.hfRepo ?? '';

  input('[data-golden-url]').value = status?.variables.goldenUrl ?? '';
  input('[data-golden-hash]').value = status?.variables.goldenHash ?? '';

  // Network restriction support, read from the workspace's own workflow.
  const notice = $('[data-network-state]');
  const text = $('[data-network-text]');
  const cidrField = $('[data-cidr-field]');
  const cidrInput = input('[data-cidr-input]');
  const network = status?.network ?? 'unknown';
  notice.className = `notice ${network === 'validated' ? 'notice--warn' : 'notice--info'}`;
  cidrField.hidden = network !== 'validated' && network !== 'enforced';
  if (status && !cidrInput.dataset.touched) cidrInput.value = status.variables.cidr ?? '';
  $('[data-cidr-state]').textContent = status?.variables.cidr ? 'Configured' : 'Required by the workflow';
  text.textContent = {
    unknown: status?.repo ? 'The workflow file could not be read.' : 'The workflow is read after the repository exists.',
    enforced: 'This workspace passes the allowed address to ngrok. Connections from other addresses are rejected.',
    validated: `This engine version requires ${VAR_RDP_CIDR} and checks its format, but no longer passes it to ngrok. The tunnel accepts connections from any address. The value is still needed for the workflow to start.`,
    absent: 'This engine version does not support address restrictions. The ngrok tunnel accepts connections from any address.',
  }[network];

  $('[data-public-notice]').hidden = visibility() !== 'public';
  void renderDangerTarget();
}

async function inspect() {
  if (!session) return;
  const name = repoName();
  if (!REPO_NAME_RE.test(name)) {
    setFieldError('repo', 'Use letters, numbers, dots, hyphens or underscores.');
    return;
  }
  setFieldError('repo', null);
  const token = ++inspectToken;
  $('[data-repo-state]').textContent = 'Checking';
  try {
    const result = await inspectWorkspace(session.gh, session.user.login, name);
    if (token !== inspectToken) return;
    status = result;
    if (result.repo) {
      const radio = form().querySelector<HTMLInputElement>(`input[name="visibility"][value="${result.repo.private ? 'private' : 'public'}"]`);
      if (radio && !form().dataset.visibilityTouched) radio.checked = true;
    }
    renderStatus();
    await runValidation();
  } catch (error) {
    if (token !== inspectToken) return;
    status = null;
    renderStatus();
    $('[data-repo-state]').textContent = 'Could not be checked';
    setSaveStatus(describe(error), 'error');
  }
}

/* ---------------- Validation ---------------- */

function renderChecks(checks: Check[] | null) {
  const list = $('[data-checks]');
  if (!checks) {
    list.replaceChildren(el('li', { class: 'checks__empty', text: session ? 'Running checks.' : 'Sign in and choose a workspace to validate it.' }));
    return;
  }
  const names = { pass: 'check', fail: 'x', warn: 'alert', skip: 'minus' } as const;
  const text = { pass: 'Passed', fail: 'Failed', warn: 'Warning', skip: 'Skipped' } as const;
  list.replaceChildren(
    ...checks.map((check) =>
      el('li', { attrs: { 'data-status': check.status } }, [
        icon(names[check.status]),
        el('span', { class: 'checks__label' }, [document.createTextNode(check.label), el('span', { class: 'visually-hidden', text: `: ${text[check.status]}` })]),
        el('span', { class: 'checks__detail', text: check.detail }),
      ]),
    ),
  );
}

async function runValidation() {
  if (!session || !status) return;
  const button = $('[data-validate]') as HTMLButtonElement;
  button.setAttribute('aria-busy', 'true');
  renderChecks(null);
  try {
    const checks = await validateWorkspace(session.gh, status, {
      owner: session.user.login,
      repo: repoName(),
      hfToken: credentials.huggingFace(),
    });
    renderChecks(checks);
  } catch (error) {
    renderChecks([{ id: 'error', label: 'Validation', status: 'fail', detail: describe(error) }]);
  } finally {
    button.removeAttribute('aria-busy');
  }
}

/* ---------------- Save ---------------- */

function setSaveStatus(message: string, tone: 'info' | 'error' | 'success' = 'info') {
  const node = $('[data-save-status]');
  node.textContent = message;
  node.dataset.tone = tone;
}

function validateForm(): boolean {
  let ok = true;
  const fail = (name: string, message: string) => {
    setFieldError(name, message);
    ok = false;
  };
  for (const name of ['repo', 'ngrok', 'hf', 'dataset', 'cidr', 'goldenUrl', 'goldenHash']) setFieldError(name, null);

  if (!REPO_NAME_RE.test(repoName())) fail('repo', 'Use letters, numbers, dots, hyphens or underscores.');
  const ngrok = input('[data-ngrok-input]').value.trim();
  const hf = input('[data-hf-input]').value.trim();
  if (!ngrok && !status?.secrets.ngrok) fail('ngrok', 'The ngrok token is required to open the RDP tunnel.');
  if (ngrok && /\s/.test(ngrok)) fail('ngrok', 'The token contains spaces.');
  if (!hf && !status?.secrets.hf) fail('hf', 'The Hugging Face token is required for persistence.');
  if (hf && !/^hf_\S{20,}$/.test(hf)) fail('hf', 'Hugging Face tokens start with hf_.');
  const dataset = input('[data-dataset-input]').value.trim();
  if (dataset && !DATASET_RE.test(dataset)) fail('dataset', 'Use the form owner/name.');
  const goldenUrl = input('[data-golden-url]').value.trim().replace('/blob/', '/resolve/');
  const goldenHash = input('[data-golden-hash]').value.trim().toLowerCase();

  if (goldenUrl) {
    if (!/^https:\/\/huggingface\.co\/datasets\/[^/]+\/[^/]+\/resolve\/[^/]+\/[^?#]+\.qcow2$/i.test(goldenUrl))
      fail('goldenUrl', 'Enter a valid Hugging Face dataset QCOW2 URL.');
    if (!/^[a-f0-9]{64}$/.test(goldenHash))
      fail('goldenHash', 'Enter a valid SHA-256 checksum.');
    if (status?.repo && !status.customGolden)
      fail('goldenUrl', 'Update this workspace to the latest AuroFlow Engine.');
    if (!dataset)
      fail('dataset', 'Specify a separate persistence dataset for the custom image.');
  }

  const network = status?.network;
  if (network === 'validated' || network === 'enforced') {
    const cidr = input('[data-cidr-input]').value.trim();
    if (cidr && !isValidIpv4Host(cidr)) fail('cidr', 'Enter a single IPv4 address followed by /32, for example 203.0.113.10/32.');
    if (!cidr && !status?.variables.cidr) fail('cidr', 'The workflow in this workspace stops if this value is missing.');
  }
  if (!ok) {
    const firstInvalid = form().querySelector<HTMLElement>('[aria-invalid="true"]');
    firstInvalid?.focus();
  }
  return ok;
}

async function onSave(event: SubmitEvent) {
  event.preventDefault();
  if (!session) return;
  if (!status) await inspect();
  if (!validateForm()) {
    setSaveStatus('Fix the highlighted fields.', 'error');
    return;
  }
  const wantPrivate = visibility() === 'private';
  const existing = status?.repo ?? null;
  let applyVisibility = false;
  if (existing && existing.private !== wantPrivate) {
    const ok = await confirmDialog(
      wantPrivate
        ? { title: 'Make the workspace private?', body: `${existing.full_name} becomes private. Actions minutes for private repositories count against your plan.`, confirmLabel: 'Make private' }
        : { title: 'Make the workspace public?', body: `Anyone will be able to read ${existing.full_name}, including the RDP endpoint on the golden-control branch and workflow logs. Secrets remain encrypted.`, confirmLabel: 'Make public', tone: 'danger' },
    );
    if (!ok) return;
    applyVisibility = true;
  } else if (!existing && !wantPrivate) {
    const ok = await confirmDialog({
      title: 'Create a public workspace?',
      body: 'The RDP endpoint of every session will be publicly readable. Set a strong Windows password before connecting.',
      confirmLabel: 'Create public workspace',
      tone: 'danger',
    });
    if (!ok) return;
  }

  const button = $('[data-save]') as HTMLButtonElement;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  const hfToken = input('[data-hf-input]').value.trim();
  const owner = session.user.login;
  const repo = repoName();
  try {
    await saveWorkspace(
      session.gh,
      {
        owner,
        repo,
        private: wantPrivate,
        ngrokToken: input('[data-ngrok-input]').value.trim(),
        hfToken,
        dataset: input('[data-dataset-input]').value.trim(),
        cidr: input('[data-cidr-input]').value.trim(),
        goldenUrl: input('[data-golden-url]').value.trim().replace('/blob/', '/resolve/'),
        goldenHash: input('[data-golden-url]').value.trim()
          ? input('[data-golden-hash]').value.trim().toLowerCase()
          : '',
        applyVisibility,
      },
      (message) => setSaveStatus(`${message}.`),
    );
    workspaceStore.set({ owner, repo });
    if ((input('[data-keep-hf]')).checked) {
      if (hfToken) credentials.setHuggingFace(hfToken);
    } else credentials.setHuggingFace(null);
    input('[data-ngrok-input]').value = '';
    input('[data-hf-input]').value = '';
    delete input('[data-dataset-input]').dataset.touched;
    delete input('[data-cidr-input]').dataset.touched;
    delete form().dataset.visibilityTouched;
    logActivity(`${owner}/${repo}`, 'success', existing ? 'Workspace configuration saved.' : 'Workspace created from the Golden template and configured.');
    setSaveStatus('Configuration saved.', 'success');
    toast('Configuration saved.', 'success');
    ($('[data-forget]') as HTMLButtonElement).disabled = false;
    renderKept();
    await inspect();
  } catch (error) {
    setSaveStatus(describe(error), 'error');
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

/* ---------------- Hugging Face helpers ---------------- */

function renderKept() {
  $('[data-hf-kept]').textContent = credentials.huggingFace() ? 'A token is currently kept in this tab.' : '';
  $('[data-danger-token-field]').hidden = !!credentials.huggingFace();
}

function hfTokenForLookup(): string | null {
  return input('[data-hf-input]').value.trim() || credentials.huggingFace();
}

async function resolveDataset(token: string | null): Promise<string | null> {
  const configured = status?.variables.hfRepo;
  if (configured) return configured;
  if (!token) return null;
  const me = await new HuggingFaceClient(token).whoami();
  return defaultDatasetName(me.name, repoName());
}

async function renderDangerTarget() {
  const target = $('[data-danger-dataset]');
  const button = $('[data-delete-dataset]') as HTMLButtonElement;
  const configured = status?.variables.hfRepo ?? null;
  target.textContent = configured ?? (credentials.huggingFace() ? 'Default name, resolved on delete' : `<hf-user>/${repoName()}-layers`);
  button.disabled = !session || !status?.repo;
}

async function onDeleteDataset() {
  if (!session || !status?.repo) return;
  const owner = session.user.login;
  const repo = repoName();
  const token = credentials.huggingFace() || input('[data-danger-token]').value.trim();
  if (!token) {
    toast('Enter a Hugging Face token with delete permission.', 'error');
    input('[data-danger-token]').focus();
    return;
  }
  const button = $('[data-delete-dataset]') as HTMLButtonElement;
  button.setAttribute('aria-busy', 'true');
  try {
    const runs = await session.gh.runs(owner, repo, 10);
    if (runs.some(isActiveRun) || dispatchLock.get(`${owner}/${repo}`)) {
      toast('The instance is running or starting. Stop it before deleting persistent data.', 'error');
      return;
    }
    const dataset = await resolveDataset(token);
    if (!dataset) throw new Error('The dataset name could not be determined.');
    const hf = new HuggingFaceClient(token);
    const exists = await hf.datasetOrNull(dataset);
    if (!exists) {
      toast(`${dataset} does not exist. Nothing to delete.`);
      return;
    }
    button.removeAttribute('aria-busy');
    const ok = await confirmDialog({
      title: 'Delete persistent data?',
      body: `This permanently deletes ${dataset} on Hugging Face, including every saved layer and the UEFI and TPM state. The next session starts from a clean Golden Image.`,
      confirmLabel: 'Delete dataset',
      tone: 'danger',
      requireText: dataset,
    });
    if (!ok) return;
    button.setAttribute('aria-busy', 'true');
    await hf.deleteDataset(dataset);
    input('[data-danger-token]').value = '';
    logActivity(`${owner}/${repo}`, 'warning', `Persistent dataset ${dataset} deleted.`);
    toast(`${dataset} deleted.`, 'success');
    await runValidation();
  } catch (error) {
    toast(describe(error), 'error');
  } finally {
    button.removeAttribute('aria-busy');
  }
}

/* ---------------- Section index ---------------- */

async function fetchGoldenHash() {
  const button = $('[data-fetch-golden-hash]') as HTMLButtonElement;
  const urlField = input('[data-golden-url]');
  const hashField = input('[data-golden-hash]');
  const url = urlField.value.trim();

  if (!url) {
    setFieldError('goldenUrl', 'Enter a Hugging Face image URL first.');
    return;
  }

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  setFieldError('goldenUrl', null);
  setFieldError('goldenHash', null);

  try {
    const token = input('[data-hf-input]').value.trim()
      || credentials.huggingFace()
      || '';

    const hf = new HuggingFaceClient(token);
    const hash = await hf.goldenChecksum(url);

    if (urlField.value.trim() !== url) return;

    hashField.value = hash;
    urlField.value = url.replace('/blob/', '/resolve/');
    toast('Golden Image checksum retrieved.', 'success');
  } catch (error) {
    setFieldError('goldenHash', describe(error));
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

function bindIndex() {
  $('[data-fetch-golden-hash]').addEventListener(
    'click', () => void fetchGoldenHash()
  );

  input('[data-golden-url]').addEventListener('input', () => {
    input('[data-golden-hash]').value = '';
  });

  const links = $$('[data-index-link]');
  const sections = links.map((link) => document.getElementById(link.dataset.indexLink!)).filter((s): s is HTMLElement => !!s);
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      for (const link of links) link.setAttribute('aria-current', String(link.dataset.indexLink === visible.target.id));
    },
    { rootMargin: '-80px 0px -60% 0px' },
  );
  sections.forEach((section) => observer.observe(section));
}

/* ---------------- Boot ---------------- */

async function boot() {
  try {
    session = await loadSession();
  } catch (error) {
    session = null;
    $('[data-account-loading]').textContent = describe(error);
    return;
  }
  renderAccount();
  renderKept();
  if (!session) return;
  const workspace = currentWorkspace(session.user.login);
  input('[data-repo-input]').value = workspace?.repo ?? takeLegacyRepo() ?? DEFAULT_WORKSPACE_REPO;
  await inspect();
}

export function initSettings(): void {
  bindIndex();
  form().addEventListener('submit', (event) => void onSave(event as SubmitEvent));

  let debounce: ReturnType<typeof setTimeout> | null = null;
  input('[data-repo-input]').addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    delete form().dataset.visibilityTouched;
    debounce = setTimeout(() => void inspect(), 600);
  });
  for (const radio of $$<HTMLInputElement>('input[name="visibility"]')) {
    radio.addEventListener('change', () => {
      form().dataset.visibilityTouched = 'true';
      $('[data-public-notice]').hidden = visibility() !== 'public';
    });
  }
  input('[data-dataset-input]').addEventListener('input', (e) => ((e.target as HTMLElement).dataset.touched = 'true'));
  input('[data-cidr-input]').addEventListener('input', (e) => ((e.target as HTMLElement).dataset.touched = 'true'));

  input('[data-keep-hf]').addEventListener('change', (event) => {
    if (!(event.target as HTMLInputElement).checked && credentials.huggingFace()) {
      credentials.setHuggingFace(null);
      renderKept();
      toast('The Hugging Face token was removed from this tab.');
    }
  });

  $('[data-dataset-default]').addEventListener('click', async () => {
    const token = hfTokenForLookup();
    if (!token) {
      setFieldError('dataset', 'Enter the Hugging Face token first to look up your username.');
      return;
    }
    try {
      const me = await new HuggingFaceClient(token).whoami();
      const field = input('[data-dataset-input]');
      field.value = defaultDatasetName(me.name, repoName());
      field.dataset.touched = 'true';
      setFieldError('dataset', null);
    } catch (error) {
      setFieldError('dataset', describe(error));
    }
  });

  $('[data-validate]').addEventListener('click', () => void (status ? runValidation() : inspect()));
  $('[data-delete-dataset]').addEventListener('click', () => void onDeleteDataset());
  $('[data-forget]').addEventListener('click', async () => {
    const workspace = workspaceStore.get();
    if (!workspace) return;
    const ok = await confirmDialog({
      title: 'Forget this workspace?',
      body: `The panel stops tracking ${workspace.owner}/${workspace.repo} in this browser and clears its log. Nothing changes on GitHub or Hugging Face.`,
      confirmLabel: 'Forget workspace',
      tone: 'danger',
    });
    if (!ok) return;
    activityStore.clear(`${workspace.owner}/${workspace.repo}`);
    workspaceStore.clear();
    ($('[data-forget]') as HTMLButtonElement).disabled = true;
    toast('Workspace forgotten on this browser.');
  });

  $('[data-signout]').addEventListener('click', () => {
    signOut();
    toast('Signed out.');
  });

  document.addEventListener('golden:signed-in', () => void boot());
  document.addEventListener('golden:signed-out', () => {
    session = null;
    status = null;
    renderAccount();
    renderKept();
    renderStatus();
  });

  void boot();
}
