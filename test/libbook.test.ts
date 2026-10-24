import { describe, expect, it } from 'vitest';
import { describeBook, type BookOutcome } from '../src/core/libBook';

const base = { seatNo: '001', date: '2026-10-25' };

function copy(extra: Partial<BookOutcome>) {
  return describeBook({ ...base, cause: 'confirmed', ...extra });
}

describe('预约结果三态判定', () => {
  it('回执成功 + 座位图不再空闲 → 绿气泡，说「约上了」', () => {
    const c = copy({ cause: 'confirmed', code: 0, seatState: '预约中' });
    expect(c.kind).toBe('ok');
    expect(c.title).toBe('约上了');
    expect(c.detail).toContain('座位 001');
    expect(c.detail).toContain('2026-10-25');
    expect(c.detail).toContain('预约中');
    expect(c.text).toContain('预约成功');
    expect(c.text).toContain('✓');
  });

  it('回执成功但座位图仍空闲 → 琥珀气泡，明确写「先别当成约上了」', () => {
    const c = copy({ cause: 'api_ok', code: 0, seatState: '空闲' });
    expect(c.kind).toBe('warn');
    expect(c.title).toBe('结果存疑');
    expect(c.detail).toContain('别当成约上了');
    expect(c.detail).toContain('我的预约');
    expect(c.text).not.toContain('✓');
  });

  it('只有页面文字 → 存疑，不判成功', () => {
    const c = copy({ cause: 'pending', message: '只在页面上看到「成功」字样' });
    expect(c.kind).toBe('warn');
    expect(c.text).toContain('结果没确认');
  });

  it('没抓到回执 → 红气泡，说「没约上」且明确这次不算数', () => {
    const c = copy({ cause: 'no_response' });
    expect(c.kind).toBe('bad');
    expect(c.title).toBe('没约上');
    expect(c.text).toContain('预约失败');
    expect(c.text).toContain('✕');
    expect(c.detail).toContain('不算数');
  });

  it('接口报错时把系统原话带出来', () => {
    const c = copy({ cause: 'api_error', code: 400, message: '该座位已被预约' });
    expect(c.kind).toBe('bad');
    expect(c.detail).toContain('该座位已被预约');
  });

  it.each([
    ['seat_missing', '找不到这个座位'],
    ['btn_disabled', '不可约'],
    ['no_button', '「立即预约」按钮'],
    ['no_dialog', '确认弹窗'],
    ['no_token', '还没登录'],
    ['no_tab', '没打开图书馆预约页面'],
    ['page_dead', '没回应'],
  ] as const)('原因码 %s 有自己的说法', (cause, expected) => {
    const c = copy({ cause });
    expect(c.kind).toBe('bad');
    expect(c.detail).toContain(expected);
  });

  it('成功与失败的措辞完全不重叠，避免看混', () => {
    const ok = copy({ cause: 'confirmed', code: 0, seatState: '预约中' });
    const bad = copy({ cause: 'no_response' });
    expect(ok.title).not.toBe(bad.title);
    expect(ok.kind).not.toBe(bad.kind);
    expect(ok.text).not.toContain('失败');
    expect(bad.text).not.toContain('成功');
    expect(ok.detail).not.toContain('没约上');
    expect(bad.title).toBe('没约上');
    expect(bad.detail).not.toContain('✓');
  });

  it('没有座位号或日期时也说得出人话', () => {
    const c = describeBook({ cause: 'no_tab' });
    expect(c.detail).toContain('这次预约');
    expect(c.detail).toContain('没打开');
  });
});
