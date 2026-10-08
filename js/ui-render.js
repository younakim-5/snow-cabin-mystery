/* =========================================================
   화면 렌더링
   -----------------------------------------------------------
   Firestore에서 받은 state를 받아 각 스테이지의 DOM을
   채워넣는 함수들. 실제 클릭 이벤트 연결은 main.js에서 한다.
   ========================================================= */

function el(id) {
  return document.getElementById(id);
}

function showOnlyStage(stageEl) {
  document.querySelectorAll(".stage").forEach((s) => s.classList.add("hidden"));
  stageEl.classList.remove("hidden");
}

function findCharacter(id) {
  return CHARACTERS.find((c) => c.id === id);
}

// 검거 결과를 보고 "누군가 검거를 선택했는가"와 "그 대상 이름들"을 계산한다.
// 여러 사람이 서로 다른 대상을 지목했다면 이름을 쉼표로 나열한다.
function getArrestOutcome(state, phaseKey) {
  const phaseNum = Number(String(phaseKey).replace("phase", ""));
  const config = ARREST[phaseNum];
  if (config && config.tieRevote) {
    // 다수결 판정 결과(검거된 한 명 또는 null=거부)를 그대로 쓴다.
    const winnerId = state.arrestWinnerTarget ? state.arrestWinnerTarget[phaseKey] : null;
    const winner = winnerId ? findCharacter(winnerId) : null;
    return { anyArrested: !!winnerId, targetNames: winner ? winner.name : (winnerId || "") };
  }

  const results = (state.arrestResults && state.arrestResults[phaseKey]) || {};
  const arrestEntries = Object.values(results).filter((r) => r.choice === "arrest");
  const anyArrested = arrestEntries.length > 0;

  const targetNames = [...new Set(arrestEntries.map((r) => r.target))]
    .map((id) => (findCharacter(id) ? findCharacter(id).name : id))
    .join(", ");

  return { anyArrested, targetNames };
}

// ---------------------------------------------------------
// 상단 바
// ---------------------------------------------------------
function renderTopBar(state) {
  const openingStages = new Set(["rules-basic", "rules-phase1", "opening", "character-select"]);
  if (openingStages.has(state.currentStage)) {
    el("phase-indicator").textContent = "오프닝";
  } else {
    const phaseNames = { 1: "1페이즈", 2: "2페이즈", 3: "3페이즈" };
    el("phase-indicator").textContent = phaseNames[state.currentPhase] || "";
  }

  const phaseNote = el("phase-note");
  const isInvestigation = state.currentStage.startsWith("investigation-");
  if (isInvestigation) {
    phaseNote.textContent = "단서를 사용하길 원하는 경우 반드시 전체 공개해야합니다";
    phaseNote.classList.remove("hidden");
  } else {
    phaseNote.textContent = "";
    phaseNote.classList.add("hidden");
  }

  let prefix = "⏱ ";
  let suffix = "";
  if (state.currentStage === "scenario" && (state.currentPhase === 1 || state.currentPhase === 2 || state.currentPhase === 3)) {
    prefix = `${state.currentPhase}페이즈 개인 시나리오 숙지 시간 (`;
    suffix = ") 남았습니다.";
  } else {
    const talkMatch = /^talk-(\d)$/.exec(state.currentStage);
    if (talkMatch) {
      prefix = `${talkMatch[1]}차 밀담 시간 (`;
      suffix = ") 남았습니다.";
    } else if (getTimedFreeRound(state)) {
      prefix = `${state.currentPhase}페이즈 조사 및 전체 토론 시간 (`;
      suffix = ") 남았습니다.";
    } else if (state.currentStage === "arrest") {
      prefix = "전체 토론 시간 (";
      suffix = ") 남았습니다. 토론 후 지목해주세요.";
    }
  }
  el("timer-prefix").textContent = prefix;
  el("timer-suffix").textContent = suffix;
}

