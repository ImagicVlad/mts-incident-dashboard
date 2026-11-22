import { useState } from 'react';
import { Link, useMatch, useNavigate } from 'react-router-dom';
import { Bell, CircleAlert, Radio, Search, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, errorText, pathFor, type Account } from './api';
import { useLive } from './live';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { NotificationBell } from './NotificationBell';
import { useViews } from './filters/ViewContext';
import { FilterTools } from './filters/FilterTools';
import { matchesSearch } from './filters/incidentViews';

export function Header({user}: {user:Account}) {
  const {snapshot} = useLive();
  const onDashboard = useMatch('/dashboard');
  const view=useViews();
  const [detailQuery,setDetailQuery]=useState('');
  const [query,setQuery]=onDashboard ? [view.query,view.setQuery] : [detailQuery,setDetailQuery];
  const [error,setError] = useState('');
  const navigate = useNavigate();
  const term = query.trim().toLocaleLowerCase('ru');
  const found = !term ? [] : onDashboard ? view.result.items : (snapshot?.incidents || []).filter(i=>matchesSearch(i,term));
  return <header className="topbar dashboard-bar"><div className="bar-inner dashboard-nav">
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
    {onDashboard && snapshot?.hasSnapshot && <FilterTools/>}
    </div>
    <div className="dashboard-actions">
      <NotificationBell key={user.login} login={user.login}/>
      <Popover><PopoverTrigger asChild><button className="account-trigger" aria-label="Аккаунт">{user.displayName.split(/\s+/).map(t=>t[0]).slice(0,2).join('').toUpperCase()}</button></PopoverTrigger>
        <PopoverContent aria-label="Аккаунт" className="account-panel"><h2>{user.displayName}</h2><p>{user.role==='coordinator'?'Координатор':'Исполнитель'}</p><p className="account-login">{user.login}</p>
          {error && <p role="alert" className="form-error">{error}</p>}
          <button className="logout" onClick={async()=>{try {await api('auth/logout',{}); window.dispatchEvent(new Event('session-expired')); navigate('/login',{replace:true});} catch(e){setError(errorText(e));}}}>Выйти из аккаунта</button>
        </PopoverContent></Popover>
    </div></div></header>;
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
