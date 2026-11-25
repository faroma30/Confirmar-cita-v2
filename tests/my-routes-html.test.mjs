// Revisión del HTML publicado sin navegador (CONFIRMAR_CITAS-006): estructura de Mis rutas y marca de build.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../" + path, import.meta.url), "utf8");

test("los controles del piloto tienen el motivo junto a «Calcular desplazamientos»", async () => {
  const html = await read("index.html");
  const block = html.slice(html.indexOf('id="myRoutesPilotControls"'), html.indexOf('id="myRoutesList"'));
  const order = ["myRoutesCalculate\"", "myRoutesCalculateReason", "myRoutesPilotStatus", "myRoutesPilotStop", "myRoutesCalculationNotice", "myRoutesPilotNotice"]
    .map(id => block.indexOf('id="' + id.replace('"', "")));
  assert.ok(order.every(index => index > 0), "faltan controles");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "orden de los controles");
  assert.match(block, /id="myRoutesCalculate" class="button primary" aria-describedby="myRoutesCalculateReason"/);
  assert.match(block, /<p id="myRoutesCalculateReason" class="muted" role="status" hidden><\/p>/);
  const css = await read("agenda.css");
  assert.match(css, /#myRoutesCalculateReason\[hidden\],#myRoutesPilotStop\[hidden\]\{display:none\}/);
});

test("la marca de build es la misma en APP_BUILD, la meta, los ?v= y los módulos de rutas", async () => {
  const [html, app, ui] = await Promise.all([read("index.html"), read("app.js"), read("my-routes-ui.mjs")]);
  const build = /const APP_BUILD = "([a-z0-9]+)";/.exec(app)[1];
  assert.equal(build, "3routes12");
  assert.equal(/<meta name="app-build" content="([^"]+)">/.exec(html)[1], build);
  for (const source of [html, app, ui]) {
    // wifi-connect tiene su propia marca (p. ej. 3co2) y no se cambia con el build de la PWA.
    const marks = [...source.matchAll(/(?<!wifi-connect\/entry\.mjs)\?v=([a-z0-9]+)/g)].map(match => match[1]);
    assert.ok(marks.length > 0);
    assert.deepEqual([...new Set(marks)], [build]);
  }
  assert.match(html, /<script type="module" src="\.\/app\.js\?v=3routes12"><\/script>/);
  assert.match(ui, /from "\.\/my-routes-pilot\.mjs\?v=3routes12"/);
  assert.match(app, /confirmAction: message => window\.confirm\(message\)/);
});
