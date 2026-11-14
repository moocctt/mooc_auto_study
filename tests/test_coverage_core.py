# -*- coding: utf-8 -*-
"""mooc_client / mooc_tasks 覆盖补齐：api 重试、token 续期、任务分类与专题进入。"""
import json
import time

import pytest

import mooc_api_login as m
import mooc_client
import mooc_tasks


BAD = object()


class Resp:
    def __init__(self, status=200, payload=None, ct="application/json", text="raw"):
        self.status_code = status
        self._p = payload
        self.headers = {"content-type": ct}
        self.text = text

    def json(self):
        if self._p is BAD:
            raise ValueError("not json")
        return self._p


class Sess:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.trust_env = True

    def request(self, method, url, **kw):
        self.calls.append((method, url, kw))
        return self.responses.pop(0)


@pytest.fixture
def tok(monkeypatch):
    t = {"access_token": "t0", "token_type": "Bearer"}
    monkeypatch.setattr(mooc_client, "fresh_token", lambda force=False: t)
    return t


def _sess(monkeypatch, responses):
    s = Sess(responses)
    monkeypatch.setattr(mooc_client.requests, "Session", lambda: s)
    return s


# ---------------------------------------------------------------- mooc_client.api

def test_api_returns_json(monkeypatch, tok):
    _sess(monkeypatch, [Resp(200, {"a": 1})])
    assert mooc_client.api("GET", "api/v1/x") == {"a": 1}


def test_api_absolute_url(monkeypatch, tok):
    s = _sess(monkeypatch, [Resp(200, {})])
    mooc_client.api("GET", "https://other/x")
    assert s.calls[0][1] == "https://other/x"


def test_api_401_refreshes_and_retries(monkeypatch):
    calls = {"n": 0}

    def fresh(force=False):
        calls["n"] += 1
        return {"access_token": f"t{calls['n']}", "token_type": "Bearer"}
    monkeypatch.setattr(mooc_client, "fresh_token", fresh)
    s = _sess(monkeypatch, [Resp(401, {}), Resp(200, {"ok": 1})])
    assert mooc_client.api("GET", "api/v1/x") == {"ok": 1}
    assert calls["n"] == 2 and len(s.calls) == 2


def test_api_auth_error_code_triggers_refresh(monkeypatch, tok):
    seen = {"n": 0}

    def fresh(force=False):
        seen["n"] += 1
        return {"access_token": "t", "token_type": "Bearer"}
    monkeypatch.setattr(mooc_client, "fresh_token", fresh)
    _sess(monkeypatch, [Resp(200, {"errorCode": 90901}), Resp(200, {"ok": 1})])
    assert mooc_client.api("GET", "api/v1/x") == {"ok": 1}
    assert seen["n"] == 2


def test_api_no_retry_flag(monkeypatch, tok):
    s = _sess(monkeypatch, [Resp(401, {}, ct="text/plain")])
    out = mooc_client.api("GET", "api/v1/x", _retry=False)
    assert out["_status"] == 401 and len(s.calls) == 1


def test_api_non_json_returns_text(monkeypatch, tok):
    _sess(monkeypatch, [Resp(200, None, ct="text/html", text="hi")])
    out = mooc_client.api("GET", "api/v1/x")
    assert out == {"_status": 200, "_text": "hi"}


def test_api_json_parse_error_falls_back(monkeypatch, tok):
    _sess(monkeypatch, [Resp(200, BAD, text="broken")])
    assert mooc_client.api("GET", "api/v1/x")["_text"] == "broken"


# ---------------------------------------------------------------- token 续期

def test_set_user_and_get_user(monkeypatch):
    mooc_client.set_user("alice")
    assert mooc_client.get_user() == "alice"
    mooc_client.set_user(None)
    assert mooc_client.get_user() == "default"


def test_load_token_safe_broken_file(monkeypatch, tmp_path):
    f = tmp_path / "mooc_token.json"
    f.write_text("{broken", encoding="utf-8")
    monkeypatch.setattr(m, "token_file", lambda user=None: str(f))
    assert mooc_client.load_token_safe() is None


