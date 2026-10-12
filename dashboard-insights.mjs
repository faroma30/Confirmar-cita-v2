export function adminCounts(teams, accounts) {
  return {
    teams: teams.length,
    activeMasters: accounts.filter((item) => item.role === "master" && item.status === "active").length,
    activeTechnicians: accounts.filter((item) => item.role === "technician" && item.status === "active").length,
    disabledTechnicians: accounts.filter((item) => item.role === "technician" && item.status === "disabled").length,
    users: accounts.length,
  };
}

export function filterAdminAccounts(accounts, filters = {}) {
  const text = String(filters.text ?? "").trim().toLocaleLowerCase("es-ES");
  return accounts.filter((item) => {
    if (text && ![item.display_name, item.employee_id_display].some((value) =>
      String(value ?? "").toLocaleLowerCase("es-ES").includes(text))) return false;
    if (filters.role && item.role !== filters.role) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.teamId && !(Array.isArray(item.teams) && item.teams.some((team) =>
      team.team_id === filters.teamId))) return false;
    return true;
  });
}

function emptySummary() {
  return { total: 0, pending: 0, contacted: 0, confirmed: 0, cancelled: 0 };
}

export function masterTeamSummary(rows) {
  const total = emptySummary();
  const technicians = new Map();
  for (const row of rows) {
    const key = String(row.technician_id ?? "");
    if (!key) continue;
    if (!technicians.has(key)) technicians.set(key, {
      technicianId: key, name: String(row.technician ?? ""), ...emptySummary(),
    });
    for (const counts of [total, technicians.get(key)]) {
      counts.total += 1;
      if (row.status === "pending") counts.pending += 1;
      if (row.status === "confirmed") counts.confirmed += 1;
      if (row.status === "cancelled") counts.cancelled += 1;
      // Contacted means WhatsApp was opened; it is independent of the status.
      if (row.contacted_at) counts.contacted += 1;
    }
  }
  return {
    total,
    technicians: [...technicians.values()].sort((a, b) => a.name.localeCompare(b.name, "es")),
  };
}

