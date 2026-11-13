const LIBRARY_TYPES = [
  {
    id: 0,
    label: "\u8BFE\u7A0B",
    path: "/api/v1/course-study/course-front/findPageForGlobalSearch",
    params: (kw) => ({ type: 0, publishClient: 1, searchContent: kw })
  },
  {
    id: 2,
    label: "\u4E13\u9898",
    path: "/api/v1/course-study/course-front/findPageForGlobalSearch",
    params: (kw) => ({ type: 2, publishClient: 1, searchContent: kw })
  },
  {
    id: 4,
    label: "\u73ED\u7EA7",
    path: "/api/v1/training/student/class-info/simple-activity-list",
    params: (kw) => ({ name: kw })
  },
  {
    id: 5,
    label: "\u8003\u8BD5",
    path: "/api/v1/exam/exam/front/activity-list",
    params: (kw) => ({ clientType: 1, name: kw })
  },
  {
    id: 6,
    label: "\u8C03\u7814",
    path: "/api/v1/exam/research-activity/activity-list",
    params: (kw) => ({ name: kw })
  },
  {
    id: 7,
    label: "\u76F4\u64AD",
    path: "/api/v1/course-study/gensee/activity-list",
    params: (kw) => ({ clientType: 1, name: kw })
  },
  {
    id: 11,
    label: "\u8BDD\u9898",
    path: "/api/v1/ask-bar/topic/name",
    params: (kw) => ({ name: kw })
  },
  {
    id: 12,
    label: "\u77E5\u8BC6",
    path: "/api/v1/course-study/knowledge/front",
    params: (kw) => ({ clientType: 1, orderType: 0, name: kw })
  },
  {
    id: 14,
    label: "\u5FAE\u543C\u76F4\u64AD",
    path: "/api/v1/live/new/activity-list",
    params: (kw) => ({ clientType: 1, subject: kw })
  },
  {
    id: 15,
    label: "\u65B0\u95FB\u8D44\u8BAF",
    path: "/api/v1/system/home-news/findNewsForGlobalSearch",
    params: (kw) => ({ newsName: kw })
  },
  {
    id: 16,
    label: "\u4EA4\u6D41\u56ED\u5730",
    path: "/api/v1/system/home-interchange/findInterchangeForGlobalSearch",
    params: (kw) => ({ interchangeName: kw })
  },
  {
    id: 20,
    label: "\u4E13\u533A\u4E13\u5BB6",
    path: "/api/v1/system/expert-database/findExpertDatabaseForGlobalSearch",
    params: (kw) => ({ expertDatabaseName: kw })
  }
];
function rawTypeOf(it) {
  for (const k of ["type", "courseType", "businessType", "kindType"]) {
    const v = it?.[k];
    if (v === void 0 || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
const AVAIL_KEY = "mooc.console.libTypes.v1";
const AVAIL_TTL = 24 * 36e5;
function readAvailTypes(ak) {
  try {
    const all = JSON.parse(localStorage.getItem(AVAIL_KEY) || "{}");
    const rec = all?.[ak];
    if (!rec || !Array.isArray(rec.ids) || !(Date.now() - Number(rec.at) < AVAIL_TTL)) return null;
    return rec.ids.includes(0) ? rec.ids : [0, ...rec.ids];
  } catch {
    return null;
  }
}
function writeAvailTypes(ak, ids) {
  try {
    const all = JSON.parse(localStorage.getItem(AVAIL_KEY) || "{}");
    all[ak] = { at: Date.now(), ids };
    localStorage.setItem(AVAIL_KEY, JSON.stringify(all));
  } catch {
  }
}
export {
  LIBRARY_TYPES,
  rawTypeOf,
  readAvailTypes,
  writeAvailTypes
};
