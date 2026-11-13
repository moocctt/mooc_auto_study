// 学时引擎：与油猴/插件/v0.1 同一套逻辑（任务 → 课程 → 小节 → start-progress 循环上报），
// 从 lib/engine.js 移植为 TS；差异是 api 层直连平台（server 端跑）。
import { API, DONE, MEDIA, NESTED, SKIP, TYPE_NAME } from '../platform/endpoints.js';
import { platformReq } from '../platform/client.js';
import { PlatformError } from '../platform/client.js';

type Row = Record<string, unknown>;
const asRow = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: unknown) => Number(v) || 0;

class QuotaExhausted extends Error {}

export interface EngineConfig {
  getStep(): number; // 单轮上报秒数（默认 600，内部钳到 ≥30）
  backdateS(step: number): number; // createTime 回填
  roundSleepMs(step: number): number;
  roundsSlack: number;
  taskGapMs(): number;
}

export const fastConfig: EngineConfig = {
  getStep: () => 600,
  backdateS: (step) => step + rand(60, 300),
  roundSleepMs: () => rand(600, 1600),
  roundsSlack: 5,
  taskGapMs: () => rand(1500, 3000),
};

interface Section { id: string; rid: string; name: string; type: number; finish: number; studied: number }

export function createEngine({ token, config = fastConfig, log = () => {} }: {
  token: string; config?: EngineConfig; log?: (msg: string) => void;
}) {
  const state = { running: false, stopFlag: false, course: '', section: '', round: 0, submitted: 0 };

  async function req(method: 'GET' | 'POST', path: string, opts: { params?: Row; data?: Row } = {}) {
    const { status, body } = await platformReq(token, method, path, opts);
    return [status, body] as const;
  }

  /** 任务源：personCourse-list（businessType 0=课程 2=专题）。
   *  human/task 接口现在只剩少量活动任务（bt=5 培训班等），真正的学习负载在 personCourse 里；
   *  finishStatus ∈ DONE 视为已完成。 */
  async function undoneTasks(): Promise<Row[]> {
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const bt of [0, 2]) {
      for (let page = 1; page <= 10; page++) {
        const [code, body] = await req('GET', API.PERSON_COURSE, {
          params: { page, pageSize: 500, findStudy: 0, businessType: bt, studyTimeOrder: 'desc', finishStatus: '', isRequired: '' },
        });
        if (code !== 200 || !body || Array.isArray(body)) throw new Error(`personCourse-list 请求失败 (HTTP ${code})`);
        const items = ((body as Row).items ?? []) as Row[];
        for (const it of items) {
          const bid = String(asRow(it.courseInfo).courseId ?? it.courseId ?? '');
          if (!bid || seen.has(bid)) continue;
          if (DONE.has(Number(it.finishStatus ?? 0))) continue;
          seen.add(bid);
          out.push({
            name: asRow(it.courseInfo).name ?? bid,
            businessId: bid,
            businessType: bt,
            required: it.isRequired,
          });
        }
        if (!items.length || items.length < 500 || seen.size >= num((body as Row).recordCount)) break;
      }
    }
    // 必修优先（稳定排序：必修在前，课程类仍在专题类之前）
    out.sort((a, b) => Number(b.required === 1) - Number(a.required === 1));
    return out;
  }

  async function sections(courseId: string, versionId: string, register: boolean): Promise<Section[]> {
    const [code, body] = await req('GET', API.CHAPTERS, { params: { courseId, versionId, isRegister: register } });
    if (code !== 200 || !Array.isArray(body)) throw new Error(`章节列表请求失败 (HTTP ${code})`);
    const out: Section[] = [];
    for (const ch of body as Row[]) {
      for (const sec of ((ch.courseChapterSections ?? []) as Row[])) {
        const p = asRow(sec.progress);
        out.push({
          id: String(sec.referenceId ?? ''), rid: String(sec.resourceId ?? ''),
          name: String(sec.sectionName ?? sec.name ?? ''),
          type: Number(sec.sectionType ?? 0),
          finish: p.finishStatus === undefined ? 0 : Number(p.finishStatus),
          studied: num(p.studyTotalTime),
        });
      }
    }
    return out;
  }

  let versionId = '';
  let isRegister = false;

  async function openCourse(courseId: string): Promise<[Row, Section[], boolean]> {
    const [code, detRaw] = await req('POST', API.REGISTER, { data: { courseId } });
    const det = detRaw && !Array.isArray(detRaw) ? (detRaw as Row) : null;
    if (code !== 200 || !det) return openLibraryCourse(courseId);
    versionId = String(det.versionId ?? '');
    isRegister = !!det.register;
    return [det, await sections(courseId, versionId, isRegister), false];
  }

  async function openLibraryCourse(courseId: string): Promise<[Row, Section[], boolean]> {
    await req('POST', API.REGISTER_STUDY, { data: { courseId, type: 1, isRequired: 0 } });
    versionId = '';
    isRegister = false;
    const [infoCode, detRaw] = await req('GET', `${API.INFO}/${encodeURIComponent(courseId)}`, { params: { source: 1, type: 1 } });
    const det = detRaw && !Array.isArray(detRaw) ? (detRaw as Row) : null;
    if (infoCode !== 200 || !det) throw new Error(`课程信息请求失败 (HTTP ${infoCode})`);
    const map: Record<string, number> = {
      pdf: 1, image: 2, url: 3, scorm: 4, mp3: 5, mp4: 6, epub: 7,
      task: 8, exam: 9, other: 10, survey: 12, assessment: 13, kj: 15,
    };
    const secs: Section[] = [];
    for (const ch of ((det.courseChapters ?? []) as Row[])) {
      for (const sec of ((ch.courseChapterSections ?? []) as Row[])) {
        const ft = String(sec.fileType ?? '').toLowerCase();
        secs.push({
          id: String(sec.id ?? ''), rid: String(sec.attachmentId ?? ''),
          name: String(sec.name ?? sec.sectionName ?? ''),
          type: map[ft] ?? 0, finish: 0, studied: 0,
        });
      }
    }
    return [{ ...det, _library: true }, secs, true];
  }

  async function startProgress(sectionId: string, backdateS: number, clientType: number): Promise<[string | null, number | null]> {
    const ct = Date.now() - Math.trunc(backdateS * 1000);
    const [code, body] = await req('GET', `${API.START}/${encodeURIComponent(sectionId)}`, { params: { clientType, createTime: ct } });
    const det = body && !Array.isArray(body) ? (body as Row) : null;
    if (code !== 200 || !det?.id) return [null, null];
    const rem = det.remainingTime;
    return [String(det.id), rem === undefined || rem === null ? null : Number(rem)];
  }

  async function progressUpdate(courseId: string): Promise<void> {
    await req('POST', API.PROGRESS_UPD, { data: { encrypt: 'false', courseId } });
  }

  async function settleNested(parentId: string, childId: string, sectionId: string, tries = 4): Promise<boolean> {
    await req('POST', API.SECTION_PROGRESS, { data: { courseId: parentId, resourceIds: childId } });
    for (let i = 0; i < tries; i++) {
      if (state.stopFlag) return false;
      const [logId] = await startProgress(sectionId, 300, 1);
      if (logId) {
        const [, body] = await req('POST', API.DOC, { data: { encrypt: 'false', logId, lessonLocation: 999 } });
        const det = body && !Array.isArray(body) ? (body as Row) : null;
        if (det && DONE.has(Number(det.finishStatus))) return true;
      }
      await sleep(rand(2500, 4000));
    }
    const [, rows] = await req('POST', API.SECTION_PROGRESS, { data: { courseId: parentId, resourceIds: childId } });
    const first = Array.isArray(rows) ? (rows[0] as Row | undefined) : null;
    return !!first && DONE.has(Number(first.finishStatus));
  }

  async function doSection(sec: Section, { depth = 0, courseId = '', library = false } = {}): Promise<[boolean, string]> {
    if (SKIP.has(sec.type)) {
      const human = [9, 12, 13].includes(sec.type);
      return [false, `${TYPE_NAME[sec.type] ?? sec.type} ${human ? '需真实作答' : '暂无上报协议'}，跳过`];
    }
    if (DONE.has(sec.finish)) return [true, '已完成，跳过'];
    if (sec.type === NESTED) {
      if (depth >= 2) return [false, '嵌套过深，跳过'];
      const parentCourse = state.course;
      const parentVid = versionId;
      const parentReg = isRegister;
      log(`↳ 关联课程 ${sec.rid}`);
      const [done, total] = await runCourse(sec.rid, depth + 1);
      state.course = parentCourse;
      versionId = parentVid;
      isRegister = parentReg;
      if (done < total) return [false, `子课程未完成 ${done}/${total}`];
      const settled = await settleNested(courseId, sec.rid, sec.id);
      return [settled, settled ? '子课程完成，父记录已结算' : '子课程完成，父记录结算未确认(稍后复核)'];
    }

    const step0 = config.getStep();
    let total: number | null = null;
    let submitted = 0;
    let prevRem: number | null = null;
    let stuck = 0;
    let maxRounds = 0;

    for (let i = 0; ; i++) {
      if (state.stopFlag) return [false, '已停止'];
      if (maxRounds && i >= maxRounds) return [false, `轮次用完 (已提交 ${submitted}s)`];
      state.round = i + 1;
      const [logId, remRaw] = await startProgress(sec.id, config.backdateS(step0), library ? 0 : 1);
      if (logId === null) return [false, 'start-progress 失败'];
      if (remRaw === null || !Number.isFinite(remRaw)) {
        // 平台对已完成/无剩余时长的小节返回 remainingTime:null，老脚本视为成功（同语义）
        return [true, submitted ? `完成（共 ${submitted}s）` : '已完成（无剩余时长）'];
      }
      const rem = remRaw;
      if (rem <= 0) {
        if (submitted || sec.studied) return [true, `时长已用完（共 ${submitted}s）`];
        return [true, '该小节无剩余时长'];
      }
      if (prevRem !== null && rem >= prevRem) {
        stuck += 1;
        if (stuck >= 2) {
          if (MEDIA.has(sec.type)) throw new QuotaExhausted(`剩余时长未下降 (${prevRem}→${rem}) —— 判定当日学时配额已满`);
          return [false, `剩余时长未下降 (${prevRem}→${rem})，该小节未结算`];
        }
      } else stuck = 0;
      prevRem = rem;

      if (total === null) {
        log(`  · ${TYPE_NAME[sec.type] ?? sec.type} 剩余 ${rem}s，已学 ${sec.studied}s`);
        total = rem + sec.studied;
        maxRounds = Math.ceil(total / Math.min(step0, API.MAX_STEP)) + config.roundsSlack;
      }

      const step = Math.min(step0, rem, API.MAX_STEP);
      const isMedia = MEDIA.has(sec.type);
      const [code, body] = isMedia
        ? await req('POST', API.VIDEO, { data: {
            encrypt: 'false', logId,
            studyTime: Math.trunc(step),
            lessonLocation: Math.trunc(Math.min(total, total - rem + step)),
            resourceTotalTime: Math.trunc(total),
            flush: 'false',
          } })
        : await req('POST', API.DOC, { data: { encrypt: 'false', logId, lessonLocation: 999 } });

      if (code !== 200) {
        const errCode = body && !Array.isArray(body) ? Number((body as Row).errorCode) : NaN;
        if (errCode === 40909) { await sleep(1000); continue; }
        return [false, `上报失败 HTTP ${code}`];
      }
      submitted += step;
      state.submitted = submitted;
      if (courseId) {
        try { await progressUpdate(courseId); } catch (e) { log(`  · 进度刷新失败（不影响已提交学时）：${e instanceof Error ? e.message : e}`); }
      }
      await sleep(config.roundSleepMs(step));
    }
  }

  async function runCourse(courseId: string, depth = 0): Promise<[number, number]> {
    const managed = !state.running;
    if (managed) { state.running = true; state.stopFlag = false; }
    try { return await runCourseInner(courseId, depth); }
    finally { if (managed) state.running = false; }
  }

  async function runCourseInner(courseId: string, depth: number): Promise<[number, number]> {
    const [det, secs, library] = await openCourse(courseId);
    const name = String(det.name ?? courseId);
    state.course = name;
    log(`===== ${name} =====`);
    const todo = secs.filter((s) => !DONE.has(s.finish));
    log(`小节 ${secs.length} 个，待处理 ${todo.length}`);
    if (!secs.length) {
      log(`⚠ 章节列表为空（courseId=${courseId}）：疑似专题/非普通课程结构，或接口返回异常；先在网页端确认这门课再重试`);
      return [0, 1];
    }
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      if (state.stopFlag) break;
      const sec = todo[i]!;
      state.section = `${i + 1}/${todo.length} (${TYPE_NAME[sec.type] ?? sec.type}) ${sec.name.slice(0, 30)}`;
      state.round = 0;
      state.submitted = 0;
      log(`[${i + 1}/${todo.length}] ${state.section}`);
      try {
        const [good, msg] = await doSection(sec, { depth, courseId, library });
        if (good) { ok += 1; failed = 0; }
        else if (SKIP.has(sec.type)) skipped += 1;
        else failed += 1;
        log(`   → ${msg}`);
        if (failed >= 5) {
          log('✗ 累计 5 个小节未完成，中止本课程（可能是课程结构或接口变化，先停下避免刷屏空转）');
          break;
        }
      } catch (e) {
        if (e instanceof QuotaExhausted) {
          if (depth === 0) log('[配额] ' + e.message + '，终止全部');
          throw e;
        }
        if (e instanceof PlatformError && e.auth) throw e;
        failed += 1;
        log(`   ✗ ${e instanceof Error ? e.message : e}`);
        if (failed >= 5) {
          log('✗ 累计 5 个小节失败，中止本课程（检查网络或接口状态）');
          break;
        }
      }
    }
    return [ok, todo.length - skipped];
  }

  async function runAll(courseId = ''): Promise<{ quotaHit: boolean; error?: string }> {
    if (state.running) { log('✗ 已在运行中，请先停止'); return { quotaHit: false }; }
    state.running = true;
    state.stopFlag = false;
    let failCount = 0;
    let quotaHit = false;
    const mode = courseId ? 'course' : 'tasks';
    try {
      if (courseId) {
        log(`指定课程 → 只跑 ${courseId}`);
        try {
          const [ok, total] = await runCourse(courseId);
          if (state.stopFlag) log(`■ 已停止 (${ok}/${total})`);
          else if (ok < total) { failCount += 1; log(`⚠ 未完成 (${ok}/${total})`); }
        } catch (e) {
          if (e instanceof QuotaExhausted) quotaHit = true;
          else if (e instanceof PlatformError && e.auth) throw e;
          else { failCount += 1; log(`✗ 课程失败: ${e instanceof Error ? e.message : e}`); }
        }
      } else {
        const tasks = await undoneTasks();
        log(`学习任务：未完成 ${tasks.length} 门${tasks.some((t) => t.required === 1) ? '（必修优先）' : ''}`);
        if (!tasks.length) log('没有未完成的学习任务');
        for (const t of tasks) {
          if (state.stopFlag) { log('已停止'); break; }
          try {
            const [ok, total] = await runCourse(String(t.businessId ?? ''));
            if (ok < total) { failCount += 1; log(`⚠ ${String(t.name ?? '').slice(0, 20)} 未完成 (${ok}/${total})`); }
          } catch (e) {
            if (e instanceof QuotaExhausted) { quotaHit = true; break; }
            if (e instanceof PlatformError && e.auth) throw e;
            failCount += 1;
            log(`✗ 课程失败: ${e instanceof Error ? e.message : e}`);
          }
          await sleep(config.taskGapMs());
        }
      }
      if (quotaHit) log('⚠ 学时配额已满，已停止 (次日再试)');
      else if (!state.stopFlag) {
        log(mode === 'course'
          ? (failCount ? `⚠ 本课程处理完毕 (失败 ${failCount} 处)` : '✅ 本课程处理完毕')
          : (failCount ? `⚠ 全部任务处理完毕 (失败 ${failCount} 门)` : '✅ 全部任务处理完毕'));
      }
      return { quotaHit };
    } catch (e) {
      log(`✗ ${e instanceof Error ? e.message : e}`);
      return { quotaHit, error: e instanceof Error ? e.message : String(e) };
    } finally {
      state.running = false;
      state.course = '';
      state.section = '';
    }
  }

  function stop(): boolean {
    if (!state.running) return false;
    state.stopFlag = true;
    log('正在停止(等当前轮结束)…');
    return true;
  }

  return { runAll, stop, undoneTasks, getState: () => ({ ...state }) };
}
