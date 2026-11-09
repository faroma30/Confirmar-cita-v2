import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminOcrReportPhotoLoader, updateAdminOcrPhotoStatus } from '../src/admin-ocr-report-photo.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup({ loadPhoto, authorized = ['a', 'b'] } = {}) {
  const selected = { id: '' };
  const image = { value: null };
  const status = { value: '' };
  const calls = [];
  const loader = createAdminOcrReportPhotoLoader({
    loadPhoto: loadPhoto || (async id => ({ id })),
    isCurrent: id => selected.id === id && authorized.includes(id),
    onImage: value => { image.value = value; },
    onStatus: value => { status.value = value; }
  });
  return { selected, image, status, calls, loader };
}

test('selección y Analizar comparten carga; el análisis espera la foto autorizada', async () => {
  const request = deferred();
  const state = setup({ loadPhoto: id => { state.calls.push(id); return request.promise; } });
  state.selected.id = 'a';
  const selectionLoad = state.loader.load('a');
  assert.equal(state.status.value, 'Cargando fotografía autorizada…');
  assert.equal(state.image.value, null);
  const analysisImage = state.loader.waitForSelectedPhoto('a');
  await Promise.resolve();
  assert.deepEqual(state.calls, ['a']);
  let analyzed = false;
  const analysis = analysisImage.then(image => { assert.equal(image.id, 'a'); analyzed = true; });
  await Promise.resolve();
  assert.equal(analyzed, false);
  request.resolve({ id: 'a', marker: 'authorized' });
  await Promise.all([selectionLoad, analysis]);
  assert.equal(analyzed, true);
  assert.equal(state.status.value, '');
});

test('rechaza reportes sin autorización y no solicita sus fotos', async () => {
  const state = setup({ loadPhoto: async id => { state.calls.push(id); return { id }; } });
  state.selected.id = '';
  assert.equal(await state.loader.load('private'), false);
  assert.deepEqual(state.calls, []);
  assert.match(state.status.value, /fotografía autorizada/);
});

test('muestra error de permisos/descarga y no deja imagen previa utilizable', async () => {
  const state = setup({ loadPhoto: async () => { throw Object.assign(new Error('forbidden'), { code: 'PERMISSION_DENIED' }); } });
  state.selected.id = 'a';
  state.loader.setManual({ marker: 'old' });
  state.selected.id = 'a';
  assert.equal(await state.loader.load('a'), false);
  assert.equal(state.image.value, null);
  assert.match(state.status.value, /No se pudo preparar la fotografía autorizada/);
  assert.doesNotMatch(state.status.value, /forbidden|PERMISSION_DENIED/);
});

test('Analizar no inicia hasta resolver la carga pendiente', async () => {
  const request = deferred();
  const state = setup({ loadPhoto: id => { state.calls.push(id); return request.promise; } });
  state.selected.id = 'a';
  const selecting = state.loader.load('a');
  const ready = state.loader.waitForSelectedPhoto('a');
  let analyzedImage = null;
  const analysis = ready.then(image => { analyzedImage = image; });
  await Promise.resolve();
  assert.equal(analyzedImage, null);
  request.resolve({ id: 'a' });
  await Promise.all([selecting, analysis]);
  assert.equal(analyzedImage.id, 'a');
});

test('cambio rápido de reporte descarta la respuesta antigua', async () => {
  const a = deferred(), b = deferred();
  const state = setup({ loadPhoto: id => { state.calls.push(id); return id === 'a' ? a.promise : b.promise; } });
  state.selected.id = 'a';
  const oldLoad = state.loader.load('a');
  state.selected.id = 'b';
  state.loader.invalidate();
  const newLoad = state.loader.load('b');
  b.resolve({ id: 'b' });
  assert.equal(await newLoad, true);
  a.resolve({ id: 'a' });
  assert.equal(await oldLoad, false);
  assert.equal(state.image.value.id, 'b');
  assert.equal(state.status.value, '');
});

test('seleccionar una foto manual invalida la carga antigua y queda disponible', async () => {
  const request = deferred();
  const state = setup({ loadPhoto: () => request.promise });
  state.selected.id = 'a';
  const oldLoad = state.loader.load('a');
  const manual = { marker: 'manual' };
  state.selected.id = '';
  state.loader.setManual(manual);
  request.resolve({ id: 'a', marker: 'stale-report' });
  assert.equal(await oldLoad, false);
  assert.equal(await state.loader.waitForSelectedPhoto(''), manual);
  assert.equal(state.image.value, manual);
});

test('Analizar puede activar la carga aunque no haya terminado el evento change', async () => {
  const state = setup({ loadPhoto: async id => { state.calls.push(id); return { id }; } });
  state.selected.id = 'b';
  const image = await state.loader.waitForSelectedPhoto('b');
  assert.equal(image.id, 'b');
  assert.deepEqual(state.calls, ['b']);
});

console.log('admin-ocr-report-photo: behavior checks passed');

test('el estado visible distingue carga, fotografía preparada y error', async () => {
  const element = { textContent: '' };
  updateAdminOcrPhotoStatus(element, 'Cargando fotografía autorizada…', null);
  assert.equal(element.textContent, 'Cargando fotografía autorizada…');
  updateAdminOcrPhotoStatus(element, '', { marker: 'photo' });
  assert.equal(element.textContent, 'Fotografía preparada en memoria.');
  updateAdminOcrPhotoStatus(element, 'No se pudo preparar la fotografía autorizada.', null);
  assert.equal(element.textContent, 'No se pudo preparar la fotografía autorizada.');
});
