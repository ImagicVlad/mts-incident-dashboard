import { signIn } from './auth';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { displayFormats, type Incident, type Snapshot } from '../src/api';
import { buildIndex, defaults, selectRows, type Settings } from '../src/filters/incidentViews';

const coord='КЦ ИТ Координаторы Массовых Инцидентов';
const file=process.env.E2E_SOURCE!;
async function publish(data:string) {
  await writeFile(file+'.writing',data,'utf8');
  // On Windows the live-source watcher can still have the previous snapshot open.
  await expect(async()=>{await rename(file+'.writing',file);}).toPass({timeout:1500,intervals:[50,100,200]});
}
function incidents(now:number) {
  const at=(minutes:number)=>new Date(now+minutes*60000).toISOString();
  function record(id:number, props:Partial<Incident>={}):Incident {
    return {id:'LAB-'+id,sysId:'lab-'+id,header:'Проверка канала '+id,productName:'Домашний интернет',service:'Доступ',
      priorityId:4,priority:'Наивысший',stateEnum:'Assigned',state:'Назначен',description:null,shortDescription:null,
      assignedGroupName:'Сеть',assignedEmployee:'Дежурный А',submitDate:at(-20),deadline:at(25),completionDate:null,
      solution:null,itsmUrl:null,lastAssignmentToTeamDateTime:null,diagnostics:[],...props};
  }
  return [
    record(2,{deadline:at(-75),assignedGroupName:coord,assignedEmployee:null,submitDate:at(-120),lastAssignmentToTeamDateTime:at(-70)}),
    record(10),record(3,{priorityId:3,priority:'Высокий',deadline:at(300),productName:'Кошелёк',assignedGroupName:coord,lastAssignmentToTeamDateTime:at(-8)}),
    record(11,{stateEnum:'Research',state:'Исследование ситуации',assignedGroupName:coord,productName:'Видео',deadline:at(-120),lastAssignmentToTeamDateTime:at(-90)}),
    record(12,{stateEnum:'Closed',state:'Закрыт',deadline:at(-90)}),
    record(20,{deadline:null,productName:'Платформа',submitDate:at(-15000)}),
    record(8,{deadline:at(70),productName:'Кошелёк'}),record(5,{deadline:at(-20),productName:'Видео'}),
  ];
}
const test=base.extend<{records:Incident[]}>({records:async({},use)=>{
  const previous=await readFile(file,'utf8');
  const records=incidents(Date.now());
  try {await publish(JSON.stringify(records));await use(records);} finally {await publish(previous);}
}});
async function login(page:Page) {
  await page.goto('/login');
  await signIn(page);
  await expect(page.getByTestId('group-critical').locator('.incident').first()).toBeVisible();
}
async function open(page:Page) {
  await page.getByRole('banner').getByRole('button',{name:/Фильтры/}).click();
  return page.getByRole('dialog',{name:'Настройки списка инцидентов'});
}
const count=(page:Page)=>page.locator('.active-filters > strong');
const sortButton=(panel:Locator)=>panel.getByRole('button',{name:'Сортировка',exact:true});
const ids=(page:Page,g:string)=>page.getByTestId('group-'+g).locator('.incident').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-incident-id')));
function backgroundPoint(map:Locator) {
  return map.locator('.graph-stage > svg').evaluate(svg=>{
    const r=svg.getBoundingClientRect();
    for (const across of [.08,.92,.5]) for (const down of [.08,.92,.5]) {
      const x=r.x+r.width*across, y=r.y+r.height*down;
      if (document.elementFromPoint(x,y)===svg) return {x,y};
    }
    throw new Error('Не найден свободный участок карты');
  });
}
async function chooseTimeOption(page:Page,panel:Locator,field:string,option:string) {
  await panel.getByRole('button',{name:field,exact:true}).click();
  await page.getByRole('listbox').getByRole('option',{name:option,exact:true}).click();
}

