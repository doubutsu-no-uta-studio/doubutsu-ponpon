/* プレイヤー管理（データ層）
   端末内（localStorage）に、複数プレイヤーの情報を保存します。
   画面の処理は players-screen.js が担当します。

   保存形式（キー: doubutsuPonpon.players.v1）
   {
     version: 1,
     selectedId: "最後に選んだプレイヤーのID" | null,
     players: [
       {
         id: "重複しない内部ID（オンラインの記録の文書IDにもなる）",
         name: "なまえ（10文字以内）",
         createdAt: 1700000000000,
         updatedAt: 1700000000000,
         bestScore: 0,       // 端末内の自己ベスト（結果画面でプレイヤーが確定したあとに更新）

         // ここから下は、オンラインランキング用（古い保存データにはなくてよい。なければ下の値になる）
         ownerUid: null,     // オンライン登録した匿名ユーザーID（未登録なら null）
         onlineScore: 0,     // サーバーに登録できたと確認済みの得点（なければ 0）
         onlineName: null,   // サーバーに登録できたと確認済みの名前
         pendingScore: 0,    // 送信待ちの得点（ランキング参加中のみ。なければ 0）

         // ランキング参加設定・最近の記録
         ranked: true | false | null,  // true=参加 / false=不参加 / null=未選択（送信しない）
         lastPlayedAt: 0               // 最後に結果画面でスコアを記録した時刻（選択画面の並び順に使う）
       }
     ],
     committedGames: ["記録済みのゲームID", ...]  // 同じゲーム結果を二重に記録しないための履歴（新しい順に最大30件）
   }

   ■ ゲスト
   selectedId が null のときはゲスト（登録しない・記録は残らない）。

   ■ オンライン削除待ち（別キー: doubutsuPonpon.pendingDeletes.v1）
   { version: 1, items: [ { id, ownerUid, queuedAt } ] }
   プレイヤー本体を消したあとも残る。サーバーから消せたと確認できるまで消さない。
   削除待ちのIDは、オンラインへの送信が止まる（古い送信で記録が再公開されない）。

   ■ 既存データの引き継ぎ（ranked）
   ranked がない古いデータは、オンライン登録済み（ownerUid と onlineScore がある）か
   登録待ち（pendingScore がある＝以前に同意した）なら参加（true）、それ以外は未選択（null）。
   未選択は「参加扱いにしない」。

   ■ 匿名UIDが変わったとき
   オンラインの記録は「プレイヤーID」の文書に、所有者のUIDとともに保存される。
   UIDが変わると、前の記録は更新できない。そこで Players.ensureOwner() が、
   新しいプレイヤーIDを割り当てて新規登録として扱う（前の記録はそのまま残り、引き継がない）。

   コンソールでの確認: Players.list() / Players.getSelected() / Players.getSyncInfo(id)
*/

