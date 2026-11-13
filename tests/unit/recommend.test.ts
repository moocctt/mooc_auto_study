/** 课程库发现：关键词 + 课程库过滤（站内推荐 recommendInHouse 已随概览页合并进「继续学习」而移除） */
import { describe, expect, it } from 'vitest';
import { filterLibrary, keywordOf, recentNames } from '../../extension/lib/recommend.js';

const NOW = new Date('2026-11-06T12:00:00').getTime();
const D = (d: number) => NOW + d * 864e5;
const row = (o: object) => ({ name: 'x', required: '选修', state: '未开始', ...o });

describe('keywordOf', () => {
  it('剥离括号与书名号, 取主要词', () => {
    expect(keywordOf('烟草专卖管理师基础知识与实务（示例专题）')).toBe('烟草专卖管理师基础知识与实务');
    expect(keywordOf('《烟草专卖法》普法专题')).toBe('烟草专卖法');
  });
  it('空名安全', () => {
    expect(keywordOf('')).toBe('');
  });
});

describe('filterLibrary', () => {
  it('排除已有任务与重复, 截断到 limit', () => {
    const items = [
      { id: 'a', name: '已有课程' },
      { id: 'b', name: '新课程' },
      { id: 'b', name: '重复 id' },
      { id: 'c', name: '另一门' },
    ];
    const out = filterLibrary(items as any, [{ bid: 'a', name: '已有课程' }], 2);
    expect(out.map((x) => x.id)).toEqual(['b', 'c']);
  });
});

describe('recentNames', () => {
  it('取学习中/已完成的名字', () => {
    const rows = [
      row({ name: '学习中课', state: '学习中' }),
      row({ name: '完成课', state: '已完成' }),
      row({ name: '未开始课', state: '未开始' }),
    ];
    expect(recentNames(rows as any)).toEqual(['学习中课', '完成课']);
  });
});
