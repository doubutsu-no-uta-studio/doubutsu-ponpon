/* 登録待ちの自動再送
   ユーザーが「とうろくする」と同意したスコア（Players の pendingScore）だけを、
   通信が使えるときに自動で Ranking.submit で送る。
   同意していないスコア（自己ベストを更新しただけ）は、送らない。

   ■ いつ送るか
   ・ゲームを開いたとき（登録待ちがあれば）
   ・ゲームを開いている間に、通信がもどったとき（online イベント）
   ・失敗したあとは、間隔をだんだん延ばして、自動で再試行する
   ・ページを閉じている間の送信はしない

   ■ 失敗の分け方
   ・一時的（オフライン・タイムアウト・混雑・ログイン待ち・原因不明）→ 登録待ちを残して、再試行する
   ・権限エラー → 判定があいまいなので1回だけ時間をおいて再試行し、同じなら止める
   ・得点・名前が条件外、プレイヤーがいない → 止める（再試行しても直らない）
   ・止めたものは、自動では送らない。画面の「もういちど ためす」で、人が再試行する

   ■ 守っていること
   ・1度に1件だけ送り、続けて送るときも間隔をあける（大量の通信を出さない）
   ・同じプレイヤーの並行送信は、Ranking.submit 側でも防いでいる。画面側が送信中なら、ここでは送らない
   ・送信成功を確認するまで、登録待ちは消さない（消すのは Ranking.submit→markRegistered）
   ・登録済みの得点は下げない（Ranking.submit が、サーバーの高い得点を優先する）

   公開API（window.AutoSync）
     getStatus(id)         { state: "idle"|"waiting"|"sending"|"stopped", code, message, attempts, nextAt }
     retryNow(id)          止めていたものも含めて、いますぐ送り直す
     cancel(id)            登録待ちを取り消す（送信中は取り消せない）。自己ベストは消えない
     noteFailure(id, r)    画面側の送信が失敗したとき、結果を渡す（自動再送の対象にする）
     config                間隔などの設定（動作確認用に変更できる）

   イベント
     autosync:changed      状態が変わった
     autosync:registered   自動で登録できた（detail: playerId, name, score, rank, code）
*/

const config = {
  backoffMs: [5000, 15000, 45000, 120000, 300000],  // 失敗が続くほど、間隔をのばす（最後の値が上限）
  startDelayMs: 1500,        // ゲームを開いてから、最初に送るまで
  firstDelayMs: 3000,        // あとから登録待ちが増えたとき、画面側の送信を待つ時間
  minGapMs: 1500,            // 続けて送るときの最短の間隔
  permissionRetryMs: 7000,   // 権限エラーを、1回だけ再試行するまで
  maxUnknownFailures: 5,     // 原因不明のエラーが続いたら、止める
  toastMs: 4500              // 成功の通知を出している時間
};

// 時間をおけば、成功するかもしれないエラー
const TRANSIENT = new Set(["offline", "timeout", "busy", "unauthenticated", "not-connected", "unknown"]);

const states = new Map();   // playerId → { attempts, nextAt, stopped, ... }
const busy = new Set();     // この自動送信の中で、送信中のプレイヤー
let timer = null;
let ticking = false;
let lastAttemptAt = 0;
let firstScan = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

// Ranking（Firebaseの部分）が読み込めていないときも、落ちないようにする
const rankingBusy = (id) => Boolean(window.Ranking && window.Ranking.isSubmitting(id));

function pendingPlayers() {
  return Players.list().filter((p) => p.pendingScore > p.onlineScore);
}

function ensureState(id, delayMs) {
  let st = states.get(id);

  if (!st) {
    st = {
      attempts: 0,
      nextAt: Date.now() + delayMs,
      unknownFailures: 0,
      permissionFailures: 0,
      stopped: null
    };
    states.set(id, st);
  }

  return st;
}

// 登録待ちの一覧と、状態の記録を合わせる（なくなったものは捨てる・新しいものは追加する）
function scan() {
  const pending = pendingPlayers();
  const ids = new Set(pending.map((p) => p.id));

  for (const id of [...states.keys()]) {
    if (!ids.has(id)) states.delete(id);
  }

  for (const p of pending) {
    ensureState(p.id, firstScan ? config.startDelayMs : config.firstDelayMs);
  }

  firstScan = false;
}

function scheduleNext() {
  clearTimeout(timer);
  timer = null;

  let next = Infinity;

  for (const p of pendingPlayers()) {
    const st = states.get(p.id);
    if (st && !st.stopped) next = Math.min(next, st.nextAt);
  }

  if (next === Infinity) return;

  const now = Date.now();
  const wait = Math.max(300, next - now, lastAttemptAt + config.minGapMs - now);

  timer = setTimeout(tick, wait);
}

function backoffFor(attempts) {
  const list = config.backoffMs;
  return list[Math.min(Math.max(attempts, 1), list.length) - 1];
}

function stop(st, code, message) {
  st.stopped = { code, message };
}

