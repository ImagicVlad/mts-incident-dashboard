import { active, type GroupId, type Incident, type Snapshot } from '../api';

export const queues = {critical:'Критические', high:'Высокий приоритет', assigned:'На координаторах', review:'Исследование ситуации'};
export type Queue = keyof typeof queues;
export const facets = {priority:'Приоритет', status:'Статус', productName:'Продукт', service:'Сервис', assignedGroupName:'Текущая команда', assignedEmployee:'Исполнитель'};
export type Facet = keyof typeof facets;
export const facetKeys = Object.keys(facets) as Facet[];
export const slaOptions = {any:'Любое состояние', upcoming:'Не просрочен', overdue:'Просрочен', missing:'Срок отсутствует', '15':'Менее 15 минут', '30':'Менее 30 минут', '60':'Менее 1 часа', '240':'Менее 4 часов', '1440':'Менее 24 часов', remainingRange:'Диапазон до срока', overdueRange:'Диапазон просрочки'};
export const createdOptions = {any:'Любое время', '1':'За последний час', '24':'За последние 24 часа', '168':'За последние 7 дней', '720':'За последние 30 дней', dates:'Диапазон дат'};
export const queueOptions = {any:'Любая длительность', under15:'Менее 15 минут', over30:'Более 30 минут', over60:'Более 1 часа', over240:'Более 4 часов', range:'Диапазон длительности'};
// The two labels describe ascending and descending order respectively.
export const sortFields = {
  priority:['Приоритет','От низкого','От высокого'], upcoming:['Предстоящий SLA','Ближайшие','Дальние'],
  created:['Возникновение','Старые','Новые'], overdue:['Просрочка SLA','Недавние','Самые давние'],
  deadline:['Дата срока SLA','Раньше','Позже'], queueAge:['Время у координаторов','Меньше','Дольше'],
  urgency:['Срочность реакции','Срочные','Спокойные'], productName:['Продукт','А–Я','Я–А'],
  assignedGroupName:['Команда','А–Я','Я–А'], assignedEmployee:['Исполнитель','А–Я','Я–А'],
  status:['Статус','А–Я','Я–А'], id:['ID инцидента','По возрастанию','По убыванию'],
} as const;
export type SortField = keyof typeof sortFields;
export type Sort = {field:SortField; dir:'asc'|'desc'};
export type Settings = {
  groups:Queue[]; choices:Record<Facet,string[]>; noOwner:boolean;
  sla:keyof typeof slaOptions; slaMin:string; slaMax:string;
  created:keyof typeof createdOptions; dateFrom:string; dateTo:string;
  queueTime:keyof typeof queueOptions; queueMin:string; queueMax:string; sort:Sort[];
  deadlineList?: {sort:Sort[]};
};
export const defaults:Settings = {
  groups:[],choices:{priority:[],status:[],productName:[],service:[],assignedGroupName:[],assignedEmployee:[]},
  noOwner:false,sla:'any',slaMin:'',slaMax:'',created:'any',dateFrom:'',dateTo:'',
  queueTime:'any',queueMin:'',queueMax:'',sort:[],
};
export function toggle<T>(list:T[], value:T) { return list.includes(value) ? list.filter(v=>v!==value) : [...list,value]; }
export const collator = new Intl.Collator('ru', {numeric:true, sensitivity:'base'});
const minute = 60_000;
function timestamp(value:string|null) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
}
// Store only stable option keys in views; names and other source text stay in memory.
function optionKey(text:string) {
  let hash = 14695981039346656037n;
  for (let n=0;n<text.length;n++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(n))) * 1099511628211n);
  return hash.toString(36);
}
export function matchesSearch(item:Incident, term:string) {
  return !term || [item.header,item.productName,item.id,item.assignedGroupName,item.assignedEmployee,item.sysId]
    .some(s=>s?.toLocaleLowerCase('ru').includes(term));
}
function dateKey(value:number, format:Intl.DateTimeFormat) {
  const parts = format.formatToParts(value);
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type)?.value).join('-');
}
export function buildIndex(snapshot:Snapshot|undefined, format:Intl.DateTimeFormat) {
  const options = Object.fromEntries(facetKeys.map(k=>[k,new Map<string,string>()])) as Record<Facet,Map<string,string>>;
  const membership = new Map<string,Set<GroupId>>();
  const byId = new Map<string,Row>();
  for (const [group,ids] of Object.entries(snapshot?.groups ?? {})) {
    for (const id of ids) {
      const assigned = membership.get(id) ?? new Set<GroupId>();
      assigned.add(group as GroupId); membership.set(id,assigned);
    }
  }
  const optionIds = new Map<string,string>();
  for (const item of snapshot?.incidents ?? []) {
    const values = {} as Record<Facet,string>;
    for (const field of facetKeys) {
      const label = (field==='priority' ? item.priority || item.priorityId?.toString() : field==='status' ? item.state || item.stateEnum : item[field])?.trim();
      values[field]='';
      if (!label) continue;
      const value = field==='priority' ? String(item.priorityId ?? label) : field==='status' ? item.stateEnum || label : label;
      const key = optionIds.get(value) ?? optionKey(value);
      optionIds.set(value,key); values[field]=key; options[field].set(key,label);
    }
    const groups = membership.get(item.id) ?? new Set<GroupId>();
    const created = timestamp(item.submitDate);
    byId.set(item.id,{item,groups,values,created,day:created===null?'':dateKey(created,format),
      deadline:timestamp(item.deadline),assignment:groups.has('assigned') ? timestamp(item.lastAssignmentToTeamDateTime) : null});
  }
  return {byId,options};
}
type Row = {item:Incident; groups:Set<GroupId>; values:Record<Facet,string>; created:number|null; day:string; deadline:number|null; assignment:number|null};
export type Index = ReturnType<typeof buildIndex>;

