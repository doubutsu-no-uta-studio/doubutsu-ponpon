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

  // プレイヤー管理画面（タイトルの上に重ねて表示。「もどる」で閉じる）
  document.getElementById("players-button").addEventListener("click", () => {
    window.PlayerUI.openManager();
  });
})();
