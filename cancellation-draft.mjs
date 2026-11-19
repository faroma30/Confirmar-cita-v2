const slot = "cc-cancellation-draft";
const encoder = new TextEncoder();

function draftKey() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("cc-workspace", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = async () => {
      const db = open.result;
      try {
        const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const transaction = db.transaction("keys", "readwrite");
        const store = transaction.objectStore("keys");
        const read = store.get(slot);
        read.onsuccess = () => { if (!read.result) store.put(candidate, slot); };
        transaction.oncomplete = () => { db.close(); resolve(read.result ?? candidate); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      } catch (error) { db.close(); reject(error); }
    };
  });
}

let revision = 0;
let key;
export async function saveCancellationDraft(owner, draft) {
  const version = ++revision;
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(owner) },
      await (key ??= draftKey()), encoder.encode(JSON.stringify(draft)));
    if (version === revision) sessionStorage.setItem(slot, JSON.stringify([[...nonce], [...new Uint8Array(ciphertext)]]));
  } catch { /* The dialog still retains the draft in memory. */ }
}

export async function readCancellationDraft(owner) {
  try {
    const saved = sessionStorage.getItem(slot);
    if (!saved) return null;
    const [nonce, ciphertext] = JSON.parse(saved);
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(nonce), additionalData: encoder.encode(owner) },
      await (key ??= draftKey()), Uint8Array.from(ciphertext));
    const draft = JSON.parse(new TextDecoder().decode(data));
    return typeof draft.id === "string" && typeof draft.reason === "string" && draft.reason.length <= 2000 ? draft : null;
  } catch { return null; }
}

export function clearCancellationDraft() {
  revision++;
  try { sessionStorage.removeItem(slot); } catch { /* Storage is optional. */ }
}
