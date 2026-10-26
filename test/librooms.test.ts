import { describe, expect, it } from 'vitest';
import { parseSeatMap, pickRoom, renderSeatMap, seatMapSvg } from '../src/core/library';
import { parseIntent } from '../src/core/intent';

const seat = (no: string, x: number, y: number, status = '空闲') => ({
  no,
  status: status === '空闲' ? 1 : 6,
  status_name: status,
  point_x: x,
  point_y: y,
});

/** 服务端把一层按房间分组时的常见形状 */
const twoRooms = () => ({
  data: {
    area_name: '二楼',
    list: [
      {
        name: 'A 区',
        seat_list: [seat('001', 10, 10), seat('002', 40, 10), seat('003', 10, 40, '使用中'), seat('004', 40, 40)],
      },
      {
        name: 'B 区',
        seat_list: [seat('001', 10, 10), seat('002', 40, 10), seat('003', 10, 40), seat('004', 40, 40, '使用中')],
      },
    ],
  },
});

describe('parseSeatMap 按房间分组', () => {
  it('两层房间各自成组，同号座位不会被吃掉', () => {
    const m = parseSeatMap(twoRooms());
    expect(m.rooms?.map((r) => r.name)).toEqual(['A 区', 'B 区']);
    expect(m.rooms?.map((r) => r.seats.length)).toEqual([4, 4]);
    expect(m.seats.length).toBe(8);
    expect(m.rooms?.map((r) => r.free)).toEqual([3, 3]);
  });

  it('平铺的一楼大厅不当成分房间', () => {
    const m = parseSeatMap({ data: { area_name: '一楼', list: [seat('001', 1, 1), seat('002', 2, 2)] } });
    expect(m.rooms).toBeUndefined();
    expect(m.seats.length).toBe(2);
  });

  it('房间名和整区名一样时也不算多间', () => {
    const m = parseSeatMap({ data: { area_name: '三楼', list: [{ name: '三楼', seat_list: [seat('001', 1, 1), seat('002', 2, 2)] }] } });
    expect(m.rooms).toBeUndefined();
  });
});

describe('pickRoom', () => {
  it('精确命中和包含匹配都认', () => {
    const m = parseSeatMap(twoRooms());
    expect(pickRoom(m, 'A 区')?.seats.length).toBe(4);
    expect(pickRoom(m, 'a区')?.seats.length).toBe(4);
    expect(pickRoom(m, 'B')?.seats.length).toBe(4);
  });

  it('问不到的房间返回 undefined', () => {
    const m = parseSeatMap(twoRooms());
    expect(pickRoom(m, 'C 区')).toBeUndefined();
  });

  it('没有分房间时返回 undefined', () => {
    const m = parseSeatMap({ data: { list: [seat('001', 1, 1), seat('002', 2, 2)] } });
    expect(pickRoom(m, 'A 区')).toBeUndefined();
  });
});

