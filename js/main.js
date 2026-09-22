/* =========================================================
   메인 진행 로직
   -----------------------------------------------------------
   - 상태 구독 (Firebase 또는 로컬 테스트 모드, backend.js가 알아서 처리)
   - 타이머 계산 및 시간 종료 시 자동 전환
   - 전원 준비완료/전원 선택 시 자동 전환
   - 버튼 클릭 등 이벤트 연결
   ========================================================= */

let latestState = null;
let timerIntervalId = null;

// ---------------------------------------------------------
// 초기화
// ---------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  if (backendIsLocalMode()) {
    const badge = el("local-mode-badge");
    if (badge) badge.classList.remove("hidden");
  }

  await backendEnsureExists();
  bindStaticEvents();

  backendSubscribe((rawState) => {
    // 오래된 Firebase 문서에 새 필드가 없더라도 현재 코드가 멈추지 않도록
    // 기본 상태의 필드들을 보충한 뒤 렌더링한다.
    const state = normalizeIncomingState(rawState);
    latestState = state;
    // 타이머/화면/자동전환을 서로 분리한다. 한 영역의 오류가 다른 기능까지
    // 함께 멈추게 하지 않는다. 특히 scenario 진입 직후 타이머를 먼저 살린다.
    try { updateTimerLoop(state); } catch (err) { console.error("타이머 갱신 오류:", err, state); }
    try { render(state); } catch (err) { console.error("상태 렌더링 오류:", err, state); }
    try { handleAutoAdvance(state); } catch (err) { console.error("자동 전환 오류:", err, state); }
  });
});

function normalizeIncomingState(raw) {
  const base = getInitialGameState();
  const state = { ...base, ...(raw || {}) };
  const mapKeys = [
    "characters", "readyPlayers", "clueClaims", "freePickCounts",
    "arrestSubmissions", "arrestChoices", "arrestResults", "arrestMajority",
    "arrestWinnerTarget", "arrestRevoteCount", "arrestEligibleTargets"
  ];
  mapKeys.forEach((key) => {
    state[key] = { ...(base[key] || {}), ...((raw && raw[key]) || {}) };
  });
  state.revealedClueIds = Array.isArray(state.revealedClueIds) ? state.revealedClueIds : [];
  return state;
}

// ---------------------------------------------------------
// 타이머
// ---------------------------------------------------------
function updateTimerLoop(state) {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  // 개인 시나리오는 공유 상태에 duration이 누락된 구버전 state가 남아 있어도
  // 현재 페이즈의 확정 시간을 사용한다 (1P 20분 / 2P 5분 / 3P 3분).
  const duration = (state.currentStage === "scenario")
    ? (Number(state.stageDurationSec) || SCENARIO_DURATIONS[state.currentPhase] || 0)
    : Number(state.stageDurationSec || 0);

  // Firestore Timestamp / 숫자(ms) 양쪽 모두 안전하게 처리한다.
  const rawStartedAt = state.stageStartedAt;
  const startedAtMs = rawStartedAt && typeof rawStartedAt.toMillis === "function"
    ? rawStartedAt.toMillis()
    : Number(rawStartedAt || 0);

  if (!duration) {
    renderTimer(null);
    return;
  }
  if (!startedAtMs) {
    // 개인 시나리오라면 타이머 자체를 숨기지 말고 확정 시간을 표시한다.
    // 동시에 Firebase의 누락된 시작 시각을 한 번 복구한다.
    if (state.currentStage === "scenario") {
      renderTimer(duration);
      repairScenarioTiming(state.currentPhase, duration);
    } else {
      renderTimer(null);
    }
    return;
  }

  const tick = () => {
    const elapsedSec = (Date.now() - startedAtMs) / 1000;
    const remaining = duration - elapsedSec;
    renderTimer(remaining);

    if (remaining <= 0) {
      clearInterval(timerIntervalId);
      timerIntervalId = null;
      onStageTimeUp(state);
    }
  };

  tick();
  timerIntervalId = setInterval(tick, 1000);
}

