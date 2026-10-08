/* =========================================================
   게임 상태
   -----------------------------------------------------------
   이 파일은 "게임 상태가 어떤 모양이고, 어떻게 바뀌는지"만
   담당한다. 실제로 그 상태를 어디에 저장하는지(Firestore냐
   localStorage냐)는 backend.js가 알아서 처리한다.
   ========================================================= */

// 이 브라우저(이 사람)가 누구인지 저장 — 새로고침해도 유지되도록 localStorage 사용
const LOCAL_PLAYER_KEY = "scm_player_id";
const LOCAL_CHARACTER_KEY = "scm_character_id";
const LOCAL_ROLE_KEY = "scm_role";

function getLocalPlayerId() {
  let id = localStorage.getItem(LOCAL_PLAYER_KEY);
  if (!id) {
    id = "player-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LOCAL_PLAYER_KEY, id);
  }
  return id;
}

function getLocalCharacterId() {
  return localStorage.getItem(LOCAL_CHARACTER_KEY);
}

function setLocalCharacterId(charId) {
  localStorage.setItem(LOCAL_CHARACTER_KEY, charId);
  localStorage.setItem(LOCAL_ROLE_KEY, "player");
}

function isLocalGM() { return localStorage.getItem(LOCAL_ROLE_KEY) === "gm"; }
function setLocalGM() { localStorage.setItem(LOCAL_ROLE_KEY, "gm"); localStorage.removeItem(LOCAL_CHARACTER_KEY); }

// ---------------------------------------------------------
// 기본 상태 값 (게임 시작/리셋 시 이 형태로 초기화)
// ---------------------------------------------------------
function getInitialGameState() {
  return {
    currentPhase: 1,
    currentStage: "rules-basic", // rules-basic | opening | character-select | rules-phase1 | scenario | rules-phase1-progress | investigation-r1~3 | talk-1~3 | discussion | arrest | arrest-result | scene | rules-phase2 | discussion-pre | investigation-free | rules-phase3 | investigation-free-p3 | ending
    stageStartedAt: serverNow(), // 밀리초 타임스탬프 (로컬/Firebase 공통)
    stageDurationSec: 0,        // 0이면 타이머 없음(캐릭터 선택, 검거 대기 등)
    currentScene: null,         // currentStage가 "scene"일 때 보여줄 진행 시나리오 id (STORY_SCENES의 키: "A"~"M", "3-1", "3-2")

    // 캐릭터 id -> 플레이어 id
    characters: {
      jueun: null,
      donggyeong: null,
      yuseong: null,
      saebom: null
    },

    // "opening", 또는 "scenario-1", "clues-1" 처럼 스테이지별 키에
    // 준비완료한 플레이어 id 배열을 저장한다.
    readyPlayers: {},

    // 조사에서 획득한 단서와 그 소유자. (1페이즈 최초 소지 단서는 없음)
    clueClaims: { ...PHASE1_STARTING_CLAIMS }, // { clueId: characterId }
    revealedClueIds: [], // 소유 여부와 별개로, 모두에게 "전체공개"된 단서 id 목록
    revealUsed: {},      // { "1": { characterId: clueId } } — 페이즈마다 1인 1회 <전체 공개> 사용 기록 (강제 공개는 기록하지 않음)
    investigationTurnIndex: 0, // 현재 조사 라운드 안에서 몇 번째 순서인지
    freePickCounts: {}, // 자유 조사 스테이지별 캐릭터 획득 장수

    // 검거 제출 현황 및 결과
    arrestSubmissions: {}, // { "phase1": { playerId: true } }
    firstArrestVotes: {},  // { "phase1": { charId: { choice, target } } } — 각 페이즈의 맨 처음 표 (재투표·다시 진행해도 바뀌지 않음, 점수용)
    scoreReports: {},      // { charId: { items: { "p1-a": 1, ... }, submittedAt } } — 엔딩 후 자기 신고 개인 점수
    scoreCommon: {},       // { "c1a": 1, "c4": 3, ... } — 3페이즈 공통 추리 점수 (네 명이 함께 정하고, 네 명 모두에게 똑같이 더해진다)
    arrestChoices: {},     // { "phase1": { playerId: { choice, target } } }  (전원 제출 전엔 클라이언트에 노출 안 함)
    arrestResults: {},     // { "phase1": { playerId: { choice, target } } } (전원 제출 후 서버가 복사)
    arrestWinnerTarget: {}, // { "phase2": targetId } — 다수결 방식에서 실제로 최다 득표한 대상 id
    arrestRevoteCount: {}, // { "phase2": 재투표 횟수 } — 동률로 재투표가 발생했을 때만 증가
    arrestEligibleTargets: {} // { "phase2": [targetId, ...] | null } — 동률 재투표 시 후보를 그 사람들로만 좁힘
  };
}

