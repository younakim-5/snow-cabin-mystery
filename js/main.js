/* =========================================================
   메인 진행 로직
   -----------------------------------------------------------
   - 상태 구독 (Firebase 또는 로컬 테스트 모드, backend.js가 알아서 처리)
   - 타이머 계산 및 시간 종료 시 자동 전환
   - 전원 준비완료/전원 선택 시 자동 전환
   - 버튼 클릭 등 이벤트 연결
   ========================================================= */

let latestState = null;
let clueClaimInFlight = false; // 단서 선택 저장 중 여부 (중복 클릭 방지)
let timerIntervalId = null;

// ---------------------------------------------------------
// 초기화
// ---------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  if (backendIsLocalMode()) {
    const badge = el("local-mode-badge");
    if (badge) badge.classList.remove("hidden");
  }

  await backendSyncClock();
  await backendEnsureExists();
  bindStaticEvents();

  backendSubscribe((state) => {
    latestState = state;
    // 화면 그리기에서 오류가 나도 타이머/자동 전환은 계속 돌아가야 한다.
    try {
      render(state);
    } catch (err) {
      console.error("[render 오류]", err);
    }
    // 타이머를 먼저 새 상태로 맞춘 뒤 자동 전환을 처리한다.
    // (자동 전환이 곧바로 다음 상태를 만들면, 그 상태의 타이머가 마지막에 남아야 한다)
    updateTimerLoop(state);
    handleAutoAdvance(state);
  });
});

// ---------------------------------------------------------
// 타이머
// ---------------------------------------------------------
function updateTimerLoop(state) {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  const duration = state.stageDurationSec;
  if (!duration || !state.stageStartedAt) {
    renderTimer(null);
    return;
  }

  const startedAtMs = state.stageStartedAt;
  let fired = false;
  let myIntervalId = null;
  const stop = () => {
    clearInterval(myIntervalId);
    if (timerIntervalId === myIntervalId) timerIntervalId = null;
  };

  const tick = () => {
    // 이미 다음 스테이지로 넘어갔다면 예전 타이머는 멈춘다.
    if (latestState && latestState.stageStartedAt !== startedAtMs) {
      stop();
      return;
    }
    const elapsedSec = (serverNow() - startedAtMs) / 1000;
    const remaining = duration - elapsedSec;
    renderTimer(remaining);

    if (remaining <= 0 && !fired) {
      fired = true;
      stop();
      onStageTimeUp(state);
    }
  };

  // interval을 먼저 등록한 뒤 첫 tick을 실행해야, 첫 tick에서 바로 시간이
  // 끝났을 때도 interval이 확실히 정리된다.
  myIntervalId = setInterval(tick, 1000);
  timerIntervalId = myIntervalId;
  tick();
}

// 타이머가 있는 스테이지(개인 시나리오 / 밀담 / 전체 토론)가 끝났을 때 이어질 다음 스테이지.
// 시간 종료와 [대화 완료] 전원 클릭이 같은 규칙을 쓰도록 한 곳에 모아둔다.
function getTimedStageNext(state) {
  if (state.currentStage === "scenario") {
    return AFTER_SCENARIO[state.currentPhase] || null;
  }

  // 밀담(1페이즈)은 라운드 이름에 규칙이 있어 별도로 처리한다.
  const talkMatch = /^talk-(\d)$/.exec(state.currentStage);
  if (talkMatch) {
    const nextRound = Number(talkMatch[1]) + 1;
    const nextStage = nextRound <= 3 ? `investigation-r${nextRound}` : "discussion";
    // 3차 밀담 뒤 전체 토론에는 토론 시간(20분)을 걸어준다.
    const nextDuration = nextStage === "discussion" ? DISCUSSION_STAGES["discussion"].durationSec : 0;
    return { stage: nextStage, durationSec: nextDuration };
  }

  // 조사 및 전체 토론 라운드(2·3페이즈) → 최종 추리(검거 / 시나리오 3)
  const freeRound = getTimedFreeRound(state);
  if (freeRound) {
    return { stage: freeRound.next, durationSec: freeRound.nextDurationSec || 0 };
  }

  // 그 외 전체 토론(discussion, discussion-pre)
  return AFTER_DISCUSSION[state.currentStage] || null;
}