let scenarioTimingRepairPending = false;
async function repairScenarioTiming(phase, duration) {
  if (scenarioTimingRepairPending) return;
  scenarioTimingRepairPending = true;
  try {
    await backendUpdate((currentRaw) => {
      const current = normalizeIncomingState(currentRaw);
      if (current.currentStage !== "scenario" || Number(current.currentPhase) !== Number(phase)) return undefined;
      const raw = current.stageStartedAt;
      const start = raw && typeof raw.toMillis === "function" ? raw.toMillis() : Number(raw || 0);
      if (start > 0 && Number(current.stageDurationSec) > 0) return undefined;
      return { ...current, stageStartedAt: Date.now(), stageDurationSec: Number(current.stageDurationSec) || duration };
    });
  } catch (err) {
    console.error("개인 시나리오 타이머 상태 복구 실패:", err);
  } finally {
    scenarioTimingRepairPending = false;
  }
}

// 시간이 다 됐을 때: 강제로 다음 스테이지로 넘긴다.
// transitionIfStillOn이 현재 스테이지를 다시 확인하기 때문에,
// 여러 탭/기기가 동시에 시간 종료를 감지해도 중복 전환되지 않는다.
async function onStageTimeUp(state) {
  if (state.currentStage === "scenario") {
    const after = AFTER_SCENARIO[state.currentPhase];
    if (after) await transitionIfStillOn("scenario", after.stage, after.durationSec);
    return;
  }

  // 밀담(1페이즈)은 라운드 이름에 규칙이 있어 별도로 처리한다.
  const talkMatch = /^talk-(\d)$/.exec(state.currentStage);
  if (talkMatch) {
    const nextRound = Number(talkMatch[1]) + 1;
    const nextStage = nextRound <= 3 ? `investigation-r${nextRound}` : "discussion";
    await transitionIfStillOn(state.currentStage, nextStage, 0);
    return;
  }

  // 그 외 전체 토론(discussion, discussion-pre/post, discussion-p3-*) 종료 시 다음 단계로.
  const after = AFTER_DISCUSSION[state.currentStage];
  if (!after) return;
  await transitionIfStillOn(state.currentStage, after.stage, after.durationSec);
}

// ---------------------------------------------------------
// 자동 전환 (전원 준비완료 / 전원 캐릭터 선택 완료)
// ---------------------------------------------------------
async function handleAutoAdvance(state) {
  const totalPlayers = 4;

  if (state.currentStage === "rules-basic") {
    const readyCount = (state.readyPlayers["rules-basic"] || []).length;
    if (readyCount >= totalPlayers) {
      await transitionIfStillOn("rules-basic", "rules-phase1", 0);
    }
  }

  if (state.currentStage === "rules-phase1") {
    const readyCount = (state.readyPlayers["rules-phase1"] || []).length;
    if (readyCount >= totalPlayers) {
      await transitionIfStillOn("rules-phase1", "opening", 0);
    }
  }

  if (state.currentStage === "opening") {
    const readyCount = (state.readyPlayers["opening"] || []).length;
    if (readyCount >= totalPlayers) {
      await transitionIfStillOn("opening", "character-select", 0);
    }
  }

  if (state.currentStage === "character-select") {
    if (allCharactersPicked(state.characters)) {
      const duration = SCENARIO_DURATIONS[state.currentPhase] || 0;
      await transitionIfStillOn("character-select", "scenario", duration);
    }
  }

  if (state.currentStage === "rules-phase2" || state.currentStage === "rules-phase3") {
    const readyCount = (state.readyPlayers[state.currentStage] || []).length;
    if (readyCount >= totalPlayers) {
      const duration = SCENARIO_DURATIONS[state.currentPhase] || 0;
      await transitionIfStillOn(state.currentStage, "scenario", duration);
    }
  }

  if (state.currentStage === "scenario") {
    const stageKey = "scenario-" + state.currentPhase;
    const readyCount = (state.readyPlayers[stageKey] || []).length;
    if (readyCount >= totalPlayers) {
      const after = AFTER_SCENARIO[state.currentPhase];
      if (after) await transitionIfStillOn("scenario", after.stage, after.durationSec);
    }
  }

  if (state.currentStage === "rules-phase1-progress") {
    const readyCount = (state.readyPlayers["rules-phase1-progress"] || []).length;
    if (readyCount >= totalPlayers) {
      await transitionIfStillOn("rules-phase1-progress", "investigation-r1", 0);
    }
  }

  // investigation-rN -> talk-N / discussion 전환은 game-state.js의 claimClueTurn 안에서 처리한다.
  // investigation-free -> discussion-post 전환은 game-state.js의 claimFreeClue 안에서 처리한다.
  // talk-N -> investigation-r(N+1), discussion(-pre/-post) -> 다음 단계 전환은 타이머 종료(onStageTimeUp)로만 이루어진다.
  // arrest -> arrest-result 전환은 game-state.js의 submitArrestChoice 안에서 처리한다.
}