// ---------------------------------------------------------
// 캐릭터 선택
// ---------------------------------------------------------
async function pickCharacter(characterId) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    if (state.characters[characterId]) {
      throw new Error("이미 선택된 캐릭터입니다.");
    }
    if (Object.values(state.characters).includes(playerId)) {
      throw new Error("이미 다른 캐릭터를 선택하셨습니다.");
    }
    return {
      ...state,
      characters: { ...state.characters, [characterId]: playerId }
    };
  });

  setLocalCharacterId(characterId);
}

function allCharactersPicked(characters) {
  return Object.values(characters).every((v) => !!v);
}

// ---------------------------------------------------------
// 준비완료 처리 (스테이지별 키로 관리)
// ---------------------------------------------------------
async function markReady(stageKey) {
  const playerId = getLocalPlayerId();
  await backendUpdate((state) => {
    const current = state.readyPlayers[stageKey] || [];
    if (current.includes(playerId)) return undefined;
    return {
      ...state,
      readyPlayers: { ...state.readyPlayers, [stageKey]: [...current, playerId] }
    };
  });
}

function isPlayerReady(readyPlayers, stageKey) {
  const list = readyPlayers[stageKey] || [];
  return list.includes(getLocalPlayerId());
}

// ---------------------------------------------------------
// 1페이즈 검거 판정 (tieRevote 방식)
// -----------------------------------------------------------
// - 4명 모두 거부 → 아무도 검거하지 않음
// - 1표라도 검거가 있으면 → 검거로 진행. 가장 많이 지목된 인물을 검거한다.
//   (거부 표는 전원 거부일 때만 의미가 있다)
// - 가장 많이 지목된 인물이 여러 명이면 → 그 인물들 + 거부로 재투표
// 반환: { revote: [옵션 id...] } 또는 { winner: 캐릭터 id | null }
// 옵션 id는 캐릭터 id 또는 "deny".
// ---------------------------------------------------------
const ARREST_DENY_OPTION = "deny";

function resolveTieRevoteArrest(choices) {
  const targetCounts = {};
  Object.values(choices).forEach((c) => {
    if (c.choice === "arrest" && c.target) targetCounts[c.target] = (targetCounts[c.target] || 0) + 1;
  });

  if (Object.keys(targetCounts).length === 0) return { winner: null }; // 전원 거부
  const maxVotes = Math.max(...Object.values(targetCounts));
  const top = Object.keys(targetCounts).filter((id) => targetCounts[id] === maxVotes);
  if (top.length > 1) return { revote: [...top, ARREST_DENY_OPTION] };
  return { winner: top[0] };
}

