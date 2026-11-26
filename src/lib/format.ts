const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1);
  const amount = value / 1024 ** exponent;
  return `${amount.toFixed(amount >= 100 || exponent === 0 ? 0 : amount >= 10 ? 1 : 2)} ${UNITS[exponent]}`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function ago(iso: string | number, now = Date.now()): string {
  const time = typeof iso === 'number' ? iso : Date.parse(iso);
  const diff = (time - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(diff / 3600), 'hour');
  return relative.format(Math.round(diff / 86400), 'day');
}

export function clock(time: number | string): string {
  return new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(time: number | string): string {
  return new Date(time).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