describe('seatMapSvg 多房间', () => {
  it('每间一块，块头带房间名', () => {
    const m = parseSeatMap(twoRooms());
    const svg = seatMapSvg(m)!;
    expect(svg).toContain('A 区');
    expect(svg).toContain('B 区');
    expect(svg.match(/<g transform="translate\(0,/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('只画一间时不出房间标题', () => {
    const m = parseSeatMap({ data: { list: [seat('001', 1, 1), seat('002', 2, 2), seat('003', 3, 3), seat('004', 4, 4)] } });
    const svg = seatMapSvg(m)!;
    expect(svg).not.toContain('房间');
  });

  it('含 & 的房间名被转义', () => {
    const raw = { data: { list: [{ name: 'A&B', seat_list: [seat('001', 1, 1), seat('002', 2, 2), seat('003', 3, 3), seat('004', 4, 4)] }, { name: 'C', seat_list: [seat('001', 1, 1), seat('002', 2, 2), seat('003', 3, 3), seat('004', 4, 4)] }] } };
    const svg = seatMapSvg(parseSeatMap(raw))!;
    expect(svg).toContain('A&amp;B');
    expect(svg).not.toContain('A&B');
  });
});

describe('renderSeatMap 多房间文案', () => {
  it('逐间列余量并给「只说某一间」的提示', () => {
    const text = renderSeatMap(parseSeatMap(twoRooms()));
    expect(text).toContain('**A 区**：空 3 / 共 4');
    expect(text).toContain('**B 区**：空 3 / 共 4');
    expect(text).toContain('就说「二楼 <房间名> 座位图」');
  });

  it('单间仍报总数和空闲座位号', () => {
    const text = renderSeatMap(parseSeatMap({ data: { list: [seat('001', 1, 1), seat('002', 2, 2)] } }));
    expect(text).toContain('共 2 个座位，当前空闲 **2** 个');
    expect(text).toContain('空闲座位：001、002');
  });

  it('三楼四楼是同一套逻辑，提示语跟着楼层名走', () => {
    const three = renderSeatMap(
      parseSeatMap({
        data: {
          area_name: '三楼',
          list: [
            { name: '西区自习室', seat_list: [seat('001', 1, 1), seat('002', 2, 2)] },
            { name: '东区自习室', seat_list: [seat('001', 1, 1), seat('002', 2, 2)] },
          ],
        },
      }),
    );
    expect(three).toContain('**西区自习室**：空 2 / 共 2');
    expect(three).toContain('就说「三楼 <房间名> 座位图」');
    expect(three).not.toContain('二楼');

    const four = renderSeatMap(
      parseSeatMap({
        data: {
          area_name: '四楼',
          list: [
            { name: '研习间 1', seat_list: [seat('001', 1, 1), seat('002', 2, 2)] },
            { name: '研习间 2', seat_list: [seat('001', 1, 1), seat('002', 2, 2)] },
          ],
        },
      }),
    );
    expect(four).toContain('四楼分了 **2** 间');
    expect(four).toContain('**研习间 2**：空 2 / 共 2');
    expect(four).toContain('就说「四楼 <房间名> 座位图」');
  });
});

describe('parseIntent 抽房间名', () => {
  const today = '2026-10-25';

  it('说了具体房间就带 room', () => {
    const r = parseIntent('二楼 A 区座位图', today);
    expect(r).toMatchObject({ tool: 'library_seat_map', args: { areaId: '4', room: 'A 区' } });
  });

  it('只说楼层就不带 room（要列全部房间）', () => {
    const r = parseIntent('图书馆二楼有哪些房间', today);
    expect(r).toMatchObject({ tool: 'library_seat_map', args: { areaId: '4' } });
    expect((r?.args as { room?: string }).room).toBeUndefined();
  });

  it('自习室也能抽出来', () => {
    const r = parseIntent('图书馆三楼考研自习室还有位置吗', today);
    expect(r).toMatchObject({ tool: 'library_seat_map', args: { areaId: '5', room: '考研自习室' } });
  });

  it('不带「图书馆」的纯自习问法仍然走找空教室', () => {
    expect(parseIntent('三楼考研自习室还有位置吗', today)?.tool).toBe('find_study_spot');
  });

  it('一楼大厅不会被当成房间', () => {
    const r = parseIntent('一楼大厅还有哪些座位', today);
    expect(r).toMatchObject({ tool: 'library_seat_map', args: { areaId: '3' } });
    expect((r?.args as { room?: string }).room).toBeUndefined();
  });

  it('三楼四楼走同一条路（区域 id 5 / 6）', () => {
    expect(parseIntent('三楼有哪些房间', today)).toMatchObject({ tool: 'library_seat_map', args: { areaId: '5' } });
    expect(parseIntent('四楼 B 区座位图', today)).toMatchObject({
      tool: 'library_seat_map',
      args: { areaId: '6', room: 'B 区' },
    });
    expect(parseIntent('四楼哪几间能坐', today)).toMatchObject({ tool: 'library_seat_map', args: { areaId: '6' } });
    // 只说「自习室还有位置吗」不带图书馆/房间，仍按「找空教室自习」处理
    expect(parseIntent('三楼自习室还有位置吗', today)?.tool).toBe('find_study_spot');
  });
});
