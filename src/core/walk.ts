/**
 * 楼间步行时间：主校区（南/北核心教学区、物理馆、材料馆、化学馆、数学馆、图书馆…）
 *
 * 学校没有给坐标，这里是一张**手工近似表**（相对网格，单位米，非真实 GPS）。
 * 用途是排序与"来不来得及"，不是导航；误差按 ±2 分钟理解。
 * 行走速度按 78 m/min（约 1.3 m/s，含上下楼与进出楼）。
 *
 * 维护方式：新楼开出来时，在 BUILDINGS 里加一行 (x, y) 即可，其余功能自动受益。
 */

export interface BuildingNode {
  /** 教室名前缀：`北1_101` → `北1` */
  prefix: string;
  label: string;
  /** 相对网格坐标（米），原点取南门 */
  x: number;
  y: number;
}

/** 主校区主要教学楼/场馆的相对位置（近似，够用即可） */
export const BUILDINGS: BuildingNode[] = [
  { prefix: '南1', label: '南核心教学区 1 号楼', x: 300, y: 420 },
  { prefix: '南2', label: '南核心教学区 2 号楼', x: 360, y: 460 },
  { prefix: '南3', label: '南核心教学区 3 号楼', x: 420, y: 500 },
  { prefix: '北1', label: '北核心教学区 1 号楼', x: 320, y: 760 },
  { prefix: '北2', label: '北核心教学区 2 号楼', x: 380, y: 800 },
  { prefix: '北3', label: '北核心教学区 3 号楼', x: 440, y: 840 },
  { prefix: '北4', label: '北核心教学区 4 号楼', x: 500, y: 880 },
  { prefix: '北5', label: '北核心教学区 5 号楼', x: 560, y: 920 },
  { prefix: '物', label: '物理馆', x: 620, y: 640 },
  { prefix: '材', label: '材料馆', x: 680, y: 700 },
  { prefix: '化', label: '化学馆', x: 740, y: 660 },
  { prefix: '数', label: '数学馆', x: 700, y: 600 },
  { prefix: '图', label: '图书馆', x: 860, y: 720 },
  { prefix: '体', label: '体育场', x: 200, y: 300 },
  { prefix: '食', label: '食堂', x: 520, y: 520 },
];

const WALK_M_PER_MIN = 78;

/** 取教室名对应的楼节点：`北3_403` → 北3 */
export function buildingOf(roomName: string): BuildingNode | undefined {
  const name = roomName.trim();
  // 长的前缀优先（否则 `北1` 会吃掉 `北10`）
  return [...BUILDINGS]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((b) => {
      if (!name.startsWith(b.prefix)) return false;
      const next = name.charAt(b.prefix.length);
      return !/\d/.test(next);
    });
}

/** 楼间步行分钟数（向上取整，至少 1 分钟）；认不出楼返回 undefined */
export function walkMinutes(from: string, to: string): number | undefined {
  const a = buildingOf(from);
  const b = buildingOf(to);
  if (!a || !b) return undefined;
  if (a.prefix === b.prefix) return 0;
  const meters = Math.hypot(a.x - b.x, a.y - b.y);
  return Math.max(1, Math.ceil(meters / WALK_M_PER_MIN));
}
