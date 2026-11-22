import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowDownUp, Check, ChevronDown, Plus, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { useLive } from '../live';
import { useViews } from './ViewContext';
import { collator, createdOptions, employeesForTeams, facetKeys, facets, queueOptions, queues, slaOptions, sortFields, toggle, type Facet, type Queue, type Sort, type SortField } from './incidentViews';
import './filters.css';

function Group({name,children}:{name:string;children:ReactNode}) {
  return <details className="filter-group"><summary><span>{name}</span><ChevronDown size={15}/></summary>
    <div className="filter-fields">{children}</div></details>;
}
function Select<T extends string>({label,value,options,onChange}:{label:string;value:T;options:Record<T,string>;onChange:(v:T)=>void}) {
  const id=useId();
  const choices=(Object.keys(options) as T[])
    .sort((a,b)=>Number(b==='any')-Number(a==='any'))
    .map(key=>({value:key,label:options[key]}));
  return <div className="filter-field">
    <label htmlFor={id}>{label}</label>
    <FilterPicker id={id} name={label} selected={value} display={options[value]} options={choices}
      onSelect={next=>{if (next!==value) onChange(next);}}/>
  </div>;
}
function Range({min,max,onMin,onMax,dates=false}:{min:string;max:string;onMin:(v:string)=>void;onMax:(v:string)=>void;dates?:boolean}) {
  const type=dates?'date':'number';
  const bad=min && max && (dates ? min>max : Number(min)>Number(max));
  return <><div className="filter-pair">{(['От','До'] as const).map((label,i)=><label key={label} className="filter-field">{label}{dates?'':', мин'}
    <input type={type} min={dates?undefined:0} value={i?max:min} aria-invalid={Boolean(bad)} onChange={e=>{
      const v=e.target.value;
      if (dates || !v || Number(v)>=0) (i?onMax:onMin)(v);
    }}/></label>)}</div>{bad && <span className="filter-error">Верхняя граница меньше нижней.</span>}</>;
}
function FacetPicker({field,primary=false}:{field:Facet;primary?:boolean}) {
  const {settings,index,toggleChoice}=useViews(), [search,setSearch]=useState('');
  const selected=settings.choices[field];
  const options=index.options[field];
  const eligible=field==='assignedEmployee' ? employeesForTeams(index,settings.choices.assignedGroupName) : null;
  const entries=[...new Set([...(eligible ?? options.keys()),...selected])].map(key=>({key,label:options.get(key) ?? 'Значение вне текущего снимка'}))
    .filter(o=>o.label.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))).sort((a,b)=>collator.compare(a.label,b.label));
  return <details className={primary?'facet primary-facet':'facet'}><summary>{facets[field]}<span>{selected.length || 'Все'}</span><ChevronDown size={14}/></summary>
    <div className="facet-body">
      {(options.size>6 || field==='assignedEmployee' || field==='assignedGroupName') && <label className="facet-search"><Search size={14}/>
        <input aria-label={'Поиск значений · '+facets[field]} placeholder="Найти в списке…" value={search} onChange={e=>setSearch(e.target.value)}/></label>}
      <div className="facet-options">{entries.map(({key,label})=><label key={key}><input type="checkbox" checked={selected.includes(key)} onChange={()=>toggleChoice(field,key)}/>{label}</label>)}
        {!entries.length && <small>{eligible && !search ? 'В выбранных командах нет назначенных исполнителей' : 'Нет подходящих значений'}</small>}</div>
    </div></details>;
}
function QuickFilters({hasFilters}:{hasFilters:boolean}) {
  const {settings:s,patch,clearFilters}=useViews();
  function chooseGroup(g:Queue) {patch({groups:toggle(s.groups,g)});}
  const preset=(label:string,on:boolean,action:()=>void)=><button key={label} type="button" aria-pressed={on} onClick={action}>{on && <Check size={13}/>} {label}</button>;
  return <>
    <div className="quick-filter-heading">
      <div className="filter-subtitle">Быстрый выбор</div>
      <button className="quick-filter-reset" type="button" disabled={!hasFilters} onClick={clearFilters}>
        {hasFilters ? <RotateCcw size={13} aria-hidden="true"/> : <Check size={13} aria-hidden="true"/>}
        {hasFilters ? 'Сбросить фильтры' : 'Все инциденты'}
      </button>
    </div>
    <div className="filter-presets">
      {(Object.keys(queues) as Queue[]).map(g=>preset(queues[g],s.groups.includes(g),()=>chooseGroup(g)))}
      {preset('Нарушен SLA',s.sla==='overdue',()=>patch({sla:s.sla==='overdue'?'any':'overdue'}))}
      {preset('SLA < 30 мин',s.sla==='30',()=>patch({sla:s.sla==='30'?'any':'30'}))}
      {preset('Без исполнителя',s.noOwner,()=>patch({noOwner:!s.noOwner,choices:{...s.choices,assignedEmployee:[]}}))}
      {preset('За последние сутки',s.created==='24',()=>patch({created:s.created==='24'?'any':'24'}))}
    </div>
  </>;
}
function AdvancedFilters() {
  const {settings:s,patch}=useViews();
  const {formats:{zoneLabel}}=useLive();
  return <>
    <FacetPicker field="assignedGroupName" primary/>
    <FacetPicker field="assignedEmployee" primary/>
    <Group name="SLA и время">
      <Select label="Состояние SLA" value={s.sla} options={slaOptions} onChange={sla=>patch({sla,slaMin:'',slaMax:''})}/>
      {(s.sla==='remainingRange' || s.sla==='overdueRange') && <Range min={s.slaMin} max={s.slaMax} onMin={slaMin=>patch({slaMin})} onMax={slaMax=>patch({slaMax})}/>}
      <Select label="Дата возникновения" value={s.created} options={createdOptions} onChange={created=>patch({created})}/>
      {s.created==='dates' && <><Range dates min={s.dateFrom} max={s.dateTo} onMin={dateFrom=>patch({dateFrom})} onMax={dateTo=>patch({dateTo})}/><small>Даты включительно · {zoneLabel}</small></>}
      <Select label="В очереди координаторов" value={s.queueTime} options={queueOptions} onChange={queueTime=>patch({queueTime})}/>
      {s.queueTime==='range' && <Range min={s.queueMin} max={s.queueMax} onMin={queueMin=>patch({queueMin})} onMax={queueMax=>patch({queueMax})}/>}
    </Group>
    <Group name="Атрибуты инцидента">{facetKeys.filter(field=>field!=='assignedGroupName' && field!=='assignedEmployee').map(field=><FacetPicker key={field} field={field}/>)}</Group>
  </>;
}
const commonSorts: (Sort & {label:string})[] = [
  {field:'upcoming',dir:'asc',label:'Ближайший SLA'},
  {field:'overdue',dir:'desc',label:'Сначала давно просроченные'},
  {field:'priority',dir:'desc',label:'Сначала высокий приоритет'},
  {field:'created',dir:'desc',label:'Сначала новые'},
  {field:'created',dir:'asc',label:'Сначала старые'},
];
const sortOptions = [
  {value:'default',label:'По умолчанию'},
  ...commonSorts.map(rule=>({value:rule.field+':'+rule.dir,label:rule.label})),
  {value:'edit',label:'Настроить порядок…',action:true},
];

