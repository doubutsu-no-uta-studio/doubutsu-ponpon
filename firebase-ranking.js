/* Firebase 接続・匿名認証・オンラインスコア登録
   接続や送信に失敗してもゲームは通常どおり遊べるよう、すべて try/catch で包み、
   エラーは throw せず、結果のオブジェクト（{ ok:false, code, message }）で返します。

   コンソールでの確認:
     Ranking.status   // "connecting" | "ready" | "error" | "disabled"
     Ranking.uid      // 匿名ユーザーID（接続前は null）
     Ranking.error    // 失敗理由（なければ null）
     await Ranking.ready   // 接続処理の完了を待つ（true=成功 / false=失敗）
     Ranking.connect()     // 失敗後の再接続

   スコア登録（Players が保存している状態をもとに送る。呼ぶ前に、
   登録したい得点を Players.queueRegistration(id, score) で送信待ちにしておく）:
     await Ranking.submit(playerId)
       → { ok:true,  code:"registered"|"updated"|"name-updated"|"unchanged"|"nothing-to-send",
           playerId, score, name, rank, ... }
       → { ok:false, code:"offline"|"timeout"|"too-frequent"|"permission-denied"|..., message, retryable }
     await Ranking.fetchRank(score)   // 「それより高い得点の人数 + 1」（同点は同順位）

   ランキング参加中のプレイヤーだけが送れる（Players の ranked が true で、削除待ちがないこと）。

   オンライン記録の削除（本人の記録だけ。所有者のUIDが一致するときだけ消せる）:
     await Ranking.deleteOnline({ id, ownerUid })
       → { ok:true, code:"deleted"|"not-found"|"not-owner" }   （削除待ちを外してよい。
            not-owner は、所有者UIDが別だと「明確に」確認できたときだけ）
       → { ok:false, code:"offline"|"timeout"|"permission-denied"|... }  （削除待ちを残して再試行。
            permission-denied は原因を確定できないので、所有者不一致とは扱わない）
     送信中の登録があるときは、その完了を待ってから消す。
     ※ 削除には Firestore のルールの変更が必要（firestore.rules.proposal を参照）

   ランキング一覧（読み取り専用。誰でも読める leaderboard から取得する）:
     await Ranking.fetchTop(20)
       → { ok:true, entries:[{ id, name, score, scoreAt }], fallback }   score の高い順、同点は scoreAt の早い順
     await Ranking.fetchPlayerEntry(playerId)
       → { ok:true, entry: {...} | null（未登録）, rank }                  そのプレイヤーの記録と順位

   オンラインのデータ構造とルールは firestore.rules を参照
     players/{playerId}      管理用（所有者のUIDあり）
     leaderboard/{playerId}  公開用（UIDなし）
   この2つは、必ず1回のトランザクションで、同じ値を書く。

   動作確認用（Firebase Emulator）:
     window.FIREBASE_EMULATOR = { auth: "http://127.0.0.1:9099",
                                  firestore: { host: "127.0.0.1", port: 8080 } }
     が、このファイルより前に設定されていれば、本物ではなくエミュレータに接続する。
     通常の公開ページでは設定されないので、何も変わらない。
*/

