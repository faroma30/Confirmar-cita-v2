export function appendCancellationReason(parent, status, reason, className = "cancellation-reason") {
  if (status !== "cancelled") return false;
  const value = typeof reason === "string" && reason.length > 0
    ? reason
    : "Motivo no disponible";
  const node = document.createElement("p");
  node.className = className;
  node.textContent = `Motivo de cancelación:\n${value}`;
  parent.append(node);
  return true;
}
