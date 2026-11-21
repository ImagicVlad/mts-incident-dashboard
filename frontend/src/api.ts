export type GroupId = 'critical' | 'assigned' | 'high' | 'review' | 'history';
export interface Incident {
  id: string; sysId: string | null; header: string | null; productName: string | null;
  dataOrigin?: string | null;
  priorityId: number | null; priority: string | null; stateEnum: string; state: string | null;
  description: string | null; shortDescription: string | null; assignedGroupName: string | null;
  assignedEmployee: string | null; deadline: string | null; submitDate: string | null;
  completionDate: string | null; solution: string | null; itsmUrl: string | null;
  lastAssignmentToTeamDateTime: string | null;
  service?: string | null; diagnostics: string[];
}
export interface Notice { eventId: string; incidentId: string; kind: string; label: string; time: string }
export interface Snapshot {
  epoch: string; snapshotVersion: number; serverTime: string; loadedAt: string | null;
  dataUpdatedAt: string | null; sourceStatus: 'ok' | 'error'; sourceError: string | null;
  hasSnapshot: boolean; demoMode: boolean; incidents: Incident[];
  groups: Record<GroupId, string[]>; counts: Record<GroupId, number>;
  notifications: Notice[]; diagnostics: string[];
}
export interface Account { login: string; displayName: string }
export interface Answer { answer: string; epoch: string; snapshotVersion: number; asOf: string; stale?: boolean }
export interface ChatAnswer extends Answer {
  incidents?: string[];
  relations?: {ids: string[]; reason: string}[];
  total?: number | null;
  metric?: 'auto' | 'sla' | 'status';
  stats?: Partial<Record<GroupId, number>>;
}
export interface SummaryAnswer extends Answer {
  assessment: {
    situation: string; impact: string; check: string;
    routing: { team: string | null; exampleId: string | null; reason: string } | null;
  };
}
export interface Message { role: 'assistant' | 'user'; content: string }
export const pathFor = (id: string) => '/incidents/' + encodeURIComponent(id);
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/' + url, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && url !== 'auth/login' && url !== 'auth/me') {
      window.dispatchEvent(new Event('session-expired'));
    }
    throw new ApiError(response.status, typeof payload.detail === 'string' ? payload.detail : 'Не удалось выполнить запрос.');
  }
  return response.status === 204 ? undefined as T : response.json();
}
export const errorText = (err: unknown) => err instanceof ApiError ? err.message : 'Нет связи с сервером. Попробуйте ещё раз.';
export function displayFormats(zone='Europe/Moscow') {
  let dateFormat: Intl.DateTimeFormat;
  try {dateFormat=new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:zone});}
  catch {zone='Europe/Moscow'; dateFormat=new Intl.DateTimeFormat('ru-RU',{timeZone:zone});}
  const hours=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:zone});
  const time=(value:string|null) => value && Number.isFinite(Date.parse(value)) ? hours.format(Date.parse(value)) : '—';
  const stamp=(value:string|null) => value && Number.isFinite(Date.parse(value)) ? dateFormat.format(Date.parse(value))+', '+time(value) : '—';
  return {time,stamp,dateFormat,zoneLabel:zone==='Europe/Moscow'?'МСК':zone};
}
export const active = (i: Incident) => i.stateEnum === 'Assigned' || i.stateEnum === 'WorkInProgress';
export const finished = (i: Incident) => i.stateEnum === 'Resolved' || i.stateEnum === 'Closed';
export function overviewStatus(item: Incident, onCoordinators: boolean) {
  switch (item.stateEnum) {
    case 'Assigned':
      if (onCoordinators) return 'Назначен координаторам';
      return item.assignedGroupName ? 'Назначен команде' : 'Назначен · команда не указана';
    case 'WorkInProgress': return onCoordinators ? 'В работе у координаторов' : 'В работе';
    case 'Research': return 'Разбор причин';
    case 'Resolved':
    case 'Closed': return 'Решён';
    default: return item.state || item.stateEnum || 'Статус не указан';
  }
}
export function remaining(deadline: string | null, now: number) {
  if (!deadline || !Number.isFinite(Date.parse(deadline))) return null;
  const delta = Date.parse(deadline) - now;
  const minutes = Math.ceil(Math.abs(delta) / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24, mins = minutes % 60;
  const clock = days ? days + ' дн.' : String(hours).padStart(2, '0') + ':' + String(mins).padStart(2,'0');
  const duration = days ? days + ' дн. ' + hours + ' ч' : (hours ? hours + ' ч ' : '') + mins + ' мин';
  return {clock, text: delta < 0 ? 'Просрочен на ' + duration : 'Осталось ' + duration, overdue: delta < 0};
}
