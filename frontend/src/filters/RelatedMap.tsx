import { useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, GitFork, Link2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { active, pathFor, type Incident } from '../api';
import './relations.css';

const pageSize = 4;
const normalized = (text?: string | null) => text?.trim().toLocaleLowerCase('ru') ?? '';

export function defaultBase(items: Incident[]) {
  const products = new Map<string, number>();
  for (const item of items) {
    const product = normalized(item.productName);
    if (product) products.set(product, (products.get(product) ?? 0) + 1);
  }
  return items.find(item => (products.get(normalized(item.productName)) ?? 0) > 1) ?? items[0];
}

type Props = {base: Incident; items: Incident[]; onOpenIncident: () => void};

export function RelatedMap({base, items, onOpenIncident}: Props) {
  const [page, setPage] = useState(0);
  const product = normalized(base.productName);
  const service = normalized(base.service);
  const neighbors = items
    .filter(item => item.id !== base.id && product !== '' && normalized(item.productName) === product)
    .map(item => ({item, sameService: service !== '' && normalized(item.service) === service}))
    .sort((a, b) => Number(b.sameService) - Number(a.sameService)
      || Number(active(b.item)) - Number(active(a.item))
      || a.item.id.localeCompare(b.item.id, 'ru', {numeric:true}));
  const pages = Math.ceil(neighbors.length / pageSize);
  const current = Math.min(page, Math.max(0, pages - 1));
  const visible = neighbors.slice(current * pageSize, (current + 1) * pageSize);

  function branch(side: 'left' | 'right', offset: number) {
    const nodes = visible.filter((_, index) => index % 2 === offset);
    if (!nodes.length) return null;
    return <div className={'relation-branch ' + side}>{nodes.map(({item, sameService}) =>
      <Link key={item.id} className="relation-node" to={pathFor(item.id)} onClick={onOpenIncident}>
        <span className="relation-id">{item.id}<ArrowUpRight size={13} aria-hidden="true"/></span>
        <strong>{item.header || 'Без названия'}</strong>
        <span className="relation-status">{item.state || item.stateEnum}</span>
        <span className="relation-note"><Link2 size={13} aria-hidden="true"/>
          {sameService ? 'Тот же продукт и сервис' : 'Тот же продукт'}</span>
      </Link>)}</div>;
  }

  return <section aria-label="Карта возможных связей">
    <div className="relation-heading"><h3><GitFork size={17} aria-hidden="true"/> Возможные связи</h3><span>{neighbors.length}</span></div>
    <p className="relation-caption">Совпадения по названиям продукта и сервиса в текущей выборке.</p>
    <div className="relation-map">
      <Link className="relation-anchor" to={pathFor(base.id)} onClick={onOpenIncident}>
        <span className="relation-id">{base.id}<ArrowUpRight size={13} aria-hidden="true"/></span>
        <strong>{base.header || 'Без названия'}</strong>
        {base.productName && <span className="relation-product">{base.productName}</span>}
        {base.service && <span className="relation-status">{base.service}</span>}
      </Link>
      {branch('left', 0)}{branch('right', 1)}
    </div>
    {!neighbors.length && <p className="relation-empty">В выборке нет других инцидентов с таким же продуктом.</p>}
    {pages > 1 && <div className="relation-pagination">
      <button type="button" aria-label="Предыдущие связи" disabled={current === 0}
        onClick={()=>setPage(current - 1)}><ChevronLeft size={16}/></button>
      <span aria-live="polite">{current * pageSize + 1}–{current * pageSize + visible.length} из {neighbors.length}</span>
      <button type="button" aria-label="Следующие связи" disabled={current === pages - 1}
        onClick={()=>setPage(current + 1)}><ChevronRight size={16}/></button>
    </div>}
  </section>;
}
