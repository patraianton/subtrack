export function formatCountdown(resetsAtIso, nowMs) {
  if (!resetsAtIso) return '—'; // reset time not yet known (API sent null — freshly-reset window)
  const t = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = t - nowMs;
  if (diff <= 0) return 'now';
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  if (hours < 24) return `${hours}h${String(totalMin % 60).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}
