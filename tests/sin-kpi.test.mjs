// CONFIRMAR_CITAS-031: KPI retirado por decisión del Director. Falla si «kpi» reaparece en la web publicada.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repo = fileURLToPath(new URL("../", import.meta.url));
const read = file => readFileSync(path.join(repo, file), "utf8");
// Web = todo lo que no es servidor, pruebas ni flujo (con archivos nuevos aún sin seguimiento).
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" })
  .split("\n").filter(file => file && existsSync(path.join(repo, file))
    && !/^(supabase|tests|wifi-connect\/tests)\//.test(file));

test("no queda «kpi» en ningún archivo ni nombre de la web (incluida la lista de publicación)", () => {
  assert.ok(files.includes("app.js") && files.includes("index.html") && files.includes(".github/workflows/pages.yml"));
  for (const file of files) {
    assert.doesNotMatch(file, /kpi/i, file);
    if (!/\.(m?js|cjs|html|css|json|webmanifest|ya?ml|md|txt)$/i.test(file)) continue;
    // El código de terceros comprimido puede contener esas letras por casualidad: se busca la palabra.
    assert.doesNotMatch(read(file), file.includes("/vendor/") ? /\bkpi\b/i : /kpi/i, file);
  }
});

test("la barra de herramientas conserva sus dos pestañas, iguales, en dos columnas", () => {
  const html = read("index.html").replace(/\r\n/g, "\n");
  const nav = html.slice(html.indexOf('<nav id="toolCategories"'), html.indexOf('<section id="wifiConnectPanel"'));
  assert.deepEqual([...nav.matchAll(/<button id="(\w+)"[^>]*>([^<]+)<\/button>/g)].map(m => [m[1], m[2]]),
    [["confirmarToolTab", "Confirmar Citas"], ["wifiToolTab", "Wifi Connect"]]);
  assert.match(read("tool-categories.css"), /\.tool-categories \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(read("app.js"), /setVisible\("toolCategories", allowed && !overlay\);/);
  for (const id of ["myRoutesTab", "myRoutesAgendaTab", "wifiConnectPanel"]) assert.ok(html.includes(`id="${id}"`), id);
});
