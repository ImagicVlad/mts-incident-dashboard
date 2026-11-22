import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { pathFor } from './api';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { useLive } from './live';
import { NoticeContent } from './NoticeContent';

const visibleNoticeCount = 3;

export function NotificationBell({login}: {login: string}) {
  const {snapshot, formats, now} = useLive();
  const titles = useMemo(() => new Map(snapshot?.incidents.map(i => [i.id, i.header])), [snapshot?.incidents]);
  const today = formats.dateFormat.format(now);
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
        {events.map(n => <PopoverClose asChild key={n.eventId}><Link className="result-link" data-kind={n.kind} to={pathFor(n.incidentId)}>
          <NoticeContent event={n} title={titles.get(n.incidentId)} today={today} formats={formats}/>
        </Link></PopoverClose>)}
      </div>}
    </PopoverContent>
  </Popover>;
}
