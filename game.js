
console.log("どうぶつのうた スイカゲーム起動！");

const {
  Engine, Render, Runner, Bodies,
  Composite, Events
} = Matter;

const board = document.getElementById("game-board");
const scoreDisplay = document.getElementById("score");
const nextDisplay = document.getElementById("next-animal");

// 動物データ：小さい順
const animals = [
  { name: "メンフクロウ", size: 43, color: "#e7c99b", emoji: "🦉" },
  { name: "レッサーパンダ", size: 54, color: "#d9a16c", emoji: "🐾" },
  { name: "ミユビナマケモノ", size: 68, color: "#b9c99d", emoji: "🦥" },
  { name: "マンドリル", size: 85, color: "#a8b7cf", emoji: "🐒" },
  { name: "クロヒョウ", size: 108, color: "#686b75", emoji: "🐈‍⬛" },
  { name: "マウンテンゴリラ", size: 135, color: "#96999a", emoji: "🦍" },
  { name: "アムールトラ", size: 170, color: "#daa365", emoji: "🐅" },
  { name: "ヘラジカ", size: 214, color: "#9d806b", emoji: "🫎" }
];

const boardWidth = board.clientWidth;
const boardHeight = board.clientHeight;

const engine = Engine.create();
engine.gravity.y = 1.2;

const render = Render.create({
  element: board,
  engine,
  options: {
    width: boardWidth,
    height: boardHeight,
    wireframes: false,
    background: "transparent",
    pixelRatio: window.devicePixelRatio || 1
  }
});

Render.run(render);

const runner = Runner.create();
// 物理演算の開始は startGame()（resetGame）から行う

// タイトル画面から「あそぶ」を押されるまで false
let isGameStarted = false;

// 開発用キー（Gキー・数字キー）は、ローカルの開発環境（localhost など）で、?debug=1 のときだけ有効。
// 公開版（GitHub Pages など）では、URL に ?debug=1 を付けても、有効にならない。
const isLocalDevelopment =
  ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) ||
  location.protocol === "file:";

const debugMode =
  isLocalDevelopment &&
  new URLSearchParams(location.search).get("debug") === "1";

// 壁と床
const wallThickness = 60;

const floor = Bodies.rectangle(
  boardWidth / 2,
  boardHeight + wallThickness / 2,
  boardWidth + wallThickness * 2,
  wallThickness,
  { isStatic: true }
);

const leftWall = Bodies.rectangle(
  -wallThickness / 2,
  boardHeight / 2,
  wallThickness,
  boardHeight * 2,
  { isStatic: true }
);

const rightWall = Bodies.rectangle(
  boardWidth + wallThickness / 2,
  boardHeight / 2,
  wallThickness,
  boardHeight * 2,
  { isStatic: true }
);

Composite.add(engine.world, [
  floor, leftWall, rightWall
]);

// スコア
let score = 0;

// ハイスコアを読み込む
const highScoreDisplay =
  document.getElementById("high-score");

const highScoreKey = "animalPuzzleHighScore";

let highScore = 0;

try {
  highScore = Number(
    localStorage.getItem(highScoreKey)
  ) || 0;
} catch (error) {
  console.log("ハイスコアを読み込めませんでした", error);
}

highScoreDisplay.textContent = highScore;

// スコア更新時に最高記録を保存
// ゲームオーバーのときだけ呼ぶ。リセット・タイトルへ戻るでは呼ばない（今回のスコアは反映されない）
function updateHighScore() {
  if (score <= highScore) return;

  highScore = score;
  highScoreDisplay.textContent = highScore;

  try {
    localStorage.setItem(
      highScoreKey,
      String(highScore)
    );
  } catch (error) {
    console.log("ハイスコアを保存できませんでした", error);
  }
}

/* STEP 13：8種類の動物画像 */

const animalImageFiles = [
  "owl.png",
  "redpanda.png",
  "sloth.png",
  "mandrill.png",
  "panther.png",
  "gorilla.png",
  "tiger.png",
  "moose.png"
];

const animalImages = animalImageFiles.map((file) => {
  const image = new Image();
  image.src = "assets/images/" + file;
  return image;
});