function renderTimer(remainingSec) {
  const display = el("timer-display");
  if (remainingSec === null) {
    display.classList.add("hidden");
    return;
  }
  display.classList.remove("hidden");
  const m = Math.max(0, Math.floor(remainingSec / 60));
  const s = Math.max(0, Math.floor(remainingSec % 60));
  el("timer-value").textContent =
    String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// ---------------------------------------------------------
// 룰 설명 (기본 / 페이즈별 공용)
// ---------------------------------------------------------
const RULES_TITLES = {
  "rules-basic": "《한낮의 별에도 봄은 오는가》",
  "rules-phase1": "게임 준비 및 진행",
  "rules-phase1-progress": "1페이즈 진행 방법",
  "rules-phase2": "2페이즈 진행 방법",
  "rules-phase3": "3페이즈 진행 방법"
};
const RULES_KEY_BY_STAGE = {
  "rules-basic": "basic",
  "rules-phase1": "phase1",
  "rules-phase1-progress": "phase1Progress",
  "rules-phase2": "phase2",
  "rules-phase3": "phase3"
};

function renderRules(state) {
  showOnlyStage(el("stage-rules"));
  const ruleKey = RULES_KEY_BY_STAGE[state.currentStage];
  el("rules-title").textContent = RULES_TITLES[state.currentStage] || "게임 규칙";
  const ruleText = String(RULES[ruleKey] || "");
  const host = el("rules-text");
  host.replaceChildren();
  const headings = ruleKey === "basic"
    ? new Set(["개인 시나리오", "정보 공유", "거짓말", "추리와 메타 추리", "단서 확인 및 공유", "전체 공개", "강제 전체 공개", "시나리오의 지시", "정답과 진행", "게임의 목적"])
    : ruleKey === "phase1"
      ? new Set(["1. 오프닝 시나리오", "2. 캐릭터 선택", "3. 개인 시나리오 숙지 — 10분", "4. 단서 준비"])
    : ruleKey === "phase1Progress"
      ? new Set(["조사 규칙", "1차 조사", "1차 밀담 — 5분", "2차 조사", "2차 밀담 — 5분", "3차 조사", "3차 밀담 — 5분", "전체 토론 — 20분", "최종 추리"])
    : ruleKey === "phase2"
      ? new Set(["<2페이즈 준비>", "개인 시나리오 및 개인 상자 단서 확인 — 5분", "2페이즈 단서 배치", "<2페이즈 진행>", "전체 토론 — 10분", "조사 및 전체 토론 — 15분", "최종 추리"])
    : new Set(["<3페이즈 준비>", "개인 시나리오 확인 — 5분", "3페이즈 단서 배치", "<3페이즈 진행>", "조사 및 전체 토론 — 20분", "최종 추리"]);
  const warnings = new Set(["단서를 사용하길 원하는 경우 반드시 전체 공개해야 합니다.", "토론 시간이 종료되기 전에는 [최종 추리]의 내용을 확인하지 마세요."]);
  let previousWasHeading = false, spacerPending = false, contentCount = 0;
  ruleText.split("\n").forEach((line) => {
    const t = String(line).trim();
    if (!t) { spacerPending = true; return; }
    const isHeading = headings.has(t);
    const add = (cls, text) => { const d=document.createElement("div"); d.className=cls; if(text != null) d.textContent=text; host.appendChild(d); };
    if (ruleKey === "basic" && contentCount === 0 && t === "개인 시나리오") add("rule-first-spacer", "");
    const isProgressSection = (ruleKey === "phase2" && t === "<2페이즈 진행>") || (ruleKey === "phase3" && t === "<3페이즈 진행>");
    if (isProgressSection) add("rule-section-divider", "── ✦ ──");
    else if (spacerPending && !previousWasHeading) add("rule-spacer", "");
    spacerPending = false;
    let cls="rule-line";
    if (isHeading) {
      cls += " rule-heading";
      if ((ruleKey === "phase2" && (t === "<2페이즈 준비>" || t === "<2페이즈 진행>")) || (ruleKey === "phase3" && (t === "<3페이즈 준비>" || t === "<3페이즈 진행>"))) cls += " rule-section-heading";
    } else if (warnings.has(t)) cls += " rule-warning";
    add(cls, line);
    previousWasHeading=isHeading; contentCount++;
  });
  const readyList = state.readyPlayers[state.currentStage] || [];
  const totalPlayers = Object.values(state.characters).filter(Boolean).length || 4;
  el("rules-ready-status").textContent = `준비완료: ${readyList.length}/${totalPlayers}`;
  const already = isPlayerReady(state.readyPlayers, state.currentStage);
  el("rules-ready-btn").disabled = already;
  el("rules-ready-btn").textContent = already ? "준비완료 (대기 중)" : "준비완료";
}

function renderOpening(state, openingText) {
  showOnlyStage(el("stage-opening"));
  const openingTitle = el("stage-opening").querySelector(".stage-title");
  if (openingTitle) openingTitle.textContent = "오프닝 시나리오";
  el("opening-text").textContent = openingText;

  const readyList = state.readyPlayers["opening"] || [];
  const totalPlayers = Object.values(state.characters).filter(Boolean).length || 4;
  el("opening-ready-status").textContent = `준비완료: ${readyList.length}/${totalPlayers}`;

  const already = isPlayerReady(state.readyPlayers, "opening");
  el("opening-ready-btn").disabled = already;
  el("opening-ready-btn").textContent = already ? "준비완료 (대기 중)" : "준비완료";
}

// ---------------------------------------------------------
// 1. 캐릭터 선택
// ---------------------------------------------------------
let pendingCharacterId = null; // 프리뷰가 아니라 실제 게임에서도 "확인" 단계를 위한 로컬(미확정) 선택

function renderCharacterSelect(state) {
  showOnlyStage(el("stage-character-select"));

  const grid = el("character-grid");
  const statusEl = el("character-select-status");
  const confirmBox = el("character-confirm");

  // 이미 다른 사람이 먼저 그 캐릭터를 가져갔다면 내 대기 중이던 선택은 취소한다.
  if (pendingCharacterId && state.characters[pendingCharacterId]) {
    pendingCharacterId = null;
  }

  if (pendingCharacterId) {
    grid.classList.add("hidden");
    statusEl.classList.add("hidden");
    confirmBox.classList.remove("hidden");
    const character = findCharacter(pendingCharacterId);
    el("character-confirm-text").textContent = `${character.name}(으)로 선택하셨습니다. 이걸로 진행하시겠습니까?`;
    return;
  }

  confirmBox.classList.add("hidden");

  const myCharId = getLocalCharacterId();
  const gm = isLocalGM();

  // 이미 캐릭터를 고른 사람은 다른 캐릭터를 또 고를 수 없다 — 그리드 대신 대기 화면을 보여준다.
  const lockedBox = el("character-select-locked");
  if (!gm && myCharId && !state.characters[myCharId]) {
    // 방금 초기화 등으로 내 캐릭터가 사라진 예외 상황: 로컬 선택을 지우고 다시 고르게 한다.
    localStorage.removeItem(LOCAL_CHARACTER_KEY);
  }
  if (!gm && myCharId && state.characters[myCharId]) {
    grid.classList.add("hidden");
    statusEl.classList.add("hidden");
    lockedBox.classList.remove("hidden");
    const character = findCharacter(myCharId);
    el("character-select-locked-text").textContent =
      `당신은 ${character ? character.name : myCharId}입니다. 다른 사람들이 캐릭터를 고를 때까지 기다려주세요.`;
    const gmBtn2 = el("gm-observe-btn");
    if (gmBtn2) gmBtn2.classList.add("hidden");
    return;
  }
  lockedBox.classList.add("hidden");

  grid.classList.remove("hidden");
  statusEl.classList.remove("hidden");
  grid.innerHTML = "";

  const gmBtn = el("gm-observe-btn");
  const gmStatus = el("gm-observe-status");
  if (gmBtn) gmBtn.classList.toggle("hidden", gm);
  if (gmStatus) gmStatus.classList.toggle("hidden", !gm);

  CHARACTERS.forEach((c) => {
    const takenBy = state.characters[c.id];
    const card = document.createElement("button");
    card.className = "character-card";
    if (takenBy) card.classList.add("taken");
    if (myCharId === c.id) card.classList.add("mine");
    card.disabled = !!takenBy;
    card.dataset.characterId = c.id;

    card.innerHTML = `
      <span class="char-portrait"><img src="assets/characters/${c.id}.png" alt="${c.name}"${c.id === "yuseong" ? ' class="flip-x"' : ''}></span>
      <span class="char-name">${c.name}</span>
      <span class="char-bio">${c.bio}</span>
    `;
    grid.appendChild(card);
  });

  const pickedCount = Object.values(state.characters).filter(Boolean).length;
  statusEl.textContent = `${pickedCount}/4명 선택 완료`;
}

// ---------------------------------------------------------
// 2. 개인 시나리오
// ---------------------------------------------------------
let currentScenarioTabIndex = 0;
let lastRenderedScenarioPhase = null;
let scenarioReviewPhase = 1;
let scenarioReviewSection = 0;

// 이 기기의 캐릭터 id. 서버 상태(state.characters)를 우선으로 보고,
// 서버 기준 캐릭터가 확인되면 localStorage 값도 그에 맞춰 복구해둔다.
function getViewerCharId(state) {
  if (isLocalGM()) return null;
  const serverCharId = state ? myCharacterId(state, getLocalPlayerId()) : null;
  if (serverCharId) {
    if (getLocalCharacterId() !== serverCharId) setLocalCharacterId(serverCharId);
    return serverCharId;
  }
  // 서버에 이 기기(플레이어 id)가 등록되어 있지 않다면, 브라우저에 남은 캐릭터 값은 믿지 않는다.
  // (예전에는 이 값으로 버튼이 켜져서, 누르면 서버가 "차례가 아닙니다"로 거절하는 일이 생겼다.)
  if (state && Object.values(state.characters || {}).some(Boolean)) return null;
  return getLocalCharacterId();
}

// 캐릭터가 모두 정해졌는데 이 기기는 그중 누구로도 등록되어 있지 않은 경우
function isUnregisteredDevice(state) {
  return !isLocalGM() && !!state && allCharactersPicked(state.characters) && !getViewerCharId(state);
}
const UNREGISTERED_DEVICE_MSG = "이 기기(브라우저)는 캐릭터로 등록되어 있지 않아 단서를 선택할 수 없습니다. 처음에 캐릭터를 선택했던 기기·브라우저로 접속해주세요.";

function updateScenarioReviewButton(state) {
  const btn = el("my-scenario-btn");
  if (!btn) return;
  const hasCharacter = !!getViewerCharId(state);
  const pastSelection = !["rules-basic","rules-phase1","opening","character-select"].includes(state.currentStage);
  btn.classList.toggle("hidden", !(hasCharacter && pastSelection));
}

// 단서를 1장이라도 가지고 있으면 true
function hasAcquiredClue(state, charId) {
  return Object.values(state.clueClaims || {}).some((owner) => owner === charId);
}

function updateClueButtons(state) {
  const myBtn = el("my-clues-btn");
  const revBtn = el("revealed-clues-btn");
  if (!myBtn || !revBtn) return;
  if (isLocalGM()) {
    // GM은 자기 단서가 없으므로 [공개된 단서]만, 캐릭터 선택이 끝난 이후부터 보여준다.
    const anyAcquired = Object.values(state.clueClaims || {}).some(Boolean);
    const pastSelection = !["rules-basic", "rules-phase1", "opening", "character-select"].includes(state.currentStage);
    myBtn.classList.add("hidden");
    revBtn.classList.toggle("hidden", !(anyAcquired && pastSelection));
    return;
  }
  const charId = getViewerCharId(state);
  // 단서를 1장이라도 획득한 뒤부터 보인다.
  const show = !!charId && !!state.characters[charId] && hasAcquiredClue(state, charId);
  myBtn.classList.toggle("hidden", !show);
  revBtn.classList.toggle("hidden", !show);
}

// ---------------------------------------------------------
// 상단 [내 단서] / [공개된 단서] 팝업
// ---------------------------------------------------------
let clueListMode = null; // "mine" | "revealed" | null(닫힘)
let clueListPhase = 1;

function openClueListModal(mode) {
  if (!latestState) return;
  clueListMode = mode;
  clueListPhase = Math.max(1, Math.min(3, latestState.currentPhase || 1));
  renderClueListModal();
  el("clue-list-modal").classList.remove("hidden");
  el("clue-list-modal").setAttribute("aria-hidden", "false");
}

function closeClueListModal() {
  clueListMode = null;
  el("clue-list-modal").classList.add("hidden");
  el("clue-list-modal").setAttribute("aria-hidden", "true");
}

function renderClueListModal() {
  if (!clueListMode || !latestState) return;
  const state = latestState;
  const isMine = clueListMode === "mine";
  const myCharId = getViewerCharId(state);
  const revealedIds = state.revealedClueIds || [];

  el("clue-list-title").textContent = isMine ? "내 단서" : "공개된 단서";

  const maxPhase = Math.max(1, Math.min(3, state.currentPhase || 1));
  if (clueListPhase > maxPhase) clueListPhase = maxPhase;
  const tabs = el("clue-list-phase-tabs");
  tabs.innerHTML = "";
  if (maxPhase >= 2) {
    for (let phase = 1; phase <= maxPhase; phase++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab-btn" + (phase === clueListPhase ? " active" : "");
      b.textContent = `${phase}페이즈`;
      b.dataset.listPhase = phase;
      tabs.appendChild(b);
    }
  }
  const phase = maxPhase >= 2 ? clueListPhase : 1;

  const ids = isMine
    ? Object.keys(state.clueClaims || {}).filter((id) => state.clueClaims[id] === myCharId)
    : revealedIds.slice();
  const visibleIds = ids.filter((id) => getCluePhase(id) === phase);

  const body = el("clue-list-body");
  body.innerHTML = "";
  if (visibleIds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "revealed-cards-empty clue-list-empty";
    empty.textContent = isMine
      ? `${phase}페이즈에 가진 단서가 없습니다.`
      : `${phase}페이즈에 전체공개된 단서가 없습니다.`;
    body.appendChild(empty);
    return;
  }

  visibleIds.forEach((clueId) => {
    const info = findClueInfo(clueId);
    if (!info) return;
    const revealed = revealedIds.includes(clueId);
    const card = document.createElement("div");
    card.className = "revealed-card" + (isMine ? " mine-card" + (revealed ? " is-revealed" : "") : "");

    const meta = document.createElement("span");
    meta.className = "revealed-card-meta";
    if (isMine) {
      meta.textContent = info.roomName + (revealed ? " · 공개됨" : "");
    } else {
      const owner = findCharacter(state.clueClaims[clueId]);
      meta.textContent = info.roomName + (owner ? " · " + owner.name + " 소유" : "");
    }
    const label = document.createElement("span");
    label.className = "revealed-card-label";
    label.textContent = info.label;
    const text = document.createElement("span");
    text.className = "revealed-card-body";
    text.textContent = info.body;
    card.append(meta, label, text);

    if (isMine) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary-btn mine-card-reveal-btn";
      btn.dataset.revealClue = clueId;
      const r = getRevealButtonState(state, myCharId, clueId);
      btn.disabled = r.disabled;
      btn.textContent = r.text;
      card.appendChild(btn);
    }
    body.appendChild(card);
  });
}

