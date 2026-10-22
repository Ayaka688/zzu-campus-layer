import { describe, expect, it } from 'vitest';
import { parseSeatMap, renderSeatMap } from '../src/core/library';

describe('parseSeatMap', () => {
  it('认典型的座位数组（no + status）', () => {
    const raw = {
      code: 0,
      data: {
        name: '一楼大厅',
        total_num: 3,
        free_num: 2,
        seat_list: [
          { seat_no: '001', status: 'free' },
          { seat_no: '002', status: 'used' },
          { seat_no: '003', status: '空闲' },
        ],
      },
    };
    const m = parseSeatMap(raw);
    expect(m.areaName).toBe('一楼大厅');
    expect(m.total).toBe(3);
    expect(m.seats.map((s) => s.no)).toEqual(['001', '002', '003']);
    expect(m.seats.filter((s) => s.free).map((s) => s.no)).toEqual(['001', '003']);
    expect(m.free).toBe(2);
  });

  it('数字状态按实测语义判定（1=可用），并仍能列出座位号', () => {
    const raw = {
      data: {
        seats: [
          { seatNo: 'A1', state: 1, x: 10, y: 20 },
          { seatNo: 'A2', state: 0, x: 30, y: 20 },
        ],
      },
    };
    const m = parseSeatMap(raw);
    expect(m.seats.map((s) => s.no)).toEqual(['A1', 'A2']);
    expect(m.seats.map((s) => s.free)).toEqual([true, false]);
    expect(renderSeatMap(m)).toContain('共 2 个座位');
  });

  it('认不出来时返回空数组，不抛错', () => {
    expect(parseSeatMap(null).seats).toEqual([]);
    expect(parseSeatMap({ code: 10001, message: '您尚未登录' }).seats).toEqual([]);
    expect(parseSeatMap('字符串').seats).toEqual([]);
    expect(parseSeatMap({ data: [1, 2, 3] }).seats).toEqual([]);
  });

  it('去重：同一座位号出现两次只留一个', () => {
    const raw = { list: [{ no: '001', status: 'free' }, { no: '001', status: 'free' }] };
    expect(parseSeatMap(raw).seats).toHaveLength(1);
  });

  it('只有座位号没有状态/坐标的不算座位（避免把区域名当座位）', () => {
    const raw = { data: { list: [{ name: '一楼大厅' }, { no: '001', status: 'free' }] } };
    expect(parseSeatMap(raw).seats.map((s) => s.no)).toEqual(['001']);
  });
});

describe('renderSeatMap', () => {
  it('列出空闲座位并给预约提示', () => {
    const m = parseSeatMap({
      data: {
        name: '一楼大厅',
        list: [
          { no: '001', status: 'free' },
          { no: '002', status: 'free' },
          { no: '003', status: 'used' },
        ],
      },
    });
    const text = renderSeatMap(m);
    expect(text).toContain('一楼大厅');
    expect(text).toContain('共 3 个座位');
    expect(text).toContain('空闲 **2** 个');
    expect(text).toContain('001');
    expect(text).toContain('长按');
  });

  it('超过上限时给省略提示', () => {
    const list = Array.from({ length: 60 }, (_, i) => ({
      no: String(i + 1).padStart(3, '0'),
      status: 'free',
    }));
    const text = renderSeatMap(parseSeatMap({ list }), { limit: 10 });
    expect(text).toContain('还有 50 个');
  });

  it('没有座位时明说，而不是回空字符串', () => {
    const text = renderSeatMap(parseSeatMap({}));
    expect(text).toContain('没解析出座位');
  });
});