def test_fresh_token_relogin_default(monkeypatch):
    monkeypatch.setattr(mooc_client, "_load", lambda: None)
    monkeypatch.setattr(m, "account_credentials", lambda key: ("u", "p"))
    monkeypatch.setattr(m, "login", lambda u, p, user=None: {"access_token": "new",
                                                            "token_type": "Bearer"})
    saved = {}
    monkeypatch.setattr(mooc_client, "_save", lambda tok: saved.update(tok))
    monkeypatch.setattr(m, "fetch_display_name", lambda tok: "张三")
    mooc_client._SOURCE_LOGGED = False
    tok = mooc_client.fresh_token()
    assert tok["access_token"] == "new" and tok["display_name"] == "张三"
    assert saved["access_token"] == "new"          # _save 打桩，只验落盘调用


def test_fresh_token_qr_account_without_password(monkeypatch):
    monkeypatch.setattr(mooc_client, "_load", lambda: None)
    mooc_client.set_user("uid-1")
    monkeypatch.setattr(m, "account_has_password", lambda key: False)
    with pytest.raises(SystemExit, match="没有保存账密"):
        mooc_client.fresh_token()
    mooc_client.set_user(None)


def test_fresh_token_uses_own_credentials(monkeypatch):
    """扫码账号名下若有账密，必须用它自己的，不能借用 default。"""
    monkeypatch.setattr(mooc_client, "_load", lambda: None)
    mooc_client.set_user("uid-1")
    monkeypatch.setattr(m, "account_has_password", lambda key: True)
    monkeypatch.setattr(m, "_all_accounts",
                        lambda: [{"key": "uid-1", "username": "u1", "password": "p1"},
                                 {"key": "default", "username": "du", "password": "dp"}])
    used = {}
    monkeypatch.setattr(m, "login", lambda u, p, user=None: used.update(u=u, p=p)
                        or {"access_token": "x", "token_type": "Bearer"})
    monkeypatch.setattr(mooc_client, "_save", lambda tok: None)
    monkeypatch.setattr(m, "fetch_display_name", lambda tok: None)
    mooc_client.fresh_token()
    assert used == {"u": "u1", "p": "p1"}
    mooc_client.set_user(None)


def test_fresh_token_default_without_credentials(monkeypatch):
    monkeypatch.setattr(mooc_client, "_load", lambda: None)
    monkeypatch.setattr(m, "account_credentials", lambda key: ("", ""))
    with pytest.raises(SystemExit, match="没有保存账密"):
        mooc_client.fresh_token()


def test_fresh_token_reuses_valid_token(monkeypatch):
    tok = {"access_token": "t", "token_type": "Bearer", "login_time": time.time(),
           "expires_in": 2592000, "display_name": "张三"}
    monkeypatch.setattr(mooc_client, "_load", lambda: tok)
    monkeypatch.setattr(mooc_client, "_save", lambda t: None)
    assert mooc_client.fresh_token()["access_token"] == "t"


def test_token_expired_variants():
    assert mooc_client.token_expired(None) is True
    assert mooc_client.token_expired({"access_token": "t", "login_time": 0}) is False
    assert mooc_client.token_expired({"access_token": "t", "login_time": time.time(),
                                      "expires_in": 2592000}) is False


# ---------------------------------------------------------------- mooc_tasks

def test_tasks_list_paginates_and_dedups(monkeypatch):
    pages = [{"items": [{"id": "a"}, {"id": "a"}], "recordCount": 3},
             {"items": [{"id": "b"}], "recordCount": 3}]
    monkeypatch.setattr(mooc_tasks, "api", lambda *a, **k: pages.pop(0))
    assert [t["id"] for t in mooc_tasks.list_tasks()] == ["a", "b"]