export function employeesForTeams(index:Index, teams:string[]) {
  if (!teams.length) return null;
  const employees=new Set<string>();
  for (const {values} of index.byId.values()) {
    if (values.assignedEmployee && teams.includes(values.assignedGroupName)) employees.add(values.assignedEmployee);
  }
  return employees;
}

function inRange(value:number, min:string, max:string) {
  return value>=0 && (!min || value>=Number(min)) && (!max || value<=Number(max));
}
function matches(row:Row, s:Settings, term:string, now:number) {
  if (!matchesSearch(row.item,term)) return false;
  if (s.groups.length && !s.groups.some(g=>row.groups.has(g))) return false;
  if (s.noOwner && row.values.assignedEmployee) return false;
  if (facetKeys.some(k=>s.choices[k].length && !s.choices[k].includes(row.values[k]))) return false;
  if (s.created==='dates') {
    if (!row.day || (s.dateFrom && row.day<s.dateFrom) || (s.dateTo && row.day>s.dateTo)) return false;
  } else if (s.created!=='any' && (row.created===null || row.created>now || now-row.created>Number(s.created)*60*minute)) return false;
  if (s.sla==='missing') {
    if (row.deadline!==null) return false;
  } else if (s.sla!=='any') {
    if (!active(row.item) || row.deadline===null) return false;
    const left = (row.deadline-now)/minute;
    if (s.sla==='overdue' || s.sla==='overdueRange') {
      if (left>0 || (s.sla==='overdueRange' && !inRange(-left,s.slaMin,s.slaMax))) return false;
    } else if (left<=0 || (s.sla==='remainingRange' ? !inRange(left,s.slaMin,s.slaMax) : s.sla!=='upcoming' && left>=Number(s.sla))) return false;
  }
  if (s.queueTime!=='any') {
    if (row.assignment===null || row.assignment>now) return false;
    const age = (now-row.assignment)/minute;
    if (s.queueTime==='range') return inRange(age,s.queueMin,s.queueMax);
    if (s.queueTime==='under15') return age<15;
    return age>({over30:30,over60:60,over240:240}[s.queueTime]);
  }
  return true;
}
function sortValue(row:Row, field:SortField, now:number):string|number|null {
  const {item,deadline,groups}=row;
  const left = active(item) && deadline!==null ? deadline-now : null;
  switch (field) {
    case 'priority': return item.priorityId!==null && [1,2,3,4].includes(item.priorityId) ? item.priorityId : null;
    case 'deadline': return deadline;
    case 'upcoming': return left!==null && left>0 ? left : null;
    case 'overdue': return left!==null && left<=0 ? -left : null;
    case 'queueAge': return row.assignment!==null && row.assignment<=now ? now-row.assignment : null;
    case 'created': return row.created;
    case 'status': return item.state || item.stateEnum || null;
    case 'urgency':
      if (left!==null && left<=0) return 0;
      if (groups.has('critical')) return 1;
      if (groups.has('high')) return 2;
      if (active(item)) return groups.has('assigned') ? 3 : 4;
      return groups.has('assigned') ? 5 : groups.has('review') ? 6 : 7;
    default: return item[field]?.trim() || null;
  }
}
function compareRows(a:Row,b:Row,sort:Sort[],now:number) {
  for (const {field,dir} of sort) {
    const x=sortValue(a,field,now), y=sortValue(b,field,now);
    if (x===y) continue;
    if (x===null) return 1;
    if (y===null) return -1;
    const diff = typeof x==='number' && typeof y==='number' ? x-y : collator.compare(String(x),String(y));
    if (diff) return dir==='asc' ? diff : -diff;
  }
  return collator.compare(a.item.id,b.item.id) || (a.item.id<b.item.id?-1:a.item.id>b.item.id?1:0);
}
export type DeadlineEntry = { item: Incident; deadline: string; at: number };
const nearestFirst: Sort[] = [{field:'upcoming',dir:'asc'}, {field:'overdue',dir:'asc'}];