// 送信の結果を、状態に反映する
function handleResult(id, result, fromAuto) {
  if (result.ok) {
    states.delete(id);
    if (result.previousPlayerId) states.delete(result.previousPlayerId);

    // 画面側の送信が成功したときは、画面にすでに表示されているので、通知しない
    if (fromAuto && result.code !== "nothing-to-send") {
      notifySuccess(result);

      emit("autosync:registered", {
        playerId: result.playerId,
        previousPlayerId: result.previousPlayerId,
        name: result.name,
        score: result.score,
        rank: result.rank,
        code: result.code
      });
    }

    emit("autosync:changed");
    return;
  }

  const st = ensureState(id, 0);
  const now = Date.now();
  st.lastError = { code: result.code, message: result.message };

  if (result.code === "too-frequent") {
    // 失敗ではなく、少し待つだけ
    st.nextAt = now + (result.retryAfterMs || 6000) + 500;
  } else if (result.code === "not-connected" && window.Ranking.status === "disabled") {
    stop(st, result.code, result.message);                  // 設定がないので、再試行しても直らない
  } else if (result.code === "permission-denied") {
    // 登録停止か、5秒の更新制限のずれか、区別できない。1回だけ時間をおいて試す
    st.permissionFailures += 1;

    if (st.permissionFailures > 1) stop(st, result.code, result.message);
    else st.nextAt = now + config.permissionRetryMs;
  } else if (TRANSIENT.has(result.code)) {
    st.attempts += 1;

    if (result.code === "unknown") {
      st.unknownFailures += 1;
      if (st.unknownFailures >= config.maxUnknownFailures) stop(st, result.code, result.message);
    }

    if (!st.stopped) st.nextAt = now + backoffFor(st.attempts);
  } else {
    stop(st, result.code, result.message);                  // 得点・名前が条件外など
  }

  emit("autosync:changed");
}

async function attempt(id) {
  busy.add(id);
  emit("autosync:changed");

  let result;

  try {
    result = await window.Ranking.submit(id);
  } catch (error) {
    result = { ok: false, code: "unknown", message: "うまく おくれなかったよ。あとで もういちど ためしてね" };
  }

  busy.delete(id);
  lastAttemptAt = Date.now();

  handleResult(id, result, true);
}

async function tick() {
  if (ticking || !window.Ranking) return;
  ticking = true;

  try {
    scan();

    if (navigator.onLine === false) return;   // 通信がもどる（online）まで待つ

    for (;;) {
      const now = Date.now();

      const due = pendingPlayers().find((p) => {
        const st = states.get(p.id);

        return st && !st.stopped && st.nextAt <= now &&
          !busy.has(p.id) && !rankingBusy(p.id);   // 画面側が送信中なら、重ねて送らない
      });

      if (!due) break;

      await attempt(due.id);
      await sleep(config.minGapMs);   // 続けて何件も送らない
    }
  } finally {
    ticking = false;
    scheduleNext();
  }
}

/* ---------- 成功の通知（ゲーム操作をじゃましない、小さな表示） ---------- */

const toastElement = document.getElementById("toast");
const toastQueue = [];
let toastShowing = false;

function showNextToast() {
  const message = toastQueue.shift();

  if (!message) {
    toastShowing = false;
    return;
  }

  toastShowing = true;
  toastElement.textContent = message;
  toastElement.classList.add("show");

  setTimeout(() => {
    toastElement.classList.remove("show");
    setTimeout(showNextToast, 400);
  }, config.toastMs);
}

function toast(message) {
  toastQueue.push(message);
  if (!toastShowing) showNextToast();
}

function notifySuccess(result) {
  toast(result.code === "unchanged"
    ? `${result.name}の きろくは もう とうろく ずみだったよ！`
    : `${result.name}の きろくを とうろくできたよ！`);
}

/* ---------- 公開API ---------- */

function getStatus(id) {
  const info = Players.getSyncInfo(id);

  if (!info || info.state !== "pending") return { state: "idle" };

  const st = states.get(id);

  if (busy.has(id) || rankingBusy(id)) {
    return { state: "sending", attempts: st ? st.attempts : 0 };
  }

  if (st && st.stopped) {
    return { state: "stopped", code: st.stopped.code, message: st.stopped.message };
  }

  return { state: "waiting", attempts: st ? st.attempts : 0, nextAt: st ? st.nextAt : 0 };
}

function retryNow(id) {
  const st = ensureState(id, 0);

  st.stopped = null;
  st.attempts = 0;
  st.unknownFailures = 0;
  st.permissionFailures = 0;
  st.nextAt = Date.now();

  emit("autosync:changed");
  tick();
}

// 登録待ちを取り消す（自己ベストは消さない）。送信中は、完了との競合を避けるため、取り消せない
function cancel(id) {
  if (busy.has(id) || rankingBusy(id)) return { ok: false, reason: "sending" };

  const info = Players.getSyncInfo(id);
  if (!info || info.pendingScore === 0) return { ok: true, nothing: true };

  Players.clearPending(id);
  states.delete(id);

  emit("autosync:changed");

  // 保存できなかったときは、ページを開きなおすと、登録待ちが戻ってしまう
  return { ok: true, saved: Players.isStorageOk() };
}

function noteFailure(id, result) {
  handleResult(id, result, false);
  scheduleNext();
}

window.AutoSync = { config, getStatus, retryNow, cancel, noteFailure };

/* ---------- きっかけ ---------- */

// 通信がもどったとき：待っているものを、すぐ（少しあとに）送り直す
window.addEventListener("online", () => {
  for (const st of states.values()) {
    if (st.stopped) continue;

    st.attempts = 0;
    st.nextAt = Math.min(st.nextAt, Date.now() + 1000);
  }

  setTimeout(tick, 1000);
});

// タブにもどったとき：時間がきているものがあれば送る
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleNext();
});

// プレイヤーの情報が変わったとき（登録待ちが増えた・取り消された など）
let changeTimer = null;
document.addEventListener("players:changed", () => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    scan();
    scheduleNext();
    emit("autosync:changed");
  }, 250);
});

// ゲームを開いたとき
scan();
scheduleNext();
