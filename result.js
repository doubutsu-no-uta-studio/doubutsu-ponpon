/* 結果画面の「だれが あそんだ？」
   ゲームオーバーになっただけでは、誰のスコアにもならない。
   プレイヤーを選んで「きろくする」を押したときだけ、そのプレイヤーの自己ベストに記録する。
   選ばずに「もういちど」「タイトルへ」を押したときは、誰にも記録しない。

   ・1回のゲームオーバーにつき、記録できるのは1回だけ（session.confirmed）
   ・記録するスコアは、ゲームオーバー時に game:over で受け取った値を使う
   ・Players.recordScore は、高い得点のときだけ更新するので、二重に呼んでも結果は同じ
*/

(function () {
  const listElement = document.getElementById("result-player-list");
  const emptyElement = document.getElementById("result-player-empty");
  const addButton = document.getElementById("result-add-player");
  const confirmButton = document.getElementById("result-confirm");
  const messageElement = document.getElementById("result-message");

  // いまのゲームオーバー1回分の状態（ゲームオーバーのたびに作り直す）
  let session = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // 最初に選んでおくプレイヤー＝前回選んだプレイヤー（いなければなし）
  function initialSelectedId() {
    const selected = Players.getSelected();
    return selected ? selected.id : null;
  }

  function setMessage(text, kind = "") {
    messageElement.textContent = text;
    messageElement.className = kind ? `result-message ${kind}` : "result-message";
  }

  function render() {
    if (!session) return;

    const players = Players.list();

    // 選んでいたプレイヤーがいなくなっていたら、選び直し
    if (!players.some((p) => p.id === session.selectedId)) {
      session.selectedId = players[0] ? players[0].id : null;
    }

    listElement.textContent = "";

    for (const player of players) {
      const isSelected = player.id === session.selectedId;

      const button = el("button", isSelected ? "result-chip selected" : "result-chip");
      button.type = "button";
      button.dataset.id = player.id;
      button.disabled = session.confirmed;
      button.setAttribute("aria-pressed", String(isSelected));
      button.append(
        el("span", "result-chip-check", isSelected ? "✓" : ""),
        el("span", "result-chip-name", player.name),
        el("span", "result-chip-best", `ベスト ${player.bestScore}`)
      );

      const item = el("li");
      item.appendChild(button);
      listElement.appendChild(item);
    }

    const hasPlayers = players.length > 0;

    emptyElement.style.display = hasPlayers ? "none" : "block";
    listElement.style.display = hasPlayers ? "flex" : "none";

    addButton.disabled = session.confirmed;

    confirmButton.disabled = session.confirmed || !session.selectedId;
    confirmButton.textContent = session.confirmed
      ? "きろく したよ ✓"
      : "この ひとの きろくに する";
  }

  // ゲームオーバー：選択欄を最初の状態にする（記録はしない）
  document.addEventListener("game:over", (event) => {
    session = {
      score: event.detail.score,
      selectedId: initialSelectedId(),
      confirmed: false
    };

    setMessage("");
    render();
  });

  // 選ぶ（記録はまだしない）
  listElement.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-id]");
    if (!button || !session || session.confirmed) return;

    session.selectedId = button.dataset.id;
    render();
  });

  // 新しいプレイヤーを追加（プレイヤー管理の部品を再利用）。追加した人が選ばれた状態になる
  addButton.addEventListener("click", async () => {
    if (!session || session.confirmed) return;

    const player = await PlayerUI.addPlayerFlow();
    if (!session || session.confirmed) return;

    if (player) session.selectedId = player.id;
    render();
  });

  // 確定：選んだプレイヤーの自己ベストに記録する（1回のゲームオーバーにつき1回だけ）
  confirmButton.addEventListener("click", () => {
    if (!session || session.confirmed || !session.selectedId) return;

    const player = Players.get(session.selectedId);
    if (!player) {
      render();
      return;
    }

    // 連打されても二重に記録しないよう、先に確定済みにする
    session.confirmed = true;
    session.confirmedId = player.id;   // オンライン登録の対象（記録したプレイヤー）

    Players.select(player.id);
    const result = Players.recordScore(player.id, session.score);

    if (!result.ok) {
      session.confirmed = false;
      setMessage("きろくできなかったよ。もういちど ためしてね", "error");
    } else if (result.updated) {
      setMessage("じこベスト こうしん！", "celebrate");
      if (window.Celebrate) window.Celebrate.personalBest(`${player.id}:${result.bestScore}`);
    } else {
      setMessage(`${player.name}の じこベストは ${result.bestScore}てん だよ`);
    }

    render();
    renderRegister();
  });


  /* ---------- オンライン登録 ----------
     「この ひとの きろくに する」でローカルに記録したあと、
     そのプレイヤーの自己ベストが、オンライン登録済みの得点より高いときだけ、登録ボタンを出す。
     ボタンを押して確認画面で「とうろくする」を選ぶまで、Firebase には何も書き込まない。
     登録する得点は「そのプレイヤーの自己ベスト」（今回のスコアとは限らない）。
     送信は Ranking.submit(playerId)。二重送信は、画面側（状態）と Ranking 側の両方で防ぐ。 */

  const registerBox = document.getElementById("result-register");
  const registerButton = document.getElementById("result-register-btn");
  const registerStatus = document.getElementById("result-register-status");

  const REGISTER_LABEL = "🏆 みんなのランキングに とうろく";

  // 登録する得点が、オンラインの条件（ルールと同じ）に合うか
  function isRegistrableScore(score) {
    const limits = window.Ranking && window.Ranking.LIMITS;
    if (!limits) return false;

    return Number.isInteger(score) &&
      score >= limits.minScore &&
      score <= limits.maxScore &&
      score % limits.scoreStep === 0;
  }

  // 登録の対象のプレイヤーID（送信中にIDが割り当て直されても、選択中のプレイヤーをたどる）
  function currentRegisterId() {
    if (!session || !session.confirmedId) return null;
    if (Players.get(session.confirmedId)) return session.confirmedId;

    const selected = Players.getSelected();
    if (selected) {
      session.confirmedId = selected.id;
      return selected.id;
    }
    return null;
  }

  // 登録しなおしても意味のないエラー（内容を直さないと、何度やっても同じ）
  const NO_RETRY = new Set(["invalid-score", "invalid-name", "player-not-found", "reload-needed"]);

  // 通信が使えるようになれば、自動で送り直されるエラー
  const AUTO_RETRY = new Set(["offline", "timeout", "busy", "unauthenticated", "not-connected", "unknown"]);

  const WAITING_NOTE = "（この たんまつに ほぞんできないので、ページを とじると きえるよ）";

  // 登録待ちの案内（だれの きろくか が分かるように、名前を入れる）
  function waitingText(name, saved) {
    const text = `${name}の きろくは、つうしんが もどったら とうろくするよ`;
    return saved === false ? `${text}\n${WAITING_NOTE}` : text;
  }

  function renderRegister() {
    const id = currentRegisterId();
    const info = id ? Players.getSyncInfo(id) : null;
    const reg = session && session.reg;

    // 結果画面でまだ記録していない／オンライン機能が読み込めていない
    if (!session || !session.confirmed || !info || !reg || !window.Ranking) {
      registerBox.hidden = true;
      return;
    }

    const name = Players.get(id).name;
    const auto = window.AutoSync ? window.AutoSync.getStatus(id) : { state: "idle" };

    let showButton = false;
    let label = REGISTER_LABEL;
    let mode = "register";   // register：同意して登録 / retry：同意済みの登録待ちを、いま送る
    let disabled = false;
    let status = "";
    let statusKind = "";

    switch (reg.state) {
      case "submitting":
        showButton = true;
        label = "とうろくちゅう…";
        disabled = true;
        break;

      case "success":
        status = "とうろくできたよ！";
        if (reg.code === "unchanged") status = "もう とうろく ずみだよ！";
        if (reg.rank) status += `\nいまの じゅんい：${reg.rank}い`;
        statusKind = "success";
        break;

      case "error":
        showButton = true;
        mode = "retry";

        if (AUTO_RETRY.has(reg.code) && auto.state !== "stopped") {
          // 登録待ちとして保存した。通信がもどったら、自動で送る
          status = waitingText(name, reg.saved);
          statusKind = "waiting";
          label = "いますぐ ためす";
        } else {
          status = auto.state === "stopped" && auto.message ? auto.message : reg.message;
          statusKind = "error";
          label = "もういちど ためす";
          showButton = !NO_RETRY.has(reg.code);
        }

        disabled = reg.retryAt > Date.now();   // 更新制限のときは、少し待つ
        break;

      default: {   // "idle" / "confirming"
        const hasPending = info.pendingScore > info.onlineScore;

        if (hasPending) {
          // 前に同意した登録待ちが残っている
          if (auto.state === "stopped") {
            status = auto.message;
            statusKind = "error";
          } else {
            status = auto.state === "sending"
              ? `${name}の きろくを おくっているよ…`
              : waitingText(name, Players.isStorageOk());
            statusKind = "waiting";
          }
        }

        if (info.bestScore > Math.max(info.onlineScore, info.pendingScore)) {
          // 自己ベストが、同意済みの得点より高い → 新しく登録するか選べる
          if (isRegistrableScore(info.bestScore)) {
            showButton = true;
            disabled = reg.state === "confirming";
          } else if (!hasPending) {
            status = "この てんすうは ランキングに とうろくできないよ";
          }
        } else if (hasPending && auto.state !== "sending" && !(auto.state === "stopped" && NO_RETRY.has(auto.code))) {
          showButton = true;
          mode = "retry";
          label = auto.state === "stopped" ? "もういちど ためす" : "いますぐ ためす";
        }
      }
    }

    registerBox.hidden = !(showButton || status);
    registerButton.hidden = !showButton;
    registerButton.disabled = disabled;
    registerButton.dataset.mode = mode;
    registerButton.textContent = label;
    registerStatus.textContent = status;
    registerStatus.className = statusKind
      ? `result-register-status ${statusKind}` : "result-register-status";
    registerStatus.hidden = status === "";
  }

  // ゲームオーバーのたびに、登録の状態も最初に戻す（記録の処理のあとで呼ばれる）
  document.addEventListener("game:over", () => {
    if (session) session.reg = { state: "idle" };
    renderRegister();
  });

  // 確認画面（名前とスコアを見せる）。「とうろくする」なら true、それ以外は false
  function askRegister(name, score) {
    return PlayerUI.openDialog((box, close) => {
      const summary = el("div", "dialog-summary");

      const nameRow = el("p", "dialog-summary-row");
      nameRow.append(el("span", "dialog-summary-label", "なまえ"), el("strong", "dialog-summary-value", name));

      const scoreRow = el("p", "dialog-summary-row");
      scoreRow.append(el("span", "dialog-summary-label", "スコア"), el("strong", "dialog-summary-value", `${score}てん`));

      summary.append(nameRow, scoreRow);

      const notice = el("div", "dialog-notice");
      notice.append(
        el("p", "dialog-notice-main", "なまえは みんなに みえるよ"),
        el("p", "dialog-notice-sub", "スコアも みんなに みえるよ。ほんとうの なまえは つかわないでね。")
      );

      const cancelButton = el("button", "dialog-cancel", "やめる");
      const okButton = el("button", "dialog-ok", "とうろくする");
      cancelButton.type = "button";
      okButton.type = "button";
      cancelButton.addEventListener("click", () => close(false));
      okButton.addEventListener("click", () => close(true));

      const buttons = el("div", "dialog-buttons");
      buttons.append(cancelButton, okButton);

      box.append(el("h3", "dialog-title", "ランキングに とうろく する？"), summary, notice, buttons);

      // 間違えて登録しないよう、最初は「やめる」を選んでおく
      setTimeout(() => cancelButton.focus(), 0);
    }).then((result) => result === true);
  }

  // 実際の送信
  //   queueScore：確認画面で同意した得点。あれば、送信待ちとして保存してから送る
  //   null：すでに保存してある送信待ち（同意済み）を、そのまま送る（自己ベストが上がっていても、勝手に増やさない）
  async function runSubmit(target, queueScore) {
    const id = currentRegisterId();
    if (!id) return;

    let saved = Players.isStorageOk();

    if (queueScore !== null) {
      // 登録済みの得点以下なら、送らない
      const queued = Players.queueRegistration(id, queueScore);
      if (!queued.ok) {
        target.reg = { state: "idle" };
        renderRegister();
        return;
      }

      saved = queued.saved;
    }

    target.reg = { state: "submitting", saved };
    renderRegister();

    let result;
    try {
      result = await window.Ranking.submit(id);
    } catch (error) {
      result = {
        ok: false, code: "unknown", retryable: true,
        message: "うまく おくれなかったよ。あとで もういちど ためしてね"
      };
    }

    // 失敗は、別のゲームに進んでいても、自動再送の対象にする
    if (!result.ok && window.AutoSync) {
      window.AutoSync.noteFailure(Players.get(id) ? id : (Players.getSelected() || {}).id || id, result);
    }

    // 送信中に、別のゲームへ進んでいたら、画面は更新しない（端末の記録は Ranking が更新済み）
    if (session !== target) return;

    if (result.ok && result.code === "nothing-to-send") {
      target.reg = { state: "idle" };
    } else if (result.ok) {
      // 登録に成功し、20位以内と確認できたときだけ、ランキングのお祝い（順位が分からなければ出さない）
      if (window.Celebrate && (result.code === "registered" || result.code === "updated")) {
        window.Celebrate.ranking(result.rank, `${result.playerId}:${result.score}`);
      }

      if (result.idChanged && result.playerId) target.confirmedId = result.playerId;
      target.reg = { state: "success", rank: result.rank, code: result.code };
    } else {
      target.reg = {
        state: "error",
        code: result.code,
        message: result.message,
        saved,
        retryAt: result.retryAfterMs ? Date.now() + result.retryAfterMs : 0
      };

      // 更新制限のときは、待ち時間がすぎたらボタンを押せるように戻す
      if (result.retryAfterMs) {
        setTimeout(() => {
          if (session === target) renderRegister();
        }, result.retryAfterMs + 50);
      }
    }

    renderRegister();
  }

  registerButton.addEventListener("click", async () => {
    const target = session;
    if (!target || !target.confirmed || !target.reg) return;

    const state = target.reg.state;
    if (state === "submitting" || state === "confirming" || state === "success") return;

    // 同意済みの登録待ちを、いま送る（失敗したあとの「もういちど ためす」・「いますぐ ためす」）
    // 確認画面は出さない。自己ベストが上がっていても、同意していない得点は送らない
    if (registerButton.dataset.mode === "retry") {
      await runSubmit(target, null);
      return;
    }

    const id = currentRegisterId();
    const player = id && Players.get(id);
    const info = id && Players.getSyncInfo(id);

    if (!player || !info.canRegister || !isRegistrableScore(info.bestScore)) {
      renderRegister();
      return;
    }

    // 確認画面を開いている間は、ボタンを押せなくする（二重に開かない）
    target.reg = { state: "confirming" };
    renderRegister();

    const agreed = await askRegister(player.name, info.bestScore);

    if (session !== target) return;

    if (!agreed) {
      // 「やめる」：オンラインには何も書かない。前に同意して保存した登録待ちは、そのまま残る
      // （取り消しは、ランキング画面の「とうろくを とりけす」から）。ローカルの自己ベストもそのまま
      target.reg = { state: "idle" };
      renderRegister();
      return;
    }

    await runSubmit(target, info.bestScore);
  });

  // 自動再送の状態が変わったとき・自動で登録できたとき
  document.addEventListener("autosync:changed", renderRegister);

  document.addEventListener("autosync:registered", (event) => {
    if (!session || !session.confirmed) return;

    const id = currentRegisterId();
    if (!id || event.detail.playerId !== id) return;

    session.reg = { state: "success", rank: event.detail.rank, code: event.detail.code };
    renderRegister();
  });

  // プレイヤーの変更（別のタブなど）に追従する
  document.addEventListener("players:changed", () => {
    if (session && !session.confirmed) render();
  });
})();