test('быстрый выбор объединяет очереди и сохраняет подходящие инциденты при переназначении',async({page,records})=>{
  await login(page);
  const categories=page.getByRole('navigation',{name:'Группы инцидентов'});
  await expect(categories.getByRole('link')).toHaveCount(4);
  const panel=await open(page);
  await expect(panel.locator('.filter-tabs button')).toHaveText(['Фильтры','Расширенные']);
  await expect(panel.getByRole('button',{name:'Мои представления'})).toHaveCount(0);
  await expect(sortButton(panel)).toContainText('По умолчанию');
  await expect(panel.locator('summary').filter({hasText:'Текущая команда'})).toBeHidden();
  await expect(panel.locator('summary').filter({hasText:'Категории'})).toHaveCount(0);
  await expect(panel.getByLabel('Совпадение категорий')).toHaveCount(0);
  await panel.getByRole('button',{name:'Критические',exact:true}).click();
  await expect(count(page)).toHaveText('Найдено 5');
  await expect(categories).toHaveCount(0);
  await panel.getByRole('button',{name:'На координаторах',exact:true}).click();
  await expect(count(page)).toHaveText('Найдено 7');
  await panel.getByRole('button',{name:/^Расширенные/}).click();
  await expect(panel.getByText('Быстрый выбор',{exact:true})).toBeHidden();
  await expect(sortButton(panel)).toBeHidden();
  await panel.locator('summary').filter({hasText:'SLA и время'}).click();
  await chooseTimeOption(page,panel,'Состояние SLA','Диапазон просрочки');
  await panel.getByLabel('От, мин',{exact:true}).fill('30');
  await panel.getByRole('button',{name:'Готово'}).click();
  const criticalCount=page.getByTestId('group-critical').getByRole('heading').locator('.count');
  await expect(criticalCount).toHaveText('1 из 5');
  await expect(page.getByTestId('group-assigned')).toContainText('LAB-2');
  const added={...records[0],id:'LAB-100',sysId:'lab-100'};
  await publish(JSON.stringify([...records,added]));
  await expect(count(page)).toHaveText('Найдено 2');
  await expect(page.getByTestId('group-critical')).toContainText(added.id);
  await expect(criticalCount).toHaveText('2 из 6');
  added.assignedGroupName='Сеть';
  await publish(JSON.stringify([...records,added]));
  await expect(page.getByTestId('group-assigned')).not.toContainText(added.id);
  await expect(page.getByTestId('group-critical')).toContainText(added.id);
  await expect(count(page)).toHaveText('Найдено 2');
  await open(page);
  await panel.getByRole('button',{name:'Фильтры',exact:true}).click();
  await panel.getByRole('button',{name:'Критические',exact:true}).click();
  await panel.getByRole('button',{name:'Готово'}).click();
  await expect(count(page)).toHaveText('Найдено 1');
  records[0].stateEnum='Resolved';records[0].state='Завершен';
  await publish(JSON.stringify([...records,added]));
  await expect(count(page)).toHaveText('Найдено 0');
  await expect(page.getByTestId('group-assigned')).toContainText('По выбранным условиям совпадений нет');
  await page.getByTestId('group-assigned').getByRole('button',{name:'Сбросить условия'}).click();
  await expect(categories.getByRole('link')).toHaveCount(4);
  await expect(page.getByTestId('group-history')).toContainText('LAB-2');
});

