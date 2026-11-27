import { ApiError, kindForStatus } from './errors';

const HF = 'https://huggingface.co';

export interface HfDataset {
  id: string;
  private: boolean;
  lastModified?: string;
  sha?: string;
}

export interface HfTreeEntry {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  lfs?: { size: number; oid?: string };
}

export interface DatasetUsage {
  layers: number;
  bytes: number;
  files: number;
}

export class HuggingFaceClient {
  constructor(private readonly token: string) {}

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(HF + path, {
        method: init.method ?? 'GET',
        cache: 'no-store',
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiError('Hugging Face', 'network', 'Network request failed');
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = ((await response.json()) as { error?: string }).error ?? '';
      } catch {
        /* not JSON */
      }
      throw new ApiError('Hugging Face', kindForStatus(response.status), `${init.method ?? 'GET'} ${path.split('?')[0]} returned ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  private async goldenEntry(value: string): Promise<HfTreeEntry | undefined> {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);

    if (
      url.origin !== 'https://huggingface.co' ||
      url.username || url.password ||
      url.search || url.hash ||
      parts.length < 6 ||
      parts[0] !== 'datasets' ||
      !['blob', 'resolve'].includes(parts[3])
    ) {
      throw new Error('Invalid Hugging Face dataset URL.');
    }

    const [owner, repo, revision] = [parts[1], parts[2], parts[4]];
    const filename = parts.slice(5).map(decodeURIComponent).join('/');

    if (!filename.toLowerCase().endsWith('.qcow2')) {
      throw new Error('Expected a QCOW2 image.');
    }

    const directory = parts.slice(5, -1).join('/');
    const entries = await this.request<HfTreeEntry[]>(
      `/api/datasets/${owner}/${repo}/tree/${revision}${directory ? '/' + directory : ''}`
    );

    const entry = entries.find(
      (item) => item.type === 'file' && item.path === filename
    );

    return entry;
  }

  async goldenSize(value: string): Promise<number | null> {
    const entry = await this.goldenEntry(value);
    return entry?.lfs?.size ?? entry?.size ?? null;
  }

  async goldenChecksum(value: string): Promise<string> {
    const entry = await this.goldenEntry(value);
    const hash = entry?.lfs?.oid;

    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error('SHA-256 checksum unavailable. Enter it manually.');
    }

    return hash.toLowerCase();
  }

  whoami(): Promise<{ name: string; type: string; auth?: { accessToken?: { role?: string } } }> {
    return this.request('/api/whoami-v2');
  }

  dataset(id: string): Promise<HfDataset> {
    return this.request<HfDataset>(`/api/datasets/${id}`);
  }

  async datasetOrNull(id: string): Promise<HfDataset | null> {
    try {
      return await this.dataset(id);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'not_found') return null;
      throw error;
    }
  }

  async usage(id: string): Promise<DatasetUsage> {
    const entries = await this.request<HfTreeEntry[]>(`/api/datasets/${id}/tree/main?recursive=true`);
    return summariseTree(entries);
  }

  /** Same call as huggingface_hub.HfApi.delete_repo. */
  async deleteDataset(id: string): Promise<void> {
    const [organization, name] = id.split('/');
    await this.request('/api/repos/delete', { method: 'DELETE', body: { type: 'dataset', name, organization } });
  }
}

/** Layers are stored as layers/<uuid>/disk.qcow2 by scripts/persistence.py. */
export function summariseTree(entries: HfTreeEntry[]): DatasetUsage {
  const layers = new Set<string>();
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    files += 1;
    bytes += entry.lfs?.size ?? entry.size ?? 0;
    const match = /^layers\/([0-9a-f]{32})\/disk\.qcow2$/.exec(entry.path);
    if (match) layers.add(match[1]);
  }
  return { layers: layers.size, bytes, files };
}

/** Default dataset name used by scripts/init-persistence.py when HF_REPO is unset. */
export const defaultDatasetName = (hfUser: string, githubRepo: string) => `${hfUser}/${githubRepo}-layers`;
