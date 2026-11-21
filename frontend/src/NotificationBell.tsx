import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { pathFor } from './api';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { useLive } from './live';

export function NotificationBell({login}: {login: string}) {
  const {snapshot, formats: {stamp}} = useLive();
  const events = snapshot?.notifications ?? [];
  const newest = events[0]?.eventId;
  const key = 'mts.notifications.seen.' + login;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null>(() => {
    try { return localStorage.getItem(key); } catch { return null; }
  });

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key) setSeen(event.newValue);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [key]);

  useEffect(() => {
    if (!open || !newest) return;
    setSeen(newest);
    try { localStorage.setItem(key, newest); } catch { /* Keep the in-memory marker. */ }
  }, [open, newest, key]);

  const unread = !open && newest !== undefined && newest !== seen;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button className="bell-trigger" aria-label={unread ? 'Оповещения, есть новые' : 'Оповещения'}>
        <Bell size={21}/>{unread && <i/>}
      </button>
    </PopoverTrigger>
    <PopoverContent aria-label="Оповещения" className="notifications-panel">
      <h2>Оповещения</h2>
      {!events.length && <p className="empty-result">Новых оповещений пока нет</p>}
      {events.map(n => <PopoverClose asChild key={n.eventId}><Link className="result-link" to={pathFor(n.incidentId)}>
        <span className="event-line"><strong>{n.label}</strong></span>
        <span className="result-meta">{n.incidentId} · {stamp(n.time)}</span>
      </Link></PopoverClose>)}
    </PopoverContent>
  </Popover>;
}
