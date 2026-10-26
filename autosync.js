/* ランキングの自動同期
   ランキングに参加しているプレイヤー（Players の ranked が true）の
     ・自己ベストの更新（pendingScore）
     ・名前の変更（名前だけの変更も対象）
   を、通信が使えるときに自動で Ranking.submit で送る。
   不参加・未選択のプレイヤーは、何も送らない。
   さらに、不参加にした・プレイヤーを削除したときの「オンライン記録の削除待ち」を、
   Ranking.deleteOnline で処理する（削除待ちは、プレイヤー本体が消えたあとも残る）。
   削除待ちのプレイヤーは、削除が終わるまで送信しない（記録が再公開されないように）。

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
     deleteStatus()        削除待ちの件数と状態 { count, stopped }
     noteFailure(id, r)    画面側の送信が失敗したとき、結果を渡す（自動再送の対象にする）
     config                間隔などの設定（動作確認用に変更できる）

   イベント
     autosync:changed      状態が変わった
     autosync:registered   自動で登録できた（detail: playerId, name, score, rank, code）
*/

const config = {
  backoffMs: [5000, 15000, 45000, 120000, 300000],  // 失敗が続くほど、間隔をのばす（最後の値が上限）
  startDelayMs: 1500,        // ゲームを開いてから、最初に送るまで
  firstDelayMs: 800,         // 自己ベスト更新・名前変更のあと、送信を始めるまで
  minGapMs: 1500,            // 続けて送るときの最短の間隔
  permissionRetryMs: 7000,   // 権限エラーを、1回だけ再試行するまで（登録の送信）
  permissionBackoffMs: [7000, 30000, 120000, 300000],   // 削除待ちの権限エラー：止めずに、間隔をのばして再試行
  maxUnknownFailures: 5,     // 原因不明のエラーが続いたら、止める
  toastMs: 4500              // 成功の通知を出している時間
};

// 時間をおけば、成功するかもしれないエラー
const TRANSIENT = new Set([
  "offline", "timeout", "busy", "unauthenticated", "not-connected", "unknown", "delete-pending"
]);

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

// 自動で送るもの：参加中で、削除待ちがなく、送信待ちの得点か名前の反映があるプレイヤー
function pendingPlayers() {
  return Players.list().filter((p) => {
    const info = Players.getSyncInfo(p.id);
    return info.needsSync && !info.deletePending;
  });
}

/* ---------- オンライン削除待ち ---------- */

const delKey = (id) => `del:${id}`;
const deleteBusy = new Set();

function pendingDeletes() {
  return Players.listPendingDeletes();
}

function ensureDeleteState(id, delayMs) {
  const key = delKey(id);
  let st = states.get(key);

  if (!st) {
    st = { attempts: 0, nextAt: Date.now() + delayMs, permissionFailures: 0, stopped: null };
    states.set(key, st);
  }

  return st;
}

function handleDeleteResult(entry, result) {
  const key = delKey(entry.id);

  if (result.ok) {
    states.delete(key);
    Players.completeDelete(entry.id);   // 削除できた（またはもう無い）ので、削除待ちを外す
    emit("autosync:changed");
    return;
  }

  const st = ensureDeleteState(entry.id, 0);
  const now = Date.now();
  st.lastError = { code: result.code, message: result.message };

  if (result.code === "not-connected" && window.Ranking.status === "disabled") {
    stop(st, result.code, result.message);
  } else if (result.code === "permission-denied") {
    // 原因を確定できない（ルール未設定・ブロック・認証の問題など）。削除待ちは保持し、
    // 止めずに、間隔をだんだん空けて再試行する（ルールが直れば、そのうち自動で成功する）
    st.permissionFailures += 1;
    st.attempts += 1;
    const list = config.permissionBackoffMs;
    st.nextAt = now + list[Math.min(st.permissionFailures, list.length) - 1];
  } else if (TRANSIENT.has(result.code) || result.code === "too-frequent") {
    st.attempts += 1;
    st.nextAt = now + backoffFor(st.attempts);
  } else {
    st.attempts += 1;
    st.nextAt = now + backoffFor(st.attempts);
  }

  emit("autosync:changed");
}

async function attemptDelete(entry) {
  deleteBusy.add(entry.id);

  let result;

  try {
    result = await window.Ranking.deleteOnline(entry);
  } catch (error) {
    result = { ok: false, code: "unknown", message: "うまく けせなかったよ" };
  }

  deleteBusy.delete(entry.id);
  lastAttemptAt = Date.now();

  handleDeleteResult(entry, result);
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
  const deletes = pendingDeletes();
  const ids = new Set(pending.map((p) => p.id));
  for (const d of deletes) ids.add(delKey(d.id));

  for (const id of [...states.keys()]) {
    if (!ids.has(id)) states.delete(id);
  }

  for (const p of pending) {
    ensureState(p.id, firstScan ? config.startDelayMs : config.firstDelayMs);
  }

  for (const d of deletes) {
    ensureDeleteState(d.id, firstScan ? config.startDelayMs : 500);
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

  for (const d of pendingDeletes()) {
    const st = states.get(delKey(d.id));
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

      // 削除を先に処理する（削除待ちのプレイヤーは、送信の対象にならない）
      const dueDelete = pendingDeletes().find((d) => {
        const st = states.get(delKey(d.id));

        return st && !st.stopped && st.nextAt <= now &&
          !deleteBusy.has(d.id) && !rankingBusy(d.id);
      });

      if (dueDelete) {
        await attemptDelete(dueDelete);
        await sleep(config.minGapMs);
        continue;
      }

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

  if (!info || !info.needsSync) return { state: "idle" };

  const st = states.get(id);

  if (busy.has(id) || rankingBusy(id)) {
    return { state: "sending", attempts: st ? st.attempts : 0 };
  }

  if (st && st.stopped) {
    return { state: "stopped", code: st.stopped.code, message: st.stopped.message };
  }

  return { state: "waiting", attempts: st ? st.attempts : 0, nextAt: st ? st.nextAt : 0 };
}

function deleteStatus() {
  const list = pendingDeletes();
  const stopped = list.some((d) => {
    const st = states.get(delKey(d.id));
    return st && st.stopped;
  });

  return { count: list.length, stopped };
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

window.AutoSync = { config, getStatus, retryNow, cancel, noteFailure, deleteStatus };

/* ---------- きっかけ ---------- */

// 通信がもどったとき：待っているものを、すぐ（少しあとに）送り直す
window.addEventListener("online", () => {
  for (const st of states.values()) {
    if (st.stopped) continue;

    st.attempts = 0;
    st.permissionFailures = 0;
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
