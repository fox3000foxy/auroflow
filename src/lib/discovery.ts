import type { AppSession } from './session';
import type { GhRepo } from './github';
import { workspaceStore } from './storage';
export async function discover(session: AppSession): Promise<GhRepo[]> {
  const repos: GhRepo[] = [];
  for (let page = 1; ; page++) {
    const batch = await session.gh.request<GhRepo[]>(`/user/repos?affiliation=owner&per_page=100&page=${page}`);
    repos.push(...batch.filter(r => !r.archived && !r.is_template && r.owner.login.toLowerCase() === session.user.login.toLowerCase()));
    if (batch.length < 100) break;
  }
  const found: GhRepo[] = [];
  for (let i = 0; i < repos.length; i += 4) {
    await Promise.all(repos.slice(i,i+4).map(async r => {
      const source = await session.gh.workflowSource(r.owner.login,r.name);
      if (source && source.includes('workflow_dispatch') && source.includes('boot-vm.sh') && source.includes('NGROK_AUTHTOKEN') && r.default_branch === 'main') found.push(r);
    }));
  }
  return found.sort((a,b)=>a.name.localeCompare(b.name));
}
export async function discoverInto(session: AppSession, target: HTMLElement): Promise<void> {
  target.textContent = 'Discovering workspaces...';
  try {
    const repos = await discover(session);
    target.replaceChildren();
    if (!repos.length) { target.textContent = 'No compatible workspace found.'; return; }
    for (const repo of repos) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn';
      button.textContent = repo.name + (repo.private ? ' (private)' : ' (public)');
      button.onclick = () => { workspaceStore.set({owner:repo.owner.login,repo:repo.name}); location.reload(); };
      target.append(button);
    }
    const selected = workspaceStore.get();
    if (repos.length === 1 && (!selected || selected.owner.toLowerCase() !== session.user.login.toLowerCase())) {
      workspaceStore.set({owner:repos[0].owner.login,repo:repos[0].name}); location.reload();
    }
  } catch { target.textContent = 'Discovery incomplete. Retry or configure a repository manually.'; }
}
