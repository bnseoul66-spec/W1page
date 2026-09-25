// All attendance dates use Asia/Seoul calendar dates, not the browser timezone.
export function todayKST(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDays(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function difference(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 86400000); }
export function calculateStats(entries, user, today = todayKST()) {
  const valid = entries.filter(e => isDate(e.entry_date) && e.entry_date <= today && e.character_count > 0);
  const dates = new Set(valid.map(e => e.entry_date));
  let cursor = dates.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (dates.has(cursor)) { streak++; cursor = addDays(cursor, -1); }
  let longest = 0, run = 0, previous;
  for (const date of [...dates].sort()) {
    run = previous && difference(date, previous) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run); previous = date;
  }
  const end = addDays(user.challenge_start, user.challenge_days - 1);
  const attended = [...dates].filter(d => d >= user.challenge_start && d <= end).length;
  return { streak, longest, totalDays: dates.size,
    totalCharacters: valid.reduce((n, e) => n + e.character_count, 0),
    challengeDay: Math.max(0, Math.min(user.challenge_days, difference(today, user.challenge_start) + 1)),
    challengeAttendance: attended, challengeEnd: end,
    challengeEnded: today > end,
    todayCharacters: valid.find(e => e.entry_date === today)?.character_count || 0 };
}
