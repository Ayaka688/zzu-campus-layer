import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/core/tools';
import { activeToolSpecs } from '../src/core/toolspec';

const specs = activeToolSpecs();

describe('toolspec：给模型看的工具清单', () => {
  it('覆盖全部工具，不多不少', () => {
    const names = specs.map((s) => s.function.name).sort();
    expect(names).toEqual(Object.keys(TOOLS).sort());
  });

  it('每个都是 function 类型、带中文描述', () => {
    for (const s of specs) {
      expect(s.type).toBe('function');
      expect(s.function.description.length).toBeGreaterThan(8);
    }
  });

  it('parameters 是 object，且 required 里的键都在 properties 里', () => {
    for (const s of specs) {
      const p = s.function.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(p.type).toBe('object');
      for (const key of p.required ?? []) {
        expect(Object.keys(p.properties ?? {})).toContain(key);
      }
    }
  });

  it('靠前的工具写清「要真实数据就调它」的边界', () => {
    const byName = new Map(specs.map((s) => [s.function.name, s.function.description]));
    expect(byName.get('get_schedule')).toContain('课表');
    expect(byName.get('find_free_room')).toContain('空教室');
    expect(byName.get('open_service')).toContain('入口');
  });
});
