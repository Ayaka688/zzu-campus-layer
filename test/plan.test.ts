import { describe, expect, it } from 'vitest';
import { PORTAL_SERVICES, matchServices } from '../src/core/catalog';
import { renderPlanProgress } from '../src/core/render';
import { parseIntent } from '../src/core/intent';
import type { PlanProgress } from '../src/core/jwxt';

const TODAY = '2026-10-20';

describe('服务目录', () => {
  it('目录非空且每项都有可用的链接', () => {
    expect(PORTAL_SERVICES.length).toBeGreaterThan(10);
    for (const s of PORTAL_SERVICES) {
      expect(/^https?:\/\//.test(s.url)).toBe(true);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.what.length).toBeGreaterThan(0);
    }
  });

  it('按名字、别名、口语都能匹配到', () => {
    expect(matchServices('座位预约')[0]?.service.name).toBe('座位预约');
    expect(matchServices('我想抢自习位')[0]?.service.name).toBe('座位预约');
    expect(matchServices('报修')[0]?.service.name).toBe('网络报修');
    expect(matchServices('奖学金')[0]?.service.name).toBe('学生奖惩助贷查询');
    expect(matchServices('食堂')[0]?.service.name).toBe('智慧食堂');
  });

  it('整句也能命中（服务直达走这条）', () => {
    const hit = matchServices('我要打开座位预约在哪里', 1)[0];
    expect(hit?.service.name).toBe('座位预约');
    expect(hit?.score).toBeGreaterThan(0);
  });

  it('匹配不到时返回空数组，而不是瞎给一个', () => {
    expect(matchServices('量子纠缠')).toEqual([]);
  });
});

describe('意图：学分 / 服务直达', () => {
  it('学分类问法', () => {
    expect(parseIntent('我还差多少学分毕业', TODAY)?.tool).toBe('get_plan_progress');
    expect(parseIntent('培养方案完成情况', TODAY)?.tool).toBe('get_plan_progress');
  });

  it('服务直达类问法', () => {
    const it1 = parseIntent('打开座位预约', TODAY);
    expect(it1?.tool).toBe('open_service');
    expect(it1?.args).toEqual({ keyword: '座位预约' });

    expect(parseIntent('报修在哪', TODAY)?.tool).toBe('open_service');
  });

  it('「怎么申请奖学金」不被成绩规则抢走', () => {
    expect(parseIntent('怎么申请奖学金', TODAY)?.tool).toBe('open_service');
  });
});

describe('渲染培养方案', () => {
  const plan: PlanProgress = {
    requiredCredits: 166,
    passedCredits: 0,
    takingCredits: 25,
    missingCourses: 41,
    modules: [
      {
        name: '通识课程',
        required: 68,
        passed: 0,
        taking: 20,
        children: [{ name: '通修通识课程', required: 34, passed: 0, taking: 12 }],
      },
      { name: '专业课程', required: 64, passed: 0, taking: 5 },
    ],
  };

  it('给出总要求/已通过/在修/还差', () => {
    const text = renderPlanProgress(plan);
    expect(text).toContain('要求 **166** 学分');
    expect(text).toContain('在修 **25**');
    expect(text).toContain('还差 **141**');
    expect(text).toContain('未修课程 **41** 门');
  });

  it('分模块与小模块都列出来', () => {
    const text = renderPlanProgress(plan);
    expect(text).toContain('**通识课程** 0/68 学分（在修 20）');
    expect(text).toContain('通修通识课程 0/34');
    expect(text).toContain('**专业课程** 0/64 学分（在修 5）');
  });

  it('要求为 0 的模块不画进度条也不崩', () => {
    const text = renderPlanProgress({ ...plan, modules: [{ name: '空模块', required: 0, passed: 0, taking: 0 }] });
    expect(text).toContain('空模块');
    expect(text).not.toContain('NaN');
  });
});