// <전체 공개> 버튼 상태 — 페이즈마다 1인 1회
function getRevealButtonState(state, charId, clueId) {
  if ((state.revealedClueIds || []).includes(clueId)) return { disabled: true, text: "공개 완료" };
  if (getRevealUsedThisPhase(state, charId)) return { disabled: true, text: "이번 페이즈 공개 기회 사용함" };
  return { disabled: false, text: "전체공개 (페이즈당 1회)" };
}

function openScenarioReview() {
  if (!latestState || isLocalGM()) return;
  scenarioReviewPhase = Math.max(1, Math.min(3, latestState.currentPhase || 1));
  scenarioReviewSection = 0;
  renderScenarioReview();
  el("scenario-review-modal").classList.remove("hidden");
  el("scenario-review-modal").setAttribute("aria-hidden", "false");
}
function closeScenarioReview() {
  el("scenario-review-modal").classList.add("hidden");
  el("scenario-review-modal").setAttribute("aria-hidden", "true");
}
function renderScenarioReview() {
  const charId = getViewerCharId(latestState);
  const character = findCharacter(charId);
  const maxPhase = Math.max(1, Math.min(3, latestState.currentPhase || 1));
  if (scenarioReviewPhase > maxPhase) scenarioReviewPhase = maxPhase;
  const scenario = SCENARIOS[scenarioReviewPhase] && SCENARIOS[scenarioReviewPhase][charId];
  el("scenario-review-title").textContent = character ? `${character.name} — 개인 시나리오` : "내 시나리오";
  const phaseTabs = el("scenario-review-phase-tabs"); phaseTabs.innerHTML = "";
  for (let phase=1; phase<=maxPhase; phase++) {
    const b=document.createElement("button"); b.className="tab-btn"+(phase===scenarioReviewPhase?" active":""); b.textContent=`${phase}페이즈`;
    b.addEventListener("click",()=>{scenarioReviewPhase=phase;scenarioReviewSection=0;renderScenarioReview();}); phaseTabs.appendChild(b);
  }
  const sectionTabs=el("scenario-review-section-tabs"); sectionTabs.innerHTML="";
  if (!scenario || !scenario.sections || !scenario.sections.length) { el("scenario-review-body").textContent="이 페이즈의 시나리오가 없습니다."; return; }
  if (scenarioReviewSection >= scenario.sections.length) scenarioReviewSection=0;
  scenario.sections.forEach((sec,idx)=>{ const b=document.createElement("button"); b.className="tab-btn"+(idx===scenarioReviewSection?" active":""); b.textContent=sec.title; b.addEventListener("click",()=>{scenarioReviewSection=idx;renderScenarioReview();}); sectionTabs.appendChild(b); });
  el("scenario-review-body").innerHTML=formatScenarioBody(scenario.sections[scenarioReviewSection].body);
}

function formatScenarioBody(text) {
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  escaped = escaped
    .replace(/\{\{BU\}\}/g, "<strong><u>").replace(/\{\{\/BU\}\}/g, "</u></strong>")
    .replace(/\{\{B\}\}/g, "<strong>").replace(/\{\{\/B\}\}/g, "</strong>")
    .replace(/\{\{U\}\}/g, "<u>").replace(/\{\{\/U\}\}/g, "</u>");
  return escaped.replace(/\[[^\]\n]+\]/g, (match) => `<strong>${match}</strong>`);
}

function renderScenario(state) {
  showOnlyStage(el("stage-scenario"));

  if (isLocalGM()) {
    el("scenario-char-name").textContent = "GM 관전";
    el("scenario-tabs").innerHTML = "";
    el("scenario-body").textContent = `${state.currentPhase}페이즈 개인 시나리오 확인 중입니다. 4명의 플레이어가 준비 완료하면 자동으로 다음 화면으로 넘어갑니다.`;
    el("scenario-ready-status").textContent = "";
    el("scenario-ready-btn").classList.add("hidden");
    return;
  }
  el("scenario-ready-btn").classList.remove("hidden");
  const charId = getViewerCharId(state);
  const character = findCharacter(charId);
  const scenario = SCENARIOS[state.currentPhase] && SCENARIOS[state.currentPhase][charId];

  // 다른 페이즈에서 보던 탭 번호가 남아 있으면 없는 탭을 가리켜 화면이 멈출 수 있다.
  // (예: 1페이즈 8번째 탭을 보던 사람이 2페이즈(탭 2개)로 넘어온 경우)
  if (lastRenderedScenarioPhase !== state.currentPhase) {
    currentScenarioTabIndex = 0;
    lastRenderedScenarioPhase = state.currentPhase;
  }
  if (scenario && currentScenarioTabIndex >= scenario.sections.length) currentScenarioTabIndex = 0;

  el("scenario-char-name").textContent = character ? character.name : "-";

  if (!scenario) {
    el("scenario-body").textContent = "이 캐릭터의 시나리오가 아직 준비되지 않았습니다.";
    el("scenario-tabs").innerHTML = "";
    return;
  }

  const tabsEl = el("scenario-tabs");
  tabsEl.innerHTML = "";
  scenario.sections.forEach((section, idx) => {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (idx === currentScenarioTabIndex ? " active" : "");
    btn.textContent = section.title;
    btn.dataset.tabIndex = idx;
    tabsEl.appendChild(btn);
  });

  el("scenario-body").innerHTML = formatScenarioBody(scenario.sections[currentScenarioTabIndex].body);

  const stageKey = "scenario-" + state.currentPhase;
  const readyList = state.readyPlayers[stageKey] || [];
  const totalPlayers = Object.values(state.characters).filter(Boolean).length || 4;
  el("scenario-ready-status").textContent = `준비완료: ${readyList.length}/${totalPlayers}`;

  const already = isPlayerReady(state.readyPlayers, stageKey);
  el("scenario-ready-btn").disabled = already;
  el("scenario-ready-btn").textContent = already ? "준비완료 (대기 중)" : "준비완료";
}

