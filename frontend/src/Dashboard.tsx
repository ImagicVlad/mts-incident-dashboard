import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { active, finished, pathFor, remaining, type GroupId, type Incident } from './api';
import { useLive } from './live';
import { Chat } from './Intelligence';

const sections = [
  {id:'critical',name:'Критические',note:'Требуют срочного решения',tone:'red'},
  {id:'assigned',name:'На координаторах',note:'Ожидают передачи профильной команде',tone:'blue'},
  {id:'high',name:'Высокий приоритет',note:'Повышенное внимание',tone:'amber'},
  {id:'review',name:'Исследование',note:'Разбор причин',tone:'violet'},
] as const;
export function Pill({item}:{item:Incident}) {
  const tone = finished(item) ? 'done' : item.stateEnum==='Research' ? 'research' : 'active';
  return <span className={'pill '+tone}>{item.state || item.stateEnum || 'Статус не указан'}</span>;
}
function Card({item,group,now,animate,critical}:{item:Incident;group:GroupId;now:number;animate:boolean;critical:boolean}) {
  const {formats:{stamp}} = useLive();
  const reduced = useReducedMotion();
  const countdown = active(item) ? remaining(item.deadline,now) : null;
  return <motion.div initial={animate && !reduced ? {opacity:0,y:6} : false} animate={{opacity:1,y:0}} transition={{duration:reduced?0:0.24}}>
    <Link data-incident-id={item.id} to={pathFor(item.id)} className={'incident'+ (critical?' urgent':'') + (group==='history'?' resolved':'')}>
      <div className="card-top"><span className="mono">{item.id}</span><span className="product">{item.productName || 'Продукт не указан'}</span><Pill item={item}/></div>
      <h3>{item.header || 'Без заголовка'}</h3>
      <div className="card-foot"><span>Начало <b>{stamp(item.submitDate)}</b></span><span>Команда <b className={item.assignedGroupName?'':'team-pending'} title={item.assignedGroupName || 'Команда не указана'}>{item.assignedGroupName || '?'}</b></span><span>Исполнитель <b>{item.assignedEmployee || 'Не указан'}</b></span>
        <span>{item.stateEnum==='Research'?'Срок из источника':'Срок'} <b>{stamp(item.deadline)}</b></span>
        {countdown && <strong className={'time-left'+(countdown.overdue?' overdue':'')}>{countdown.text}</strong>}
        {(finished(item) || item.stateEnum==='Research') && item.completionDate && <strong className="time-left">Устранён {stamp(item.completionDate)}</strong>}
      </div>
    </Link>
  </motion.div>;
}
export function Dashboard() {
  const {snapshot,now,newCards,bootstrapError,formats:{dateFormat,stamp,zoneLabel}} = useLive();
  const [expanded,setExpanded] = useState<Partial<Record<GroupId,boolean>>>({});
  useEffect(()=>{document.title='Дашборд инцидентов · МТС';},[]);
  if (!snapshot?.hasSnapshot) return <main className="container waiting"><h1>Дашборд инцидентов</h1><p role="status">{bootstrapError || snapshot?.sourceStatus==='error' ? 'Данные недоступны' : 'Загружаем инциденты…'}</p></main>;
  const byId = new Map(snapshot.incidents.map(i=>[i.id,i]));
  const entries = snapshot.incidents.filter(i=>active(i) && i.deadline && Number.isFinite(Date.parse(i.deadline))).sort((a,b)=>Date.parse(a.deadline!)-Date.parse(b.deadline!));
  const nearest = entries.find(i=>Date.parse(i.deadline!)>=now) ?? entries.at(-1);
  const nextClock = nearest && remaining(nearest.deadline,now);
  const renderGroup = (id:GroupId,name:string) => {
    const ids = snapshot.groups[id];
    const shown = expanded[id]?ids:ids.slice(0,2);
    return <section className={'group '+(id==='history'?'history':'')} key={id} id={id} data-testid={'group-'+id} aria-labelledby={'heading-'+id}>
      <h2 id={'heading-'+id} className="section-head"><button className="category-toggle" type="button" aria-expanded={!!expanded[id]} aria-controls={'list-'+id} onClick={()=>setExpanded(prev=>({...prev,[id]:!prev[id]}))}>
        <span className="category-name">{name}</span><span className="count">{ids.length}</span><ChevronDown size={16}/></button></h2>
      <div id={'list-'+id} className="incident-list">{shown.map(key=>{
        const item=byId.get(key);
        return item && <Card key={key} item={item} group={id} critical={snapshot.groups.critical.includes(key)} now={now} animate={newCards.has(id+'/'+key)}/>;
      })}
      {!ids.length && <p className="queue-empty">{id==='history'?'Завершённых инцидентов пока нет.':'В этой категории нет инцидентов.'}</p>}</div>
    </section>;
  };
  return <main className="container overview">
    <div className="page-intro"><h1>Дашборд инцидентов</h1><div className="date-stamp">{dateFormat.format(now)}
      <span>Данные на {stamp(snapshot.dataUpdatedAt)} {zoneLabel}</span></div></div>
    <nav className="metrics" aria-label="Группы инцидентов">{sections.map(g=><a className={'metric '+g.tone} key={g.id} href={'#'+g.id} onClick={()=>setExpanded(p=>({...p,[g.id]:true}))}>
      <span className="metric-name"><i/>{g.name}</span><strong>{String(snapshot.counts[g.id]).padStart(2,'0')}</strong><small>{g.note}</small></a>)}</nav>
    <div className="work-grid"><div className="queue">{sections.map(g=>renderGroup(g.id,g.name))}</div>
      <aside className="rail"><section className="focus"><div className="focus-pattern" aria-hidden="true"/><p className="eyebrow"><span className="signal red-dot"/>Ближайший срок</p>
        {nearest && nextClock ? <><strong className="big-clock">{nextClock.clock}</strong><p className="clock-note">{nextClock.overdue?'прошло со срока решения':'до срока решения'} · {stamp(nearest.deadline)} {zoneLabel}</p>
          <div className="focus-bottom"><span className="mono">{nearest.id} / {nearest.productName || 'Продукт не указан'}</span><h3>{nearest.header || 'Без заголовка'}</h3><Link to={pathFor(nearest.id)}>Открыть инцидент <ChevronRight size={14}/></Link></div></>
          : <p className="clock-note empty-clock">Нет активных инцидентов с указанным сроком.</p>}
      </section><Chat/></aside></div>
    {renderGroup('history','История решённых инцидентов')}
    {snapshot.diagnostics.length>0 && <details className="source-details"><summary>Замечания к данным ({snapshot.diagnostics.length})</summary><ul>{snapshot.diagnostics.map((m,k)=><li key={k}>{m}</li>)}</ul></details>}
  </main>;
}
