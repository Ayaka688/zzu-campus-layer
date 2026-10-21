import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/core/intent';
import { parseCard, parseTodos } from '../src/core/portal';
import { renderCard, renderTodos } from '../src/core/render';
import { Card } from '../src/core/types';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const TODAY = '2026-10-20';

describe('一卡通', () => {
  it('真实 fixture：balance 是字符串，能解析成数字', () => {
    const raw = fixture('card.json');
    const card = parseCard(raw.data);
    expect(typeof raw.data.balance).toBe('string');
    expect(card.balance).toBe(0);
    expect(card.cardType).toBe('uni-app');
    expect(card.expenses).toEqual([]);
    expect(card.appUrl).toContain('ecard.v.zzu.edu.cn');
  });

  it('字符串带单位/空串也不炸', () => {
    expect(parseCard({ balance: '' }).balance).toBe(0);
    expect(parseCard({ balance: '12.50' }).balance).toBe(12.5);
    expect(parseCard({ balance: '¥8.00' }).balance).toBe(8);
    expect(parseCard(null).balance).toBe(0);
  });

  it('渲染余额与「没有流水」', () => {
    const text = renderCard(parseCard(fixture('card.json').data));
    expect(text).toContain('余额 **¥0**');
    expect(text).toContain('没有最近流水');
  });

  it('有流水时按「时间 · 地点 · 金额」列出来', () => {
    const card = Card.parse({
      balance: 33.5,
      expenses: [{ time: '2026-10-19 12:03', place: '荷园二食堂', amount: '12.5' }],
      incomes: [{ time: '2026-10-18 09:00', place: '圈存', amount: 50 }],
    });
    const text = renderCard(card);
    expect(text).toContain('余额 **¥33.50**');
    expect(text).toContain('最近消费');
    expect(text).toContain('荷园二食堂');
    expect(text).toContain('¥12.50');
    expect(text).toContain('最近充值');
  });
});

describe('待办', () => {
  it('真实 fixture：计数全 0、列表为空', () => {
    const counts = fixture('todo-count.json').data;
    const list = fixture('todo-list.json').data;
    const todos = parseTodos(counts, list.items);
    expect(todos.counts).toEqual({ apply: 0, circulated: 0, todo: 0, timeout: 0, urgent: 0 });
    expect(todos.items).toEqual([]);
  });

  it('字段缺失时按 0 处理（不抛错）', () => {
    expect(parseTodos(undefined, []).counts.todo).toBe(0);
    expect(parseTodos({ todo_count: 3 } as never, []).counts.todo).toBe(3);
  });

  it('渲染「没有待办」', () => {
    expect(renderTodos(parseTodos(fixture('todo-count.json').data, []))).toContain('没有需要你处理的待办');
  });

  it('有未办事项时列出计数与标题', () => {
    const todos = parseTodos(
      { apply_count: 1, circulated_count: 2, todo_count: 3, todo_timeout: 1, todo_urgent: 1 },
      [{ title: '国家奖学金申请', status: '待审批', time: '2026-10-18' }, { name: '请假申请' }],
    );
    const text = renderTodos(todos);
    expect(text).toContain('待办 **3** 项');
    expect(text).toContain('我发起的在办 **2**');
    expect(text).toContain('⚠️ 紧急 **1** 项');
    expect(text).toContain('⏰ 已超时 **1** 项');
    expect(text).toContain('国家奖学金申请');
    expect(text).toContain('请假申请');
  });
});

describe('意图：一卡通与待办', () => {
  it.each([
    ['我卡里还有多少钱'],
    ['一卡通余额'],
    ['饭卡还剩多少'],
    ['最近消费记录'],
    ['校园卡怎么充值'],
  ])('「%s」→ get_card', (q) => {
    expect(parseIntent(q, TODAY)?.tool).toBe('get_card');
  });

  it.each([['有什么要办的事'], ['待办事项'], ['我有没有没办完的']])('「%s」→ get_todos', (q) => {
    expect(parseIntent(q, TODAY)?.tool).toBe('get_todos');
  });

  it('「怎么申请奖学金」仍走服务直达，不被待办规则抢走', () => {
    expect(parseIntent('怎么申请奖学金', TODAY)?.tool).toBe('open_service');
  });
});
