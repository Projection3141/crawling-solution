# Mall Collector Public UI

## 실행

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run web

브라우저 또는 Electron WebView에서 다음 주소를 엽니다.

http://127.0.0.1:3210

설정 우선순위

public 화면 입력 > .env 공통 설정 > 코드 기본값

계정 키는 쇼핑몰 구분 없이 다음 두 개만 사용합니다.

ACCOUNT_ID=
ACCOUNT_PW=

결과 파일

실행별로 다음 경로가 생성됩니다.

out/<mall>/<run-id>/
├─ inventory.csv
├─ summary.csv
├─ products.csv
├─ result.json
└─ debug-*.html

inventory.csv: 천유는 옵션별 수량, 과자생각은 판매 가능/품절 상태

summary.csv: 상품 단위 요약

products.csv: 수집한 전체 상품 목록