test('карта связей открывается отдельно, масштабируется и восстанавливает выбранный инцидент',async({page,records})=>{
  await page.setViewportSize({width:1440,height:900});
  await login(page);
  const panel=await open(page);
  await panel.getByRole('button',{name:'Критические',exact:true}).click();
  await panel.getByRole('button',{name:'Расширенные',exact:true}).click();
  const launch=panel.getByRole('button',{name:'Карта связей',exact:true});
  await launch.click();
  await expect(panel).toBeHidden();
  const map=page.getByRole('dialog',{name:'Карта связей',exact:true});
  const control=(name:string)=>map.getByRole('button',{name,exact:true});
  await expect(map).toHaveAttribute('data-mode','floating');
  expect(records.length).toBe(8);
  const initial=(await map.boundingBox())!;
  const handle=(await map.locator('.relation-titlebar').boundingBox())!;
  const x=handle.x+60, y=handle.y+handle.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x-70,y+24,{steps:4});await page.mouse.up();
  await expect.poll(async()=>(await map.boundingBox())!.x).toBeCloseTo(initial.x-70,0);
  await control('Изменить размер карты').press('ArrowLeft');
  await expect.poll(async()=>(await map.boundingBox())!.width).toBeLessThan(initial.width);
  await expect(map.locator('[data-incident-id="LAB-12"]')).toHaveCount(0);
  const node=map.locator('[data-incident-id="LAB-2"]');
  await expect(node.locator('.graph-card-id')).toBeVisible();
  await expect(node.locator('.graph-card-id')).toHaveText('LAB-2');
  await expect(node.locator('.graph-card-title')).toBeVisible();
  await expect(node.locator('.graph-card-title')).toContainText('Проверка');
  const canvas=(await map.locator('.graph-stage > svg').boundingBox())!;
  const card=node.locator('.graph-card-body');
  const tooltip=map.getByRole('tooltip');
  await card.hover();
  await expect(tooltip).toContainText('Назначен координаторам');
  await expect(tooltip).toContainText(coord);
  await expect(tooltip).toContainText(displayFormats().time(records[0].deadline));
  const tip=(await tooltip.boundingBox())!, anchor=(await card.boundingBox())!;
  if (anchor.y-canvas.y>tip.height+16) expect(tip.y+tip.height).toBeLessThanOrEqual(anchor.y+1);
  await control('Приблизить').hover();
  await expect(tooltip).toBeHidden();
  await node.focus();
  await expect(tooltip).toBeVisible();
  await node.press('Escape');
  await expect(tooltip).toBeHidden();
  await card.click();
  await expect(map.locator('.graph-inspector')).toContainText('LAB-2');
  const scale=map.locator('.graph-scale');
  await control('Вписать карту').click();
  await expect(scale).toHaveText('100%');
  await control('Приблизить').click();
  await expect.poll(async()=>parseInt(await scale.innerText())).toBeGreaterThan(100);
  await control('Вписать карту').click();
  await control('Отдалить').click();
  await expect.poll(async()=>parseInt(await scale.innerText())).toBeLessThan(100);
  const zoom=await scale.innerText();
  const blank=await backgroundPoint(map);
  const originalPosition=await node.getAttribute('transform');
  await page.mouse.move(blank.x,blank.y);await page.mouse.down();
  await page.mouse.move(blank.x+24,blank.y+16,{steps:4});await page.mouse.up();
  await expect(node).not.toHaveAttribute('transform',originalPosition!);
  await expect(node).toHaveAttribute('aria-pressed','true');
  await expect(map.locator('.graph-inspector')).toContainText('LAB-2');
  const spot=await backgroundPoint(map);
  await page.mouse.click(spot.x,spot.y);
  await expect(node).toHaveAttribute('aria-pressed','false');
  await expect(map.locator('.graph-cluster[data-muted="true"]')).toHaveCount(0);
  await expect(map.locator('.graph-inspector')).toBeHidden();
  await expect(scale).toHaveText(zoom);
  await card.click();
  await expect(map.locator('.graph-inspector')).toContainText('LAB-2');

  await control('Развернуть карту').click();
  await expect(map).toHaveAttribute('data-mode','maximized');
  const banner=await page.getByRole('banner').boundingBox();
  expect((await map.boundingBox())!.y).toBeCloseTo(banner!.y+banner!.height,0);
  await control('Восстановить размер карты').click();
  await control('Свернуть карту').click();
  await expect(map).toHaveAttribute('data-mode','minimized');
  await open(page);
  await panel.getByRole('button',{name:'Расширенные',exact:true}).click();
  await launch.click();
  await expect(map).toHaveCount(1);
  await expect(map).toHaveAttribute('data-mode','floating');
  await expect(map.locator('.graph-inspector')).toContainText('LAB-2');
  await control('Закрыть карту').click();
  await expect(map).toHaveCount(0);
});

