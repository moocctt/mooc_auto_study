const COURSE_ENTRY_RE = /course\/detail\/\d+&([^&]+)/;
const SUBJECT_ENTRY_RE = /subject\/detail\/([^&/?#]+)/;
const SUBJECT_SECTION_RE = /\/study\/course\/detail\/\d+&[0-9a-zA-Z-]+\/\d+\/\d+\/([0-9a-zA-Z-]+)/;
function courseIdOf(url) {
  const u = decodeURIComponent(url);
  const m = u.match(COURSE_ENTRY_RE) || u.match(SUBJECT_ENTRY_RE);
  return m ? m[1] : "";
}
function freshUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("ap", String(Date.now()));
    return u.toString();
  } catch {
    return url;
  }
}
function landedUrlOk(url, targetId) {
  const u = decodeURIComponent(String(url || ""));
  return !!targetId && u.includes(targetId) && !u.includes("access_token=") && /\/study\/(course\/detail\/\d+&|subject\/detail\/)/.test(u);
}
function courseEntryHash(type, rid) {
  return `#/study/course/detail/${type}&${rid}`;
}
function subjectHash(subjectId) {
  return `#/study/subject/detail/${subjectId}`;
}
export {
  COURSE_ENTRY_RE,
  SUBJECT_ENTRY_RE,
  SUBJECT_SECTION_RE,
  courseEntryHash,
  courseIdOf,
  freshUrl,
  landedUrlOk,
  subjectHash
};
