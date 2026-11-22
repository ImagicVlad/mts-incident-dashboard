import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, displayFormats, type Account, type Notice, type Snapshot } from './api';

type LinkState = 'connecting' | 'online' | 'reconnecting';
interface Live {
  snapshot?: Snapshot; link: LinkState; now: number; bootstrapError: boolean;
  applyAssignment: (snapshot: Snapshot) => void;
  toasts: Notice[]; dismiss: (id: string) => void; newCards: Set<string>;
  formats: ReturnType<typeof displayFormats>; aiConfigured?: boolean;
}
const Context = createContext<Live | null>(null);
export function useLive() {
  const value = useContext(Context);
  if (!value) throw Error('Missing live data provider');
  return value;
}
export function LiveProvider({children}: {children: ReactNode}) {
  const client = useQueryClient();
  const {data: snapshot} = useQuery<Snapshot>({queryKey:['live'], enabled:false});
  const {data:settings} = useQuery({queryKey:['health'],queryFn:()=>api<{displayTimezone:string;aiConfigured:boolean}>('health'),staleTime:60_000});
  const formats = useMemo(()=>displayFormats(settings?.displayTimezone),[settings?.displayTimezone]);
  const [link,setLink] = useState<LinkState>('connecting');
  const [bootstrapError,setBootstrapError] = useState(false);
  const [toasts,setToasts] = useState<Notice[]>([]);
  const [newCards,setNewCards] = useState<Set<string>>(new Set());
  const clock = useRef({server:Date.now(), sample:performance.now()});
  const [now,setNow] = useState(Date.now);
  const assignmentUpdate = useRef<(snapshot: Snapshot) => void>(()=>{});

  useEffect(() => {
    let closed = false, receivedStream = false, baseline = true;
    let previous: Snapshot | undefined;
    const timers = new Set<number>();
    const after = (ms: number, fn: () => void) => {
      const timer = window.setTimeout(() => {timers.delete(timer); fn();}, ms);
      timers.add(timer);
    };
    const accept = (data: Snapshot, source: 'initial' | 'stream' | 'assignment') => {
      if (closed || (source==='initial' && receivedStream)) return;
      if (source==='assignment' && previous && previous.epoch!==data.epoch) return;
      if (previous?.epoch === data.epoch && data.snapshotVersion < previous.snapshotVersion) return;
      const sameRun = previous?.epoch === data.epoch;
      if (source!=='initial' && previous && sameRun && !baseline) {
        const oldIds = new Set(previous.notifications.map(n => n.eventId));
        const added = data.notifications.filter(n =>
          !oldIds.has(n.eventId) && n.kind !== 'research' && n.kind !== 'resolved');
        if (added.length) {
          setToasts(old => [...added, ...old].slice(0,3));
          const ids = new Set(added.map(n => n.eventId));
          after(6500, () => setToasts(old => old.filter(n => !ids.has(n.eventId))));
        }
        const addedCards = Object.entries(data.groups).flatMap(([key, ids]) => {
          const old = new Set(previous!.groups[key as keyof Snapshot['groups']]);
          return ids.filter(id => !old.has(id)).map(id => key + '/' + id);
        });
        if (addedCards.length) {
          setNewCards(old => new Set([...old, ...addedCards]));
          after(350, () => setNewCards(old => {const next = new Set(old); addedCards.forEach(key => next.delete(key)); return next;}));
        }
      } else if (!sameRun) {
        setToasts([]); setNewCards(new Set());
      }
      if (source==='stream') { receivedStream = true; baseline = false; setLink('online'); }
      clock.current = {server:Date.parse(data.serverTime), sample:performance.now()};
      setNow(clock.current.server);
      setBootstrapError(false);
      previous = data;
      client.setQueryData(['live'], data);
    };
    const controller = new AbortController();
    assignmentUpdate.current = data => accept(data, 'assignment');
    api<Snapshot>('incidents', undefined, controller.signal).then(data => accept(data, 'initial')).catch(() => {
      if (!closed && !receivedStream) setBootstrapError(true);
    });
    const stream = new EventSource('/api/incidents/events');
    stream.addEventListener('snapshot', (e: MessageEvent<string>) => accept(JSON.parse(e.data), 'stream'));
    stream.onerror = () => {
      if (closed) return;
      baseline = true; setLink('reconnecting');
      api<Account>('auth/me', undefined, controller.signal).catch(error => {
        if (!closed && error instanceof ApiError && error.status === 401) window.dispatchEvent(new Event('session-expired'));
      });
    };
    const ticker = window.setInterval(() => setNow(clock.current.server + performance.now() - clock.current.sample),1000);
    return () => {
      closed = true; stream.close(); controller.abort(); clearInterval(ticker); timers.forEach(clearTimeout);
    };
  }, [client]);
  return <Context.Provider value={{snapshot,link,now,bootstrapError,toasts,newCards,formats,applyAssignment:data=>assignmentUpdate.current(data),aiConfigured:settings?.aiConfigured,
    dismiss:id => setToasts(old => old.filter(n => n.eventId !== id))}}>{children}</Context.Provider>;
}
