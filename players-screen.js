/* プレイヤー管理画面とダイアログ（画面の処理）
   ダイアログは管理画面から独立しているので、
   結果画面やランキング画面からも同じ部品を使えます。

   公開API（window.PlayerUI）
     openManager()        プレイヤー管理画面を開く
     closeManager()       閉じる
     addPlayerFlow(opts)  名前＋ランキング参加の選択ダイアログ → 追加。追加したプレイヤー or null を返す
                          opts.select:false なら、選択状態は変えない（結果画面用）
     editFlow(id)         編集ダイアログ（名前・ランキング参加）→ 変更後のプレイヤー or null
     deleteFlow(id)       削除確認ダイアログ → 削除。削除したら true
     choosePlayer(opts)   プレイヤー選択画面（タイトル・結果画面で共通）。
                          { id: "..."|null(ゲスト) } を返す。閉じただけなら null
                          opts.currentId   いま選んでいるプレイヤー（null=ゲスト）
                          opts.select      false なら Players の選択状態は変えない（結果画面用）
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

  /* ---------- ランキング参加の選択 ---------- */

  const RANK_NOTICE_ON =
    "なまえと スコアが インターネットで みんなに みえるよ。ほんとうの なまえは つかわないでね。";
  const RANK_NOTICE_OFF = "ランキングには のらないよ。じこベストは この たんまつに のこるよ。";

  // 「ランキングに さんかする／さんかしない」の2択（最初は、どちらも選ばれていない）
  // 戻り値: { element, get(), set(value), onChange(fn) }
  function rankingChoice(initial) {
    let value = typeof initial === "boolean" ? initial : null;
    const listeners = [];

    const wrap = el("div", "rank-choice");
    const yes = el("button", "rank-choice-btn", "ランキングに さんかする");
    const no = el("button", "rank-choice-btn", "さんかしない");
    const notice = el("p", "rank-choice-notice");
    for (const b of [yes, no]) b.type = "button";

    function render() {
      yes.classList.toggle("selected", value === true);
      no.classList.toggle("selected", value === false);
      yes.setAttribute("aria-pressed", String(value === true));
      no.setAttribute("aria-pressed", String(value === false));
      notice.textContent = value === true ? RANK_NOTICE_ON : value === false ? RANK_NOTICE_OFF : "どちらかを えらんでね";
      notice.className = "rank-choice-notice" + (value === true ? " on" : "");
      listeners.forEach((fn) => fn(value));
    }

    yes.addEventListener("click", () => { value = true; render(); });
    no.addEventListener("click", () => { value = false; render(); });

    const row = el("div", "rank-choice-row");
    row.append(yes, no);
    wrap.append(row, notice);
    render();

    return {
      element: wrap,
      get: () => value,
      onChange: (fn) => listeners.push(fn)
    };
  }

  // 名前入力＋ランキング参加の選択（新規登録・編集で共通）。
  // { name, ranked } を返す。キャンセルなら null
  function promptPlayer({ title, initialName = "", initialRanked = null, okLabel, rankedLabel = true }) {
    return openDialog((box, close) => {
      const input = el("input", "dialog-input");
      input.type = "text";
      input.value = initialName;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("enterkeyhint", "done");
      input.setAttribute("aria-label", "プレイヤーの なまえ");

      const counter = el("div", "dialog-counter");
      const message = el("div", "dialog-error");
      const choice = rankingChoice(initialRanked);
      const okButton = el("button", "dialog-ok", okLabel);
      const cancelButton = el("button", "dialog-cancel", "やめる");

      // 名前が正しく、ランキングの選択もできているときだけ、押せる
      function refresh() {
        const check = Players.validateName(input.value);
        const length = input.value.trim().length;

        counter.textContent = `${length} / ${Players.MAX_NAME_LENGTH}`;
        counter.classList.toggle("over", length > Players.MAX_NAME_LENGTH);

        message.textContent =
          check.ok || input.value.trim() === "" ? "" : check.error;
        okButton.disabled = !check.ok || choice.get() === null;
      }

      function submit() {
        const check = Players.validateName(input.value);
        if (check.ok && choice.get() !== null) close({ name: check.name, ranked: choice.get() });
      }

      choice.onChange(refresh);
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

      box.append(el("h3", "dialog-title", title), input, counter, message, choice.element, buttons);

      refresh();
      setTimeout(() => input.focus(), 0);
    });
  }

  // 参加するか未選択の既存プレイヤーに、参加するかどうかをたずねる。選んだら Players に反映する
  // 「あとで きめる」のときは、未選択のまま（オンラインには何も送らない）
  const askedThisSession = new Set();

  async function askRankingIfUndecided(id) {
    const player = Players.get(id);
    if (!player || player.ranked !== null || askedThisSession.has(id)) return;
    askedThisSession.add(id);

    const answer = await openDialog((box, close) => {
      const choice = rankingChoice(null);
      const later = el("button", "dialog-cancel", "あとで きめる");
      const ok = el("button", "dialog-ok", "きめた");
      later.type = "button";
      ok.type = "button";
      ok.disabled = true;

      choice.onChange((value) => { ok.disabled = value === null; });
      later.addEventListener("click", () => close(null));
      ok.addEventListener("click", () => close(choice.get()));

      const buttons = el("div", "dialog-buttons");
      buttons.append(later, ok);

      box.append(
        el("h3", "dialog-title", `「${player.name}」は ランキングに さんかする？`),
        choice.element,
        buttons
      );
    });

    if (typeof answer === "boolean") Players.setRanked(id, answer);
  }

  /* ---------- 追加・編集・削除の流れ ---------- */

  async function addPlayerFlow(options = {}) {
    if (Players.list().length >= Players.MAX_PLAYERS) {
      await confirmDialog({
        title: "いっぱいだよ",
        message: `プレイヤーは ${Players.MAX_PLAYERS}にんまで。` +
          "つかわない プレイヤーを けしてね。",
        okLabel: "わかった"
      });
      return null;
    }

    const input = await promptPlayer({
      title: "あたらしく とうろく",
      okLabel: "とうろく"
    });
    if (input === null) return null;

    const result = Players.add(input.name, { ranked: input.ranked, select: options.select !== false });
    return result.ok ? result.player : null;
  }

  // 編集：名前の変更と、ランキング参加・不参加の変更
  async function editFlow(id) {
    const player = Players.get(id);
    if (!player) return null;

    const input = await promptPlayer({
      title: "プレイヤーを へんしゅう",
      initialName: player.name,
      initialRanked: player.ranked,
      okLabel: "ほぞん"
    });
    if (input === null) return null;

    // 参加をやめるときは、オンラインの なまえと スコアが きえることを確認する
    if (input.ranked === false && player.ranked !== false && Players.getSyncInfo(id).state !== "unregistered") {
      const yes = await confirmDialog({
        title: "ランキングから けす？",
        message: `「${player.name}」の なまえと スコアを、オンラインの ランキングから けすよ。` +
          "この たんまつの じこベストは のこるよ。",
        okLabel: "けす",
        danger: true
      });
      if (!yes) return null;
    }

    if (input.name !== player.name) Players.rename(id, input.name);   // ランキング参加中なら、自動で反映される
    if (input.ranked !== player.ranked) Players.setRanked(id, input.ranked);

    return Players.get(id);
  }

  async function deleteFlow(id) {
    const player = Players.get(id);
    if (!player) return false;

    const online = player.ranked === true || player.onlineScore > 0 || player.pendingScore > 0;

    const yes = await confirmDialog({
      title: `「${player.name}」を けす？`,
      message: online
        ? "この たんまつの プレイヤーの きろくと、オンラインの ランキングの なまえと スコアを けします。もとには もどせないよ。"
        : "この たんまつから プレイヤーと じこベストを けします。もとには もどせないよ。",
      okLabel: "けす",
      danger: true
    });
    if (!yes) return false;

    return Players.remove(id);
  }

  /* ---------- プレイヤー選択画面（タイトル・結果画面で共通） ---------- */

  // 選択画面を開く。{ kind: "player", id } | { kind: "guest" } | { kind: "new" } | null
  function openPicker(currentId) {
    return openDialog((box, close) => {
      const players = Players.listRecent();
      const list = el("ul", "picker-list");

      function row(className, selected, nameText, subText, onClick) {
        const button = el("button", className + (selected ? " selected" : ""));
        button.type = "button";
        button.setAttribute("aria-pressed", String(selected));
        button.append(
          el("span", "player-check", selected ? "✓" : ""),
          el("span", "picker-name", nameText),
          el("span", "picker-best", subText)
        );
        button.addEventListener("click", onClick);
        return button;
      }

      for (const player of players) {
        const item = el("li");
        const mark = player.ranked === true ? "🏆 " : "";
        item.appendChild(row("picker-row", player.id === currentId, mark + player.name,
          `ベスト ${player.bestScore}`, () => close({ kind: "player", id: player.id })));
        list.appendChild(item);
      }

      if (players.length === 0) {
        list.appendChild(el("li", "picker-empty", "まだ とうろくした ひとは いないよ"));
      }

      const guest = row("picker-row picker-guest", currentId === null, "ゲスト", "きろくは のこらないよ",
        () => close({ kind: "guest" }));

      const add = el("button", "picker-add", "＋ あたらしく とうろく");
      add.type = "button";
      add.addEventListener("click", () => close({ kind: "new" }));

      const cancel = el("button", "dialog-cancel", "とじる");
      cancel.type = "button";
      cancel.addEventListener("click", () => close(null));

      box.classList.add("picker-box");
      box.append(el("h3", "dialog-title", "だれが あそぶ？"), list, guest, add, cancel);
    });
  }

  // 選んでもらい、結果を返す（{ id } / ゲストは id が null / 閉じただけなら null）
  // 新規登録を選んだときは、登録まで行う（やめたら選択画面にもどる）
  async function choosePlayer(options = {}) {
    const apply = options.select !== false;
    let currentId = options.currentId === undefined ? null : options.currentId;

    for (;;) {
      const picked = await openPicker(currentId);
      if (picked === null) return null;

      if (picked.kind === "guest") {
        if (apply) Players.selectGuest();
        return { id: null };
      }

      if (picked.kind === "new") {
        const player = await addPlayerFlow({ select: apply });
        if (player) return { id: player.id };
        continue;   // 登録をやめたら、選択画面にもどる
      }

      if (!Players.get(picked.id)) continue;   // 選んでいる間に消えていた
      if (apply) Players.select(picked.id);
      await askRankingIfUndecided(picked.id);
      return { id: picked.id };
    }
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
        el("span", "player-name", (player.ranked === true ? "🏆 " : "") + player.name),
        el("span", "player-best", `ベスト ${player.bestScore}`)
      );

      const editButton = el("button", "player-icon", "✏️");
      editButton.dataset.action = "edit";
      editButton.setAttribute("aria-label", `${player.name}を へんしゅう`);

      const deleteButton = el("button", "player-icon", "🗑");
      deleteButton.dataset.action = "delete";
      deleteButton.setAttribute("aria-label", `${player.name}を けす`);

      item.append(selectButton, editButton, deleteButton);
      listElement.appendChild(item);
    }

    if (players.length === 0) {
      noteElement.textContent =
        "まだ プレイヤーが いないよ。ゲストでも あそべるよ！";
    } else {
      noteElement.textContent =
        `あそぶ ひとを えらんでね（${players.length} / ${Players.MAX_PLAYERS}にん）　🏆 は ランキングに さんかちゅう`;
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
        await askRankingIfUndecided(id);
        break;
      case "edit":
        await editFlow(id);
        break;
      case "delete":
        await deleteFlow(id);
        break;
    }
  });

  addButton.addEventListener("click", () => addPlayerFlow());

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
    editFlow,
    deleteFlow,
    choosePlayer,
    openDialog
  };
})();
