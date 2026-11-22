import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowUpRight, Crosshair, Diamond, Minus, Plus, Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { pathFor, type Incident } from '../api';
import './graph.css';

type Point = {x: number; y: number};
type Camera = Point & {zoom: number};
type Node = Point & {item: Incident; product: string; service: string};
type Cluster = Point & {name: string; key: string; radius: number; tone: number; nodes: Node[]};
const normalize = (text?: string | null) => (text ?? '').trim().toLocaleLowerCase('ru');
const collator = new Intl.Collator('ru', {numeric:true});
const clamp = (number: number, low: number, high: number) => Math.min(high, Math.max(low, number));
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function layout(items: Incident[]) {
  const products = new Map<string, Incident[]>();
  for (const item of items) {
    const key = normalize(item.productName);
    const group = products.get(key);
    if (group) group.push(item); else products.set(key, [item]);
  }
  const groups = [...products.entries()].sort(([a, left], [b, right]) =>
    right.length - left.length || collator.compare(a,b));
  const clusters: Cluster[] = [];
  // Pack product clusters on a spiral. Coordinates stay independent of zoom and window size.
  let searchRadius = 0;
  for (const [key, members] of groups) {
    const radius = 34 + Math.ceil(Math.sqrt(members.length) * 17);
    let x = 0, y = 0;
    if (clusters.length) {
      let distance = Math.max(0, searchRadius - radius * 3);
      let angle = clusters.length * GOLDEN_ANGLE;
      while (clusters.some(c => Math.hypot(x-c.x, y-c.y) < c.radius + radius + 12)) {
        angle += 0.48;
        distance += 1.8;
        x = 1.32 * distance * Math.cos(angle);
        y = distance * Math.sin(angle);
      }
      searchRadius = distance;
    }
    const sorted = members.sort((a,b) => collator.compare(normalize(a.service), normalize(b.service)) || collator.compare(a.id,b.id));
    const phase = clusters.length * GOLDEN_ANGLE;
    const nodes = sorted.map((item,i) => {
      const angle = phase + i * Math.PI * 2 / sorted.length;
      const arm = sorted.length <= 12 ? radius * (i % 2 ? .78 : .62) : 18 + Math.sqrt((i + 1) / sorted.length) * (radius - 30);
      const a = sorted.length <= 12 ? angle : phase + i * GOLDEN_ANGLE;
      return {item, product:key, service:normalize(item.service), x:x + arm * Math.cos(a), y:y + arm * Math.sin(a)};
    });
    clusters.push({key, name:members[0].productName?.trim() || '', x, y, radius, nodes, tone:clusters.length % 5});
  }
  const left = Math.min(0, ...clusters.map(c=>c.x-c.radius)), right = Math.max(1, ...clusters.map(c=>c.x+c.radius));
  const top = Math.min(0, ...clusters.map(c=>c.y-c.radius)), bottom = Math.max(1, ...clusters.map(c=>c.y+c.radius));
  return {clusters, nodes:clusters.flatMap(c=>c.nodes), center:{x:(left+right)/2,y:(top+bottom)/2},
    width:right-left, height:bottom-top};
}

