// 实网回归测试：默认跳过，用 `npm run test:live` 或 `ZZU_LIVE=1 npm test` 触发。
// 依赖本机 tmp/zzu/ 下的真实 token（不进仓库）。没 token 时整组自动 skip。
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokenMeta } from '../src/core/jwt';
import { ask } from '../src/core/agent';
import { CampusService } from '../src/core/services';

const DIR = process.env.ZZU_TOKEN_DIR ?? '../tmp/zzu';
const path = (f: string) => `${DIR}/${f}`;
const read = (f: string): string | null => {
  const p = path(f);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
};

const jwxt = read('jwxt-token.txt');
const portal = read('token.txt');
const enabled = process.env.ZZU_LIVE === '1' && Boolean(jwxt || portal);

describe.skipIf(!enabled)('实网回归（郑大）', () => {
  const svc = new CampusService({ jwxtToken: jwxt ?? undefined, portalToken: portal ?? undefined });

  it('token 可解码；教务 token 必须有效（门户 token 只有 8h，过期不算失败）', () => {
    for (const t of [jwxt, portal]) {
      if (!t) continue;
      expect(tokenMeta(t).issuer).toBe('cas.s.zzu.edu.cn');
    }
    if (jwxt) {
      expect(tokenMeta(jwxt).valid, '教务 token 已过期，去 https://jwxt.zzu.edu.cn 登录一次').toBe(true);
    }
    if (portal && !tokenMeta(portal).valid) {
      // 门户 userToken 是 8 小时短票，隔天必过期；数据层以教务为主，这里只提示不失败。
      console.log('[live] 门户 token 已过期（8h TTL），门户相关用例将走备用路径');
    }
  });

  it('取到当前学期与教学周', async () => {
    const term = await svc.term();
    expect(term.code).toMatch(/^\d{4}-\d{4}-[12]$/);
    expect(term.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(term.weeks.length).toBeGreaterThanOrEqual(16);
    const week = await svc.currentWeek();
    expect(week).toBeGreaterThanOrEqual(1);
    expect(week).toBeLessThanOrEqual(term.weeks.length);
  });

  it('课表能归一化成课程', async () => {
    const courses = await svc.courses();
    expect(courses.length).toBeGreaterThan(0);
    for (const c of courses.slice(0, 20)) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.weekday).toBeGreaterThanOrEqual(1);
      expect(c.weeks.length).toBeGreaterThan(0);
    }
  });

  it('空教室能算出来', async () => {
    const rooms = await svc.freeRooms({ minSeats: 60, limit: 5 });
    expect(Array.isArray(rooms)).toBe(true);
    expect(rooms.length).toBeGreaterThan(0);
    for (const r of rooms) {
      expect(r.room.name.length).toBeGreaterThan(0);
      expect(r.freeSections.length).toBeGreaterThan(0);
    }
  });

  it('「明天南核空教室」只回南1–南3 的教室（地点词真的生效）', async () => {
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    const got = await ask('明天南核空教室', { jwxtToken: jwxt!, ...(portal ? { portalToken: portal } : {}), today });
    expect(got.tool).toBe('find_free_room');
    const rooms = (got.data?.rooms ?? []) as Array<{ room: { name: string } }>;
    if (rooms.length === 0) {
      // 那天南核真的排满了也算通过，但文案要说明是地点范围内没找到
      expect(got.text).toContain('南核心教学区');
      return;
    }
    for (const r of rooms) expect(r.room.name).toMatch(/^南[123][_\s（(]/);
  });

  it('通知有标题与摘要', async () => {
    const notices = await svc.notices({ limit: 3 });
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) {
      expect(n.title.length).toBeGreaterThan(0);
      expect(typeof n.summary).toBe('string');
    }
  });

  it('成绩与考试接口不报错（可能为空数组）', async () => {
    await expect(svc.grades()).resolves.toBeInstanceOf(Array);
    await expect(svc.exams()).resolves.toBeInstanceOf(Array);
  });

  it('培养方案能算出学分进度', async () => {
    const plan = await svc.planProgress();
    expect(plan.requiredCredits).toBeGreaterThan(0);
    expect(plan.modules.length).toBeGreaterThan(0);
    expect(plan.passedCredits + plan.missingCourses >= 0).toBe(true);
    for (const m of plan.modules) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.required).toBeGreaterThanOrEqual(0);
    }
  });

  it('一卡通余额能查到（用教务 token 访问门户接口）', async () => {
    const card = await svc.card();
    expect(Number.isFinite(card.balance)).toBe(true);
    expect(card.balance).toBeGreaterThanOrEqual(0);
  });

  it('待办计数能查到', async () => {
    const todos = await svc.todos();
    expect(todos.counts.todo).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(todos.items)).toBe(true);
  });
});
