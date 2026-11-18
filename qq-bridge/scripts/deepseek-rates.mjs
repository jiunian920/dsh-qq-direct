const holidays = {
  2026: [[1, 1, 3], [2, 15, 23], [4, 4, 6], [5, 1, 5], [6, 19, 21], [9, 25, 27], [10, 1, 7]],
  2027: [[1, 1, 3], [2, 5, 13], [4, 3, 5], [5, 1, 5], [6, 9, 9], [9, 15, 15], [10, 1, 7]],
};
const offPeakRates = {
  'deepseek-flash': [0.02, 1, 4],
  'deepseek-v4-pro': [0.15, 4.5, 13.5],
};

export function tariffAt(timestamp, model) {
  const china = new Date(timestamp + 8 * 60 * 60_000);
  const calendar = holidays[china.getUTCFullYear()];
  const rates = offPeakRates[model];
  if (!calendar || !Array.isArray(rates)) return undefined;
  const weekday = china.getUTCDay();
  const month = china.getUTCMonth() + 1;
  const day = china.getUTCDate();
  const hour = china.getUTCHours();
  const isHoliday = calendar.some(([m, first, last]) => month === m && day >= first && day <= last);
  const peak = weekday >= 1 && weekday <= 5 && !isHoliday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
  return { bucket: peak ? 'peak' : 'offPeak', rates: peak ? rates.map(rate => rate * 2) : rates };
}