// ---------------------------------------------------------
// 3. 단서 조사 (1페이즈: 턴제 / 2페이즈: 자유 조사) 공용 헬퍼
// ---------------------------------------------------------
let currentInvestigationRoomIndex = 0;

// 4명을 화면 4분할 자리에 고정 배치 (좌상/우상/좌하/우하)
const QUADRANT_ORDER = ["tl", "tr", "bl", "br"];
const QUADRANT_CHARACTER_IDS = ["saebom", "jueun", "donggyeong", "yuseong"];

// 각자 지금까지 획득한 단서를 4분할 보드에 그려넣는다.
const quadrantPhaseView = {};

function getCluePhase(clueId) {
  for (const phaseKey of Object.keys(CLUES)) {
    for (const room of CLUES[phaseKey].rooms) {
      if (room.items.some((item) => item.id === clueId)) return Number(phaseKey);
    }
  }
  if (clueId.startsWith("p2-")) return 2;
  if (clueId.startsWith("p3-")) return 3;
  return 1;
}

// 이 기기(플레이어)가 해당 단서의 내용을 볼 수 있는지.
// 본인 소유 단서 / 전체공개된 단서 / GM만 열람 가능.
function canViewClue(state, clueId) {
  if (!state) return false;
  if (isLocalGM()) return true;
  if ((state.revealedClueIds || []).includes(clueId)) return true;
  const viewerCharId = getViewerCharId(state);
  return !!viewerCharId && state.clueClaims[clueId] === viewerCharId;
}

function renderQuadrants(board, state, activeCharId) {
  QUADRANT_CHARACTER_IDS.forEach((characterId, idx) => {
    const character = CHARACTERS.find((c) => c.id === characterId);
    const quadrant = document.createElement("div");
    quadrant.className = "quadrant " + QUADRANT_ORDER[idx] + (character.id === activeCharId ? " active" : "");

    const nameEl = document.createElement("span");
    nameEl.className = "quadrant-name";
    nameEl.textContent = character.name;
    if (character.id === activeCharId && /^investigation-r\d$/.test(state.currentStage)) {
      const prompt = document.createElement("span");
      prompt.className = "turn-prompt";
      prompt.textContent = "단서 카드 1장을 선택하세요";
      nameEl.appendChild(prompt);
    }
    quadrant.appendChild(nameEl);

    const myClaims = Object.entries(state.clueClaims).filter(([, charId]) => charId === character.id);
    const maxPhase = Math.max(1, Math.min(3, state.currentPhase || 1));
    if (maxPhase >= 2) {
      if (!quadrantPhaseView[character.id] || quadrantPhaseView[character.id] > maxPhase) quadrantPhaseView[character.id] = maxPhase;
      const tabs = document.createElement("div");
      tabs.className = "claim-phase-tabs";
      for (let phase = 1; phase <= maxPhase; phase++) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "claim-phase-tab" + (quadrantPhaseView[character.id] === phase ? " active" : "");
        tab.textContent = `${phase}페이즈`;
        tab.addEventListener("click", () => { quadrantPhaseView[character.id] = phase; render(latestState); });
        tabs.appendChild(tab);
      }
      quadrant.appendChild(tabs);
    }

    const visiblePhase = maxPhase >= 2 ? (quadrantPhaseView[character.id] || maxPhase) : 1;
    const visibleClaims = myClaims.filter(([clueId]) => getCluePhase(clueId) === visiblePhase);
    if (visibleClaims.length === 0) {
      const empty = document.createElement("span");
      empty.className = "quadrant-empty";
      empty.textContent = `${visiblePhase}페이즈에 획득한 단서가 없습니다.`;
      quadrant.appendChild(empty);
    } else {
      visibleClaims.forEach(([clueId]) => {
        const info = findClueInfo(clueId);
        const revealed = (state.revealedClueIds || []).includes(clueId);
        const viewable = canViewClue(state, clueId);
        const entry = document.createElement("button");
        entry.type = "button";
        entry.className = "claim-entry" + (viewable ? "" : " private");
        entry.innerHTML = `<span class="claim-meta">${info ? info.roomName : ""}${revealed ? " · 공개됨" : ""}</span>`;
        if (viewable) {
          entry.addEventListener("click", () => openClaimedClueModal(clueId));
        } else {
          entry.disabled = true;
          entry.title = "다른 사람이 획득한 단서입니다.";
        }
        quadrant.appendChild(entry);
      });
    }
    board.appendChild(quadrant);
  });
}

// 전체 공개된 카드 목록을 그려넣는다 (내용까지 바로 보임).
function renderRevealedCards(state) {
  const listEl = el("revealed-cards-list");
  listEl.innerHTML = "";

  const revealedIds = state.revealedClueIds || [];
  if (revealedIds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "revealed-cards-empty";
    empty.textContent = "아직 전체공개된 카드가 없습니다.";
    listEl.appendChild(empty);
    return;
  }

  revealedIds.forEach((clueId) => {
    const info = findClueInfo(clueId);
    if (!info) return;
    const ownerCharId = state.clueClaims[clueId];
    const ownerChar = findCharacter(ownerCharId);

    const card = document.createElement("div");
    card.className = "revealed-card";
    card.innerHTML = `
      <span class="revealed-card-meta">${info.roomName}${ownerChar ? " · " + ownerChar.name + " 소유" : ""}</span>
      <span class="revealed-card-label">${info.label}</span>
      <span class="revealed-card-body">${info.body}</span>
    `;
    listEl.appendChild(card);
  });
}

function openClaimedClueModal(clueId) {
  const info = findClueInfo(clueId);
  if (!info) return;

  // 본인 것이 아니고 공개되지도 않은 단서는 열지 않는다.
  if (!canViewClue(latestState, clueId)) return;

  const myCharId = getViewerCharId(latestState);
  const ownerCharId = latestState ? latestState.clueClaims[clueId] : null;

  el("clue-modal-title").textContent = `${info.roomName} — ${info.label}`;
  el("clue-modal-body").textContent = info.body;

  // 내가 소유한 단서라면 <전체공개> 버튼을 보여준다. 페이즈마다 1회만 쓸 수 있다.
  const revealBtn = el("clue-reveal-btn");
  const isMine = !!myCharId && myCharId === ownerCharId;
  revealBtn.classList.toggle("hidden", !isMine);
  const r = getRevealButtonState(latestState, myCharId, clueId);
  revealBtn.disabled = r.disabled;
  revealBtn.textContent = r.text;
  revealBtn.dataset.clueId = clueId;

  el("clue-modal").classList.remove("hidden");
}

function closeClueModal() {
  el("clue-modal").classList.add("hidden");
}

