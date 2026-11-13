/** 平台路由解析纯函数: 用例全部来自真实 bug（多开 / 专题路由 / 误判提前结束） */
import { describe, expect, it } from 'vitest';
import {
  SUBJECT_SECTION_RE, courseIdOf, courseEntryHash, freshUrl,
  landedUrlOk, subjectHash,
} from '../../extension/lib/mooc-routes.js';

describe('courseIdOf', () => {
  it('普通课程 SSO state: course/detail/1&<id>', () => {
    expect(courseIdOf('https://mooc.ctt.cn/?ap=1#/study/course/detail/1&b1f3c2d4'))
      .toBe('b1f3c2d4');
  });
  it('专题课程入口: course/detail/10&<id>', () => {
    expect(courseIdOf('https://mooc.ctt.cn/?ap=1#/study/course/detail/10&c8d9e0'))
      .toBe('c8d9e0');
  });
  it('专题入口: subject/detail/<uuid>', () => {
    expect(courseIdOf('https://mooc.ctt.cn/?ap=1794103937145#/study/subject/detail/3b8b4520-7939-401e-89fc-7c8bdb62aeda'))
      .toBe('3b8b4520-7939-401e-89fc-7c8bdb62aeda');
  });
  it('URL 编码的 state 也能解析', () => {
    expect(courseIdOf('https://sso.example.com/login?state=%2Fstudy%2Fcourse%2Fdetail%2F1%26abc123'))
      .toBe('abc123');
  });
  it('畸形路由 detail/<id> 缺 & → 不误判（曾导致开错标签多开）', () => {
    expect(courseIdOf('https://mooc.ctt.cn/#/study/course/detail/3b8b4520')).toBe('');
  });
  it('非课程路由返回空', () => {
    // 平台真实「我的任务」路由（bundle 路由表提取）; 平台没有 #/task（假路由, 会静默回落首页）
    expect(courseIdOf('https://mooc.ctt.cn/#/center/my/task')).toBe('');
    expect(courseIdOf('https://mooc.ctt.cn/#/study/home')).toBe('');
  });
});

describe('landedUrlOk', () => {
  const id = '3b8b4520-7939-401e-89fc-7c8bdb62aeda';
  it('专题页整页重定向后的小节播放页 → 已落地', () => {
    expect(landedUrlOk(
      `https://mooc.ctt.cn/?ap=1#/study/course/detail/10&abc/6/1/${id}`, id,
    )).toBe(true);
  });
  it('token 未被平台消费（仍在 SSO 回调）→ 未落地', () => {
    expect(landedUrlOk(
      `https://mooc.ctt.cn/#/study/subject/detail/${id}?access_token=tk`, id,
    )).toBe(false);
  });
  it('畸形路由（平台跳错）→ 未落地', () => {
    expect(landedUrlOk(`https://mooc.ctt.cn/#/study/course/detail/${id}`, id)).toBe(false);
  });
  it('路由对但 id 不匹配 → 未落地', () => {
    expect(landedUrlOk('https://mooc.ctt.cn/#/study/subject/detail/other-id', id)).toBe(false);
  });
  it('空目标 id → 未落地', () => {
    expect(landedUrlOk('https://mooc.ctt.cn/#/study/task', '')).toBe(false);
  });
});

describe('SUBJECT_SECTION_RE', () => {
  it('从小节播放页提取专题 id（finishCourse 回航依据）', () => {
    const h = '#/study/course/detail/10&c1c2c3/6/1/3b8b4520-7939';
    expect(h.match(SUBJECT_SECTION_RE)?.[1]).toBe('3b8b4520-7939');
  });
  it('hash 直航的课程页无 <章>/<节>/<专题> 后缀 → 不匹配（曾导致误报课程完成提前结束值守）', () => {
    expect('#/study/course/detail/10&c1c2c3'.match(SUBJECT_SECTION_RE)).toBeNull();
  });
  it('普通课程页（detail/1&）不匹配', () => {
    expect('#/study/course/detail/1&xyz'.match(SUBJECT_SECTION_RE)).toBeNull();
  });
});

describe('freshUrl / hash helpers', () => {
  it('freshUrl 加 ap query 强制整页导航', () => {
    const out = freshUrl('https://mooc.ctt.cn/?ap=111#/study/subject/detail/x');
    expect(out.startsWith('https://mooc.ctt.cn/?ap=')).toBe(true);
    expect(out).not.toContain('ap=111');
  });
  it('非法 url 原样返回', () => {
    expect(freshUrl('not a url')).toBe('not a url');
  });
  it('courseEntryHash / subjectHash 拼接', () => {
    expect(courseEntryHash(10, 'abc')).toBe('#/study/course/detail/10&abc');
    expect(subjectHash('s1')).toBe('#/study/subject/detail/s1');
  });
});
