import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { active, finished, pathFor, remaining, type GroupId, type Incident } from './api';
import { useLive } from './live';
import type { ConsoleOutlet } from './Console';
import { DeadlineFocus } from './DeadlineFocus';
import { ActiveFilters } from './filters/FilterTools';
import { useViews } from './filters/ViewContext';
import { facetKeys } from './filters/incidentViews';

const sections = [
  {id:'critical',name:'Критические',note:'Наивысший приоритет или высокий с истекающим либо нарушенным сроком',tone:'red',icon:'alert-triangle'},
  {id:'high',name:'Высокий приоритет',note:'Активные инциденты до порога критичности',tone:'amber',icon:'chevrons-up'},
  {id:'assigned',name:'На координаторах',note:'Следующий шаг — передача профильной команде',tone:'blue',icon:'users-group'},
  {id:'review',name:'Исследование',note:'Сбой устранён, идёт разбор причин',tone:'violet',icon:'file-search'},
] as const;
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
export function Pill({item,label}:{item:Incident;label?:string}) {
  const tone = finished(item) ? 'done' : item.stateEnum==='Research' ? 'research' : 'active';
  const source = item.state || item.stateEnum || 'Статус не указан';
  return <span className={'pill '+tone} title={label && label!==source ? source : undefined}>{label ?? source}</span>;
}
type PriorityQueue = 'high' | 'critical';
function Card({item,group,now,animate,priority,onCoordinators}:{item:Incident;group?:GroupId;now:number;animate:boolean;priority?:PriorityQueue;onCoordinators:boolean}) {
  const {formats:{stamp}} = useLive();
  const reduced = useReducedMotion();
  const countdown = active(item) ? remaining(item.deadline,now) : null;
  const coordinatorSince = onCoordinators ? item.lastAssignmentToTeamDateTime : null;
  const restoredAt = finished(item) || item.stateEnum === 'Research' ? item.completionDate : null;
  const hasMetadata = Boolean(item.submitDate || item.assignedGroupName || coordinatorSince);
  return <motion.div initial={animate && !reduced ? {opacity:0,y:6} : false} animate={{opacity:1,y:0}} transition={{duration:reduced?0:0.24}}>
    <Link data-incident-id={item.id} data-priority={priority} to={pathFor(item.id)} className={group==='history'?'incident resolved':'incident'}>
      <div className="card-top">
        <div className="card-identity min-w-0">
          <span className="mono">{item.id}</span>
          {item.productName && <span className="product">{item.productName}</span>}
        </div>
        <Pill item={item} label={overviewStatus(item,onCoordinators)}/>
      </div>
      {item.header && <h3>{item.header}</h3>}
      {(hasMetadata || countdown || restoredAt) && <div className="card-foot">
        {hasMetadata && <div className="card-meta">
          {item.submitDate && <span>Начало <b><time dateTime={item.submitDate}>{stamp(item.submitDate)}</time></b></span>}
          {item.assignedGroupName && <span className="card-team">
            <span>Текущая команда</span>{' '}
            <b className="min-w-0 truncate" title={item.assignedGroupName}>{item.assignedGroupName}</b>
          </span>}
          {coordinatorSince && <span className="coordinator-since">У координаторов с <b><time dateTime={coordinatorSince}>{stamp(coordinatorSince)}</time></b></span>}
        </div>}
        {countdown && <strong className={'time-left'+(countdown.overdue?' overdue':'')}>{countdown.text}</strong>}
        {restoredAt && <strong className="time-left">Сбой устранён <time dateTime={restoredAt}>{stamp(restoredAt)}</time></strong>}
      </div>}
    </Link>
  </motion.div>;
}
export function Dashboard() {
  const {setChatDock} = useOutletContext<ConsoleOutlet>();
  const {snapshot,now,newCards,bootstrapError} = useLive();
  const {settings,query,result,index,clearFilters,patch,reset}=useViews();
  const deadlineHeading = useRef<HTMLHeadingElement>(null);
  const [expanded,setExpanded] = useState<Partial<Record<GroupId,boolean>>>({});
  useEffect(()=>{document.title='Дашборд инцидентов · МТС';},[]);
  if (!snapshot?.hasSnapshot) return <main className="container waiting"><h1>Дашборд инцидентов</h1><p role="status">{bootstrapError || snapshot?.sourceStatus==='error' ? 'Данные недоступны' : 'Загружаем инциденты…'}</p></main>;
  const filtered = Boolean(settings.deadlineList || query.trim() || settings.groups.length || settings.noOwner || settings.sla!=='any' || settings.created!=='any'
    || settings.queueTime!=='any' || facetKeys.some(k=>settings.choices[k].length));
  const visibleSections = sections.filter(s=>!settings.groups.length || settings.groups.includes(s.id));
  const counter = (id:GroupId) => <span className={'count'+(filtered?' filtered-count':'')}>{filtered?result.groups[id].length+' из '+snapshot.counts[id]:snapshot.counts[id]}</span>;
  const onCoordinators = new Set(snapshot.groups.assigned);
  const priorityById = new Map<string, PriorityQueue>();
  for (const queue of ['high', 'critical'] as const) {
    for (const id of snapshot.groups[queue]) priorityById.set(id, queue);
  }
  function toggleAllDeadlines() {
    if (settings.deadlineList) {
      reset();
      return;
    }
    patch({deadlineList:{sort:[]}});
    requestAnimationFrame(() => {
      deadlineHeading.current?.focus({preventScroll:true});
      deadlineHeading.current?.scrollIntoView({block:'start',behavior:'instant'});
    });
  }
  function renderCard(item: Incident, group?: GroupId) {
    return <Card key={item.id} item={item} group={group} priority={priorityById.get(item.id)} now={now}
      onCoordinators={onCoordinators.has(item.id)} animate={!!group && newCards.has(group+'/'+item.id)}/>;
  }
  const renderGroup = (id:GroupId,name:string) => {
    const ids = result.groups[id];
    const shown = expanded[id]?ids:ids.slice(0,2);
    return <section className={'group '+(id==='history'?'history':'')} key={id} id={id} data-testid={'group-'+id} aria-labelledby={'heading-'+id}>
      <h2 id={'heading-'+id} className="section-head"><button className="category-toggle" type="button" aria-expanded={!!expanded[id]} aria-controls={'list-'+id} onClick={()=>setExpanded(prev=>({...prev,[id]:!prev[id]}))}>
        <span className="category-caption"><span className="category-name">{name}</span>{counter(id)}</span>
        <ChevronDown size={16}/></button></h2>
      <div id={'list-'+id} className="incident-list">{shown.map(key=>{
        const item=index.byId.get(key)?.item;
        return item && renderCard(item,id);
      })}
      {!ids.length && snapshot.counts[id]>0 && filtered &&
        <p className="queue-empty">По выбранным условиям совпадений нет. <button className="filter-text" onClick={clearFilters}>Сбросить условия</button></p>}</div>
    </section>;
  };
  return <main className="container overview">
    <div className="page-intro"><h1>Дашборд инцидентов</h1></div>
    {!settings.deadlineList && <ActiveFilters/>}
    {!filtered && <nav className="metrics" aria-label="Группы инцидентов">{sections.map(g=><a className={'metric '+g.tone} key={g.id} href={'#'+g.id} onClick={()=>setExpanded(p=>({...p,[g.id]:true}))}>
      <span className="metric-heading"><svg width="20" height="20" aria-hidden="true" focusable="false"><use href={'/queue-icons.svg#'+g.icon}/></svg>
        <span className="category-caption"><strong className="metric-name">{g.name}</strong>{counter(g.id)}</span>
      </span><small>{g.note}</small></a>)}</nav>}
    <div className="work-grid"><div className="queue" id="dashboard-queue">
      {settings.deadlineList ? <section className="group" data-testid="deadline-results" aria-labelledby="deadline-results-heading">
        <h2 id="deadline-results-heading" className="section-head" ref={deadlineHeading} tabIndex={-1}>Инциденты со сроком решения</h2>
        <ActiveFilters/>
        <div className="incident-list">{result.items.map(item=>renderCard(item))}
          {!result.count && <p className="queue-empty">По выбранным условиям нет активных инцидентов со сроком решения.</p>}
        </div>
      </section> : visibleSections.map(g=>renderGroup(g.id,g.name))}
    </div>
      <aside className="rail"><DeadlineFocus entries={result.deadlines} showingAll={!!settings.deadlineList} onToggleAll={toggleAllDeadlines}/><div className="chat-dock" ref={setChatDock}/></aside></div>
    {!settings.deadlineList && !settings.groups.length && renderGroup('history','История решённых инцидентов')}
    {snapshot.diagnostics.length>0 && <details className="source-details"><summary>Замечания к данным ({snapshot.diagnostics.length})</summary><ul>{snapshot.diagnostics.map((m,k)=><li key={k}>{m}</li>)}</ul></details>}
  </main>;
}
