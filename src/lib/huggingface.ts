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
  lfs?: { size: number };
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
          Authorization: `Bearer ${this.token}`,
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