// ---------------------------------------------------------
// 3-A. 1페이즈: 턴제 조사
// ---------------------------------------------------------
// opts.discussion = true 이면 같은 레이아웃을 "전체 토론" 화면으로 쓴다 (단서 선택 불가).
function renderInvestigation(state, opts = {}) {
  showOnlyStage(el("stage-investigation"));
  const discussionMode = !!opts.discussion;
  renderInvestigationDoneRow(state, discussionMode);

  const match = /^investigation-r(\d)$/.exec(state.currentStage);
  const round = match ? Number(match[1]) : 1;
  el("investigation-title").textContent = discussionMode ? "전체 토론" : `${round}차 조사`;

  const sequence = discussionMode ? [] : getRoundSequence(state.currentPhase, round);
  const turnIndex = state.investigationTurnIndex || 0;
  const currentTurnCharId = discussionMode ? null : sequence[turnIndex];
  const myCharId = getViewerCharId(state);

  // 내 차례인데 자기 방 말고는 남은 단서가 없으면 자기 방 단서를 고를 수 있게 풀어준다.
  const isMyTurnNow = !discussionMode && !!myCharId && myCharId === currentTurnCharId;
  const ownRoomAllowed = isMyTurnNow && !hasSelectableClueOutsideOwnRoom(state, myCharId);

  el("investigation-turn-indicator").textContent = isUnregisteredDevice(state)
    ? UNREGISTERED_DEVICE_MSG
    : ownRoomAllowed
    ? "선택할 수 있는 다른 단서가 남아 있지 않아, 이번에는 자신의 방 단서를 선택할 수 있습니다."
    : "";
  el("investigation-turn-indicator").className = "scenario-text";

  const board = el("investigation-board");
  board.innerHTML = "";
  board.classList.toggle("phase2-compact", state.currentPhase === 2);
  renderQuadrants(board, state, currentTurnCharId);

  // 중앙: 방 탭 + 이번 라운드 대상 단서 A/B/C 버튼
  const center = document.createElement("div");
  center.className = "clue-center";

  const roomTabs = document.createElement("nav");
  roomTabs.className = "tab-row secondary";
  const phaseData = CLUES[state.currentPhase];
  phaseData.rooms.forEach((room, idx) => {
    const unlocked = isRoomUnlocked(room.id, state.revealedClueIds || []);
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (idx === currentInvestigationRoomIndex ? " active" : "") + (!unlocked ? " locked" : "");
    btn.textContent = room.name + (!unlocked ? " (잠김)" : "");
    btn.dataset.roomIndex = idx;
    roomTabs.appendChild(btn);
  });

  const letterRow = document.createElement("div");
  letterRow.className = "letter-row";
  const room = phaseData.rooms[currentInvestigationRoomIndex];
  const roomUnlocked = isRoomUnlocked(room.id, state.revealedClueIds || []);
  if (!roomUnlocked) {
    const lockedMsg = document.createElement("p");
    lockedMsg.className = "revealed-cards-empty";
    lockedMsg.textContent = room.lockedMessage || "아직 열 수 없는 곳입니다.";
    letterRow.appendChild(lockedMsg);
  } else room.items.forEach((item, idx) => {
    const letter = String.fromCharCode(65 + idx);
    const claimed = !!state.clueClaims[item.id];
    const isMyTurn = myCharId === currentTurnCharId;
    const isOwnRoom = ROOM_OWNER[room.id] === myCharId && !ownRoomAllowed;

    const btn = document.createElement("button");
    btn.className = "letter-btn";
    btn.textContent = letter;
    btn.dataset.clueId = item.id;
    btn.disabled = discussionMode || claimed || !isMyTurn || isOwnRoom;
    letterRow.appendChild(btn);
  });

  center.appendChild(roomTabs);
  center.appendChild(letterRow);
  board.appendChild(center);

  renderRevealedCards(state);
}

// ---------------------------------------------------------
// 3-B. 2·3페이즈: 조사 및 전체 토론 (순서/자기 방 제한 없음, 잠긴 장소 있음)
// ---------------------------------------------------------
function getFreePickCount(state, charId) {
  const stageCounts = ((state.freePickCounts || {})[state.currentStage] || {});
  return stageCounts[charId] || 0;
}

function renderInvestigationFree(state, opts = {}) {
  showOnlyStage(el("stage-investigation"));
  const discussionMode = !!opts.discussion;
  renderInvestigationDoneRow(state, discussionMode || !!getTimedFreeRound(state));

  const roundConfig = (FREE_PICK_ROUNDS[state.currentPhase] || []).find(
    (r) => r.stage === state.currentStage
  );
  const picksPerPerson = roundConfig ? roundConfig.picksPerPerson : 2;

  el("investigation-title").textContent = discussionMode ? "전체 토론" : "조사 및 전체 토론";

  const myCharId = getViewerCharId(state);
  const myCount = getFreePickCount(state, myCharId);
  el("investigation-turn-indicator").textContent = isUnregisteredDevice(state)
    ? UNREGISTERED_DEVICE_MSG
    : discussionMode
    ? ""
    : `조사와 토론을 함께 진행합니다. 원하는 단서를 선택하세요. (나: ${myCount}/${picksPerPerson} 획득)\n시간이 끝나거나 4명 모두 [완료]를 누르면 최종 추리로 넘어갑니다.`;
  el("investigation-turn-indicator").className = "scenario-text";

  const board = el("investigation-board");
  board.innerHTML = "";
  board.classList.add("phase2-compact");
  renderQuadrants(board, state, null);

  const center = document.createElement("div");
  center.className = "clue-center";

  const pickableRoomIds = FREE_INVESTIGATION_ROOMS[state.currentPhase] || [];
  const phaseData = CLUES[state.currentPhase];
  const pickableRooms = phaseData ? phaseData.rooms.filter((r) => pickableRoomIds.includes(r.id)) : [];

  const roomTabs = document.createElement("nav");
  roomTabs.className = "tab-row secondary";
  pickableRooms.forEach((room, idx) => {
    const unlocked = isRoomUnlocked(room.id, state.revealedClueIds || []);
    const btn = document.createElement("button");
    btn.className = "tab-btn" +
      (idx === currentInvestigationRoomIndex ? " active" : "") +
      (!unlocked ? " locked" : "");
    btn.textContent = room.name + (!unlocked ? " (잠김)" : "");
    btn.dataset.roomIndex = idx;
    roomTabs.appendChild(btn);
  });

  const letterRow = document.createElement("div");
  letterRow.className = "letter-row";
  const room = pickableRooms[currentInvestigationRoomIndex] || pickableRooms[0];

  if (!room) {
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "revealed-cards-empty";
    emptyMsg.textContent = "이번 페이즈의 조사 단서가 아직 준비되지 않았습니다.";
    letterRow.appendChild(emptyMsg);
  } else {
    const roomLocked = !isRoomUnlocked(room.id, state.revealedClueIds || []);
    if (roomLocked) {
      const lockedMsg = document.createElement("p");
      lockedMsg.className = "revealed-cards-empty";
      lockedMsg.textContent = room.lockedMessage || "아직 열 수 없는 곳입니다.";
      letterRow.appendChild(lockedMsg);
    } else {
      room.items.forEach((item, idx) => {
        const letter = String.fromCharCode(65 + idx);
        const claimed = !!state.clueClaims[item.id];
        const reachedLimit = myCount >= picksPerPerson;

        const btn = document.createElement("button");
        btn.className = "letter-btn";
        btn.textContent = letter;
        btn.dataset.clueId = item.id;
        btn.disabled = discussionMode || claimed || reachedLimit;
        letterRow.appendChild(btn);
      });

      const allClaimedHere = room.items.every((item) => !!state.clueClaims[item.id]);
      if (allClaimedHere && !discussionMode) {
        const hint = document.createElement("p");
        hint.className = "revealed-cards-empty";
        hint.style.marginTop = "10px";
        hint.textContent = "이 방의 단서를 모두 획득했습니다. 다른 방을 확인하거나, 잠긴 장소를 열 수 있는 단서를 공개했는지 확인해보세요.";
        letterRow.appendChild(hint);
      }
    }
  }

  center.appendChild(roomTabs);
  center.appendChild(letterRow);
  board.appendChild(center);

  renderRevealedCards(state);
}

// ---------------------------------------------------------
// 3-1 / 3-2. 밀담 / 전체 토론
// ---------------------------------------------------------
// 밀담 / 전체 토론 스테이지인지 (= [대화 완료] 버튼이 붙는 스테이지)
function isTalkOrDiscussionStage(stage) {
  return /^talk-\d$/.test(stage) || Object.prototype.hasOwnProperty.call(DISCUSSION_STAGES, stage);
}

// 타이머가 걸린 자유 조사 라운드 설정 (없으면 null)
function getTimedFreeRound(state) {
  const round = (FREE_PICK_ROUNDS[state.currentPhase] || []).find((r) => r.stage === state.currentStage);
  return round && round.durationSec ? round : null;
}

// 4명이 버튼을 눌러 일찍 넘길 수 있는 스테이지 (밀담 / 전체 토론 / 타이머 있는 자유 조사)
function isSkippableStage(state) {
  return isTalkOrDiscussionStage(state.currentStage) || !!getTimedFreeRound(state);
}

// 조사 레이아웃으로 그리는 전체 토론 스테이지
const BOARD_DISCUSSION_STAGES = new Set(["discussion", "discussion-pre"]);

// 화면에 있는 모든 [대화 완료] 버튼/상태 문구를 현재 상태에 맞춘다.
function updateTalkDoneControls(state) {
  const stageKey = state.currentStage;
  const readyList = state.readyPlayers[stageKey] || [];
  const totalPlayers = Object.values(state.characters).filter(Boolean).length || 4;
  const already = isPlayerReady(state.readyPlayers, stageKey);
  const gm = isLocalGM();
  const label = getTimedFreeRound(state) ? "완료" : "대화 완료";
  document.querySelectorAll(".talk-done-btn").forEach((btn) => {
    btn.classList.toggle("hidden", gm);
    btn.disabled = already;
    btn.textContent = already ? `${label} (대기 중)` : label;
  });
  document.querySelectorAll(".talk-done-status").forEach((s) => {
    s.textContent = `${label}: ${readyList.length}/${totalPlayers}`;
  });
}