export function selectRows(index:Index, snapshot:Snapshot|undefined, settings:Settings, query:string, now:number) {
  const term=query.trim().toLocaleLowerCase('ru');
  const rows = [...index.byId.values()].filter(row=>matches(row,settings,term,now));
  const scheduled = rows.filter((r): r is Row & {deadline:number; item:Incident & {deadline:string}} =>
    active(r.item) && r.deadline!==null && r.item.deadline!==null);
  if (snapshot?.deadlineOrder) {
    const rank = new Map(snapshot.deadlineOrder.map((id, i) => [id, i]));
    scheduled.sort((a,b) => rank.get(a.item.id)! - rank.get(b.item.id)!);
  } else {
    scheduled.sort((a,b)=>compareRows(a,b,nearestFirst,now));
  }
  const deadlines: DeadlineEntry[] = scheduled.map(({item,deadline})=>({item,deadline:item.deadline,at:deadline}));
  const visible = settings.deadlineList ? scheduled : rows;
  const sort = settings.deadlineList?.sort ?? settings.sort;
  if (sort.length) {
    const order = settings.deadlineList ? [...sort,...nearestFirst] : sort;
    visible.sort((a,b)=>compareRows(a,b,order,now));
  }
  const matched = new Set(visible.map(r=>r.item.id));
  const groups:Record<GroupId,string[]> = {critical:[],high:[],assigned:[],review:[],history:[]};
  for (const key of Object.keys(groups) as GroupId[]) {
    if (settings.groups.length && (key==='history' || !settings.groups.includes(key))) continue;
    groups[key] = sort.length ? visible.filter(r=>r.groups.has(key)).map(r=>r.item.id)
      : (snapshot?.groups[key] ?? []).filter(id=>matched.has(id));
  }
  const count = settings.deadlineList ? visible.length : new Set(Object.values(groups).flat()).size;
  return {items:visible.map(row=>row.item), deadlines, groups, count};
}
