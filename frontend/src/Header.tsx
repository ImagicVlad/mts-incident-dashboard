import { lazy, Suspense, useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router-dom';
import { Bell, CircleAlert, Moon, Radio, Search, Sun, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorText, pathFor, type Account } from './api';
import { useLive } from './live';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { NotificationBell } from './NotificationBell';
import { useViews } from './filters/ViewContext';
import { FilterTools } from './filters/FilterTools';
import { matchesSearch } from './filters/incidentViews';

const RelationWindow = lazy(async () => {
  const { RelationWindow } = await import('./filters/RelationWindow');
  return {default: RelationWindow};
});

const generatorKey = ['incident-generator'] as const;
type GeneratorState = {enabled: boolean};

function GeneratorControl() {
  const cache = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api<GeneratorState>('generator', {enabled}),
    onMutate: () => cache.cancelQueries({queryKey: generatorKey}),
    onSuccess: state => cache.setQueryData(generatorKey, state),
    onSettled: () => cache.invalidateQueries({queryKey: generatorKey}),
  });
  const status = useQuery({
    queryKey: generatorKey,
    queryFn: ({signal}) => api<GeneratorState>('generator', undefined, signal),
    refetchOnMount: 'always',
    refetchInterval: toggle.isPending ? false : 5000,
  });
  const enabled = status.data?.enabled ?? false;
  return <>
    <button type="button" className="generator-control" role="switch" aria-checked={enabled}
      aria-labelledby="generator-label" aria-describedby="generator-hint"
      disabled={!status.data || toggle.isPending} onClick={() => toggle.mutate(!enabled)}>
      <span className="generator-copy"><strong id="generator-label">Автогенерация инцидентов</strong>
        <small id="generator-hint">{status.isPending ? 'Проверяем состояние…' : 'По одному каждые 25–60 секунд'}</small></span>
      <span className="generator-switch" aria-hidden="true"/>
    </button>
    {(toggle.isError || status.isError) && <p className="generator-error form-error" role="alert">
      {errorText(toggle.error ?? status.error)}
    </p>}
  </>;
}

export function Header({user}: {user:Account}) {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const themeLabel = dark ? 'Светлая тема' : 'Тёмная тема';
  function toggleTheme() {
    const theme = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    setDark(!dark);
    try { localStorage.setItem('mts.theme', theme); } catch { /* Keep the choice for this page. */ }
  }
  const {snapshot} = useLive();
  const onDashboard = useMatch('/dashboard');
  const view=useViews();
  const [mapRequest, setMapRequest] = useState(0);
  const [detailQuery,setDetailQuery]=useState('');
  const [query,setQuery]=onDashboard ? [view.query,view.setQuery] : [detailQuery,setDetailQuery];
  const [error,setError] = useState('');
  const navigate = useNavigate();
  const term = query.trim().toLocaleLowerCase('ru');
  const found = !term ? [] : onDashboard ? view.result.items : (snapshot?.incidents || []).filter(i=>matchesSearch(i,term));
  return <><header className="topbar dashboard-bar"><div className="bar-inner dashboard-nav">
    <Link className="mts-mark" to="/dashboard" aria-label="МТС — на дашборд">
      <img src="/mts-logo.svg" width="40" height="40" alt=""/><span>МТС</span>
    </Link>
    <div className="header-search-tools">
    <form className="incident-search" role="search" onSubmit={e=>{e.preventDefault(); if(found[0]) {setQuery(''); navigate(pathFor(found[0].id));}}}>
      <Search aria-hidden="true" size={19}/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setQuery('');}}
        aria-label="Поиск инцидентов" type="search" placeholder="Поиск инцидентов…" autoComplete="off"/>
      {term && <div className="search-results">{found.map(i=><Link className="result-link" key={i.id} to={pathFor(i.id)} onClick={()=>setQuery('')}>
        <span className="result-meta">{i.id} · {i.productName || 'Продукт не указан'}</span><strong>{i.header || 'Без заголовка'}</strong></Link>)}
        {!found.length && <p className="empty-result" role="status">Инциденты не найдены</p>}</div>}
    </form>
    {onDashboard && snapshot?.hasSnapshot && <FilterTools onOpenMap={()=>setMapRequest(n=>n+1)}/>}
    </div>
    <div className="dashboard-actions">
      <button type="button" className="theme-trigger" aria-label={themeLabel} title={themeLabel} onClick={toggleTheme}>
        {dark ? <Sun size={19} aria-hidden="true"/> : <Moon size={19} aria-hidden="true"/>}
      </button>
      <NotificationBell key={user.login} login={user.login}/>
      <Popover><PopoverTrigger asChild><button className="account-trigger" aria-label="Аккаунт">{user.displayName.split(/\s+/).map(t=>t[0]).slice(0,2).join('').toUpperCase()}</button></PopoverTrigger>
        <PopoverContent aria-label="Аккаунт" className="account-panel"><h2>{user.displayName}</h2><p>Координатор</p><p className="account-login">{user.login}</p>
          <GeneratorControl/>
          {error && <p role="alert" className="form-error">{error}</p>}
          <button className="logout" onClick={async()=>{try {await api('auth/logout',{}); window.dispatchEvent(new Event('session-expired')); navigate('/login',{replace:true});} catch(e){setError(errorText(e));}}}>Выйти из аккаунта</button>
        </PopoverContent></Popover>
    </div></div></header>
    {mapRequest > 0 && <Suspense fallback={null}>
      <RelationWindow items={view.result.items} openRequest={mapRequest} onClose={()=>setMapRequest(0)}/>
    </Suspense>}
  </>;
}
export function LiveStatus() {
  const {snapshot,link,bootstrapError} = useLive();
  const sourceError = snapshot?.sourceStatus === 'error' || bootstrapError;
  if (!sourceError && link !== 'reconnecting') return null;
  return <div className="container system-status" aria-live="polite">
    {link === 'reconnecting' && <span className="connection"><Radio size={14}/>Восстанавливаем связь…</span>}
    {sourceError && <span className="source-error"><CircleAlert size={15}/>{snapshot?.hasSnapshot ? 'Показан последний корректный снимок.' : 'Данные недоступны.'} {snapshot?.sourceError || 'Ожидаем источник.'}</span>}
  </div>;
}
export function Toasts() {
  const {toasts,dismiss} = useLive();
  const reduced = useReducedMotion();
  return <div className="toasts" aria-live="polite"><AnimatePresence>{toasts.map(n=>
    <motion.div key={n.eventId} initial={{opacity:0,y:reduced?0:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reduced?0:4}} transition={{duration:reduced?0:0.22}} className="toast">
      <Bell size={17}/><Link to={pathFor(n.incidentId)} onClick={()=>dismiss(n.eventId)}><strong>{n.label}</strong><span>{n.incidentId}</span></Link>
      <button aria-label="Закрыть оповещение" onClick={()=>dismiss(n.eventId)}><X size={16}/></button>
    </motion.div>)}</AnimatePresence></div>;
}