function renderInvestigationDoneRow(state, show) {
  el("investigation-done-row").classList.toggle("hidden", !show);
  if (show) updateTalkDoneControls(state);
}

function renderTalk(state) {
  showOnlyStage(el("stage-talk"));
  const match = /^talk-(\d)$/.exec(state.currentStage);
  const round = match ? Number(match[1]) : 1;
  el("talk-title").textContent = `${round}차 밀담`;
  el("talk-text").textContent = TALK_TEXTS[round] || "";
  renderTalkTransfer(state);
  updateTalkDoneControls(state);
}

// 밀담 중 단서 양도 UI: 내 단서 목록 + 받을 사람 선택 + [양도] 버튼
let selectedTransferClueId = null;
let selectedTransferTarget = null;

function renderTalkTransfer(state) {
  const host = el("talk-transfer");
  if (!host) return;
  host.innerHTML = "";
  const myCharId = getViewerCharId(state);
  if (isLocalGM() || !myCharId) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");

  const title = document.createElement("h3");
  title.className = "revealed-cards-title";
  title.textContent = "단서 양도";
  host.appendChild(title);

  const myClues = Object.keys(state.clueClaims || {}).filter(
    (id) => state.clueClaims[id] === myCharId && !isStartingClue(id)
  );
  if (selectedTransferClueId && !myClues.includes(selectedTransferClueId)) selectedTransferClueId = null;

  if (myClues.length === 0) {
    const empty = document.createElement("p");
    empty.className = "revealed-cards-empty";
    empty.textContent = "양도할 수 있는 단서가 없습니다.";
    host.appendChild(empty);
    return;
  }

  const clueRow = document.createElement("div");
  clueRow.className = "choice-row transfer-clue-row";
  myClues.forEach((id) => {
    const info = findClueInfo(id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice-btn" + (id === selectedTransferClueId ? " selected" : "");
    b.dataset.transferClue = id;
    b.textContent = info ? `${info.roomName} — ${info.label}` : id;
    clueRow.appendChild(b);
  });
  host.appendChild(clueRow);

  const targetRow = document.createElement("div");
  targetRow.className = "choice-row transfer-target-row";
  CHARACTERS.filter((c) => c.id !== myCharId).forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice-btn" + (c.id === selectedTransferTarget ? " selected" : "");
    b.dataset.transferTarget = c.id;
    b.textContent = `${c.name}에게`;
    targetRow.appendChild(b);
  });
  host.appendChild(targetRow);

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "primary-btn";
  submit.dataset.transferSubmit = "1";
  submit.disabled = !selectedTransferClueId || !selectedTransferTarget;
  submit.textContent = "양도하기";
  host.appendChild(submit);
}

function renderDiscussion(state) {
  // 1페이즈 전체 토론 / 2페이즈 첫 번째 전체 토론은 조사 화면 레이아웃 그대로 보여준다.
  if (BOARD_DISCUSSION_STAGES.has(state.currentStage)) {
    if (state.currentPhase === 1) renderInvestigation(state, { discussion: true });
    else renderInvestigationFree(state, { discussion: true });
    return;
  }
  showOnlyStage(el("stage-discussion"));
  const config = DISCUSSION_STAGES[state.currentStage];
  el("discussion-text").textContent = config ? config.text : "";
  updateTalkDoneControls(state);
}

// ---------------------------------------------------------
// 4. 검거
// ---------------------------------------------------------
let selectedArrestChoice = null;
let selectedArrestTarget = null;
const lastSeenRevoteCount = {}; // phaseKey -> 마지막으로 화면에서 본 재투표 횟수 (로컬 선택 초기화 판단용)

function renderArrest(state) {
  showOnlyStage(el("stage-arrest"));

  const phaseKey = "phase" + state.currentPhase;
  el("arrest-title").textContent = `시나리오 ${state.currentPhase}`;
  const config = ARREST[state.currentPhase];
  if (!config) return;

  el("arrest-prompt").textContent = config.prompt;
  el("arrest-instruction").textContent = config.instruction;

  // 동률로 인한 재투표라면, 라운드가 바뀐 시점에 내 로컬 선택도 함께 초기화한다.
  const revoteCount = (state.arrestRevoteCount && state.arrestRevoteCount[phaseKey]) || 0;
  const revoteNotice = el("arrest-revote-notice");
  const prevRevoteCount = lastSeenRevoteCount[phaseKey] || 0;
  if (revoteCount > prevRevoteCount) {
    selectedArrestChoice = null;
    selectedArrestTarget = null;
  }
  lastSeenRevoteCount[phaseKey] = revoteCount;

  const eligibleIds = state.arrestEligibleTargets && state.arrestEligibleTargets[phaseKey];

  const optionName = (id) => {
    if (id === "deny") return "거부";
    const t = config.targets && config.targets.find((x) => x.id === id);
    if (t) return t.name;
    const c = findCharacter(id);
    return c ? (config.tieRevote ? `${c.name} 검거` : c.name) : id;
  };

  if (revoteCount > 0 && eligibleIds) {
    const names = eligibleIds.map(optionName).join(", ");
    revoteNotice.textContent = `동률입니다. ${names} 중에서 다시 선택해주세요. (재투표 ${revoteCount}회차)`;
    revoteNotice.classList.remove("hidden");
  } else {
    revoteNotice.classList.add("hidden");
  }

  const choiceRow = el("arrest-choices");
  const targetRow = el("arrest-target-choices");
  let needsTarget;

  if (config.mode === "direct") {
    // 1페이즈와 달리 "검거/거부" 단계 없이, 대상 중 한 명을 바로 지목한다.
    choiceRow.innerHTML = "";
    choiceRow.classList.add("hidden");
    selectedArrestChoice = "accuse"; // 저장 형식(choice/target)을 그대로 재사용하기 위한 고정값

    needsTarget = true;
    targetRow.classList.remove("hidden");
    targetRow.innerHTML = "";
    const availableTargets = eligibleIds
      ? config.targets.filter((t) => eligibleIds.includes(t.id))
      : config.targets;
    availableTargets.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn" + (selectedArrestTarget === t.id ? " selected" : "");
      btn.textContent = t.name;
      btn.dataset.targetId = t.id;
      targetRow.appendChild(btn);
    });
  } else if (config.tieRevote && revoteCount > 0 && eligibleIds) {
    // 1페이즈 동률 재투표: "동경 검거 / 유성 검거 / 거부"처럼 한 줄에 바로 고른다.
    choiceRow.classList.remove("hidden");
    choiceRow.innerHTML = "";
    targetRow.classList.add("hidden");
    targetRow.innerHTML = "";
    needsTarget = selectedArrestChoice === "arrest";
    eligibleIds.forEach((id) => {
      const isDeny = id === "deny";
      const selected = isDeny
        ? selectedArrestChoice === "deny"
        : selectedArrestChoice === "arrest" && selectedArrestTarget === id;
      const btn = document.createElement("button");
      btn.className = "choice-btn" + (selected ? " selected" : "");
      btn.textContent = optionName(id);
      btn.dataset.choiceId = isDeny ? "deny" : "arrest";
      if (!isDeny) btn.dataset.targetId = id;
      choiceRow.appendChild(btn);
    });
  } else {
    choiceRow.classList.remove("hidden");
    choiceRow.innerHTML = "";
    config.choices.forEach((choice) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn" + (selectedArrestChoice === choice.id ? " selected" : "");
      btn.textContent = choice.label;
      btn.dataset.choiceId = choice.id;
      choiceRow.appendChild(btn);
    });

    needsTarget = config.choices.find((c) => c.id === selectedArrestChoice)?.needsTarget;
    if (needsTarget) {
      targetRow.classList.remove("hidden");
      targetRow.innerHTML = "";
      CHARACTERS.forEach((c) => {
        const btn = document.createElement("button");
        btn.className = "choice-btn" + (selectedArrestTarget === c.id ? " selected" : "");
        btn.textContent = c.name;
        btn.dataset.targetId = c.id;
        targetRow.appendChild(btn);
      });
    } else {
      targetRow.classList.add("hidden");
    }
  }

  const submissions = (state.arrestSubmissions && state.arrestSubmissions[phaseKey]) || {};
  const submittedPlayerIds = Object.keys(submissions);
  const myPlayerId = getLocalPlayerId();
  const iSubmitted = submittedPlayerIds.includes(myPlayerId);

  const totalPlayers = Object.values(state.characters).filter(Boolean).length || 4;
  el("arrest-submit-status").textContent = `제출: ${submittedPlayerIds.length}/${totalPlayers}`;

  const canSubmit = !!selectedArrestChoice && (!needsTarget || !!selectedArrestTarget);
  el("arrest-submit-btn").disabled = iSubmitted || !canSubmit;
  el("arrest-submit-btn").textContent = iSubmitted ? "제출 완료 (대기 중)" : "제출하기";
}

