export const API = {
  TASKS: '/api/v1/human/task',
  START: '/api/v1/course-study/course-front/start-progress',
  VIDEO: '/api/v1/course-study/course-front/video-progress',
  DOC: '/api/v1/course-study/course-front/doc-progress',
  PROGRESS_UPD: '/api/v1/course-study/course-front/course-progress-update',
  CHAPTERS: '/api/v1/course-study/subject/chapter-progress',
  REGISTER: '/api/v1/course-study/course-front/register',
  SECTION_PROGRESS: '/api/v1/course-study/course-front/course-section-progress',
  INFO: '/api/v1/course-study/course-front/info',
  REGISTER_STUDY: '/api/v1/course-study/course-front/registerStudy',
  SEARCH: '/api/v1/course-study/course-front/findPageForGlobalSearch',
  HOURS: '/api/v1/system/cadre-education/detail-hour-member',
  PERSON_COURSE: '/api/v1/course-study/course-study-progress/personCourse-list',
  COURSE_LOG: '/api/v1/course-study/course-study-progress/person-courselog',
  SUBJECT_LOG: '/api/v1/course-study/course-study-progress/subject-log',
  MAX_STEP: 90,
} as const;

export const SEARCH_TYPE: Record<string, number> = { course: 0, subject: 2 };

export interface LibrarySpec {
  id: number; label: string; path: string; params: (kw: string) => Record<string, unknown>;
  linkable?: boolean;
}

export const LIBRARY_TYPES: LibrarySpec[] = [
  { id: 0, label: '课程', path: API.SEARCH, params: (kw) => ({ type: 0, publishClient: 1, searchContent: kw }), linkable: true },
  { id: 2, label: '专题', path: API.SEARCH, params: (kw) => ({ type: 2, publishClient: 1, searchContent: kw }), linkable: true },
  { id: 4, label: '班级', path: '/api/v1/training/student/class-info/simple-activity-list', params: (kw) => ({ name: kw }) },
  { id: 5, label: '考试', path: '/api/v1/exam/exam/front/activity-list', params: (kw) => ({ clientType: 1, name: kw }) },
  { id: 6, label: '调研', path: '/api/v1/exam/research-activity/activity-list', params: (kw) => ({ name: kw }) },
  { id: 7, label: '直播', path: '/api/v1/course-study/gensee/activity-list', params: (kw) => ({ clientType: 1, name: kw }) },
  { id: 11, label: '话题', path: '/api/v1/ask-bar/topic/name', params: (kw) => ({ name: kw }) },
  { id: 12, label: '知识', path: '/api/v1/course-study/knowledge/front', params: (kw) => ({ clientType: 1, orderType: 0, name: kw }) },
  { id: 14, label: '微吼直播', path: '/api/v1/live/new/activity-list', params: (kw) => ({ clientType: 1, subject: kw }) },
  { id: 15, label: '新闻资讯', path: '/api/v1/system/home-news/findNewsForGlobalSearch', params: (kw) => ({ newsName: kw }) },
  { id: 16, label: '交流园地', path: '/api/v1/system/home-interchange/findInterchangeForGlobalSearch', params: (kw) => ({ interchangeName: kw }) },
  { id: 20, label: '专区专家', path: '/api/v1/system/expert-database/findExpertDatabaseForGlobalSearch', params: (kw) => ({ expertDatabaseName: kw }) },
];

export const DONE = new Set([2, 4]);
export const SKIP = new Set([4, 8, 9, 12, 13, 15]);
export const MEDIA = new Set([5, 6]);
export const NESTED = 10;
export const TYPE_NAME: Record<number, string> = {
  1: 'pdf', 2: '图片', 3: '外链', 4: 'scorm', 5: 'mp3', 6: 'mp4', 7: 'epub',
  8: '任务', 9: '考试', 10: '关联课程', 12: '问卷', 13: '评估', 15: '课件',
};