// 落下待ちの動物
let currentLevel = 0;
let nextLevel = 0;
let dropX = boardWidth / 2;
let canDrop = true;

// 動物の表示
const preview = document.createElement("div");
preview.className = "animal";
board.appendChild(preview);

// 落下する動物の種類を決める
function randomLevel() {
  return Math.floor(Math.random() * 3);
}

// プレビュー更新
function updatePreview() {
  const data = animals[currentLevel];
  const file = animalImageFiles[currentLevel];

  if (file) {
    preview.textContent = "";
    preview.style.backgroundImage =
      `url("assets/images/${file}")`;
    preview.style.backgroundSize = "contain";
    preview.style.backgroundRepeat = "no-repeat";
    preview.style.backgroundPosition = "center";
    preview.style.backgroundColor = "transparent";
    preview.style.border = "none";
  } else {
    preview.textContent = data.emoji;
    preview.style.backgroundImage = "none";
    preview.style.backgroundColor = data.color;
    preview.style.border = "";
  }

  preview.style.width = `${data.size}px`;
  preview.style.height = `${data.size}px`;
  preview.style.left = `${dropX}px`;

  const nextFile = animalImageFiles[nextLevel];

  if (nextFile) {
    nextDisplay.textContent = "";
    nextDisplay.style.backgroundImage =
      `url("assets/images/${nextFile}")`;
    nextDisplay.style.backgroundSize = "contain";
    nextDisplay.style.backgroundRepeat = "no-repeat";
    nextDisplay.style.backgroundPosition = "center";
  } else {
    nextDisplay.textContent = animals[nextLevel].emoji;
    nextDisplay.style.backgroundImage = "none";
  }

}

// 位置調整
function moveAnimal(clientX) {
  if (!isGameStarted || !canDrop) return;

  const rect = board.getBoundingClientRect();
  const radius = animals[currentLevel].size / 2;

  let x = clientX - rect.left;
  x = Math.max(radius, Math.min(rect.width - radius, x));

  dropX = x;
  preview.style.left = `${dropX}px`;
}

// 物理ボールを作成
function createAnimal(level, x, y) {
  const data = animals[level];

  const body = Bodies.circle(
    x, y, data.size / 2,
    {
      restitution: 0.25,
      friction: 0.5,
      density: 0.001,

      render: {
        fillStyle: "transparent",
        strokeStyle: "transparent",
        lineWidth: 0
      }
    }
  );

  body.animalLevel = level;
  body.createdAt = Date.now();
  Composite.add(engine.world, body);

  return body;
}

// 動物を落とす
let nextDropReadyTime = null;

function dropAnimal() {
  if (!isGameStarted || !canDrop || isPaused || isGameOver) return;

  canDrop = false;
  preview.style.display = "none";

  const radius = animals[currentLevel].size / 2;
  createAnimal(currentLevel, dropX, radius + 12);

  // 落下音
  playSound(440, 0.16, "triangle");

  currentLevel = nextLevel;
  nextLevel = randomLevel();

  // 600ミリ秒後に次の動物を準備
  nextDropReadyTime = engine.timing.timestamp + 600;
}


// 合体処理
const mergingBodies = new Set();
const mergeQueue = [];

Events.on(engine, "collisionStart", (event) => {
  for (const pair of event.pairs) {
    const a = pair.bodyA;
    const b = pair.bodyB;

    if (
      a.animalLevel === undefined ||
      b.animalLevel === undefined
    ) continue;

    if (a.animalLevel !== b.animalLevel) continue;
    if (mergingBodies.has(a.id) || mergingBodies.has(b.id)) continue;

    mergingBodies.add(a.id);
    mergingBodies.add(b.id);

    mergeQueue.push({
      a,
      b,
      level: a.animalLevel
    });
  }
});

// 衝突判定後に合体を実行
Events.on(engine, "afterUpdate", () => {
  while (mergeQueue.length > 0) {
    const { a, b, level } = mergeQueue.shift();

    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;

    Composite.remove(engine.world, a);
    Composite.remove(engine.world, b);

    if (level < animals.length - 1) {
      createAnimal(level + 1, x, y);
    } else {
      // ヘラジカ同士が合体したとき
      showFinalCelebration();
    }

    // 合体した動物のレベルに応じて加点
    score += (level + 1) * 10;
    scoreDisplay.textContent = score;
    // ベスト（端末全体）は、ゲームオーバーのときだけ確定する（プレイ中は更新しない）

    mergingBodies.delete(a.id);
    mergingBodies.delete(b.id);
  }
});