(function () {
  const STORAGE_KEY = "doubutsuPonpon.players.v1";
  const DELETES_KEY = "doubutsuPonpon.pendingDeletes.v1";
  const MAX_COMMITTED = 30;
  const MAX_NAME_LENGTH = 10;
  const MAX_PLAYERS = 10;

  // 使える文字：ひらがな・カタカナ・長音・漢字・々・英数字（半角/全角）
  // 絵文字・記号・空白は使えない（すべて1文字=1UTF-16単位の範囲に限定）
  const NAME_PATTERN = new RegExp(
    "^[A-Za-z0-9" +
    "\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A" +
    "\\u3041-\\u3096\\u30A1-\\u30FA\\u30FC\\u3005" +
    "\\u4E00-\\u9FFF]+$"
  );

  // 重複しない内部IDを作る（http のLAN接続でも動くよう予備を用意）
  function createId() {
    if (window.crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // 名前のチェック。{ ok, name } または { ok:false, error } を返す
  function validateName(raw) {
    const name = String(raw ?? "").trim();

    if (name === "") {
      return { ok: false, error: "なまえを いれてね" };
    }

    if (!NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: "つかえない もじが あるよ（えもじ・きごう・くうはくは だめ）"
      };
    }

    if (name.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `${MAX_NAME_LENGTH}もじまでだよ` };
    }

    return { ok: true, name };
  }

  // 0以上の整数ならそのまま、それ以外は 0
  function toScore(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  function emptyState() {
    return { version: 1, selectedId: null, players: [], committedGames: [] };
  }

  // 保存データを読み込む（壊れていても空の状態で続行する）
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();

      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.players)) return emptyState();

      const seen = new Set();
      const players = [];

      for (const p of data.players) {
        if (!p || typeof p.id !== "string" || typeof p.name !== "string") continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);

        // オンライン用の項目は、古いデータにはないので、なければ初期値で補う
        const onlineScore = toScore(p.onlineScore);
        const pendingScore = toScore(p.pendingScore);

        const ownerUid = typeof p.ownerUid === "string" && p.ownerUid !== ""
          ? p.ownerUid : null;

        // 参加設定：保存してあればそれを使う。古いデータは、オンラインに関わった形跡があれば参加
        let ranked = null;
        if (p.ranked === true || p.ranked === false) {
          ranked = p.ranked;
        } else if ((ownerUid && onlineScore > 0) || pendingScore > 0) {
          ranked = true;
        }

        players.push({
          id: p.id,
          name: p.name.slice(0, MAX_NAME_LENGTH),
          createdAt: Number(p.createdAt) || Date.now(),
          updatedAt: Number(p.updatedAt) || Date.now(),
          // 自己ベストは、オンライン登録済みの得点より低くならない
          bestScore: Math.max(toScore(p.bestScore), onlineScore),
          ownerUid,
          onlineScore,
          onlineName: typeof p.onlineName === "string"
            ? p.onlineName.slice(0, MAX_NAME_LENGTH) : null,
          // 登録済みの得点以下の「送信待ち」は、意味がないので無しにする
          pendingScore: pendingScore > onlineScore ? pendingScore : 0,
          ranked,
          lastPlayedAt: Number(p.lastPlayedAt) || 0
        });
      }

      // 選択が無効（または null）ならゲスト
      const selectedId = players.some((p) => p.id === data.selectedId)
        ? data.selectedId : null;

      const committedGames = Array.isArray(data.committedGames)
        ? data.committedGames.filter((g) => typeof g === "string").slice(0, MAX_COMMITTED)
        : [];

      return { version: 1, selectedId, players, committedGames };
    } catch (error) {
      console.warn("[Players] プレイヤー情報を読み込めませんでした", error);
      return emptyState();
    }
  }

  let state = load();

  /* ---------- オンライン削除待ち（プレイヤー本体とは別に保存する） ---------- */

  function loadDeletes() {
    try {
      const raw = localStorage.getItem(DELETES_KEY);
      if (!raw) return [];

      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return [];

      const seen = new Set();
      const items = [];

      for (const item of data.items) {
        if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push({
          id: item.id,
          ownerUid: typeof item.ownerUid === "string" && item.ownerUid !== "" ? item.ownerUid : null,
          queuedAt: Number(item.queuedAt) || Date.now()
        });
      }

      return items;
    } catch (error) {
      console.warn("[Players] 削除待ちを読み込めませんでした", error);
      return [];
    }
  }

  let pendingDeletes = loadDeletes();

  function saveDeletes() {
    try {
      localStorage.setItem(DELETES_KEY, JSON.stringify({ version: 1, items: pendingDeletes }));
      return true;
    } catch (error) {
      console.warn("[Players] 削除待ちを保存できませんでした", error);
      return false;
    }
  }

  // オンラインに記録がある（かもしれない）プレイヤーか
  function mayBeOnline(p) {
    return p.ranked === true || Boolean(p.ownerUid) || p.onlineScore > 0 || p.pendingScore > 0;
  }

  // 削除待ちに入れる（すでにあれば、所有者UIDだけ補う）。保存の成否を返す
  function queueDelete(p) {
    const existing = pendingDeletes.find((d) => d.id === p.id);

    if (existing) {
      if (!existing.ownerUid && p.ownerUid) existing.ownerUid = p.ownerUid;
    } else {
      pendingDeletes.push({ id: p.id, ownerUid: p.ownerUid || null, queuedAt: Date.now() });
    }

    return saveDeletes();
  }

  // 直前の保存が成功したか（保存できなかったときに、「保存したよ」と案内しないために使う）
  let storageOk = true;

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageOk = true;
    } catch (error) {
      console.warn("[Players] プレイヤー情報を保存できませんでした", error);
      storageOk = false;
    }

    return storageOk;
  }

  function emitChange() {
    document.dispatchEvent(new CustomEvent("players:changed", {
      detail: { selectedId: state.selectedId }
    }));
  }

  // 外から受け取る値は、コピーして渡す
  const copy = (p) => (p ? { ...p } : null);

  // index 番目のプレイヤーに新しいIDを割り当て、オンライン関連の状態を初期化する
  function reassignAt(index) {
    const p = state.players[index];

    let newId = createId();
    while (state.players.some((x) => x.id === newId)) newId = createId();

    const oldId = p.id;

    p.id = newId;
    p.ownerUid = null;
    p.onlineScore = 0;
    p.onlineName = null;
    p.updatedAt = Date.now();

    // 参加中なら、新しいIDで自己ベストを登録し直す
    if (p.ranked === true && p.bestScore > 0) {
      p.pendingScore = Math.max(p.pendingScore, p.bestScore);
    }

    if (state.selectedId === oldId) state.selectedId = newId;

    save();
    emitChange();
  }

  const Players = {
    MAX_NAME_LENGTH,
    MAX_PLAYERS,

    validateName,

    // 直前の保存が成功していたか
    isStorageOk() {
      return storageOk;
    },

    list() {
      return state.players.map(copy);
    },

    get(id) {
      return copy(state.players.find((p) => p.id === id));
    },

    getSelected() {
      return this.get(state.selectedId);
    },

    select(id) {
      if (!state.players.some((p) => p.id === id)) return false;

      state.selectedId = id;
      save();
      emitChange();
      return true;
    },

    // ゲストを選ぶ（記録は残らず、オンラインにも送らない）
    selectGuest() {
      state.selectedId = null;
      save();
      emitChange();
      return true;
    },

    // 選択画面用：最近記録したプレイヤーが上（ゲストは画面側で一番下に付ける）
    listRecent() {
      return state.players
        .map((p, index) => ({ p, index }))
        .sort((a, b) =>
          b.p.lastPlayedAt - a.p.lastPlayedAt ||
          b.p.updatedAt - a.p.updatedAt ||
          a.index - b.index)
        .map((x) => copy(x.p));
    },

    // 追加する。ranked（true/false）は必ず指定する（未選択では作れない）
    //   options.select: false なら、選択状態は変えない（結果画面から追加するとき）
    add(rawName, options = {}) {
      const check = validateName(rawName);
      if (!check.ok) return check;

      if (typeof options.ranked !== "boolean") {
        return { ok: false, error: "ランキングに さんかするか えらんでね" };
      }

      if (state.players.length >= MAX_PLAYERS) {
        return {
          ok: false,
          error: `プレイヤーは ${MAX_PLAYERS}にんまでだよ`
        };
      }

      const now = Date.now();
      const player = {
        id: createId(),
        name: check.name,
        createdAt: now,
        updatedAt: now,
        bestScore: 0,
        ownerUid: null,
        onlineScore: 0,
        onlineName: null,
        pendingScore: 0,
        ranked: options.ranked,
        lastPlayedAt: 0
      };

      state.players.push(player);
      if (options.select !== false) state.selectedId = player.id;
      save();
      emitChange();

      return { ok: true, player: copy(player) };
    },

    // 名前を変更する（IDと記録は引き継ぐ）
    rename(id, rawName) {
      const player = state.players.find((p) => p.id === id);
      if (!player) return { ok: false, error: "プレイヤーが みつからないよ" };

      const check = validateName(rawName);
      if (!check.ok) return check;

      player.name = check.name;
      player.updatedAt = Date.now();
      save();
      emitChange();

      return { ok: true, player: copy(player) };
    },

    // 自己ベストを記録する。今より高い得点のときだけ更新する
    // （同点・低い得点・不正な値では何も変えないので、同じ得点で何度呼んでも結果は同じ）
    // ゲーム終了時に自動では呼ばれない。結果画面でプレイヤーが確定したあとに呼ぶこと
    recordScore(id, score) {
      const player = state.players.find((p) => p.id === id);
      if (!player) return { ok: false, updated: false };

      if (!Number.isInteger(score) || score <= player.bestScore) {
        return { ok: true, updated: false, bestScore: player.bestScore };
      }

      const previousBest = player.bestScore;

      player.bestScore = score;
      player.updatedAt = Date.now();
      save();
      emitChange();

      return { ok: true, updated: true, bestScore: score, previousBest };
    },

    // 結果画面で確定したスコアを、1回だけ記録する（gameId が同じなら何もしない）
    //   id が null（ゲスト）：何も記録しない
    //   自己ベストを更新したときだけ bestScore を更新し、参加中なら送信待ちに入れる（自動送信される）
    commitResult(gameId, id, score) {
      if (typeof gameId !== "string" || gameId === "") return { ok: false, reason: "invalid-game" };

      if (state.committedGames.includes(gameId)) {
        return { ok: true, duplicate: true };
      }

      if (id === null) return { ok: true, guest: true };

      const player = state.players.find((p) => p.id === id);
      if (!player) return { ok: false, reason: "not-found" };

      const result = { ok: true, updated: false, bestScore: player.bestScore, ranked: player.ranked === true };

      if (Number.isInteger(score) && score > player.bestScore) {
        result.updated = true;
        result.previousBest = player.bestScore;
        result.bestScore = score;
        player.bestScore = score;

        if (player.ranked === true && score > player.onlineScore) {
          player.pendingScore = Math.max(player.pendingScore, score);
        }
      }

      const now = Date.now();
      player.lastPlayedAt = now;
      if (result.updated) player.updatedAt = now;

      state.selectedId = player.id;
      state.committedGames.unshift(gameId);
      state.committedGames.length = Math.min(state.committedGames.length, MAX_COMMITTED);

      result.saved = save();
      emitChange();
      return result;
    },

    isGameCommitted(gameId) {
      return state.committedGames.includes(gameId);
    },

    // ---------- ランキング参加設定 ----------

    // 参加・不参加を変える
    //   参加にしたとき：自己ベストが 0 より大きければ、送信待ちに入れる（自動で登録される）
    //   不参加にしたとき：送信待ちを消し、オンラインの記録の削除待ちを作る（端末内の自己ベストは残る）
    setRanked(id, ranked) {
      const p = state.players.find((x) => x.id === id);
      if (!p) return { ok: false, reason: "not-found" };
      if (typeof ranked !== "boolean") return { ok: false, reason: "invalid" };

      const result = { ok: true, changed: p.ranked !== ranked, deleteQueued: false };
      if (!result.changed) return result;

      if (ranked) {
        p.ranked = true;
        if (p.bestScore > p.onlineScore) p.pendingScore = Math.max(p.pendingScore, p.bestScore);
      } else {
        // 先に削除待ちを保存してから、端末側の「登録済み」の記憶を消す
        if (mayBeOnline(p)) {
          if (!queueDelete(p)) return { ok: false, reason: "storage" };
          result.deleteQueued = true;
        }

        p.ranked = false;
        p.pendingScore = 0;
        p.ownerUid = null;
        p.onlineScore = 0;
        p.onlineName = null;
      }

      p.updatedAt = Date.now();
      result.saved = save();
      emitChange();
      return result;
    },

    // ---------- オンライン削除待ち ----------

    listPendingDeletes() {
      return pendingDeletes.map((d) => ({ ...d }));
    },

    hasPendingDelete(id) {
      return pendingDeletes.some((d) => d.id === id);
    },

    // サーバーから消せた（または、消す必要がなくなった）ので、削除待ちを外す
    completeDelete(id) {
      const before = pendingDeletes.length;
      pendingDeletes = pendingDeletes.filter((d) => d.id !== id);

      if (pendingDeletes.length !== before) {
        saveDeletes();
        emitChange();
      }
    },

    // ---------- オンラインランキング用の状態 ----------

    // 登録の状態を調べる
    //   state: "unregistered"     オンラインに記録なし（送信待ちもない）
    //          "pending"          登録を選んだが、まだ送れていない
    //          "unregisteredBest" 登録済みだが、自己ベストはそれより高く、未登録
    //          "registered"       自己ベストまで登録済み
    //   canRegister: 登録できる得点（登録済みより高い自己ベスト）があるか
    //   nameDirty:   登録済みの名前と、今の名前が違う（名前の反映待ち）
    getSyncInfo(id) {
      const p = state.players.find((x) => x.id === id);
      if (!p) return null;

      let status;
      if (p.pendingScore > p.onlineScore) {
        status = "pending";
      } else if (p.onlineScore === 0) {
        status = "unregistered";
      } else if (p.bestScore > p.onlineScore) {
        status = "unregisteredBest";
      } else {
        status = "registered";
      }

      return {
        state: status,
        bestScore: p.bestScore,
        onlineScore: p.onlineScore,
        pendingScore: p.pendingScore,
        canRegister: p.bestScore > p.onlineScore,
        nameDirty: p.onlineScore > 0 && p.onlineName !== p.name,
        ranked: p.ranked,
        deletePending: pendingDeletes.some((d) => d.id === p.id),
        // 自動で送るものがあるか（参加中で、送信待ちの得点か名前の反映がある）
        needsSync: p.ranked === true &&
          (p.pendingScore > p.onlineScore || (p.onlineScore > 0 && p.onlineName !== p.name))
      };
    },

    // 「ランキングに登録する」と選んだ得点を、送信待ちとして保存する
    // （自己ベスト以下で、登録済みの得点より高いときだけ。通信に失敗しても残る）
    // 本人が同意したスコアだけを入れること。複数あるときは、同意した最高得点だけを保持する。
    // 自己ベストが更新されただけでは、送信待ちは増えない・変わらない
    queueRegistration(id, score) {
      const p = state.players.find((x) => x.id === id);
      if (!p) return { ok: false, reason: "not-found" };

      if (!Number.isInteger(score) || score <= 0) {
        return { ok: false, reason: "invalid-score" };
      }
      if (score > p.bestScore) {
        return { ok: false, reason: "above-best" };
      }
      if (score <= p.onlineScore) {
        return { ok: false, reason: "already-registered" };
      }

      p.pendingScore = Math.max(p.pendingScore, score);
      const saved = save();
      emitChange();

      // saved が false のときは、この端末に保存できていない（ページを閉じると、送信待ちは消える）
      return { ok: true, pendingScore: p.pendingScore, saved };
    },

    // 送信待ちを取り消す（「今回は登録しない」など）
    clearPending(id) {
      const p = state.players.find((x) => x.id === id);
      if (!p) return false;

      if (p.pendingScore !== 0) {
        p.pendingScore = 0;
        save();
        emitChange();
      }
      return true;
    },

    // サーバーへの登録が成功したことを記録する（名前だけの反映のときは score に onlineScore を渡す）
    // 所有者のUIDが、すでに別のUIDで記録されている場合は、記録しない
    markRegistered(id, { uid, score, name }) {
      const p = state.players.find((x) => x.id === id);
      if (!p) return { ok: false, reason: "not-found" };

      if (typeof uid !== "string" || uid === "") {
        return { ok: false, reason: "invalid-uid" };
      }
      if (!Number.isInteger(score) || score <= 0) {
        return { ok: false, reason: "invalid-score" };
      }
      if (!validateName(name).ok) {
        return { ok: false, reason: "invalid-name" };
      }
      if (p.ownerUid && p.ownerUid !== uid) {
        return { ok: false, reason: "owner-mismatch" };
      }
      // 送信中に不参加にされた（削除待ち）ときは、「登録済み」と覚えない
      if (p.ranked !== true || pendingDeletes.some((d) => d.id === id)) {
        return { ok: false, reason: "not-participating" };
      }

      p.ownerUid = uid;
      p.onlineScore = Math.max(p.onlineScore, score);
      p.onlineName = name;
      p.bestScore = Math.max(p.bestScore, p.onlineScore);
      if (p.pendingScore <= p.onlineScore) p.pendingScore = 0;
      p.updatedAt = Date.now();
      save();
      emitChange();

      return { ok: true, player: copy(p) };
    },

    // オンラインに送る前に呼ぶ。今の匿名UIDが、記録の所有者と同じか確認する
    //   - まだオンライン登録していない（ownerUid がない）か、UIDが同じ → そのまま使える
    //   - UIDが違う（ブラウザのデータ消失などで匿名ユーザーが変わった）
    //       → 新しいプレイヤーIDを割り当て、オンライン関連の状態を初期化する。
    //         前のオンラインの記録は更新も引き継ぎもしない（サーバーにそのまま残る）。
    //         名前、自己ベスト、送信待ちの得点、順番、選択状態は維持する。
    ensureOwner(id, currentUid) {
      const index = state.players.findIndex((x) => x.id === id);
      if (index < 0) return { ok: false, reason: "not-found" };

      if (typeof currentUid !== "string" || currentUid === "") {
        return { ok: false, reason: "invalid-uid" };
      }

      const p = state.players[index];

      if (!p.ownerUid || p.ownerUid === currentUid) {
        return { ok: true, reassigned: false, player: copy(p) };
      }

      const oldId = p.id;
      reassignAt(index);

      return { ok: true, reassigned: true, oldId, player: copy(p) };
    },

    // 今のプレイヤーIDでは、オンラインに書き込めないと分かったときに、
    // 新しいプレイヤーIDを割り当てる（サーバーに、別のUIDが所有する同じIDの記録があった場合など）
    // 名前・自己ベスト・送信待ち・順番・選択状態は維持し、オンライン関連の状態は初期化する
    reassignId(id) {
      const index = state.players.findIndex((x) => x.id === id);
      if (index < 0) return { ok: false, reason: "not-found" };

      const oldId = state.players[index].id;
      reassignAt(index);

      return { ok: true, reassigned: true, oldId, player: copy(state.players[index]) };
    },

    // オンラインの記録が、サーバーから消えていたときに、もう一度登録できるようにする
    // （ランキング画面で、本人が選んだときだけ呼ぶ）
    // 名前・ID・自己ベストはそのまま。「登録済み」の記憶と、送信待ちだけを、初期状態に戻す
    resetOnlineState(id) {
      const p = state.players.find((x) => x.id === id);
      if (!p) return { ok: false, reason: "not-found" };

      p.ownerUid = null;
      p.onlineScore = 0;
      p.onlineName = null;
      p.pendingScore = p.ranked === true && p.bestScore > 0 ? p.bestScore : 0;
      p.updatedAt = Date.now();
      save();
      emitChange();

      return { ok: true, player: copy(p) };
    },

    // 端末内から削除する。オンラインに記録がありうるときは、先にオンライン削除待ちを保存する
    // （プレイヤー本体を消したあとも、削除待ちは残る）。保存できなければ、削除しない
    remove(id) {
      const index = state.players.findIndex((p) => p.id === id);
      if (index < 0) return false;

      if (mayBeOnline(state.players[index]) && !queueDelete(state.players[index])) {
        return false;
      }

      state.players.splice(index, 1);

      if (state.selectedId === id) state.selectedId = null;   // ゲストに戻る

      save();
      emitChange();
      return true;
    }
  };

  // 別のタブで変更されたら、読み込み直す
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;

    state = load();
    emitChange();
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== DELETES_KEY) return;

    pendingDeletes = loadDeletes();
    emitChange();
  });

  // ※ ゲーム終了時の自動記録はしない。結果画面でプレイヤーを確定したあとに
  //   Players.commitResult(gameId, id, score) を呼ぶ。

  window.Players = Players;
})();
