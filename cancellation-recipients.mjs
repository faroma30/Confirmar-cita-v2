const MAILBOX = /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const CANCELLATION_RECIPIENT_LIMITS = { to: 320, cc: 1000 };

function splitRecipients(value) {
  return String(value ?? '').split(/[,;\s]+/).filter(Boolean);
}

function validMailbox(address) {
  return address.length <= 254 && address.indexOf('@') <= 64 && MAILBOX.test(address);
}

export function normalizeCancellationRecipients(value, maxLength) {
  const addresses = new Map();
  for (const address of splitRecipients(value)) {
    if (!validMailbox(address)) return { valid: false, value: '' };
    const key = address.toLowerCase();
    if (!addresses.has(key)) addresses.set(key, address);
  }
  const serialized = [...addresses.values()].join(',');
  return { valid: serialized.length <= maxLength, value: serialized };
}

function encodeMailboxes(value) {
  return splitRecipients(value).map((address) => {
    const at = address.indexOf('@');
    return `${encodeURIComponent(address.slice(0, at))}${address.slice(at)}`;
  }).join(',');
}

export function buildCancellationMailto({ to, cc, subject, body }) {
  const recipients = normalizeCancellationRecipients(to, CANCELLATION_RECIPIENT_LIMITS.to);
  const copies = normalizeCancellationRecipients(cc, CANCELLATION_RECIPIENT_LIMITS.cc);
  if (!recipients.valid || !recipients.value || !copies.valid) return '';
  const safeSubject = String(subject ?? '').replace(/[\r\n]+/g, ' ');
  const ccHeader = copies.value ? `cc=${encodeMailboxes(copies.value)}&` : '';
  return `mailto:${encodeMailboxes(recipients.value)}?${ccHeader}subject=${encodeURIComponent(safeSubject)}&body=${encodeURIComponent(body ?? '')}`;
}

export function createCancellationRecipientEditor(container, addButton, { label, maxLength }) {
  function refreshLabels() {
    [...container.children].forEach((row, index) => {
      const [input, remove] = row.children;
      input.setAttribute('aria-label', `${label}, correo ${index + 1}`);
      remove.setAttribute('aria-label', `Eliminar correo ${index + 1} de ${label}`);
    });
  }

  function addRow(value = '') {
    const row = container.ownerDocument.createElement('div');
    row.className = 'cancellation-recipient-row';
    const input = container.ownerDocument.createElement('input');
    input.type = 'email';
    input.maxLength = 254;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = value;
    const remove = container.ownerDocument.createElement('button');
    remove.type = 'button';
    remove.className = 'button secondary';
    remove.textContent = 'Eliminar';
    remove.addEventListener('click', () => {
      const nextFocus = row.nextElementSibling?.firstElementChild
        ?? row.previousElementSibling?.firstElementChild ?? addButton;
      row.remove();
      refreshLabels();
      nextFocus.focus();
    });
    row.append(input, remove);
    container.append(row);
    return input;
  }

  addButton.addEventListener('click', () => {
    const input = addRow();
    refreshLabels();
    input.focus();
  });

  return {
    setValue(value) {
      container.replaceChildren();
      for (const address of splitRecipients(value)) addRow(address);
      refreshLabels();
    },
    read() {
      const value = [...container.children].map((row) => row.firstElementChild.value).join(',');
      return normalizeCancellationRecipients(value, maxLength);
    },
  };
}