// ---------------------------------------------------------
// 검거 제출 (제출 여부만 먼저 공개, 실제 선택 내용은 전원 제출 후 결과로 옮김)
// ---------------------------------------------------------
async function submitArrestChoice(phaseKey, choice, target) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    const eligible = state.arrestEligibleTargets && state.arrestEligibleTargets[phaseKey];
    if (target && eligible && !eligible.includes(target)) {
      throw new Error("이번 재투표에서는 선택할 수 없는 대상입니다.");
    }
    if (!target && choice === ARREST_DENY_OPTION && eligible && !eligible.includes(ARREST_DENY_OPTION)) {
      throw new Error("이번 재투표에서는 선택할 수 없는 선택지입니다.");
    }

    const submissions = { ...(state.arrestSubmissions[phaseKey] || {}), [playerId]: true };
    const choices = {
      ...(state.arrestChoices[phaseKey] || {}),
      [playerId]: { choice, target: target || null }
    };

    const next = {
      ...state,
      arrestSubmissions: { ...state.arrestSubmissions, [phaseKey]: submissions },
      arrestChoices: { ...state.arrestChoices, [phaseKey]: choices }
    };
    // 점수용: 이 캐릭터의 해당 페이즈 "최초" 표를 한 번만 기록한다.
    const voterCharId = myCharacterId(state, playerId);
    const firstPhase = { ...((state.firstArrestVotes || {})[phaseKey] || {}) };
    if (voterCharId && !firstPhase[voterCharId]) {
      firstPhase[voterCharId] = { choice, target: target || null };
      next.firstArrestVotes = { ...(state.firstArrestVotes || {}), [phaseKey]: firstPhase };
    }

    const pickedPlayerIds = Object.values(state.characters).filter(Boolean);
    const allSubmitted = pickedPlayerIds.length > 0 && pickedPlayerIds.every((pid) => submissions[pid]);

    if (allSubmitted) {
      const phaseNum = Number(phaseKey.replace("phase", ""));
      const config = ARREST[phaseNum];

      if (config && config.tieRevote) {
        const outcome = resolveTieRevoteArrest(choices);
        if (outcome.revote) {
          next.arrestSubmissions = { ...state.arrestSubmissions, [phaseKey]: {} };
          next.arrestChoices = { ...state.arrestChoices, [phaseKey]: {} };
          next.arrestRevoteCount = {
            ...state.arrestRevoteCount,
            [phaseKey]: (state.arrestRevoteCount[phaseKey] || 0) + 1
          };
          next.arrestEligibleTargets = { ...state.arrestEligibleTargets, [phaseKey]: outcome.revote };
          // currentStage는 "arrest"에 그대로 머무른다 (재투표).
        } else {
          next.arrestResults = { ...state.arrestResults, [phaseKey]: choices };
          next.arrestWinnerTarget = { ...state.arrestWinnerTarget, [phaseKey]: outcome.winner };
          next.arrestEligibleTargets = { ...state.arrestEligibleTargets, [phaseKey]: null };
          next.currentStage = "arrest-result";
        }
      } else if (config && config.majorityRule) {
        // 개별 득표 최다득표자 방식. 최다득표가 여러 명이면 그 후보들만 남겨 재투표한다.
        const voteCounts = {};
        Object.values(choices).forEach((c) => {
          if (!c.target) return;
          voteCounts[c.target] = (voteCounts[c.target] || 0) + 1;
        });
        const maxVotes = Math.max(0, ...Object.values(voteCounts));
        const topTargets = Object.keys(voteCounts).filter((id) => voteCounts[id] === maxVotes);

        if (topTargets.length > 1) {
          next.arrestSubmissions = { ...state.arrestSubmissions, [phaseKey]: {} };
          next.arrestChoices = { ...state.arrestChoices, [phaseKey]: {} };
          next.arrestRevoteCount = {
            ...state.arrestRevoteCount,
            [phaseKey]: (state.arrestRevoteCount[phaseKey] || 0) + 1
          };
          next.arrestEligibleTargets = { ...state.arrestEligibleTargets, [phaseKey]: topTargets };
          // currentStage는 "arrest"에 그대로 머무른다 (재투표).
        } else {
          const winner = topTargets[0];
          next.arrestResults = { ...state.arrestResults, [phaseKey]: choices };
          next.arrestWinnerTarget = { ...state.arrestWinnerTarget, [phaseKey]: winner };
          next.arrestEligibleTargets = { ...state.arrestEligibleTargets, [phaseKey]: null };
          next.currentStage = "arrest-result";
        }
      } else {
        next.arrestResults = { ...state.arrestResults, [phaseKey]: choices };
        next.currentStage = "arrest-result";
      }
    }

    return next;
  });
}

// ---------------------------------------------------------
// 단서 조사 (턴제)
// ---------------------------------------------------------
function myCharacterId(state, playerId) {
  return Object.keys(state.characters).find((c) => state.characters[c] === playerId) || null;
}

// <강제 전체 공개> 단서를 획득했을 때 공개 목록에 추가할 단서 id들.
// alsoReveal(예: 지하실의 문 → 주은의 열쇠)은 소지자가 누구든 함께 공개한다.
function applyForcedReveal(state, clueId) {
  const item = findClueItem(clueId);
  if (!item || !item.forceReveal) return state.revealedClueIds || [];
  const revealed = [...(state.revealedClueIds || [])];
  [clueId, ...(item.alsoReveal || [])].forEach((id) => {
    if (!revealed.includes(id)) revealed.push(id);
  });
  return revealed;
}

// 현재 스테이지("investigation-r1" 등)에서 이번 라운드의 전체 턴 순서를 만든다.
function getRoundSequence(phase, round) {
  const config = INVESTIGATION_ROUNDS[phase] && INVESTIGATION_ROUNDS[phase][round];
  if (!config) return [];
  return buildTurnSequence(config.order, config.laps);
}

