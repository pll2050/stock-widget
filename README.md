# 스탁 위젯

Electron 기반 데스크톱 주식 모니터링 위젯입니다. 앱은 항상 다른 창 위에 표시되는 작은 위젯으로 동작하며, 실제 종료는 시스템 트레이 메뉴에서만 수행합니다.

## 실행

```bash
npm install
npm start
```

## 현재 구현 범위

- 항상 위에 표시되는 프레임 없는 위젯 창
- 시스템 트레이 메뉴
- 창 닫기 시 숨김 처리
- 트레이 메뉴를 통한 실제 종료
- 환경설정 창
- 종목명/티커 검색
- 관심 종목 추가, 삭제, 정렬
- 로컬 JSON 설정 저장
- 일반 탭의 위젯 불투명도 조절
- 환경설정의 인증 탭에서 증권사 선택 및 증권사별 인증정보 저장
- 증권사 인증정보는 Electron `safeStorage`로 암호화해 `settings.json`에 저장
- 키움증권 REST API 접근토큰 발급, 국내주식 종목 검색, 현재가 조회
- 키움증권 WebSocket 실시간 주식체결 시세 구독
- 토스증권 Open API 접근토큰 발급, 종목코드/심볼 검색, 현재가 조회
- 인증정보 미설정 시 위젯 안내 메시지 표시

## 개발 메모

- Renderer는 `preload`를 통해 제한된 IPC API만 사용합니다.
- `nodeIntegration`은 꺼져 있고 `contextIsolation`은 켜져 있습니다.
- 시세 조회와 종목 검색은 `src/main/stock-provider.js`에서 현재 선택된 증권사 provider로 라우팅합니다.
- 키움증권 선택 시 운영 도메인 `https://api.kiwoom.com`을 사용하며, 국내주식 `ka10099` 종목정보 리스트와 현재가 TR을 호출합니다.
- 키움증권은 초기 스냅샷 이후 `wss://api.kiwoom.com:10000/api/dostk/websocket`으로 `0B` 주식체결 실시간 시세를 구독합니다.
- 토스증권 선택 시 `https://openapi.tossinvest.com`을 사용하며, `GET /api/v1/stocks`와 `GET /api/v1/prices`를 호출합니다.
- 토스증권은 현재 공식 WebSocket API가 공개되어 있지 않아 REST polling 방식으로 유지합니다.
- `settings.json`에는 키움 App Key/Secret Key와 토스 Client ID/Client Secret 원문을 저장하지 않고, `src/main/secret-storage.js`에서 암호화한 값만 저장합니다.
