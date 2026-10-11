/** Capture a form synchronously while Event.currentTarget is still available. */
export function captureSubmittedForm(event) {
  const form = event?.currentTarget;
  if (!form || typeof form.reset !== "function") {
    throw new TypeError("A submitted form is required");
  }
  return form;
}