test.describe('Карта на телефоне',()=>{
  test.use({hasTouch:true});
  test('поиск на мобильной карте видит обновления смены и открывает карточку',async({page,records})=>{
    await page.setViewportSize({width:390,height:844});
    await login(page);
    const panel=await open(page);
    await panel.getByRole('button',{name:'Расширенные',exact:true}).click();
    await panel.getByRole('button',{name:'Карта связей',exact:true}).click();
    const map=page.getByRole('dialog',{name:'Карта связей',exact:true});
    await expect.poll(()=>map.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    const search=map.getByRole('searchbox',{name:'Поиск на карте'});
    await search.fill('Потеря пакетов');
    const result=map.locator('.graph-results').getByRole('button',{name:/LAB-21/});
    await expect(result).toHaveCount(0);
    const sibling={...records.find(item=>item.id==='LAB-20')!,id:'LAB-21',sysId:'lab-21',header:'Потеря пакетов',
      deadline:records[0].deadline};
    await publish(JSON.stringify([...records,sibling]));
    await expect(result).toBeVisible();
    await search.press('Enter');
    await expect(map.locator('.graph-inspector')).toContainText('LAB-21');
    await map.locator('[data-incident-id="LAB-21"] .graph-card-body').tap();
    const tip=map.getByRole('tooltip');
    await expect(tip).toContainText('Назначен команде');
    await expect(tip).toContainText(sibling.assignedGroupName!);
    await expect(tip).toContainText(displayFormats().time(sibling.deadline));
    const blank=await backgroundPoint(map);
    await page.touchscreen.tap(blank.x,blank.y);
    await expect(tip).toBeHidden();
    await expect(map.locator('.graph-inspector')).toBeHidden();
    await map.locator('[data-incident-id="LAB-21"] .graph-card-body').tap();
    await map.getByRole('link',{name:'Открыть инцидент'}).click();
    await expect(page).toHaveURL(/\/incidents\/LAB-21$/);
    await expect(page.getByRole('heading',{name:'Потеря пакетов',exact:true})).toBeVisible();
    await expect(map).toHaveAttribute('data-mode','minimized');
    await map.getByRole('button',{name:'Восстановить карту'}).click();
    await expect(map.locator('.graph-inspector')).toContainText('LAB-21');
    await map.getByRole('button',{name:'Закрыть карту'}).click();
    await expect(map).toHaveCount(0);
  });
});

test('расширенные фильтры работают с поиском, условия и сортировка восстанавливаются после перезагрузки',async({page,records})=>{
  await login(page);expect(records.length).toBe(8);
  const panel=await open(page);
  await panel.getByRole('button',{name:/^Расширенные/}).click();
  async function choose(facet:string,label:string) {
    const entry=panel.locator('.facet').filter({has:page.locator('summary').getByText(facet,{exact:false})});
    await entry.locator('summary').click();
    if (await entry.getByRole('textbox').count()) await entry.getByRole('textbox').fill(label.slice(0,4));
    await entry.getByLabel(label,{exact:true}).check();
  }
  await expect(panel.locator('summary').filter({hasText:'Текущая команда'})).toBeVisible();
  await expect(panel.locator('summary').filter({hasText:'Исполнитель'})).toBeVisible();
  await choose('Текущая команда','Сеть');
  await choose('Исполнитель','Дежурный А');
  await panel.locator('summary').getByText('Атрибуты инцидента').click();
  await choose('Продукт','Домашний интернет');
  await panel.getByLabel('Кошелёк',{exact:true}).check();
  await panel.locator('summary').getByText('SLA и время').click();
  await chooseTimeOption(page,panel,'Состояние SLA','Диапазон до срока');
  await panel.getByLabel('От, мин',{exact:true}).fill('20');await panel.getByLabel('До, мин',{exact:true}).fill('90');
  await expect(count(page)).toHaveText('Найдено 2');
  await panel.getByRole('button',{name:'Фильтры',exact:true}).click();
  await sortButton(panel).click();
  await page.getByRole('listbox').getByRole('option',{name:'Ближайший SLA',exact:true}).click();
  await page.keyboard.press('Escape');
  const search=page.getByRole('searchbox');
  await search.fill('LAB-1');
  await expect(page.locator('.search-results a')).toHaveCount(1);
  await expect(count(page)).toHaveText('Найдено 1');
  await search.press('Escape');
  await expect(count(page)).toHaveText('Найдено 2');
  await page.reload();
  await expect(count(page)).toHaveText('Найдено 2');
  await expect.poll(()=>ids(page,'critical')).toEqual(['LAB-10','LAB-8']);
  await open(page);
  await expect(sortButton(panel)).toContainText('Ближайший SLA');
  await page.keyboard.press('Escape');
  const stored=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('mts.dashboard.')).map(([,v])=>v).join(''));
  expect(stored).not.toBe('');
  for (const item of ['Дежурный А','Домашний интернет','LAB-10','Проверка канала']) expect(stored).not.toContain(item);
  await page.getByRole('button',{name:'Сбросить всё',exact:true}).click();
  await open(page);
  await expect(sortButton(panel)).toContainText('По умолчанию');
});