/* プレイヤー一覧のスクロール表示（見た目だけ。選択・記録の処理には関わらない）
   一覧がスクロールできるときだけ、右端の細いバーと「スクロールして…」の案内を出す。
   上下に続きがあるときは、うっすらしたぼかしも出す。 */
(function () {
  const wrap = document.getElementById("result-list-wrap");
  const list = document.getElementById("result-player-list");
  const player = document.getElementById("result-player");
  const thumb = wrap.querySelector(".result-scroll-thumb");
  const track = wrap.querySelector(".result-scroll-track");

  function update() {
    const maxScroll = list.scrollHeight - list.clientHeight;
    const scrollable = maxScroll > 1;

    wrap.classList.toggle("scrollable", scrollable);
    player.classList.toggle("has-scroll", scrollable);

    if (!scrollable) {
      wrap.classList.remove("can-scroll-up", "can-scroll-down");
      return;
    }

    // バーの長さと位置（見えている割合と、いまの位置）
    const trackHeight = track.clientHeight;
    const thumbHeight = Math.max(
      24, Math.round(trackHeight * list.clientHeight / list.scrollHeight)
    );
    const ratio = list.scrollTop / maxScroll;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform =
      `translateY(${Math.round((trackHeight - thumbHeight) * ratio)}px)`;

    wrap.classList.toggle("can-scroll-up", list.scrollTop > 2);
    wrap.classList.toggle("can-scroll-down", list.scrollTop < maxScroll - 2);
  }

  // 選ばれている行が、一覧の見える範囲の外にあるときは、見えるところまで動かす
  // （最初に選ばれているプレイヤーが下の方にいるとき・追加した人が一番下に出るときのため）
  function ensureSelectedVisible() {
    const chip = list.querySelector(".result-chip.selected");
    if (!chip) return;

    const listRect = list.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    if (listRect.height === 0) return;   // 結果画面が表示されていないとき

    const margin = 5;

    if (rect.top < listRect.top + margin) {
      list.scrollTop -= listRect.top + margin - rect.top;
    } else if (rect.bottom > listRect.bottom - margin) {
      list.scrollTop += rect.bottom - (listRect.bottom - margin);
    }
  }

  list.addEventListener("scroll", update, { passive: true });

  // 一覧の中身が作り直されたとき（選択・追加など）
  new MutationObserver(() => {
    ensureSelectedVisible();
    update();
  }).observe(list, { childList: true });
  if (window.ResizeObserver) new ResizeObserver(update).observe(list);
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
})();