// 操作

 // 操作
let isDragging = false;

board.addEventListener("pointerdown", (event) => {
  if (!isGameStarted || isGameOver || isPaused) return;

  isDragging = true;
  moveAnimal(event.clientX);
  board.setPointerCapture(event.pointerId);
});

board.addEventListener("pointermove", (event) => {
  if (!isGameStarted || isGameOver || isPaused) return;

  // マウスでは、指を押していなくても左右に動かせる
  if (event.pointerType === "mouse" || isDragging) {
    moveAnimal(event.clientX);
  }
});

board.addEventListener("pointerup", (event) => {
  if (!isDragging) return;

  isDragging = false;
  if (isGameOver || isPaused) return;

  moveAnimal(event.clientX);
  dropAnimal();
});

board.addEventListener("pointercancel", () => {
  isDragging = false;
});


// 初期化
currentLevel = randomLevel();
nextLevel = randomLevel();
updatePreview();
preview.style.display = "none"; // ゲーム開始まで非表示

/* STEP 6：動物の顔を描画する */

// Matter.jsの描画が終わったあとに実行
Events.on(render, "afterRender", () => {
  const ctx = render.context;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ゲーム内にあるすべての動物を取得
  const bodies = Composite.allBodies(engine.world);

  for (const body of bodies) {
    // 壁や床は対象外
    if (body.animalLevel === undefined) continue;

    const data = animals[body.animalLevel];

    ctx.save();

    // 動物の中心へ移動
    ctx.translate(body.position.x, body.position.y);

    // 動物の回転に合わせる
    ctx.rotate(body.angle);

    // 動物の大きさに合わせて絵文字も拡大
    ctx.font = `${Math.round(data.size * 0.55)}px sans-serif`;

    const image = animalImages[body.animalLevel];

    if (image && image.complete && image.naturalWidth > 0) {

      ctx.save();

      // 動物の輪郭に沿った、ごく薄い白い光
      ctx.shadowColor = "rgba(255, 255, 255, 0.7)";
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // 動物の画像は1回だけ描画
      ctx.drawImage(
        image,
        -data.size / 2,
        -data.size / 2,
        data.size,
        data.size
      );

      ctx.restore();
      
    } else {
      ctx.fillText(data.emoji, 0, 2);
    }

    ctx.restore();
  }

  ctx.restore();
});

/* STEP 7：ゲームオーバー判定 */

// HTML要素を取得
const dangerMessage =
  document.getElementById("danger-message");

const gameOverScreen =
  document.getElementById("game-over-screen");

const finalScore =
  document.getElementById("final-score");

const retryButton =
  document.getElementById("retry-button");

// 危険ラインの位置
const dangerY = 65;

// ゲームの状態
let isGameOver = false;
let dangerStartTime = null;

// 5秒の猶予
const dangerDuration = 5000;

// 積み上がりを監視
Events.on(engine, "afterUpdate", () => {
  if (isGameOver) return;

  const bodies = Composite.allBodies(engine.world);

  // 落とした直後の動物は判定しない
  // 静止に近い動物だけを確認

  const isDanger = bodies.some((body) => {
    if (body.animalLevel === undefined) return false;

    // 落下・合体直後の1秒間は判定しない
    if (Date.now() - body.createdAt < 1000) {
      return false;
    }

    const top = body.bounds.min.y;

    return (
      top < dangerY &&
      body.speed < 1.5
    );
  });

  if (isDanger) {
    if (dangerStartTime === null) {
      dangerStartTime = engine.timing.timestamp;
    }

    const elapsed = engine.timing.timestamp - dangerStartTime;
    const remaining = Math.max(
      0,
      Math.ceil((dangerDuration - elapsed) / 1000)
    );

    dangerMessage.style.display = "block";
    dangerMessage.textContent =
      `⚠ あと ${remaining} 秒！`;

    if (elapsed >= dangerDuration) {
      endGame();
    }
  } else {
    dangerStartTime = null;
    dangerMessage.style.display = "none";
  }
});

