import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSeatMap, seatMapDataUri, seatMapSvg } from '../src/core/library';

const seat = (no: string, x: number, y: number, status = '空闲') => ({
  no,
  name: no,
  status: status === '空闲' ? 1 : 6,
  status_name: status,
  point_x: x,
  point_y: y,
});

describe('parseSeatMap 保留坐标', () => {
  it('point_x/point_y 变成 x/y', () => {
    const m = parseSeatMap({ data: { list: [seat('001', 10, 20), seat('002', 30, 40)] } });
    expect(m.seats.map((s) => [s.no, s.x, s.y])).toEqual([
      ['001', 10, 20],
      ['002', 30, 40],
    ]);
  });

  it('没有坐标时不编造 x/y', () => {
    const m = parseSeatMap({ data: { list: [{ no: '001', status: 1, status_name: '空闲' }] } });
    expect(m.seats[0]!.x).toBeUndefined();
  });
});

describe('seatMapSvg', () => {
  const map = parseSeatMap({
    data: {
      list: [
        seat('001', 100, 100),
        seat('002', 160, 100),
        seat('003', 100, 160, '使用中'),
        seat('004', 160, 160, '使用中'),
        seat('005', 220, 160),
        seat('006', 220, 100),
      ],
    },
  });

  it('画出与座位数一致的圆点，空闲绿、占用灰', () => {
    const svg = seatMapSvg(map);
    expect(svg).toBeTruthy();
    const circles = svg!.match(/<circle /g) ?? [];
    expect(circles.length).toBe(6);
    expect((svg!.match(/fill="#3fb950"/g) ?? []).length).toBe(4);
    expect((svg!.match(/fill="#3a3f47"/g) ?? []).length).toBe(2);
  });

  it('坐标被归一化进画布（不出现负数或超出宽度）', () => {
    const svg = seatMapSvg(map, { width: 400 })!;
    const xs = [...svg.matchAll(/cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    const ys = [...svg.matchAll(/cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(400);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it('座位太少或没有坐标就不画', () => {
    expect(seatMapSvg(parseSeatMap({ data: { list: [seat('001', 1, 1)] } }))).toBeUndefined();
    expect(seatMapSvg(parseSeatMap({ data: { list: [{ no: '001', status_name: '空闲' }] } }))).toBeUndefined();
  });

  it('data URI 可直接给 img 用，且带 svg 头', () => {
    const uri = seatMapDataUri(map)!;
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(uri.split(',')[1]!)).toContain('<svg');
  });
});

describe('真实一楼大厅 216 个座位', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/library-seat-full.json', import.meta.url), 'utf8'));

  it('解析出 216 个座位、58 个空闲，并画出 216 个点', () => {
    const map = parseSeatMap(raw);
    expect(map.seats.length).toBe(216);
    expect(map.seats.filter((s) => s.free).length).toBe(58);
    const svg = seatMapSvg(map)!;
    expect((svg.match(/<circle /g) ?? []).length).toBe(216);
  });

  it('坐标跨度还原成一整张图（宽 720、高不超过 560）', () => {
    const svg = seatMapSvg(parseSeatMap(raw))!;
    const m = /width="(\d+)" height="(\d+)"/.exec(svg)!;
    expect(Number(m[1])).toBe(720);
    expect(Number(m[2])).toBeLessThanOrEqual(560);
  });
});
