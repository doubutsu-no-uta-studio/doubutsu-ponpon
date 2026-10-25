/* ゲーム中のボタン：リセット（確認画面）と、動物の進化一覧
   どちらも、開いている間は、ゲームを止める（DoubutsuGame.holdPause / releasePause）。
   もともと一時停止中だったときは、閉じても、勝手に再開しない。
   リセットしても、今回のスコアは、プレイヤーの記録にもランキングにも残さない
   （game:over を出さず、Players にも触らない）。 */

(function () {
  const resetButton = document.getElementById("reset-button");
  const evolveButton = document.getElementById("evolve-button");
  const titleScreen = document.getElementById("title-screen");
  const evolveScreen = document.getElementById("evolve-screen");
  const evoList = document.getElementById("evo-list");
  const evoScroll = document.getElementById("evo-scroll");
  const evoHint = document.getElementById("evo-hint");
  const evoClose = document.getElementById("evo-close");

  let busy = false;   // 確認画面・進化一覧のどちらかを開いている間は、もう1つ開かない

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- リセット ---------- */

  async function askReset() {
    return PlayerUI.openDialog((box, close) => {
      const again = el("button", "dialog-ok dialog-danger", "もういちど あそぶ");
      const title = el("button", "dialog-cancel", "タイトルに もどる");
      const keep = el("button", "dialog-ok", "ゲームを つづける");

      for (const b of [again, title, keep]) b.type = "button";

      again.addEventListener("click", () => close("again"));
      title.addEventListener("click", () => close("title"));
      keep.addEventListener("click", () => close("keep"));

      const buttons = el("div", "dialog-buttons stack");
      buttons.append(keep, again, title);

      box.append(
        el("h3", "dialog-title", "ゲームを おわる？"),
        el("p", "dialog-message center", "いまの スコアは きろくされないよ"),
        buttons
      );

      // まちがえて終わらないよう、最初は「ゲームを つづける」を選んでおく
      setTimeout(() => keep.focus(), 0);
    });
  }

  resetButton.addEventListener("click", async () => {
    if (busy || !window.DoubutsuGame.holdPause()) return;   // ゲーム中でないときは何もしない
    busy = true;

    const choice = await askReset();   // 外側のタップ・Escは、「つづける」と同じ

    busy = false;

    if (choice === "again") {
      window.DoubutsuGame.start();            // 最初から（スコア・動物・次の動物・危険ラインの数えを初期化）
    } else if (choice === "title") {
      window.DoubutsuGame.exitToTitle();
      titleScreen.classList.remove("hidden");
    } else {
      window.DoubutsuGame.releasePause();     // 中断前の状態から再開（もともと一時停止中なら、そのまま）
    }
  });

  /* ---------- 動物の進化一覧 ---------- */

  function renderEvolution() {
    const chain = window.DoubutsuGame.getEvolutionChain();

    evoList.textContent = "";

    chain.forEach((animal, index) => {
      const item = el("li", "evo-item");

      const picture = el("div", "evo-picture");

      if (animal.image) {
        const img = el("img");
        img.src = animal.image;
        img.alt = "";
        picture.appendChild(img);
      } else {
        picture.textContent = animal.emoji;
      }

      item.append(picture, el("span", "evo-name", animal.name));

      // いちばん大きい動物には、矢印ではなく、「いちばん おおきい」の目印をつける（その先には進化しない）
      if (index === chain.length - 1) item.append(el("span", "evo-last", "いちばん おおきい！"));

      evoList.appendChild(item);

      if (index < chain.length - 1) {
        const arrow = el("li", "evo-arrow", "→");
        arrow.setAttribute("aria-hidden", "true");
        evoList.appendChild(arrow);
      }
    });
  }

  function updateHint() {
    evoHint.hidden = !(evoScroll.scrollWidth > evoScroll.clientWidth + 1);
  }

  evolveButton.addEventListener("click", () => {
    if (busy || !window.DoubutsuGame.holdPause()) return;
    busy = true;

    renderEvolution();
    evolveScreen.classList.remove("hidden");
    evoScroll.scrollLeft = 0;
    updateHint();
    evoClose.focus();
  });

  function closeEvolution() {
    if (evolveScreen.classList.contains("hidden")) return;

    evolveScreen.classList.add("hidden");
    busy = false;
    window.DoubutsuGame.releasePause();
  }

  evoClose.addEventListener("click", closeEvolution);
  window.addEventListener("resize", updateHint);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEvolution();
  });
})();