export function RelatedMap({items,onOpenIncident}:{items:Incident[];onOpenIncident:()=>void}) {
  const graph = useMemo(()=>layout(items),[items]);
  const svg = useRef<SVGSVGElement>(null);
  const [size,setSize] = useState({width:640,height:340});
  const [camera,setCamera] = useState<Camera | null>(null);
  const [selected,setSelected] = useState('');
  const [hover,setHover] = useState('');
  const [query,setQuery] = useState('');
  const [searchOpen,setSearchOpen] = useState(false);
  const listId = useId();
  const [cursor,setCursor] = useState(0);
  const selectedNode = graph.nodes.find(n=>n.item.id===selected);
  const cluster = selectedNode && graph.clusters.find(c=>c.key===selectedNode.product);
  const neighbors = cluster?.key ? cluster.nodes.filter(n=>n!==selectedNode) : [];
  const sameService = neighbors.filter(n=>selectedNode?.service && n.service===selectedNode.service);
  const fit = Math.min((size.width-34)/graph.width,(size.height-32)/graph.height,1.7);
  const view = camera ?? {...graph.center,zoom:1};
  const scale = Math.max(.001,fit)*view.zoom;
  const project = (p:Point):Point => ({x:(p.x-view.x)*scale+size.width/2, y:(p.y-view.y)*scale+size.height/2});
  const search = normalize(query);
  const found = useMemo(()=>search ? graph.nodes.filter(({item})=>
    [item.id,item.header,item.productName,item.service].some(value=>normalize(value).includes(search)))
    .sort((a,b)=>Number(normalize(b.item.id)===search)-Number(normalize(a.item.id)===search)
      || collator.compare(a.item.id,b.item.id)) : [],[graph,search]);
  const results = found.slice(0,8);
  const activeResult = Math.min(cursor,results.length-1);

  useLayoutEffect(()=>{
    const el=svg.current;
    if (!el) return;
    const observer=new ResizeObserver(([{contentRect:{width,height}}])=>{
      if (width>0 && height>0) setSize({width,height});
    });
    observer.observe(el);
    return ()=>observer.disconnect();
  },[]);

  function zoomAt(factor:number, from:Point, to=from) {
    setCamera(old=>{
      const v=old ?? {...graph.center,zoom:1};
      const zoom=clamp(v.zoom*factor,.4,10);
      return {zoom, x:v.x+(from.x-size.width/2)/(fit*v.zoom)-(to.x-size.width/2)/(fit*zoom),
        y:v.y+(from.y-size.height/2)/(fit*v.zoom)-(to.y-size.height/2)/(fit*zoom)};
    });
  }
  const wheelAction = useRef(zoomAt);
  useLayoutEffect(()=>{wheelAction.current=zoomAt;});
  useEffect(()=>{
    const el=svg.current;
    if (!el) return;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();
      const rect=el.getBoundingClientRect();
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?rect.height:1);
      wheelAction.current(Math.exp(-clamp(delta,-160,160)*.003),{x:event.clientX-rect.left,y:event.clientY-rect.top});
    };
    el.addEventListener('wheel',wheel,{passive:false});
    return ()=>el.removeEventListener('wheel',wheel);
  },[]);

  const pointers=useRef(new Map<number,Point>());
  const dragged=useRef(false);
  const travel=useRef(0);
  const center=(a:Point,b:Point)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  function point(e:PointerEvent<SVGSVGElement>) {
    const rect=e.currentTarget.getBoundingClientRect();
    return {x:e.clientX-rect.left,y:e.clientY-rect.top};
  }
  function down(e:PointerEvent<SVGSVGElement>) {
    if (e.button!==0) return;
    if (!pointers.current.size) {dragged.current=false;travel.current=0;}
    pointers.current.set(e.pointerId,point(e));
    (e.target as Element).setPointerCapture(e.pointerId);
    setSearchOpen(false);
  }
  function move(e:PointerEvent<SVGSVGElement>) {
    const previous=pointers.current.get(e.pointerId);
    if (!previous) return;
    const p=point(e);
    const other=[...pointers.current].find(([id])=>id!==e.pointerId)?.[1];
    pointers.current.set(e.pointerId,p);
    travel.current+=Math.hypot(p.x-previous.x,p.y-previous.y);
    if (travel.current<3 && !other) return;
    dragged.current=true;
    if (other) {
      const distance=Math.hypot(p.x-other.x,p.y-other.y);
      const before=Math.hypot(previous.x-other.x,previous.y-other.y);
      if (distance>1 && before>1) zoomAt(distance/before,center(previous,other),center(p,other));
    } else zoomAt(1,previous,p);
  }
  function focusSearch(node:Node) {
    setSelected(node.item.id);setCamera({x:node.x,y:node.y,zoom:Math.max(view.zoom,2.2)});
    setQuery(node.item.id);setSearchOpen(false);
  }
  const focalPoint = {x:size.width/2,y:size.height/2};
  const legend = <div className="graph-legend"><span><Diamond size={10}/>Продукт</span><span><i/>Инцидент</span>
    {sameService.length > 0 && <span><i className="graph-legend-service"/>Общий сервис</span>}
  </div>;
  // Prefer the active product label when space is too tight for all labels at overview scale.
  const labels: {text:string; x:number; y:number; half:number}[]=[];
  for (const c of [cluster,...graph.clusters.filter(g=>g!==cluster)]) {
    if (!c?.name) continue;
    const {x,y}=project(c);
    const text=c.name.length>25 ? c.name.slice(0,24)+'…' : c.name;
    const half=text.length*3.25+4, labelY=y-11;
    if (x+half<0 || x-half>size.width || labelY<7 || labelY>size.height) continue;
    if (!labels.some(l=>Math.abs(l.y-labelY)<17 && Math.abs(l.x-x)<l.half+half)) {
      labels.push({text,x,y:labelY,half});
    }
  }
  return <div className="incident-graph">
    <div className="graph-toolbar">
      <div className="graph-search" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Element))setSearchOpen(false);}}>
        <Search size={15} aria-hidden="true"/>
        <input type="search" aria-label="Поиск на карте" placeholder="Поиск на карте" value={query}
          aria-controls={searchOpen && search ? listId : undefined}
          onChange={e=>{setQuery(e.target.value);setCursor(0);setSearchOpen(true);}}
          onFocus={()=>setSearchOpen(true)} onClick={()=>setSearchOpen(true)} onKeyDown={e=>{
            if (e.key==='Escape' && searchOpen) {e.stopPropagation(); setSearchOpen(false);}
            if (e.key==='ArrowDown' || e.key==='ArrowUp') {
              e.preventDefault();setSearchOpen(true);
              setCursor(i=>clamp(i+(e.key==='ArrowDown'?1:-1),0,Math.max(0,results.length-1)));
            }
            if (e.key==='Enter' && results[activeResult]) {e.preventDefault();focusSearch(results[activeResult]);}
          }}/>
        {query && <button type="button" aria-label="Очистить поиск на карте" onClick={()=>{setQuery('');setSearchOpen(false);}}><X size={13}/></button>}
        {searchOpen && search && <div className="graph-results" id={listId}>
          {results.map((n,i)=><button type="button" key={n.item.id} data-current={activeResult===i}
            onClick={()=>focusSearch(n)}><b>{n.item.id}</b><span>{n.item.header || n.item.productName}</span></button>)}
          {!results.length && <span role="status">Совпадений на карте нет</span>}
        </div>}
      </div>
      <div className="graph-zoom">
        <button type="button" aria-label="Отдалить" title="Отдалить" disabled={view.zoom<=.4} onClick={()=>zoomAt(1/1.3,focalPoint)}><Minus size={16}/></button>
        <span className="graph-scale">{Math.round(view.zoom*100)}%</span>
        <button type="button" aria-label="Приблизить" title="Приблизить" disabled={view.zoom>=10} onClick={()=>zoomAt(1.3,focalPoint)}><Plus size={16}/></button>
        <button type="button" aria-label="Вписать карту" title="Вписать карту" onClick={()=>setCamera(null)}><Crosshair size={16}/></button>
      </div>
    </div>
    <div className="graph-stage">
      <svg ref={svg} aria-label="Граф инцидентов по продуктам и сервисам" onPointerDown={down} onPointerMove={move}
        onPointerUp={e=>pointers.current.delete(e.pointerId)} onPointerCancel={e=>pointers.current.delete(e.pointerId)}
        onLostPointerCapture={e=>pointers.current.delete(e.pointerId)}>
        {graph.clusters.map(c=>{
          const hub=project(c), grouped=!!c.key, focused=c===cluster;
          return <g key={c.key} className={'graph-cluster graph-tone-'+c.tone} data-muted={!!cluster && !focused}>
            {grouped && <g aria-hidden="true">{c.nodes.map(n=>{
              const p=project(n);
              return <line key={n.item.id} x1={hub.x} y1={hub.y} x2={p.x} y2={p.y} className="graph-edge" data-on={n===selectedNode}/>;
            })}<rect className="graph-hub" x={hub.x-3.5} y={hub.y-3.5} width="7" height="7" rx="1" transform={'rotate(45 '+hub.x+' '+hub.y+')'}><title>{c.name}</title></rect></g>}
            {focused && selectedNode && sameService.map(n=>{
              const p=project(n), s=project(selectedNode);
              return <line key={n.item.id} className="graph-service-edge" x1={s.x} y1={s.y} x2={p.x} y2={p.y}/>;
            })}
            {c.nodes.map(n=>{
              const p=project(n), chosen=selectedNode===n, showId=chosen || hover===n.item.id;
              const title=n.item.id+' · '+(n.item.header || 'Без названия');
              return <g transform={'translate('+p.x+' '+p.y+')'} key={n.item.id} data-incident-id={n.item.id}
                className="graph-node" data-selected={chosen} tabIndex={0} role="button" aria-label={title} aria-pressed={chosen}
                onClick={()=>{if(!dragged.current)setSelected(n.item.id);}}
                onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(n.item.id);}}}
                onMouseEnter={()=>setHover(n.item.id)} onMouseLeave={()=>setHover('')}
                onFocus={()=>setHover(n.item.id)} onBlur={()=>setHover('')}>
                <title>{title}</title><circle r="11" fill="transparent"/>
                {chosen && <circle className="graph-halo" r="10"/>}
                <circle className="graph-dot" r={chosen?5.5:4}/>
                {showId && <text className="graph-id" x="9" y="4">{n.item.id}</text>}
              </g>;
            })}
          </g>;
        })}
        <g className="graph-labels" aria-hidden="true">{labels.map(l=><text key={l.text+l.x} x={l.x} y={l.y} textAnchor="middle">{l.text}</text>)}</g>
      </svg>
      {!!items.length && legend}
      {!items.length && <div className="graph-empty">Для текущих фильтров нет инцидентов.</div>}
    </div>
    {selectedNode && <div className="graph-inspector">
      <div><span className="graph-current-id">{selectedNode.item.id}</span>
        <strong>{selectedNode.item.header || 'Без названия'}</strong>
        <small>{cluster?.name || 'Продукт не указан'}{neighbors.length?' · С общим продуктом: '+neighbors.length:' · Совпадений нет'}
          {sameService.length>0 && ' · Из них с общим сервисом: '+sameService.length}</small>
      </div>
      <Link to={pathFor(selectedNode.item.id)} onClick={onOpenIncident} aria-label="Открыть инцидент" title="Открыть инцидент"><ArrowUpRight size={17}/></Link>
    </div>}
  </div>;
}