// 1페이즈 턴제 조사: 자기 방을 제외하고 아직 고를 수 있는 단서가 남아 있는지.
// 남아 있지 않다면 예외적으로 자기 방 단서를 고를 수 있다.
function hasSelectableClueOutsideOwnRoom(state, charId) {
  const phaseData = CLUES[state.currentPhase];
  if (!phaseData) return false;
  const revealed = state.revealedClueIds || [];
  return phaseData.rooms.some(
    (room) =>
      ROOM_OWNER[room.id] !== charId &&
      isRoomUnlocked(room.id, revealed) &&
      room.items.some((item) => !state.clueClaims[item.id])
  );
}

async function claimClueTurn(clueId) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    const match = /^investigation-r(\d)$/.exec(state.currentStage);
    if (!match) throw new Error("지금은 단서를 선택할 수 없는 단계입니다.");

    const round = Number(match[1]);
    const sequence = getRoundSequence(state.currentPhase, round);
    const turnIndex = state.investigationTurnIndex || 0;
    const expectedCharId = sequence[turnIndex];

    const charId = myCharacterId(state, playerId);
    if (!charId) {
      throw new Error("이 기기(브라우저)는 캐릭터로 등록되어 있지 않습니다. 처음에 캐릭터를 선택했던 기기·브라우저로 접속해주세요.");
    }
    if (charId !== expectedCharId) {
      const nameOf = (id) => (CHARACTERS.find((c) => c.id === id) || {}).name || id || "-";
      throw new Error(`아직 당신의 차례가 아닙니다. (현재 차례: ${nameOf(expectedCharId)} / 이 기기: ${nameOf(charId)} / ${round}차 조사 ${turnIndex + 1}번째)`);
    }
    if (state.clueClaims[clueId]) {
      throw new Error("이미 다른 사람이 획득한 단서입니다.");
    }
    const room = findClueRoom(clueId);
    if (room && ROOM_OWNER[room] === charId && hasSelectableClueOutsideOwnRoom(state, charId)) {
      throw new Error("자신의 방에 있는 단서는 선택할 수 없습니다. (다른 곳에 선택할 수 있는 단서가 남아 있을 때만 해당)");
    }

    const nextTurnIndex = turnIndex + 1;
    const next = {
      ...state,
      clueClaims: { ...state.clueClaims, [clueId]: charId },
      revealedClueIds: applyForcedReveal(state, clueId),
      investigationTurnIndex: nextTurnIndex
    };

    if (nextTurnIndex >= sequence.length) {
      // 이번 라운드 종료 -> 다음 단계로 (밀담 또는 전체 토론)
      const afterRound = { 1: "talk-1", 2: "talk-2", 3: "talk-3" };
      const nextStage = afterRound[round];
      const duration = TALK_DURATION_SEC;
      next.currentStage = nextStage;
      next.investigationTurnIndex = 0;
      next.stageStartedAt = serverNow();
      next.stageDurationSec = duration;
    }

    return next;
  });
}

// 자유 조사(조사 및 전체 토론): 순서/자기 방 제한 없이 자유롭게 단서를 획득한다.
// 1인당 장수는 FREE_PICK_ROUNDS의 picksPerPerson.
// 전원이 다 골라도 바로 넘어가지 않는다 — 시간 종료 또는 4명 [완료]로 넘어간다 (main.js).
async function claimFreeClue(clueId) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    const roundConfig = (FREE_PICK_ROUNDS[state.currentPhase] || []).find((r) => r.stage === state.currentStage);
    if (!roundConfig) throw new Error("지금은 단서를 선택할 수 없는 단계입니다.");
    const charId = myCharacterId(state, playerId);
    if (!charId) throw new Error("캐릭터가 아직 선택되지 않았습니다.");
    if (state.clueClaims[clueId]) throw new Error("이미 다른 사람이 획득한 단서입니다.");

    const room = findClueRoom(clueId);
    const pickableRoomIds = FREE_INVESTIGATION_ROOMS[state.currentPhase] || [];
    if (!pickableRoomIds.includes(room)) throw new Error("이번 조사에서 선택할 수 없는 단서입니다.");
    if (room && !isRoomUnlocked(room, state.revealedClueIds || [])) throw new Error("아직 열 수 없는 곳입니다.");

    const stageCounts = { ...((state.freePickCounts || {})[state.currentStage] || {}) };
    const myCount = stageCounts[charId] || 0;
    if (myCount >= roundConfig.picksPerPerson) throw new Error(`이미 ${roundConfig.picksPerPerson}장을 획득했습니다.`);
    stageCounts[charId] = myCount + 1;
    const freePickCounts = { ...(state.freePickCounts || {}), [state.currentStage]: stageCounts };

    return {
      ...state,
      clueClaims: { ...state.clueClaims, [clueId]: charId },
      revealedClueIds: applyForcedReveal(state, clueId),
      freePickCounts
    };
  });
}