const FIREBASE_SDK_VERSION = "13.1.0";
const SDK_BASE =
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/`;

// firestore.rules と同じ値（ルールを変えたら、ここも合わせる）
const LIMITS = {
  minScore: 10,
  maxScore: 100000,
  scoreStep: 10,
  minIntervalMs: 5000   // 同じプレイヤーの更新は、5秒以上あける
};

const Ranking = {
  status: "connecting",
  uid: null,
  error: null,
  app: null,
  auth: null,
  ready: null,
  connect: null,
  submit: null,
  fetchRank: null,
  isSubmitting: null,
  deleteOnline: null,
  LIMITS,
  fetchTop: null,
  fetchPlayerEntry: null,
  // 通信の待ち時間の上限（ミリ秒）
  // forceFallback：複合インデックスなしの取得方法を、わざと使う（動作確認用）
  config: { timeoutMs: 15000, forceFallback: false }
};

window.Ranking = Ranking;

function isConfigured(config) {
  return Boolean(config) &&
    Object.values(config).every(
      (value) => typeof value === "string" &&
        value !== "" && !value.startsWith("PASTE_")
    );
}

let authEmulatorConnected = false;

async function connect() {
  Ranking.status = "connecting";
  Ranking.error = null;

  try {
    const config = window.FIREBASE_CONFIG;

    if (!isConfigured(config)) {
      Ranking.status = "disabled";
      console.warn(
        "[Ranking] firebase-config.js が未設定のため、オンライン機能は無効です"
      );
      return false;
    }

    const [{ initializeApp, getApps, getApp }, authModule] =
      await Promise.all([
        import(SDK_BASE + "firebase-app.js"),
        import(SDK_BASE + "firebase-auth.js")
      ]);

    const { getAuth, signInAnonymously, connectAuthEmulator } = authModule;

    // 初期化は1回だけ（再接続のときは、作ってあるものを使う）
    Ranking.app = getApps().length ? getApp() : initializeApp(config);
    Ranking.auth = getAuth(Ranking.app);

    const emulator = window.FIREBASE_EMULATOR;
    if (emulator && emulator.auth && !authEmulatorConnected) {
      connectAuthEmulator(Ranking.auth, emulator.auth, { disableWarnings: true });
      authEmulatorConnected = true;
    }

    // 保存済みのログイン状態の復元を待つ（同じ端末では同じ匿名IDを再利用）
    await Ranking.auth.authStateReady();

    if (!Ranking.auth.currentUser) {
      await signInAnonymously(Ranking.auth);
    }

    Ranking.uid = Ranking.auth.currentUser.uid;
    Ranking.status = "ready";
    console.log("[Ranking] 接続成功 / 匿名ユーザーID:", Ranking.uid);
    return true;
  } catch (error) {
    Ranking.status = "error";
    Ranking.error = error && error.code ? error.code : String(error);
    console.warn(
      "[Ranking] Firebaseに接続できませんでした（ゲームは通常どおり遊べます）:",
      Ranking.error
    );
    return false;
  }
}

Ranking.connect = () => {
  Ranking.ready = connect();
  return Ranking.ready;
};

/* ---------- Firestore ---------- */

let firestoreModule = null;
let firestoreDb = null;
let firestorePromise = null;

// Firestore は、最初に使うときに読み込む（起動を軽くするため）
function getFirestoreDb() {
  if (firestoreDb) return Promise.resolve(firestoreDb);

  if (!firestorePromise) {
    firestorePromise = (async () => {
      const module = await import(SDK_BASE + "firebase-firestore.js");
      const db = module.getFirestore(Ranking.app);

      const emulator = window.FIREBASE_EMULATOR;
      if (emulator && emulator.firestore) {
        module.connectFirestoreEmulator(
          db, emulator.firestore.host, emulator.firestore.port
        );
      }

      firestoreModule = module;
      firestoreDb = db;
      return db;
    })().catch((error) => {
      firestorePromise = null;
      throw error;
    });
  }

  return firestorePromise;
}

/* ---------- エラー ---------- */

// ユーザーに見せる日本語のメッセージ
const MESSAGES = {
  "not-connected": "オンラインに つながっていないよ。あとで もういちど ためしてね",
  "unauthenticated": "ログインが できていないよ。ページを よみこみなおしてね",
  "offline": "インターネットに つながっていないよ。つながったら もういちど ためしてね",
  "timeout": "へんじが こないよ。あとで もういちど ためしてね",
  "busy": "いま こんでいるよ。あとで もういちど ためしてね",
  "too-frequent": "さっき おくったばかりだよ。すこし まってから もういちど ためしてね",
  "permission-denied": "いまは とうろくできないよ。あとで もういちど ためしてね",
  "invalid-score": "この てんすうは ランキングに とうろくできないよ",
  "invalid-name": "この なまえは ランキングに つかえないよ。なまえを かえてね",
  "player-not-found": "プレイヤーが みつからないよ",
  "reload-needed": "ページを よみこみなおしてね。とうろくまちは のこっているよ",
  "delete-pending": "ランキングから けす じゅんびが おわるまで、まってね",
  "not-participating": "このプレイヤーは ランキングに さんかしていないよ",
  "unknown": "うまく おくれなかったよ。あとで もういちど ためしてね"
};

// 時間をおけば成功する可能性があるもの
const RETRYABLE = new Set([
  "not-connected", "unauthenticated", "offline", "timeout", "busy", "too-frequent", "unknown", "delete-pending"
]);

function failure(code, extra = {}) {
  return {
    ok: false,
    code,
    message: MESSAGES[code] || MESSAGES.unknown,
    retryable: RETRYABLE.has(code),
    ...extra
  };
}

// 送信の途中で、自分で中止するときのエラー
class SubmitAbort extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.abortCode = code;
    this.extra = extra;
  }
}

// どんなエラーでも、決まったコードに分類する
function classify(error) {
  if (error instanceof SubmitAbort) {
    return failure(error.abortCode, error.extra);
  }

  const code = error && error.code ? String(error.code) : "";

  // Firebase の部品そのものを読み込めなかった（回線が切れているとき）
  if (error instanceof TypeError && /dynamically imported module|Failed to fetch|Load failed/i.test(error.message)) {
    return failure("offline");
  }

  switch (code) {
    case "permission-denied":
      return failure("permission-denied");
    case "unauthenticated":
      return failure("unauthenticated");
    case "unavailable":
    case "auth/network-request-failed":
      return failure("offline");
    case "deadline-exceeded":
      return failure("timeout");
    case "aborted":
    case "resource-exhausted":
      return failure("busy");
    default:
      console.warn("[Ranking] 想定していないエラー:", error);
      return failure("unknown");
  }
}

// 一定時間で、待つのをやめる（送信そのものは、あとから成功することもある）
function withTimeout(promise, ms) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SubmitAbort("timeout")), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---------- 接続の確認 ---------- */

// 送信できる状態か確認する。{ uid } または失敗の結果を返す
async function ensureConnected() {
  // 前の接続に失敗していたら、1回だけ再接続する
  if (Ranking.status === "error" && navigator.onLine !== false) {
    await withTimeout(Ranking.connect(), Ranking.config.timeoutMs);
  } else if (Ranking.ready) {
    await withTimeout(Ranking.ready, Ranking.config.timeoutMs);
  }

  if (Ranking.status === "disabled") return failure("not-connected");

  // Firebase の部品（SDK）の読み込みに失敗したあとは、ブラウザが失敗を覚えていて、
  // 通信がもどっても、ページを読み込みなおすまで、読み込めない。再試行しても直らない
  if (Ranking.status === "error" && /dynamically imported module/i.test(String(Ranking.error))) {
    return failure("reload-needed");
  }

  if (Ranking.status === "error") {
    return Ranking.error === "auth/network-request-failed"
      ? failure("offline")
      : failure("not-connected");
  }

  if (Ranking.status !== "ready") return failure("not-connected");

  const user = Ranking.auth && Ranking.auth.currentUser;
  if (!user) return failure("unauthenticated");

  Ranking.uid = user.uid;
  return { uid: user.uid };
}

/* ---------- 得点の登録 ---------- */

function isValidOnlineScore(score) {
  return Number.isInteger(score) &&
    score >= LIMITS.minScore &&
    score <= LIMITS.maxScore &&
    score % LIMITS.scoreStep === 0;
}

// 同じプレイヤーの送信は、同時に1つだけ（二重登録の防止）
const inFlight = new Map();

// 自分が最後に書き込めた時刻（5秒の更新制限を、通信せずに判断するため）
const lastCommitAt = new Map();

Ranking.isSubmitting = (playerId) => inFlight.has(playerId);

// 管理用と公開用を、1回のトランザクションで書く
async function writeOnline({ id, uid, name, desiredScore }) {
  const db = await getFirestoreDb();
  const fs = firestoreModule;

  const privateRef = fs.doc(db, "players", id);
  const publicRef = fs.doc(db, "leaderboard", id);

  // トランザクションの読み取りが成功したか（権限エラーが、読み取りか書き込みかを見分ける）
  let readSucceeded = false;

  try {
    const outcome = await withTimeout(
      fs.runTransaction(db, async (tx) => {
        readSucceeded = false;

        // 作成か更新かを決めるために、先に自分の管理用データを読む
        const snapshot = await tx.get(privateRef);
        readSucceeded = true;

        const remote = snapshot.exists() ? snapshot.data() : null;

        if (remote && remote.ownerUid !== uid) {
          throw new SubmitAbort("permission-denied");
        }

        const remoteScore = remote && Number.isInteger(remote.score)
          ? remote.score : 0;

        // オンラインの得点は下げない（低い得点や同点では、上書きしない）
        const score = Math.max(remoteScore, desiredScore);

        // 何も変わらないなら、書き込まない（更新制限の対象にもならない）
        if (remote && score === remoteScore && remote.name === name) {
          return { wrote: false, created: false, increased: false, score, name };
        }

        // 5秒の更新制限。サーバーの時刻と端末の時刻がずれていると
        // 間違えるので、0〜5秒の範囲に見えるときだけ、送らずに止める
        if (remote) {
          const updatedMs = remote.updatedAt && remote.updatedAt.toMillis
            ? remote.updatedAt.toMillis() : NaN;
          const elapsed = Date.now() - updatedMs;

          if (elapsed >= 0 && elapsed < LIMITS.minIntervalMs) {
            throw new SubmitAbort("too-frequent", {
              retryAfterMs: LIMITS.minIntervalMs - elapsed
            });
          }
        }

        const increased = score > remoteScore;
        const now = fs.serverTimestamp();

        const privateData = remote
          ? {
              ownerUid: remote.ownerUid,
              name,
              score,
              scoreAt: increased ? now : remote.scoreAt,
              createdAt: remote.createdAt,
              updatedAt: now
            }
          : {
              ownerUid: uid,
              name,
              score,
              scoreAt: now,
              createdAt: now,
              updatedAt: now
            };

        tx.set(privateRef, privateData);
        tx.set(publicRef, {
          name,
          score,
          scoreAt: privateData.scoreAt,
          updatedAt: now
        });

        return { wrote: true, created: !remote, increased, score, name };
      }),
      Ranking.config.timeoutMs
    );

    return { outcome };
  } catch (error) {
    return { error, readSucceeded };
  }
}

async function runSubmit(playerId, entry) {
  const Players = window.Players;
  if (!Players) return failure("unknown");

  const first = Players.get(playerId);
  if (!first) return failure("player-not-found");

  // ランキングに参加していないプレイヤーの名前・得点は、送らない
  if (first.ranked !== true) return failure("not-participating");

  // オンラインの記録の削除待ちがある間は送らない（古い送信で、消した記録が再公開されないように）
  if (Players.hasPendingDelete(playerId)) return failure("delete-pending");

  // 送る内容：送信待ちの得点、または名前の反映
  const info = Players.getSyncInfo(playerId);
  const hasNewScore = info.pendingScore > info.onlineScore;

  if (!hasNewScore && !info.nameDirty) {
    return { ok: true, code: "nothing-to-send", playerId, score: info.onlineScore, name: first.name, rank: null };
  }

  const desiredScore = hasNewScore ? info.pendingScore : info.onlineScore;

  // 通信の前に、送れる内容か確認する（ルールと同じ条件）
  if (!isValidOnlineScore(desiredScore)) return failure("invalid-score");
  if (!Players.validateName(first.name).ok) return failure("invalid-name");

  // 接続・ログインの確認
  if (navigator.onLine === false) return failure("offline");

  const connection = await ensureConnected();
  if (connection.ok === false) return connection;
  const { uid } = connection;

  // 匿名UIDが変わっていたら、新しいプレイヤーIDを使う
  const owner = Players.ensureOwner(playerId, uid);
  if (!owner.ok) return failure("player-not-found");

  let id = owner.player.id;
  let idChanged = owner.reassigned;
  const originalId = playerId;

  const rememberId = () => {
    entry.ids.add(id);
    inFlight.set(id, entry);
  };
  if (idChanged) rememberId();

  // 通信を待っている間に、不参加にされたり削除されたりしていないか、もう一度確認する
  const current = Players.get(id);
  if (!current) return failure("player-not-found");
  if (current.ranked !== true) return failure("not-participating");
  if (Players.hasPendingDelete(id) || Players.hasPendingDelete(playerId)) return failure("delete-pending");

  // 自分が直前に書き込んだ場合は、通信せずに5秒の制限を判断する
  const wait = () => {
    const last = lastCommitAt.get(id);
    if (!last) return 0;
    return Math.max(0, LIMITS.minIntervalMs + 500 - (Date.now() - last));
  };

  if (wait() > 0) return failure("too-frequent", { retryAfterMs: wait() });

  // 書き込み。サーバーに「別のUIDの同じIDの記録」があって読めないときは、
  // 新しいプレイヤーIDに割り当て直して、1回だけやり直す
  let name = Players.get(id).name;
  let attempt = await writeOnline({ id, uid, name, desiredScore });

  if (
    attempt.error &&
    attempt.error.code === "permission-denied" &&
    !attempt.readSucceeded
  ) {
    const reassigned = Players.reassignId(id);

    if (reassigned.ok) {
      id = reassigned.player.id;
      idChanged = true;
      rememberId();
      name = Players.get(id).name;
      attempt = await writeOnline({ id, uid, name, desiredScore });
    }
  }

  if (attempt.error) return classify(attempt.error);

  const { outcome } = attempt;

  if (outcome.wrote) lastCommitAt.set(id, Date.now());

  // 成功したので、端末側の状態を更新する
  const marked = Players.markRegistered(id, {
    uid, score: outcome.score, name: outcome.name
  });

  // 順位は、わかれば付ける（取れなくても、登録の成功には影響しない）
  let rank = null;
  const rankResult = await Ranking.fetchRank(outcome.score);
  if (rankResult.ok) rank = rankResult.rank;

  let code;
  if (!outcome.wrote) code = "unchanged";
  else if (outcome.created) code = "registered";
  else if (outcome.increased) code = "updated";
  else code = "name-updated";

  return {
    ok: true,
    code,
    playerId: id,
    previousPlayerId: idChanged ? originalId : null,
    idChanged,
    score: outcome.score,
    name: outcome.name,
    created: outcome.created,
    increased: outcome.increased,
    rank,
    // 端末のデータに記録できなかった場合（送信中に、プレイヤーが削除されたときなど）
    localUpdated: marked.ok
  };
}

Ranking.submit = function submit(playerId) {
  // 送信中なら、新しく送らず、同じ結果を返す
  const running = inFlight.get(playerId);
  if (running) return running.promise;

  const entry = { ids: new Set([playerId]), promise: null };
  inFlight.set(playerId, entry);

  entry.promise = runSubmit(playerId, entry)
    .catch((error) => classify(error))
    .finally(() => {
      for (const id of entry.ids) {
        if (inFlight.get(id) === entry) inFlight.delete(id);
      }
    });

  return entry.promise;
};

/* ---------- オンライン記録の削除 ---------- */

// 本人の記録（管理用 players と公開用 leaderboard）を、1回のトランザクションで消す。
// 所有者UIDが一致しない記録は消さない（他人の記録を消せない）。
Ranking.deleteOnline = async function deleteOnline(entry) {
  try {
    const id = entry && entry.id;
    if (typeof id !== "string" || id === "") return failure("player-not-found");

    // 送信中の登録があれば、完了を待つ（そのあとに消せば、記録が残らない）
    const running = inFlight.get(id);
    if (running) await running.promise.catch(() => null);

    if (navigator.onLine === false) return failure("offline");

    const connection = await ensureConnected();
    if (connection.ok === false) return connection;
    const { uid } = connection;

    // 記録した端末のUIDと違う（匿名ユーザーが変わった）ときは、消せない
    if (entry.ownerUid && entry.ownerUid !== uid) {
      console.warn("[Ranking] 別の匿名ユーザーが登録した記録のため、削除できません:", id);
      return { ok: true, code: "not-owner" };
    }

    const db = await withTimeout(getFirestoreDb(), Ranking.config.timeoutMs);
    const fs = firestoreModule;

    const privateRef = fs.doc(db, "players", id);
    const publicRef = fs.doc(db, "leaderboard", id);

    // 削除待ちを外してよいのは、所有者UIDが「明確に」一致しないと確認できたときだけ。
    // 読み取りや書き込みが permission-denied になった場合は、原因を確定できない
    // （ルール未設定・ブロック・一時的な認証の問題など）ので、削除待ちを残して、あとで再試行する
    const code = await withTimeout(
      fs.runTransaction(db, async (tx) => {
        const snapshot = await tx.get(privateRef);

        if (!snapshot.exists()) return "not-found";

        const remoteOwner = snapshot.data().ownerUid;
        if (typeof remoteOwner === "string" && remoteOwner !== "" && remoteOwner !== uid) {
          return "not-owner";   // 読めて、所有者が別のUIDだと確認できた
        }
        if (remoteOwner !== uid) return "owner-unknown";   // 所有者が読み取れない形式。消さずに残す

        tx.delete(publicRef);
        tx.delete(privateRef);
        return "deleted";
      }),
      Ranking.config.timeoutMs
    );

    // 所有者を確認できない記録は、削除待ちを外さず、止めて報告する
    if (code === "owner-unknown") return failure("unknown");

    lastCommitAt.delete(id);
    return { ok: true, code };
  } catch (error) {
    return classify(error);
  }
};

// 順位：それより高い得点の人数 + 1（同点は同順位）
Ranking.fetchRank = async function fetchRank(score) {
  try {
    if (!Number.isInteger(score) || score < 0) return failure("invalid-score");

    const connection = await ensureConnected();
    if (connection.ok === false) return connection;

    const db = await withTimeout(getFirestoreDb(), Ranking.config.timeoutMs);
    const fs = firestoreModule;

    const snapshot = await withTimeout(
      fs.getCountFromServer(
        fs.query(fs.collection(db, "leaderboard"), fs.where("score", ">", score))
      ),
      Ranking.config.timeoutMs
    );

    return { ok: true, rank: snapshot.data().count + 1 };
  } catch (error) {
    return classify(error);
  }
};

/* ---------- ランキング一覧の取得（読み取り専用） ---------- */

// 文書から、表示に使う値を取り出す（壊れたデータは null）
function toEntry(snapshot) {
  const score = snapshot.get("score");
  if (!Number.isInteger(score)) return null;

  const name = snapshot.get("name");
  const scoreAt = snapshot.get("scoreAt");

  return {
    id: snapshot.id,
    name: typeof name === "string" ? name : "？",
    score,
    scoreAt: scoreAt && scoreAt.toMillis ? scoreAt.toMillis() : 0
  };
}

// 上位 limitCount 件：スコアの高い順、同点は到達時刻（scoreAt）の早い順
// 「score 降順 + scoreAt 昇順」の複合インデックスが必要。まだ作られていないときは、
// score 降順だけで取り、同点の順番を端末側で並べ替える（20位に同点がいる場合だけ、選ばれる人が不正確になる）
Ranking.fetchTop = async function fetchTop(limitCount = 20) {
  try {
    if (navigator.onLine === false) return failure("offline");

    const connection = await ensureConnected();
    if (connection.ok === false) return connection;

    const db = await withTimeout(getFirestoreDb(), Ranking.config.timeoutMs);
    const fs = firestoreModule;
    const collection = fs.collection(db, "leaderboard");

    let snapshot;
    let fallback = false;

    try {
      if (Ranking.config.forceFallback) {
        throw { code: "failed-precondition", message: "(動作確認用)" };
      }

      snapshot = await withTimeout(
        fs.getDocs(fs.query(
          collection,
          fs.orderBy("score", "desc"),
          fs.orderBy("scoreAt", "asc"),
          fs.limit(limitCount)
        )),
        Ranking.config.timeoutMs
      );
    } catch (error) {
      if (!error || error.code !== "failed-precondition") throw error;

      console.warn(
        "[Ranking] 複合インデックス（score 降順 + scoreAt 昇順）がないため、簡易な方法で取得します。" +
        "firestore.indexes.json を参照して、インデックスを作成してください:", error.message
      );

      snapshot = await withTimeout(
        fs.getDocs(fs.query(collection, fs.orderBy("score", "desc"), fs.limit(limitCount))),
        Ranking.config.timeoutMs
      );
      fallback = true;
    }

    const entries = snapshot.docs.map(toEntry).filter(Boolean);

    if (fallback) {
      entries.sort((a, b) => b.score - a.score || a.scoreAt - b.scoreAt);
    }

    return { ok: true, entries, fallback };
  } catch (error) {
    return classify(error);
  }
};

// 1人のプレイヤーの、オンラインの記録と順位（未登録なら entry は null）
Ranking.fetchPlayerEntry = async function fetchPlayerEntry(playerId) {
  try {
    if (navigator.onLine === false) return failure("offline");

    const connection = await ensureConnected();
    if (connection.ok === false) return connection;

    const db = await withTimeout(getFirestoreDb(), Ranking.config.timeoutMs);
    const fs = firestoreModule;

    const snapshot = await withTimeout(
      fs.getDoc(fs.doc(db, "leaderboard", playerId)),
      Ranking.config.timeoutMs
    );

    const entry = snapshot.exists() ? toEntry(snapshot) : null;
    if (!entry) return { ok: true, entry: null, rank: null };

    // 順位は、取れなくても、記録の表示には影響しない
    const rankResult = await Ranking.fetchRank(entry.score);

    return { ok: true, entry, rank: rankResult.ok ? rankResult.rank : null };
  } catch (error) {
    return classify(error);
  }
};

Ranking.connect();
