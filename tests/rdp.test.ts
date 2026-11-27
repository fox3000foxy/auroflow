import { describe, expect, it } from 'vitest';
import { rdpFile, rdpFileName, rdpUri, supportsRdpUri } from '../src/lib/rdp';

describe('rdp helpers', () => {
  it('writes a .rdp file with the endpoint and no credentials', () => {
    const file = rdpFile('4.tcp.eu.ngrok.io:17342');
    expect(file.split('\r\n')[0]).toBe('full address:s:4.tcp.eu.ngrok.io:17342');
    expect(file).not.toMatch(/password/i);
    expect(file.endsWith('\r\n')).toBe(true);
  });

  it('builds the legacy Microsoft URI', () => {
    expect(rdpUri('0.tcp.ngrok.io:12345')).toBe('rdp://full%20address=s:0.tcp.ngrok.io:12345');
  });

  it('refuses anything that is not host:port', () => {
    expect(() => rdpFile('evil\r\nalternate shell:s:cmd.exe')).toThrow();
    expect(() => rdpUri('javascript:alert(1)')).toThrow();
  });

  it('derives a safe file name', () => {
    expect(rdpFileName('auroflow-instance')).toBe('auroflow-instance.rdp');
    expect(rdpFileName('../x y')).toBe('x-y.rdp');
  });

  it('offers rdp:// only where Microsoft clients handle it', () => {
    expect(supportsRdpUri('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(true);
    expect(supportsRdpUri('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(supportsRdpUri('Mozilla/5.0 (Linux; Android 15)')).toBe(true);
    expect(supportsRdpUri('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(supportsRdpUri('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });
});