// 이번 페이즈에 이 캐릭터가 <전체 공개>를 이미 사용했다면 공개한 단서 id, 아니면 null
function getRevealUsedThisPhase(state, charId) {
  const phaseUsed = ((state.revealUsed || {})[String(state.currentPhase)]) || {};
  return phaseUsed[charId] || null;
}

// 자신이 소유한 단서를 모두에게 공개한다 (소유 여부는 바뀌지 않는다).
// 페이즈마다 1인 1회만 가능하다.
async function revealClueCard(clueId) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    const charId = myCharacterId(state, playerId);
    if (state.clueClaims[clueId] !== charId) {
      throw new Error("자신이 획득한 단서만 공개할 수 있습니다.");
    }
    if ((state.revealedClueIds || []).includes(clueId)) return undefined;
    if (getRevealUsedThisPhase(state, charId)) {
      throw new Error("이번 페이즈의 <전체 공개> 기회(1회)를 이미 사용했습니다.");
    }
    const phaseKey = String(state.currentPhase);
    const revealUsed = { ...(state.revealUsed || {}) };
    revealUsed[phaseKey] = { ...(revealUsed[phaseKey] || {}), [charId]: clueId };
    return { ...state, revealedClueIds: [...(state.revealedClueIds || []), clueId], revealUsed };
  });
}

// 밀담 중 단서 양도 (교환은 서로 한 장씩 양도). 최초 소지 단서는 양도할 수 없다.
async function transferClue(clueId, toCharId) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    if (!/^talk-\d$/.test(state.currentStage)) throw new Error("단서 양도는 밀담 중에만 할 수 있습니다.");
    const charId = myCharacterId(state, playerId);
    if (!charId) throw new Error("캐릭터가 아직 선택되지 않았습니다.");
    if (state.clueClaims[clueId] !== charId) throw new Error("자신이 가진 단서만 양도할 수 있습니다.");
    if (isStartingClue(clueId)) throw new Error("최초 소지 단서는 양도할 수 없습니다.");
    if (!toCharId || toCharId === charId || !Object.prototype.hasOwnProperty.call(state.characters, toCharId)) {
      throw new Error("받을 사람을 다시 선택해주세요.");
    }
    return { ...state, clueClaims: { ...state.clueClaims, [clueId]: toCharId } };
  });
}

// ---------------------------------------------------------
// 스테이지/페이즈 전환
// ---------------------------------------------------------
async function advanceStage(nextStage, durationSec) {
  await backendUpdate((state) => ({
    ...state,
    currentStage: nextStage,
    stageStartedAt: serverNow(),
    stageDurationSec: durationSec || 0
  }));
}

async function advancePhase(nextPhase, nextStage, durationSec) {
  await backendUpdate((state) => {
    // 여러 명이 동시에 눌러도 한 번만 넘어가도록, 바로 앞 페이즈일 때만 진행한다.
    if (state.currentPhase !== nextPhase - 1) return undefined;
    // 페이즈가 바뀌면 그 페이즈에서 이미 소유한 것으로 간주되는 최초 소지 단서를 함께 등록한다.
    const seedByPhase = { 2: PHASE2_STARTING_CLAIMS };
    const seed = seedByPhase[nextPhase] || {};

    return {
      ...state,
      currentPhase: nextPhase,
      currentStage: nextStage,
      stageStartedAt: serverNow(),
      stageDurationSec: durationSec || 0,
      clueClaims: { ...state.clueClaims, ...seed }
    };
  });
}

