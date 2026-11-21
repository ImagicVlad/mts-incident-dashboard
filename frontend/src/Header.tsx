import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, Check, CircleAlert, Radio, Search, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, errorText, pathFor, type Account } from './api';
import { useLive } from './live';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from './components/ui/popover';

export function Header({user}: {user:Account}) {
  const {snapshot,formats:{stamp}} = useLive();
  const [query,setQuery] = useState('');
  const [error,setError] = useState('');
  const navigate = useNavigate();
  const term = query.trim().toLocaleLowerCase('ru');
  const found = term ? (snapshot?.incidents || []).filter(i =>
    [i.header,i.productName,i.id,i.assignedGroupName,i.assignedEmployee,i.sysId].some(s=>s?.toLowerCase().includes(term))) : [];
  const events = snapshot?.notifications ?? [];
  return <header className="topbar dashboard-bar"><div className="bar-inner dashboard-nav">
    <Link className="mts-mark" to="/dashboard" aria-label="МТС — на дашборд"><img src="/mts-logo.svg" width="40" height="40" alt="МТС"/></Link>
    <form className="incident-search" role="search" onSubmit={e=>{e.preventDefault(); if(found[0]) {setQuery(''); navigate(pathFor(found[0].id));}}}>
      <Search aria-hidden="true" size={19}/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setQuery('');}}
        aria-label="Поиск инцидентов" type="search" placeholder="поиск инцидентов..." autoComplete="off"/>
      {term && <div className="search-results">{found.map(i=><Link className="result-link" key={i.id} to={pathFor(i.id)} onClick={()=>setQuery('')}>
        <span className="result-meta">{i.id} · {i.productName || 'Продукт не указан'}</span><strong>{i.header || 'Без заголовка'}</strong></Link>)}
        {!found.length && <p className="empty-result" role="status">Инциденты не найдены</p>}</div>}
    </form>
    <div className="dashboard-actions">
      <Popover><PopoverTrigger asChild><button className="bell-trigger" aria-label={'Оповещения (' + events.length + ')'}><Bell size={21}/>{events.length>0 && <i/>}</button></PopoverTrigger>
        <PopoverContent aria-label="Оповещения" className="notifications-panel"><h2>Оповещения</h2>
          {!events.length && <p className="empty-result">Новых оповещений пока нет</p>}
          {events.map(n=><PopoverClose asChild key={n.eventId}><Link className="result-link" to={pathFor(n.incidentId)}>
            <span className="event-line"><strong>{n.label}</strong></span><span className="result-meta">{n.incidentId} · {stamp(n.time)}</span></Link></PopoverClose>)}
        </PopoverContent></Popover>
      <Popover><PopoverTrigger asChild><button className="account-trigger" aria-label="Аккаунт">{user.displayName.split(/\s+/).map(t=>t[0]).slice(0,2).join('').toUpperCase()}</button></PopoverTrigger>
        <PopoverContent aria-label="Аккаунт" className="account-panel"><h2>{user.displayName}</h2><p>Координатор массовых инцидентов</p><p className="account-login">{user.login}</p>
          {error && <p role="alert" className="form-error">{error}</p>}
          <button className="logout" onClick={async()=>{try {await api('auth/logout',{}); window.dispatchEvent(new Event('session-expired')); navigate('/login',{replace:true});} catch(e){setError(errorText(e));}}}>Выйти из аккаунта</button>
        </PopoverContent></Popover>
    </div></div></header>;
}
export function LiveStatus() {
  const {snapshot,link,bootstrapError} = useLive();
  return <div className="container system-status" aria-live="polite">
    <span className={link==='online' ? 'connection online' : 'connection'}><Radio size={14}/>{link==='online'?'На связи':link==='connecting'?'Подключение…':'Восстанавливаем связь…'}</span>
    {snapshot?.sourceStatus==='ok' && <span className="source-ok"><Check size={14}/> {snapshot.demoMode ? 'Демонстрационные данные' : 'Файл загружен'}</span>}
    {(snapshot?.sourceStatus==='error' || bootstrapError) && <span className="source-error"><CircleAlert size={15}/>{snapshot?.hasSnapshot ? 'Показан последний корректный снимок.' : 'Данные недоступны.'} {snapshot?.sourceError || 'Ожидаем источник.'}</span>}
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