// ゲームオーバー処理
function endGame() {
  if (isGameOver) return;

  isGameOver = true;
  canDrop = false;

  preview.style.display = "none";
  dangerMessage.style.display = "none";

  finalScore.textContent = score;
  gameOverScreen.style.display = "flex";

  Runner.stop(runner);

  // BGMを停止
  bgm.pause();
  bgm.currentTime = 0;

  // 通常のゲームオーバーのとき、自己ベスト（端末全体）を確定・保存する
  updateHighScore();

  // ランキング機能などが結果を受け取るためのイベント
  document.dispatchEvent(new CustomEvent("game:over", {
    detail: { score, highScore }
  }));
}

// 盤面の動物・状態をすべて片付ける（物理演算は止めたまま）
function clearGameState() {
  Runner.stop(runner);
  overlayHolds = 0;   // 開いていた確認画面・進化一覧の「停止中」の記憶を、リセット

  for (const body of Composite.allBodies(engine.world)) {
    if (body.animalLevel !== undefined) {
      Composite.remove(engine.world, body);
    }
  }

  mergeQueue.length = 0;
  mergingBodies.clear();

  score = 0;
  lastSoundScore = 0;
  scoreDisplay.textContent = score;

  isGameOver = false;
  isPaused = false;
  isDragging = false;
  canDrop = false;
  dangerStartTime = null;
  nextDropReadyTime = null;

  dangerMessage.style.display = "none";
  gameOverScreen.style.display = "none";
  preview.style.display = "none";
  pauseButton.textContent = "Ⅱ ポーズ";

  board.querySelectorAll(".final-celebration")
    .forEach((element) => element.remove());

  bgm.pause();
  bgm.currentTime = 0;
}

// ゲームを最初から始める（開始・リトライ共通）
function resetGame() {
  clearGameState();

  currentLevel = randomLevel();
  nextLevel = randomLevel();
  dropX = boardWidth / 2;
  canDrop = true;
  updatePreview();
  preview.style.display = "flex";

  isGameStarted = true;
  Runner.run(runner, engine);
  playBgm();
}

// タイトル画面へ戻る
function exitToTitle() {
  isGameStarted = false;
  clearGameState();
}

// リトライ
retryButton.addEventListener("click", resetGame);

/* 確認画面・進化一覧を開いている間、ゲームを止める
   もともと一時停止中だったときは、閉じても、一時停止のままにする */
let overlayHolds = 0;
let pausedBeforeOverlay = false;

function holdPause() {
  if (!isGameStarted || isGameOver) return false;

  if (overlayHolds === 0) {
    pausedBeforeOverlay = isPaused;
    if (!isPaused) togglePause();
  }

  overlayHolds += 1;
  return true;
}

function releasePause() {
  if (overlayHolds === 0) return;

  overlayHolds -= 1;

  if (overlayHolds === 0 && !pausedBeforeOverlay && isPaused) togglePause();
}

// 動物の進化順（小さい順）。「しんか」画面は、ここから表示する（ステージが増えても、ここだけ変えればよい）
function getEvolutionChain() {
  return animals.map((animal, index) => ({
    name: animal.name,
    image: animalImageFiles[index] ? `assets/images/${animalImageFiles[index]}` : null,
    emoji: animal.emoji
  }));
}

window.DoubutsuGame = {
  start: resetGame,
  exitToTitle,
  isStarted: () => isGameStarted,
  holdPause,
  releasePause,
  getEvolutionChain
};

/* 開発用：Gキーでゲームオーバーをテスト（ローカルの ?debug=1 のみ） */

document.addEventListener("keydown", (event) => {
  if (!debugMode) return;

  if (event.key.toLowerCase() === "g" && isGameStarted && !isGameOver) {
    endGame();
  }
});

/* =====================================
   STEP 8：BGM・効果音・ポーズ
===================================== */

// ボタンとBGM
const bgm = document.getElementById("bgm");
const bgmButton = document.getElementById("bgm-button");
const pauseButton = document.getElementById("pause-button");

let bgmEnabled = true;
let isPaused = false;

// BGMの音量
bgm.volume = 0.35;

