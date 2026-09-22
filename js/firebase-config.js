/* =========================================================
   Firebase 설정
   -----------------------------------------------------------
   Firebase 콘솔(console.firebase.google.com)에서
   프로젝트를 만든 뒤 "프로젝트 설정 > 일반 > 내 앱"에서
   나오는 값을 아래에 그대로 붙여넣으세요.

   Firestore(콘솔 > Firestore Database)를 반드시 활성화해야 합니다.
   보안 규칙은 개발 중에는 테스트 모드(모두 읽기/쓰기 허용)로
   두고, 실제 배포 전에는 규칙을 다시 검토하세요.

   -----------------------------------------------------------
   ※ 아래 값을 아직 채우지 않았다면(placeholder 그대로라면)
     자동으로 "로컬 테스트 모드"로 동작합니다.
     로컬 테스트 모드는 Firebase 없이, 같은 브라우저에서 연 여러 탭끼리만
     상태를 동기화합니다 (다른 컴퓨터끼리는 동기화되지 않음).
     실제 여러 사람과 플레이하려면 반드시 아래 값을 채워야 합니다.
   ========================================================= */

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const IS_LOCAL_MODE = firebaseConfig.apiKey === "YOUR_API_KEY";

let db, GAME_DOC_REF;

if (!IS_LOCAL_MODE) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  // 이 게임은 세션(방) 개념이 없으므로 문서 하나만 고정으로 사용한다.
  GAME_DOC_REF = db.collection("games").doc("main");
} else {
  console.info(
    "[한낮의 별에도 봄은 오는가] Firebase 설정이 비어 있어 로컬 테스트 모드로 동작합니다. " +
    "같은 브라우저의 여러 탭끼리만 동기화됩니다. 실제 배포 전 js/firebase-config.js를 채워주세요."
  );
}
