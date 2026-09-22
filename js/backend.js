/* =========================================================
   백엔드 추상화
   -----------------------------------------------------------
   firebase-config.js에서 진짜 Firebase 설정값을 채워넣기 전까지는
   IS_LOCAL_MODE가 true가 되고, 이 파일이 Firestore 대신
   localStorage를 이용한 "로컬 테스트 모드"로 동작한다.

   같은 브라우저에서 탭을 여러 개 열어두면, 브라우저의 storage
   이벤트 덕분에 탭끼리 상태가 실시간으로 동기화된다.
   (다른 컴퓨터끼리는 동기화되지 않음 — 그건 진짜 Firebase가 필요하다.)

   game-state.js는 이 파일이 제공하는 backendSubscribe /
   backendUpdate / backendSet / backendEnsureExists 네 개의
   함수만 사용하고, Firestore인지 로컬인지는 신경쓰지 않는다.
   ========================================================= */

const LOCAL_STORAGE_STATE_KEY = "scm_game_state_v1";
const localSubscribers = [];

function backendIsLocalMode() {
  return typeof IS_LOCAL_MODE !== "undefined" && IS_LOCAL_MODE;
}

// ---------------------------------------------------------
// 로컬 모드 (localStorage)
// ---------------------------------------------------------
function localReadState() {
  const raw = localStorage.getItem(LOCAL_STORAGE_STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function localWriteState(state) {
  localStorage.setItem(LOCAL_STORAGE_STATE_KEY, JSON.stringify(state));
}

function localNotifySubscribers(state) {
  localSubscribers.forEach((cb) => cb(state));
}

// 다른 탭에서 localStorage가 바뀌면 storage 이벤트가 발생한다.
// (단, 값을 쓴 바로 그 탭에서는 발생하지 않으므로 backendUpdate/backendSet에서
//  같은 탭 몫은 직접 알려준다.)
window.addEventListener("storage", (e) => {
  if (e.key !== LOCAL_STORAGE_STATE_KEY || !e.newValue) return;
  localNotifySubscribers(JSON.parse(e.newValue));
});

// ---------------------------------------------------------
// 공용 API
// ---------------------------------------------------------

async function backendEnsureExists() {
  if (backendIsLocalMode()) {
    if (!localReadState()) localWriteState(getInitialGameState());
    return;
  }
  const doc = await GAME_DOC_REF.get();
  if (!doc.exists) await GAME_DOC_REF.set(getInitialGameState());
}

// state가 바뀔 때마다 callback(state)를 호출한다.
// 반환값은 구독 해제 함수.
function backendSubscribe(callback) {
  if (backendIsLocalMode()) {
    localSubscribers.push(callback);
    let state = localReadState();
    if (!state) {
      state = getInitialGameState();
      localWriteState(state);
    }
    callback(state);
    return () => {
      const idx = localSubscribers.indexOf(callback);
      if (idx >= 0) localSubscribers.splice(idx, 1);
    };
  }

  return GAME_DOC_REF.onSnapshot((doc) => {
    if (!doc.exists) {
      GAME_DOC_REF.set(getInitialGameState());
      return;
    }
    callback(doc.data());
  });
}

// updaterFn(currentState) -> newState 객체를 반환하면 그 값으로 저장된다.
// undefined/falsy를 반환하면 "변경 없음"으로 간주하고 아무 것도 쓰지 않는다.
// updaterFn 안에서 throw하면 그대로 바깥으로 전파된다 (예: 이미 선택된 캐릭터).
async function backendUpdate(updaterFn) {
  if (backendIsLocalMode()) {
    const current = localReadState() || getInitialGameState();
    const next = updaterFn(current);
    if (!next) return;
    localWriteState(next);
    localNotifySubscribers(next); // 같은 탭에서 누른 액션은 즉시 반영
    return;
  }

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(GAME_DOC_REF);
    const current = doc.exists ? doc.data() : getInitialGameState();
    const next = updaterFn(current);
    if (!next) return;
    tx.set(GAME_DOC_REF, next);
  });
}

async function backendSet(state) {
  if (backendIsLocalMode()) {
    localWriteState(state);
    localNotifySubscribers(state);
    return;
  }
  await GAME_DOC_REF.set(state);
}
