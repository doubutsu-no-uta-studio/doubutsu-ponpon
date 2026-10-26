/* 画面遷移（タイトル画面 ⇔ ゲーム画面） */

(function () {
  const titleScreen = document.getElementById("title-screen");
  const playButton = document.getElementById("play-button");
  const rankingButton = document.getElementById("ranking-button");
  const toTitleButton = document.getElementById("to-title-button");

  function showTitle() {
    window.DoubutsuGame.exitToTitle();
    titleScreen.classList.remove("hidden");
  }

  function startPlaying() {
    titleScreen.classList.add("hidden");
    window.DoubutsuGame.start();
  }

  playButton.addEventListener("click", startPlaying);

  // ランキング一覧画面（タイトルの上に重ねて表示。「もどる」で閉じる）
  rankingButton.addEventListener("click", () => {
    window.RankingUI.open();
  });

  toTitleButton.addEventListener("click", showTitle);

  // 選択中のプレイヤーのカード（タップで、プレイヤー選択画面。選ばなくても、ゲストで あそべる）
  const cardButton = document.getElementById("title-player-card");
  const cardName = document.getElementById("title-player-name");
  const cardBest = document.getElementById("title-player-best");
  const cardNote = document.getElementById("title-player-note");

  function renderPlayerCard() {
    const player = Players.getSelected();

    if (!player) {
      cardName.textContent = "ゲスト";
      cardBest.textContent = "きろくは のこらないよ";
      cardNote.hidden = true;
      return;
    }

    cardName.textContent = player.name;
    cardBest.textContent = `ベスト ${player.bestScore}`;

    // 控えめな案内：未選択なら参加の確認、送れていないものがあるときは「とうろくまち」
    let note = "";
    const info = Players.getSyncInfo(player.id);

    if (player.ranked === null) {
      note = "ランキングに さんかする？";
    } else if (info.needsSync) {
      const status = window.AutoSync ? window.AutoSync.getStatus(player.id) : { state: "waiting", attempts: 0 };
      if (status.state !== "sending" && (status.state === "stopped" || status.attempts > 0 || navigator.onLine === false)) {
        note = "ランキング とうろくまち";
      }
    }

    cardNote.textContent = note;
    cardNote.hidden = note === "";
  }

  let choosing = false;

  cardButton.addEventListener("click", async () => {
    if (choosing) return;
    choosing = true;

    try {
      const current = Players.getSelected();
      await window.PlayerUI.choosePlayer({ currentId: current ? current.id : null });
    } finally {
      choosing = false;
      renderPlayerCard();
    }
  });

  document.addEventListener("players:changed", renderPlayerCard);
  document.addEventListener("autosync:changed", renderPlayerCard);
  window.addEventListener("online", renderPlayerCard);
  window.addEventListener("offline", renderPlayerCard);
  renderPlayerCard();

  // プレイヤー管理画面（タイトルの上に重ねて表示。「もどる」で閉じる）
  document.getElementById("players-button").addEventListener("click", () => {
    window.PlayerUI.openManager();
  });
})();
