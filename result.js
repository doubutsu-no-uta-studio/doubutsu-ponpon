/* 結果画面
   ゲームオーバーになった時点では、スコアは「仮確定」。
   「もういちど あそぶ」か「タイトルへ」を押したときに、結果画面で選ばれているプレイヤーに記録する。

   ・プレイヤー名をタップすると、タイトル画面と同じ選択画面（PlayerUI.choosePlayer）が開く。
     選んだ時点で閉じる。ゲストを選ぶと、記録は残らず、オンラインにも送られない
   ・記録は 1 回のゲームにつき 1 回だけ（gameId で判定。連打・再読み込みでも二重にならない）
   ・自己ベストを更新したときだけ、保存済みの最高得点を更新する
     （ランキング参加中のプレイヤーなら、自動でオンライン登録される。完了は待たない）
   ・ゲームオーバー時に、仮確定の結果を端末に一時保存する。ブラウザを閉じたり再読み込みしたりしても、
     次に開いたときに、同じ結果画面を復元する。記録が済んだら、一時保存は消す
   ・記録するスコアは、ゲームオーバー時に game:over で受け取った値を使う
*/

(function () {
  const PENDING_KEY = "doubutsuPonpon.pendingResult.v1";

  const titleScreen = document.getElementById("title-screen");
  const gameOverScreen = document.getElementById("game-over-screen");
  const finalScore = document.getElementById("final-score");
  const retryButton = document.getElementById("retry-button");
  const toTitleButton = document.getElementById("to-title-button");

  const cardButton = document.getElementById("result-player-card");
  const nameElement = document.getElementById("result-player-name");
  const bestElement = document.getElementById("result-player-best");
  const bestNote = document.getElementById("result-best-note");
  const guestNote = document.getElementById("result-guest-note");
  const syncNote = document.getElementById("result-sync-note");

  // 記録前の結果 1 回分：{ gameId, score, playerId(null=ゲスト) }。記録したら null に戻す
  let session = null;
  let picking = false;

  function createGameId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ---------- 一時保存 ---------- */

  function savePending() {
    if (!session) return;

    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        gameId: session.gameId,
        score: session.score,
        playerId: session.playerId,
        createdAt: session.createdAt
      }));
    } catch (error) {
      console.warn("[Result] 結果を一時保存できませんでした", error);
    }
  }

  function clearPending() {
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch (error) {
      console.warn("[Result] 一時保存を消せませんでした", error);
    }
  }

  function loadPending() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return null;

      const data = JSON.parse(raw);
      if (!data || typeof data.gameId !== "string" || !Number.isInteger(data.score) || data.score < 0) {
        return null;
      }

      return {
        gameId: data.gameId,
        score: data.score,
        playerId: typeof data.playerId === "string" ? data.playerId : null,
        createdAt: Number(data.createdAt) || Date.now()
      };
    } catch (error) {
      return null;
    }
  }

  /* ---------- 記録 ---------- */

  // 結果画面で選ばれているプレイヤーに記録する（1回だけ）
  function commit() {
    const target = session;
    if (!target) return;   // 記録済み（または結果がない）

    // 連打されても二重に記録しないよう、先に確定済みにする
    session = null;

    const player = target.playerId ? Players.get(target.playerId) : null;

    // 選んでいたプレイヤーが、別のタブなどで消えていたときは、ゲストと同じ（誰にも記録しない）
    const result = Players.commitResult(target.gameId, player ? player.id : null, target.score);

    if (result.ok === false) {
      console.warn("[Result] 記録できませんでした", result);
    }

    clearPending();   // 記録の処理が終わってから消す（途中で閉じても、gameId で二重に記録されない）

    // 自己ベストを更新した参加者は、すぐ送信を始める（完了は待たない。失敗しても自動で再試行される）
    if (result.updated && result.ranked && window.AutoSync) {
      window.AutoSync.retryNow(player.id);
    }
  }

  /* ---------- 表示 ---------- */

  function syncNoteVisible(player) {
    if (!player || player.ranked !== true) return false;

    const info = Players.getSyncInfo(player.id);
    if (!info || !info.needsSync) return false;

    const status = window.AutoSync ? window.AutoSync.getStatus(player.id) : { state: "waiting", attempts: 0 };
    if (status.state === "sending") return false;

    return status.state === "stopped" || status.attempts > 0 || navigator.onLine === false;
  }

  function render() {
    if (!session) return;

    let player = session.playerId ? Players.get(session.playerId) : null;

    // 選んでいたプレイヤーがいなくなっていたら、ゲストにする
    if (session.playerId && !player) {
      session.playerId = null;
      savePending();
    }

    finalScore.textContent = session.score;

    if (player) {
      nameElement.textContent = player.name;
      bestElement.textContent = `ベスト ${player.bestScore}`;
    } else {
      nameElement.textContent = "ゲスト";
      bestElement.textContent = "";
    }

    guestNote.hidden = Boolean(player);
    bestNote.hidden = !(player && session.score > 0 && session.score > player.bestScore);
    syncNote.hidden = !syncNoteVisible(player);
  }

  // 自己ベストを更新するなら、お祝いする（参加・不参加に関係なく同じ。ゲストにはない）
  function celebrateIfBest() {
    if (!session || !session.playerId || !window.Celebrate) return;

    const player = Players.get(session.playerId);
    if (player && session.score > 0 && session.score > player.bestScore) {
      window.Celebrate.personalBest(`${session.gameId}:${player.id}`);
    }
  }

  /* ---------- きっかけ ---------- */

  // ゲームオーバー：仮確定の状態にして、一時保存する
  document.addEventListener("game:over", (event) => {
    commit();   // 前の結果が残っていたら、先に記録する

    const selected = Players.getSelected();

    session = {
      gameId: createGameId(),
      score: event.detail.score,
      playerId: selected ? selected.id : null,
      createdAt: Date.now()
    };

    savePending();
    render();
    celebrateIfBest();
  });

  // プレイヤー名をタップ：タイトル画面と同じ選択画面。選んだ時点で閉じる
  cardButton.addEventListener("click", async () => {
    if (!session || picking) return;
    picking = true;

    const target = session;

    try {
      const picked = await PlayerUI.choosePlayer({ currentId: target.playerId, select: false });

      if (picked && session === target) {
        target.playerId = picked.id;
        savePending();
        render();
        celebrateIfBest();
      }
    } finally {
      picking = false;
    }
  });

  // 「もういちど」「タイトルへ」：記録してから進む（ゲームの開始・タイトル表示は、それぞれの処理が行う）
  retryButton.addEventListener("click", commit);
  toTitleButton.addEventListener("click", commit);

  // プレイヤーの変更・送信の状態の変化に追従する
  document.addEventListener("players:changed", render);
  document.addEventListener("autosync:changed", render);

  /* ---------- 起動時：記録前の結果画面を復元する ---------- */

  function restore() {
    const pending = loadPending();
    if (!pending) return;

    // すでに記録済み（記録のあと、一時保存を消す前に閉じられた）なら、消すだけ
    if (Players.isGameCommitted(pending.gameId)) {
      clearPending();
      return;
    }

    session = pending;

    titleScreen.classList.add("hidden");
    gameOverScreen.style.display = "flex";
    render();
  }

  restore();
})();
