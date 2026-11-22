import { memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, GitFork, Maximize2, Minus, MoveDiagonal2, X } from 'lucide-react';
import type { Incident } from '../api';
import { RelatedMap } from './RelatedMap';
import './relations.css';

type Rect = {left: number; top: number; width: number; height: number};
type Mode = 'floating' | 'maximized' | 'minimized';
type Point = Pick<Rect, 'left' | 'top'>;
type Gesture = {kind: 'move' | 'resize'; pointerId: number; x: number; y: number; rect: Rect};
// Clock ticks can produce a new result array containing exactly the same incident objects.
const Graph = memo(RelatedMap, (previous, next) => previous.onOpenIncident === next.onOpenIncident
  && previous.items.length === next.items.length
  && previous.items.every((item, index) => item === next.items[index]));

function viewport(): Rect {
  const width = document.documentElement.clientWidth;
  const bottom = Math.min(document.documentElement.clientHeight, window.visualViewport?.height ?? innerHeight);
  const top = Math.min(bottom, Math.max(0, document.querySelector('.dashboard-bar')?.getBoundingClientRect().bottom ?? 0));
  return {left: 0, top, width, height: bottom - top};
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fit(rect: Rect, screen: Rect): Rect {
  const width = clamp(rect.width, 320, screen.width);
  const height = clamp(rect.height, 330, screen.height);
  return {width, height, left: clamp(rect.left, 0, screen.width - width),
    top: clamp(rect.top, screen.top, screen.top + screen.height - height)};
}

function initialRect(screen: Rect): Rect {
  const margin = screen.width <= 600 ? 8 : 24;
  const width = Math.min(940, screen.width - margin * 2);
  const height = Math.min(620, screen.height - margin * 2);
  return fit({width, height, left: (screen.width - width) / 2, top: screen.top + (screen.height - height) / 2}, screen);
}

const keyboardSteps: Record<string, [number, number]> = {
  ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16],
};

export function RelationWindow({items, onClose, openRequest}: {
  items: Incident[]; onClose: () => void; openRequest?: number;
}) {
  const [screen, setScreen] = useState(viewport);
  const [normal, setNormal] = useState(() => initialRect(screen));
  const [mode, setMode] = useState<Mode>('floating');
  const [compact, setCompact] = useState<Point>({left: 0, top: 0});
  const previousMode = useRef<'maximized' | 'floating'>('floating');
  const request = useRef(openRequest);
  const panel = useRef<HTMLElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const miniWidth = Math.min(224, screen.width), miniHeight = Math.min(48, screen.height);
  const rect = mode === 'maximized' ? screen : mode === 'floating' ? fit(normal, screen) : {
    width: miniWidth, height: miniHeight, left: clamp(compact.left, 0, screen.width - miniWidth),
    top: clamp(compact.top, screen.top, screen.top + screen.height - miniHeight),
  };

  useLayoutEffect(() => {
    const update = () => setScreen(viewport());
    const header = document.querySelector('.dashboard-bar');
    const observer = new ResizeObserver(update);
    if (header) observer.observe(header);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  useLayoutEffect(() => {
    if (request.current !== openRequest) {
      request.current = openRequest;
      setMode(current => current === 'minimized' ? previousMode.current : current);
    }
    panel.current?.focus({preventScroll:true});
  }, [openRequest]);

  const minimize = useCallback(() => {
    if (mode === 'minimized') return;
    previousMode.current = mode;
    setCompact({left: 16, top: screen.top + screen.height - miniHeight - 16});
    setMode('minimized');
  }, [mode, screen.top, screen.height, miniHeight]);

  function close() {
    onClose();
    const trigger = document.querySelector<HTMLElement>('.filter-trigger') ?? document.querySelector<HTMLElement>('.mts-mark');
    trigger?.focus({preventScroll:true});
  }

  function start(event: PointerEvent<HTMLElement>, kind: Gesture['kind']) {
    if (mode === 'maximized' || !event.isPrimary || event.button !== 0) return;
    if (kind === 'move' && (event.target as Element).closest('button')) return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll:true});
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {kind, pointerId:event.pointerId, x:event.clientX, y:event.clientY, rect};
  }

  function adjust(kind: Gesture['kind'], origin: Rect, dx: number, dy: number) {
    if (kind === 'resize') {
      setNormal({...origin, width: clamp(origin.width + dx, 320, screen.width - origin.left),
        height: clamp(origin.height + dy, 330, screen.top + screen.height - origin.top)});
      return;
    }
    const position = {left: clamp(origin.left + dx, 0, screen.width - origin.width),
      top: clamp(origin.top + dy, screen.top, screen.top + screen.height - origin.height)};
    if (mode === 'minimized') setCompact(position);
    else setNormal({...origin, ...position});
  }

  function keyAdjust(event: KeyboardEvent<HTMLElement>, kind: Gesture['kind']) {
    if (mode === 'maximized' || event.target !== event.currentTarget || !keyboardSteps[event.key]) return;
    event.preventDefault();
    adjust(kind, rect, ...keyboardSteps[event.key]);
  }

  return createPortal(<section ref={panel} role="dialog" aria-labelledby="relation-window-title" tabIndex={-1}
    className="relation-window" data-mode={mode} style={rect}
    onKeyDown={e=>{if (e.key==='Escape') {e.preventDefault();close();}}}
    onPointerDownCapture={e => {
      if (!e.currentTarget.contains(document.activeElement)) e.currentTarget.focus({preventScroll:true});
    }}
    onPointerMove={e => {
      const drag = gesture.current;
      if (drag?.pointerId === e.pointerId) adjust(drag.kind, drag.rect, e.clientX - drag.x, e.clientY - drag.y);
    }}
    onLostPointerCapture={e => {if (gesture.current?.pointerId === e.pointerId) gesture.current = null;}}>
    <div className="relation-titlebar" role="group" aria-label="Управление окном" tabIndex={mode === 'maximized' ? -1 : 0}
      onPointerDown={e => start(e, 'move')} onKeyDown={e => keyAdjust(e, 'move')}>
      <span className="relation-window-symbol" aria-hidden="true"><GitFork size={18}/></span>
      <h2 id="relation-window-title">Карта связей</h2>
      <div className="relation-window-controls">
        {mode === 'minimized'
          ? <button type="button" aria-label="Восстановить карту" title="Восстановить карту"
              onClick={() => setMode(previousMode.current)}><Copy/></button>
          : <>
            <button type="button" aria-label="Свернуть карту" title="Свернуть карту" onClick={minimize}><Minus/></button>
            <button type="button" aria-label={mode === 'maximized' ? 'Восстановить размер карты' : 'Развернуть карту'}
              title={mode === 'maximized' ? 'Восстановить размер карты' : 'Развернуть карту'}
              onClick={() => setMode(mode === 'maximized' ? 'floating' : 'maximized')}>
              {mode === 'maximized' ? <Copy/> : <Maximize2/>}
            </button>
          </>}
        <button type="button" aria-label="Закрыть карту" title="Закрыть карту" onClick={close}><X/></button>
      </div>
    </div>
    <div className="relation-window-body" hidden={mode === 'minimized'}><Graph items={items} onOpenIncident={minimize}/></div>
    {mode === 'floating' && <button type="button" className="relation-window-resize" aria-label="Изменить размер карты"
      title="Изменить размер карты" onPointerDown={e => start(e, 'resize')} onKeyDown={e => keyAdjust(e, 'resize')}>
      <MoveDiagonal2 size={15}/>
    </button>}
  </section>, document.body);
}
