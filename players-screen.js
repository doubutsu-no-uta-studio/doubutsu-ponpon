/* プレイヤー管理画面とダイアログ（画面の処理）
   ダイアログは管理画面から独立しているので、
   結果画面やランキング画面からも同じ部品を使えます。

   公開API（window.PlayerUI）
     openManager()        プレイヤー管理画面を開く
     closeManager()       閉じる
     addPlayerFlow()      名前入力ダイアログ → 追加。追加したプレイヤー or null を返す
     renameFlow(id)       名前変更ダイアログ → 変更。変更後のプレイヤー or null
     deleteFlow(id)       削除確認ダイアログ → 削除。削除したら true
     openDialog(build)    ダイアログの枠を開く（Escや外側タップで閉じる）。build(box, close) で中身を作り、
                          close(結果) で閉じる。閉じたときの結果（キャンセルは null）を Promise で返す
*/

(function () {
  const screen = document.getElementById("players-screen");
  const listElement = document.getElementById("players-list");
  const noteElement = document.getElementById("players-note");
  const addButton = document.getElementById("player-add-button");
  const backButton = document.getElementById("players-back-button");
  const dialogLayer = document.getElementById("dialog-layer");

  /* ---------- ダイアログ（共通部品） ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ダイアログを1つ開き、閉じたときに結果を返す
  function openDialog(buildContent) {
    return new Promise((resolve) => {
      const backdrop = el("div", "dialog-backdrop");
      const box = el("div", "dialog-box");
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");

      const previousFocus = document.activeElement;

      function close(result) {
        document.removeEventListener("keydown", onKeyDown, true);
        backdrop.remove();
        if (!dialogLayer.firstChild) dialogLayer.classList.add("hidden");
        if (previousFocus && previousFocus.focus) previousFocus.focus();
        resolve(result);
      }

      function onKeyDown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close(null);
        }
      }

      buildContent(box, close);

      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target === backdrop) close(null);
      });

      backdrop.appendChild(box);
      dialogLayer.appendChild(backdrop);
      dialogLayer.classList.remove("hidden");
      document.addEventListener("keydown", onKeyDown, true);
    });
  }

  // 名前入力ダイアログ。入力した名前、キャンセルなら null
  function promptName({ title, initial = "", okLabel = "OK" }) {
    return openDialog((box, close) => {
      const input = el("input", "dialog-input");
      input.type = "text";
      input.value = initial;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("enterkeyhint", "done");
      input.setAttribute("aria-label", "プレイヤーの なまえ");

      const counter = el("div", "dialog-counter");
      const message = el("div", "dialog-error");
      const okButton = el("button", "dialog-ok", okLabel);
      const cancelButton = el("button", "dialog-cancel", "やめる");

      // 入力のたびに、名前を確認する（変換中も打てるよう、文字数は強制で切らない）
      function refresh() {
        const check = Players.validateName(input.value);
        const length = input.value.trim().length;

        counter.textContent = `${length} / ${Players.MAX_NAME_LENGTH}`;
        counter.classList.toggle("over", length > Players.MAX_NAME_LENGTH);

        // 空のときは、エラーを出さずボタンだけ押せなくする
        message.textContent =
          check.ok || input.value.trim() === "" ? "" : check.error;
        okButton.disabled = !check.ok;
      }

      function submit() {
        const check = Players.validateName(input.value);
        if (check.ok) close(check.name);
      }

      input.addEventListener("input", refresh);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          submit();
        }
      });

      okButton.addEventListener("click", submit);
      cancelButton.addEventListener("click", () => close(null));

      const buttons = el("div", "dialog-buttons");
      buttons.append(cancelButton, okButton);

      box.append(
        el("h3", "dialog-title", title),
        input, counter, message, buttons
      );

      refresh();
      setTimeout(() => input.focus(), 0);
    });
  }

  // 確認ダイアログ。OK なら true、それ以外は false
  function confirmDialog({ title, message, okLabel = "OK", danger = false }) {
    return openDialog((box, close) => {
      const okButton = el(
        "button",
        danger ? "dialog-ok dialog-danger" : "dialog-ok",
        okLabel
      );
      const cancelButton = el("button", "dialog-cancel", "やめる");

      okButton.addEventListener("click", () => close(true));
      cancelButton.addEventListener("click", () => close(false));

      const buttons = el("div", "dialog-buttons");
      buttons.append(cancelButton, okButton);

      box.append(
        el("h3", "dialog-title", title),
        el("p", "dialog-message", message),
        buttons
      );

      // 誤って削除しないよう、最初は「やめる」を選んでおく
      setTimeout(() => cancelButton.focus(), 0);
    }).then((result) => result === true);
  }

  /* ---------- 追加・変更・削除の流れ ---------- */

  async function addPlayerFlow() {
    if (Players.list().length >= Players.MAX_PLAYERS) {
      await confirmDialog({
        title: "いっぱいだよ",
        message: `プレイヤーは ${Players.MAX_PLAYERS}にんまで。` +
          "つかわない プレイヤーを けしてね。",
        okLabel: "わかった"
      });
      return null;
    }

    const name = await promptName({
      title: "あたらしい プレイヤー",
      okLabel: "つくる"
    });
    if (name === null) return null;

    const result = Players.add(name);
    return result.ok ? result.player : null;
  }

  async function renameFlow(id) {
    const player = Players.get(id);
    if (!player) return null;

    const name = await promptName({
      title: "なまえを かえる",
      initial: player.name,
      okLabel: "かえる"
    });
    if (name === null) return null;

    const result = Players.rename(id, name);
    return result.ok ? result.player : null;
  }

  async function deleteFlow(id) {
    const player = Players.get(id);
    if (!player) return false;

    const yes = await confirmDialog({
      title: `「${player.name}」を けす？`,
      message: "この たんまつから プレイヤーを けします。" +
        "オンラインの ランキングの きろくは のこるよ。",
      okLabel: "けす",
      danger: true
    });
    if (!yes) return false;

    return Players.remove(id);
  }

  /* ---------- 管理画面 ---------- */

  function renderList() {
    const players = Players.list();
    const selectedId = (Players.getSelected() || {}).id;

    listElement.textContent = "";

    for (const player of players) {
      const isSelected = player.id === selectedId;

      const item = el("li", isSelected ? "player-card selected" : "player-card");
      item.dataset.id = player.id;

      const selectButton = el("button", "player-select");
      selectButton.dataset.action = "select";
      selectButton.setAttribute("aria-pressed", String(isSelected));
      selectButton.append(
        el("span", "player-check", isSelected ? "✓" : ""),
        el("span", "player-name", player.name),
        el("span", "player-best", `ベスト ${player.bestScore}`)
      );

      const editButton = el("button", "player-icon", "✏️");
      editButton.dataset.action = "rename";
      editButton.setAttribute("aria-label", `${player.name}の なまえを かえる`);

      const deleteButton = el("button", "player-icon", "🗑");
      deleteButton.dataset.action = "delete";
      deleteButton.setAttribute("aria-label", `${player.name}を けす`);

      item.append(selectButton, editButton, deleteButton);
      listElement.appendChild(item);
    }

    if (players.length === 0) {
      noteElement.textContent =
        "まだ プレイヤーが いないよ。したの ボタンで つくってね！";
    } else {
      noteElement.textContent =
        `あそぶ ひとを えらんでね（${players.length} / ${Players.MAX_PLAYERS}にん）`;
    }

    addButton.disabled = players.length >= Players.MAX_PLAYERS;
  }

  listElement.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const id = button.closest(".player-card").dataset.id;

    switch (button.dataset.action) {
      case "select":
        Players.select(id);
        break;
      case "rename":
        await renameFlow(id);
        break;
      case "delete":
        await deleteFlow(id);
        break;
    }
  });

  addButton.addEventListener("click", addPlayerFlow);

  function openManager() {
    renderList();
    screen.classList.remove("hidden");
  }

  function closeManager() {
    screen.classList.add("hidden");
  }

  backButton.addEventListener("click", closeManager);

  // データが変わったら、開いている管理画面を更新
  document.addEventListener("players:changed", () => {
    if (!screen.classList.contains("hidden")) renderList();
  });

  window.PlayerUI = {
    openManager,
    closeManager,
    addPlayerFlow,
    renameFlow,
    deleteFlow,
    openDialog
  };
})();
