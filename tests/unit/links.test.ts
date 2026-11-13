/** 平台直达链接: 优先行内 url, 否则按 bid 拼课程页 */
import { describe, expect, it } from 'vitest';
import { isCourseDetailUrl, platformSsoUrl, platformUrl, ssoCourseUrl } from '../../extension/lib/links.js';

describe('platformUrl', () => {
  it('优先使用平台给的 url', () => {
    expect(platformUrl({ url: 'https://mooc.ctt.cn/home?courseId=c9', bid: 'c9' }))
      .toBe('https://mooc.ctt.cn/home?courseId=c9');
  });
  it('无 url 时按 bid 拼课程页', () => {
    expect(platformUrl({ bid: 'b1f3c2d4' })).toBe('https://mooc.ctt.cn/#/study/course/detail/1&b1f3c2d4');
  });
  it('搜索结果用 id', () => {
    expect(platformUrl({ id: 'lib-1' })).toBe('https://mooc.ctt.cn/#/study/course/detail/1&lib-1');
  });
  it('无任何标识回退平台首页', () => {
    expect(platformUrl({})).toBe('https://mooc.ctt.cn');
  });
  it('相对/空 url 不采用', () => {
    expect(platformUrl({ url: '/home?courseId=x', bid: 'b2' })).toBe('https://mooc.ctt.cn/#/study/course/detail/1&b2');
  });
});

describe('platformSsoUrl', () => {
  it('把 token 放进 URL fragment（不发往服务端）', () => {
    const u = new URL(platformSsoUrl({ access_token: 'tk', token_type: 'Bearer', expires_in: 2592000 }));
    expect(u.origin + u.pathname).toBe('https://mooc.ctt.cn/');
    expect(u.hash).toContain('access_token=tk');
    expect(u.hash).toContain('token_type=Bearer');
  });
  it('无 token 时回退首页', () => {
    expect(platformSsoUrl(null)).toBe('https://mooc.ctt.cn');
  });
  it('有效期按令牌原值透传（扫码/账密不同）', () => {
    const u = decodeURIComponent(platformSsoUrl({ access_token: 'tk', expires_in: 7 * 86400 }));
    expect(u).toContain('expires_in=604800');
  });
  it('令牌没有 expires_in（官网导入）时不编造 30 天', () => {
    const u = decodeURIComponent(platformSsoUrl({ access_token: 'tk', token_type: 'Bearer' }));
    expect(u).not.toContain('expires_in');
    expect(u).toContain('access_token=tk');
  });
});

describe('ssoCourseUrl', () => {
  const token = { access_token: 'tk', token_type: 'Bearer', expires_in: 2592000 };
  it('课程: state 指向 course/detail/1&<id>', () => {
    const u = decodeURIComponent(ssoCourseUrl({ bid: 'c9' }, token, 1));
    expect(u).toContain('state=/study/course/detail/1&c9');
  });
  it('专题: state 指向 subject/detail/<id>（真实路由, 自动进小节播放页）', () => {
    const u = decodeURIComponent(ssoCourseUrl({ bid: 's1' }, token, 2));
    expect(u).toContain('state=/study/subject/detail/s1');
  });
  it('无 token 回退 platformUrl（专题用 subject 路由）', () => {
    expect(ssoCourseUrl({ bid: 's1' }, undefined, 2)).toBe('https://mooc.ctt.cn/#/study/subject/detail/s1');
    expect(ssoCourseUrl({ bid: 'c9' }, undefined, 1)).toBe('https://mooc.ctt.cn/#/study/course/detail/1&c9');
  });
});

describe('platformUrl', () => {
  it('专题行用 subject 路由', () => {
    expect(platformUrl({ bid: 's1', type: '专题' })).toBe('https://mooc.ctt.cn/#/study/subject/detail/s1');
  });
  it('课程行用 course/detail 路由', () => {
    expect(platformUrl({ bid: 'c9', type: '课程' })).toBe('https://mooc.ctt.cn/#/study/course/detail/1&c9');
  });
});