function renderArrestResult(state) {
  showOnlyStage(el("stage-arrest-result"));

  const phaseKey = "phase" + state.currentPhase;
  const results = (state.arrestResults && state.arrestResults[phaseKey]) || {};

  const listEl = el("arrest-result-list");
  listEl.innerHTML = "";

  Object.entries(state.characters).forEach(([charId, playerId]) => {
    if (!playerId) return;
    const character = findCharacter(charId);
    const result = results[playerId];
    const row = document.createElement("div");
    row.className = "result-row";
    const config = ARREST[state.currentPhase];
    if (result && config) {
      let resultText;
      if (config.mode === "direct") {
        const target = config.targets.find((t) => t.id === result.target);
        resultText = target ? target.name : result.target;
      } else {
        const choiceLabel = config.choices.find((c) => c.id === result.choice)?.label;
        resultText = choiceLabel || result.choice;
        if (result.target) {
          const targetChar = findCharacter(result.target);
          resultText += ` (${targetChar ? targetChar.name : result.target})`;
        }
      }
      row.innerHTML = `
        <span class="result-name">${character.name}</span>
        <span>${resultText}</span>
      `;
    } else {
      row.innerHTML = `
        <span class="result-name">${character.name}</span>
        <span>-</span>
      `;
    }
    listEl.appendChild(row);
  });

  // 최다 득표 결과 (이어질 시나리오를 결정)
  const winnerId = state.arrestWinnerTarget ? state.arrestWinnerTarget[phaseKey] : null;
  const config = ARREST[state.currentPhase] || {};
  let winnerName;
  if (winnerId) {
    const t = (config.targets || []).find((x) => x.id === winnerId);
    winnerName = t ? t.name : (findCharacter(winnerId) || {}).name || winnerId;
  }
  const summary = document.createElement("div");
  summary.className = "result-row result-summary";
  summary.innerHTML = `<span class="result-name">결과</span><span>${
    winnerName ? `최다 득표: ${winnerName}` : "모두 거부 — 아무도 지목하지 않았습니다."
  }</span>`;
  listEl.appendChild(summary);
}


// ---------------------------------------------------------
// 4-2. 진행 시나리오 (A~M, 3-1, 3-2)
// ---------------------------------------------------------
// 본문: [..] 굵게(formatScenarioBody) + "이름)" 대사 표시 굵게 + BAD ENDING 강조
function formatSceneText(text) {
  return formatScenarioBody(text)
    .replace(/^(주은|유성|동경|새봄|간호사|경찰|범석)\)/gm, "<strong>$1)</strong>")
    .replace(/^(BAD ENDING)$/gm, '<strong class="scene-ending-mark">$1</strong>');
}

function renderScene(state) {
  showOnlyStage(el("stage-scene"));
  const scene = STORY_SCENES[state.currentScene];
  el("scene-title").textContent = scene ? scene.title : "-";
  el("scene-text").innerHTML = scene ? formatSceneText(scene.text) : "";
  const btn = el("scene-next-btn");
  btn.textContent = scene && scene.next ? scene.next.label : "다음으로";
  btn.classList.toggle("hidden", isLocalGM() || !scene || !scene.next);
  // 장면이 바뀌면 맨 위부터 읽도록
  if (renderScene.lastScene !== state.currentScene) {
    renderScene.lastScene = state.currentScene;
    window.scrollTo(0, 0);
  }
}

function renderEnding(state) {
  showOnlyStage(el("stage-ending"));
  el("ending-next-btn").classList.toggle("hidden", isLocalGM());
  el("ending-text").innerHTML = formatSceneText(ENDING_TEXT);
}

// ---------------------------------------------------------
// 해설집 팝업 (엔딩 화면 [해설집 보기])
// ---------------------------------------------------------
let commentaryChapter = null; // null이면 스포일러 경고 화면

function formatCommentaryBody(text) {
  const escaped = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\{\{B\}\}/g, "<strong>").replace(/\{\{\/B\}\}/g, "</strong>");
}

function openCommentary() {
  commentaryChapter = null;
  renderCommentary();
  el("commentary-modal").classList.remove("hidden");
  el("commentary-modal").setAttribute("aria-hidden", "false");
}

function closeCommentary() {
  el("commentary-modal").classList.add("hidden");
  el("commentary-modal").setAttribute("aria-hidden", "true");
}

function renderCommentary() {
  const tabs = el("commentary-tabs");
  tabs.innerHTML = "";
  COMMENTARY.chapters.forEach((ch, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab-btn" + (idx === commentaryChapter ? " active" : "");
    b.textContent = ch.title;
    b.dataset.chapterIndex = idx;
    tabs.appendChild(b);
  });

  const body = el("commentary-body");
  if (commentaryChapter === null) {
    body.className = "scenario-text commentary-body commentary-warning";
    body.innerHTML = formatCommentaryBody(COMMENTARY.warning);
  } else {
    const ch = COMMENTARY.chapters[commentaryChapter];
    body.className = "scenario-text commentary-body";
    body.innerHTML = `<h4 class="commentary-chapter-title">${formatCommentaryBody(ch.title)}</h4>` + formatCommentaryBody(ch.body);
  }
  el("commentary-panel").scrollTop = 0;
}

// ---------------------------------------------------------
// 6. 점수 확인 (자기 신고 → 결과 공개)
// ---------------------------------------------------------
let scoreDraft = {}; // 제출 전 이 기기에서 고른 점수 { itemId: points }

// 화면에 보여줄 현재 값: 직접 고른 값 > 기록 기반 자동 값 > 0
function scoreValueFor(state, charId, item) {
  if (Object.prototype.hasOwnProperty.call(scoreDraft, item.id)) return scoreDraft[item.id];
  const auto = item.auto ? autoScoreFor(state, charId, item) : null;
  return auto === null ? 0 : auto;
}

function collectScoreDraft(state) {
  const charId = getViewerCharId(state);
  const goals = SCORE_GOALS[charId] || {};
  const out = {};
  [1, 2, 3].forEach((ph) => (goals[ph] || []).forEach((g) => { out[g.id] = scoreValueFor(state, charId, g); }));
  return out;
}

function scoreItemRow(state, charId, item, locked, lockedValue, shared) {
  const row = document.createElement("div");
  row.className = "score-item";
  const label = document.createElement("div");
  label.className = "score-item-text";
  label.textContent = item.text;
  if (item.criteria) {
    const crit = document.createElement("div");
    crit.className = "score-criteria";
    crit.textContent = item.criteria;
    label.appendChild(crit);
  }
  if (item.auto && !locked) {
    const auto = autoScoreFor(state, charId, item);
    if (auto !== null) {
      const note = document.createElement("span");
      note.className = "score-auto-note";
      note.textContent = auto > 0 ? " (게임 기록: 달성)" : " (게임 기록: 미달성)";
      label.appendChild(note);
    }
  }
  row.appendChild(label);
  const btns = document.createElement("div");
  btns.className = "score-item-buttons";
  const current = locked ? lockedValue : scoreValueFor(state, charId, item);
  // 1점짜리는 [미달성 / 달성], 그 이상은 0~최대 점수 중 선택
  const values = item.binary ? [0, item.points] : Array.from({ length: item.points + 1 }, (_, i) => i);
  values.forEach((v) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice-btn score-btn" + (v === current ? " selected" : "");
    b.textContent = (item.points === 1 || item.binary) ? (v ? `달성 (+${item.points})` : "미달성") : `${v}점`;
    if (shared) b.dataset.scoreCommon = item.id; else b.dataset.scoreItem = item.id;
    b.dataset.scoreValue = v;
    b.disabled = locked;
    btns.appendChild(b);
  });
  row.appendChild(btns);
  return row;
}

