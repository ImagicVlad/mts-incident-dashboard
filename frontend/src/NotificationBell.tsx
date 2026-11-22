import { useCallback, useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { pathFor } from './api';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { useLive } from './live';

const visibleNoticeCount = 3;

export function NotificationBell({login}: {login: string}) {
  const {snapshot, formats: {stamp}} = useLive();
  const events = snapshot?.notifications ?? [];
  const newest = events[0]?.eventId;
  const key = 'mts.notifications.seen.' + login;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string | null>(() => {
    try { return localStorage.getItem(key); } catch { return null; }
  });

  const sizeFeed = useCallback((list: HTMLDivElement | null) => {
    if (!list || events.length <= visibleNoticeCount) return;
    const firstRows = Array.from(list.children).slice(0, visibleNoticeCount);
    const measure = () => {
      const height = firstRows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
      list.style.maxHeight = `${height}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    firstRows.forEach(row => observer.observe(row));
    return () => {
      observer.disconnect();
      list.style.removeProperty('max-height');
    };
  }, [events]);

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
      {events.length > 0 && <div className="notification-feed" ref={sizeFeed}>
        {events.map(n => <PopoverClose asChild key={n.eventId}><Link className="result-link" to={pathFor(n.incidentId)}>
          <span className="event-line"><strong>{n.label}</strong></span>
          <span className="result-meta">{n.incidentId} · {stamp(n.time)}</span>
        </Link></PopoverClose>)}
      </div>}
    </PopoverContent>
  </Popover>;
}
