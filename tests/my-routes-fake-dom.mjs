import { setTimeout as pause } from "node:timers/promises";
// DOM mínimo para probar Mis rutas sin navegador ni dependencias (no hay jsdom en el repositorio).
export function element(tag = "") {
  return {
    tag, children: [], value: "", hidden: true, disabled: false, textContent: "", events: {}, attributes: {},
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    reset() {}, focus() {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children.length = 0; },
  };
}

export function fakePanel() {
  const elements = new Map();
  const panel = { ownerDocument: { createElement: element }, querySelector(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  } };
  const get = id => panel.querySelector("#myRoutes" + id);
  get("Tab").parentElement = element();
  return { panel, get };
}

/** Texto visible (sin nodos ocultos por `hidden` en contenedores generados) de un árbol. */
export function texts(node) {
  const out = [];
  const walk = item => {
    if (typeof item === "string") { out.push(item); return; }
    if (item.textContent) out.push(item.textContent);
    for (const child of item.children ?? []) walk(child);
  };
  for (const child of node.children) walk(child);
  return out;
}

// Con una pausa real por ronda (la de `node:timers/promises`, que los relojes imitados de las pruebas no tocan):
// las huellas (crypto.subtle) terminan fuera de la cola de `setImmediate` y con carga se quedaban cortas.
export const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await pause(2); };