// BGMを再生
function playBgm() {
  if (!isGameStarted || !bgmEnabled || isPaused || isGameOver) return;

  bgm.play().catch(() => {
    // ブラウザの自動再生制限がある場合は
    // 最初の操作時に再生する
  });
}

// BGMのON/OFF
bgmButton.addEventListener("click", () => {
  bgmEnabled = !bgmEnabled;

  if (bgmEnabled) {
    bgmButton.textContent = "♫ BGM ON";
    playBgm();
  } else {
    bgmButton.textContent = "♫ BGM OFF";
    bgm.pause();
  }
});

bgmButton.textContent = "♫ BGM ON";

// 最初のクリック・タップでBGM再生
board.addEventListener("pointerdown", () => {
  playBgm();
});

// 効果音を作る
let audioContext = null;

function playSound(frequency, duration, type = "sine") {
  if (!bgmEnabled || isPaused || isGameOver) return;

  try {
    if (!audioContext) {
      audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
    }

    if (audioContext.state === "suspended") {
      audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = type;
    oscillator.frequency.value = frequency;

    gain.gain.setValueAtTime(
      0.35,
      audioContext.currentTime
    );

    gain.gain.exponentialRampToValueAtTime(
      0.001,
      audioContext.currentTime + duration
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start();
    oscillator.stop(
      audioContext.currentTime + duration
    );
  } catch (error) {
    console.log("効果音を再生できませんでした", error);
  }
}

// 合体したときの効果音
Events.on(engine, "afterUpdate", () => {
  if (isPaused || isGameOver) return;

  // スコアが増えたら合体音を鳴らす
  if (score > lastSoundScore) {

    // 合体したときの効果音（キラキラ3音）
    playSound(784, 0.25, "sine");

    setTimeout(() => {
      playSound(1175, 0.28, "sine");
    }, 70);

    setTimeout(() => {
      playSound(1568, 0.35, "sine");
    }, 140);

    lastSoundScore = score;
  }
});

let lastSoundScore = score;

// ポーズ処理
function togglePause() {
  if (!isGameStarted || isGameOver) return;

  isPaused = !isPaused;

  if (isPaused) {
    Runner.stop(runner);
    bgm.pause();

    pauseButton.textContent = "▶ さいかい";
  } else {
    Runner.run(runner, engine);

    pauseButton.textContent = "Ⅱ ポーズ";
    playBgm();
  }
}

pauseButton.addEventListener("click", togglePause);

/* STEP 9：ゲーム内時間で次の動物を準備 */

Events.on(engine, "afterUpdate", () => {
  if (isPaused || isGameOver) return;
  if (nextDropReadyTime === null) return;

  if (engine.timing.timestamp >= nextDropReadyTime) {
    const radius = animals[currentLevel].size / 2;

    dropX = Math.max(
      radius,
      Math.min(boardWidth - radius, dropX)
    );

    updatePreview();
    preview.style.display = "flex";

    canDrop = true;
    nextDropReadyTime = null;
  }
});


/* STEP 16：最終進化の特別演出 */

function showFinalCelebration() {
  const boardElement = board;
  if (!boardElement) return;

  // 以前の演出が残っていたら削除
  boardElement.querySelectorAll(".final-celebration")
    .forEach((element) => element.remove());

  const celebration = document.createElement("div");
  celebration.className = "final-celebration";

  celebration.innerHTML = `
    <div class="celebration-sparkles">✨ 🌟 ✨</div>
    <div class="celebration-message">おめでとう！</div>
    <div class="celebration-subtitle">ヘラジカ だいせいこう！</div>
  `;

  boardElement.appendChild(celebration);

  setTimeout(() => {
    celebration.remove();
  }, 2200);
}

/* 開発用：数字キーで動物を直接出す */

document.addEventListener("keydown", (event) => {
  if (!debugMode || !isGameStarted) return;

  const level = Number(event.key) - 1;

  if (
    level < 0 ||
    level >= animals.length ||
    !Number.isInteger(level) ||
    isGameOver
  ) return;

  const size = animals[level].size;
  const x = boardWidth / 2;

  createAnimal(level, x, size / 2 + 12);

  console.log(
    "テスト生成:",
    animals[level].name
  );
});
