import assert from "node:assert/strict";
import test from "node:test";
import { createAdminWifiOcrSource } from "../../admin-wifi-ocr-source.mjs";
import { adminOcrPhotoErrorMessage, createAdminOcrReportPhotoLoader } from "../src/admin-ocr-report-photo.mjs";

const id = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const admin = { role: "admin", status: "active", must_change_password: false };
const detail = { category: "wifi_ocr", metadata: { photo_shared: true }, has_attachment: true };
const payload = Uint8Array.from({ length: 256 }, (_, i) => (i * 37) % 256);
const base64 = Buffer.from(payload).toString("base64");
const wrapped = base64.match(/.{1,76}/g).join("\n");
function sourceFor({ profile = admin, detailData = detail, attachmentData = { mime: "image/png", base64: wrapped }, detailError, attachmentError, thrown } = {}) {
  const calls = [];
  const rpc = async (name, args) => {
    calls.push([name, args]);
    if (name === "cc_issue_report_detail") {
      if (thrown) throw thrown;
      return { data: detailData, error: detailError || null };
    }
    if (name === "cc_issue_attachment") return { data: attachmentData, error: attachmentError || null };
    if (name === "cc_admin_wifi_ocr_reports") return { data: { items: [{ id, created_at: "2026-01-01T00:00:00Z", worker: "synthetic", status: "pending" }] }, error: null };
    throw new Error("unexpected synthetic RPC");
  };
  return { source: createAdminWifiOcrSource({ rpc, getProfile: () => profile }), calls };
}

test("descarga base64 PostgreSQL con saltos de línea, conserva bytes y llega al analizador", async () => {
  const { source, calls } = sourceFor();
  const photo = await source.loadPhoto(id);
  assert.ok(photo instanceof Blob);
  assert.equal(photo.type, "image/png");
  assert.equal(photo.size, payload.length);
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), payload);
  assert.deepEqual(calls.map(call => call[0]), ["cc_issue_report_detail", "cc_issue_attachment"]);

  let selected = id;
  let analyzed = null;
  const loader = createAdminOcrReportPhotoLoader({
    loadPhoto: source.loadPhoto,
    isCurrent: reportId => reportId === selected,
    onImage: () => {},
    onStatus: () => {}
  });
  const imageToAnalyze = await loader.waitForSelectedPhoto(id);
  async function syntheticAnalyzer(image) { analyzed = image; return new Uint8Array(await image.arrayBuffer()); }
  const analyzedBytes = await syntheticAnalyzer(imageToAnalyze);
  assert.equal(analyzed, photo === imageToAnalyze ? photo : imageToAnalyze);
  assert.deepEqual(analyzedBytes, payload);
});

test("no enumera ni carga fotos cuando el consentimiento no es explícito", async () => {
  const { source } = sourceFor({ detailData: { ...detail, metadata: { photo_shared: false } } });
  assert.deepEqual(await source.list(), []);
  await assert.rejects(source.loadPhoto(id), error => error.code === "CONSENT_INVALID");
});

test("clasifica foto inexistente", async () => {
  const { source } = sourceFor({ detailData: { ...detail, has_attachment: false } });
  await assert.rejects(source.loadPhoto(id), error => error.code === "PHOTO_NOT_FOUND");
});

test("rechaza cuenta sin permiso Admin activo antes de llamar RPC", async () => {
  const { source, calls } = sourceFor({ profile: { role: "master", status: "active" } });
  await assert.rejects(source.loadPhoto(id), error => error.code === "ACCESS_DENIED");
  assert.equal(calls.length, 0);
});

test("clasifica acceso denegado sin filtrar el mensaje del servidor", async () => {
  const { source } = sourceFor({ attachmentError: { code: "42501", message: "private policy details" } });
  await assert.rejects(source.loadPhoto(id), error => error.code === "ACCESS_DENIED" && !error.message.includes("private"));
});

test("clasifica error de red y no revela la excepción", async () => {
  const { source } = sourceFor({ thrown: new TypeError("secret host and credentials") });
  await assert.rejects(source.loadPhoto(id), error => error.code === "NETWORK_ERROR" && !error.message.includes("secret"));
});

test("clasifica respuesta vacía del servidor", async () => {
  const { source } = sourceFor({ attachmentData: null });
  await assert.rejects(source.loadPhoto(id), error => error.code === "RESPONSE_EMPTY");
});

test("clasifica formato MIME o base64 incompatible", async t => {
  await t.test("MIME", async () => {
    const { source } = sourceFor({ attachmentData: { mime: "application/pdf", base64 } });
    await assert.rejects(source.loadPhoto(id), error => error.code === "FORMAT_UNSUPPORTED");
  });
  await t.test("Base64 corrupto", async () => {
    const { source } = sourceFor({ attachmentData: { mime: "image/png", base64: "not base64" } });
    await assert.rejects(source.loadPhoto(id), error => error.code === "FORMAT_UNSUPPORTED");
  });
});

test("distingue fotografía demasiado grande", async () => {
  const oversized = "A".repeat(6_990_509);
  const { source } = sourceFor({ attachmentData: { mime: "image/png", base64: oversized } });
  await assert.rejects(source.loadPhoto(id), error => error.code === "PHOTO_TOO_LARGE");
});

test("clasifica error de conversión", async () => {
  const originalAtob = globalThis.atob;
  globalThis.atob = () => { throw new Error("private conversion detail"); };
  try {
    const { source } = sourceFor();
    await assert.rejects(source.loadPhoto(id), error => error.code === "CONVERSION_FAILED" && error.message === "CONVERSION_FAILED");
  } finally {
    globalThis.atob = originalAtob;
  }
});

test("tras fallo permite reintentar sin recargar la app y no expone detalles privados", async () => {
  let attempt = 0;
  const rpc = async name => {
    if (name === "cc_issue_report_detail") return { data: detail, error: null };
    attempt++;
    return attempt === 1
      ? { data: null, error: { code: "42501", message: "secret policy text" } }
      : { data: { mime: "image/png", base64: wrapped }, error: null };
  };
  const source = createAdminWifiOcrSource({ rpc, getProfile: () => admin });
  let image = null, status = "";
  const loader = createAdminOcrReportPhotoLoader({
    loadPhoto: source.loadPhoto,
    isCurrent: reportId => reportId === id,
    onImage: value => { image = value; },
    onStatus: value => { status = value; }
  });
  assert.equal(await loader.load(id), false);
  assert.match(status, /denegó el acceso/);
  assert.doesNotMatch(status, /secret|42501/);
  assert.equal(await loader.load(id), true);
  assert.ok(image instanceof Blob);
  assert.equal(status, "");
});

test("los mensajes de diagnóstico son sanitizados y estables", () => {
  assert.match(adminOcrPhotoErrorMessage({ code: "NETWORK_ERROR", message: "private URL" }), /Comprueba la conexión/);
  assert.doesNotMatch(adminOcrPhotoErrorMessage({ message: "private URL" }), /private URL/);
});
