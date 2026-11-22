import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { ArrowUpRight, Crosshair, Diamond, Minus, Plus, Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { pathFor, type Incident } from '../api';
import { IncidentTooltip } from './IncidentTooltip';
import './graph.css';

type Point = {x: number; y: number};
type Camera = Point & {zoom: number};
type Node = Point & {item: Incident; product: string; service: string};
type Cluster = Point & {name: string; key: string; width: number; height: number; tone: number; nodes: Node[]};
const normalize = (text?: string | null) => (text ?? '').trim().toLocaleLowerCase('ru');
const collator = new Intl.Collator('ru', {numeric:true});
const clamp = (number: number, low: number, high: number) => Math.min(high, Math.max(low, number));
const CARD_WIDTH = 106;
const CARD_HEIGHT = 42;
const CARD_GAP = 10;

function caption(text: string) {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > 18) {
      lines.push(line);
      line = '';
      if (lines.length === 2) break;
    }
    const part = word.length > 18 ? word.slice(0,17) + '…' : word;
    line = line ? line + ' ' + part : part;
  }
  if (line && lines.length < 2) lines.push(line);
  if (lines.length === 2 && lines.join(' ').length < text.trim().length) {
    lines[1] = lines[1].slice(0,17).replace(/…$/, '') + '…';
  }
  return lines;
}

function layout(items: Incident[]) {
  const products = new Map<string, Incident[]>();
  for (const item of items) {
    const key = normalize(item.productName);
    const group = products.get(key);
    if (group) group.push(item); else products.set(key, [item]);
  }
  const groups = [...products.entries()].sort(([a, left], [b, right]) =>
    right.length - left.length || collator.compare(a,b));
  const blocks = groups.map(([key, members]) => {
    const columns = members.length === 1 ? 1 : 2 * Math.ceil(Math.sqrt(members.length / 14));
    const rows = Math.ceil(members.length / columns);
    const width = columns * (CARD_WIDTH + CARD_GAP) + (columns === 1 ? 10 : 64);
    const height = rows * (CARD_HEIGHT + CARD_GAP) + 32;
    return {key, members, columns, width, height};
  });
  // Cluster bounds include the cards themselves and a clear band for the product name.
  const gutter = 20;
  const area = blocks.reduce((sum, b) => sum + (b.width + gutter) * (b.height + gutter), 0);
  const wrap = Math.max(1, Math.sqrt(area * 1.55), ...blocks.map(b=>b.width));
  const clusters: Cluster[] = [];
  let left = 0, top = 0, shelfHeight = 0, width = 1, height = 1;
  for (const b of blocks) {
    if (left && left + b.width > wrap) {left = 0; top += shelfHeight + gutter; shelfHeight = 0;}
    const x = left + b.width / 2, y = top + b.height / 2;
    const sorted = b.members.sort((a,b)=>collator.compare(normalize(a.service),normalize(b.service)) || collator.compare(a.id,b.id));
    const nodes = sorted.map((item,i) => {
      const col = i % b.columns, row = Math.floor(i / b.columns);
      const countRows = Math.ceil(sorted.length/b.columns);
      const outward = 8 + 14*Math.sin(Math.PI*(row+.5)/countRows);
      return {item, product:b.key, service:normalize(item.service),
        x:x + (col - (b.columns - 1)/2) * (CARD_WIDTH + CARD_GAP)
          + (b.columns === 1 ? 0 : col < b.columns / 2 ? -outward : outward),
        y:top + 37 + row * (CARD_HEIGHT + CARD_GAP) + CARD_HEIGHT/2};
    });
    clusters.push({key:b.key, name:sorted[0].productName?.trim() || '', x,y,width:b.width,height:b.height,
      nodes,tone:clusters.length % 5});
    width = Math.max(width,left + b.width); height = Math.max(height,top + b.height);
    left += b.width + gutter; shelfHeight = Math.max(shelfHeight,b.height);
  }
  return {clusters,nodes:clusters.flatMap(c=>c.nodes),center:{x:width/2,y:height/2},width,height};
}

