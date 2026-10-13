export function createWifiReportNavigation({
  getRoute, setRoute, render, historyRef = globalThis.history,
  locationRef = globalThis.location, onOpen = () => {}, onClose = () => {},
}) {
  let returnRoute = "home";
  let opened = false;
  let pushed = false;

  function restore() {
    if (!opened) return false;
    opened = false;
    pushed = false;
    onClose();
    setRoute(returnRoute);
    void render();
    return true;
  }

  return {
    open() {
      if (opened) return false;
      returnRoute = getRoute() || "home";
      onOpen(returnRoute);
      setRoute("wifi-report");
      try {
        historyRef.pushState({ ...(historyRef.state ?? {}), ccTool: "wifi", ccWifiReport: true }, "", locationRef.href);
        pushed = true;
      } catch {
        pushed = false;
      }
      opened = true;
      void render();
      return true;
    },
    close() {
      if (!opened) return false;
      if (pushed && historyRef.state?.ccWifiReport) {
        historyRef.back();
        return true;
      }
      return restore();
    },
    handlePopState() { return restore(); },
    restore,
    isOpen() { return opened; },
    getReturnRoute() { return returnRoute; },
  };
}
