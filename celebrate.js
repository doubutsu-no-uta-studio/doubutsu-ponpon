/* お祝い演出（紙吹雪・メッセージ・効果音）
   Celebrate.personalBest(key)   自己ベストを更新したとき
   Celebrate.ranking(rank, key)  オンライン登録に成功し、順位が20位以内と確認できたとき
   ・key が同じお祝いは、1回しか出さない（二重表示の防止）
   ・順位が分からない／21位以下のときは、ランキングのお祝いを出さない
   ・同時に起きたときは、順番に出す（重ならない）
   ・画面のクリック・タップを妨げない（pointer-events: none）
   ・音は game.js の音ON/OFF（bgmEnabled）に従う。音が鳴らなくても、表示は出る
   ・「動きを減らす」設定のときは、紙吹雪を出さない */

(function () {
  const SHOW_MS = 3000;
  const COLORS = ["#f7b7c4", "#f9d976", "#a8d5a2", "#9fcdf0", "#f5b78c", "#cdb5ee"];

  const seen = new Set();
  const queue = [];
  let active = false;
  let audio = null;

  const reducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 効果音（外部の素材は使わない） ---------- */

  function tone(freq, start, length, type, volume) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const t = audio.currentTime + start;

    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + length);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(t);
    osc.stop(t + length);
  }

  function playSound(kind) {
    try {
      if (typeof bgmEnabled !== "undefined" && !bgmEnabled) return;   // 音OFF

      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();

      if (kind === "ranking") {
        [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.3, "triangle", 0.22));
        tone(1568, 0.5, 0.5, "sine", 0.16);
      } else {
        tone(784, 0, 0.16, "sine", 0.2);
        tone(1175, 0.1, 0.24, "sine", 0.2);
      }
    } catch (error) {
      // 音が鳴らせなくても、表示には影響しない
    }
  }

  /* ---------- 表示 ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function confetti(layer, count) {
    for (let i = 0; i < count; i++) {
      const piece = el("span", "cel-piece");
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = COLORS[i % COLORS.length];
      piece.style.setProperty("--x", `${(Math.random() - 0.5) * 120}px`);
      piece.style.setProperty("--r", `${(Math.random() - 0.5) * 900}deg`);
      piece.style.setProperty("--d", `${1.9 + Math.random() * 0.9}s`);
      piece.style.setProperty("--delay", `${Math.random() * 0.5}s`);
      layer.appendChild(piece);
    }
  }

  function run(job) {
    active = true;

    const layer = el("div", `cel-layer ${job.kind}`);
    layer.setAttribute("aria-hidden", "true");

    const banner = el("div", "cel-banner");

    if (job.kind === "ranking") {
      banner.appendChild(el("div", "cel-trophy", "🏆"));

      if (job.rank <= 3) {
        const medal = ["gold", "silver", "bronze"][job.rank - 1];
        banner.appendChild(el("div", `cel-medal ${medal}`, String(job.rank)));
      }

      banner.appendChild(el("div", "cel-title", `ランキング ${job.rank}い おめでとう！`));
    } else {
      banner.appendChild(el("div", "cel-title", "じこベスト こうしん！"));
    }

    layer.appendChild(banner);
    if (!reducedMotion()) confetti(layer, job.kind === "ranking" ? 64 : 26);
    document.body.appendChild(layer);

    playSound(job.kind);

    setTimeout(() => {
      layer.remove();
      active = false;
      next();
    }, SHOW_MS);
  }

  function next() {
    if (!active && queue.length > 0) run(queue.shift());
  }

  // 同じ key のお祝いは、1回だけ
  function enqueue(job, key) {
    if (key) {
      if (seen.has(key)) return false;
      seen.add(key);
    }

    queue.push(job);
    next();
    return true;
  }

  window.Celebrate = {
    personalBest(key) {
      return enqueue({ kind: "best" }, key && `best:${key}`);
    },

    ranking(rank, key) {
      if (!Number.isInteger(rank) || rank < 1 || rank > 20) return false;
      return enqueue({ kind: "ranking", rank }, key && `rank:${key}`);
    }
  };

  // オフラインからの自動再送で登録できたとき
  document.addEventListener("autosync:registered", (event) => {
    const d = event.detail;
    if (d.code !== "registered" && d.code !== "updated") return;

    window.Celebrate.ranking(d.rank, `${d.playerId}:${d.score}`);
  });
})();
