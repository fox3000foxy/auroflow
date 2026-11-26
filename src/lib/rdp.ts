import { ENDPOINT_RE } from './config';

/**
 * Remote Desktop launch helpers.
 *
 * A .rdp file is the reliable path: mstsc on Windows, Windows App on macOS and
 * Remmina on Linux open it directly. The rdp:// URI is only honoured by the
 * Microsoft clients for macOS, iOS and Android (legacy URI scheme), so it is
 * offered as a shortcut on those platforms only.
 *
 * No credentials are ever written: the reference image has no password set and
 * any password the user configures is typed in the client.
 */

/** Contents of a .rdp file for `host:port`. Lines use CRLF like files saved by mstsc. */
export function rdpFile(endpoint: string): string {
  if (!ENDPOINT_RE.test(endpoint)) throw new Error('Invalid RDP endpoint');
  return [
    `full address:s:${endpoint}`,
    'screen mode id:i:2',
    'use multimon:i:0',
    'redirectclipboard:i:1',
    'audiomode:i:0',
    'prompt for credentials:i:1',
    '',
  ].join('\r\n');
}

/** Legacy Remote Desktop URI (macOS, iOS and Android clients). */
export function rdpUri(endpoint: string): string {
  if (!ENDPOINT_RE.test(endpoint)) throw new Error('Invalid RDP endpoint');
  return `rdp://full%20address=s:${endpoint}`;
}

/** Safe file name derived from the workspace repository. */
export function rdpFileName(repo: string): string {
  const base = repo.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'windows-golden';
  return `${base}.rdp`;
}

/** Whether the platform has a Microsoft client that handles rdp:// links. */
export function supportsRdpUri(userAgent: string, platform = ''): boolean {
  return /Macintosh|Mac OS X|iPhone|iPad|iPod|Android/i.test(userAgent) || /mac|ios|android/i.test(platform);
}

/** Trigger a download of the .rdp file in the browser. */
export function downloadRdpFile(endpoint: string, repo: string): void {
  const blob = new Blob([rdpFile(endpoint)], { type: 'application/x-rdp' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = rdpFileName(repo);
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
