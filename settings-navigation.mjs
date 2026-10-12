/** Keeps settings in a separate screen while retaining the current agenda DOM and state. */
export function createSettingsNavigation({
  getElement, viewIds, settingsId, titleId, window, history, location, document,
  historyStateKey = "ccSettingsKey", triggerId = "settingsToggle",
}) {
  let isOpen = false;
  let historyKey = null;
  let returnState = null;
  let returnFocusId = null;
  let closeFallback = null;

  const setVisible = (id, visible) => getElement(id).classList.toggle("hidden", !visible);
  const clearFallback = () => {
    if (closeFallback !== null) window.clearTimeout(closeFallback);
    closeFallback = null;
  };
  const show = (key, saveReturnState) => {
    if (saveReturnState) {
      returnState = {
        visibility: new Map(viewIds.map((id) => [id, !getElement(id).classList.contains("hidden")])),
        scrollY: window.scrollY,
      };
      returnFocusId = document.activeElement?.id || triggerId;
    }
    for (const id of viewIds) setVisible(id, false);
    setVisible(settingsId, true);
    isOpen = true;
    if (key) historyKey = key;
    window.scrollTo({ top: 0, behavior: "auto" });
    getElement(titleId).focus({ preventScroll: true });
  };
  const restore = () => {
    if (!isOpen) return;
    clearFallback();
    setVisible(settingsId, false);
    for (const id of viewIds) setVisible(id, returnState?.visibility.get(id) ?? false);
    isOpen = false;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: returnState?.scrollY ?? 0, behavior: "auto" });
      const focusTarget = returnFocusId ? getElement(returnFocusId) : null;
      if (focusTarget && !focusTarget.classList.contains("hidden")) focusTarget.focus({ preventScroll: true });
    });
  };
  const onPopState = (event) => {
    const returnedKey = event.state?.[historyStateKey] ?? null;
    if (isOpen && returnedKey !== historyKey) restore();
    else if (!isOpen && historyKey && returnedKey === historyKey && returnState) show(historyKey, false);
  };

  window.addEventListener("popstate", onPopState);

  return {
    open() {
      if (isOpen) return;
      const randomId = window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      historyKey = `settings-${randomId}`;
      show(historyKey, true);
      try {
        const currentState = history.state && typeof history.state === "object" ? history.state : {};
        history.pushState({ ...currentState, [historyStateKey]: historyKey }, "", location.href);
      } catch {
        historyKey = null;
      }
    },
    close() {
      if (!isOpen) return;
      if (historyKey && history.state?.[historyStateKey] === historyKey) {
        closeFallback = window.setTimeout(() => {
          if (isOpen) restore();
        }, 500);
        history.back();
        return;
      }
      restore();
    },
    abandon() {
      clearFallback();
      if (historyKey && history.state?.[historyStateKey] === historyKey) {
        const nextState = { ...history.state };
        delete nextState[historyStateKey];
        history.replaceState(nextState, "", location.href);
      }
      setVisible(settingsId, false);
      isOpen = false;
      historyKey = null;
      returnState = null;
      returnFocusId = null;
    },
    isOpen: () => isOpen,
  };
}