export function RelatedMap({items,onOpenIncident}:{items:Incident[];onOpenIncident:()=>void}) {
  const graph = useMemo(()=>layout(items),[items]);
  const svg = useRef<SVGSVGElement>(null);
  const [size,setSize] = useState({width:640,height:340});
  const [camera,setCamera] = useState<Camera | 'initial' | null>('initial');
  const [selected,setSelected] = useState('');
  const [hover,setHover] = useState('');
  const [query,setQuery] = useState('');
  const [searchOpen,setSearchOpen] = useState(false);
  const listId = useId();
  const tooltipId = useId();
  const cardClip = useId();
  const [cursor,setCursor] = useState(0);
  const selectedNode = graph.nodes.find(n=>n.item.id===selected);
  const cluster = selectedNode && graph.clusters.find(c=>c.key===selectedNode.product);
  const neighbors = cluster?.key ? cluster.nodes.filter(n=>n!==selectedNode) : [];
  const sameService = neighbors.filter(n=>selectedNode?.service && n.service===selectedNode.service);
  const fit = Math.max(.001, Math.min((size.width-34)/graph.width,(size.height-32)/graph.height,1.7));
  const first = graph.clusters[0];
  const overview = {...graph.center,zoom:1};
  // Start a dense snapshot at reading size; fit remains available as a full overview.
  const initialZoom = Math.min(10,1.35/fit);
  const initialX = size.width/(2*fit*initialZoom), initialY = size.height/(2*fit*initialZoom);
  const initialView = first && fit < 1.15
    ? {x:clamp(first.x,Math.min(graph.center.x,initialX),Math.max(graph.center.x,graph.width-initialX)),
       y:clamp(first.y,Math.min(graph.center.y,initialY),Math.max(graph.center.y,graph.height-initialY)),zoom:initialZoom}
    : overview;
  const view = camera === 'initial' ? initialView : camera ?? overview;
  const scale = Math.max(.001,fit)*view.zoom;
  const project = (p:Point):Point => ({x:(p.x-view.x)*scale+size.width/2, y:(p.y-view.y)*scale+size.height/2});
  const cardScale = Math.min(scale,1.7);
  const hovering = graph.nodes.find(n=>n.item.id===hover);
  const hoverCenter = hovering && project(hovering);
  const tipAnchor = hoverCenter && {
    x:hoverCenter.x, y:hoverCenter.y-CARD_HEIGHT*cardScale/2, bottom:hoverCenter.y+CARD_HEIGHT*cardScale/2,
  };
  const visibleTip = tipAnchor && tipAnchor.x >= 0 && tipAnchor.x <= size.width && tipAnchor.bottom >= 0 && tipAnchor.y <= size.height;
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
      const v=old === 'initial' ? initialView : old ?? overview;
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
    if (!(e.target as Element).closest('[data-incident-id]')) setHover('');
    if (pointers.current.size) dragged.current=true;
    else {dragged.current=false;travel.current=0;}
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
    dragged.current=true;setHover('');
    if (other) {
      const distance=Math.hypot(p.x-other.x,p.y-other.y);
      const before=Math.hypot(previous.x-other.x,previous.y-other.y);
      if (distance>1 && before>1) zoomAt(distance/before,center(previous,other),center(p,other));
    } else zoomAt(1,previous,p);
  }
  function focusSearch(node:Node) {
    setHover('');setSelected(node.item.id);setCamera({x:node.x,y:node.y,zoom:Math.min(10,Math.max(view.zoom,1.35/fit))});
    setQuery(node.item.id);setSearchOpen(false);
  }
  const focalPoint = {x:size.width/2,y:size.height/2};
  const legend = <div className="graph-legend"><span><Diamond size={10}/>Продукт</span><span><i/>Инцидент</span>
    {sameService.length > 0 && <span><i className="graph-legend-service"/>Общий сервис</span>}
  </div>;
  return <div className="incident-graph" onKeyDown={e=>{
    if (e.key==='Escape' && hover) {e.preventDefault();e.stopPropagation();setHover('');}
  }}>
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
        onClick={e=>{
          if (e.target===e.currentTarget && !dragged.current) {
            setSelected('');
            setHover('');
          }
        }}
        onPointerUp={e=>pointers.current.delete(e.pointerId)} onPointerCancel={e=>pointers.current.delete(e.pointerId)}
        onLostPointerCapture={e=>pointers.current.delete(e.pointerId)}>
        <defs><clipPath id={cardClip}><rect x={-CARD_WIDTH/2+6} y={-CARD_HEIGHT/2+2}
          width={CARD_WIDTH-12} height={CARD_HEIGHT-4}/></clipPath></defs>
        {graph.clusters.map(c=>{
          const labelCenter=project({x:c.x,y:c.y-c.height/2+15});
          const hub=project({x:c.x,y:c.nodes.length===1 ? c.y-c.height/2+25 : c.y+14});
          const grouped=!!c.key, focused=c===cluster;
          const labelScale=Math.min(scale,1.45);
          const label=c.name.length>Math.floor(c.width/6.8) ? c.name.slice(0,Math.floor(c.width/6.8)-1)+'…' : c.name;
          return <g key={c.key} className={'graph-cluster graph-tone-'+c.tone} data-muted={!!cluster && !focused}>
            {grouped && <g aria-hidden="true">{c.nodes.map(n=>{
              const p=project(n);
              const endX=p.x-Math.sign(p.x-hub.x)*CARD_WIDTH*cardScale/2;
              const endY=p.x===hub.x ? p.y-CARD_HEIGHT*cardScale/2 : p.y;
              const mid=(hub.x+endX)/2;
              return <path key={n.item.id} d={`M ${hub.x} ${hub.y} C ${mid} ${hub.y}, ${mid} ${endY}, ${endX} ${endY}`}
                fill="none" className="graph-edge" data-on={n===selectedNode}/>;
            })}<g transform={'translate('+hub.x+' '+hub.y+') scale('+labelScale+')'}>
              <rect className="graph-hub" x="-3.5" y="-3.5" width="7" height="7" rx="1" transform="rotate(45)"/>
              <text className="graph-labels" textAnchor="middle" y={(labelCenter.y-hub.y)/labelScale}>{label}</text>
            </g></g>}
            {focused && selectedNode && sameService.map(n=>{
              const p=project(n), s=project(selectedNode);
              return <line key={n.item.id} className="graph-service-edge" x1={s.x} y1={s.y} x2={p.x} y2={p.y}/>;
            })}
            {c.nodes.map(n=>{
              const p=project(n), chosen=selectedNode===n;
              const title=n.item.header || 'Без названия';
              return <g transform={'translate('+p.x+' '+p.y+') scale('+cardScale+')'} key={n.item.id} data-incident-id={n.item.id}
                className="graph-node" data-selected={chosen} tabIndex={0} role="button" aria-label={n.item.id+' · '+title}
                aria-describedby={visibleTip && hover===n.item.id?tooltipId:undefined} aria-pressed={chosen}
                onClick={()=>{if(!dragged.current){setSelected(n.item.id);setHover(n.item.id);}}}
                onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(n.item.id);setHover(n.item.id);}}}
                onPointerEnter={e=>{if(e.pointerType!=='touch'&&!pointers.current.size)setHover(n.item.id);}}
                onPointerLeave={e=>{if(e.pointerType!=='touch')setHover('');}}
                onFocus={()=>setHover(n.item.id)} onBlur={()=>setHover('')}>
                <rect className="graph-card-body" x={-CARD_WIDTH/2} y={-CARD_HEIGHT/2} width={CARD_WIDTH} height={CARD_HEIGHT} rx="4"/>
                <rect className="graph-card-accent" data-level={n.item.priorityId ?? 0} x={-CARD_WIDTH/2+2} y="-12" width="2.5" height="24" rx="1.2"/>
                <g clipPath={'url(#'+cardClip+')'} pointerEvents="none">
                  <text className="graph-card-id" x="-45" y="-9">{n.item.id}</text>
                  <text className="graph-card-title">{caption(title).map((line,i)=>
                    <tspan x="-45" y={3+i*11} key={i}>{line}</tspan>)}</text>
                </g>
              </g>;
            })}
          </g>;
        })}
      </svg>
      {hovering && tipAnchor && visibleTip && <IncidentTooltip id={tooltipId} item={hovering.item} anchor={tipAnchor} bounds={size}/>}
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
