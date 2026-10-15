const KPI_ORIGIN = "https://polite-malasada-c03d92.netlify.app";

function validDashboardUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === KPI_ORIGIN
      && url.pathname === "/"
      && url.search === ""
      && /^#[A-Za-z0-9_-]{16,128}$/.test(url.hash)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function checkKpiAvailability(supabase) {
  if (!supabase?.functions?.invoke) return false;
  const { data, error } = await supabase.functions.invoke("kpi-dashboard-access", {
    body: { action: "availability" },
  });
  return !error && data?.available === true;
}

export async function resolveKpiDashboardUrl(supabase) {
  if (!supabase?.functions?.invoke) return null;
  const { data, error } = await supabase.functions.invoke("kpi-dashboard-access", {
    body: { action: "open" },
  });
  return !error && validDashboardUrl(data?.url) ? data.url : null;
}

export { validDashboardUrl };