test('меню SLA, даты и очереди применяют выбранные условия и поддерживают клавиатуру',async({page,records})=>{
  records[0].submitDate='2025-04-17T23:00:00Z';
  await publish(JSON.stringify(records));
  await login(page);
  const panel=await open(page);
  await panel.getByRole('button',{name:'Расширенные',exact:true}).click();
  await panel.locator('summary').getByText('SLA и время').click();
  await chooseTimeOption(page,panel,'Состояние SLA','Просрочен');
  await expect(count(page)).toHaveText('Найдено 2');

  const dateButton=panel.getByRole('button',{name:'Дата возникновения',exact:true});
  const menu=page.getByRole('listbox');
  await dateButton.press('Enter');
  await expect(menu.getByRole('option',{name:'Любое время'})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('End');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(dateButton).toBeFocused();
  await expect(dateButton).toContainText('Любое время');
  await dateButton.press('Enter');
  await page.keyboard.press('End');
  await expect(menu.getByRole('option',{name:'Диапазон дат'})).toBeFocused();
  await page.keyboard.press('Enter');
  await panel.getByLabel('От',{exact:true}).fill('2025-04-18');
  await panel.getByLabel('До',{exact:true}).fill('2025-04-18');
  await expect(count(page)).toHaveText('Найдено 1');

  await chooseTimeOption(page,panel,'В очереди координаторов','Диапазон длительности');
  await panel.getByLabel('От, мин',{exact:true}).fill('60');
  await panel.getByLabel('До, мин',{exact:true}).fill('65');
  await expect(count(page)).toHaveText('Найдено 0');
  await panel.getByLabel('До, мин',{exact:true}).fill('80');
  await expect(count(page)).toHaveText('Найдено 1');
  await expect(page.getByTestId('group-assigned')).toContainText('LAB-2');
});

test('сортировка выше быстрого выбора и сохраняется при сбросе фильтров',async({page,records})=>{
  await login(page);expect(records.length).toBe(8);
  const panel=await open(page);
  const sort=sortButton(panel);
  const quickTitle=panel.getByText('Быстрый выбор',{exact:true});
  const top=await sort.boundingBox(), bottom=await quickTitle.boundingBox();
  expect(top!.y+top!.height).toBeLessThanOrEqual(bottom!.y);
  await expect(panel.getByRole('button',{name:'Все инциденты',exact:true})).toBeDisabled();

  const menu=page.getByRole('listbox');
  await sort.focus();await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option',{name:'По умолчанию',exact:true})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();await expect(panel).toBeVisible();
  await expect(sort).toBeFocused();await expect(sort).toContainText('По умолчанию');
  await page.keyboard.press('Enter');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();await expect(sort).toContainText('Ближайший SLA');

  const critical=panel.getByRole('button',{name:'Критические',exact:true});
  await critical.click();
  await expect(count(page)).toHaveText('Найдено 5');
  await panel.getByRole('button',{name:'Сбросить фильтры',exact:true}).click();
  await expect(critical).toHaveAttribute('aria-pressed','false');
  await expect(panel.getByRole('button',{name:'Все инциденты',exact:true})).toBeDisabled();
  await expect(sort).toContainText('Ближайший SLA');
  await expect(page.getByRole('navigation',{name:'Группы инцидентов'}).getByRole('link')).toHaveCount(4);
});

test('список исполнителей зависит от команд и сохраняет совместимые назначения',async({page,records})=>{
  const owners:Record<string,string> = {
    'LAB-2':'Дежурный координатор','LAB-10':'Сетевой инженер',
    'LAB-3':'Сменный инженер','LAB-8':'Сменный инженер','LAB-5':'Специалист биллинга',
  };
  await publish(JSON.stringify(records.map(item=>({...item,
    assignedEmployee:owners[item.id] ?? item.assignedEmployee,
    assignedGroupName:item.id==='LAB-5'?'Биллинг':item.assignedGroupName,
  }))));
  await login(page);
  const panel=await open(page);
  const recent=panel.getByRole('button',{name:'За последние сутки',exact:true});
  await recent.click();
  await panel.getByRole('button',{name:/^Расширенные/}).click();
  const teams=panel.locator('.facet').filter({has:page.locator('summary').getByText('Текущая команда')});
  const staff=panel.locator('.facet').filter({has:page.locator('summary').getByText('Исполнитель')});
  await teams.locator('summary').click();
  const network=teams.getByRole('checkbox',{name:'Сеть',exact:true});
  await network.check();
  await teams.getByRole('checkbox',{name:coord,exact:true}).check();
  await staff.locator('summary').click();
  const owner=(name:string)=>staff.getByRole('checkbox',{name,exact:true});
  await expect(owner('Специалист биллинга')).toHaveCount(0);
  await owner('Дежурный координатор').check();
  await owner('Сменный инженер').check();
  await owner('Сетевой инженер').check();
  await network.uncheck();
  await expect(owner('Сетевой инженер')).toHaveCount(0);
  await expect(owner('Сменный инженер')).toBeChecked();
  await expect(owner('Дежурный координатор')).toBeChecked();
  await expect(count(page)).toHaveText('Найдено 2');
  await network.check();
  await expect(owner('Сетевой инженер')).not.toBeChecked();
  await expect(owner('Сменный инженер')).toBeChecked();
  await panel.getByRole('button',{name:'Фильтры',exact:true}).click();
  await expect(recent).toHaveAttribute('aria-pressed','true');
});

test('текущие фильтры и сортировка из прежнего формата восстанавливаются',async({page,records})=>{
  await login(page);expect(records.length).toBe(8);
  const current={...defaults,groups:['critical','assigned'],groupMode:'all',sla:'overdue',sort:[{field:'upcoming',dir:'asc'}]};
  const saved={...defaults,groups:['high','assigned'],groupMode:'all'};
  await page.evaluate(p=>localStorage.setItem('mts.dashboard.views.v1.e2e.coordinator',JSON.stringify(p)),{
    current,views:[{id:'old-view',name:'Очереди смены',settings:saved}],
  });
  await page.reload();
  await expect(count(page)).toHaveText('Найдено 2');
  await expect(page.getByTestId('group-critical')).toContainText('LAB-5');
  const panel=await open(page);
  await expect(sortButton(panel)).toContainText('Ближайший SLA');
  await expect(panel.getByRole('button',{name:'Нарушен SLA',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(panel.getByRole('button',{name:'Мои представления'})).toHaveCount(0);
  await expect(panel.getByText('Очереди смены',{exact:true})).toHaveCount(0);
});

test('сортировка по нескольким уровням и управление на планшете и телефоне',async({page,records})=>{
  await login(page);expect(records.length).toBe(8);
  await page.getByTestId('group-critical').getByRole('button').click();
  const panel=await open(page);
  await expect(panel.getByRole('button',{name:'Добавить уровень'})).toBeHidden();
  await sortButton(panel).click();
  await page.getByRole('listbox').getByRole('option',{name:'Настроить порядок…',exact:true}).click();
  for(let i=0;i<3;i++) await panel.getByRole('button',{name:'Добавить уровень'}).click();
  await expect(panel.getByRole('button',{name:'Добавить уровень'})).toHaveCount(0);
  await panel.getByLabel('Критерий 3').selectOption('id');
  await expect.poll(()=>ids(page,'critical')).toEqual(['LAB-10','LAB-8','LAB-2','LAB-5','LAB-20']);
  await panel.getByLabel('Направление 2').selectOption('desc');
  await expect.poll(()=>ids(page,'critical')).toEqual(['LAB-8','LAB-10','LAB-2','LAB-5','LAB-20']);
  await panel.getByRole('button',{name:'Повысить уровень 3'}).click();
  await expect.poll(()=>ids(page,'critical')).toEqual(['LAB-2','LAB-5','LAB-8','LAB-10','LAB-20']);
  await panel.getByRole('button',{name:'Удалить уровень 2'}).click();
  await panel.getByLabel('Критерий 2').selectOption('overdue');
  await panel.getByLabel('Направление 2').selectOption('desc');
  await expect.poll(()=>ids(page,'critical').then(a=>a.slice(0,2))).toEqual(['LAB-2','LAB-5']);
  for (const width of [820,390,320]) {
    await page.setViewportSize({width,height:780});
    await expect(panel.getByRole('button',{name:'Готово'})).toBeInViewport();
    expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth && document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const header=page.getByRole('banner');
    const search=header.getByRole('searchbox');
    const trigger=header.getByRole('button',{name:/Фильтры/});
    await expect(search).toBeInViewport({ratio:1});
    await expect(trigger).toBeInViewport({ratio:1});
    const s=(await search.boundingBox())!, t=(await trigger.boundingBox())!;
    expect(s.x+s.width<=t.x+1 || t.x+t.width<=s.x+1 || s.y+s.height<=t.y+1 || t.y+t.height<=s.y+1).toBe(true);
  }
  await page.keyboard.press('Escape');await expect(panel).toBeHidden();
  await expect(page.locator('.filter-trigger')).toBeFocused();
  await page.getByTestId('group-critical').locator('.incident').first().click();
  await expect(page).toHaveURL(/\/incidents\//);
  await expect(page.getByRole('banner').getByRole('searchbox')).toBeVisible();
  await expect(page.locator('.filter-trigger')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('banner').getByRole('button',{name:/Фильтры/})).toBeVisible();
});

base('границы времени, московская дата, признаки завершения и устойчивое сравнение',()=>{
  const now=Date.parse('2026-11-20T21:10:00Z'), items=incidents(now);
  const groups={critical:['LAB-2','LAB-5','LAB-8','LAB-10','LAB-20'],high:['LAB-3'],assigned:['LAB-2','LAB-3','LAB-11'],review:['LAB-11'],history:['LAB-12']};
  const snapshot={incidents:items,groups} as Snapshot;
  const index=buildIndex(snapshot,displayFormats().dateFormat);
  const select=(change:Partial<Settings>)=>selectRows(index,snapshot,{...defaults,...change},'',now).items.map(i=>i.id);
  expect(select({sla:'overdue'})).toEqual(['LAB-2','LAB-5']);
  expect(select({sla:'missing'})).toEqual(['LAB-20']);
  expect(select({sla:'30'})).toEqual(['LAB-10']);
  expect(select({sla:'15'})).toEqual([]);
  expect(selectRows(index,snapshot,{...defaults,sla:'15'},'',now+12*60000).items.map(i=>i.id)).toEqual(['LAB-10']);
  expect(select({noOwner:true})).toEqual(['LAB-2']);
  expect(select({queueTime:'under15'})).toEqual(['LAB-3']);
  expect(select({queueTime:'range',queueMin:'60',queueMax:'80'})).toEqual(['LAB-2']);
  expect(select({created:'24'})).not.toContain('LAB-20');
  expect(select({created:'dates',dateFrom:'2026-11-20',dateTo:'2026-11-20'})).toContain('LAB-10');
  items[1].submitDate=new Date(now-5*60000).toISOString();
  expect(selectRows(buildIndex(snapshot,displayFormats().dateFormat),snapshot,{...defaults,created:'dates',dateFrom:'2026-11-21',dateTo:'2026-11-21'},'',now).items.map(i=>i.id)).toEqual(['LAB-10']);
  expect(select({sort:[{field:'priority',dir:'asc'}]})[0]).toBe('LAB-3');
  expect(select({sort:[{field:'queueAge',dir:'desc'}]}).slice(0,3)).toEqual(['LAB-11','LAB-2','LAB-3']);
  expect(select({sort:[{field:'urgency',dir:'asc'}]}).slice(0,2)).toEqual(['LAB-2','LAB-5']);
  expect(groups.critical).toEqual(['LAB-2','LAB-5','LAB-8','LAB-10','LAB-20']);
});
