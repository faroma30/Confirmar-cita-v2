// CONFIRMAR_CITAS-007: la web publica solo la app. Reproduce la lista de .github/workflows/pages.yml
// sin red (lee el repositorio local con git) y comprueba qué entra y qué no en el artefacto de Pages.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(path.join(repo, ".github/workflows/pages.yml"), "utf8").replace(/\r\n/g, "\n");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
const forbidden = ["supabase/", "tests/", "wifi-connect/tests/", ".github/"];
const notWeb = new Set([".gitattributes"]);
const isForbidden = file => forbidden.some(prefix => file.startsWith(prefix));

function listedItems() {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => /^\s+PAGES_FILES: \|\s*$/.test(line));
  assert.ok(start > 0, "PAGES_FILES en pages.yml");
  const indent = lines[start + 1].match(/^\s*/)[0];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(indent) || !line.trim()) break;
    items.push(line.trim());
  }
  return items;
}

const tracked = git("ls-files");
const items = listedItems();
const expand = files => files.filter(file => items.some(item => file === item || file.startsWith(item + "/")));
const published = new Set(expand(tracked));

test("cada elemento de la lista existe en el repositorio y la lista no repite", () => {
  assert.equal(new Set(items).size, items.length);
  for (const item of items) assert.ok(tracked.some(file => file === item || file.startsWith(item + "/")), "existe: " + item);
});

test("excluye supabase/, tests/, wifi-connect/tests/, .github/ y archivos de git", () => {
  for (const file of published) {
    assert.ok(!isForbidden(file), "no debe publicarse: " + file);
    assert.ok(!notWeb.has(file), "no debe publicarse: " + file);
  }
  for (const item of items) assert.ok(!isForbidden(item + "/") && !isForbidden(item), item);
  // Hay archivos en esas carpetas: la exclusión no es trivial.
  for (const prefix of forbidden) assert.ok(tracked.some(file => file.startsWith(prefix)), "hay archivos en " + prefix);
});

test("incluye todo lo que hoy publica main, salvo supabase/, tests/ y wifi-connect/tests/", () => {
  const main = git("ls-tree", "-r", "--name-only", "main");
  // CONFIRMAR_CITAS-031: retirado a propósito por decisión del Director.
  const retired = new Set(["kpi-access.mjs"]);
  const missing = main.filter(file => !isForbidden(file) && !notWeb.has(file) && !retired.has(file) && !published.has(file));
  assert.deepEqual(missing, []);
});

test("toda la app de esta rama entra en la lista (un archivo web nuevo obliga a añadirlo)", () => {
  const missing = tracked.filter(file => !isForbidden(file) && !notWeb.has(file) && !published.has(file));
  assert.deepEqual(missing, []);
});

test("todo lo que carga index.html, el manifiesto y los módulos publicados está publicado", () => {
  const pending = ["index.html"];
  const seen = new Set();
  const refs = [];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(repo, file), "utf8");
    const found = file.endsWith(".html")
      ? [...source.matchAll(/(?:src|href)="(\.\/[^"?#]+)/g)].map(m => m[1])
      : [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.\.?\/[^"'?#]+)/g)].map(m => m[1]);
    for (const ref of found) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), ref));
      refs.push(target);
      assert.ok(published.has(target), `${file} carga ${target}, que no se publicaría`);
      if (/\.(m?js)$/.test(target) && !target.includes("/vendor/")) pending.push(target);
    }
  }
  const manifest = JSON.parse(readFileSync(path.join(repo, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) assert.ok(published.has(icon.src.replace(/^\/Confirmar-cita-v2\//, "")), icon.src);
  for (const needed of ["app.js", "config.js", "manifest.webmanifest", "my-routes-ui.mjs", "wifi-connect/entry.mjs"]) {
    assert.ok(refs.includes(needed), "se carga " + needed);
  }
});

test("el flujo solo corre con push a main, sin secretos y con las acciones oficiales de Pages", () => {
  const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(on, /^\s+push:\n\s+branches: \[main\]\s*$/m);
  assert.doesNotMatch(on, /pull_request|workflow_dispatch|schedule|tags|branches-ignore|\*/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.equal((workflow.match(/if: github\.ref == 'refs\/heads\/main'/g) ?? []).length, 2);
  const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map(m => m[1]);
  assert.deepEqual(uses, ["actions/checkout@v4", "actions/configure-pages@v5", "actions/upload-pages-artifact@v3", "actions/deploy-pages@v4"]);
  assert.match(workflow, /path: _site/);
});
