import { describe, expect, it } from 'vitest';
import { parseIntent } from '../src/core/intent';

/** 这几条是用户实际踩过的说法，必须落到「能下单」的路径上，而不是只给入口 */
describe('图书馆座位意图', () => {
  const today = '2026-10-22';

  it('「想预约明天图书馆一楼座位」→ 先看座位图（带区域与日期）', () => {
    const r = parseIntent('想预约明天图书馆一楼座位', today);
    expect(r?.tool).toBe('library_seat_map');
    expect(r?.args).toEqual({ areaId: '3', date: '2026-10-23' });
  });

  it('「订 001，明天」→ 进下单准备（带座位号）', () => {
    const r = parseIntent('订 001，明天', today);
    expect(r?.tool).toBe('book_library_seat');
    expect(r?.args).toMatchObject({ seatNo: '001', date: '2026-10-23' });
  });

  it('只问余量不给区域 → 仍然走馆级余量', () => {
    const r = parseIntent('图书馆还有位置吗', today);
    expect(r?.tool).toBe('library_seats');
  });

  it('「南核空教室」不会被图书馆规则抢走', () => {
    const r = parseIntent('明天南核空教室', today);
    expect(r?.tool).toBe('find_free_room');
  });
});
