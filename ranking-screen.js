/* ランキング一覧画面（読み取りと表示だけ。登録の処理には関わらない）
   ・上位20人：順位・名前・得点（同点は同順位、同点なら到達の早い順）。1〜3位にメダル
   ・下の欄：選んだプレイヤーの順位と記録（20位より下でも見られる）。プレイヤーの切り替えもできる
   ・「こうしん」で最新の情報を取得する

   公開API（window.RankingUI）
     open()   画面を開いて、最新の情報を取得する
     close()  閉じる
*/

(function () {
  const screen = document.getElementById("ranking-screen");
  const listElement = document.getElementById("rank-list");
  const listWrap = document.getElementById("rank-list-wrap");
  const stateBox = document.getElementById("rank-state");
  const stateImage = document.getElementById("rank-state-img");
  const stateText = document.getElementById("rank-state-text");
  const stateRetry = document.getElementById("rank-state-retry");
  const refreshButton = document.getElementById("rank-refresh");
  const backButton = document.getElementById("rank-back");
  const playerSelect = document.getElementById("rank-player-select");
  const meBody = document.getElementById("rank-me-body");
  const meNote = document.getElementById("rank-me-note");
  const meReset = document.getElementById("rank-me-reset");

  const TOP_COUNT = 20;
  const REFRESH_COOLDOWN_MS = 1500;   // 連打で読み取り回数が増えないように

  let listToken = 0;       // 古い返事で、新しい表示を上書きしないための番号
  let standingToken = 0;
  let entries = [];        // いま表示している上位の記録
  let standing = null;     // 選んだプレイヤーの、サーバー上の状況

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ---------- メッセージ ---------- */

  // 読み込みに失敗したときの、子ども向けの案内
  function loadErrorMessage(result) {
    switch (result && result.code) {
      case "offline":
        return "インターネットに つながっていないよ。つながったら もういちど ためしてね";
      case "timeout":
        return "へんじが こないよ。あとで もういちど ためしてね";
      case "not-connected":
      case "unauthenticated":
        return "オンラインに つながっていないよ。あとで もういちど ためしてね";
      default:
        return "ランキングを よみこめなかったよ。あとで もういちど ためしてね";
    }
  }

  /* ---------- 上位の一覧 ---------- */

  // 中央の状態表示（よみこみ中・空・失敗）。一覧は隠す
  function showState(kind, text) {
    const images = {
      loading: "assets/images/owl.png",
      empty: "assets/images/sloth.png",
      error: "assets/images/redpanda.png"
    };

    stateImage.src = images[kind];
    stateBox.className = `rank-state ${kind}`;
    stateText.textContent = text;
    stateRetry.hidden = kind !== "error";
    stateBox.hidden = false;
    listWrap.hidden = true;
    updateScrollUi();
  }

  function showList() {
    stateBox.hidden = true;
    listWrap.hidden = false;
    updateScrollUi();
  }

  // 順位の表記：1位は「🥇 1位」、2位は「🥈 2位」、3位は「🥉 3位」、4位以降は「4位」
  function rankLabel(rank) {
    const medal = rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : "";
    return `${medal}${rank}位`;
  }

  // 同点は同順位（1位、2位、2位、4位）：自分より高い得点の人数 + 1
  function ranksOf(list) {
    return list.map((entry) => 1 + list.filter((other) => other.score > entry.score).length);
  }

  function localIds() {
    return new Set(Players.list().map((p) => p.id));
  }

  function renderList() {
    const ranks = ranksOf(entries);
    const mine = localIds();
    const selected = Players.getSelected();

    listElement.textContent = "";

    entries.forEach((entry, index) => {
      const rank = ranks[index];
      const isMine = mine.has(entry.id);
      const isSelected = selected && selected.id === entry.id;

      const row = el("li", "rank-row" + (isMine ? " mine" : "") + (isSelected ? " selected" : ""));
      row.dataset.id = entry.id;

      // 1〜3位はメダル付き（同順位なら同じメダル）：「🥇 1位」「4位」
      const pos = el("span", "rank-pos", rankLabel(rank));

      const name = el("span", "rank-name", entry.name);
      row.append(pos, name);

      if (isMine) row.append(el("span", "rank-tag", isSelected ? "あなた" : "うちの こ"));

      row.append(el("span", "rank-score", `${entry.score}てん`));
      listElement.appendChild(row);
    });
  }

  async function loadList() {
    const token = ++listToken;

    refreshButton.disabled = true;
    showState("loading", "ランキングを よみこんでいるよ！");

    const result = await Ranking.fetchTop(TOP_COUNT);
    if (token !== listToken) return;

    if (!result.ok) {
      showState("error", loadErrorMessage(result));
    } else if (result.entries.length === 0) {
      entries = [];
      showState("empty", "まだ だれも とうろくしていないよ。いちばんのりを めざそう！");
    } else {
      entries = result.entries;
      renderList();
      showList();
      listElement.scrollTop = 0;
      updateScrollUi();
    }

    // 続けて何度も押されないよう、少しだけ待ってから、また押せるようにする
    setTimeout(() => {
      if (token === listToken) refreshButton.disabled = false;
    }, REFRESH_COOLDOWN_MS);
  }

  /* ---------- 自分の順位（下の欄） ---------- */

  function renderPlayerSelect() {
    const players = Players.list();
    const selected = Players.getSelected();

    playerSelect.textContent = "";

    for (const player of players) {
      const option = el("option", "", player.name);
      option.value = player.id;
      option.selected = Boolean(selected) && selected.id === player.id;
      playerSelect.appendChild(option);
    }

    // ゲストは一番下
    const guest = el("option", "", "ゲスト");
    guest.value = "";
    guest.selected = !selected;
    playerSelect.appendChild(guest);
  }

  function setMe(parts, note = "", showReset = false) {
    meBody.textContent = "";
    meBody.append(...parts);

    meNote.textContent = note;
    meNote.hidden = note === "";
    meReset.hidden = !showReset;
  }

  function renderMe() {
    const player = Players.getSelected();

    if (!player) {
      standing = null;
      setMe([el("span", "rank-me-text", "ゲストは ランキングに のらないよ")]);
      return;
    }

    const info = Players.getSyncInfo(player.id);

    // しらべている間は、「のっていない」とは表示しない（結果が出るまで待つ）
    if (!standing || standing.playerId !== player.id || standing.loading) {
      setMe([el("span", "rank-me-text", "しらべているよ…")]);
      return;
    }

    if (standing.error) {
      setMe([el("span", "rank-me-text", "じぶんの じゅんいを よみこめなかったよ")]);
      return;
    }

    if (standing.entry) {
      const rank = standing.rank ? rankLabel(standing.rank) : "－";

      setMe([
        el("span", "rank-me-rank", rank),
        el("span", "rank-me-name", standing.entry.name),
        el("span", "rank-me-score", `${standing.entry.score}てん`)
      ]);
      return;
    }

    // サーバーに記録がない
    if (player.ranked !== true) {
      const text = player.ranked === false
        ? "ランキングに さんかしていないよ"
        : "ランキングに さんかするか きめていないよ";
      setMe([el("span", "rank-me-text", text)], "「プレイヤー」の へんしゅうで かえられるよ");
      return;
    }

    const parts = [el("span", "rank-me-text", "まだ ランキングに のっていないよ")];

    if (info.bestScore > 0) {
      parts.push(el("span", "rank-me-sub", `じこベスト ${info.bestScore}てん（とうろくまち）`));
    }

    // この端末は「登録済み」と覚えているのに、サーバーには記録がない（消された場合など）
    if (info.onlineScore > 0) {
      setMe(parts, "この たんまつでは とうろく ずみに なっているけど、ランキングに きろくが ないよ", true);
    } else {
      setMe(parts);
    }
  }

  async function loadStanding() {
    const player = Players.getSelected();
    const token = ++standingToken;

    renderPlayerSelect();

    if (!player) {
      renderMe();
      return;
    }

    standing = { playerId: player.id, loading: true };
    renderMe();

    const result = await Ranking.fetchPlayerEntry(player.id);
    if (token !== standingToken) return;

    standing = result.ok
      ? { playerId: player.id, entry: result.entry, rank: result.rank }
      : { playerId: player.id, error: true };

    renderMe();
  }

  /* ---------- とうろくまち（通信できなくて、まだ送れていない登録） ---------- */

  const pendingBox = document.getElementById("rank-pending");
  const pendingList = document.getElementById("rank-pending-list");

  function pendingStateText(status) {
    if (status.state === "sending") return "いま おくっているよ…";
    if (status.state === "stopped") return status.message || "いまは とうろくできないよ";
    return "つうしんが もどったら とうろくするよ";
  }

  // 登録待ちのあるプレイヤーを、1人ずつ表示する（だれの記録か分かるように、名前つき）
  function renderPending() {
    const items = Players.list()
      .filter((p) => Players.getSyncInfo(p.id).needsSync && !Players.hasPendingDelete(p.id))
      .map((p) => ({ player: p, status: window.AutoSync ? window.AutoSync.getStatus(p.id) : { state: "waiting" } }));

    pendingList.textContent = "";
    pendingBox.hidden = items.length === 0;

    for (const { player, status } of items) {
      const sending = status.state === "sending";
      const stopped = status.state === "stopped";
      const canRetry = !(stopped && ["invalid-score", "invalid-name", "player-not-found", "reload-needed"].includes(status.code));

      const row = el("li", `rank-pending-row ${status.state}`);
      row.dataset.id = player.id;

      const main = el("div", "rank-pending-main");
      main.append(
        el("span", "rank-pending-name", player.name),
        el("span", "rank-pending-score",
          player.pendingScore > player.onlineScore ? `${player.pendingScore}てん` : "なまえの へんこう")
      );

      const actions = el("div", "rank-pending-actions");

      if (canRetry) {
        const retry = el("button", "rank-pending-btn", stopped ? "もういちど ためす" : "いますぐ ためす");
        retry.type = "button";
        retry.dataset.action = "retry";
        retry.disabled = sending;
        actions.appendChild(retry);
      }

      row.append(main, el("p", `rank-pending-state ${status.state}`, pendingStateText(status)), actions);
      pendingList.appendChild(row);
    }
  }

  pendingList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;

    window.AutoSync.retryNow(button.closest(".rank-pending-row").dataset.id);
  });

  // 自動再送の状態が変わったとき・自動で登録できたとき（開いている間だけ）
  document.addEventListener("autosync:changed", () => {
    if (!screen.classList.contains("hidden")) renderPending();
  });

  document.addEventListener("autosync:registered", () => {
    if (screen.classList.contains("hidden")) return;
    renderPending();
    load();   // ランキングと自分の順位も、最新にする
  });

  /* ---------- 操作 ---------- */

  function load() {
    loadList();
    loadStanding();
  }

  function open() {
    screen.classList.remove("hidden");
    renderPending();
    load();
  }

  function close() {
    listToken++;       // 閉じたあとに届いた返事は、使わない
    standingToken++;
    screen.classList.add("hidden");
  }

  refreshButton.addEventListener("click", () => {
    if (!refreshButton.disabled) load();
  });

  stateRetry.addEventListener("click", load);
  backButton.addEventListener("click", close);

  // プレイヤーを切り替える（結果画面や管理画面と同じ「前回選んだプレイヤー」として覚える）
  playerSelect.addEventListener("change", () => {
    if (playerSelect.value === "") Players.selectGuest();
    else Players.select(playerSelect.value);
    renderList();
    loadStanding();
  });

  // 登録の記録が見つからないとき：本人が選んだときだけ、もう一度登録できる状態に戻す
  meReset.addEventListener("click", async () => {
    const player = Players.getSelected();
    if (!player) return;

    const agreed = await PlayerUI.openDialog((box, closeDialog) => {
      const cancelButton = el("button", "dialog-cancel", "やめる");
      const okButton = el("button", "dialog-ok", "やりなおす");
      cancelButton.type = "button";
      okButton.type = "button";
      cancelButton.addEventListener("click", () => closeDialog(false));
      okButton.addEventListener("click", () => closeDialog(true));

      const buttons = el("div", "dialog-buttons");
      buttons.append(cancelButton, okButton);

      box.append(
        el("h3", "dialog-title", `「${player.name}」の とうろく`),
        el("p", "dialog-message",
          "ランキングに きろくが みつからないよ。もういちど とうろくできるように しますか？" +
          "（なまえと じこベストは そのまま のこるよ）"),
        buttons
      );

      setTimeout(() => cancelButton.focus(), 0);
    }).then((result) => result === true);

    if (!agreed) return;

    Players.resetOnlineState(player.id);
    renderMe();
  });

  // 画面が開いている間に、プレイヤーの選択が変わったら、表示を合わせる
  document.addEventListener("players:changed", () => {
    if (screen.classList.contains("hidden")) return;

    renderPlayerSelect();
    if (entries.length > 0 && !listWrap.hidden) renderList();
    renderMe();
    renderPending();
  });

  /* ---------- 一覧のスクロール表示（右端の細いバー・上下のぼかし） ---------- */

  const thumb = listWrap.querySelector(".rank-scroll-thumb");
  const track = listWrap.querySelector(".rank-scroll-track");

  function updateScrollUi() {
    const maxScroll = listElement.scrollHeight - listElement.clientHeight;
    const scrollable = !listWrap.hidden && maxScroll > 1;

    listWrap.classList.toggle("scrollable", scrollable);

    if (!scrollable) {
      listWrap.classList.remove("can-scroll-up", "can-scroll-down");
      return;
    }

    const trackHeight = track.clientHeight;
    const thumbHeight = Math.max(
      24, Math.round(trackHeight * listElement.clientHeight / listElement.scrollHeight)
    );
    const ratio = listElement.scrollTop / maxScroll;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${Math.round((trackHeight - thumbHeight) * ratio)}px)`;

    listWrap.classList.toggle("can-scroll-up", listElement.scrollTop > 2);
    listWrap.classList.toggle("can-scroll-down", listElement.scrollTop < maxScroll - 2);
  }

  listElement.addEventListener("scroll", updateScrollUi, { passive: true });
  new MutationObserver(updateScrollUi).observe(listElement, { childList: true });
  if (window.ResizeObserver) new ResizeObserver(updateScrollUi).observe(listElement);
  window.addEventListener("resize", updateScrollUi);
  window.addEventListener("orientationchange", updateScrollUi);

  window.RankingUI = { open, close };
})();
