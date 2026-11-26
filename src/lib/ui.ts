/** Small DOM helpers shared by the client scripts. Content is always set with textContent. */

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

export function $$<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

export function setText(selector: string, text: string, root: ParentNode = document): void {
  $(selector, root).textContent = text;
}

export function show(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** Clone an inline SVG icon rendered server-side inside a <template id="icons">. */
export function icon(name: string): SVGElement | null {
  const template = document.getElementById('icon-sprites') as HTMLTemplateElement | null;
  const source = template?.content.querySelector(`[data-icon="${name}"]`);
  return source ? (source.cloneNode(true) as SVGElement) : null;
}

/* ---------------- Toasts ---------------- */

export function toast(message: string, tone: 'info' | 'success' | 'error' = 'info'): void {
  const region = document.getElementById('toasts');
  if (!region) return;
  const node = el('div', { class: `toast toast--${tone}`, text: message, attrs: { role: tone === 'error' ? 'alert' : 'status' } });
  region.append(node);
  requestAnimationFrame(() => node.classList.add('is-visible'));
  setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 250);
  }, tone === 'error' ? 7000 : 3500);
}

/* ---------------- Confirmation dialog ---------------- */

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: 'danger' | 'default';
  /** Text the user must type to enable the confirm button. */
  requireText?: string;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const dialog = document.getElementById('confirm-dialog') as HTMLDialogElement | null;
  if (!dialog) return Promise.resolve(false);
  const title = $('[data-dialog-title]', dialog);
  const body = $('[data-dialog-body]', dialog);
  const field = $('[data-dialog-field]', dialog);
  const input = $('[data-dialog-input]', dialog) as HTMLInputElement;
  const hint = $('[data-dialog-hint]', dialog);
  const confirm = $('[data-dialog-confirm]', dialog) as HTMLButtonElement;
  const cancel = $('[data-dialog-cancel]', dialog) as HTMLButtonElement;

  title.textContent = options.title;
  body.textContent = options.body;
  confirm.textContent = options.confirmLabel;
  confirm.className = options.tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary';
  field.hidden = !options.requireText;
  input.value = '';
  if (options.requireText) {
    hint.textContent = options.requireText;
    confirm.disabled = true;
  } else {
    confirm.disabled = false;
  }

  return new Promise((resolve) => {
    const onInput = () => {
      confirm.disabled = input.value.trim() !== options.requireText;
    };
    const finish = (value: boolean) => {
      input.removeEventListener('input', onInput);
      confirm.removeEventListener('click', onConfirm);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onConfirm = (event: Event) => {
      event.preventDefault();
      if (!confirm.disabled) finish(true);
    };
    const onCancel = (event: Event) => {
      event.preventDefault();
      finish(false);
    };
    const onClose = () => finish(false);
    input.addEventListener('input', onInput);
    confirm.addEventListener('click', onConfirm);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    (options.requireText ? input : cancel).focus();
  });
}

/* ---------------- Clipboard ---------------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { attrs: { readonly: '', 'aria-hidden': 'true' } });
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
