export const LODGING_PREFERENCES = ['three-bedroom', 'two-bedroom', 'both', 'either', 'not-specified'] as const;

export function normalizeLodgingPreference(raw: unknown): string | null {
  const value = String(raw ?? '').trim() || 'not-specified';
  return (LODGING_PREFERENCES as readonly string[]).includes(value) ? value : null;
}

function isRealDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

export function validateStayInquiry(input: unknown): { ok: boolean; error?: string; lodgingPreference?: string } {
  const inquiry = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const lodgingPreference = normalizeLodgingPreference(inquiry.lodgingPreference);
  if (!lodgingPreference) return { ok: false, error: 'Choose a valid lodging option.' };

  const guestCount = Number(inquiry.guestCount);
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 10) {
    return { ok: false, error: 'Overnight guests must be between 1 and 10.' };
  }

  const arrival = String(inquiry.arrival ?? '').trim();
  const departure = String(inquiry.departure ?? '').trim();
  if (!isRealDate(arrival) || !isRealDate(departure) || departure <= arrival) {
    return { ok: false, error: 'A valid departure date after arrival is required.' };
  }
  return { ok: true, lodgingPreference };
}

export function sameStayLodgingChoice(existing: unknown, incoming: unknown) {
  return normalizeLodgingPreference(existing) === normalizeLodgingPreference(incoming);
}