describe('isCourseDetailUrl', () => {
  it('课程详情页（kind=1）命中', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/study/course/detail/1&b1f3c2d4e5a6978800112233')).toBe(true);
  });
  it('专题详情页（kind=2）命中', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/study/course/detail/2&abc-123')).toBe(true);
  });
  it('URL 编码过的 hash 也能命中（SSO 跳转后 state 被编码）', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/?ap=1#%2Fstudy%2Fcourse%2Fdetail%2F1%26b1f3c2d4')).toBe(true);
  });
  it('带 query 的正常页命中', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/?ap=1762560000000#/study/course/detail/2&xyz')).toBe(true);
  });
  it('专题页 subject/detail 路由命中', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/study/subject/detail/3b8b4520-7939-401e-89fc-7c8bdb62aeda')).toBe(true);
    expect(isCourseDetailUrl('https://mooc.ctt.cn/?ap=123#/study/subject/detail/abc')).toBe(true);
  });
  it('专题内小节播放页（detail/10&<id>/<章>/<节>/<专题id>）命中', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/study/course/detail/10&b9d31bba-1be5-4105-9508-0a69bb3ea9ab/6/1/3b8b4520')).toBe(true);
  });
  it('首页/我的任务/学习错误页不命中', () => {
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/home')).toBe(false);
    // 平台真实「我的任务」路由（bundle 路由表提取）; 平台没有 #/task（假路由, 会静默回落首页）
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/center/my/task')).toBe(false);
    expect(isCourseDetailUrl('https://mooc.ctt.cn/#/study/errors/c9')).toBe(false);
  });
  it('非平台域名不命中', () => {
    expect(isCourseDetailUrl('https://evil.com/#/study/course/detail/1&c9')).toBe(false);
    expect(isCourseDetailUrl('https://mooc.ctt.cn.evil.com/#/study/course/detail/1&c9')).toBe(false);
    expect(isCourseDetailUrl('chrome-extension://abc/console.html')).toBe(false);
  });
  it('非法 URL 不命中', () => {
    expect(isCourseDetailUrl('not a url')).toBe(false);
    expect(isCourseDetailUrl('')).toBe(false);
  });
});

/**
 * 防回归: 主动构造/跳转的平台路由必须落在真路由白名单里（2026-11-09 真机核实）。
 * 详见 extension/lib/links.js 顶部「平台真实 hash 路由对照表」。
 * 背景: leaveDoc 兜底曾拼出 #/task —— 平台路由表没有它, SPA 静默回落首页导致
 * 值守「返回继续」断链(#216)。这里把白名单钉死, 防止再引入假路由。
 */
describe('平台真路由白名单（防假路由回归）', () => {
  // 平台 main bundle 路由表 + 真机整页导航核实过的「可主动跳转」路由
  const REAL_ROUTE_RE = /^#\/(home|center\/my\/task|study\/course\/detail\/\d+&|study\/course\/index|study\/subject\/detail\/|study\/branch\/index|knowledge\/(details|detail|index)\/)/;
  const FAKE_ROUTES = ['#/task', '#/study/home'];

  it('代码里所有构造函数产物都命中真路由', () => {
    const built = [
      platformUrl({ bid: 'c9' }),
      platformUrl({ bid: 'c9', type: '专题' }),
      ssoCourseUrl({ bid: 'c9' }, undefined, 1),
      ssoCourseUrl({ bid: 'c9' }, undefined, 2),
    ];
    for (const u of built) {
      const hash = decodeURIComponent(new URL(u).hash || '');
      expect(REAL_ROUTE_RE.test(hash)).toBe(true);
    }
  });

  it('已知假路由不会被任何构造函数产出', () => {
    const built = [
      platformUrl({ bid: 'c9' }),
      platformUrl({ bid: 'c9', type: '专题' }),
      ssoCourseUrl({ bid: 'c9' }, { access_token: 'tk' }, 1),
      ssoCourseUrl({ bid: 'c9' }, { access_token: 'tk' }, 2),
    ].join(' ');
    for (const fake of FAKE_ROUTES) expect(built.includes(fake)).toBe(false);
  });

  it('真「我的任务」路由与假路由区分明确', () => {
    expect(REAL_ROUTE_RE.test('#/center/my/task')).toBe(true);
    expect(REAL_ROUTE_RE.test('#/task')).toBe(false);
    expect(REAL_ROUTE_RE.test('#/study/home')).toBe(false);
  });
});