def test_tasks_classify_groups():
    now = time.time() * 1000
    items = [{"status": 1, "startTime": now + 10_000},
             {"status": 2, "startTime": 0},
             {"status": 3, "expired": False},
             {"status": 1, "expired": True}]
    out = mooc_tasks.classify(items, now)
    assert len(out["未开始"]) == 1 and len(out["未完成"]) == 2   # 过期那条也仍未完成
    assert len(out["已完成"]) == 1 and len(out["已过期"]) == 1


def test_tasks_enter_subject(monkeypatch):
    seen = []

    def fake(method, path, **kw):
        seen.append(path)
        if "register" in path:
            return {"versionId": "v1", "register": True}
        return [{"name": "章节", "courseChapterSections": []}]
    monkeypatch.setattr(mooc_tasks, "api", fake)
    det, chapters = mooc_tasks.enter_subject("C1")
    assert det["versionId"] == "v1" and isinstance(chapters, list)
    assert len(seen) == 2


def test_tasks_ts_formats(monkeypatch):
    assert mooc_tasks._ts(0) == "-"
    assert mooc_tasks._ts(1700000000000).startswith("20")


def test_print_subject_output(capsys):
    det = {"name": "专题", "courseHour": 8, "register": True, "credit": None,
           "registerMemberCount": 10}
    chapters = [{"name": "第一章", "courseChapterSections": [
        {"name": "小节A", "type": 6, "progress": {"finishStatus": 2}, "courseTime": 300},
        {"courseInfo": {"name": "小节B", "type": 5, "courseTime": 60},
         "progress": {"finishStatus": 1}},
        {"name": "小节C"}]}]
    mooc_tasks.print_subject(det, chapters)
    out = capsys.readouterr().out
    assert "专题" in out and "小节A" in out and "小节B" in out
    assert "小计: 1/3 小节已完成" in out


def test_main_enters_first_active_subject(monkeypatch, capsys):
    items = [{"id": "1", "name": "在期专题", "businessId": "C1", "businessType": 2,
              "status": 2, "startTime": 0, "endTime": 0},
             {"id": "2", "name": "未来课程", "businessId": "C2", "businessType": 1,
              "status": 1, "startTime": time.time() * 1000 + 100000, "endTime": 0}]
    monkeypatch.setattr(mooc_tasks, "list_tasks", lambda: items)
    entered = []
    monkeypatch.setattr(mooc_tasks, "enter_subject",
                        lambda bid: (entered.append(bid), ({"name": "专题"}, []))[1])
    mooc_tasks.main()
    out = capsys.readouterr().out
    assert "任务总数(去重): 2" in out and "== 未开始 (1) ==" in out
    assert entered == ["C1"]


def test_main_without_subjects(monkeypatch, capsys):
    monkeypatch.setattr(mooc_tasks, "list_tasks", lambda: [
        {"id": "1", "name": "课程", "businessId": "C1", "businessType": 1,
         "status": 1, "startTime": 0, "endTime": 0}])
    monkeypatch.setattr(mooc_tasks, "enter_subject", lambda bid: pytest.fail("不该进入"))
    mooc_tasks.main()
    assert "任务总数(去重): 1" in capsys.readouterr().out


def test_load_token_missing_and_broken(monkeypatch, tmp_path):
    monkeypatch.setattr(mooc_client, "_token_file", lambda: str(tmp_path / "nope.json"))
    assert mooc_client.load_token_safe() is None
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    monkeypatch.setattr(mooc_client, "_token_file", lambda: str(bad))
    assert mooc_client.load_token_safe() is None


def test_load_token_success(monkeypatch, tmp_path):
    f = tmp_path / "ok.json"
    f.write_text(json.dumps({"access_token": "a"}), encoding="utf-8")
    monkeypatch.setattr(mooc_client, "_token_file", lambda: str(f))
    assert mooc_client.load_token_safe()["access_token"] == "a"


def test_save_writes_login_time(monkeypatch, tmp_path):
    f = tmp_path / "s.json"
    monkeypatch.setattr(mooc_client, "_token_file", lambda: str(f))
    mooc_client._save({"access_token": "a"})
    assert json.loads(f.read_text(encoding="utf-8"))["login_time"] > 0