function renderScore(state) {
  showOnlyStage(el("stage-score"));
  const charId = getViewerCharId(state);
  const reports = state.scoreReports || {};
  const playerCharIds = Object.keys(state.characters || {}).filter((c) => state.characters[c]);
  const submittedCount = playerCharIds.filter((c) => reports[c]).length;
  const allDone = playerCharIds.length > 0 && submittedCount === playerCharIds.length;

  // 체크 폼
  const form = el("score-form");
  form.innerHTML = "";
  const myReport = charId ? reports[charId] : null;
  if (charId && !isLocalGM() && !allDone) {
    const goals = SCORE_GOALS[charId] || {};
    const sections = [
      { title: "1페이즈 목표", items: goals[1] || [] },
      { title: "2페이즈 목표", items: goals[2] || [] },
      { title: "3페이즈 [대답해야 한다]", items: goals[3] || [] }
    ];
    sections.forEach((sec) => {
      const h = document.createElement("h3");
      h.className = "revealed-cards-title score-section-title";
      h.textContent = sec.title;
      form.appendChild(h);
      sec.items.forEach((item) => {
        form.appendChild(scoreItemRow(state, charId, item, !!myReport, myReport ? myReport.items[item.id] : 0));
      });
    });
  }
  if (!allDone) {
    // 공통 추리: 네 명이 함께 정하는 점수 (누가 눌러도 모두에게 반영)
    const h = document.createElement("h3");
    h.className = "revealed-cards-title score-section-title";
    h.textContent = "3페이즈 공통 추리 (네 명 공통, 합계 14점)";
    form.appendChild(h);
    const note = document.createElement("p");
    note.className = "score-auto-note score-common-note";
    note.textContent = "네 명이 함께 의논해서 정하는 점수입니다. 누가 눌러도 모두의 화면에 반영되며, 네 명 모두에게 같은 점수가 더해집니다.";
    form.appendChild(note);
    const common = state.scoreCommon || {};
    let lastQ = null;
    SCORE_COMMON.forEach((q) => {
      if (q.q && q.q !== lastQ) {
        const qh = document.createElement("div");
        qh.className = "score-question";
        qh.textContent = q.q;
        form.appendChild(qh);
        lastQ = q.q;
      }
      form.appendChild(scoreItemRow(state, charId, q, isLocalGM(), Number(common[q.id]) || 0, true));
    });
  }

  const submitRow = el("score-submit-row");
  submitRow.classList.toggle("hidden", allDone);
  const btn = el("score-submit-btn");
  btn.classList.toggle("hidden", !charId || isLocalGM() || !!myReport);
  el("score-submit-status").textContent = myReport
    ? `제출 완료 — 다른 사람을 기다리는 중 (${submittedCount}/${playerCharIds.length})`
    : `제출: ${submittedCount}/${playerCharIds.length}`;

  // 결과 (네 명 모두 제출한 뒤에만)
  const results = el("score-results");
  results.classList.toggle("hidden", !allDone);
  el("score-commentary-row").classList.toggle("hidden", !allDone);
  if (!allDone) { results.innerHTML = ""; return; }

  const commonTotal = summarizeCommon(state);
  const rows = playerCharIds.map((c) => {
    const r = summarizeScore(c, reports[c]);
    return { charId: c, ...r, common: commonTotal, total: r.p1 + r.p2 + r.p3 + commonTotal };
  });
  rows.sort((a, b) => b.total - a.total);
  let rank = 0, prevTotal = null;
  rows.forEach((r, i) => {
    if (r.total !== prevTotal) { rank = i + 1; prevTotal = r.total; }
    r.rank = rank;
  });
  const maxOf = (c) => {
    const g = SCORE_GOALS[c] || {};
    const m = (list) => (list || []).reduce((a, x) => a + x.points, 0);
    return { p1: m(g[1]), p2: m(g[2]), p3: m(g[3]), common: m(SCORE_COMMON) };
  };
  let html = `<h3 class="revealed-cards-title">결과</h3><div class="score-table-wrap"><table class="score-table">
    <thead><tr><th>순위</th><th>인물</th><th>1페이즈</th><th>2페이즈</th><th>3페이즈 개인</th><th>공통 추리</th><th>총점</th><th>평가 등급</th></tr></thead><tbody>`;
  rows.forEach((r) => {
    const m = maxOf(r.charId);
    const name = (findCharacter(r.charId) || {}).name || r.charId;
    html += `<tr${r.rank === 1 ? ' class="score-top"' : ""}><td>${r.rank}위</td><td>${name}</td>
      <td>${r.p1} / ${m.p1}</td><td>${r.p2} / ${m.p2}</td><td>${r.p3} / ${m.p3}</td><td>${r.common} / ${m.common}</td>
      <td><strong>${r.total}</strong> / ${m.p1 + m.p2 + m.p3 + m.common}</td>
      <td class="score-grade-cell"><strong>${scoreGradeFor(r.total).name}</strong><div class="score-grade-desc">${scoreGradeFor(r.total).desc}</div></td></tr>`;
  });
  html += "</tbody></table></div>";
  html += `<div class="score-grade-legend">${SCORE_GRADES.map((g, i) => {
    const max = i === 0 ? 25 : SCORE_GRADES[i - 1].min - 1;
    return `<div><strong>${g.min}–${max}점 · ${g.name}</strong> — ${g.desc}</div>`;
  }).join("")}</div>`;
  results.innerHTML = html;
}

// ---------------------------------------------------------
// 점수·추리 해설 팝업 (엔딩 화면 [점수·추리 해설 보기])
// ---------------------------------------------------------
let answersTab = 0;

function openAnswers() {
  answersTab = 0;
  renderAnswers();
  el("answers-modal").classList.remove("hidden");
  el("answers-modal").setAttribute("aria-hidden", "false");
}

function closeAnswers() {
  el("answers-modal").classList.add("hidden");
  el("answers-modal").setAttribute("aria-hidden", "true");
}

function renderAnswers() {
  const tabs = el("answers-tabs");
  tabs.innerHTML = "";
  ANSWER_GUIDE.tabs.forEach((t, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab-btn" + (idx === answersTab ? " active" : "");
    b.textContent = t.title;
    b.dataset.answersIndex = idx;
    tabs.appendChild(b);
  });
  const t = ANSWER_GUIDE.tabs[answersTab];
  el("answers-body").innerHTML =
    `<h4 class="commentary-chapter-title">${formatCommentaryBody(t.title)}</h4>` + formatCommentaryBody(t.body);
  el("answers-panel").scrollTop = 0;
}

// ---------------------------------------------------------
// 마스터 렌더 함수 — main.js가 상태 변경마다 이걸 호출
// ---------------------------------------------------------
function render(state) {
  state = state || latestState; // 인자 없이 호출돼도 최신 상태로 그린다.
  if (!state) return;
  renderTopBar(state);
  updateScenarioReviewButton(state);
  updateClueButtons(state);
  renderClueListModal(); // 팝업이 열려 있으면 새 상태로 다시 그린다.

  switch (state.currentStage) {
    case "rules-basic":
    case "rules-phase1":
    case "rules-phase1-progress":
    case "rules-phase2":
    case "rules-phase3":
      renderRules(state);
      break;
    case "opening":
      renderOpening(state, OPENING_TEXT);
      break;
    case "character-select":
      renderCharacterSelect(state);
      break;
    case "scenario":
      renderScenario(state);
      break;
    case "investigation-r1":
    case "investigation-r2":
    case "investigation-r3":
      renderInvestigation(state);
      break;
    case "investigation-free":
    case "investigation-free-p3":
      renderInvestigationFree(state);
      break;
    case "talk-1":
    case "talk-2":
    case "talk-3":
      renderTalk(state);
      break;
    case "discussion":
    case "discussion-pre":
      renderDiscussion(state);
      break;
    case "arrest":
      renderArrest(state);
      break;
    case "arrest-result":
      renderArrestResult(state);
      break;
    case "scene":
      renderScene(state);
      break;
    case "ending":
      renderEnding(state);
      break;
    case "score":
      renderScore(state);
      break;
    default:
      console.warn("알 수 없는 스테이지:", state.currentStage);
  }
}