// 현재 스테이지가 expectedStage일 때만 다음으로 넘긴다.
// (타이머 종료·전원 준비완료가 동시에 여러 탭/기기에서 감지되어도
//  중복으로 다음 단계로 넘어가지 않도록 막아준다.)
// expectedStartedAt을 넘기면 "그 시각에 시작된 바로 그 스테이지"일 때만 넘긴다.
// 타이머 종료로 넘기는 경우(checkTimeUp=true)에는 저장된 값 기준으로 실제로 시간이
// 다 됐는지도 다시 확인해서, 오래된 화면이나 시계가 틀어진 기기가 일찍 넘기지 못하게 한다.
async function transitionIfStillOn(expectedStage, nextStage, durationSec, expectedStartedAt, checkTimeUp) {
  await backendUpdate((state) => {
    if (state.currentStage !== expectedStage) return undefined;
    if (expectedStartedAt !== undefined && state.stageStartedAt !== expectedStartedAt) return undefined;
    if (checkTimeUp && state.stageDurationSec) {
      const endsAt = state.stageStartedAt + state.stageDurationSec * 1000;
      if (serverNow() < endsAt - 2000) return undefined; // 2초 오차 허용
    }
    const next = {
      ...state,
      currentStage: nextStage,
      stageStartedAt: serverNow(),
      stageDurationSec: durationSec || 0
    };
    // "scene:3-1"처럼 진행 시나리오로 넘어가는 경우
    if (nextStage.startsWith("scene:")) {
      next.currentStage = "scene";
      next.currentScene = nextStage.slice("scene:".length);
    }
    if (/^investigation-r\d$/.test(nextStage)) {
      next.investigationTurnIndex = 0;
    }
    return next;
  });
}

// ---------------------------------------------------------
// 진행 시나리오 (검거 결과 분기)
// ---------------------------------------------------------

// 검거 결과 화면 → 결과에 맞는 시나리오로 (결과 화면에 있을 때만, 한 번만)
async function goToArrestResultScene() {
  await backendUpdate((state) => {
    if (state.currentStage !== "arrest-result") return undefined;
    const phaseKey = "phase" + state.currentPhase;
    const winner = state.arrestWinnerTarget ? state.arrestWinnerTarget[phaseKey] : null;
    const map = ARREST_RESULT_SCENES[state.currentPhase] || {};
    const sceneId = map[winner || "none"];
    if (!sceneId) return undefined;
    return { ...state, currentStage: "scene", currentScene: sceneId, stageStartedAt: serverNow(), stageDurationSec: 0 };
  });
}

// 진행 시나리오 fromScene → toScene (지금 fromScene일 때만)
async function goToScene(fromScene, toScene) {
  await backendUpdate((state) => {
    if (state.currentStage !== "scene" || state.currentScene !== fromScene) return undefined;
    return { ...state, currentScene: toScene, stageStartedAt: serverNow(), stageDurationSec: 0 };
  });
}

// 진행 시나리오 → 엔딩
async function goToEnding(fromScene) {
  await backendUpdate((state) => {
    if (state.currentStage !== "scene" || state.currentScene !== fromScene) return undefined;
    return { ...state, currentStage: "ending", currentScene: null, stageStartedAt: serverNow(), stageDurationSec: 0 };
  });
}

// 배드엔딩 → 해당 페이즈 검거 투표를 처음부터 다시 (투표 기록만 초기화, 단서·공개 상태는 유지)
async function redoArrest(fromScene, phase) {
  await backendUpdate((state) => {
    if (state.currentStage !== "scene" || state.currentScene !== fromScene) return undefined;
    const phaseKey = "phase" + phase;
    const clear = (obj, value) => ({ ...(obj || {}), [phaseKey]: value });
    const config = ARREST[phase] || {};
    return {
      ...state,
      currentStage: "arrest",
      currentScene: null,
      stageStartedAt: serverNow(),
      stageDurationSec: config.discussionSec || 0,
      arrestSubmissions: clear(state.arrestSubmissions, {}),
      arrestChoices: clear(state.arrestChoices, {}),
      arrestResults: clear(state.arrestResults, {}),
      arrestWinnerTarget: clear(state.arrestWinnerTarget, null),
      arrestRevoteCount: clear(state.arrestRevoteCount, 0),
      arrestEligibleTargets: clear(state.arrestEligibleTargets, null)
    };
  });
}

// ---------------------------------------------------------
// 점수 (엔딩 이후)
// ---------------------------------------------------------

// 엔딩 → 점수 확인 화면
async function goToScore() {
  await backendUpdate((state) => {
    if (state.currentStage !== "ending") return undefined;
    return { ...state, currentStage: "score", stageStartedAt: serverNow(), stageDurationSec: 0 };
  });
}