// ---------------------------------------------------------
// 이벤트 연결
// ---------------------------------------------------------
function bindStaticEvents() {

  el("my-scenario-btn").addEventListener("click", openScenarioReview);
  el("scenario-review-close").addEventListener("click", closeScenarioReview);
  el("scenario-review-modal").addEventListener("click", (e) => { if (e.target === el("scenario-review-modal")) closeScenarioReview(); });

  // 리셋
  el("reset-btn").addEventListener("click", async () => {
    if (!confirm("정말 게임을 처음부터 다시 시작할까요?")) return;
    await resetGame();
    currentScenarioTabIndex = 0;
    currentInvestigationRoomIndex = 0;
    selectedArrestChoice = null;
    selectedArrestTarget = null;
  });

  // 룰 설명 (기본 / 페이즈별 공용)
  el("rules-ready-btn").addEventListener("click", () => {
    if (isLocalGM()) return;
    markReady(latestState.currentStage);
  });

  // 0. 오프닝
  el("opening-ready-btn").addEventListener("click", () => {
    if (isLocalGM()) return;
    markReady("opening");
  });

  // GM 관전: 캐릭터 슬롯을 차지하지 않고 공유 상태를 읽기만 한다.
  el("gm-observe-btn").addEventListener("click", () => {
    setLocalGM();
    pendingCharacterId = null;
    render(latestState);
  });

  // 1. 캐릭터 선택 (이벤트 위임)
  el("character-grid").addEventListener("click", (e) => {
    if (isLocalGM()) return;
    const card = e.target.closest(".character-card");
    if (!card || card.disabled) return;
    pendingCharacterId = card.dataset.characterId;
    render(latestState);
  });

  el("character-confirm-yes-btn").addEventListener("click", async () => {
    const charId = pendingCharacterId;
    try {
      await pickCharacter(charId);
      pendingCharacterId = null;
    } catch (err) {
      pendingCharacterId = null;
      alert(err.message);
      render(latestState);
    }
  });

  el("character-confirm-back-btn").addEventListener("click", () => {
    pendingCharacterId = null;
    render(latestState);
  });

  // 2. 개인 시나리오의 탭/준비완료 이벤트는 renderScenario()가 직접 연결한다.

  // 3. 단서 조사 (턴제 / 자유조사 공용, 이벤트 위임)
  el("investigation-board").addEventListener("click", async (e) => {
    if (isLocalGM()) return;
    const roomTab = e.target.closest(".tab-btn");
    if (roomTab && roomTab.dataset.roomIndex !== undefined) {
      currentInvestigationRoomIndex = Number(roomTab.dataset.roomIndex);
      render(latestState);
      return;
    }

    const letterBtn = e.target.closest(".letter-btn");
    if (letterBtn && !letterBtn.disabled) {
      try {
        if (/^investigation-free/.test(latestState.currentStage)) {
          await claimFreeClue(letterBtn.dataset.clueId);
        } else {
          await claimClueTurn(letterBtn.dataset.clueId);
        }
      } catch (err) {
        alert(err.message);
      }
    }
  });

  el("clue-reveal-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    const clueId = el("clue-reveal-btn").dataset.clueId;
    try {
      await revealClueCard(clueId);
      closeClueModal();
    } catch (err) {
      alert(err.message);
    }
  });

  el("clue-close-btn").addEventListener("click", closeClueModal);

  // 4. 검거
  el("arrest-choices").addEventListener("click", (e) => {
    if (isLocalGM()) return;
    const btn = e.target.closest(".choice-btn");
    if (!btn) return;
    selectedArrestChoice = btn.dataset.choiceId;
    selectedArrestTarget = null;
    render(latestState);
  });

  el("arrest-target-choices").addEventListener("click", (e) => {
    if (isLocalGM()) return;
    const btn = e.target.closest(".choice-btn");
    if (!btn) return;
    selectedArrestTarget = btn.dataset.targetId;
    render(latestState);
  });

  el("arrest-submit-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    const phaseKey = "phase" + latestState.currentPhase;
    await submitArrestChoice(phaseKey, selectedArrestChoice, selectedArrestTarget);
  });

  el("arrest-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    const phaseKey = "phase" + latestState.currentPhase;

    if (latestState.currentPhase === 1) {
      // 검거 결과를 보고 시나리오 A(누군가 검거됨)로 갈지, B로 바로 갈지 정한다.
      const { anyArrested } = getArrestOutcome(latestState, phaseKey);
      await advanceStage(anyArrested ? "scenario-a" : "scenario-b", 0);
      return;
    }

    const config = ARREST[latestState.currentPhase];
    if (config && config.majorityRule) {
      // 다수결 결과(산장주인 vs 그 외)를 보고 시나리오 C/D로 분기한다.
      const majority = latestState.arrestMajority && latestState.arrestMajority[phaseKey];
      await advanceStage(majority === "host" ? "scenario-d" : "scenario-c", 0);
      return;
    }

    // 그 외: 다음 페이즈 룰 설명으로 — 해당 페이즈 콘텐츠가 준비되면 이어진다.
    const nextPhase = latestState.currentPhase + 1;
    selectedArrestChoice = null;
    selectedArrestTarget = null;
    currentScenarioTabIndex = 0;

    if (SCENARIOS[nextPhase]) {
      await advancePhase(nextPhase, "rules-phase" + nextPhase, 0);
    } else {
      alert("다음 내용이 아직 준비되지 않았습니다.");
    }
  });

  el("scenario-a-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    await advanceStage("scenario-b", 0);
  });

  el("scenario-c-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    await advanceStage("scenario-e", 0);
  });

  el("scenario-d-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    await advanceStage("scenario-e", 0);
  });

  el("scenario-e-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    await goToNextPhaseOrWait();
  });

  el("scenario-3-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    const config = PHASE_FINALE[latestState.currentPhase];
    await advanceStage(config ? config.nextStage : "ending", 0);
  });

  async function goToNextPhaseOrWait() {
    const nextPhase = latestState.currentPhase + 1;
    selectedArrestChoice = null;
    selectedArrestTarget = null;
    currentScenarioTabIndex = 0;

    if (SCENARIOS[nextPhase]) {
      await advancePhase(nextPhase, "rules-phase" + nextPhase, 0);
    } else {
      alert("다음 페이즈 콘텐츠가 아직 준비되지 않았습니다.");
    }
  }

  el("scenario-b-next-btn").addEventListener("click", async () => {
    await goToNextPhaseOrWait();
  });
}
