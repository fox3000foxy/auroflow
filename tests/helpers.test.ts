import { describe, expect, it } from 'vitest';
import { summariseTree, defaultDatasetName } from '../src/lib/huggingface';
import { isValidIpv4Host, networkSupport } from '../src/lib/workspace';
import { decodeBase64 } from '../src/lib/github';
import { bytes, duration } from '../src/lib/format';
import { kindForStatus } from '../src/lib/errors';

describe('summariseTree', () => {
  it('counts layers and sizes from the dataset tree', () => {
    const id = 'a'.repeat(32);
    const id2 = 'b'.repeat(32);
    const usage = summariseTree([
      { type: 'directory', path: 'layers' },
      { type: 'file', path: `layers/${id}/disk.qcow2`, size: 100, lfs: { size: 1000 } },
      { type: 'file', path: `layers/${id}/OVMF_VARS.fd`, size: 50 },
      { type: 'file', path: `layers/${id2}/disk.qcow2`, size: 10, lfs: { size: 2000 } },
      { type: 'file', path: 'latest.json', size: 5 },
    ]);
    expect(usage).toEqual({ layers: 2, bytes: 3055, files: 4 });
  });

  it('builds the engine default dataset name', () => {
    expect(defaultDatasetName('alice', 'auroflow-instance')).toBe('alice/auroflow-instance-layers');
  });
});

describe('workspace helpers', () => {
  it('validates single IPv4 hosts like the workflow does', () => {
    expect(isValidIpv4Host('203.0.113.10/32')).toBe(true);
    expect(isValidIpv4Host('203.0.113.0/24')).toBe(false);
    expect(isValidIpv4Host('256.0.0.1/32')).toBe(false);
    expect(isValidIpv4Host('01.2.3.4/32')).toBe(false);
    expect(isValidIpv4Host('::1/128')).toBe(false);
  });

  it('detects network restriction support from the workflow source', () => {
    expect(networkSupport('ngrok tcp 3390 --cidr-allow "$RDP_ALLOWED_CIDR"')).toBe('enforced');
    expect(networkSupport('test -n "$RDP_ALLOWED_CIDR"\nngrok tcp 3390')).toBe('validated');
    expect(networkSupport('ngrok tcp 3390')).toBe('absent');
    expect(networkSupport(null)).toBe('unknown');
  });
});

describe('misc', () => {
  it('decodes GitHub base64 content with line breaks and UTF-8', () => {
    const encoded = Buffer.from('{"run_id":"1","note":"é"}').toString('base64').replace(/(.{8})/g, '$1\n');
    expect(JSON.parse(decodeBase64(encoded)).note).toBe('é');
  });

  it('formats bytes and durations', () => {
    expect(bytes(5_175_000_000)).toBe('4.82 GiB');
    expect(duration(3_725_000)).toBe('1 h 02 min');
    expect(duration(65_000)).toBe('1 min 05 s');
  });

  it('maps HTTP statuses to error kinds', () => {
    expect(kindForStatus(401)).toBe('auth');
    expect(kindForStatus(403, true)).toBe('rate_limit');
    expect(kindForStatus(403)).toBe('forbidden');
    expect(kindForStatus(404)).toBe('not_found');
    expect(kindForStatus(422)).toBe('validation');
  });
});