// 기록으로 미리 체크할 수 있는 항목의 값 (점수) — 판단할 수 없으면 null
function autoScoreFor(state, charId, goal) {
  if (!goal.auto) return null;
  const first1 = ((state.firstArrestVotes || {}).phase1) || {};
  const first2 = ((state.firstArrestVotes || {}).phase2) || {};
  const [kind, arg] = goal.auto.split(":");
  if (kind === "vote1Killer") {
    const v = first1[charId];
    if (!v) return null;
    return v.choice === "arrest" && v.target === SCORE_KILLER_ID ? goal.points : 0;
  }
  if (kind === "vote1NoneOn") {
    if (Object.keys(first1).length === 0) return null;
    const got = Object.values(first1).some((v) => v.choice === "arrest" && v.target === arg);
    return got ? 0 : goal.points;
  }
  if (kind === "reveal2") {
    const used = (((state.revealUsed || {})["2"]) || {})[charId];
    return used && arg.split(",").includes(used) ? goal.points : 0;
  }
  if (kind === "vote2Host") {
    const v = first2[charId];
    if (!v) return null;
    return v.target === "host" ? goal.points : 0;
  }
  return null;
}

// 자기 신고 점수 제출 (한 번만)
async function submitScoreReport(items) {
  const playerId = getLocalPlayerId();
  await backendUpdate((state) => {
    if (state.currentStage !== "score") throw new Error("지금은 점수를 제출할 수 없습니다.");
    const charId = myCharacterId(state, playerId);
    if (!charId) throw new Error("캐릭터가 아직 선택되지 않았습니다.");
    if ((state.scoreReports || {})[charId]) return undefined;
    // 항목별 최대 점수를 넘지 않도록 정리
    const allowed = {};
    const goals = SCORE_GOALS[charId] || {};
    [1, 2, 3].forEach((ph) => (goals[ph] || []).forEach((g) => { allowed[g.id] = g.points; }));
    const clean = {};
    Object.keys(allowed).forEach((id) => {
      let v = Math.max(0, Math.min(allowed[id], Number(items[id]) || 0));
      const g = [1, 2, 3].flatMap((ph) => goals[ph] || []).find((x) => x.id === id);
      if (g && g.binary && v !== g.points) v = 0; // 전부 맞히거나 0점
      clean[id] = v;
    });
    return {
      ...state,
      scoreReports: { ...(state.scoreReports || {}), [charId]: { items: clean, submittedAt: serverNow() } }
    };
  });
}

// 제출된 점수 합계 (페이즈별 / 공통 / 총점)
function summarizeScore(charId, report) {
  const items = (report && report.items) || {};
  const goals = SCORE_GOALS[charId] || {};
  const sum = (list) => list.reduce((acc, g) => acc + (Number(items[g.id]) || 0), 0);
  const p1 = sum(goals[1] || []);
  const p2 = sum(goals[2] || []);
  const p3 = sum(goals[3] || []);
  return { p1, p2, p3 };
}

// 공통 추리 점수 합계 (네 명 공통)
function summarizeCommon(state) {
  const items = state.scoreCommon || {};
  return SCORE_COMMON.reduce((acc, q) => acc + (Number(items[q.id]) || 0), 0);
}

function allScoreReportsSubmitted(state) {
  const ids = Object.keys(state.characters || {}).filter((c) => state.characters[c]);
  return ids.length > 0 && ids.every((c) => (state.scoreReports || {})[c]);
}

// 공통 추리 점수 한 항목 설정 (누가 눌러도 모두에게 반영, 결과 공개 전까지)
async function setScoreCommon(itemId, value) {
  await backendUpdate((state) => {
    if (state.currentStage !== "score" || allScoreReportsSubmitted(state)) return undefined;
    const q = SCORE_COMMON.find((x) => x.id === itemId);
    if (!q) return undefined;
    const v = Math.max(0, Math.min(q.points, Number(value) || 0));
    return { ...state, scoreCommon: { ...(state.scoreCommon || {}), [itemId]: v } };
  });
}

// ---------------------------------------------------------
// 리셋
// ---------------------------------------------------------
async function resetGame() {
  await backendSet(getInitialGameState());
  localStorage.removeItem(LOCAL_CHARACTER_KEY);
  localStorage.removeItem(LOCAL_ROLE_KEY);
}