type PickerProps<T extends string> = {
  id?:string; name:string; listName?:string; selected:T; display:string;
  options:{value:T;label:string;action?:boolean}[];
  onSelect:(value:T)=>void;
};
function FilterPicker<T extends string>({id,name,listName=name,selected,display,options,onSelect}:PickerProps<T>) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const menu=useRef<HTMLDivElement>(null);
  const valueId=useId();

  function navigate(event:KeyboardEvent<HTMLDivElement>) {
    const choices=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const current=choices.indexOf(document.activeElement as HTMLButtonElement);
    let next:number;
    switch (event.key) {
      case 'ArrowDown': next=(current+1)%choices.length;break;
      case 'ArrowUp': next=(current-1+choices.length)%choices.length;break;
      case 'Home': next=0;break;
      case 'End': next=choices.length-1;break;
      case 'Tab':
        trigger.current?.focus();
        setOpen(false);
        return;
      default:return;
    }
    event.preventDefault();
    choices[next].focus();
  }
  return <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><button type="button" id={id} ref={trigger} className="sort-picker-trigger" aria-label={name} aria-describedby={valueId} aria-haspopup="listbox"
        onKeyDown={e=>{if (e.key==='ArrowDown' || e.key==='ArrowUp') {e.preventDefault();setOpen(true);}}}>
        <span id={valueId}>{display}</span><ChevronDown size={15} aria-hidden="true"/>
      </button></PopoverTrigger>
      <PopoverContent ref={menu} role="listbox" aria-label={listName} className="sort-picker-menu" sideOffset={5}
        onOpenAutoFocus={e=>{e.preventDefault();menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();}}
        onKeyDown={navigate}>
        {options.map(option=><button key={option.value} type="button" role="option" tabIndex={-1} className="sort-picker-option" data-action={option.action}
          aria-selected={selected===option.value} onClick={()=>{onSelect(option.value);setOpen(false);}}>
          {option.action && <SlidersHorizontal size={15} aria-hidden="true"/>}
          <span>{option.label}</span>{selected===option.value && <Check className="sort-check" size={15} aria-hidden="true"/>}
        </button>)}
      </PopoverContent>
    </Popover>;
}

