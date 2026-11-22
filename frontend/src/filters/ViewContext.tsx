import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLive } from '../live';
import { buildIndex, createdOptions, defaults, employeesForTeams, facetKeys, queueOptions, queues, selectRows, slaOptions, sortFields, toggle, type Facet, type Settings, type Sort } from './incidentViews';

function validSort(value:unknown):value is Sort[] {
  return Array.isArray(value) && value.length<=3 && value.every(v=>v && Object.hasOwn(sortFields,v.field) && ['asc','desc'].includes(v.dir));
}
function validSettings(s:unknown):s is Settings {
  if (!s || typeof s!=='object') return false;
  const x=s as Settings;
  return Array.isArray(x.groups) && x.groups.every(g=>Object.hasOwn(queues,g))
    && !!x.choices && facetKeys.every(k=>Array.isArray(x.choices[k]) && x.choices[k].every(v=>typeof v==='string'))
    && typeof x.noOwner==='boolean' && Object.hasOwn(slaOptions,x.sla) && Object.hasOwn(createdOptions,x.created)
    && Object.hasOwn(queueOptions,x.queueTime) && [x.slaMin,x.slaMax,x.queueMin,x.queueMax].every(v=>typeof v==='string' && (!v || (Number.isFinite(Number(v)) && Number(v)>=0)))
    && [x.dateFrom,x.dateTo].every(v=>typeof v==='string' && (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)))
    && validSort(x.sort) && (x.deadlineList===undefined || validSort(x.deadlineList?.sort));
}
function readSettings(key:string, login:string):Settings {
  try {
    const stored=localStorage.getItem(key);
    if (stored!==null) {
      const settings:unknown=JSON.parse(stored);
      return validSettings(settings) ? settings : defaults;
    }
    const legacy=localStorage.getItem('mts.dashboard.views.v1.'+login);
    if (legacy) {
      const current=JSON.parse(legacy,(field,v)=>field==='groupMode' ? undefined : v)?.current;
      if (validSettings(current)) return current;
    }
  } catch { /* Settings can be unavailable in private browsing. */ }
  return defaults;
}
function useViewModel(login:string) {
  const {snapshot,now,formats}=useLive();
  const key='mts.dashboard.filters.v1.'+login;
  const [settings,setSettings]=useState(()=>readSettings(key,login));
  const [storageError,setStorageError]=useState(false);
  const [query,setQuery]=useState('');
  function save(next:Settings) {
    setSettings(next);
    try {localStorage.setItem(key,JSON.stringify(next));setStorageError(false);}
    catch {setStorageError(true);}
  }
  const index=useMemo(()=>buildIndex(snapshot,formats.dateFormat),[snapshot,formats]);
  const result=useMemo(()=>selectRows(index,snapshot,settings,query,now),[index,snapshot,settings,query,now]);
  function patch(change:Partial<Settings>) { save({...settings,...change}); }
  function toggleChoice(field:Facet, key:string) {
    const choices={...settings.choices,[field]:toggle(settings.choices[field],key)};
    if (field==='assignedGroupName' && choices.assignedEmployee.length) {
      const eligible=employeesForTeams(index,choices.assignedGroupName);
      if (eligible) choices.assignedEmployee=choices.assignedEmployee.filter(person=>eligible.has(person));
    }
    patch({choices,noOwner:field==='assignedEmployee' ? false : settings.noOwner});
  }
  function reset() {save(defaults);setQuery('');}
  function clearFilters() {save({...defaults,sort:settings.sort});setQuery('');}
  const sort = settings.deadlineList?.sort ?? settings.sort;
  function setSort(next:Sort[]) {patch(settings.deadlineList ? {deadlineList:{sort:next}} : {sort:next});}
  return {query,setQuery,index,result,settings,sort,patch,toggleChoice,reset,clearFilters,setSort,storageError};
}
const Context=createContext<ReturnType<typeof useViewModel>|null>(null);
export function ViewProvider({login,children}:{login:string;children:ReactNode}) {
  const model=useViewModel(login);
  return <Context.Provider value={model}>{children}</Context.Provider>;
}
export function useViews() {
  const model=useContext(Context);
  if (!model) throw new Error('Missing dashboard views');
  return model;
}
