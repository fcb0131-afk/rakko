/* =============================================================
   朝の15分 — app.js

   考え方：PDCAを本人に回させない。アプリが代わりに回す。
     Plan  … roadmap.js の順番がそのまま計画
     Do    … 今日の1個だけを出す
     Check … 完走見込み日を自動計算
     Act   … 遅れたら、必ず間に合う戻し方を計算して提示する
   ============================================================= */

const App = (function () {
  "use strict";

  const KEY = "asa15.v1";
  const DEADLINE = "2027-03-31";
  const FIRST_TARGET = 10000;
  const MAX_PER_WEEKDAY = 3;

  /* ---------------- 日付まわり ---------------- */

  function todayISO() {
    return toISO(new Date());
  }

  function toISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function fromISO(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function isWeekday(d) {
    const w = d.getDay();
    return w >= 1 && w <= 5;
  }

  /** from（含む）から to（含まない）までの平日数 */
  function weekdaysBetween(fromDate, toDate) {
    if (toDate <= fromDate) return 0;
    let n = 0;
    const cur = new Date(fromDate.getTime());
    while (cur < toDate) {
      if (isWeekday(cur)) n++;
      cur.setDate(cur.getDate() + 1);
    }
    return n;
  }

  /** 基準日から n 平日ぶん進めた日付（基準日自体が平日ならそれを1日目に数える） */
  function addWeekdays(fromDate, n) {
    const cur = new Date(fromDate.getTime());
    if (n <= 0) return cur;
    let left = n;
    while (left > 0) {
      if (isWeekday(cur)) left--;
      if (left > 0) cur.setDate(cur.getDate() + 1);
    }
    // 基準日が休日なら、最初の平日まで送る
    while (!isWeekday(cur)) cur.setDate(cur.getDate() + 1);
    return cur;
  }

  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  function fmtDot(d) {
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  }

  function fmtStamp(d) {
    const wd = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()];
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${fmtDot(d)} ${wd} ${hh}:${mm}`;
  }

  function yen(n) {
    return "¥" + Number(n || 0).toLocaleString("ja-JP");
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------------- 状態 ---------------- */

  let state = null;
  let lastXDraft = "";

  function defaultState() {
    return {
      version: 1,
      startDate: todayISO(),
      deadline: DEADLINE,
      theme: null, // null = 端末の設定に従う
      pace: { perWeekday: 1 },
      items: {},
      deferred: [],
      revenue: [],
      lastBackupAt: null
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return defaultState();
      return Object.assign(defaultState(), parsed);
    } catch (e) {
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      toast("保存できませんでした");
    }
  }

  /* ---------------- ロードマップの参照 ---------------- */

  /** roadmap.js を1本のリストに平坦化（フェーズ名つき） */
  function allItems() {
    const out = [];
    ROADMAP.forEach(function (phase) {
      phase.items.forEach(function (item, i) {
        out.push(Object.assign({}, item, { phase: phase.phase, indexInPhase: i }));
      });
    });
    return out;
  }

  function isDeferred(id) {
    return state.deferred.indexOf(id) !== -1;
  }

  function isDone(id) {
    return !!(state.items[id] && state.items[id].done);
  }

  function activeItems() {
    return allItems().filter(function (it) { return !isDeferred(it.id); });
  }

  function doneCount() {
    return activeItems().filter(function (it) { return isDone(it.id); }).length;
  }

  /** 今日やる1個：done でも あとで でもない、最初の項目 */
  function currentItem() {
    return activeItems().find(function (it) { return !isDone(it.id); }) || null;
  }

  function doneTodayCount() {
    const t = todayISO();
    return Object.keys(state.items).filter(function (id) {
      return state.items[id].done && state.items[id].doneAt === t;
    }).length;
  }

  function stepNumberOf(item) {
    const phaseIndex = ROADMAP.findIndex(function (p) { return p.phase === item.phase; });
    return phaseIndex >= 0 ? phaseIndex : 0;
  }

  /* ---------------- ペース計算 ---------------- */

  function pace() {
    const today = fromISO(todayISO());
    const deadline = fromISO(state.deadline);
    const total = activeItems().length;
    const done = doneCount();
    const remaining = Math.max(0, total - done);
    const perWeekday = state.pace.perWeekday;

    const eta = remaining === 0
      ? today
      : addWeekdays(today, Math.ceil(remaining / perWeekday));

    const elapsedWeekdays = weekdaysBetween(fromISO(state.startDate), today);
    const expected = Math.min(total, elapsedWeekdays * perWeekday);

    return {
      total: total,
      done: done,
      remaining: remaining,
      perWeekday: perWeekday,
      eta: eta,
      deadline: deadline,
      onTrack: eta <= deadline,
      monthsSpare: Math.floor(daysBetween(eta, deadline) / 30),
      actualPct: total ? (done / total) * 100 : 0,
      expectedPct: total ? (expected / total) * 100 : 0,
      daysToDeadline: Math.max(0, daysBetween(today, deadline))
    };
  }

  /** remaining 個を perWeekday ペースで消化したときの完走日 */
  function etaFor(remaining, perWeekday) {
    const today = fromISO(todayISO());
    if (remaining <= 0) return today;
    return addWeekdays(today, Math.ceil(remaining / perWeekday));
  }

  /** 「あとで」に回せる候補（未完了で optional なもの） */
  function deferrableItems() {
    return activeItems().filter(function (it) {
      return it.optional && !isDone(it.id);
    });
  }

  /** 最後の砦：1万円に直結しない項目（optional ＋ 最終フェーズ） */
  function nonEssentialItems() {
    const lastPhase = ROADMAP[ROADMAP.length - 1].phase;
    return activeItems().filter(function (it) {
      return !isDone(it.id) && (it.optional || it.phase === lastPhase);
    });
  }

  /**
   * 挽回案を計算する。
   * 「間に合わせる方法がない」状態を絶対に作らないため、
   * 最後は必ず期限を引き直す案を返す。
   */
  function computeFixes() {
    const p = pace();
    const fixes = [];

    // 案1：平日の個数を増やす
    for (let per = p.perWeekday + 1; per <= MAX_PER_WEEKDAY; per++) {
      const eta = etaFor(p.remaining, per);
      if (eta <= p.deadline) {
        fixes.push({
          title: `平日に1日${per}個ずつ`,
          sub: `→ ${fmtDot(eta)} 完走の見込みに戻る`,
          apply: function () {
            state.pace.perWeekday = per;
            save();
            toast(`平日に1日${per}個ずつ進める設定にしました`);
          }
        });
        break;
      }
    }

    // 案2：後回しでいい項目を外す
    const deferrable = deferrableItems();
    if (deferrable.length) {
      for (let n = 1; n <= deferrable.length; n++) {
        const eta = etaFor(p.remaining - n, p.perWeekday);
        if (eta <= p.deadline) {
          fixes.push({
            title: "後回しでいい項目を外す",
            sub: `→ ${n}項目を「あとで」に送れば間に合う`,
            apply: function () {
              deferrable.slice(0, n).forEach(function (it) { state.deferred.push(it.id); });
              save();
              toast(`${n}項目を「あとで」に送りました`);
            }
          });
          break;
        }
      }
    }

    if (fixes.length) return fixes;

    // 案3：1万円に直結する項目だけに絞る
    const nonEssential = nonEssentialItems();
    if (nonEssential.length) {
      const etaTrimmed = etaFor(p.remaining - nonEssential.length, MAX_PER_WEEKDAY);
      if (etaTrimmed <= p.deadline) {
        fixes.push({
          title: "まず1万円に必要な項目だけに絞る",
          sub: `→ ${nonEssential.length}項目をあとに回し、${fmtDot(etaTrimmed)} 完走`,
          apply: function () {
            nonEssential.forEach(function (it) { state.deferred.push(it.id); });
            state.pace.perWeekday = MAX_PER_WEEKDAY;
            save();
            toast("いま必要な項目だけに絞りました");
          }
        });
        return fixes;
      }
    }

    // 最後の砦：期限を置き直す。ここで必ず「間に合う」状態に戻す
    const newEta = etaFor(p.remaining, p.perWeekday);
    fixes.push({
      title: "ゴールの日を置き直す",
      sub: `→ 期限を ${fmtDot(newEta)} にすれば、今のペースのままで届く`,
      apply: function () {
        state.deadline = toISO(newEta);
        save();
        toast("ゴールの日を置き直しました");
      }
    });
    return fixes;
  }

  /* ---------------- 描画 ---------------- */

  const ICON = {
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    now: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"></circle></svg>',
    todo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9"></circle></svg>',
    later: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
  };

  function renderAll() {
    renderTheme();
    renderStamp();
    renderFlip();
    renderTask();
    renderPace();
    renderRoadmap();
    renderRevenue();
    renderBackupInfo();
    renderXDraft();
  }

  function renderStamp() {
    document.getElementById("stamp").textContent = fmtStamp(new Date());
  }

  function renderFlip() {
    const p = pace();
    document.getElementById("deadlineLabel").textContent = fmtDot(p.deadline);

    const days = String(p.daysToDeadline);
    const chars = days.length < 2 ? days.padStart(2, "0") : days;
    document.getElementById("digits").innerHTML = chars
      .split("")
      .map(function (c) { return `<div class="digit"><span>${c}</span></div>`; })
      .join("");

    document.getElementById("footPct").textContent = Math.round(p.actualPct) + "%";
    document.getElementById("footRev").textContent = yen(revenueTotal());

    const footPace = document.getElementById("footPace");
    if (p.remaining === 0) {
      footPace.textContent = "DONE";
      footPace.style.color = "#4fe3b4";
    } else if (p.onTrack) {
      footPace.textContent = p.monthsSpare >= 1 ? `+${p.monthsSpare} MO` : "ON TIME";
      footPace.style.color = "#4fe3b4";
    } else {
      footPace.textContent = "ADJUST";
      footPace.style.color = "#ffb45c";
    }
  }

  function renderTask() {
    const panel = document.getElementById("taskPanel");
    const item = currentItem();

    // すべて完了
    if (!item) {
      panel.className = "p";
      panel.innerHTML = `
        <div class="allclear">
          <div class="big">ロードマップを走り切りました</div>
          <div class="sm">
            ここまで来られたのは、毎朝の15分を積み重ねたからです。<br>
            「あとで」に送った項目があれば、下のロードマップから戻せます。
          </div>
        </div>`;
      return;
    }

    const quota = state.pace.perWeekday;
    const doneToday = doneTodayCount();
    const restMode = doneToday >= quota;

    // 今日のぶんは終わっている
    if (restMode) {
      panel.className = "p";
      panel.innerHTML = `
        <div class="p-head"><span class="p-ttl">TODAY</span>
          <span class="tag mint">今日はここまで</span>
        </div>
        <div class="rest">
          <div class="big">おつかれさまでした</div>
          <div class="sm">
            今日のぶんは終わっています。ここで閉じて大丈夫です。<br>
            もし進めたい気分なら、次の1個をどうぞ。
          </div>
          <div class="b-row">
            <button class="b b-out" onclick="App.showNext()">次の1個を見る</button>
          </div>
        </div>`;
      return;
    }

    renderTaskCard(item, doneToday, quota);
  }

  function renderTaskCard(item, doneToday, quota) {
    const panel = document.getElementById("taskPanel");
    const step = stepNumberOf(item);
    const promptBlock = item.prompt
      ? `<div class="pr">
           <div class="pr-head">
             <span class="l">PROMPT</span>
             <button class="lnk" onclick="App.copyPrompt()">${ICON.copy} COPY</button>
           </div>
           <div class="pr-body" id="promptBody">${esc(item.prompt)}</div>
         </div>`
      : "";

    const moreNote = quota > 1 && doneToday > 0
      ? `<div class="more-note">今日はあと ${quota - doneToday} 個（任意）</div>`
      : "";

    panel.className = "p";
    panel.innerHTML = `
      <div class="t-meta">
        <span class="t-step">STEP ${step}</span>
        <span class="t-sub">${esc(item.phase.replace(/^\d+\.\s*/, ""))} ・ 目安 ${item.minutes}分</span>
      </div>
      <div class="t-ttl">${esc(item.title)}</div>
      <div class="t-desc">${esc(item.desc)}</div>
      ${promptBlock}
      <div class="b-row">
        <button class="b b-led" onclick="App.completeCurrent()">完了にする</button>
      </div>
      ${moreNote}`;
  }

  function renderPace() {
    const p = pace();
    const tag = document.getElementById("paceTag");
    const gauge = document.getElementById("gauge");
    const say = document.getElementById("paceSay");
    const fixBox = document.getElementById("fixBox");
    const legDot = document.getElementById("legDot");

    document.getElementById("paceEta").textContent =
      p.remaining === 0 ? "完走" : fmtDot(p.eta);

    document.getElementById("gAct").style.width = p.actualPct + "%";
    document.getElementById("gPlan").style.left = p.expectedPct + "%";

    if (p.remaining === 0) {
      tag.className = "tag mint";
      tag.textContent = "完走";
      gauge.classList.remove("behind");
      legDot.style.background = "var(--mint)";
      say.innerHTML = "ロードマップは走り切りました。ここからは自分のペースで大丈夫です。";
      fixBox.hidden = true;
      return;
    }

    if (p.onTrack) {
      tag.className = "tag mint";
      tag.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>余裕あり';
      gauge.classList.remove("behind");
      legDot.style.background = "var(--mint)";
      say.innerHTML = p.monthsSpare >= 1
        ? `このペースなら、期限より <b>約${p.monthsSpare}ヶ月早く</b> 走り切れます。焦らず1日${p.perWeekday}個でOKです。`
        : `このペースなら期限内に走り切れます。焦らず1日${p.perWeekday}個でOKです。`;
      fixBox.hidden = true;
      return;
    }

    // 遅れているとき
    tag.className = "tag lamp";
    tag.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"></path><polyline points="3 3 3 9 9 9"></polyline></svg>ペースを引き直しました';
    gauge.classList.add("behind");
    legDot.style.background = "var(--lamp)";
    say.innerHTML = "少し間があきましたね。<b>まだ十分間に合います。</b>下から戻し方をひとつ選ぶだけで、ペースを引き直します。";

    const fixes = computeFixes();
    window.__fixes = fixes;
    document.getElementById("fixOptions").innerHTML = fixes
      .map(function (f, i) {
        return `<button class="fix-o" onclick="App.applyFix(${i})">
                  <span><span class="t">${esc(f.title)}</span><span class="s mono">${esc(f.sub)}</span></span>
                  <span class="a">→</span>
                </button>`;
      })
      .join("");
    fixBox.hidden = false;
  }

  function renderRoadmap() {
    const total = activeItems().length;
    const done = doneCount();
    const pct = total ? Math.round((done / total) * 100) : 0;

    document.getElementById("itemCount").textContent = total + " ITEMS";
    document.getElementById("pgTotal").textContent = total;
    document.getElementById("pgDone").textContent = done;
    document.getElementById("pgPct").textContent = pct + "%";
    document.getElementById("pgBar").style.width = pct + "%";

    const cur = currentItem();
    const html = ROADMAP.map(function (phase) {
      const items = phase.items;
      const d = items.filter(function (it) { return isDone(it.id) && !isDeferred(it.id); }).length;
      const active = items.filter(function (it) { return !isDeferred(it.id); }).length;

      const rows = items.map(function (it) {
        let cls, icon, badge = "";
        if (isDeferred(it.id)) {
          cls = "later"; icon = ICON.later;
          badge = '<span class="later-badge">あとで</span>';
        } else if (isDone(it.id)) {
          cls = "done"; icon = ICON.done;
        } else if (cur && cur.id === it.id) {
          cls = "now"; icon = ICON.now;
        } else {
          cls = "todo"; icon = ICON.todo;
        }
        return `<button class="rm-i ${cls}" onclick="App.toggleItem('${it.id}')">
                  ${icon}<span>${esc(it.title)}${badge}</span>
                </button>`;
      }).join("");

      return `<div>
                <div class="rm-h"><span class="nm">${esc(phase.phase)}</span>
                <span class="ct mono">${d} / ${active}</span></div>
                ${rows}
              </div>`;
    }).join("");

    document.getElementById("rm").innerHTML = html;
  }

  function revenueTotal() {
    return state.revenue.reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);
  }

  function renderRevenue() {
    const total = revenueTotal();
    document.getElementById("revTotal").textContent = yen(total);
    document.getElementById("revBar").style.width =
      Math.min(100, (total / FIRST_TARGET) * 100) + "%";

    const body = document.getElementById("revBody");
    if (!state.revenue.length) {
      body.innerHTML = '<div class="mo-empty">まだ実績はありません。最初の1件は、ここに積み上がります。</div>';
      return;
    }

    const rows = state.revenue
      .slice()
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; })
      .map(function (r, i) {
        return `<div class="mo-item">
                  <span class="mi-l">
                    <span class="mi-t">${esc(r.title)}</span>
                    <span class="mi-d mono">${esc(r.date)}</span>
                  </span>
                  <span class="mi-a mono">${yen(r.amount)}</span>
                  <button class="mi-x" title="削除" onclick="App.removeRevenue('${esc(r.id)}')">×</button>
                </div>`;
      }).join("");

    body.innerHTML = `<div class="mo-list">${rows}</div>`;
  }

  function renderBackupInfo() {
    document.getElementById("lastBackup").textContent =
      state.lastBackupAt ? state.lastBackupAt.replace(/-/g, ".") : "まだありません";
  }

  function buildXDraft() {
    const p = pace();
    const item = currentItem();
    const dayNo = daysBetween(fromISO(state.startDate), fromISO(todayISO())) + 1;

    if (!item) {
      return `Day${dayNo}. note×X×AIの副業ロードマップ、ひととおり走り切りました。（${p.done}/${p.total} 完了）\n#副業記録`;
    }
    if (doneTodayCount() > 0) {
      return `Day${dayNo}. 今日は「${item.title}」の手前まで進みました。（${p.done}/${p.total} 完了）\n#副業記録`;
    }
    return `Day${dayNo}. 今日は「${item.title}」から。朝の15分だけ、コツコツやっています。（${p.done}/${p.total} 完了）\n#副業記録`;
  }

  function renderXDraft(force) {
    const ta = document.getElementById("xText");
    // 本人が書き換えている途中なら、上書きしない
    if (!force && ta.value && ta.value !== lastXDraft) return;
    lastXDraft = buildXDraft();
    ta.value = lastXDraft;
  }

  /* ---------------- 操作 ---------------- */

  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1900);
  }

  function completeCurrent() {
    const item = currentItem();
    if (!item) return;
    state.items[item.id] = { done: true, doneAt: todayISO() };
    save();
    renderAll();
    toast("積み上げが1個増えました");
  }

  /** ロードマップ一覧から直接切り替える（「あとで」は元に戻す） */
  function toggleItem(id) {
    if (isDeferred(id)) {
      state.deferred = state.deferred.filter(function (x) { return x !== id; });
      save();
      renderAll();
      toast("ロードマップに戻しました");
      return;
    }
    if (isDone(id)) {
      delete state.items[id];
      toast("チェックを外しました");
    } else {
      state.items[id] = { done: true, doneAt: todayISO() };
      toast("完了にしました");
    }
    save();
    renderAll();
  }

  /** 今日のぶんが終わったあと、あえて次を出す */
  function showNext() {
    const item = currentItem();
    if (!item) return;
    renderTaskCard(item, 0, 1);
  }

  function applyFix(i) {
    const fixes = window.__fixes || [];
    if (!fixes[i]) return;
    fixes[i].apply();
    renderAll();
  }

  function copyPrompt() {
    const el = document.getElementById("promptBody");
    if (!el) return;
    copyText(el.textContent, "プロンプトをコピーしました");
  }

  function copyX() {
    copyText(document.getElementById("xText").value, "コピーしました");
  }

  function copyText(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(msg); },
        function () { fallbackCopy(text, msg); }
      );
    } else {
      fallbackCopy(text, msg);
    }
  }

  function fallbackCopy(text, msg) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast(msg); }
    catch (e) { toast("コピーできませんでした"); }
    document.body.removeChild(ta);
  }

  function openX() {
    const text = encodeURIComponent(document.getElementById("xText").value);
    window.open("https://x.com/intent/post?text=" + text, "_blank", "noopener");
  }

  function regenerateXDraft() {
    renderXDraft(true);
    toast("下書きを作り直しました");
  }

  /* ---------------- 収益 ---------------- */

  function toggleRevenueForm() {
    const form = document.getElementById("revForm");
    const btn = document.getElementById("revToggle");
    form.hidden = !form.hidden;
    btn.textContent = form.hidden ? "+ 記録する" : "閉じる";
    if (!form.hidden) {
      document.getElementById("revDate").value = todayISO();
      document.getElementById("revTitle").focus();
    }
  }

  function addRevenue() {
    const title = document.getElementById("revTitle").value.trim();
    const date = document.getElementById("revDate").value || todayISO();
    const amount = Number(document.getElementById("revAmount").value);

    if (!title) { toast("何が売れたかを入れてください"); return; }
    if (!amount || amount <= 0) { toast("金額を入れてください"); return; }

    state.revenue.push({
      id: "r" + Date.now(),
      title: title,
      date: date,
      amount: amount
    });
    save();

    document.getElementById("revTitle").value = "";
    document.getElementById("revAmount").value = "";
    toggleRevenueForm();
    renderAll();

    const total = revenueTotal();
    if (total >= FIRST_TARGET) {
      toast("最初の1万円、達成しました");
    } else {
      toast("記録しました");
    }
  }

  function removeRevenue(id) {
    state.revenue = state.revenue.filter(function (r) { return r.id !== id; });
    save();
    renderAll();
    toast("削除しました");
  }

  /* ---------------- バックアップ ---------------- */

  function exportData() {
    state.lastBackupAt = todayISO();
    save();

    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "asa15-backup-" + todayISO().replace(/-/g, "") + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    renderBackupInfo();
    toast("書き出しました");
  }

  function importData() {
    document.getElementById("importFile").click();
  }

  function handleImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || parsed.version !== 1 || typeof parsed.items !== "object") {
          toast("このファイルは読み込めません");
          return;
        }
        if (!confirm("今の記録を、このファイルの内容で置き換えます。よろしいですか？")) return;
        state = Object.assign(defaultState(), parsed);
        save();
        renderAll();
        toast("読み込みました");
      } catch (err) {
        toast("このファイルは読み込めません");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  /* ---------------- テーマ ---------------- */

  function setTheme(t) {
    state.theme = t;
    save();
    renderTheme();
  }

  function renderTheme() {
    const prefersDark = window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    const t = state.theme || (prefersDark ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", t);
    document.getElementById("tLight").setAttribute("aria-pressed", String(t === "light"));
    document.getElementById("tDark").setAttribute("aria-pressed", String(t === "dark"));
  }

  /* ---------------- 起動 ---------------- */

  function init() {
    state = load();
    save(); // 初回に startDate を固定する
    document.getElementById("importFile").addEventListener("change", handleImportFile);
    renderAll();

    // 日付をまたいだまま開きっぱなしのときのために
    setInterval(renderStamp, 30000);

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(function () { /* 失敗しても動く */ });
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  return {
    setTheme: setTheme,
    completeCurrent: completeCurrent,
    toggleItem: toggleItem,
    showNext: showNext,
    applyFix: applyFix,
    copyPrompt: copyPrompt,
    copyX: copyX,
    openX: openX,
    regenerateXDraft: regenerateXDraft,
    toggleRevenueForm: toggleRevenueForm,
    addRevenue: addRevenue,
    removeRevenue: removeRevenue,
    exportData: exportData,
    importData: importData
  };
})();