function Ordering() {
  const [editing,setEditing]=useState(false);
  const {settings:{deadlineList},sort,setSort}=useViews();
  const first=sort[0];
  const preset=sort.length===1 && commonSorts.find(rule=>rule.field===first.field && rule.dir===first.dir);
  const selected=preset ? preset.field+':'+preset.dir : first ? 'edit' : deadlineList ? 'upcoming:asc' : 'default';
  const defaultLabel=deadlineList ? 'Ближайший SLA' : 'По умолчанию';
  const selectedLabel=preset ? preset.label : !first ? defaultLabel : sort.length>1
    ? 'По нескольким критериям' : sortFields[first.field][0]+' · '+sortFields[first.field][first.dir==='asc'?1:2];
  function selectOrder(value:string) {
    if (value==='edit') {setEditing(true);return;}
    const rule=commonSorts.find(r=>r.field+':'+r.dir===value);
    setSort(rule && !(deadlineList && value==='upcoming:asc') ? [{field:rule.field,dir:rule.dir}] : []);
    setEditing(false);
  }
  const fields=Object.keys(sortFields) as SortField[];
  function move(i:number,j:number) {const next=[...sort]; [next[i],next[j]]=[next[j],next[i]];setSort(next);}
  return <>
    <div className="quick-sort"><span className="filter-subtitle">Сортировка</span>
      <FilterPicker name="Сортировка" listName="Порядок инцидентов" selected={selected} display={selectedLabel} options={sortOptions} onSelect={selectOrder}/>
    </div>
    {editing && <div className="sorting-fields">
    <div className="sort-level"><strong>{deadlineList ? 'Порядок в списке' : 'Порядок внутри категорий'}</strong><button aria-label="Свернуть настройку порядка" onClick={()=>setEditing(false)}><X size={15}/></button></div>
    {sort.length>1 && <p className="filter-hint">При совпадении значений применяется следующий уровень.</p>}
    {sort.map((rule,i)=><div className="sort-row" key={i}>
      <div className="sort-level"><b>Уровень {i+1}</b><div>
        <button aria-label={'Повысить уровень '+(i+1)} disabled={!i} onClick={()=>move(i,i-1)}><ArrowUp size={15}/></button>
        <button aria-label={'Понизить уровень '+(i+1)} disabled={i===sort.length-1} onClick={()=>move(i,i+1)}><ArrowDown size={15}/></button>
        <button aria-label={'Удалить уровень '+(i+1)} onClick={()=>setSort(sort.filter((_,n)=>n!==i))}><X size={15}/></button></div></div>
      <div className="filter-pair"><select aria-label={'Критерий '+(i+1)} value={rule.field} onChange={e=>{
        const field=e.target.value as SortField; setSort(sort.map((r,n)=>i===n?{field,dir:field==='priority' || field==='created'?'desc':'asc'}:r));
      }}>{fields.map(f=><option key={f} value={f} disabled={sort.some((r,n)=>n!==i && r.field===f)}>{sortFields[f][0]}</option>)}</select>
      <select aria-label={'Направление '+(i+1)} value={rule.dir} onChange={e=>setSort(sort.map((r,n)=>n===i?{...r,dir:e.target.value==='asc'?'asc':'desc'}:r))}>
        <option value="asc">{sortFields[rule.field][1]}</option><option value="desc">{sortFields[rule.field][2]}</option></select></div>
    </div>)}
    {sort.length<3 && <button className="filter-secondary" onClick={()=>{
      const field=fields.find(f=>!sort.some(r=>r.field===f))!;setSort([...sort,{field,dir:field==='priority'?'desc':'asc'}]);
    }}><Plus size={15}/>Добавить уровень</button>}
    {sort.some(r=>r.field==='urgency') && <p className="filter-hint">Первыми идут активные с просрочкой, затем критические, высокий приоритет и прочие активные. В оставшихся активных и исследованиях раньше идут записи координаторов. История — последней.</p>}
    {sort.some(r=>r.field==='upcoming' || r.field==='overdue') && <p className="filter-hint">Учитываются сроки активных инцидентов. Записи вне выбранного вида срока идут в конце при обоих направлениях.</p>}
    </div>}
  </>;
}
function useFilterChips() {
  const {settings:s,patch,toggleChoice,index,query,setQuery}=useViews();
  const chips:{label:string;removeLabel?:string;remove:()=>void}[]=[];
  if (s.deadlineList) chips.push({label:'Все сроки',removeLabel:'Сбросить фильтр по срокам',remove:()=>patch({deadlineList:undefined})});
  if (query.trim()) chips.push({label:'Поиск · '+query.trim(),remove:()=>setQuery('')});
  for (const g of s.groups) chips.push({label:queues[g],remove:()=>patch({groups:toggle(s.groups,g)})});
  const range=(a:string,b:string,unit:string)=>[a && 'от '+a,b && 'до '+b].filter(Boolean).join(' ') + (a || b ? unit:'');
  if (s.sla!=='any') chips.push({label:'SLA · '+slaOptions[s.sla]+(s.sla.endsWith('Range')?' '+range(s.slaMin,s.slaMax,' мин'):''),remove:()=>patch({sla:'any'})});
  if (s.created!=='any') chips.push({label:s.created==='dates'?'Возникновение · '+(range(s.dateFrom,s.dateTo,'')||'любые даты'):createdOptions[s.created],remove:()=>patch({created:'any'})});
  if (s.queueTime!=='any') chips.push({label:'У координаторов · '+(s.queueTime==='range'?range(s.queueMin,s.queueMax,' мин')||'любая длительность':queueOptions[s.queueTime]),remove:()=>patch({queueTime:'any'})});
  if (s.noOwner) chips.push({label:'Без исполнителя',remove:()=>patch({noOwner:false})});
  for (const k of facetKeys) for (const v of s.choices[k]) chips.push({label:facets[k]+' · '+(index.options[k].get(v) ?? 'вне снимка'),remove:()=>toggleChoice(k,v)});
  return chips;
}
export function FilterTools() {
  const {result,sort,storageError}=useViews(), chips=useFilterChips();
  const [open,setOpen]=useState(false), [tab,setTab]=useState('Фильтры');
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button className="filter-trigger" data-active={chips.length>0 || sort.length>0}>
      <SlidersHorizontal size={17}/>Фильтры{chips.length>0 && <b>{chips.length}</b>}{sort.length>0 && <ArrowDownUp aria-label="Настроена сортировка" size={14}/>}
    </button></PopoverTrigger>
    <PopoverContent className="filter-panel" aria-label="Настройки списка инцидентов">
      <div className="filter-panel-head"><h2>Настройки списка</h2><button onClick={()=>setOpen(false)} aria-label="Закрыть настройки"><X size={18}/></button></div>
      <div className="filter-tabs" role="group" aria-label="Раздел настроек">{['Фильтры','Расширенные'].map(t=><button key={t} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t}</button>)}</div>
      <div className="filter-scroll" key={tab}>{tab==='Фильтры'?<><Ordering/><QuickFilters hasFilters={chips.length>0}/></>:<AdvancedFilters/>}</div>
      {storageError && <small role="status" className="filter-error">Браузер не сохранил настройки. Они доступны до перезагрузки.</small>}
      <div className="filter-footer"><span>Инцидентов в списках <b>{result.count}</b></span><button onClick={()=>setOpen(false)}>Готово</button></div>
    </PopoverContent></Popover>;
}
export function ActiveFilters() {
  const {sort,reset,result,setSort}=useViews(), chips=useFilterChips();
  const [showAll,setShowAll]=useState(false);
  if (!chips.length && !sort.length) return null;
  return <div className="active-filters" aria-label="Активные условия">
    <strong>Найдено {result.count}</strong>
    {(showAll?chips:chips.slice(0,3)).map((c,i)=><button key={i} title={c.label} aria-label={c.removeLabel ?? 'Убрать '+c.label} onClick={c.remove}><span>{c.label}</span><X size={13}/></button>)}
    {chips.length>3 && <button onClick={()=>setShowAll(!showAll)}>{showAll?'Свернуть':'Ещё '+(chips.length-3)}</button>}
    {sort.length>0 && <button onClick={()=>setSort([])} aria-label="Сбросить сортировку"><ArrowDownUp size={13}/><span>{sortFields[sort[0].field][0]}{sort.length>1?' +'+(sort.length-1):''}</span><X size={13}/></button>}
    <button className="filter-text" onClick={reset}>Сбросить всё</button>
  </div>;
}
