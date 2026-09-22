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
    currentStage: "rules-basic", // rules-basic | opening | character-select | rules-phase1 | scenario | rules-phase1-progress | investigation-r1~3 | talk-1~3 | discussion | rules-phase2 | discussion-pre | investigation-free | discussion-post | arrest | arrest-result | scenario-a | scenario-b | rules-phase3
    stageStartedAt: Date.now(), // 밀리초 타임스탬프 (로컬/Firebase 공통)
    stageDurationSec: 0,        // 0이면 타이머 없음(캐릭터 선택, 검거 대기 등)

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

    // 조사에서 획득한 단서와 그 소유자. 1페이즈 최초 소지 열쇠는 게임 시작부터 이미 소유한 상태로 둔다.
    clueClaims: { ...PHASE1_STARTING_CLAIMS }, // { clueId: characterId }
    revealedClueIds: [], // 소유 여부와 별개로, 모두에게 "전체공개"된 단서 id 목록
    investigationTurnIndex: 0, // 현재 조사 라운드 안에서 몇 번째 순서인지
    freePickCounts: {}, // 자유 조사 스테이지별 캐릭터 획득 장수

    // 검거 제출 현황 및 결과
    arrestSubmissions: {}, // { "phase1": { playerId: true } }
    arrestChoices: {},     // { "phase1": { playerId: { choice, target } } }  (전원 제출 전엔 클라이언트에 노출 안 함)
    arrestResults: {},     // { "phase1": { playerId: { choice, target } } } (전원 제출 후 서버가 복사)
    arrestMajority: {},    // { "phase2": "host" | "other" } — 다수결 방식일 때만 사용
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
// 검거 제출 (제출 여부만 먼저 공개, 실제 선택 내용은 전원 제출 후 결과로 옮김)
// ---------------------------------------------------------
async function submitArrestChoice(phaseKey, choice, target) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    const eligible = state.arrestEligibleTargets && state.arrestEligibleTargets[phaseKey];
    if (target && eligible && !eligible.includes(target)) {
      throw new Error("이번 재투표에서는 선택할 수 없는 대상입니다.");
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

    const pickedPlayerIds = Object.values(state.characters).filter(Boolean);
    const allSubmitted = pickedPlayerIds.length > 0 && pickedPlayerIds.every((pid) => submissions[pid]);

    if (allSubmitted) {
      const phaseNum = Number(phaseKey.replace("phase", ""));
      const config = ARREST[phaseNum];

      if (config && config.majorityRule) {
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
          next.arrestMajority = { ...state.arrestMajority, [phaseKey]: winner === "host" ? "host" : "other" };
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

// 현재 스테이지("investigation-r1" 등)에서 이번 라운드의 전체 턴 순서를 만든다.
function getRoundSequence(phase, round) {
  const config = INVESTIGATION_ROUNDS[phase] && INVESTIGATION_ROUNDS[phase][round];
  if (!config) return [];
  return buildTurnSequence(config.order, config.laps);
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
    if (charId !== expectedCharId) {
      throw new Error("아직 당신의 차례가 아닙니다.");
    }
    if (state.clueClaims[clueId]) {
      throw new Error("이미 다른 사람이 획득한 단서입니다.");
    }
    const room = findClueRoom(clueId);
    if (room && ROOM_OWNER[room] === charId) {
      throw new Error("자신의 방에 있는 단서는 선택할 수 없습니다.");
    }

    const nextTurnIndex = turnIndex + 1;
    const next = {
      ...state,
      clueClaims: { ...state.clueClaims, [clueId]: charId },
      investigationTurnIndex: nextTurnIndex
    };

    if (nextTurnIndex >= sequence.length) {
      // 이번 라운드 종료 -> 다음 단계로 (밀담 또는 전체 토론)
      const afterRound = { 1: "talk-1", 2: "talk-2", 3: "talk-3" };
      const nextStage = afterRound[round];
      const duration = TALK_DURATION_SEC;
      next.currentStage = nextStage;
      next.investigationTurnIndex = 0;
      next.stageStartedAt = Date.now();
      next.stageDurationSec = duration;
    }

    return next;
  });
}

// 2페이즈: 순서/자기 방 제한 없이 자유롭게 단서를 획득한다. 1인당 2장까지.
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

    const next = { ...state, clueClaims: { ...state.clueClaims, [clueId]: charId }, freePickCounts };
    const charIds = Object.keys(state.characters);
    const allDone = charIds.every((cid) => (stageCounts[cid] || 0) >= roundConfig.picksPerPerson);
    if (allDone) {
      const after = DISCUSSION_STAGES[roundConfig.next];
      next.currentStage = roundConfig.next;
      next.stageStartedAt = Date.now();
      next.stageDurationSec = after ? after.durationSec : 0;
    }
    return next;
  });
}

// 자신이 소유한 단서를 모두에게 공개한다 (소유 여부는 바뀌지 않는다).
async function revealClueCard(clueId) {
  const playerId = getLocalPlayerId();

  await backendUpdate((state) => {
    const charId = myCharacterId(state, playerId);
    if (state.clueClaims[clueId] !== charId) {
      throw new Error("자신이 획득한 단서만 공개할 수 있습니다.");
    }
    if ((state.revealedClueIds || []).includes(clueId)) return undefined;
    return { ...state, revealedClueIds: [...(state.revealedClueIds || []), clueId] };
  });
}

// ---------------------------------------------------------
// 스테이지/페이즈 전환
// ---------------------------------------------------------
async function advanceStage(nextStage, durationSec) {
  await backendUpdate((state) => ({
    ...state,
    currentStage: nextStage,
    stageStartedAt: Date.now(),
    stageDurationSec: durationSec || 0
  }));
}

async function advancePhase(nextPhase, nextStage, durationSec) {
  await backendUpdate((state) => {
    // 페이즈가 바뀌면 그 페이즈에서 이미 소유한 것으로 간주되는 최초 소지 단서를 함께 등록한다.
    const seedByPhase = { 2: PHASE2_STARTING_CLAIMS };
    const seed = seedByPhase[nextPhase] || {};

    return {
      ...state,
      currentPhase: nextPhase,
      currentStage: nextStage,
      stageStartedAt: Date.now(),
      stageDurationSec: durationSec || 0,
      clueClaims: { ...state.clueClaims, ...seed }
    };
  });
}

// 현재 스테이지가 expectedStage일 때만 다음으로 넘긴다.
// (타이머 종료·전원 준비완료가 동시에 여러 탭/기기에서 감지되어도
//  중복으로 다음 단계로 넘어가지 않도록 막아준다.)
async function transitionIfStillOn(expectedStage, nextStage, durationSec) {
  await backendUpdate((state) => {
    if (state.currentStage !== expectedStage) return undefined;
    const next = {
      ...state,
      currentStage: nextStage,
      stageStartedAt: Date.now(),
      stageDurationSec: durationSec || 0
    };
    if (/^investigation-r\d$/.test(nextStage)) {
      next.investigationTurnIndex = 0;
    }
    return next;
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
