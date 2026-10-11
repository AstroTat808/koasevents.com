// Type information for the Node-compatible append-only event implementation.
export interface TurnstileHistoryEvent {
  id: string;
  createdAt: string;
  ok: boolean;
  action: string;
  expectedAction: string;
  hostname: string;
  requestHostname: string;
  codes: string[];
  detail: string;
}
export const TURNSTILE_EVENT_ROOT: string;
export function turnstileEventKey(row: TurnstileHistoryEvent): string;
export function appendTurnstileEvent<T extends TurnstileHistoryEvent>(store: any, row: T): Promise<T>;
export function loadTurnstileEvents(
  store: any,
  days?: number,
  nowMs?: number,
): Promise<{ rows: TurnstileHistoryEvent[]; unreadable: number; truncated: boolean; windowDays: number }>;
export function probeTurnstileEventStore(store: any): Promise<boolean>;