// 시간이 다 됐을 때: 강제로 다음 스테이지로 넘긴다.
// transitionIfStillOn이 현재 스테이지를 다시 확인하기 때문에,
// 여러 탭/기기가 동시에 시간 종료를 감지해도 중복 전환되지 않는다.
async function onStageTimeUp(state) {
  const after = getTimedStageNext(state);
  if (!after) return;
  await transitionIfStillOn(state.currentStage, after.stage, after.durationSec, state.stageStartedAt, true);
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

  // 밀담 / 전체 토론: [대화 완료]를 4명 모두 누르면 타이머와 상관없이 다음으로 넘어간다.
  if (isSkippableStage(state)) {
    const readyCount = (state.readyPlayers[state.currentStage] || []).length;
    if (readyCount >= totalPlayers) {
      const after = getTimedStageNext(state);
      if (after) await transitionIfStillOn(state.currentStage, after.stage, after.durationSec, state.stageStartedAt);
    }
  }

  // investigation-rN -> talk-N / discussion 전환은 game-state.js의 claimClueTurn 안에서 처리한다.
  // investigation-free(-p3) -> arrest / scene:3-1 전환은 타이머 종료 또는 4명 [완료]로 이루어진다.
  // talk-N -> investigation-r(N+1), discussion(-pre) -> 다음 단계 전환은 타이머 종료 또는 4명 [대화 완료]로 이루어진다.
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
    closeClueListModal();
    closeClueModal();
    currentScenarioTabIndex = 0;
    currentInvestigationRoomIndex = 0;
    selectedArrestChoice = null;
    selectedArrestTarget = null;
    selectedTransferClueId = null;
    selectedTransferTarget = null;
    scoreDraft = {};
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

  // 2. 시나리오 탭 전환
  el("scenario-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    currentScenarioTabIndex = Number(btn.dataset.tabIndex);
    render(latestState);
  });

  el("scenario-ready-btn").addEventListener("click", () => {
    if (isLocalGM()) return;
    markReady("scenario-" + latestState.currentPhase);
  });

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
      // 저장이 끝나기 전에 한 번 더 눌리면(더블클릭 등) 두 번째 요청이
      // "차례가 아닙니다"로 거절되므로, 처리 중에는 추가 클릭을 무시한다.
      if (clueClaimInFlight) return;
      clueClaimInFlight = true;
      document.querySelectorAll("#investigation-board .letter-btn").forEach((b) => { b.disabled = true; });
      try {
        if (/^investigation-free/.test(latestState.currentStage)) {
          await claimFreeClue(letterBtn.dataset.clueId);
        } else {
          await claimClueTurn(letterBtn.dataset.clueId);
        }
      } catch (err) {
        alert(err.message);
      } finally {
        clueClaimInFlight = false;
        if (latestState) render(latestState);
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

  // 밀담 중 단서 양도 (이벤트 위임)
  el("talk-transfer").addEventListener("click", async (e) => {
    if (isLocalGM() || !latestState) return;
    const clueBtn = e.target.closest("[data-transfer-clue]");
    if (clueBtn) {
      selectedTransferClueId = clueBtn.dataset.transferClue;
      render(latestState);
      return;
    }
    const targetBtn = e.target.closest("[data-transfer-target]");
    if (targetBtn) {
      selectedTransferTarget = targetBtn.dataset.transferTarget;
      render(latestState);
      return;
    }
    const submitBtn = e.target.closest("[data-transfer-submit]");
    if (submitBtn && !submitBtn.disabled) {
      const info = findClueInfo(selectedTransferClueId);
      const target = findCharacter(selectedTransferTarget);
      if (!info || !target) return;
      if (!confirm(`[${info.label}] 단서를 ${target.name}에게 양도할까요?\n양도하면 이 단서는 더 이상 볼 수 없습니다.`)) return;
      try {
        await transferClue(selectedTransferClueId, selectedTransferTarget);
        selectedTransferClueId = null;
        selectedTransferTarget = null;
      } catch (err) {
        alert(err.message);
      }
      render(latestState);
    }
  });

  // 밀담 / 전체 토론 공용 [대화 완료] 버튼 (밀담 화면, 토론 화면, 조사 레이아웃 토론 화면)
  document.querySelectorAll(".talk-done-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (isLocalGM() || !latestState) return;
      if (!isSkippableStage(latestState)) return;
      markReady(latestState.currentStage);
    });
  });

  // 상단 [내 단서] / [공개된 단서]
  el("my-clues-btn").addEventListener("click", () => openClueListModal("mine"));
  el("revealed-clues-btn").addEventListener("click", () => openClueListModal("revealed"));
  el("clue-list-close").addEventListener("click", closeClueListModal);
  el("clue-list-modal").addEventListener("click", async (e) => {
    if (e.target === el("clue-list-modal")) { closeClueListModal(); return; }
    const phaseTab = e.target.closest("[data-list-phase]");
    if (phaseTab) {
      clueListPhase = Number(phaseTab.dataset.listPhase);
      renderClueListModal();
      return;
    }
    const revealBtn = e.target.closest("[data-reveal-clue]");
    if (revealBtn && !revealBtn.disabled) {
      if (isLocalGM()) return;
      if (!confirm("이 단서를 모두에게 전체공개할까요?\n(전체 공개는 페이즈마다 1회만 사용할 수 있습니다.)")) return;
      try {
        await revealClueCard(revealBtn.dataset.revealClue);
      } catch (err) {
        alert(err.message);
      }
    }
  });

  // 4. 검거
  el("arrest-choices").addEventListener("click", (e) => {
    if (isLocalGM()) return;
    const btn = e.target.closest(".choice-btn");
    if (!btn) return;
    selectedArrestChoice = btn.dataset.choiceId;
    // 1페이즈 재투표에서는 "동경 검거"처럼 대상까지 한 번에 고르는 버튼을 쓴다.
    selectedArrestTarget = btn.dataset.targetId || null;
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
    try {
      await submitArrestChoice(phaseKey, selectedArrestChoice, selectedArrestTarget);
    } catch (err) {
      alert(err.message);
    }
  });

  // 검거 결과 → 결과별 진행 시나리오 (1페이즈 A~E / 2페이즈 G~K)
  el("arrest-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    selectedArrestChoice = null;
    selectedArrestTarget = null;
    await goToArrestResultScene();
  });

  // 진행 시나리오 [다음] 버튼 — STORY_SCENES[...].next에 따라 분기
  el("scene-next-btn").addEventListener("click", async () => {
    if (isLocalGM() || !latestState) return;
    const sceneId = latestState.currentScene;
    const scene = STORY_SCENES[sceneId];
    if (!scene || !scene.next) return;
    const nxt = scene.next;
    if (nxt.type === "scene") {
      await goToScene(sceneId, nxt.to);
    } else if (nxt.type === "redo") {
      selectedArrestChoice = null;
      selectedArrestTarget = null;
      await redoArrest(sceneId, nxt.phase);
    } else if (nxt.type === "phase") {
      currentScenarioTabIndex = 0;
      await advancePhase(nxt.phase, "rules-phase" + nxt.phase, 0);
    } else if (nxt.type === "ending") {
      await goToEnding(sceneId);
    }
  });

  // 해설집
  // 엔딩 → 점수 확인
  el("ending-next-btn").addEventListener("click", async () => {
    if (isLocalGM()) return;
    await goToScore();
  });

  // 점수 자기 신고: 점수 버튼 선택 (이벤트 위임)
  el("score-form").addEventListener("click", async (e) => {
    const commonBtn = e.target.closest("[data-score-common]");
    if (commonBtn && !commonBtn.disabled && !isLocalGM()) {
      await setScoreCommon(commonBtn.dataset.scoreCommon, Number(commonBtn.dataset.scoreValue));
      return;
    }
    const btn = e.target.closest("[data-score-item]");
    if (!btn || btn.disabled || !latestState) return;
    scoreDraft[btn.dataset.scoreItem] = Number(btn.dataset.scoreValue);
    render(latestState);
  });

  el("score-submit-btn").addEventListener("click", async () => {
    if (isLocalGM() || !latestState) return;
    if (!confirm("내 개인 점수를 이대로 제출할까요? 제출한 뒤에는 고칠 수 없습니다.\n(공통 추리 점수는 네 명이 모두 제출하기 전까지 계속 고칠 수 있습니다.)")) return;
    try {
      await submitScoreReport(collectScoreDraft(latestState));
    } catch (err) {
      alert(err.message);
    }
  });

  // 점수·추리 해설 팝업
  el("answers-open-btn").addEventListener("click", openAnswers);
  el("answers-close-btn").addEventListener("click", closeAnswers);
  el("answers-modal").addEventListener("click", (e) => {
    if (e.target === el("answers-modal")) { closeAnswers(); return; }
    const tab = e.target.closest("[data-answers-index]");
    if (tab) {
      answersTab = Number(tab.dataset.answersIndex);
      renderAnswers();
    }
  });

  el("commentary-open-btn").addEventListener("click", openCommentary);
  el("commentary-close-btn").addEventListener("click", closeCommentary);
  el("commentary-modal").addEventListener("click", (e) => {
    if (e.target === el("commentary-modal")) { closeCommentary(); return; }
    const tab = e.target.closest("[data-chapter-index]");
    if (tab) {
      commentaryChapter = Number(tab.dataset.chapterIndex);
      renderCommentary();
    }
  });
}
