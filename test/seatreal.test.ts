import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSeatMap, renderSeatMap } from '../src/core/library';

/** 真实响应（2026-10-22 一楼大厅，216 个座位，原文裁到 6 条） */
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/library-seat.json', import.meta.url), 'utf8'));

describe('parseSeatMap（真实响应）', () => {
  const m = parseSeatMap(fixture);

  it('从 data.list 里解析出座位号（字段是 no/name，不是 seat_no）', () => {
    expect(m.seats.length).toBe(6);
    expect(m.seats.map((s) => s.no)).toEqual(['001', '002', '003', '004', '005', '006']);
  });

  it('用 status_name 判定空/占，而不是猜数字', () => {
    const free = m.seats.filter((s) => s.free).map((s) => s.no);
    expect(free.length).toBe(2);
    expect(free).toEqual(['001', '006']);
  });

  it('带上区域名与总数/空闲数', () => {
    expect(m.areaName).toBe('一楼大厅');
    expect(m.total).toBe(216);
    // free_num 是服务端给的 58，但这份 fixture 只有 6 条，所以 seats 内统计是 3
    expect(m.free).toBe(58);
  });

  it('正文里给出空闲座位号', () => {
    const text = renderSeatMap(m);
    expect(text).toContain('一楼大厅');
    expect(text).toContain('001');
    expect(text).toContain('长按');
  });
});
